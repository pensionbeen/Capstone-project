import path from 'node:path';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Only the generated fixture is scanned; links are rejected rather than followed.
export async function snapshot(folder) {
  const rows = [];
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      const file = path.join(directory, entry.name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error('FIXTURE_LINK_UNEXPECTED');
      if (rows.length >= 128 || stat.size > 1024 * 1024) throw new Error('FIXTURE_LIMIT_EXCEEDED');
      if (stat.isDirectory()) {
        rows.push([relative + '/', 'directory']);
        await walk(file, relative + '/');
      } else if (stat.isFile()) {
        rows.push([relative, createHash('sha256').update(await readFile(file)).digest('hex')]);
      } else throw new Error('FIXTURE_TYPE_UNEXPECTED');
    }
  }
  await walk(folder);
  return JSON.stringify(rows.sort(([a], [b]) => a.localeCompare(b)));
}
