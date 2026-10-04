import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { basename, isAbsolute, parse } from 'node:path';
import type { FolderResult } from '../shared/desktop.js';

export const APP_URL = 'orbit://app/index.html';
export const DEV_URL = 'http://127.0.0.1:5173/';

export function isTrustedPage(rawUrl: string, expected: string): boolean {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    return url.href === expected;
  } catch {
    return false;
  }
}

export function staticAssetPath(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'orbit:' || url.host !== 'app' || url.username || url.password) return;
    if (url.pathname === '/' || url.pathname === '/index.html') return 'index.html';
    if (/^\/assets\/[\w.-]+\.(?:js|css|svg|woff2)$/.test(url.pathname)) {
      return url.pathname.slice(1);
    }
  } catch {
    return;
  }
}

export async function inspectDirectory(value: unknown): Promise<FolderResult> {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    return {
      status: 'error',
      message: '선택한 폴더의 위치를 확인할 수 없어요. 다시 선택해 주세요.',
    };
  }
  try {
    if (!(await stat(value)).isDirectory()) {
      return { status: 'error', message: '파일 대신 프로젝트 폴더를 선택해 주세요.' };
    }
    await access(value, constants.R_OK);
    return { status: 'selected', name: basename(value) || parse(value).root, path: value };
  } catch {
    return { status: 'error', message: '폴더가 없거나 열 수 없어요. 다른 폴더를 선택해 주세요.' };
  }
}
