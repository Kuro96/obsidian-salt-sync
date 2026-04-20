import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { SCHEMA_VERSION, encodeFrame, decodeFrame } from '@salt-sync/shared';
import type { TransportMessage } from '@salt-sync/shared';
import { startTestServer, type TestServer } from '../helpers/integrationServer';

let srv: TestServer;
afterEach(async () => {
  if (srv) await srv.cleanup();
});

interface BufferedWs {
  ws: WebSocket;
  next(): Promise<TransportMessage>;
  waitFor(predicate: (m: TransportMessage) => boolean): Promise<TransportMessage>;
  close(): void;
}

function openWs(url: string): Promise<BufferedWs> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const queue: TransportMessage[] = [];
    const waiters: Array<(m: TransportMessage) => void> = [];
    ws.on('message', (data: Buffer) => {
      const m = decodeFrame(new Uint8Array(data));
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    });
    ws.once('open', () =>
      resolve({
        ws,
        next: () =>
          new Promise<TransportMessage>((res) => {
            if (queue.length) res(queue.shift()!);
            else waiters.push(res);
          }),
        async waitFor(pred) {
          for (;;) {
            const m = queue.length
              ? queue.shift()!
              : await new Promise<TransportMessage>((res) => waiters.push(res));
            if (pred(m)) return m;
          }
        },
        close: () => ws.close(),
      }),
    );
    ws.once('error', reject);
  });
}

function send(ws: BufferedWs, msg: TransportMessage): void {
  ws.ws.send(encodeFrame(msg), { binary: true });
}

describe('WebSocket integration', () => {
  it('rejects bad token with auth_failed', async () => {
    srv = await startTestServer({ serverToken: 'good' });
    const w = await openWs(srv.wsUrl('v1'));
    send(w, { type: 'hello', token: 'BAD', deviceId: 'd', schemaVersion: SCHEMA_VERSION });
    const reply = await w.next();
    expect(reply.type).toBe('auth_failed');
    w.close();
  });

  it('rejects mismatched schemaVersion', async () => {
    srv = await startTestServer({ serverToken: 'good' });
    const w = await openWs(srv.wsUrl('v1'));
    send(w, { type: 'hello', token: 'good', deviceId: 'd', schemaVersion: 999 });
    const reply = await w.next();
    expect(reply.type).toBe('schema_mismatch');
    w.close();
  });

  it('per-vault token isolation: v1 token cannot access v2', async () => {
    srv = await startTestServer({ serverToken: 'admin', vaultTokens: { v1: 't1', v2: 't2' } });
    const w = await openWs(srv.wsUrl('v2'));
    send(w, { type: 'hello', token: 't1', deviceId: 'd', schemaVersion: SCHEMA_VERSION });
    const reply = await w.next();
    expect(reply.type).toBe('auth_failed');
    w.close();
  });

  it('successful handshake: auth_ok then sync_state_vector', async () => {
    srv = await startTestServer({ serverToken: 'good' });
    const w = await openWs(srv.wsUrl('v1'));
    send(w, { type: 'hello', token: 'good', deviceId: 'd', schemaVersion: SCHEMA_VERSION });
    const m1 = await w.next();
    expect(m1.type).toBe('auth_ok');
    const m2 = await w.next();
    expect(m2.type).toBe('sync_state_vector');
    w.close();
  });

  it('two clients converge on sync_update broadcast', async () => {
    srv = await startTestServer({ serverToken: 'good' });
    const a = await openWs(srv.wsUrl('v1'));
    const b = await openWs(srv.wsUrl('v1'));

    send(a, { type: 'hello', token: 'good', deviceId: 'A', schemaVersion: SCHEMA_VERSION });
    send(b, { type: 'hello', token: 'good', deviceId: 'B', schemaVersion: SCHEMA_VERSION });

    // drain both handshakes (auth_ok + sync_state_vector)
    await a.next(); await a.next();
    await b.next(); await b.next();

    const tmp = new Y.Doc();
    tmp.getText('t').insert(0, 'hello');
    send(a, { type: 'sync_update', update: Y.encodeStateAsUpdate(tmp) });

    const received = await b.waitFor(
      (m) => m.type === 'sync_update' && m.update.length > 2,
    );

    const verify = new Y.Doc();
    Y.applyUpdate(verify, (received as { type: 'sync_update'; update: Uint8Array }).update);
    expect(verify.getText('t').toString()).toBe('hello');

    a.close();
    b.close();
  });
});
