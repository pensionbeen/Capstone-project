// Synthetic PTY guest: no network, no project reads/writes, no AI calls.
const data = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const id = data.conversation || '12345678-1234-4234-8234-123456789012';
process.stdout.write(
  `OpenAI Codex v0.160.0\r\n--------\r\nworkdir: ${process.cwd()}\r\nmodel: gpt-6.1-sol\r\nprovider: openai\r\napproval: never\r\nsandbox: read-only\r\nreasoning effort: high\r\nsession id: ${id}\r\n--------\r\nuser\r\n${data.prompt}\r\n`,
);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (input) => {
  if (input.includes(3)) {
    process.stdout.write('\r\nFIXTURE_STOP_RECEIVED\r\n');
    setTimeout(() => process.exit(1), 100);
  }
});
process.stdout.on('resize', () =>
  process.stdout.write(`\r\nFIXTURE_SIZE:${process.stdout.columns}x${process.stdout.rows}\r\n`),
);
if (data.prompt.includes('WAIT')) {
  setInterval(() => {}, 1000);
} else if (data.prompt.includes('BURST')) {
  let count = 0;
  const timer = setInterval(() => {
    process.stdout.write(`${count} 한글 출력 부하 ${'a'.repeat(800)}\r\n`.repeat(8));
    if (++count === 110) {
      clearInterval(timer);
      process.stdout.write('FIXTURE_BURST_END\r\n');
      setTimeout(() => process.exit(0), 700);
    }
  }, 30);
} else {
  setTimeout(() => {
    process.stdout.write(
      `\r\nFIXTURE_REPLY:한글 응답 ${data.conversation ? 'RESUMED' : 'FIRST'}\r\n`,
    );
    setTimeout(() => process.exit(0), 400);
  }, 2200);
}
