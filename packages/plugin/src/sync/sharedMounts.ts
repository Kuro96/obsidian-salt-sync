import type { SharedDirectoryMount } from '@salt-sync/shared';

export function isSharedMountEnabled(mount: Pick<SharedDirectoryMount, 'enabled'>): boolean {
  return mount.enabled !== false;
}

export function normalizeSharedMountsForRuntime(
  mounts: SharedDirectoryMount[],
  legacySharedMountEnabled?: boolean,
): SharedDirectoryMount[] {
  return mounts.map((mount) => ({
    ...mount,
    enabled: mount.enabled ?? legacySharedMountEnabled ?? true,
  }));
}
