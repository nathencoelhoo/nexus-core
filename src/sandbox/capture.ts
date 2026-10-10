export interface Captured {
  text: string;
  totalBytes: number;
  droppedBytes: number;
}

/**
 * Bounded head+tail capture. Memory is O(headBytes + tailBytes) no matter how much a
 * process prints: compiler errors are usually at the top, test summaries at the bottom.
 */
export class BoundedCapture {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer = Buffer.alloc(0);
  private total = 0;
  private dropped = 0;
  private headCap: number;
  private tailCap: number;

  constructor(headCap: number, tailCap: number) {
    this.headCap = headCap;
    this.tailCap = tailCap;
  }

  push(data: Buffer): void {
    this.total += data.length;
    let rest = data;
    if (this.headLen < this.headCap) {
      const take = Math.min(this.headCap - this.headLen, rest.length);
      this.head.push(rest.subarray(0, take));
      this.headLen += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tail = Buffer.concat([this.tail, rest]);
    if (this.tail.length > this.tailCap) {
      const drop = this.tail.length - this.tailCap;
      this.dropped += drop;
      this.tail = this.tail.subarray(drop);
    }
  }

  result(): Captured {
    const head = Buffer.concat(this.head).toString('utf8');
    const text = this.dropped > 0
      ? `${head}\n[… ${this.dropped} bytes elided …]\n${this.tail.toString('utf8')}`
      : head + this.tail.toString('utf8');
    return { text, totalBytes: this.total, droppedBytes: this.dropped };
  }
}
