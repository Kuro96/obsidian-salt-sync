/**
 * Y.Doc 共享数据模型版本，握手时双端校验。
 *
 * v1：pathToId / idToPath / docs / sys / pathToBlob / blobTombstones
 * v2：新增 fileTombstones（markdown 文件删除同步）
 */
export const SCHEMA_VERSION = 2;

/** journal 条目数超过此阈值时触发 compact */
export const MAX_JOURNAL_ENTRIES = 100;

/** journal 总字节数超过此阈值时触发 compact */
export const MAX_JOURNAL_BYTES = 1024 * 1024; // 1 MB

/** room 收到最后一次 update 后，延迟多少毫秒执行持久化 */
export const SAVE_DEBOUNCE_MS = 5_000;

/** WebSocket 重连的初始等待时间 */
export const RECONNECT_BASE_MS = 1_000;

/** WebSocket 重连的最大等待时间 */
export const RECONNECT_MAX_MS = 30_000;

/** 每累计多少条 journal 写入后自动创建 snapshot（Phase 6） */
export const AUTO_SNAPSHOT_ENTRIES = 50;

/**
 * Blob GC staleness 门槛（毫秒）。
 * 只有 LastModified 早于 (now - 此值) 的孤立对象才会被删除，
 * 给刚上传但 pathToBlob 尚未被本轮 GC 读到的 blob 留缓冲。
 */
export const BLOB_GC_STALE_MS = 10 * 60 * 1000; // 10 分钟

/** 快照默认保留天数（可通过 SNAPSHOT_RETENTION_DAYS 环境变量覆盖） */
export const SNAPSHOT_RETENTION_DAYS = 7;

/** 每个 vault 默认保留的最大快照数量（可通过 SNAPSHOT_MAX_COUNT 环境变量覆盖） */
export const SNAPSHOT_MAX_COUNT = 5;
