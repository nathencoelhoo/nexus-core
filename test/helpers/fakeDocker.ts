import * as http from 'node:http';
import type * as net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function frame(type: 1 | 2 | 3, s: string | Buffer): Buffer {
  const data = typeof s === 'string' ? Buffer.from(s) : s;
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
}

export interface Script { frames: Array<[1 | 2 | 3, string | Buffer]>; exitCode: number; hang?: boolean; chunkSize?: number }

/** In-process fake Docker daemon on a unix socket, including the 101-hijack exec/start path. */
export class FakeDocker {
  socketPath: string;
  created: any[] = [];
  archives: Buffer[] = [];
  execBodies: any[] = [];
  kills = 0;
  removes = 0;
  runtimes: string[] = ['runc', 'runsc'];
  script: Script = { frames: [], exitCode: 0 };
  conflictOnce = false;
  listed: any[] = [];
  private dir: string;
  private server: http.Server;
  private sockets = new Set<net.Socket>();

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'fakedocker-'));
    this.socketPath = join(this.dir, 'd.sock');
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('upgrade', (_req, socket) => this.upgrade(socket as net.Socket));
  }

  static async start(): Promise<FakeDocker> {
    const f = new FakeDocker();
    await new Promise<void>(r => f.server.listen(f.socketPath, r));
    return f;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>(r => this.server.close(() => r()));
    rmSync(this.dir, { recursive: true, force: true });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = (req.url ?? '').replace(/^\/v1\.\d+/, '');
      const m = req.method;
      const send = (code: number, obj?: unknown) => {
        res.statusCode = code;
        if (obj !== undefined) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); } else res.end();
      };
      if (m === 'GET' && path === '/info') return send(200, { Runtimes: Object.fromEntries(this.runtimes.map(r => [r, {}])) });
      if (m === 'POST' && path.startsWith('/containers/create')) {
        if (this.conflictOnce) { this.conflictOnce = false; return send(409, { message: 'name in use' }); }
        this.created.push(JSON.parse(body.toString()));
        return send(201, { Id: 'c1' });
      }
      if (m === 'POST' && path === '/containers/c1/start') return send(204);
      if (m === 'PUT' && path.startsWith('/containers/c1/archive')) { this.archives.push(body); return send(200); }
      if (m === 'POST' && path === '/containers/c1/exec') { this.execBodies.push(JSON.parse(body.toString())); return send(201, { Id: 'e1' }); }
      if (m === 'GET' && path === '/exec/e1/json') return send(200, { Running: false, ExitCode: this.script.exitCode });
      if (m === 'POST' && path.startsWith('/containers/c1/kill')) {
        this.kills++;
        for (const s of this.sockets) s.end();
        return send(204);
      }
      if (m === 'DELETE' && path.startsWith('/containers/')) { this.removes++; return send(204); }
      if (m === 'GET' && path.startsWith('/containers/json')) return send(200, this.listed);
      send(404, { message: `no route ${m} ${path}` });
    });
  }

  private upgrade(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    const wire = Buffer.concat(this.script.frames.map(([t, s]) => frame(t, s)));
    const size = this.script.chunkSize ?? Math.max(wire.length, 1);
    let off = 0;
    const pump = () => {
      if (socket.destroyed) return;
      if (off >= wire.length) { if (!this.script.hang) socket.end(); return; }
      socket.write(wire.subarray(off, off + size));
      off += size;
      setTimeout(pump, 1);
    };
    pump();
  }
}
