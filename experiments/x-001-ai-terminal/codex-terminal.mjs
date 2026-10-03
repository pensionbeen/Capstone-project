import {
  authSummary, capture, cmdInvocation, codexPath, fileState, loadPty,
  pidState, report, workspace, terminalExitCode,
} from './lib.mjs';

let pty;
let command;
let blocked;
const file = codexPath();
if (process.platform !== 'win32' || !process.stdin.isTTY || !process.stdout.isTTY) {
  blocked = 'WINDOWS_INTERACTIVE_TERMINAL_REQUIRED';
} else if (await fileState(file) !== 'accessible') {
  blocked = 'CODEX_CMD_INACCESSIBLE';
} else {
  try {
    pty = loadPty();
    const login = cmdInvocation(file, ['login', 'status']);
    const auth = authSummary(await capture(login.file, login.args));
    if (!auth.statusCommandSucceeded || auth.method !== 'ChatGPT') {
      blocked = 'CHATGPT_LOGIN_NOT_CONFIRMED'; // No automatic login or API-key fallback.
    } else {
      const help = cmdInvocation(file, ['--help']);
      const result = await capture(help.file, help.args);
      const text = result.stdout + result.stderr;
      if (result.error || result.code !== 0 ||
          !['--sandbox', '--ask-for-approval', '--no-alt-screen', '--cd'].every((flag) => text.includes(flag))) {
        blocked = 'REQUIRED_FLAGS_NOT_CONFIRMED';
      } else {
        command = cmdInvocation(file, ['--sandbox', 'read-only',
          '--ask-for-approval', 'never', '--no-alt-screen', '--cd', await workspace()]);
      }
    }
  } catch (error) { blocked = error.code || 'PREPARATION_FAILED'; }
}
if (blocked) {
  await report('terminal', { status: 'BLOCKED', reason: blocked, actualResponse: 'NOT_RUN' });
  process.exitCode = 2;
} else {
  console.log('X-001: 가짜 프로젝트에서 Codex를 실행합니다. 원문 화면은 파일로 저장하지 않습니다.');
  console.log('Ctrl+C는 Codex에 전달됩니다. /quit으로 정상 종료, Ctrl+Q로 실험 세션 종료.');
  console.log('최대 10분. 실제 모델/응답/중단/재개와 남은 자식 프로세스는 별도로 확인하세요.');
  let terminal;
  try {
    terminal = pty.spawn(command.file, command.args, {
      cwd: process.cwd(), cols: process.stdout.columns || 100, rows: process.stdout.rows || 30,
      env: process.env, encoding: 'utf8', name: 'xterm-256color', useConpty: true,
    });
  } catch (error) {
    await report('terminal', { status: 'BLOCKED', reason: error.code || 'PTY_SPAWN_FAILED' });
    process.exitCode = 2;
  }
  if (terminal) {
    console.log('실험 외부 프로세스 PID: ' + terminal.pid);
    const previousRaw = Boolean(process.stdin.isRaw);
    let done = false;
    let stopReason = 'cli-exit';
    let ctrlC = 0;
    let resizes = 0;
    let stopTimer;
    let timeLimit;
    let dataListener;
    let exitListener;
    const restore = () => {
      process.stdin.off('data', input);
      process.stdout.off('resize', resize);
      process.off('SIGTERM', terminate);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      clearTimeout(stopTimer);
      clearTimeout(timeLimit);
      dataListener?.dispose();
      exitListener?.dispose();
    };
    const finish = async (event) => {
      if (done) return;
      done = true;
      restore();
      process.stdout.write('\r\n');
      await new Promise((resolve) => setTimeout(resolve, 250));
      await report('terminal', {
        status: 'MANUAL_REVIEW_REQUIRED', stopReason,
        outerPid: terminal.pid, outerProcess: pidState(terminal.pid),
        exitCode: event?.exitCode ?? null, resizeCalls: resizes, ctrlCForwarded: ctrlC,
        actualResponse: 'UNCONFIRMED', model: 'UNCONFIRMED', reasoning: 'UNCONFIRMED',
        descendantCleanup: 'UNCONFIRMED', rawTranscriptSaved: false,
      });
      process.exitCode = terminalExitCode(event, stopReason);
    };
    const stop = (reason) => {
      if (done || stopTimer) return;
      stopReason = reason;
      try { terminal.kill(); } catch { /* timeout below still records the missing exit event */ }
      stopTimer = setTimeout(() => { void finish(null); }, 3500);
    };
    function input(chunk) {
      const value = chunk.toString('utf8');
      if (value.includes('\u0011')) { stop('ctrl-q'); return; }
      ctrlC += (value.match(/\u0003/gu) || []).length;
      try { terminal.write(value); } catch { stop('input-error'); }
    }
    function resize() {
      try {
        terminal.resize(Math.max(20, process.stdout.columns || 100), Math.max(5, process.stdout.rows || 30));
        resizes += 1;
      } catch { stop('resize-error'); }
    }
    function terminate() { stop('parent-sigterm'); }
    dataListener = terminal.onData((data) => process.stdout.write(data));
    exitListener = terminal.onExit((event) => { void finish(event); });
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.on('data', input).resume();
    process.stdout.on('resize', resize);
    process.on('SIGTERM', terminate);
    timeLimit = setTimeout(() => stop('ten-minute-limit'), 10 * 60 * 1000);
  }
}
