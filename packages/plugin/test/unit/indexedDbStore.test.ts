import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  IndexedDbBlobRuntimeStateStore,
  IndexedDbLocalCache,
  IndexedDbMarkdownPendingStore,
  loadDeviceId,
  loadPluginCacheVersionMarker,
  refreshLocalRuntimeStateForPluginCacheVersion,
  saveDeviceId,
  savePluginCacheVersionMarker,
} from '../../src/storage/indexedDbStore';

async function seedRuntimeState(localCacheKey: string, legacyVaultId: string): Promise<void> {
  const cache = new IndexedDbLocalCache();
  const markdown = new IndexedDbMarkdownPendingStore();
  const blob = new IndexedDbBlobRuntimeStateStore();

  for (const key of [localCacheKey, legacyVaultId]) {
    await cache.save(key, {
      vaultId: key,
      ydocUpdate: new Uint8Array([1, 2, 3]),
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    await markdown.save(key, {
      vaultId: key,
      pendingLocalDeletions: [`${key}.md`],
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    await blob.save(key, {
      vaultId: key,
      pendingRemoteDownloads: [{ docPath: `${key}.png`, hash: 'hash-1' }],
      pendingRemoteDeletes: [`${key}-remote.png`],
      pendingLocalUpserts: [`${key}-upsert.png`],
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
  }
}

async function expectRuntimeStateCleared(localCacheKey: string, legacyVaultId: string): Promise<void> {
  const cache = new IndexedDbLocalCache();
  const markdown = new IndexedDbMarkdownPendingStore();
  const blob = new IndexedDbBlobRuntimeStateStore();

  for (const key of [localCacheKey, legacyVaultId]) {
    await expect(cache.load(key)).resolves.toBeNull();
    await expect(markdown.load(key)).resolves.toBeNull();
    await expect(blob.load(key)).resolves.toBeNull();
  }
}

describe('IndexedDB plugin cache version marker', () => {
  it('missing marker triggers per-vault runtime state clear without deleting device id', async () => {
    const localCacheKey = 'ws://server::missing-marker';
    const legacyVaultId = 'missing-marker';
    await seedRuntimeState(localCacheKey, legacyVaultId);
    await saveDeviceId('device-missing-marker');

    await expect(refreshLocalRuntimeStateForPluginCacheVersion(localCacheKey, legacyVaultId)).resolves.toBe(true);

    await expectRuntimeStateCleared(localCacheKey, legacyVaultId);
    await expect(loadDeviceId()).resolves.toBe('device-missing-marker');
  });

  it('marker below 0.4.0 triggers per-vault runtime state clear', async () => {
    const localCacheKey = 'ws://server::old-marker';
    const legacyVaultId = 'old-marker';
    await seedRuntimeState(localCacheKey, legacyVaultId);
    await savePluginCacheVersionMarker(localCacheKey, '0.3.2');

    await expect(refreshLocalRuntimeStateForPluginCacheVersion(localCacheKey, legacyVaultId)).resolves.toBe(true);

    await expectRuntimeStateCleared(localCacheKey, legacyVaultId);
  });

  it('marker at or above 0.4.0 preserves runtime state', async () => {
    const localCacheKey = 'ws://server::new-marker';
    const legacyVaultId = 'new-marker';
    const cache = new IndexedDbLocalCache();
    const markdown = new IndexedDbMarkdownPendingStore();
    const blob = new IndexedDbBlobRuntimeStateStore();
    await seedRuntimeState(localCacheKey, legacyVaultId);
    await savePluginCacheVersionMarker(localCacheKey, '0.4.0');

    await expect(refreshLocalRuntimeStateForPluginCacheVersion(localCacheKey, legacyVaultId)).resolves.toBe(false);

    await expect(cache.load(localCacheKey)).resolves.not.toBeNull();
    await expect(cache.load(legacyVaultId)).resolves.not.toBeNull();
    await expect(markdown.load(localCacheKey)).resolves.not.toBeNull();
    await expect(markdown.load(legacyVaultId)).resolves.not.toBeNull();
    await expect(blob.load(localCacheKey)).resolves.not.toBeNull();
    await expect(blob.load(legacyVaultId)).resolves.not.toBeNull();
  });

  it('saves and updates the cache version marker', async () => {
    const localCacheKey = 'ws://server::saved-marker';

    await savePluginCacheVersionMarker(localCacheKey, '0.4.0');
    await expect(loadPluginCacheVersionMarker(localCacheKey)).resolves.toMatchObject({
      localCacheKey,
      pluginVersion: '0.4.0',
    });

    await savePluginCacheVersionMarker(localCacheKey, '0.4.1');
    await expect(loadPluginCacheVersionMarker(localCacheKey)).resolves.toMatchObject({
      localCacheKey,
      pluginVersion: '0.4.1',
    });
  });
});
