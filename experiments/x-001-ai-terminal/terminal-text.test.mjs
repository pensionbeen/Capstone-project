import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalText } from './terminal-text.mjs';
import { waitUntil } from './lib.mjs';

test('Terminal cursor moves preserve actual line positions and Korean text', async () => {
  const screen = new TerminalText(80, 12);
  try {
    screen.write('\u001b[2J\u001b[HOpenAI Codex v0.160.0\u001b[2;1H--------\u001b[3;1H한글 출력\r\n');
    await waitUntil(() => screen.pending, count => count === 0);
    assert.equal(screen.read(), 'OpenAI Codex v0.160.0\n--------\n한글 출력\n');
  } finally { screen.dispose(); }
});
test('Rendered output does not add a completed line after text without a line advance', async () => {
  const screen = new TerminalText(80, 12);
  try {
    screen.write('turn interrupted');
    await waitUntil(() => screen.pending, count => count === 0);
    assert.equal(screen.read(), 'turn interrupted');
  } finally { screen.dispose(); }
});
test('CR and absolute column moves do not become line advances', async () => {
  for (const suffix of ['\r', '\u001b[1G']) {
    const screen = new TerminalText(80, 12);
    try {
      screen.write('prefix\r\nturn interrupted' + suffix);
      await waitUntil(() => screen.pending, count => count === 0);
      assert.equal(screen.read(), 'prefix\nturn interrupted');
    } finally { screen.dispose(); }
  }
});

test('Automatic wrapping preserves spaces at the wrap boundary, including Korean', async () => {
  const screen = new TerminalText(5, 12);
  try {
    screen.write('abc  def\r\n한글 뒤\r\n');
    await waitUntil(() => screen.pending, count => count === 0);
    assert.equal(screen.read(), 'abc  def\n한글 뒤\n');
  } finally { screen.dispose(); }
});
