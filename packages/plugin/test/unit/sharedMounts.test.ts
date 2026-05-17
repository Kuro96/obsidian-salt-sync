import { describe, expect, it } from 'vitest';
import { isSharedMountEnabled, normalizeSharedMountsForRuntime } from '../../src/sync/sharedMounts';

describe('shared mount enabled semantics', () => {
  it('treats only explicit false as disabled', () => {
    expect(isSharedMountEnabled({})).toBe(true);
    expect(isSharedMountEnabled({ enabled: true })).toBe(true);
    expect(isSharedMountEnabled({ enabled: false })).toBe(false);
  });

  it('normalizes missing enabled to true when there is no legacy shared mount switch', () => {
    const [mount] = normalizeSharedMountsForRuntime([
      { localPath: 'Shared', vaultId: 'shared-vault', token: 'token' },
    ]);

    expect(mount.enabled).toBe(true);
  });

  it('uses explicit legacy shared mount switch only for mounts missing enabled', () => {
    const mounts = normalizeSharedMountsForRuntime([
      { localPath: 'Old', vaultId: 'old-vault', token: 'token' },
      { enabled: true, localPath: 'Explicit', vaultId: 'explicit-vault', token: 'token' },
    ], false);

    expect(mounts[0].enabled).toBe(false);
    expect(mounts[1].enabled).toBe(true);
  });
});
