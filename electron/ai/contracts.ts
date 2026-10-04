import { randomUUID } from 'node:crypto';
import type { AIReply, TerminalChunk } from '../../shared/ai.js';

export const MAX_PROMPT = 8000;
export const MAX_OUTPUT = 512 * 1024;
export const MAX_READ = 64 * 1024;
export const MAX_TURN_OUTPUT = 8 * 1024 * 1024;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function promptIsValid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_PROMPT &&
    !Array.from(value).some((char) => {
      const code = char.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  );
}
export function sizeIsValid(cols: unknown, rows: unknown): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    Number(cols) >= 20 &&
    Number(cols) <= 512 &&
    Number(rows) >= 5 &&
    Number(rows) <= 120
  );
}
export const rejected = (message: string): AIReply => ({ ok: false, message });

// Bounded replay; the renderer pulls at most 64 KiB and never owns the PTY.
export class OutputBuffer {
  readonly id = randomUUID();
  chunks: TerminalChunk[] = [];
  bytes = 0;
  next = 0;
  truncated = false;
  append(data: string, cols: number, rows: number) {
    for (let index = 0; index < data.length; index += 4096) {
      const chunk = { sequence: this.next++, data: data.slice(index, index + 4096), cols, rows };
      this.chunks.push(chunk);
      this.bytes += Buffer.byteLength(chunk.data);
    }
    while (this.bytes > MAX_OUTPUT || this.chunks.length > 2048) {
      const removed = this.chunks.shift();
      if (!removed) break;
      this.bytes -= Buffer.byteLength(removed.data);
      this.truncated = true;
    }
  }
  read(after: number) {
    const result: TerminalChunk[] = [];
    let bytes = 0;
    for (const chunk of this.chunks) {
      if (chunk.sequence < after) continue;
      const size = Buffer.byteLength(chunk.data);
      if (bytes + size > MAX_READ) break;
      result.push(chunk);
      bytes += size;
    }
    return result;
  }
}
