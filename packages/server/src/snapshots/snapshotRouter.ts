import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Auth } from '../auth.js';
import type { SnapshotStore } from '@salt-sync/shared';
import type { RoomManager } from '../rooms/roomManager.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

/** 处理 snapshot 相关 HTTP 路由 */
export class SnapshotRouter {
  constructor(
    private readonly store: SnapshotStore,
    private readonly roomManager: RoomManager,
    private readonly auth: Auth,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    const method = req.method ?? '';

    const createMatch = pathname.match(/^\/vault\/([^/]+)\/snapshots$/);
    const getMatch = pathname.match(/^\/vault\/([^/]+)\/snapshots\/([^/]+)$/);

    if (!createMatch && !getMatch) return false;

    const vaultId = decodeURIComponent((createMatch ?? getMatch!)[1]);
    const token =
      (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('token') ||
      '';

    if (!this.auth.validateTokenForVault(token, vaultId)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    if (method === 'POST' && createMatch) {
      await this.handleCreate(res, vaultId);
      return true;
    }
    if (method === 'GET' && createMatch) {
      await this.handleList(res, vaultId);
      return true;
    }
    if (method === 'GET' && getMatch) {
      await this.handleGet(res, vaultId, decodeURIComponent(getMatch[2]));
      return true;
    }

    return false;
  }

  // ── route handlers ────────────────────────────────────────────────────────

  private async handleCreate(res: ServerResponse, vaultId: string): Promise<void> {
    try {
      const room = await this.roomManager.getOrCreate(vaultId);
      const meta = await room.snapshotNow('http-request');
      sendJson(res, 201, meta);
    } catch (err) {
      console.error('[SnapshotRouter] create error:', err);
      sendJson(res, 500, { error: 'internal error' });
    }
  }

  private async handleList(res: ServerResponse, vaultId: string): Promise<void> {
    try {
      const metas = await this.store.list(vaultId);
      sendJson(res, 200, { snapshots: metas });
    } catch (err) {
      console.error('[SnapshotRouter] list error:', err);
      sendJson(res, 500, { error: 'internal error' });
    }
  }

  private async handleGet(res: ServerResponse, vaultId: string, snapshotId: string): Promise<void> {
    try {
      const snapshot = await this.store.get(vaultId, snapshotId);
      if (!snapshot) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': snapshot.payload.length,
        'X-Snapshot-Meta': JSON.stringify(snapshot.meta),
      });
      res.end(Buffer.from(snapshot.payload));
    } catch (err) {
      console.error('[SnapshotRouter] get error:', err);
      sendJson(res, 500, { error: 'internal error' });
    }
  }
}
