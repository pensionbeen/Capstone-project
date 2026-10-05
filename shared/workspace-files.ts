export function validRelativePath(value: unknown, allowRoot = false): value is string {
  if (typeof value !== 'string' || value.length > 1000) return false;
  if (!value) return allowRoot;
  if (/[\\:*?<>"|]/u.test(value) || [...value].some((c) => c.charCodeAt(0) < 32)) return false;
  return value
    .split('/')
    .every(
      (part) =>
        Boolean(part) &&
        part !== '.' &&
        part !== '..' &&
        !/[. ]$/u.test(part) &&
        !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
    );
}

export interface FileEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'unavailable';
}
export type FileListResult =
  | { ok: true; entries: FileEntry[]; truncated: boolean }
  | { ok: false; message: string };
export type OpenFileResult = { ok: true } | { ok: false; message: string };
