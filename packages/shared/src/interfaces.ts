import type {
  VaultId,
  BlobHash,
  SnapshotMeta,
  ConnectionStatus,
  ConnectInput,
  RoomMeta,
  LoadedDocumentState,
  AppendDeltaInput,
  AppendDeltaResult,
  WriteCheckpointInput,
  DocumentStoreMeta,
  CompactResult,
  PutBlobInput,
  GetBlobInput,
  StoredBlob,
  PutSnapshotInput,
  StoredSnapshot,
  LocalCacheState,
  FileFingerprint,
} from './types.js';
import type { TransportMessage } from './protocol.js';

// ─── Transport ───────────────────────────────────────────────────────────────

/** 服务端侧：代表一个已建立的客户端连接 */
export interface TransportSession {
  id: string;
  vaultId: VaultId;
  send(message: TransportMessage): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
  onMessage(handler: (message: TransportMessage) => Promise<void> | void): void;
  onClose(handler: () => Promise<void> | void): void;
}

/** 客户端侧：管理与服务端的 WebSocket 连接 */
export interface TransportClient {
  connect(input: ConnectInput): Promise<void>;
  disconnect(): Promise<void>;
  send(message: TransportMessage): Promise<void>;
  onMessage(handler: (message: TransportMessage) => Promise<void> | void): void;
  onStatusChange(handler: (status: ConnectionStatus) => void): void;
}

// ─── Room ────────────────────────────────────────────────────────────────────

/** 单个 vault 的内存会合点，负责广播和持久化协调 */
export interface RoomCoordinator {
  readonly vaultId: VaultId;
  load(): Promise<void>;
  attachSession(session: TransportSession): Promise<void>;
  detachSession(sessionId: string): Promise<void>;
  applyClientUpdate(sessionId: string, update: Uint8Array): Promise<void>;
  applyAwareness(sessionId: string, payload: Uint8Array): Promise<void>;
  getMeta(): Promise<RoomMeta>;
  snapshotNow(triggeredBy?: string): Promise<SnapshotMeta>;
  disposeIfIdle(): Promise<boolean>;
}

export interface RoomManager {
  getOrCreate(vaultId: VaultId): Promise<RoomCoordinator>;
  get(vaultId: VaultId): Promise<RoomCoordinator | null>;
  disposeIdleRooms(): Promise<void>;
}

// ─── DocumentStore ───────────────────────────────────────────────────────────

/**
 * 负责 checkpoint + journal 的读写与恢复。
 * compactIfNeeded 由 RoomCoordinator 在每次 saveNow() 末尾调用。
 */
export interface DocumentStore {
  load(vaultId: VaultId): Promise<LoadedDocumentState>;
  appendDelta(input: AppendDeltaInput): Promise<AppendDeltaResult>;
  writeCheckpoint(input: WriteCheckpointInput): Promise<void>;
  readMeta(vaultId: VaultId): Promise<DocumentStoreMeta | null>;
  writeMeta(meta: DocumentStoreMeta): Promise<void>;
  compactIfNeeded(vaultId: VaultId): Promise<CompactResult>;
}

// ─── BlobStore ───────────────────────────────────────────────────────────────

export interface BlobStore {
  has(vaultId: VaultId, hash: BlobHash): Promise<boolean>;
  /** 返回入参中已存在于存储层的 hash 子集，用于批量上传前的去重检查 */
  hasMany(vaultId: VaultId, hashes: BlobHash[]): Promise<Set<BlobHash>>;
  put(input: PutBlobInput): Promise<void>;
  get(input: GetBlobInput): Promise<StoredBlob | null>;
  delete?(vaultId: VaultId, hash: BlobHash): Promise<void>;
}

// ─── SnapshotStore ───────────────────────────────────────────────────────────

export interface SnapshotStore {
  put(input: PutSnapshotInput): Promise<SnapshotMeta>;
  list(vaultId: VaultId): Promise<SnapshotMeta[]>;
  get(vaultId: VaultId, snapshotId: string): Promise<StoredSnapshot | null>;
  delete(vaultId: VaultId, snapshotId: string): Promise<void>;
  prune(vaultId: VaultId): Promise<{ deleted: number }>;
}

// ─── LocalCache ──────────────────────────────────────────────────────────────

/** 客户端本地缓存，不是全局权威，仅用于离线后恢复和冷启动优化 */
export interface LocalCache {
  load(vaultId: VaultId): Promise<LocalCacheState | null>;
  save(vaultId: VaultId, state: LocalCacheState): Promise<void>;
  clear(vaultId: VaultId): Promise<void>;
}

// ─── FilesystemBridge ────────────────────────────────────────────────────────

export interface FilesystemBridge {
  // 磁盘 -> 共享状态
  markDirty(path: string): void;
  drain(): Promise<void>;

  // 共享状态 -> 磁盘
  flushFile(path: string): Promise<void>;
  suppressExpectedWrite(path: string, fingerprint: FileFingerprint): void;

  // 路由：根据文件路径判断归属哪个 room（主 vault 或共享目录挂载）
  resolveVaultId(path: string): VaultId;
}

// ─── SyncEngine ──────────────────────────────────────────────────────────────

export interface SyncEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * 全量协调：扫描本地文件与共享状态的差异，补齐双向缺失。
   * 通常在启动、重连、或用户手动触发时调用，不用于平时增量同步。
   */
  reconcile(): Promise<void>;
  handleLocalFileChange(path: string): Promise<void>;
  handleRemoteUpdate(update: Uint8Array): Promise<void>;
  createSnapshot(): Promise<SnapshotMeta>;
  restoreSnapshot(snapshotId: string): Promise<void>;
}
