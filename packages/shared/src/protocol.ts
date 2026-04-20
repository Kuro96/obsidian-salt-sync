import type { RoomMeta } from './types.js';

// ─── 握手 ────────────────────────────────────────────────────────────────────

/** 客户端 -> 服务端，握手发起 */
export interface HelloMessage {
  type: 'hello';
  token: string;
  deviceId: string;
  deviceName?: string;
  schemaVersion: number;
}

/** 服务端 -> 客户端，握手成功 */
export interface AuthOkMessage {
  type: 'auth_ok';
  serverSchemaVersion: number;
}

/** 服务端 -> 客户端，鉴权失败 */
export interface AuthFailedMessage {
  type: 'auth_failed';
  reason: string;
}

/** 服务端 -> 客户端，schema 版本不兼容 */
export interface SchemaMismatchMessage {
  type: 'schema_mismatch';
  serverSchemaVersion: number;
}

// ─── 文档同步 ─────────────────────────────────────────────────────────────────

/** 双向，CRDT 增量 update */
export interface SyncUpdateMessage {
  type: 'sync_update';
  update: Uint8Array;
}

/** 双向，用于请求对端发送缺失的 update（state vector 交换） */
export interface SyncStateVectorMessage {
  type: 'sync_state_vector';
  sv: Uint8Array;
}

// ─── Awareness ───────────────────────────────────────────────────────────────

/** 双向，光标 / 在线状态广播 */
export interface AwarenessMessage {
  type: 'awareness_update';
  payload: Uint8Array;
}

// ─── 控制 / 诊断 ──────────────────────────────────────────────────────────────

/** 服务端 -> 客户端，room 诊断信息 */
export interface RoomMetaMessage {
  type: 'room_meta';
  meta: RoomMeta;
}

/** 服务端 -> 客户端，运行时错误 */
export interface ErrorMessage {
  type: 'server_error';
  code: string;
  message: string;
}

// ─── 联合类型 ─────────────────────────────────────────────────────────────────

export type TransportMessage =
  | HelloMessage
  | AuthOkMessage
  | AuthFailedMessage
  | SchemaMismatchMessage
  | SyncUpdateMessage
  | SyncStateVectorMessage
  | AwarenessMessage
  | RoomMetaMessage
  | ErrorMessage;
