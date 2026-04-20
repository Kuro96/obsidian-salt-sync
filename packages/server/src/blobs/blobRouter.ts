import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Auth } from '../auth.js';
import { BLOB_GC_STALE_MS } from '@salt-sync/shared';
import type { BlobStore, BlobRef, SnapshotStore } from '@salt-sync/shared';
import type { S3BlobStore } from './s3BlobStore.js';
import type { RoomManager } from '../rooms/roomManager.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

function sha256hex(body: Uint8Array): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

// ── BlobRouter ────────────────────────────────────────────────────────────────

/** 处理附件相关 HTTP 路由，挂载在主 http.createServer 处理函数中 */
export class BlobRouter {
  constructor(
    private readonly store: BlobStore,
    private readonly auth: Auth,
    private readonly roomManager: RoomManager | null = null,
    private readonly snapshotStore: SnapshotStore | null = null,
  ) {}

  /**
   * 尝试处理请求；若 URL 不匹配任何 blob 路由则返回 false，
   * 由调用方继续处理（如 /health 或 404）。
   */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    const method = req.method ?? '';

    const token =
      (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('token') ||
      '';

    // 解析路由并拿到 vaultId 做 per-vault 鉴权（防止 vault A 的 token 访问 vault B）
    const existsMatch = pathname.match(/^\/vault\/([^/]+)\/blobs\/exists$/);
    const gcMatch = pathname.match(/^\/vault\/([^/]+)\/blobs\/gc$/);
    const blobMatch = pathname.match(/^\/vault\/([^/]+)\/blobs\/([a-f0-9]{64})$/);

    if (!existsMatch && !gcMatch && !blobMatch) return false;

    const vaultId = decodeURIComponent(
      (existsMatch ?? gcMatch ?? blobMatch!)[1],
    );

    // GC 是管理员操作，要求匹配全局 SERVER_TOKEN
    if (gcMatch) {
      if (!this.auth.validateAdminToken(token)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return true;
      }
    } else {
      if (!this.auth.validateTokenForVault(token, vaultId)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return true;
      }
    }

    if (method === 'POST' && existsMatch) {
      await this.handleExists(req, res, vaultId);
      return true;
    }

    if (method === 'POST' && gcMatch) {
      await this.handleGc(res, vaultId);
      return true;
    }

    if (blobMatch) {
      const hash = blobMatch[2];
      if (method === 'PUT') {
        await this.handlePut(req, res, vaultId, hash);
        return true;
      }
      if (method === 'GET') {
        await this.handleGet(req, res, vaultId, hash);
        return true;
      }
    }

    return false;
  }

  // ── route handlers ────────────────────────────────────────────────────────

  private async handleGc(res: ServerResponse, vaultId: string): Promise<void> {
    const s3Store = this.store as S3BlobStore;
    if (typeof s3Store.listHashes !== 'function') {
      sendJson(res, 501, { error: 'GC not supported by current store implementation' });
      return;
    }

    try {
      if (!this.roomManager) {
        // 无 roomManager（测试场景）时拒绝 GC，避免误删
        sendJson(res, 503, { error: 'roomManager unavailable; refusing to GC' });
        return;
      }

      // 从 Y.Doc 获取当前被引用的 hash 集合。
      // 必须走 getOrCreate + load，否则未加载的 room 会导致活引用集合为空 → 误删所有 blob。
      const room = await this.roomManager.getOrCreate(vaultId);
      await room.load();
      const liveHashes = new Set<string>();
      for (const [, ref] of room.pathToBlob as unknown as Map<string, BlobRef>) {
        liveHashes.add(ref.hash);
      }

      // 保护被存活快照引用的 blob，防止在快照保留期内被 GC 误删
      if (this.snapshotStore) {
        const snapshots = await this.snapshotStore.list(vaultId);
        for (const snap of snapshots) {
          for (const hash of snap.referencedBlobHashes ?? []) {
            liveHashes.add(hash);
          }
        }
      }

      // 获取 S3 中所有 blob hash 及 LastModified
      const allObjects = await s3Store.listHashes(vaultId);

      // staleness 过滤：只删早于 (now - BLOB_GC_STALE_MS) 的孤立对象，
      // 给"刚 PUT 但 pathToBlob 引用尚未到达"的对象留缓冲窗口。
      const cutoff = Date.now() - BLOB_GC_STALE_MS;
      const orphans = allObjects.filter((o) => !liveHashes.has(o.hash));
      const stale = orphans.filter(
        (o) => o.lastModified !== null && o.lastModified.getTime() < cutoff,
      );
      const skippedTooNew = orphans.length - stale.length;

      for (const { hash } of stale) {
        await s3Store.delete(vaultId, hash).catch((err) => {
          console.error(`[BlobRouter] GC delete error for ${hash}:`, err);
        });
      }

      sendJson(res, 200, {
        checked: allObjects.length,
        deleted: stale.length,
        kept: liveHashes.size,
        skippedTooNew,
      });
    } catch (err) {
      console.error('[BlobRouter] GC error:', err);
      sendJson(res, 500, { error: 'internal error' });
    }
  }

  private async handleExists(
    req: IncomingMessage,
    res: ServerResponse,
    vaultId: string,
  ): Promise<void> {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body.toString()) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as Record<string, unknown>).hashes)
      ) {
        sendJson(res, 400, { error: 'body must be { hashes: string[] }' });
        return;
      }
      const hashes = (parsed as { hashes: string[] }).hashes;
      const existing = await this.store.hasMany(vaultId, hashes);
      sendJson(res, 200, { existing: [...existing] });
    } catch (err) {
      console.error('[BlobRouter] exists error:', err);
      sendJson(res, 500, { error: 'internal error' });
    }
  }

  private async handlePut(
    req: IncomingMessage,
    res: ServerResponse,
    vaultId: string,
    hash: string,
  ): Promise<void> {
    try {
      const body = await readBody(req);
      const actualHash = sha256hex(body);
      if (actualHash !== hash) {
        sendJson(res, 400, { error: 'hash mismatch' });
        return;
      }
      const contentType = req.headers['content-type'];
      await this.store.put({
        vaultId,
        hash,
        bytes: new Uint8Array(body),
        contentType,
      });
      res.writeHead(204);
      res.end();
    } catch (err) {
      console.error('[BlobRouter] PUT error:', err);
      sendJson(res, 500, { error: 'internal error' });
    }
  }

  private async handleGet(
    req: IncomingMessage,
    res: ServerResponse,
    vaultId: string,
    hash: string,
  ): Promise<void> {
    try {
      const blob = await this.store.get({ vaultId, hash });
      if (!blob) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': blob.contentType ?? 'application/octet-stream',
        'Content-Length': blob.size,
        'Cache-Control': 'immutable, max-age=31536000',
      });
      res.end(Buffer.from(blob.bytes));
    } catch (err) {
      console.error('[BlobRouter] GET error:', err);
      sendJson(res, 500, { error: 'internal error' });
    }
  }
}
