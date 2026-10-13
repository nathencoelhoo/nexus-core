import { createHmac, randomBytes } from 'node:crypto';
import type { Hmac } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { DETECTORS } from './detectors.ts';
import type { Detector, Kind } from './detectors.ts';

/** Compile-time proof that text went through a scrubber. Third-party egress (LLM, embeddings) accepts only this. */
export type Scrubbed = string & { readonly __scrubbed: true };
export const asScrubbed = (s: string): Scrubbed => s as Scrubbed;

export interface ScrubberOpts {
  /** Per-run secret for the placeholder tag (HMAC), so low-entropy PII cannot be dictionary-attacked from the tag. */
  salt: Buffer;
  detectors?: Detector[];
  /** A partial line longer than this is force-emitted (minus `overlap`). Bounds memory. */
  maxLine?: number;
  /** Tail always retained when force-emitting: must exceed the longest possible match. */
  overlap?: number;
  maxKeyBlock?: number;
  onRedaction?: (e: { name: string; kind: Kind }) => void;
}

interface Span { start: number; end: number; name: string; kind: Kind; prio: number }

const BEGIN_RE = /-----BEGIN[A-Z0-9 ]{0,40}PRIVATE KEY-----/;
const END_RE = /-----END[A-Z0-9 ]{0,40}PRIVATE KEY-----/;

function merge(spans: Span[]): Span[] {
  spans.sort((a, b) => a.start - b.start || a.prio - b.prio);
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;                 // union: never leave a tail unredacted
      if (s.prio < last.prio) { last.prio = s.prio; last.name = s.name; last.kind = s.kind; }
    } else out.push({ ...s });
  }
  return out;
}

/**
 * Streaming redactor. Guarantees:
 *  - A match is never split across emitted output (chunk boundaries cannot hide a secret).
 *  - Output is independent of how the input was chunked.
 *  - Memory is bounded by maxLine + chunk size; multi-byte characters split across chunks are reassembled.
 * Text is released at line boundaries; a partial line is held until its newline, a force-emit, or flush().
 */
export class StreamScrubber {
  readonly counts: Record<string, number> = {};
  private salt: Buffer;
  private detectors: Detector[];
  private maxLine: number;
  private overlap: number;
  private maxKeyBlock: number;
  private onRedaction?: (e: { name: string; kind: Kind }) => void;
  private dec = new StringDecoder('utf8');
  private pending = '';
  private inKey = false;
  private keyBytes = 0;
  private keyHmac: Hmac | null = null;

  constructor(o: ScrubberOpts) {
    this.salt = o.salt;
    this.detectors = o.detectors ?? DETECTORS;
    this.maxLine = o.maxLine ?? 65_536;
    this.overlap = o.overlap ?? 8_192;
    this.maxKeyBlock = o.maxKeyBlock ?? 65_536;
    this.onRedaction = o.onRedaction;
  }

  write(chunk: Buffer | string): string {
    const s = typeof chunk === 'string' ? chunk : this.dec.write(chunk);
    const base = this.pending.length;
    this.pending += s;
    let out = '';
    const term = Math.max(s.lastIndexOf('\n'), s.lastIndexOf('\r'));
    if (term >= 0) out += this.emitUpTo(base + term + 1);
    if (this.pending.length >= this.maxLine) {
      if (this.inKey) {                       // garbage inside a key block with no newlines: drop all but the tail
        this.keyBytes += this.pending.length - this.overlap;
        this.pending = this.pending.slice(-this.overlap);
      } else out += this.emitUpTo(this.pending.length - this.overlap);
    }
    return out;
  }

  /** End of stream. Fails closed: an unterminated private-key block is still redacted. */
  flush(): string {
    this.pending += this.dec.end();
    let out = this.pending.length > 0 ? this.emitUpTo(this.pending.length) : '';
    if (this.inKey) out += this.closeKey();
    return out;
  }

  private emitUpTo(limitIn: number): string {
    const text = this.pending;
    let limit = Math.min(limitIn, text.length);
    if (limit <= 0) return '';

    // A limit inside a line must not cut through a completed match.
    if (limit < text.length && !/[\r\n]/.test(text[limit - 1]!) && !this.inKey) {
      const ls = Math.max(text.lastIndexOf('\n', limit - 1), text.lastIndexOf('\r', limit - 1)) + 1;
      const tail = text.slice(ls);
      for (let changed = true; changed;) {
        changed = false;
        for (const sp of this.find(tail)) {
          const s = ls + sp.start; const e = ls + sp.end;
          if (s < limit && limit < e) { limit = s; changed = true; }
        }
      }
      if (limit <= 0) return '';
    }

    this.pending = text.slice(limit);
    // Every complete line yields its output plus '\n' (dropped key-body lines yield nothing, newline included), so the
    // result cannot depend on where emissions happened to split. The final segment is a partial line (or empty).
    const segs = text.slice(0, limit).split('\n');
    const last = segs.pop()!;
    let out = '';
    for (const line of segs) {
      const r = this.processLine(line);
      if (r !== null) out += `${r}\n`;
    }
    if (last.length > 0) {
      const r = this.processLine(last);
      if (r !== null) out += r;
    }
    return out;
  }

  private processLine(line: string): string | null {
    if (this.inKey) {
      this.keyBytes += line.length + 1;
      const end = END_RE.exec(line);
      if (end) {
        this.keyHmac!.update(line.slice(0, end.index + end[0].length));
        return this.closeKey() + this.scanLine(line.slice(end.index + end[0].length));
      }
      this.keyHmac!.update(line).update('\n');
      if (this.keyBytes > this.maxKeyBlock) return this.closeKey();
      return null;                                           // drop key body lines (and their newline)
    }
    const b = BEGIN_RE.exec(line);
    if (b && !END_RE.test(line.slice(b.index + b[0].length))) {
      this.inKey = true;
      this.keyBytes = 0;
      this.keyHmac = createHmac('sha256', this.salt).update('private_key\0').update(line.slice(b.index)).update('\n');
      return this.scanLine(line.slice(0, b.index));
    }
    return this.scanLine(line);
  }

  private closeKey(): string {
    const tag = this.keyHmac!.digest('hex').slice(0, 8);
    this.inKey = false; this.keyHmac = null; this.keyBytes = 0;
    this.count('private_key', 'secret');
    return `[REDACTED:private_key:${tag}]`;
  }

  private find(line: string): Span[] {
    const spans: Span[] = [];
    for (const [prio, d] of this.detectors.entries()) {
      if (d.hint && !d.hint.test(line)) continue;
      for (const m of line.matchAll(d.re)) {
        const ix = m.indices?.[d.group ?? 0];
        if (!ix) continue;
        const [s, e] = ix;
        if (d.validate && !d.validate(line.slice(s, e), line, s)) continue;
        spans.push({ start: s, end: e, name: d.name, kind: d.kind, prio });
      }
    }
    return spans;
  }

  private scanLine(line: string): string {
    if (line.length < 6) return line;
    const spans = merge(this.find(line));
    if (spans.length === 0) return line;
    let out = ''; let pos = 0;
    for (const sp of spans) {
      const tag = createHmac('sha256', this.salt).update(sp.name).update('\0').update(line.slice(sp.start, sp.end)).digest('hex').slice(0, 8);
      out += `${line.slice(pos, sp.start)}[REDACTED:${sp.name}:${tag}]`;
      pos = sp.end;
      this.count(sp.name, sp.kind);
    }
    return out + line.slice(pos);
  }

  private count(name: string, kind: Kind): void {
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    this.onRedaction?.({ name, kind });
  }
}

export class ScrubTransform extends Transform {
  readonly scrubber: StreamScrubber;
  constructor(o: ScrubberOpts) { super(); this.scrubber = new StreamScrubber(o); }
  override _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback): void {
    try { const out = this.scrubber.write(chunk); if (out) this.push(out); cb(); } catch (e) { cb(e as Error); }
  }
  override _flush(cb: TransformCallback): void {
    try { const out = this.scrubber.flush(); if (out) this.push(out); cb(); } catch (e) { cb(e as Error); }
  }
}

export const randomSalt = (): Buffer => randomBytes(32);

/** One-shot, for text assembled in memory (prompts, diffs, diagnostics). */
export function scrubText(text: string, o: ScrubberOpts): Scrubbed {
  const s = new StreamScrubber(o);
  return asScrubbed(s.write(text) + s.flush());
}
