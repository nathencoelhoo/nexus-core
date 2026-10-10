/**
 * Minimal deterministic USTAR writer for PUT /containers/{id}/archive.
 * - Paths are validated (no traversal, no absolute paths, no NULs).
 * - Parent directories are emitted explicitly with the sandbox uid/gid. Docker would
 *   otherwise create implied parents as root, leaving them unwritable for the sandbox user.
 * - mtime is pinned to 0, so identical inputs produce byte-identical archives.
 */
export class PathError extends Error {}

export interface TarFile { path: string; content: Buffer | string; mode?: number }
export interface TarOptions { uid?: number; gid?: number; maxFiles?: number; maxTotalBytes?: number }

const BLOCK = 512;

export function validateRelPath(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0) throw new PathError('empty path');
  if (p.includes('\0') || p.includes('\\')) throw new PathError(`illegal character in path: ${JSON.stringify(p)}`);
  if (p.startsWith('/')) throw new PathError(`absolute path not allowed: ${p}`);
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new PathError(`illegal path segment in: ${p}`);
  }
  if (Buffer.byteLength(p) > 98) throw new PathError(`path too long (max 98 bytes): ${p}`);
  return p;
}

function octal(h: Buffer, off: number, len: number, n: number): void {
  const s = n.toString(8).padStart(len - 1, '0');
  if (s.length > len - 1) throw new Error('octal field overflow');
  h.write(s, off, 'ascii');
  h[off + len - 1] = 0;
}

function header(name: string, type: '0' | '5', size: number, mode: number, uid: number, gid: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  octal(h, 100, 8, mode);
  octal(h, 108, 8, uid);
  octal(h, 116, 8, gid);
  octal(h, 124, 12, size);
  octal(h, 136, 12, 0);
  h.fill(0x20, 148, 156);                 // checksum field counts as spaces while summing
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

export function buildTar(files: TarFile[], opts: TarOptions = {}): Buffer {
  const uid = opts.uid ?? 65534;
  const gid = opts.gid ?? 65534;
  const maxFiles = opts.maxFiles ?? 2000;
  const maxTotal = opts.maxTotalBytes ?? 16 * 1024 * 1024;
  if (files.length > maxFiles) throw new PathError(`too many files (${files.length} > ${maxFiles})`);

  const seen = new Set<string>();
  const dirs: string[] = [];
  const dirSet = new Set<string>();
  let total = 0;

  for (const f of files) {
    const p = validateRelPath(f.path);
    if (seen.has(p)) throw new PathError(`duplicate path: ${p}`);
    seen.add(p);
    const content = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    total += content.length;
    if (total > maxTotal) throw new PathError(`payload exceeds ${maxTotal} bytes`);
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/');
      if (!dirSet.has(d)) { dirSet.add(d); dirs.push(d); }
    }
  }
  for (const d of dirSet) if (seen.has(d)) throw new PathError(`path used as both file and directory: ${d}`);

  const parts: Buffer[] = [];
  for (const d of dirs) parts.push(header(`${d}/`, '5', 0, 0o755, uid, gid));
  for (const f of files) {
    const content = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    const mode = (f.mode ?? 0o644) & 0o777;
    parts.push(header(f.path, '0', content.length, mode, uid, gid), content);
    const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));    // end-of-archive marker
  return Buffer.concat(parts);
}
