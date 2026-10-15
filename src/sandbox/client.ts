import * as http from 'node:http';
import type { Duplex } from 'node:stream';

/** Pinned API version: behavior must not drift with the daemon (Docker 24+). */
const API = '/v1.43';

export class DockerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`docker ${status}: ${message}`);
    this.status = status;
  }
}

interface ReqOpts { body?: unknown; headers?: http.OutgoingHttpHeaders; timeoutMs?: number; ok?: number[] }

export interface ContainerSummary { Id: string; Names: string[]; Labels: Record<string, string>; State: string }

/** Zero-dependency Docker Engine API client over the unix socket. */
export class DockerClient {
  private socketPath: string;
  private defaultTimeoutMs: number;

  constructor(socketPath = '/var/run/docker.sock', defaultTimeoutMs = 30_000) {
    this.socketPath = socketPath;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  private request(method: string, path: string, o: ReqOpts = {}): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload = o.body === undefined ? undefined
        : Buffer.isBuffer(o.body) ? o.body : Buffer.from(JSON.stringify(o.body));
      const headers: http.OutgoingHttpHeaders = { ...o.headers };
      if (payload) {
        headers['Content-Length'] = payload.length;
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
      const req = http.request(
        { socketPath: this.socketPath, path: API + path, method, headers, timeout: o.timeoutMs ?? this.defaultTimeoutMs },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('error', reject);
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            const status = res.statusCode ?? 0;
            if ((o.ok ?? [200, 201, 204]).includes(status)) resolve({ status, body });
            else reject(new DockerError(status, body.toString('utf8').slice(0, 500)));
          });
        });
      req.on('timeout', () => req.destroy(new Error(`docker request timed out: ${method} ${path}`)));
      req.on('error', reject);
      req.end(payload);
    });
  }

  private async json<T>(method: string, path: string, o?: ReqOpts): Promise<T> {
    const r = await this.request(method, path, o);
    return JSON.parse(r.body.toString('utf8')) as T;
  }

  async info(): Promise<{ Runtimes?: Record<string, unknown> }> {
    return this.json('GET', '/info');
  }

  createContainer(name: string, body: unknown): Promise<{ Id: string }> {
    return this.json('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body });
  }

  async startContainer(id: string): Promise<void> {
    await this.request('POST', `/containers/${id}/start`, { ok: [204, 304] });
  }

  async killContainer(id: string): Promise<void> {
    await this.request('POST', `/containers/${id}/kill?signal=SIGKILL`, { ok: [204, 404, 409] });
  }

  async removeContainer(idOrName: string): Promise<void> {
    await this.request('DELETE', `/containers/${encodeURIComponent(idOrName)}?force=true&v=true`, { ok: [204, 404] });
  }

  listByLabel(label: string): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    return this.json('GET', `/containers/json?all=true&filters=${filters}`);
  }

  execCreate(containerId: string, body: unknown): Promise<{ Id: string }> {
    return this.json('POST', `/containers/${containerId}/exec`, { body });
  }

  execInspect(execId: string): Promise<{ Running: boolean; ExitCode: number | null }> {
    return this.json('GET', `/exec/${execId}/json`);
  }

  /**
   * POST /exec/{id}/start hijacks the HTTP connection into a raw bidirectional stream
   * (101 Switching Protocols). Some daemons answer 200 and stream the body instead; handle both.
   * If `stdin` is given (the exec must have AttachStdin) it is written and the write side is closed, which the
   * daemon turns into EOF on the process's stdin. Reading continues until the daemon ends the stream.
   */
  execStart(execId: string, stdin?: Buffer): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
      const req = http.request({
        socketPath: this.socketPath, path: `${API}/exec/${execId}/start`, method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': payload.length,
          Connection: 'Upgrade', Upgrade: 'tcp',
        },
      });
      req.once('upgrade', (_res, socket, head) => {
        if (head.length > 0) socket.unshift(head);   // bytes that arrived with the 101 headers
        if (stdin) socket.end(stdin);                // half-close: we keep reading the output
        resolve(socket);
      });
      req.once('response', res => {
        if (res.statusCode === 200) {
          if (stdin) { res.resume(); reject(new Error('daemon did not hijack the connection; cannot send stdin')); return; }
          resolve(res as unknown as Duplex);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => reject(new DockerError(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8').slice(0, 500))));
      });
      req.once('error', reject);
      req.end(payload);
    });
  }
}
