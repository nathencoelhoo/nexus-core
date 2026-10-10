/**
 * Docker attach/exec streams are multiplexed when the exec has no TTY:
 *   [type:u8][0 0 0][size:u32 BE][payload...]   type 0=stdin 1=stdout 2=stderr 3=daemon error
 * TCP gives no framing guarantees, so a header or payload can be split across any chunk boundary.
 */
export type FrameStream = 'stdout' | 'stderr' | 'daemon';
export interface Frame { stream: FrameStream; data: Buffer }

export class FrameError extends Error {}

const HEADER = 8;
/** Protocol sanity bound: a corrupt size field must not make us buffer gigabytes. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class Demuxer {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Frame[] = [];
    let off = 0;
    while (this.buf.length - off >= HEADER) {
      const type = this.buf[off]!;
      if (type > 3 || this.buf[off + 1] !== 0 || this.buf[off + 2] !== 0 || this.buf[off + 3] !== 0) {
        // Almost always means the exec was created with Tty:true (raw stream) or we desynced.
        throw new FrameError(`invalid frame header at offset ${off}`);
      }
      const size = this.buf.readUInt32BE(off + 4);
      if (size > MAX_FRAME_BYTES) throw new FrameError(`frame size ${size} exceeds ${MAX_FRAME_BYTES}`);
      if (this.buf.length - off - HEADER < size) break;          // wait for the rest of the payload
      const start = off + HEADER;
      if (type !== 0) {
        out.push({
          stream: type === 1 ? 'stdout' : type === 2 ? 'stderr' : 'daemon',
          data: Buffer.from(this.buf.subarray(start, start + size)), // copy: don't pin the socket chunk
        });
      }
      off = start + size;
    }
    this.buf = off >= this.buf.length ? Buffer.alloc(0) : Buffer.from(this.buf.subarray(off));
    return out;
  }

  /** Call at EOF. A partial trailing frame means the stream was truncated. */
  end(): void {
    if (this.buf.length > 0) throw new FrameError(`truncated stream: ${this.buf.length} trailing bytes`);
  }
}
