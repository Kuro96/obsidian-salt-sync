import type { SharedDirectoryMount } from '@salt-sync/shared';

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
    || segments.some((segment) => segment.includes('.sync-conflict-'));
}

export function isSameOrChildPath(path: string, parent: string): boolean {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedParent = normalizeVaultPath(parent);
  if (!normalizedPath || !normalizedParent) return false;
  return normalizedPath === normalizedParent || normalizedPath.startsWith(normalizedParent + '/');
}

export function validateSharedMountOverlaps(
  mounts: SharedDirectoryMount[],
): { ok: true } | { ok: false; message: string } {
  const enabled = mounts
    .map((mount, index) => ({ mount, index, localPath: normalizeVaultPath(mount.localPath) }))
    .filter(({ mount }) => mount.enabled !== false);

  for (const item of enabled) {
    if (!item.localPath) {
      return { ok: false, message: '共享目录挂载路径不能为空' };
    }
    if (isPathIgnoredBySync(item.localPath)) {
      return { ok: false, message: `共享目录挂载路径不能位于忽略目录: ${item.mount.localPath}` };
    }
  }

  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      const a = enabled[i];
      const b = enabled[j];
      if (a.localPath === b.localPath || isSameOrChildPath(a.localPath, b.localPath) || isSameOrChildPath(b.localPath, a.localPath)) {
        return {
          ok: false,
          message: `共享目录挂载路径不能重叠: ${a.mount.localPath} 与 ${b.mount.localPath}`,
        };
      }
    }
  }

  return { ok: true };
}
