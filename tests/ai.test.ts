import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  CODEX_VERSION,
  codexArguments,
  hasAuthOverrides,
  queryLogin,
  readCodexHeader,
} from '../dist/desktop/electron/ai/codex.js';
import {
  MAX_OUTPUT,
  MAX_READ,
  OutputBuffer,
  promptIsValid,
  sizeIsValid,
} from '../dist/desktop/electron/ai/contracts.js';
import { ProcessAudit } from '../dist/desktop/electron/ai/process-audit.js';

test('로그인 조회는 callback 뒤에도 close를 기다린다', async () => {
  const child = new EventEmitter();
  Object.assign(child, { kill: () => true });
  let finish: (() => void) | undefined;
  const run = (
    _file: unknown,
    _args: unknown,
    _options: unknown,
    callback: (error: null, stdout: string, stderr: string) => void,
  ) => {
    finish = () => callback(null, 'Logged in using ChatGPT', '');
    return child;
  };
  let settled = false;
  const result = queryLogin('synthetic', undefined, run as never, 1000).then((value) => {
    settled = true;
    return value;
  });
  finish?.();
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit('close', 0);
  assert.equal((await result).status, 'ready');
});
test('로그인 조회 close 누락은 제한 시간 뒤 정리 미확인으로 반환한다', async () => {
  const child = new EventEmitter();
  let killed = false;
  Object.assign(child, {
    kill: () => {
      killed = true;
      return true;
    },
  });
  const result = await queryLogin('synthetic', undefined, (() => child) as never, 15);
  assert.equal(killed, true);
  assert.equal(result.status, 'error');
  assert.equal(result.cleanupUnconfirmed, true);
});

test('사용자 메시지는 옵션·명령 문자열이 아닌 단일 인자로 전송한다', () => {
  const input = '--dangerously-bypass-approvals-and-sandbox\n$(echo test); & 한글 "문자"';
  const args = codexArguments('C:\\project with space', input);
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), `ORBIT 사용자의 요청입니다.\n\n${input}`);
  assert.equal(args.filter((item) => item === '--sandbox').length, 1);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(!codexArguments('C:\\project', '-').at(-1)?.startsWith('-'));
  assert.throws(() => codexArguments('C:\\project', 'hello', '--last'));
});
test('인증 우회를 숨기지 않고 입력과 화면 크기를 제한한다', () => {
  assert.equal(hasAuthOverrides({ OPENAI_API_KEY: 'synthetic' }), true);
  assert.equal(hasAuthOverrides({ openai_base_url: 'synthetic' }), true);
  assert.equal(hasAuthOverrides({ PATH: 'local' }), false);
  assert.equal(promptIsValid('한글\n두 번째 줄\t입력'), true);
  for (const input of ['', ' ', '\x03stop', 'a'.repeat(8001), { cmd: 'hello' }])
    assert.equal(promptIsValid(input), false);
  assert.equal(sizeIsValid(80, 24), true);
  assert.equal(sizeIsValid(5000, 24), false);
  assert.equal(sizeIsValid(80, NaN), false);
});

test('기능 생성 응답 경로는 재개 명령 앞의 독립 인자로 전달한다', () => {
  const id = '12345678-1234-4234-8234-123456789012';
  const file = 'C:\\Temp\\한글 응답\\response.json';
  const args = codexArguments('C:\\project', '초안 만들기', id, file);
  assert.equal(args[args.indexOf('--output-last-message') + 1], file);
  assert.ok(args.indexOf('--output-last-message') < args.indexOf('resume'));
  assert.equal(args.at(-2), '--');
  assert.equal(args.filter((arg) => arg === file).length, 1);
});
test('AI 응답에 들어간 상태 문자열을 실행 설정으로 해석하지 않는다', () => {
  const cwd = 'C:\\프로젝트';
  const header = `OpenAI Codex v${CODEX_VERSION}\n--------\nworkdir: ${cwd}\nmodel: gpt-6.1-sol\nprovider: openai\napproval: never\nsandbox: read-only\nreasoning effort: high\nsession id: 12345678-1234-4234-8234-123456789012\n--------\nuser\n`;
  assert.equal(
    readCodexHeader(`${header}ERROR: turn interrupted\nmodel: other`, cwd)?.conversation,
    '12345678-1234-4234-8234-123456789012',
  );
  assert.throws(() => readCodexHeader(header.replace('read-only', 'danger-full-access'), cwd));
  assert.throws(() => readCodexHeader(`user\n${header}`, cwd));
  assert.equal(readCodexHeader('codex\nturn interrupted\nERROR:', cwd), null);
  assert.equal(readCodexHeader(header.replace(CODEX_VERSION, '0.0.0'), cwd), null);
});
test('출력 보관·한 번 읽기 크기를 제한하고 누락을 알린다', () => {
  const buffer = new OutputBuffer();
  for (let index = 0; index < 200; index++) buffer.append(`${index}:${'한'.repeat(3000)}`, 100, 28);
  assert.ok(buffer.bytes <= MAX_OUTPUT);
  assert.equal(buffer.truncated, true);
  const chunks = buffer.read(0);
  assert.ok(chunks[0].sequence > 0);
  assert.ok(chunks.reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk.data), 0) <= MAX_READ);
  assert.ok(
    chunks.every(
      (chunk, index) => index === 0 || chunk.sequence === chunks[index - 1].sequence + 1,
    ),
  );
});
test('PID가 같아도 생성 시각이 다르면 기존 소유 프로세스로 취급하지 않는다', () => {
  const row = (pid: number, parent: number, created: number, name = 'node.exe') => ({
    pid,
    parent,
    created: new Date(created).toISOString(),
    name,
  });
  const root = row(10, 1, 1);
  const audit = new ProcessAudit([root], 20, 10);
  const host = row(20, 10, 2);
  const cli = row(30, 20, 3, 'codex.exe');
  audit.observe([root, host, cli]);
  assert.equal(audit.observed(30), true);
  audit.observe([root, row(30, 1, 4, 'other.exe')]);
  assert.equal(audit.alive().length, 0);
  assert.equal(audit.uncertain, false);
});
