import { openDB, type IDBPDatabase } from 'idb';
import type { LocalCache, LocalCacheState, VaultId } from '@salt-sync/shared';

const DB_NAME = 'salt-sync';
const DB_VERSION = 3;
const STORE_NAME = 'local-cache';
const BLOB_RUNTIME_STORE_NAME = 'blob-runtime-state';
const DEVICE_META_STORE_NAME = 'device-meta';

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
