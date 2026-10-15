import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocker, frame } from './helpers/fakeDocker.ts';
import { DockerClient } from '../src/sandbox/client.ts';
import { Sandbox, InvalidRequest, SandboxDead } from '../src/sandbox/sandbox.ts';
import { SandboxManager, RuntimeUnavailable } from '../src/sandbox/manager.ts';
import { DEFAULT_POLICY } from '../src/sandbox/policy.ts';
import { Demuxer, FrameError } from '../src/sandbox/demux.ts';
import { BoundedCapture } from '../src/sandbox/capture.ts';
import { buildTar, PathError } from '../src/sandbox/tar.ts';
import { KeyedSemaphore, QueueFull } from '../src/sandbox/semaphore.ts';

const policy = { ...DEFAULT_POLICY, killGraceMs: 50, floodBytes: 4096 };
const ident = { tenantId: 't1', runId: 'r1' };
let fake: FakeDocker;
let client: DockerClient;

before(async () => { fake = await FakeDocker.start(); client = new DockerClient(fake.socketPath, 5000); });
after(async () => { await fake.stop(); });
beforeEach(() => {
  fake.created = []; fake.uploads = []; fake.execBodies = []; fake.kills = 0; fake.removes = 0;
  fake.runtimes = ['runc', 'runsc']; fake.script = { frames: [], exitCode: 0 };
});

// ---- demux -------------------------------------------------------------------------------
test('demux: correct at every possible chunk boundary', () => {
  const wire = Buffer.concat([frame(1, 'hello '), frame(2, 'oops'), frame(1, ''), frame(1, 'world')]);
  for (let cut = 1; cut < wire.length; cut++) {
    const d = new Demuxer();
    const frames = [...d.push(wire.subarray(0, cut)), ...d.push(wire.subarray(cut))];
    d.end();
    const so = frames.filter(f => f.stream === 'stdout').map(f => f.data.toString()).join('');
    const se = frames.filter(f => f.stream === 'stderr').map(f => f.data.toString()).join('');
    assert.equal(so, 'hello world', `cut=${cut}`);
    assert.equal(se, 'oops', `cut=${cut}`);
  }
});

test('demux: byte-at-a-time, rejects desync, detects truncation', () => {
  const wire = Buffer.concat([frame(1, 'abc'), frame(2, 'de')]);
  const d = new Demuxer();
  const got = [];
  for (const b of wire) got.push(...d.push(Buffer.from([b])));
  d.end();
  assert.equal(got.length, 2);
  assert.throws(() => new Demuxer().push(Buffer.from('plain text, not a frame!!')), FrameError);
  const t = new Demuxer(); t.push(wire.subarray(0, 10));
  assert.throws(() => t.end(), FrameError);
  const big = Buffer.alloc(8); big[0] = 1; big.writeUInt32BE(0x7fffffff, 4);
  assert.throws(() => new Demuxer().push(big), FrameError);
});

// ---- capture -----------------------------------------------------------------------------
test('capture: bounded memory, keeps head and tail, counts dropped bytes', () => {
  const c = new BoundedCapture(10, 10);
  for (let i = 0; i < 1000; i++) c.push(Buffer.from('0123456789'));
  const r = c.result();
  assert.equal(r.totalBytes, 10000);
  assert.equal(r.droppedBytes, 9980);
  assert.ok(r.text.startsWith('0123456789'));
  assert.ok(r.text.includes('9980 bytes elided'));
  assert.ok(r.text.endsWith('0123456789'));
  const small = new BoundedCapture(100, 100); small.push(Buffer.from('hi'));
  assert.deepEqual(small.result(), { text: 'hi', totalBytes: 2, droppedBytes: 0 });
});

// ---- tar ---------------------------------------------------------------------------------
function parseTar(buf: Buffer) {
  const out: Array<{ name: string; type: string; size: number; uid: number; content: string; sumOk: boolean }> = [];
  let off = 0;
  while (off + 512 <= buf.length && buf[off] !== 0) {
    const h = buf.subarray(off, off + 512);
    const name = h.subarray(0, 100).toString().replace(/\0.*$/, '');
    const size = parseInt(h.subarray(124, 135).toString(), 8);
    const uid = parseInt(h.subarray(108, 115).toString(), 8);
    const stored = parseInt(h.subarray(148, 154).toString(), 8);
    const copy = Buffer.from(h); copy.fill(0x20, 148, 156);
    const sum = copy.reduce((a, b) => a + b, 0);
    const type = String.fromCharCode(h[156]!);
    out.push({ name, type, size, uid, content: buf.subarray(off + 512, off + 512 + size).toString(), sumOk: stored === sum });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

test('tar: valid headers, explicit parent dirs owned by sandbox user, deterministic', () => {
  const files = [{ path: 'src/a/b.ts', content: 'let x = 1;' }, { path: 'package.json', content: '{}' }];
  const t = buildTar(files);
  const e = parseTar(t);
  assert.deepEqual(e.map(x => [x.name, x.type]), [['src/', '5'], ['src/a/', '5'], ['src/a/b.ts', '0'], ['package.json', '0']]);
  assert.ok(e.every(x => x.sumOk && x.uid === 65534));
  assert.equal(e[2]!.content, 'let x = 1;');
  assert.equal(t.length % 512, 0);
  assert.ok(buildTar(files).equals(t));
});

test('tar: rejects traversal, absolute, duplicates, file/dir clash, oversize', () => {
  for (const bad of ['../x', '/etc/passwd', 'a/../b', 'a//b', './a', 'a\\b', 'a\0b', '']) {
    assert.throws(() => buildTar([{ path: bad, content: 'x' }]), PathError, bad);
  }
  assert.throws(() => buildTar([{ path: 'a', content: '' }, { path: 'a', content: '' }]), PathError);
  assert.throws(() => buildTar([{ path: 'a', content: '' }, { path: 'a/b', content: '' }]), PathError);
  assert.throws(() => buildTar([{ path: 'a', content: Buffer.alloc(100) }], { maxTotalBytes: 10 }), PathError);
});

test('tar: GNU tar accepts our archive', async () => {
  const { execFileSync } = await import('node:child_process');
  const t = buildTar([{ path: 'd/x.txt', content: 'hello' }]);
  const listing = execFileSync('tar', ['-tvf', '-'], { input: t }).toString();
  assert.match(listing, /d\/x\.txt/);
  assert.match(listing, /65534\/65534/);
});

// ---- semaphore ---------------------------------------------------------------------------
test('semaphore: per-key cap, no head-of-line blocking, bounded queue, idempotent release', async () => {
  const s = new KeyedSemaphore(3, 1, 3);
  const a1 = await s.acquire('A');
  let a2got = false; const a2 = s.acquire('A').then(r => { a2got = true; return r; });
  const b1 = await s.acquire('B');                 // not blocked behind A's waiter
  assert.equal(a2got, false);
  const c1 = await s.acquire('C');                 // global cap now reached (3)
  const d = s.acquire('D'); const e = s.acquire('E');   // queue holds a2, d, e (maxQueue 3)
  await assert.rejects(s.acquire('F'), QueueFull);
  a1(); a1();                                      // double release must not double-free
  const a2r = await a2; assert.equal(a2got, true);
  assert.equal(s.stats().held, 3);
  a2r(); b1(); c1();
  (await d)(); (await e)();
  assert.equal(s.stats().held, 0);
});

// ---- policy ------------------------------------------------------------------------------
test('create body carries every isolation parameter', async () => {
  fake.script = { frames: [], exitCode: 0 };
  await Sandbox.create(client, policy, ident);
  const b = fake.created[0];
  const h = b.HostConfig;
  assert.equal(h.Runtime, 'runsc');
  assert.deepEqual(h.CapDrop, ['ALL']);
  assert.equal(h.ReadonlyRootfs, true);
  assert.equal(h.Privileged, false);
  assert.equal(h.NetworkMode, 'none');
  assert.equal(h.Memory, 512 * 1024 * 1024);
  assert.equal(h.MemorySwap, h.Memory);
  assert.equal(h.NanoCpus, 500_000_000);
  assert.ok(h.PidsLimit > 0);
  assert.ok(h.SecurityOpt.includes('no-new-privileges:true'));
  assert.match(h.Tmpfs['/tmp'], /noexec/);
  assert.match(h.Tmpfs['/workspace'], /uid=65534/);
  assert.equal(b.User, '65534:65534');
  assert.equal(b.Labels['nexus.managed'], 'true');
  assert.ok(Number(b.Labels['nexus.expires_at']) > Date.now() / 1000);
});

test('name collision replaces the stale container', async () => {
  fake.conflictOnce = true;
  await Sandbox.create(client, policy, ident);
  assert.equal(fake.removes, 1);
  assert.equal(fake.created.length, 1);
});

// ---- exec --------------------------------------------------------------------------------
test('exec: demuxes stdout/stderr across odd chunking and reads the exit code', async () => {
  const sb = await Sandbox.create(client, policy, ident);
  fake.script = { frames: [[1, 'compiling…\n'], [2, 'error TS2322: bad\n'], [1, 'done\n']], exitCode: 2, chunkSize: 7 };
  const seen: string[] = [];
  const r = await sb.exec({ argv: ['tsc', '--noEmit'], onFrame: async f => { seen.push(f.stream); } });
  assert.equal(r.exitCode, 2);
  assert.equal(r.termination, 'exit');
  assert.equal(r.stdout.text, 'compiling…\ndone\n');
  assert.equal(r.stderr.text, 'error TS2322: bad\n');
  assert.deepEqual(seen, ['stdout', 'stderr', 'stdout']);
  const body = fake.execBodies[0];
  assert.deepEqual(body.Cmd.slice(0, 4), ['timeout', '-k', '2', '60']);
  assert.deepEqual(body.Cmd.slice(4), ['tsc', '--noEmit']);
  assert.equal(body.Tty, false);
  assert.equal(body.WorkingDir, '/workspace');
});

test('exec: output flood is truncated, classified, and the sandbox is killed', async () => {
  const sb = await Sandbox.create(client, policy, ident);
  fake.script = { frames: Array.from({ length: 40 }, () => [1, Buffer.alloc(1000, 0x41)] as [1, Buffer]), exitCode: 137, chunkSize: 1008 };
  const r = await sb.exec({ argv: ['yes'] });
  assert.equal(r.termination, 'output_flood');
  assert.ok(r.stdout.totalBytes < 40_000);
  assert.ok(r.stdout.text.length <= policy.headBytes + policy.tailBytes + 100);
  assert.ok(fake.kills >= 1);
  assert.equal(sb.isDead, true);
  await assert.rejects(sb.exec({ argv: ['ls'] }), SandboxDead);
});

test('exec: host backstop kills a hung process', async () => {
  const sb = await Sandbox.create(client, policy, ident);
  fake.script = { frames: [[1, 'start\n']], exitCode: 137, hang: true };
  const r = await sb.exec({ argv: ['sleep', '999'], timeoutMs: 100 });
  assert.equal(r.termination, 'timeout');
  assert.ok(fake.kills >= 1);
  assert.equal(r.stdout.text, 'start\n');
});

test('exec: `timeout` exit code 124 is classified as timeout; >128 as signal/oom', async () => {
  const sb = await Sandbox.create(client, policy, ident);
  fake.script = { frames: [], exitCode: 124 };
  assert.equal((await sb.exec({ argv: ['x'] })).termination, 'timeout');
  fake.script = { frames: [], exitCode: 137 };
  assert.equal((await sb.exec({ argv: ['x'], timeoutMs: 60_000 })).termination, 'signal_or_oom');
});

test('exec: input validation', async () => {
  const sb = await Sandbox.create(client, policy, ident);
  await assert.rejects(sb.exec({ argv: [] }), InvalidRequest);
  await assert.rejects(sb.exec({ argv: ['a\0b'] }), InvalidRequest);
  await assert.rejects(sb.exec({ argv: ['ls'], cwd: '/etc' }), InvalidRequest);
  await assert.rejects(sb.exec({ argv: ['ls'], cwd: '/workspace/../etc' }), InvalidRequest);
  await assert.rejects(sb.exec({ argv: ['ls'], env: { 'bad name': 'x' } }), InvalidRequest);
});

test('writeFiles: streams a validated tar into `tar -x` inside the container (the archive API cannot write to tmpfs)', async () => {
  const sb = await Sandbox.create(client, policy, ident);
  await sb.writeFiles([{ path: 'src/index.ts', content: 'export {}' }]);
  assert.equal(fake.uploads.length, 1);
  assert.equal(parseTar(fake.uploads[0]!)[1]!.name, 'src/index.ts');
  const body = fake.execBodies[0];
  assert.equal(body.AttachStdin, true);
  assert.equal(body.User, '65534:65534');
  assert.equal(body.WorkingDir, '/workspace');
  assert.deepEqual(body.Cmd, ['timeout', '-k', '2', '30', 'tar', '-x', '-p', '-f', '-', '-C', '/workspace']);

  fake.script = { frames: [[2, 'tar: no space left on device']], exitCode: 2 };      // a failing tar surfaces its stderr
  await assert.rejects(sb.writeFiles([{ path: 'a.txt', content: 'x' }]), /exit 2.*no space left/);

  const before = fake.execBodies.length;
  await assert.rejects(sb.writeFiles([{ path: '../escape', content: 'x' }]), PathError);   // rejected before any daemon call
  assert.equal(fake.execBodies.length, before);
});

// ---- manager -----------------------------------------------------------------------------
test('manager: concurrent getOrCreate for one run creates exactly one container', async () => {
  const m = new SandboxManager(client, policy);
  const all = await Promise.all(Array.from({ length: 8 }, () => m.getOrCreate(ident)));
  assert.equal(fake.created.length, 1);
  assert.ok(all.every(s => s === all[0]));
  await m.closeAll();
});

test('manager: fails closed when runsc is missing; dev flag falls back to runc', async () => {
  fake.runtimes = ['runc'];
  await assert.rejects(new SandboxManager(client, policy).getOrCreate(ident), RuntimeUnavailable);
  assert.equal(fake.created.length, 0);
  const dev = new SandboxManager(client, { ...policy, allowRuncFallback: true });
  await dev.getOrCreate(ident);
  assert.equal(fake.created[0].HostConfig.Runtime, 'runc');
  await dev.closeAll();
});

test('manager: dead sandbox is replaced; slots are released; orphans are reaped', async () => {
  const m = new SandboxManager(client, { ...policy, maxPerTenant: 1 });
  const s1 = await m.getOrCreate(ident);
  await s1.kill();
  const s2 = await m.getOrCreate(ident);          // would deadlock if the dead one still held the slot
  assert.notEqual(s1, s2);
  assert.equal(m.stats().live, 1);
  await m.closeAll();
  fake.listed = [
    { Id: 'old', Labels: { 'nexus.expires_at': String(Math.floor(Date.now() / 1000) - 3600) } },
    { Id: 'fresh', Labels: { 'nexus.expires_at': String(Math.floor(Date.now() / 1000) + 3600) } },
  ];
  const before = fake.removes;
  assert.equal(await m.reapOrphans(), 1);
  assert.equal(fake.removes, before + 1);
});
