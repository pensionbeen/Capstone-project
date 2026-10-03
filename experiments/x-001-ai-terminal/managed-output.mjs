import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

export function bulkEvidence(output, nonce, expected) {
  if (!/^[a-f0-9]{12}$/u.test(nonce)) throw new Error('INVALID_NONCE');
  const clean = stripVTControlCharacters(output);
  // Require observed line boundaries. Normalize an observed CRLF, never invent LF.
  const lines = [...clean.matchAll(new RegExp('^X001_BURST_' + nonce + ' (\\d{4}) abcdef0123456789\\r?\\n', 'gmu'))];
  const payload = lines.map(match => match[0].replace(/\r\n$/u, '\n')).join('');
  const bytes = Buffer.byteLength(payload);
  const hash = createHash('sha256').update(payload).digest('hex');
  return { pass: Number.isSafeInteger(expected.lines) && expected.lines > 0 &&
    lines.length === expected.lines && lines.every((match, index) => Number(match[1]) === index) &&
    bytes === expected.bytes && hash === expected.hash,
  lines: lines.length, bytes, hash };
}
