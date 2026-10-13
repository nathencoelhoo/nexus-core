import { Demuxer } from './demux.ts';
import type { Frame } from './demux.ts';
import { BoundedCapture } from './capture.ts';
import type { Captured } from './capture.ts';
import { buildCreateBody } from './policy.ts';
import type { SandboxPolicy } from './policy.ts';
import { buildTar } from './tar.ts';
import type { TarFile } from './tar.ts';
import { DockerClient, DockerError } from './client.ts';

export class SandboxDead extends Error {}
export class InvalidRequest extends Error {}

export type Termination = 'exit' | 'timeout' | 'signal_or_oom' | 'output_flood';

export interface ExecOptions {
  argv: string[];
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  /** Awaited per frame: a slow consumer stalls the socket read, which backpressures the daemon. */
  onFrame?: (f: Frame) => void | Promise<void>;
  /**
   * Factory for a streaming redactor (one per stream). Scrubbing happens BEFORE head+tail capture: truncating first
   * could cut a secret in half and leave an unmatchable fragment in the output.
   */
  scrub?: () => { write(b: Buffer): string; flush(): string };
}

export interface ExecResult {
  exitCode: number | null;
  termination: Termination;
  stdout: Captured;
  stderr: Captured;
  daemonErrors: string[];
  durationMs: number;
}

export interface Ident { tenantId: string; runId: string }

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function containerName(i: Ident): string {
  if (!ID_RE.test(i.tenantId) || !ID_RE.test(i.runId)) throw new InvalidRequest('invalid tenant/run id');
  return `nexus-${i.tenantId}-${i.runId}`;
}

function validateArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64) throw new InvalidRequest('argv must have 1..64 entries');
  for (const a of argv) {
    if (typeof a !== 'string' || a.length > 8192 || a.includes('\0')) throw new InvalidRequest('invalid argv entry');
  }
  return argv as string[];
}

function validateCwd(cwd: string | undefined): string {
  if (cwd === undefined) return '/workspace';
  if (!/^\/workspace(\/[\w.@+-]+)*$/.test(cwd) || cwd.includes('..')) throw new InvalidRequest('cwd must be under /workspace');
  return cwd;
}

function validateEnv(env: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(k) || typeof v !== 'string' || v.length > 1024 || v.includes('\0'))
      throw new InvalidRequest(`invalid env var: ${k}`);
    out.push(`${k}=${v}`);
  }
  if (out.length > 32) throw new InvalidRequest('too many env vars');
  return out;
}

/**
 * One long-lived sandbox per run. Code -> Compile -> Test -> Patch all exec into the same
 * container, so workspace state (build caches, generated files) survives between steps.
 */
export class Sandbox {
  readonly id: string;
  readonly name: string;
  private client: DockerClient;
  private policy: SandboxPolicy;
  private dead = false;

  private constructor(client: DockerClient, policy: SandboxPolicy, id: string, name: string) {
    this.client = client;
    this.policy = policy;
    this.id = id;
    this.name = name;
  }

  get isDead(): boolean { return this.dead; }

  static async create(client: DockerClient, policy: SandboxPolicy, ident: Ident): Promise<Sandbox> {
    const name = containerName(ident);
    const expiresAt = Math.floor(Date.now() / 1000) + policy.ttlSeconds;
    const body = buildCreateBody(policy, {
      'nexus.managed': 'true',
      'nexus.tenant': ident.tenantId,
      'nexus.run': ident.runId,
      'nexus.expires_at': String(expiresAt),
    });
    let id: string;
    try {
      id = (await client.createContainer(name, body)).Id;
    } catch (e) {
      // Name collision = leftover from a crashed orchestrator. The workspace is reproducible
      // from the event log, so replace it rather than adopt unknown state.
      if (e instanceof DockerError && e.status === 409) {
        await client.removeContainer(name);
        id = (await client.createContainer(name, body)).Id;
      } else throw e;
    }
    try {
      await client.startContainer(id);
    } catch (e) {
      await client.removeContainer(id).catch(() => undefined);
      throw e;
    }
    return new Sandbox(client, policy, id, name);
  }

  async writeFiles(files: TarFile[]): Promise<{ files: number; bytes: number }> {
    this.assertAlive();
    const tar = buildTar(files);           // validates paths and sizes before touching the daemon
    // Archive upload must target a RUNNING container: tmpfs mounts only exist after start.
    await this.client.putArchive(this.id, '/workspace', tar);
    return { files: files.length, bytes: tar.length };
  }

  async exec(o: ExecOptions): Promise<ExecResult> {
    this.assertAlive();
    const argv = validateArgv(o.argv);
    const cwd = validateCwd(o.cwd);
    const env = validateEnv(o.env);
    const timeoutMs = Math.min(Math.max(o.timeoutMs ?? this.policy.defaultExecMs, 100), this.policy.maxExecMs);
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const started = performance.now();

    // argv goes straight to execve inside the sandbox: the host never builds a shell string.
    // `timeout` is the first line of defense; the host-side timer below is the backstop.
    const { Id: execId } = await this.client.execCreate(this.id, {
      AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false,
      User: this.policy.user, WorkingDir: cwd, Env: env,
      Cmd: ['timeout', '-k', '2', String(secs), ...argv],
    });
    const stream = await this.client.execStart(execId);

    const demux = new Demuxer();
    const out = new BoundedCapture(this.policy.headBytes, this.policy.tailBytes);
    const err = new BoundedCapture(this.policy.headBytes, this.policy.tailBytes);
    const daemonErrors: string[] = [];
    let total = 0;
    let flood = false;
    let hardTimeout = false;

    const sOut = o.scrub?.();
    const sErr = o.scrub?.();
    const timer = setTimeout(() => { hardTimeout = true; void this.kill(); }, timeoutMs + this.policy.killGraceMs);
    try {
      for await (const chunk of stream) {
        for (const f of demux.push(chunk as Buffer)) {
          total += f.data.length;                       // raw bytes: the flood guard must not depend on redaction
          if (f.stream === 'daemon') { daemonErrors.push(f.data.toString('utf8').slice(0, 1024)); continue; }
          const sc = f.stream === 'stdout' ? sOut : sErr;
          const data = sc ? Buffer.from(sc.write(f.data), 'utf8') : f.data;
          if (data.length === 0) continue;              // scrubber is holding a partial line
          (f.stream === 'stdout' ? out : err).push(data);
          if (o.onFrame) await o.onFrame({ stream: f.stream, data });
        }
        if (total > this.policy.floodBytes) { flood = true; break; }
      }
      if (!flood && !hardTimeout) demux.end();
    } catch (e) {
      await this.kill();                    // desynced or broken stream: never trust this sandbox again
      throw e;
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }

    // Release whatever the scrubbers were holding (fails closed on unterminated key blocks).
    for (const [sc, cap, stream] of [[sOut, out, 'stdout'], [sErr, err, 'stderr']] as const) {
      const rest = sc?.flush();
      if (rest) {
        const data = Buffer.from(rest, 'utf8');
        cap.push(data);
        if (o.onFrame) await o.onFrame({ stream, data });
      }
    }

    // Disconnecting does not stop the process, so a flooder must be killed, not just ignored.
    if (flood) await this.kill();

    const exitCode = await this.waitExit(execId);
    const durationMs = Math.round(performance.now() - started);

    let termination: Termination = 'exit';
    if (flood) termination = 'output_flood';
    else if (hardTimeout) termination = 'timeout';
    else if (exitCode === 124 || (exitCode === 137 && durationMs >= timeoutMs - 250)) termination = 'timeout';
    else if (exitCode !== null && exitCode > 128) termination = 'signal_or_oom';

    return { exitCode, termination, stdout: out.result(), stderr: err.result(), daemonErrors, durationMs };
  }

  async kill(): Promise<void> {
    this.dead = true;
    await this.client.killContainer(this.id).catch(() => undefined);
  }

  async destroy(): Promise<void> {
    this.dead = true;
    await this.client.removeContainer(this.id).catch(() => undefined);
  }

  /** ExitCode is null while Running; poll briefly to close the race after the stream EOFs. */
  private async waitExit(execId: string): Promise<number | null> {
    let last: number | null = null;
    for (let i = 0; i < 40; i++) {
      const r = await this.client.execInspect(execId).catch(() => null);
      if (r && !r.Running && r.ExitCode !== null && r.ExitCode !== undefined) return r.ExitCode;
      if (r && r.ExitCode !== null && r.ExitCode !== undefined) last = r.ExitCode;
      await sleep(25);
    }
    return last;
  }

  private assertAlive(): void {
    if (this.dead) throw new SandboxDead(`sandbox ${this.name} is dead`);
  }
}
