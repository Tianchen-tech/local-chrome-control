import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFrame, NativeDecoder, LineDecoder } from '../server/framing.mjs';
test('native protocol handles UTF-8 split at every byte and multiple messages', () => {
  const messages = [{ text: '中文 🏠' }, { answer: 42 }];
  const bytes = Buffer.concat(messages.map(m => nativeFrame(m)));
  const read = [], decoder = new NativeDecoder(m => read.push(m));
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  decoder.end(); assert.deepEqual(read, messages);
});
test('native protocol rejects oversized and truncated frames', () => {
  assert.throws(() => nativeFrame({ data: 'a'.repeat(100) }, 10), /FRAME_TOO_LARGE/);
  const d = new NativeDecoder(() => {}, 10);
  assert.throws(() => d.push(nativeFrame({ data: 'a'.repeat(100) })), /INVALID_FRAME_LENGTH/);
  const t = new NativeDecoder(() => {}); t.push(nativeFrame({ x: 1 }).subarray(0, 7));
  assert.throws(() => t.end(), /TRUNCATED_FRAME/);
});
test('JSONL decoder handles split Unicode and enforces limits', () => {
  const values = [], decoder = new LineDecoder(m => values.push(m));
  for (const byte of Buffer.from('{"x":"中文"}\n{"y":1}\n')) decoder.push(Buffer.from([byte]));
  assert.deepEqual(values, [{ x: '中文' }, { y: 1 }]);
  assert.throws(() => new LineDecoder(() => {}, 4).push(Buffer.from('12345')), /LINE_TOO_LARGE/);
});
