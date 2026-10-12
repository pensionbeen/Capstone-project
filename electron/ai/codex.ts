import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { AIAvailability } from '../../shared/ai.js';
import { UUID } from './contracts.js';

export const CODEX_VERSION = '0.162.1';
export const MODEL = 'gpt-6.1-sol';
export const EFFORT = 'high';

export function hasAuthOverrides(env: NodeJS.ProcessEnv) {
  const names = new Set([
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'CODEX_CHATGPT_BASE_URL',
  ]);
  return Object.keys(env).some((name) => names.has(name.toUpperCase()) && Boolean(env[name]));
}

export async function installedCodex(): Promise<string> {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !process.env.APPDATA)
    throw new Error('UNSUPPORTED_PLATFORM');
  const root = join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (metadata.name !== '@openai/codex' || metadata.version !== CODEX_VERSION)
    throw new Error('UNSUPPORTED_VERSION');
  const require = createRequire(join(root, 'bin', 'codex.js'));
  let vendor: string;
  try {
    vendor = join(dirname(require.resolve('@openai/codex-win32-x64/package.json')), 'vendor');
  } catch {
    vendor = join(root, 'vendor');
  }
  const file = join(vendor, 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  await access(file);
  return file;
}

export function queryLogin(
  file: string,
  signal?: AbortSignal,
  run = execFile,
  deadlineMs = 15000,
): Promise<AIAvailability> {
  return new Promise((resolve) => {
    let closed = false;
    let settled = false;
    let result: AIAvailability | undefined;
    const finish = () => {
      if (!closed || !result || settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const child = run(
      file,
      ['login', 'status'],
      { windowsHide: true, timeout: 10000, maxBuffer: 8192, signal },
      (error, stdout, stderr) => {
        const text = `${stdout}\n${stderr}`.trim();
        if (!error && /Logged in using ChatGPT/u.test(text))
          result = {
            status: 'ready',
            version: CODEX_VERSION,
            message:
              'Codex 설치와 ChatGPT 로그인을 확인했어요. 실제 응답은 메시지를 보내 확인해요.',
          };
        else if (/not logged in/iu.test(text))
          result = {
            status: 'login-required',
            version: CODEX_VERSION,
            message: '터미널에서 codex login으로 로그인한 뒤 다시 확인해 주세요.',
          };
        else
          result = {
            status: 'error',
            message:
              'Codex 로그인 상태를 확인하지 못했어요. 터미널에서 codex login status를 확인해 주세요.',
          };
        finish();
      },
    );
    child.once('close', () => {
      closed = true;
      finish();
    });
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (!closed) {
        try {
          child.kill();
        } catch {
          /* Report unconfirmed cleanup below. */
        }
      }
      resolve({
        status: 'error',
        cleanupUnconfirmed: !closed,
        message: '로그인 확인 프로그램의 종료를 확인하지 못했어요. 새 실행을 제한했어요.',
      });
    }, deadlineMs);
  });
}

export async function inspectCodex(signal?: AbortSignal): Promise<AIAvailability> {
  if (hasAuthOverrides(process.env))
    return {
      status: 'unsupported',
      message: '별도 API 인증 또는 접속 주소 설정이 있어 기존 로그인 방식을 확인해야 해요.',
    };
  try {
    const file = await installedCodex();
    return await queryLogin(file, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return message.startsWith('UNSUPPORTED')
      ? {
          status: 'unsupported',
          message: `현재 검증 대상은 Windows x64의 Codex ${CODEX_VERSION}이에요. 설치 버전을 확인해 주세요.`,
        }
      : {
          status: 'missing',
          message:
            '사용자 npm 설치 위치에서 Codex를 찾지 못했어요. Codex CLI 설치 후 다시 확인해 주세요.',
        };
  }
}

export function codexArguments(
  cwd: string,
  input: string,
  conversation?: string,
  resultFile?: string,
): string[] {
  if (conversation && !UUID.test(conversation)) throw new Error('INVALID_CONVERSATION');
  const args = [
    '--ask-for-approval',
    'never',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--model',
    MODEL,
    '-c',
    `model_reasoning_effort=${EFFORT}`,
    '-c',
    'project_root_markers=[]',
    '-c',
    'hide_agent_reasoning=true',
    '--disable',
    'hooks',
    '--disable',
    'plugins',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--cd',
    cwd,
  ];
  if (resultFile) args.push('--output-last-message', resultFile);
  if (conversation) args.push('resume', conversation);
  // A fixed prefix also keeps the special lone '-' prompt from selecting stdin.
  args.push('--', `ORBIT 사용자의 요청입니다.\n\n${input}`);
  return args;
}

// Only the first CLI-owned header is metadata; never parse user/AI text as status.
export function readCodexHeader(text: string, cwd: string): { conversation: string } | null {
  const match = text.match(
    new RegExp(
      `^OpenAI Codex v${CODEX_VERSION.replaceAll('.', '\\.')}\\n--------\\n([\\s\\S]{1,8192}?)\\n--------\\nuser\\n`,
      'mu',
    ),
  );
  if (!match || match.index === undefined || match.index > 4096) return null;
  if (/(?:^|\n)user\n/u.test(text.slice(0, match.index))) throw new Error('HEADER_INVALID');
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    const item = line.match(/^([a-z ]+): (.*)$/u);
    if (!item?.[1] || item[2] === undefined) continue;
    if (fields.has(item[1])) throw new Error('HEADER_DUPLICATE');
    fields.set(item[1], item[2]);
  }
  const conversation = fields.get('session id') ?? '';
  if (
    fields.get('model') !== MODEL ||
    fields.get('reasoning effort') !== EFFORT ||
    fields.get('provider') !== 'openai' ||
    fields.get('approval') !== 'never' ||
    fields.get('sandbox') !== 'read-only' ||
    fields.get('workdir') !== cwd ||
    !UUID.test(conversation)
  )
    throw new Error('HEADER_CONFIG_MISMATCH');
  return { conversation };
}
