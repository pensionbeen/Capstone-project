import { createRequire } from 'node:module';
import path from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { codexPath } from './lib.mjs';

// Mirrors the inspected, installed 0.160.0 npm launcher. This comparison skips
// its Node signal-forwarding wrapper; installation and authentication stay intact.
export async function installedCodexNative() {
  const packageRoot = path.join(path.dirname(codexPath()), 'node_modules', '@openai', 'codex');
  const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.name !== '@openai/codex' || metadata.version !== '0.160.0') throw new Error('CODEX_NATIVE_PACKAGE_MISMATCH');
  const require = createRequire(path.join(packageRoot, 'bin', 'codex.js'));
  let vendorRoot;
  try { vendorRoot = path.join(path.dirname(require.resolve('@openai/codex-win32-x64/package.json')), 'vendor'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    vendorRoot = path.join(packageRoot, 'vendor');
  }
  const file = path.join(vendorRoot, 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  await access(file);
  return file;
}
