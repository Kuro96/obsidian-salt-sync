/**
 * 二进制 WebSocket 协议帧。
 *
 * 帧布局：
 *   +--------+-------------------+
 *   | tag:1  | body: remaining   |
 *   +--------+-------------------+
 *
 * tag 区间：
 *   0x01-0x0F  control  — body 是 UTF-8 JSON
 *   0x10-0x1F  data     — body 是裸 Yjs 二进制（sync_update / sv / awareness）
 *   0x20-0x2F  diag     — body 是 UTF-8 JSON
 *
 * 对应编解码由 encodeFrame / decodeFrame 封装，双向对称。
 */
import type { TransportMessage } from './protocol.js';

export const FRAME_TAG = {
  HELLO: 0x01,
  AUTH_OK: 0x02,
  AUTH_FAILED: 0x03,
  SCHEMA_MISMATCH: 0x04,
  SERVER_ERROR: 0x05,
  SYNC_UPDATE: 0x10,
  SYNC_STATE_VECTOR: 0x11,
  AWARENESS_UPDATE: 0x12,
  ROOM_META: 0x20,
} as const;

type FrameTag = (typeof FRAME_TAG)[keyof typeof FRAME_TAG];

const TYPE_TO_TAG: Record<TransportMessage['type'], FrameTag> = {
  hello: FRAME_TAG.HELLO,
  auth_ok: FRAME_TAG.AUTH_OK,
  auth_failed: FRAME_TAG.AUTH_FAILED,
  schema_mismatch: FRAME_TAG.SCHEMA_MISMATCH,
  server_error: FRAME_TAG.SERVER_ERROR,
  sync_update: FRAME_TAG.SYNC_UPDATE,
  sync_state_vector: FRAME_TAG.SYNC_STATE_VECTOR,
  awareness_update: FRAME_TAG.AWARENESS_UPDATE,
  room_meta: FRAME_TAG.ROOM_META,
};

const TAG_TO_TYPE: Record<FrameTag, TransportMessage['type']> = {
  [FRAME_TAG.HELLO]: 'hello',
  [FRAME_TAG.AUTH_OK]: 'auth_ok',
  [FRAME_TAG.AUTH_FAILED]: 'auth_failed',
  [FRAME_TAG.SCHEMA_MISMATCH]: 'schema_mismatch',
  [FRAME_TAG.SERVER_ERROR]: 'server_error',
  [FRAME_TAG.SYNC_UPDATE]: 'sync_update',
  [FRAME_TAG.SYNC_STATE_VECTOR]: 'sync_state_vector',
  [FRAME_TAG.AWARENESS_UPDATE]: 'awareness_update',
  [FRAME_TAG.ROOM_META]: 'room_meta',
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function isDataTag(tag: number): boolean {
  return tag >= 0x10 && tag <= 0x1f;
}

function dataFrame(tag: FrameTag, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.byteLength);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

function jsonFrame(tag: FrameTag, obj: unknown): Uint8Array {
  const body = textEncoder.encode(JSON.stringify(obj));
  const out = new Uint8Array(1 + body.byteLength);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

export function encodeFrame(msg: TransportMessage): Uint8Array {
  const tag = TYPE_TO_TAG[msg.type];
  if (tag === undefined) {
    throw new Error(`encodeFrame: unknown message type '${(msg as { type: string }).type}'`);
  }

  switch (msg.type) {
    case 'sync_update':
      return dataFrame(tag, msg.update);
    case 'sync_state_vector':
      return dataFrame(tag, msg.sv);
    case 'awareness_update':
      return dataFrame(tag, msg.payload);
    default: {
      // Control / diag: strip `type` since it's already in the tag
      const { type: _drop, ...rest } = msg as TransportMessage & Record<string, unknown>;
      return jsonFrame(tag, rest);
    }
  }
}

export function decodeFrame(frame: Uint8Array): TransportMessage {
  if (frame.byteLength < 1) {
    throw new Error('decodeFrame: frame is empty');
  }
  const tag = frame[0] as FrameTag;
  const type = TAG_TO_TYPE[tag];
  if (type === undefined) {
    throw new Error(`decodeFrame: unknown tag 0x${frame[0].toString(16).padStart(2, '0')}`);
  }

  // Subarray copy: we slice so the returned Uint8Array owns an independent
  // buffer, protecting callers from accidental reuse of the ws recv buffer.
  const body = frame.subarray(1);

  if (isDataTag(tag)) {
    const payload = body.slice();
    switch (type) {
      case 'sync_update':
        return { type, update: payload };
      case 'sync_state_vector':
        return { type, sv: payload };
      case 'awareness_update':
        return { type, payload };
      default:
        throw new Error(`decodeFrame: data tag 0x${tag.toString(16)} mapped to non-data type '${type}'`);
    }
  }

  const text = textDecoder.decode(body);
  const obj = text.length ? JSON.parse(text) : {};
  return { type, ...obj } as TransportMessage;
}
