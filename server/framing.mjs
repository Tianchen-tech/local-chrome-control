import { endianness } from 'node:os';
const little = endianness() === 'LE';
export function nativeFrame(message, max = 1024 * 1024) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (!body.length || body.length > max) throw new Error('FRAME_TOO_LARGE');
  const prefix = Buffer.alloc(4);
  if (little) prefix.writeUInt32LE(body.length); else prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
export class NativeDecoder {
  constructor(onMessage, max = 12 * 1024 * 1024) { this.buffer = Buffer.alloc(0); this.onMessage = onMessage; this.max = max; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = little ? this.buffer.readUInt32LE(0) : this.buffer.readUInt32BE(0);
      if (!length || length > this.max) throw new Error('INVALID_FRAME_LENGTH');
      if (this.buffer.length < length + 4) break;
      const value = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
      this.buffer = this.buffer.subarray(length + 4);
      this.onMessage(value);
    }
    if (this.buffer.length > this.max + 4) throw new Error('FRAME_TOO_LARGE');
  }
  end() { if (this.buffer.length) throw new Error('TRUNCATED_FRAME'); }
}
export class LineDecoder {
  constructor(onMessage, max = 256 * 1024) { this.buffer = Buffer.alloc(0); this.onMessage = onMessage; this.max = max; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let at;
    while ((at = this.buffer.indexOf(10)) >= 0) {
      if (at > this.max) throw new Error('LINE_TOO_LARGE');
      const line = this.buffer.subarray(0, at).toString('utf8').trim();
      this.buffer = this.buffer.subarray(at + 1);
      if (line) this.onMessage(JSON.parse(line));
    }
    if (this.buffer.length > this.max) throw new Error('LINE_TOO_LARGE');
  }
}
