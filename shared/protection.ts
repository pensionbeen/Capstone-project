export interface ProtectionDraft {
  paths: string[];
  read: boolean;
  write: boolean;
  remove: boolean;
}

export const emptyProtection: ProtectionDraft = {
  paths: [],
  read: true,
  write: true,
  remove: true,
};
export const protectionUnavailable = '보호 요청을 확인할 수 없어 ORBIT의 Codex 실행을 보류했어요.';

export function validProtectionPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 200 &&
    !/[:*?<>"|]/.test(trimmed) &&
    ![...trimmed].some((character) => character.charCodeAt(0) < 32) &&
    !/^[\\/]/.test(trimmed) &&
    !trimmed.split(/[\\/]/).some((part) => part === '..' || part === '.')
  );
}

export function validProtection(value: unknown): value is ProtectionDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<ProtectionDraft>;
  return (
    Object.keys(d).length === 4 &&
    typeof d.read === 'boolean' &&
    typeof d.write === 'boolean' &&
    typeof d.remove === 'boolean' &&
    Array.isArray(d.paths) &&
    d.paths.length <= 30 &&
    (d.paths.length === 0 || d.read || d.write || d.remove) &&
    d.paths.every((p) => typeof p === 'string' && p === p.trim() && validProtectionPath(p)) &&
    new Set(d.paths).size === d.paths.length
  );
}
