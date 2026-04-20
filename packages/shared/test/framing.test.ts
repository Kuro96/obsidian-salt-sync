import { describe, it, expect } from 'vitest';
import {
  encodeFrame,
  decodeFrame,
  FRAME_TAG,
  SCHEMA_VERSION,
} from '../src';
import type { TransportMessage } from '../src';

describe('framing round-trip', () => {
  it('hello (control/JSON)', () => {
    const msg: TransportMessage = {
      type: 'hello',
      token: 't',
      deviceId: 'd',
      deviceName: 'Laptop',
      schemaVersion: SCHEMA_VERSION,
    };
    const frame = encodeFrame(msg);
    expect(frame[0]).toBe(FRAME_TAG.HELLO);
    expect(decodeFrame(frame)).toEqual(msg);
  });

  it('auth_ok / auth_failed / schema_mismatch / server_error (control)', () => {
    const variants: TransportMessage[] = [
      { type: 'auth_ok', serverSchemaVersion: 2 },
      { type: 'auth_failed', reason: 'bad token' },
      { type: 'schema_mismatch', serverSchemaVersion: 3 },
      { type: 'server_error', code: 'E_X', message: 'boom' },
    ];
    for (const msg of variants) {
      const frame = encodeFrame(msg);
      expect(decodeFrame(frame)).toEqual(msg);
    }
  });

  it('sync_update (data) keeps bytes intact and avoids base64 overhead', () => {
    const update = new Uint8Array([0, 1, 2, 254, 255]);
    const frame = encodeFrame({ type: 'sync_update', update });
    expect(frame[0]).toBe(FRAME_TAG.SYNC_UPDATE);
    // Total frame length == 1 tag byte + raw update length (no base64 bloat)
    expect(frame.byteLength).toBe(1 + update.byteLength);

    const decoded = decodeFrame(frame);
    expect(decoded.type).toBe('sync_update');
    expect(decoded.type === 'sync_update' && Array.from(decoded.update)).toEqual(
      Array.from(update),
    );
  });

  it('sync_state_vector (data) round-trips', () => {
    const sv = new Uint8Array([9, 8, 7, 6, 5]);
    const decoded = decodeFrame(encodeFrame({ type: 'sync_state_vector', sv }));
    expect(decoded.type).toBe('sync_state_vector');
    expect(decoded.type === 'sync_state_vector' && Array.from(decoded.sv)).toEqual([9, 8, 7, 6, 5]);
  });

  it('awareness_update (data) round-trips', () => {
    const payload = new Uint8Array([42, 0, 17]);
    const decoded = decodeFrame(encodeFrame({ type: 'awareness_update', payload }));
    expect(decoded.type).toBe('awareness_update');
    expect(decoded.type === 'awareness_update' && Array.from(decoded.payload)).toEqual([42, 0, 17]);
  });

  it('room_meta (diag/JSON)', () => {
    const meta = {
      vaultId: 'v1',
      schemaVersion: 2,
      connectedClientCount: 3,
      loaded: true,
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const frame = encodeFrame({ type: 'room_meta', meta });
    expect(frame[0]).toBe(FRAME_TAG.ROOM_META);
    expect(decodeFrame(frame)).toEqual({ type: 'room_meta', meta });
  });

  it('decoded data payload is an independent copy (does not share the recv buffer)', () => {
    const update = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeFrame({ type: 'sync_update', update });
    const decoded = decodeFrame(frame) as { type: 'sync_update'; update: Uint8Array };
    // Mutating the original frame must not leak into the decoded payload
    frame[1] = 99;
    expect(decoded.update[0]).toBe(1);
  });

  it('decodeFrame rejects empty frames and unknown tags', () => {
    expect(() => decodeFrame(new Uint8Array())).toThrow(/empty/);
    expect(() => decodeFrame(new Uint8Array([0xff]))).toThrow(/unknown tag/);
  });
});
