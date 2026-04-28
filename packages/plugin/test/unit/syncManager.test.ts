import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncManager } from '../../src/sync/syncManager';
import type { SaltSyncSettings } from '../../src/settings';
import type { Plugin } from 'obsidian';

// ── helpers ───────────────────────────────────────────────────────────────────

function baseSettings(overrides: Partial<SaltSyncSettings> = {}): SaltSyncSettings {
  return {
    serverUrl: 'ws://localhost:8080',
    vaultId: 'primary-vault',
    token: 'primary-token',
    deviceId: 'dev1',
    deviceName: 'test',
    vaultSyncEnabled: true,
    sharedMounts: [],
    ...overrides,
  };
}

function fakePlugin(): Plugin {
  return {} as unknown as Plugin;
}

// VaultSyncEngine ctor touches nothing — safe to instantiate without start()
// We spy on engine methods to avoid real HTTP calls.

// ── tests ─────────────────────────────────────────────────────────────────────

describe('SyncManager.getAvailableScopes', () => {
  it('returns primary scope when only primary is enabled', () => {
    const mgr = new SyncManager(fakePlugin(), baseSettings());
    const scopes = mgr.getAvailableScopes();
    expect(scopes).toHaveLength(1);
    expect(scopes[0].label).toBe('主库');
  });

  it('returns mount scopes when only mounts are enabled', () => {
    const settings = baseSettings({
      vaultSyncEnabled: false,
      sharedMounts: [
        { enabled: true, localPath: 'Shared', vaultId: 'shared-vault', token: 'shared-token' },
        { enabled: true, localPath: 'Work', vaultId: 'work-vault', token: 'work-token' },
      ],
    });
    const mgr = new SyncManager(fakePlugin(), settings);
    const scopes = mgr.getAvailableScopes();
    expect(scopes).toHaveLength(2);
    expect(scopes[0].label).toBe('Shared');
    expect(scopes[1].label).toBe('Work');
  });

  it('primary comes first when both primary and mounts are enabled', () => {
    const settings = baseSettings({
      vaultSyncEnabled: true,
      sharedMounts: [
        { enabled: true, localPath: 'Shared', vaultId: 'shared-vault', token: 'shared-token' },
      ],
    });
    const mgr = new SyncManager(fakePlugin(), settings);
    const scopes = mgr.getAvailableScopes();
    expect(scopes).toHaveLength(2);
    expect(scopes[0].label).toBe('主库');
    expect(scopes[1].label).toBe('Shared');
  });

  it('returns empty when no sync is enabled', () => {
    const settings = baseSettings({ vaultSyncEnabled: false, sharedMounts: [] });
    const mgr = new SyncManager(fakePlugin(), settings);
    expect(mgr.getAvailableScopes()).toHaveLength(0);
  });

  it('ignores disabled mounts', () => {
    const settings = baseSettings({
      vaultSyncEnabled: false,
      sharedMounts: [
        { enabled: false, localPath: 'Disabled', vaultId: 'x', token: 'x' },
        { enabled: true, localPath: 'Active', vaultId: 'active-vault', token: 'active-token' },
      ],
    });
    const mgr = new SyncManager(fakePlugin(), settings);
    const scopes = mgr.getAvailableScopes();
    expect(scopes).toHaveLength(1);
    expect(scopes[0].label).toBe('Active');
  });
});

describe('SyncManager mount validation', () => {
  it('rejects enabled duplicate mount paths', () => {
    const settings = baseSettings({
      vaultSyncEnabled: false,
      sharedMounts: [
        { enabled: true, localPath: 'Shared', vaultId: 'a', token: 'ta' },
        { enabled: true, localPath: 'Shared/', vaultId: 'b', token: 'tb' },
      ],
    });

    expect(() => new SyncManager(fakePlugin(), settings)).toThrow(/不能重叠/);
  });

  it('rejects enabled parent-child mount overlaps', () => {
    const settings = baseSettings({
      vaultSyncEnabled: false,
      sharedMounts: [
        { enabled: true, localPath: 'Shared', vaultId: 'a', token: 'ta' },
        { enabled: true, localPath: 'Shared/Sub', vaultId: 'b', token: 'tb' },
      ],
    });

    expect(() => new SyncManager(fakePlugin(), settings)).toThrow(/不能重叠/);
  });

  it('allows overlaps when one mount is disabled', () => {
    const settings = baseSettings({
      vaultSyncEnabled: false,
      sharedMounts: [
        { enabled: true, localPath: 'Shared', vaultId: 'a', token: 'ta' },
        { enabled: false, localPath: 'Shared/Sub', vaultId: 'b', token: 'tb' },
      ],
    });

    expect(() => new SyncManager(fakePlugin(), settings)).not.toThrow();
  });
});

describe('SyncManager.getScopeForPath', () => {
  it('returns primary scope for paths not under any mount', () => {
    const settings = baseSettings({
      sharedMounts: [
        { enabled: true, localPath: 'Shared', vaultId: 'shared-vault', token: 'shared-token' },
      ],
    });
    const mgr = new SyncManager(fakePlugin(), settings);
    const scope = mgr.getScopeForPath('notes/foo.md');
    expect(scope?.label).toBe('主库');
  });

  it('returns mount scope for paths under the mount prefix', () => {
    const settings = baseSettings({
      vaultSyncEnabled: true,
      sharedMounts: [
        { enabled: true, localPath: 'Shared', vaultId: 'shared-vault', token: 'shared-token' },
      ],
    });
    const mgr = new SyncManager(fakePlugin(), settings);
    const scope = mgr.getScopeForPath('Shared/notes/bar.md');
    expect(scope?.label).toBe('Shared');
  });

  it('matches exact mount path (no trailing slash)', () => {
    const settings = baseSettings({
      vaultSyncEnabled: false,
      sharedMounts: [
        { enabled: true, localPath: 'Shared', vaultId: 'shared-vault', token: 'shared-token' },
      ],
    });
    const mgr = new SyncManager(fakePlugin(), settings);
    const scope = mgr.getScopeForPath('Shared');
    expect(scope?.label).toBe('Shared');
  });

  it('does NOT match path that starts with mount name but lacks separator', () => {
    // 'SharedExtra/foo.md' should NOT match mount 'Shared'
    const settings = baseSettings({
      vaultSyncEnabled: true,
      sharedMounts: [
        { enabled: true, localPath: 'Shared', vaultId: 'shared-vault', token: 'shared-token' },
      ],
    });
    const mgr = new SyncManager(fakePlugin(), settings);
    const scope = mgr.getScopeForPath('SharedExtra/foo.md');
    expect(scope?.label).toBe('主库');
  });

  it('returns null when no sync is enabled', () => {
    const settings = baseSettings({ vaultSyncEnabled: false, sharedMounts: [] });
    const mgr = new SyncManager(fakePlugin(), settings);
    expect(mgr.getScopeForPath('notes/foo.md')).toBeNull();
  });

  it('selects first matching mount when multiple mounts share a prefix', () => {
    const settings = baseSettings({
      vaultSyncEnabled: false,
      sharedMounts: [
        { enabled: true, localPath: 'Work/A', vaultId: 'a', token: 'ta' },
        { enabled: true, localPath: 'Work/B', vaultId: 'b', token: 'tb' },
      ],
    });
    const mgr = new SyncManager(fakePlugin(), settings);
    expect(mgr.getScopeForPath('Work/A/doc.md')?.label).toBe('Work/A');
    expect(mgr.getScopeForPath('Work/B/doc.md')?.label).toBe('Work/B');
  });
});

describe('SyncManager.hasAnySync', () => {
  it('true when primary is enabled', () => {
    expect(new SyncManager(fakePlugin(), baseSettings()).hasAnySync).toBe(true);
  });

  it('true when only mount is enabled', () => {
    const settings = baseSettings({
      vaultSyncEnabled: false,
      sharedMounts: [{ enabled: true, localPath: 'S', vaultId: 'sv', token: 't' }],
    });
    expect(new SyncManager(fakePlugin(), settings).hasAnySync).toBe(true);
  });

  it('false when nothing is enabled', () => {
    const settings = baseSettings({ vaultSyncEnabled: false, sharedMounts: [] });
    expect(new SyncManager(fakePlugin(), settings).hasAnySync).toBe(false);
  });
});

describe('SyncScope.downloadSnapshotFile — docPath conversion', () => {
  it('primary scope passes vaultPath as-is', async () => {
    const mgr = new SyncManager(fakePlugin(), baseSettings());
    const scope = mgr.getScopeForPath('notes/foo.md')!;

    // Spy on the underlying engine method
    const engines = (mgr as unknown as { primaryEngine: { downloadSnapshotFile: (...a: unknown[]) => unknown } }).primaryEngine;
    const spy = vi.spyOn(engines, 'downloadSnapshotFile').mockResolvedValue({ text: 'hello', contentType: 'text/markdown' });

    await scope.downloadSnapshotFile('snap-1', 'notes/foo.md');
    expect(spy).toHaveBeenCalledWith('snap-1', 'notes/foo.md');
  });

  it('mount scope strips the mount prefix from vaultPath', async () => {
    const settings = baseSettings({
      vaultSyncEnabled: false,
      sharedMounts: [
        { enabled: true, localPath: 'Shared', vaultId: 'shared-vault', token: 'shared-token' },
      ],
    });
    const mgr = new SyncManager(fakePlugin(), settings);
    const scope = mgr.getScopeForPath('Shared/notes/bar.md')!;

    const engines = (mgr as unknown as { mountEngines: Array<{ engine: { downloadSnapshotFile: (...a: unknown[]) => unknown } }> }).mountEngines;
    const spy = vi.spyOn(engines[0].engine, 'downloadSnapshotFile').mockResolvedValue({ text: 'world', contentType: 'text/markdown' });

    await scope.downloadSnapshotFile('snap-2', 'Shared/notes/bar.md');
    // docPath should have 'Shared/' stripped
    expect(spy).toHaveBeenCalledWith('snap-2', 'notes/bar.md');
  });
});
