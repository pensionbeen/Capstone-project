import { spawn } from 'node:child_process';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type FileEntry,
  type FileListResult,
  type OpenFileResult,
  validRelativePath,
} from '../shared/workspace-files.js';

const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

// A fixed text editor opens a file as data. Never use a file association or a shell.
export function launchTextEditor(file: string): Promise<void> {
  if (
    process.platform !== 'win32' ||
    !process.env.SystemRoot ||
    !isAbsolute(process.env.SystemRoot)
  )
    return Promise.reject(new Error('Windows 메모장을 사용할 수 없어요.'));
  return new Promise((accept, reject) => {
    const child = spawn(join(process.env.SystemRoot as string, 'System32', 'notepad.exe'), [file], {
      shell: false,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      accept();
    });
  });
}

export class ProjectFiles {
  private active = 0;
  constructor(private launch = launchTextEditor) {}

  private async checked(root: string, path: string, allowRoot = false) {
    if (!validRelativePath(path, allowRoot) || !isAbsolute(root)) throw new Error('invalid path');
    const canonicalRoot = await realpath(root);
    // A moved/replaced root must be selected again; do not follow a newly introduced link.
    if (
      resolve(root).toLowerCase() !== canonicalRoot.toLowerCase() ||
      (await lstat(root)).isSymbolicLink()
    )
      throw new Error('changed root');
    let target = canonicalRoot;
    for (const part of path ? path.split('/') : []) {
      target = join(target, part);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error('linked path');
      const canonical = await realpath(target);
      if (!inside(canonicalRoot, canonical) || relative(target, canonical) !== '')
        throw new Error('outside project');
    }
    return { target, info: await lstat(target) };
  }

  async list(root: string, path: string): Promise<FileListResult> {
    if (this.active >= 4) return { ok: false, message: '파일 조회가 끝난 뒤 다시 시도해 주세요.' };
    this.active++;
    try {
      const { target, info } = await this.checked(root, path, true);
      if (!info.isDirectory()) throw new Error('not directory');
      const entries: FileEntry[] = [];
      let truncated = false;
      const directory = await opendir(target);
      for await (const item of directory) {
        if (entries.length === 200) {
          truncated = true;
          break;
        }
        const relativePath = path ? `${path}/${item.name}` : item.name;
        entries.push({
          name: item.name,
          path: relativePath,
          kind:
            !validRelativePath(relativePath) || item.isSymbolicLink()
              ? 'unavailable'
              : item.isDirectory()
                ? 'directory'
                : item.isFile()
                  ? 'file'
                  : 'unavailable',
        });
      }
      entries.sort(
        (a, b) =>
          Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
          a.name.localeCompare(b.name, 'ko'),
      );
      return { ok: true, entries, truncated };
    } catch {
      return { ok: false, message: '폴더가 없거나 열 수 없어요. 링크 폴더는 탐색하지 않아요.' };
    } finally {
      this.active--;
    }
  }

  async open(root: string, path: string): Promise<OpenFileResult> {
    if (this.active >= 4) return { ok: false, message: '파일 작업이 끝난 뒤 다시 시도해 주세요.' };
    this.active++;
    try {
      const { target, info } = await this.checked(root, path);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('not a small file');
      // Recheck at the handoff. An external program still opens by path; this is not OS isolation.
      const checked = await this.checked(root, path);
      if (
        checked.target !== target ||
        !checked.info.isFile() ||
        checked.info.size > 2 * 1024 * 1024
      )
        throw new Error('changed file');
      await this.launch(target);
      return { ok: true };
    } catch {
      return {
        ok: false,
        message:
          '파일이 없거나 열 수 없어요. 프로젝트 안의 2 MiB 이하 파일만 메모장으로 열 수 있어요.',
      };
    } finally {
      this.active--;
    }
  }
}
