import { createHash } from 'node:crypto';
import type { Diagnostic } from './types.ts';

export const sha256 = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

/** Strip everything that varies between otherwise-identical failures. */
export function normalizeMessage(m: string): string {
  return m
    .replace(/\[REDACTED:([a-z_]+):[0-9a-f]+\]/g, '[REDACTED:$1]')       // scrubber tags vary per value
    .replace(/\x1b\[[0-9;]*m/g, '')                                   // ANSI
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<ts>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@+-]+)+[\\/]([\w.@+-]+)/g, '$1') // abs path -> basename
    .replace(/:\d+(?::\d+)?/g, '')                                    // :line:col
    .replace(/\b(pid|tid)[ =:]\d+/gi, '$1 <n>')
    .replace(/\s+/g, ' ')
    .trim();
}

const isFrameworkFrame = (f: string) =>
  /node_modules|node:internal|\/usr\/lib|<anonymous>/.test(f);

export function topUserFrameSymbol(frames: string[] = []): string {
  const f = frames.find(x => !isFrameworkFrame(x));
  if (!f) return '';
  const m = /at\s+([^\s(]+)/.exec(f);
  return m?.[1] ?? normalizeMessage(f);
}

export function fingerprint(d: Diagnostic): string {
  return sha256([d.tool, d.code, normalizeMessage(d.message), topUserFrameSymbol(d.frames)].join('\0'));
}

/** Order-independent fingerprint of the whole failure set. */
export function failureSetFingerprint(ds: Diagnostic[]): string {
  return sha256([...new Set(ds.map(fingerprint))].sort().join('|'));
}
