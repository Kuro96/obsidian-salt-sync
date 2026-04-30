import { isIgnoredPathSegment } from './ignoredPathRules.js';

export function normalizeVaultPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/+/g, '/');
}

export function isPathIgnoredBySync(vaultPath: string): boolean {
  const normalized = normalizeVaultPath(vaultPath);
  if (!normalized) return false;
  return normalized.split('/').some(isIgnoredPathSegment);
}

export function isSameOrChildPath(path: string, parent: string): boolean {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedParent = normalizeVaultPath(parent);
  if (!normalizedPath || !normalizedParent) return false;
  return normalizedPath === normalizedParent || normalizedPath.startsWith(normalizedParent + '/');
}
