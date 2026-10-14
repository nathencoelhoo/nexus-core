import { after } from 'node:test';
import assert from 'node:assert/strict';
import { DOCKER_ENABLED, itest, sleep, uuid, waitFor } from './_helpers.ts';
import { DockerClient } from '../../src/sandbox/client.ts';
import { SandboxManager } from '../../src/sandbox/manager.ts';
import type { Sandbox, Ident } from '../../src/sandbox/sandbox.ts';
import { QueueFull } from '../../src/sandbox/semaphore.ts';
import { DEFAULT_POLICY } from '../../src/sandbox/policy.ts';
import type { SandboxPolicy } from '../../src/sandbox/policy.ts';
import { StreamScrubber } from '../../src/compliance/scrubber.ts';

/**
 * Runs against a REAL Docker daemon. NEXUS_RUNTIME=runsc runs the same suite under gVisor; assertions that read
 * Linux cgroup or capability state are runc-only, because gVisor reports its own emulated view of those.
 */
const RUNTIME = process.env.NEXUS_RUNTIME === 'runsc' ? 'runsc' : 'runc';
const IS_RUNC = RUNTIME === 'runc';
const policy: SandboxPolicy = {
  ...DEFAULT_POLICY, image: process.env.NEXUS_IMAGE ?? 'node:22-bookworm-slim', runtime: RUNTIME, allowRuncFallback: false,
  ttlSeconds: 300, floodBytes: 1_000_000, killGraceMs: 3_000, maxConcurrent: 8, maxPerTenant: 4, maxQueue: 4,
};
const client = new DockerClient(process.env.DOCKER_SOCKET ?? '/var/run/docker.sock', 60_000);
const manager = new SandboxManager(client, policy);
after(async () => { await manager.closeAll(); });

const dtest = (name: string, fn: () => Promise<void>) => itest(`[${RUNTIME}] ${name}`, fn, DOCKER_ENABLED);
const ident = (): Ident => ({ tenantId: 'itest', runId: `r${uuid().replace(/-/g, '').slice(0, 20)}` });
async function withSandbox<T>(fn: (sb: Sandbox, id: Ident) => Promise<T>): Promise<T> {
  const id = ident();
  const sb = await manager.getOrCreate(id);
  try { return await fn(sb, id); } finally { await manager.destroy(id); }
}
const sh = (script: string) => ['sh', '-c', script];
const j = (...p: string[]) => p.join('');

dtest('exec over the real hijacked stream: stdout, stderr and the exit code are separated correctly', () =>
  withSandbox(async sb => {
    const r = await sb.exec({ argv: sh('echo hi; echo err 1>&2; exit 3') });
    assert.equal(r.stdout.text, 'hi\n');
    assert.equal(r.stderr.text, 'err\n');
    assert.equal(r.exitCode, 3);
    assert.equal(r.termination, 'exit');
  }));

dtest('tar upload into the running container: nested dirs are writable by the sandbox user, modes are honored', () =>
  withSandbox(async sb => {
    await sb.writeFiles([
      { path: 'a/b/c.txt', content: 'hello\n' },
      { path: 'run.sh', content: '#!/bin/sh\necho ran\n', mode: 0o755 },
    ]);
    const r = await sb.exec({ argv: sh('echo more >> a/b/new.txt && cat a/b/c.txt a/b/new.txt && ./run.sh') });
    assert.equal(r.exitCode, 0, r.stderr.text);
    assert.equal(r.stdout.text, 'hello\nmore\nran\n');
    const who = await sb.exec({ argv: sh('stat -c "%u:%g" a a/b') });
    assert.equal(who.stdout.text, '65534:65534\n65534:65534\n');
  }));

dtest('runs as an unprivileged user; root filesystem is read-only; /workspace is writable and executable; /tmp is not executable', () =>
  withSandbox(async sb => {
    assert.equal((await sb.exec({ argv: ['id', '-u'] })).stdout.text, '65534\n');
    assert.notEqual((await sb.exec({ argv: sh('echo x > /etc/nexus_probe') })).exitCode, 0);
    assert.equal((await sb.exec({ argv: sh('echo ok > /workspace/p && cat /workspace/p') })).stdout.text, 'ok\n');
    assert.equal((await sb.exec({ argv: sh('cp /bin/true /workspace/t && /workspace/t') })).exitCode, 0);
    const noexec = await sb.exec({ argv: sh('cp /bin/true /tmp/t && /tmp/t') });
    assert.notEqual(noexec.exitCode, 0);
    assert.match(noexec.stderr.text, /denied|not permitted/i);
  }));

dtest('no network', () =>
  withSandbox(async sb => {
    const script = "const s=require('net').connect({host:'1.1.1.1',port:53});s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),2000)";
    const r = await sb.exec({ argv: ['node', '-e', script] });
    assert.equal(r.exitCode, 0, 'the connection succeeded: the sandbox has network access');
  }));

dtest('capabilities dropped, no-new-privileges, and cgroup limits (runc only)', () =>
  withSandbox(async sb => {
    if (!IS_RUNC) return;
    const st = await sb.exec({ argv: sh('grep -E "^(CapEff|CapBnd|NoNewPrivs):" /proc/self/status') });
    assert.match(st.stdout.text, /CapEff:\s+0000000000000000/);
    assert.match(st.stdout.text, /CapBnd:\s+0000000000000000/);
    assert.match(st.stdout.text, /NoNewPrivs:\s+1/);
    const lim = await sb.exec({ argv: sh('cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max') });
    if (lim.exitCode === 0) assert.deepEqual(lim.stdout.text.trim().split('\n'), ['536870912', '128', '50000 100000']);
    const swap = await sb.exec({ argv: sh('cat /sys/fs/cgroup/memory.swap.max 2>/dev/null || echo n/a') });
    if (swap.stdout.text.trim() !== 'n/a') assert.equal(swap.stdout.text.trim(), '0');
  }));

dtest('a process that exceeds the memory limit is killed and classified signal_or_oom (runc only)', () =>
  withSandbox(async sb => {
    if (!IS_RUNC) return;
    const r = await sb.exec({ argv: ['node', '-e', 'const a=[];for(;;)a.push(Buffer.alloc(50*1024*1024,1))'], timeoutMs: 60_000 });
    assert.equal(r.exitCode, 137);
    assert.equal(r.termination, 'signal_or_oom');
  }));

dtest('timeout: the process is killed and classified as a timeout', () =>
  withSandbox(async sb => {
    const r = await sb.exec({ argv: ['sleep', '30'], timeoutMs: 1000 });
    assert.equal(r.termination, 'timeout');
    assert.equal(r.exitCode, 124);
    assert.ok(r.durationMs < 8_000, `took ${r.durationMs}ms`);
    assert.equal(sb.isDead, false);                          // a clean `timeout` exit leaves the sandbox usable
    assert.equal((await sb.exec({ argv: ['echo', 'still alive'] })).stdout.text, 'still alive\n');
  }));

dtest('output flood: truncated, classified, and the container is really killed', () =>
  withSandbox(async (sb, id) => {
    const r = await sb.exec({ argv: ['yes'] });
    assert.equal(r.termination, 'output_flood');
    assert.ok(sb.isDead);
    await waitFor(async () => {
      const [c] = await client.listByLabel(`nexus.run=${id.runId}`);
      return c !== undefined && c.State !== 'running';
    }, 15_000, 'container to stop');
  }));

dtest('large output is captured head+tail in bounded memory', () =>
  withSandbox(async sb => {
    const r = await sb.exec({ argv: ['seq', '1', '100000'] });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.droppedBytes > 400_000, String(r.stdout.droppedBytes));
    assert.ok(r.stdout.text.startsWith('1\n2\n3\n'));
    assert.match(r.stdout.text, /bytes elided/);
    assert.ok(r.stdout.text.endsWith('99999\n100000\n'));
    assert.ok(r.stdout.text.length < 70_000);
  }));

dtest('scrubbing end to end: a token printed by the sandbox never reaches the result or onFrame', () =>
  withSandbox(async sb => {
    const tok = j('gh', 'p_', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6');
    const seen: string[] = [];
    const r = await sb.exec({
      argv: sh(`echo deploy ${tok} done; echo contact ${j('jane.doe', '@', 'corp.io')} 1>&2`),
      scrub: () => new StreamScrubber({ salt: Buffer.from('itest-salt') }),
      onFrame: f => { seen.push(f.data.toString()); },
    });
    assert.ok(!r.stdout.text.includes(tok) && !seen.join('').includes(tok));
    assert.match(r.stdout.text, /deploy \[REDACTED:github_token:[0-9a-f]{8}\] done/);
    assert.match(r.stderr.text, /\[REDACTED:email:/);
  }));

dtest('the container expires by itself when its TTL elapses (orchestrator-crash safety)', async () => {
  const m = new SandboxManager(client, { ...policy, ttlSeconds: 2 });
  const id = ident();
  await m.getOrCreate(id);
  await sleep(3_500);
  const [c] = await client.listByLabel(`nexus.run=${id.runId}`);
  assert.equal(c?.State, 'exited');
  await m.destroy(id);
  assert.deepEqual(await client.listByLabel(`nexus.run=${id.runId}`), []);
});

dtest('the orphan reaper removes expired containers left by a dead orchestrator', async () => {
  const dead = new SandboxManager(client, { ...policy, ttlSeconds: 2 });
  const id = ident();
  await dead.getOrCreate(id);                                // ...and the "orchestrator" never cleans up
  const reaper = new SandboxManager(client, policy);
  const n = await reaper.reapOrphans(Date.now() + 120_000);
  assert.ok(n >= 1, `reaped ${n}`);
  assert.deepEqual(await client.listByLabel(`nexus.run=${id.runId}`), []);
});

dtest('per-tenant concurrency limit with a bounded queue, using real containers', async () => {
  const m = new SandboxManager(client, { ...policy, maxPerTenant: 1, maxQueue: 1 });
  const [i1, i2, i3] = [ident(), ident(), ident()];
  await m.getOrCreate(i1);
  const second = m.getOrCreate(i2);                          // waits for the slot
  await sleep(200);
  await assert.rejects(m.getOrCreate(i3), (e) => e instanceof QueueFull);
  await m.destroy(i1);                                       // frees the slot
  await second;
  await m.destroy(i2);
  assert.deepEqual(m.stats(), { held: 0, queued: 0, live: 0 });
});

dtest('concurrent getOrCreate for one run creates one container', async () => {
  const id = ident();
  const all = await Promise.all(Array.from({ length: 5 }, () => manager.getOrCreate(id)));
  assert.ok(all.every(s => s === all[0]));
  assert.equal((await client.listByLabel(`nexus.run=${id.runId}`)).length, 1);
  await manager.destroy(id);
});
