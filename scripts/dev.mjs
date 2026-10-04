import { spawn } from 'node:child_process';
import electron from 'electron';
import { createServer } from 'vite';

const server = await createServer();
await server.listen();
server.printUrls();
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', '--dev'], { stdio: 'inherit', env: environment });
let closing;
async function close(code = 0) {
  if (closing) return closing;
  closing = (async () => {
    await server.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('close', resolve));
    }
    process.exitCode = code;
  })();
  return closing;
}
child.once('error', (error) => {
  console.error(error.message);
  void close(1);
});
child.once('exit', (code) => {
  void close(code ?? 1);
});
process.once('SIGINT', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
