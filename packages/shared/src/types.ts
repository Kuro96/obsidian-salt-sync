// ─── 基础标量类型 ────────────────────────────────────────────────────────────

export type VaultId = string;
export type FileId = string;
export type BlobHash = string; // 通常是内容的 SHA-256 十六进制字符串

// ─── Blob 相关 ───────────────────────────────────────────────────────────────

/** 共享模型中某个路径当前引用的 blob 元数据 */
export interface BlobRef {
  hash: BlobHash;
  size: number;
  contentType?: string;
  updatedAt: string;
}

/** 已删除附件的 tombstone，用于跨设备同步删除操作 */
export interface BlobTombstone {
  hash: BlobHash;
  deletedAt: string;
  /** 删除来源设备 ID（可选，旧格式兼容） */
  deviceId?: string;
  /** 删除来源设备名称（可选） */
  deviceName?: string;
  /** 删除来源 vaultId（可选，用于共享目录挂载场景） */
  vaultId?: string;
  /** 删除原因：local-delete | reconcile-missing | snapshot-restore 等 */
  deleteSource?: string;
}

/** 已删除 markdown 文件的 tombstone */
export interface FileTombstone {
  deletedAt: string;
  /** 删除来源设备 ID（可选，旧格式兼容） */
  deviceId?: string;
  /** 删除来源设备名称（可选） */
  deviceName?: string;
  /** 删除来源 vaultId（可选，用于共享目录挂载场景） */
  vaultId?: string;
  /** 删除原因：local-delete | reconcile-missing | snapshot-restore 等 */
  deleteSource?: string;
}

// ─── Snapshot 元数据 ─────────────────────────────────────────────────────────

export interface SnapshotMeta {
  snapshotId: string;
  vaultId: VaultId;
  createdAt: string;
  schemaVersion?: number;
  markdownFileCount: number;
  blobFileCount: number;
  referencedBlobHashes?: BlobHash[];
}

// ─── 持久化相关 ──────────────────────────────────────────────────────────────

/** DocumentStore journal 中的一条增量记录 */
export interface PersistedDelta {
  seq: number;
  payload: Uint8Array;
  sha256: string;
  createdAt: string;
}

/** DocumentStore 的全量 checkpoint */
export interface PersistedCheckpoint {
  version: number;
  payload: Uint8Array;
  stateVector: Uint8Array;
  sha256: string;
  createdAt: string;
}

// ─── 文件系统桥接 ────────────────────────────────────────────────────────────

/** 用于自写回声抑制的内容指纹 */
export interface FileFingerprint {
  sha256: string;
  byteLength: number;
  /** TTL 过期时间戳（ms）；窗口期内相同内容的重复事件均被抑制 */
  expiresAt?: number;
}

// ─── 传输层辅助类型 ──────────────────────────────────────────────────────────

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'failed';

export interface ConnectInput {
  /** 服务端 WebSocket 地址，如 ws://localhost:3000 */
  serverUrl: string;
  vaultId: VaultId;
  token: string;
  schemaVersion: number;
  /** 设备的稳定唯一标识（UUID），用于 awareness、冲突溯源、离线状态管理 */
  deviceId: string;
  /** 可读显示名，仅供 UI 展示 */
  deviceName?: string;
}

// ─── 共享目录 / 多 vault 配置 ─────────────────────────────────────────────────

export interface SharedDirectoryMount {
  /** 是否启用该共享目录挂载同步 */
  enabled?: boolean;
  /** 相对 vault 根的本地挂载路径，e.g. "Shared" */
  localPath: string;
  /** 该共享目录在服务端对应的逻辑 room ID */
  vaultId: VaultId;
  /** 访问该共享目录 room 的鉴权凭据（独立于主 vault token） */
  token: string;
  /** 可选：若共享目录托管在不同服务器 */
  serverUrl?: string;
  /** 可选：只读挂载（本地修改不上传） */
  readOnly?: boolean;
}

/** 插件完整同步配置 */
export interface SyncConfig {
  primaryVaultId: VaultId;
  primaryToken: string;
  serverUrl: string;
  deviceId: string;
  sharedMounts?: SharedDirectoryMount[];
}

// ─── Room 元数据 ─────────────────────────────────────────────────────────────

export interface RoomMeta {
  vaultId: VaultId;
  schemaVersion?: number;
  connectedClientCount: number;
  loaded: boolean;
  updatedAt?: string;
}

// ─── DocumentStore 输入输出类型 ──────────────────────────────────────────────

export interface DocumentStoreMeta {
  vaultId: VaultId;
  currentCheckpointVersion: number;
  nextSeq: number;
  journalEntryCount: number;
  journalTotalBytes: number;
  updatedAt: string;
}

export interface LoadedDocumentState {
  checkpoint: PersistedCheckpoint | null;
  deltas: PersistedDelta[];
  meta: DocumentStoreMeta | null;
}

export interface AppendDeltaInput {
  vaultId: VaultId;
  payload: Uint8Array;
  /** 若提供，实现层应校验当前 nextSeq 是否与此值匹配，防止乱序写入 */
  expectedNextSeq?: number;
}

export interface AppendDeltaResult {
  seq: number;
  entryCount: number;
  totalBytes: number;
}

export interface WriteCheckpointInput {
  vaultId: VaultId;
  checkpoint: PersistedCheckpoint;
  /** 若提供，删除 seq <= 此值的所有 journal 条目 */
  replaceUpToSeq?: number;
}

export interface CompactResult {
  compacted: boolean;
  checkpointVersion?: number;
}

// ─── BlobStore 输入输出类型 ──────────────────────────────────────────────────

export interface PutBlobInput {
  vaultId: VaultId;
  hash: BlobHash;
  bytes: Uint8Array;
  contentType?: string;
}

export interface GetBlobInput {
  vaultId: VaultId;
  hash: BlobHash;
}

export interface StoredBlob {
  hash: BlobHash;
  bytes: Uint8Array;
  contentType?: string;
  size: number;
}

// ─── SnapshotStore 输入输出类型 ──────────────────────────────────────────────

export interface PutSnapshotInput {
  vaultId: VaultId;
  snapshotId: string;
  payload: Uint8Array;
  meta: SnapshotMeta;
}

export interface StoredSnapshot {
  meta: SnapshotMeta;
  payload: Uint8Array;
}

// ─── LocalCache ──────────────────────────────────────────────────────────────

export interface LocalCacheState {
  vaultId: VaultId;
  ydocUpdate: Uint8Array;
  updatedAt: string;
}
