import { openDB, type IDBPDatabase } from 'idb';
import type { LocalCache, LocalCacheState, VaultId } from '@salt-sync/shared';

const DB_NAME = 'salt-sync';
const DB_VERSION = 4;
const STORE_NAME = 'local-cache';
const BLOB_RUNTIME_STORE_NAME = 'blob-runtime-state';
const DEVICE_META_STORE_NAME = 'device-meta';
const MARKDOWN_PENDING_STORE_NAME = 'markdown-pending-state';
const CACHE_VERSION_META_PREFIX = 'localCacheVersion::';
export const CURRENT_PLUGIN_CACHE_VERSION = '0.4.0';
export const MIN_SAFE_PLUGIN_CACHE_VERSION = '0.4.0';

export interface PluginCacheVersionMarker {
  localCacheKey: VaultId;
  pluginVersion: string;
  updatedAt: string;
}

export interface MarkdownPendingState {
  vaultId: VaultId;
  pendingLocalDeletions: string[];
  localPath?: string;
  updatedAt: string;
}

export interface BlobRuntimeState {
  vaultId: VaultId;
  pendingRemoteDownloads: Array<{ docPath: string; hash: string }>;
  pendingRemoteDeletes: string[];
  pendingLocalUpserts: string[];
  /** 启动窗口期或 pathToBlob 尚未同步时观测到的本地删除。hash 为 null 表示当时未知。 */
  pendingLocalDeletions?: Array<{ docPath: string; hash: string | null }>;
  /**
   * 已确认在本设备本地存在过的 blob 路径集合（跨会话持久化）。
   * 用于在 hashCache 被清空后（如重启）仍能识别出本地删除，
   * 避免把"本地已删除但 hashCache 空"的文件错误地重新下载。
   */
  knownLocalPaths?: string[];
  /**
   * 保存时的共享目录本地挂载路径（仅 mount 引擎写入；主 vault 不写，值为 undefined）。
   * 恢复时若与当前 localPath 不符，knownLocalPaths 视为失效并跳过，
   * 防止切换挂载路径后把新路径下的空目录误判为"用户删除了所有附件"。
   */
  localPath?: string;
  updatedAt: string;
}

async function getDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'vaultId' });
      }
      if (!db.objectStoreNames.contains(BLOB_RUNTIME_STORE_NAME)) {
        db.createObjectStore(BLOB_RUNTIME_STORE_NAME, { keyPath: 'vaultId' });
      }
      if (!db.objectStoreNames.contains(DEVICE_META_STORE_NAME)) {
        db.createObjectStore(DEVICE_META_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(MARKDOWN_PENDING_STORE_NAME)) {
        db.createObjectStore(MARKDOWN_PENDING_STORE_NAME, { keyPath: 'vaultId' });
      }
    },
  });
}

// ── Device ID (device-local, never synced via data.json) ──────────────────────

export async function loadDeviceId(): Promise<string | null> {
  const db = await getDb();
  return (await db.get(DEVICE_META_STORE_NAME, 'deviceId') as string | undefined) ?? null;
}

export async function saveDeviceId(id: string): Promise<void> {
  const db = await getDb();
  await db.put(DEVICE_META_STORE_NAME, id, 'deviceId');
}

function cacheVersionMetaKey(localCacheKey: VaultId): string {
  return `${CACHE_VERSION_META_PREFIX}${localCacheKey}`;
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(version: string, minimum: string): boolean {
  const parsedVersion = parseSemver(version);
  const parsedMinimum = parseSemver(minimum);
  if (!parsedVersion || !parsedMinimum) return false;
  for (let i = 0; i < parsedVersion.length; i++) {
    if (parsedVersion[i] > parsedMinimum[i]) return true;
    if (parsedVersion[i] < parsedMinimum[i]) return false;
  }
  return true;
}

function isPluginCacheVersionMarker(value: unknown, localCacheKey: VaultId): value is PluginCacheVersionMarker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Partial<PluginCacheVersionMarker>;
  return marker.localCacheKey === localCacheKey && typeof marker.pluginVersion === 'string' && typeof marker.updatedAt === 'string';
}

export async function loadPluginCacheVersionMarker(localCacheKey: VaultId): Promise<PluginCacheVersionMarker | null> {
  const db = await getDb();
  const raw = await db.get(DEVICE_META_STORE_NAME, cacheVersionMetaKey(localCacheKey)) as unknown;
  return isPluginCacheVersionMarker(raw, localCacheKey) ? raw : null;
}

export async function savePluginCacheVersionMarker(
  localCacheKey: VaultId,
  pluginVersion = CURRENT_PLUGIN_CACHE_VERSION,
): Promise<void> {
  const db = await getDb();
  await db.put(DEVICE_META_STORE_NAME, {
    localCacheKey,
    pluginVersion,
    updatedAt: new Date().toISOString(),
  } satisfies PluginCacheVersionMarker, cacheVersionMetaKey(localCacheKey));
}

export function shouldForceRefreshForPluginCacheVersion(marker: PluginCacheVersionMarker | null): boolean {
  return !marker || !isVersionAtLeast(marker.pluginVersion, MIN_SAFE_PLUGIN_CACHE_VERSION);
}

export async function clearPerVaultRuntimeState(localCacheKey: VaultId, legacyVaultId: VaultId): Promise<void> {
  const db = await getDb();
  const keys = new Set<VaultId>([localCacheKey, legacyVaultId]);
  for (const key of keys) {
    await db.delete(STORE_NAME, key);
    await db.delete(MARKDOWN_PENDING_STORE_NAME, key);
    await db.delete(BLOB_RUNTIME_STORE_NAME, key);
  }
}

export async function refreshLocalRuntimeStateForPluginCacheVersion(
  localCacheKey: VaultId,
  legacyVaultId: VaultId,
): Promise<boolean> {
  const marker = await loadPluginCacheVersionMarker(localCacheKey);
  if (!shouldForceRefreshForPluginCacheVersion(marker)) return false;
  await clearPerVaultRuntimeState(localCacheKey, legacyVaultId);
  return true;
}

export class IndexedDbLocalCache implements LocalCache {
  async load(vaultId: VaultId): Promise<LocalCacheState | null> {
    const db = await getDb();
    const raw = await db.get(STORE_NAME, vaultId) as
      | { vaultId: string; ydocUpdate: ArrayBuffer; updatedAt: string }
      | undefined;

    if (!raw) return null;
    return {
      vaultId: raw.vaultId,
      ydocUpdate: new Uint8Array(raw.ydocUpdate),
      updatedAt: raw.updatedAt,
    };
  }

  async save(vaultId: VaultId, state: LocalCacheState): Promise<void> {
    const db = await getDb();
    // .slice().buffer 确保写入的是紧凑 ArrayBuffer，
    // 避免 Yjs 返回的 Uint8Array 若是切片时把上游大 buffer 一并写入。
    await db.put(STORE_NAME, {
      vaultId: state.vaultId,
      ydocUpdate: state.ydocUpdate.slice().buffer,
      updatedAt: state.updatedAt,
    });
  }

  async clear(vaultId: VaultId): Promise<void> {
    const db = await getDb();
    await db.delete(STORE_NAME, vaultId);
  }

  async clearLegacyVaultOnlyKey(currentKey: VaultId, legacyVaultId: VaultId): Promise<boolean> {
    if (currentKey === legacyVaultId) return false;
    const db = await getDb();
    const raw = await db.get(STORE_NAME, legacyVaultId) as
      | { vaultId: string; ydocUpdate: ArrayBuffer; updatedAt: string }
      | undefined;
    if (!raw) return false;
    await db.delete(STORE_NAME, legacyVaultId);
    return true;
  }
}

export class IndexedDbMarkdownPendingStore {
  async load(vaultId: VaultId): Promise<MarkdownPendingState | null> {
    const db = await getDb();
    const raw = await db.get(MARKDOWN_PENDING_STORE_NAME, vaultId) as MarkdownPendingState | undefined;
    return raw ?? null;
  }

  async save(vaultId: VaultId, state: MarkdownPendingState): Promise<void> {
    const db = await getDb();
    await db.put(MARKDOWN_PENDING_STORE_NAME, { ...state, vaultId });
  }

  async clear(vaultId: VaultId): Promise<void> {
    const db = await getDb();
    await db.delete(MARKDOWN_PENDING_STORE_NAME, vaultId);
  }
}

export class IndexedDbBlobRuntimeStateStore {
  async load(vaultId: VaultId): Promise<BlobRuntimeState | null> {
    const db = await getDb();
    const raw = await db.get(BLOB_RUNTIME_STORE_NAME, vaultId) as BlobRuntimeState | undefined;
    return raw ?? null;
  }

  async save(vaultId: VaultId, state: BlobRuntimeState): Promise<void> {
    const db = await getDb();
    await db.put(BLOB_RUNTIME_STORE_NAME, {
      ...state,
      vaultId,
    });
  }

  async clear(vaultId: VaultId): Promise<void> {
    const db = await getDb();
    await db.delete(BLOB_RUNTIME_STORE_NAME, vaultId);
  }
}
