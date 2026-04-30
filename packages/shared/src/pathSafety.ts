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
  const segments = normalized.split('/');
  return segments.some((segment) => segment === '.obsidian' || segment === '.trash')
    || segments.some((segment) => segment === '.stfolder' || segment === '.stversions' || segment === '.stignore')
    || segments.some((segment) => segment.includes('.sync-conflict-'))
    || segments.some((segment) => /^~syncthing~.*\.tmp$/i.test(segment));
}

export function isSameOrChildPath(path: string, parent: string): boolean {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedParent = normalizeVaultPath(parent);
  if (!normalizedPath || !normalizedParent) return false;
  return normalizedPath === normalizedParent || normalizedPath.startsWith(normalizedParent + '/');
}
