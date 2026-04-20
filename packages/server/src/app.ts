import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { SCHEMA_VERSION } from '@salt-sync/shared';
import type { TransportSession, VaultId, TransportMessage } from '@salt-sync/shared';
import { Auth } from './auth.js';
import { encodeFrame, decodeFrame } from '@salt-sync/shared';
import { SqliteDocumentStore } from './persistence/sqliteDocumentStore.js';
import { RoomManager } from './rooms/roomManager.js';
import { BlobRouter } from './blobs/blobRouter.js';
import { SnapshotRouter } from './snapshots/snapshotRouter.js';
import { FileRouter } from './files/fileRouter.js';
import { AdminRouter } from './admin/adminRouter.js';
import type { S3BlobStore } from './blobs/s3BlobStore.js';
import type { S3SnapshotStore } from './snapshots/s3SnapshotStore.js';

export interface AppDeps {
  auth: Auth;
  store: SqliteDocumentStore;
  roomManager: RoomManager;
  blobStore: S3BlobStore | null;
  snapshotStore: S3SnapshotStore | null;
  startTime?: number;
}

export interface AppHandle {
  server: http.Server;
  wss: WebSocketServer;
  roomManager: RoomManager;
  /** Close WS + HTTP; no-op if already stopped. */
  close(): Promise<void>;
}

/**
 * Build the full server stack (HTTP + WS) and return a handle.
 * Caller decides when to .listen() and .close(). No background timers.
 */
export function createApp(deps: AppDeps): AppHandle {
  const startTime = deps.startTime ?? Date.now();
  const { auth, roomManager, blobStore, snapshotStore } = deps;
  const blobRouter = blobStore ? new BlobRouter(blobStore, auth, roomManager, snapshotStore) : null;
  const snapshotRouter = snapshotStore
    ? new SnapshotRouter(snapshotStore, roomManager, auth)
    : null;
  const fileRouter = new FileRouter(blobStore, snapshotStore, roomManager, auth);
  const adminRouter = new AdminRouter();

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url ?? '';
    const url = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      const activeRooms = roomManager.listActive();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          timestamp: new Date().toISOString(),
          uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
          rooms: {
            active: activeRooms.length,
            vaultIds: activeRooms.map((r) => r.vaultId),
          },
          schemaVersion: SCHEMA_VERSION,
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/api/rooms') {
      const token =
        (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '') ||
        url.searchParams.get('token') ||
        '';
      if (!auth.validateAdminToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const rooms = await Promise.all(roomManager.listActive().map((r) => r.getMeta()));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rooms }));
      return;
    }

    if (blobRouter && (await blobRouter.handle(req, res, url))) return;
    if (await fileRouter.handle(req, res, url)) return;
    if (snapshotRouter && (await snapshotRouter.handle(req, res, url))) return;
    if (adminRouter.handle(req, res)) return;

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const rawUrl = request.url ?? '';
    const url = new URL(rawUrl, `http://${request.headers.host ?? 'localhost'}`);
    const match = url.pathname.match(/^\/vault\/sync\/([^/]+)$/);

    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const vaultId = decodeURIComponent(match[1]);
    if (!auth.validateVaultId(vaultId)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConnection(ws, vaultId, auth, roomManager);
    });
  });

  return {
    server,
    wss,
    roomManager,
    async close() {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function handleConnection(
  ws: WebSocket,
  vaultId: VaultId,
  auth: Auth,
  roomManager: RoomManager,
): void {
  const sessionId = crypto.randomUUID();
  let authenticated = false;
  let session: TransportSession | null = null;

  ws.on('message', async (data: Buffer) => {
    try {
      const msg = decodeFrame(new Uint8Array(data));

      if (!authenticated) {
        if (msg.type !== 'hello') {
          ws.send(
            encodeFrame({
              type: 'server_error',
              code: 'HELLO_REQUIRED',
              message: 'First message must be hello',
            }),
            { binary: true },
          );
          ws.close(1008, 'HELLO_REQUIRED');
          return;
        }

        if (!auth.validateTokenForVault(msg.token ?? '', vaultId)) {
          ws.send(encodeFrame({ type: 'auth_failed', reason: 'Invalid token' }), { binary: true });
          ws.close(1008, 'auth_failed');
          return;
        }

        if (msg.schemaVersion !== SCHEMA_VERSION) {
          ws.send(
            encodeFrame({
              type: 'schema_mismatch',
              serverSchemaVersion: SCHEMA_VERSION,
            }),
            { binary: true },
          );
          ws.close(1008, 'schema_mismatch');
          return;
        }

        authenticated = true;
        ws.send(
          encodeFrame({ type: 'auth_ok', serverSchemaVersion: SCHEMA_VERSION }),
          { binary: true },
        );

        session = makeSession(sessionId, vaultId, ws);
        const room = await roomManager.getOrCreate(vaultId);
        await room.attachSession(session);
        console.log(`[server] session ${sessionId} authenticated for vault ${vaultId}`);
        return;
      }
    } catch (err) {
      console.error(`[server] message error on session ${sessionId}:`, err);
      // Unknown/garbled first frame: treat as protocol mismatch, mirroring PRD §8.3.3
      if (!authenticated) {
        try {
          ws.send(
            encodeFrame({ type: 'auth_failed', reason: 'protocol mismatch' }),
            { binary: true },
          );
        } catch {}
        ws.close(1002, 'protocol mismatch');
      }
    }
  });

  ws.on('close', () => {
    if (!authenticated) return;
    const room = roomManager.get(vaultId);
    if (room) room.detachSession(sessionId).catch(console.error);
  });

  ws.on('error', (err) => {
    console.error(`[server] ws error on session ${sessionId}:`, err);
  });
}

function makeSession(id: string, vaultId: VaultId, ws: WebSocket): TransportSession {
  const messageHandlers: Array<(msg: TransportMessage) => Promise<void> | void> = [];
  const closeHandlers: Array<() => Promise<void> | void> = [];

  ws.on('message', (data: Buffer) => {
    try {
      const msg = decodeFrame(new Uint8Array(data));
      if (msg.type === 'hello') return;
      for (const h of messageHandlers) h(msg);
    } catch {}
  });

  ws.on('close', () => {
    for (const h of closeHandlers) h();
  });

  return {
    id,
    vaultId,
    async send(message) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeFrame(message), { binary: true });
      }
    },
    async close(code, reason) {
      ws.close(code, reason);
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
  };
}
