import type { IncomingMessage, ServerResponse } from 'node:http';
import { SCHEMA_VERSION, BLOB_GC_STALE_MS } from '@salt-sync/shared';
import { ZipFile } from 'yazl';
import type { Auth } from '../auth.js';
import type { SyncTokenRecord, SyncTokenStatus, SyncTokenStore } from '../auth/syncTokenStore.js';
import type { SqliteDocumentStore } from '../persistence/sqliteDocumentStore.js';
import type { RoomManager } from '../rooms/roomManager.js';
import type { BlobRef, BlobStore, SnapshotStore } from '@salt-sync/shared';
import type { S3BlobStore } from '../blobs/s3BlobStore.js';
import { docFromPayload, extractBlobRef, extractMarkdown, listAllFiles } from '../snapshots/snapshotUtils.js';

interface AdminApiRouterDeps {
  auth: Auth;
  blobStore: BlobStore | null;
  syncTokenStore: SyncTokenStore;
  snapshotStore: SnapshotStore | null;
  store: SqliteDocumentStore;
  roomManager: RoomManager;
  startTime: number;
}

interface TokenMutationBody {
  name?: unknown;
  note?: unknown;
  expiresAt?: unknown;
  status?: unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function getBearerToken(req: IncomingMessage, url: URL): string {
  return (
    (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('token') ||
    ''
  );
}

function redactEndpoint(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}`;
  } catch {
    return endpoint;
  }
}

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('payload_too_large');
    }
    chunks.push(buf);
  }

  if (chunks.length === 0) return {};

  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sanitizeTokenRecord(record: SyncTokenRecord): Omit<SyncTokenRecord, 'tokenHash'> {
  const { tokenHash: _tokenHash, ...safeRecord } = record;
  return safeRecord;
}

// 'expired' is a time-driven automatic state; admins may only set active or revoked via PATCH.
function isValidStatus(value: unknown): value is Extract<SyncTokenStatus, 'active' | 'revoked'> {
  return value === 'active' || value === 'revoked';
}

function normalizeOptionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${field}_must_be_string`);
  }
  return value;
}

function normalizeRequiredName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('name_required');
  }
  return value.trim();
}

function normalizeExpiresAt(value: unknown): string | null | undefined {
  const normalized = normalizeOptionalString(value, 'expiresAt');
  if (normalized === undefined || normalized === null) {
    return normalized;
  }
  // Treat empty string as "no expiry" rather than storing an ambiguous '' in the DB.
  if (normalized === '') {
    return null;
  }
  if (Number.isNaN(new Date(normalized).getTime())) {
    throw new Error('expiresAt_invalid');
  }
  return normalized;
}

function errorStatus(error: string): number {
  return error === 'not_found' ? 404 : 400;
}

function zipDate(iso: string): Date {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? new Date() : value;
}

export class AdminApiRouter {
  constructor(private readonly deps: AdminApiRouterDeps) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    if (!pathname.startsWith('/admin/api/')) return false;

    const token = getBearerToken(req, url);
    if (!this.deps.auth.validateAdminToken(token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    try {
      if (req.method === 'GET' && pathname === '/admin/api/overview') {
        await this.handleOverview(res);
        return true;
      }

      if (req.method === 'GET' && pathname === '/admin/api/rooms') {
        await this.handleRooms(res);
        return true;
      }

      const roomMatch = pathname.match(/^\/admin\/api\/rooms\/([^/]+)$/);
      if (req.method === 'GET' && roomMatch) {
        await this.handleRoomDetails(res, decodeURIComponent(roomMatch[1]));
        return true;
      }

      if (req.method === 'GET' && pathname === '/admin/api/config') {
        this.handleConfig(res);
        return true;
      }

      if (req.method === 'GET' && pathname === '/admin/api/tokens') {
        this.handleTokenList(res);
        return true;
      }

      if (req.method === 'POST' && pathname === '/admin/api/tokens') {
        await this.handleTokenCreate(req, res);
        return true;
      }

      const tokenMatch = pathname.match(/^\/admin\/api\/tokens\/([^/]+)$/);
      if (tokenMatch && req.method === 'PATCH') {
        await this.handleTokenUpdate(req, res, decodeURIComponent(tokenMatch[1]));
        return true;
      }

      if (tokenMatch && req.method === 'DELETE') {
        this.handleTokenDelete(res, decodeURIComponent(tokenMatch[1]));
        return true;
      }

      const rotateMatch = pathname.match(/^\/admin\/api\/tokens\/([^/]+)\/rotate$/);
      if (rotateMatch && req.method === 'POST') {
        this.handleTokenRotate(res, decodeURIComponent(rotateMatch[1]));
        return true;
      }

      const snapshotListMatch = pathname.match(/^\/admin\/api\/vaults\/([^/]+)\/snapshots$/);
      if (snapshotListMatch && req.method === 'GET') {
        await this.handleAdminSnapshotList(res, decodeURIComponent(snapshotListMatch[1]));
        return true;
      }

      if (snapshotListMatch && req.method === 'POST') {
        await this.handleAdminSnapshotCreate(res, decodeURIComponent(snapshotListMatch[1]));
        return true;
      }

      const snapshotDetailMatch = pathname.match(/^\/admin\/api\/vaults\/([^/]+)\/snapshots\/([^/]+)$/);
      if (snapshotDetailMatch && req.method === 'DELETE') {
        await this.handleAdminSnapshotDelete(
          res,
          decodeURIComponent(snapshotDetailMatch[1]),
          decodeURIComponent(snapshotDetailMatch[2]),
        );
        return true;
      }

      const snapshotManifestMatch = pathname.match(/^\/admin\/api\/vaults\/([^/]+)\/snapshots\/([^/]+)\/manifest$/);
      if (snapshotManifestMatch && req.method === 'GET') {
        await this.handleAdminSnapshotManifest(
          res,
          decodeURIComponent(snapshotManifestMatch[1]),
          decodeURIComponent(snapshotManifestMatch[2]),
        );
        return true;
      }

      const snapshotDownloadMatch = pathname.match(/^\/admin\/api\/vaults\/([^/]+)\/snapshots\/([^/]+)\/download$/);
      if (snapshotDownloadMatch && req.method === 'GET') {
        await this.handleAdminSnapshotDownload(
          res,
          decodeURIComponent(snapshotDownloadMatch[1]),
          decodeURIComponent(snapshotDownloadMatch[2]),
        );
        return true;
      }

      const snapshotRestoreMatch = pathname.match(/^\/admin\/api\/vaults\/([^/]+)\/snapshots\/([^/]+)\/restore$/);
      if (snapshotRestoreMatch && req.method === 'POST') {
        await this.handleAdminSnapshotRestore(
          res,
          decodeURIComponent(snapshotRestoreMatch[1]),
          decodeURIComponent(snapshotRestoreMatch[2]),
        );
        return true;
      }

      const blobGcMatch = pathname.match(/^\/admin\/api\/vaults\/([^/]+)\/blobs\/gc$/);
      if (blobGcMatch && req.method === 'POST') {
        await this.handleAdminBlobGc(res, decodeURIComponent(blobGcMatch[1]));
        return true;
      }

      sendJson(res, 404, { error: 'not_found' });
      return true;
    } catch (err) {
      console.error('[AdminApiRouter] request failed:', err);
      if (err instanceof SyntaxError) {
        sendJson(res, 400, { error: 'invalid_json' });
        return true;
      }
      if (err instanceof Error && err.message === 'snapshot_store_not_configured') {
        sendJson(res, 501, { error: 'snapshot_store_not_configured' });
        return true;
      }
      if (err instanceof Error && err.message === 'payload_too_large') {
        sendJson(res, 413, { error: 'payload_too_large' });
        return true;
      }
      if (err instanceof Error && /^(name_required|name_must_be_string|note_must_be_string|expiresAt_must_be_string|expiresAt_invalid|status_invalid)$/.test(err.message)) {
        sendJson(res, errorStatus(err.message), { error: err.message });
        return true;
      }
      sendJson(res, 500, { error: 'internal_error' });
      return true;
    }
  }

  private async handleOverview(res: ServerResponse): Promise<void> {
    const activeRooms = await Promise.all(this.deps.roomManager.listActive().map((room) => room.getMeta()));
    sendJson(res, 200, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.deps.startTime) / 1000),
      schemaVersion: SCHEMA_VERSION,
      rooms: {
        active: activeRooms.length,
        vaultIds: activeRooms.map((room) => room.vaultId),
      },
      tokenMode: this.deps.auth.getSyncTokenMode(),
    });
  }

  private async handleRooms(res: ServerResponse): Promise<void> {
    const rooms = await Promise.all(this.deps.roomManager.listActive().map((room) => room.getMeta()));
    sendJson(res, 200, { rooms });
  }

  private async handleRoomDetails(res: ServerResponse, vaultId: string): Promise<void> {
    const room = this.deps.roomManager.get(vaultId);
    const persistence = await this.deps.store.readMeta(vaultId);

    if (!room && !persistence) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    sendJson(res, 200, {
      vaultId,
      active: Boolean(room),
      room: room ? await room.getMeta() : null,
      state: room ? room.getAdminState() : null,
      persistence,
    });
  }

  private handleConfig(res: ServerResponse): void {
    sendJson(res, 200, {
      auth: {
        tokenMode: this.deps.auth.getSyncTokenMode(),
        adminTokenConfigured: Boolean(process.env.SERVER_TOKEN),
        envFallbackAvailable: this.deps.auth.isEnvFallbackAvailable(),
        legacyVaultTokenCount: this.deps.auth.getConfiguredVaultTokenCount(),
        dbTokenCount: this.deps.auth.getDbTokenCount(),
      },
      storage: {
        dataDir: process.env.DATA_DIR ?? null,
        s3Endpoint: redactEndpoint(process.env.S3_ENDPOINT),
        s3Region: process.env.S3_REGION ?? null,
        s3Bucket: process.env.S3_BUCKET ?? null,
      },
      snapshot: {
        retentionDays: parseInt(process.env.SNAPSHOT_RETENTION_DAYS ?? '', 10) || null,
        maxCount: parseInt(process.env.SNAPSHOT_MAX_COUNT ?? '', 10) || null,
      },
    });
  }

  private handleTokenList(res: ServerResponse): void {
    const tokens = this.deps.syncTokenStore.list().map(sanitizeTokenRecord);
    sendJson(res, 200, {
      tokens,
      tokenMode: this.deps.auth.getSyncTokenMode(),
    });
  }

  private async handleTokenCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJsonBody(req)) as TokenMutationBody;
    const created = this.deps.syncTokenStore.create({
      name: normalizeRequiredName(body.name),
      note: normalizeOptionalString(body.note, 'note'),
      expiresAt: normalizeExpiresAt(body.expiresAt),
    });

    sendJson(res, 201, {
      token: sanitizeTokenRecord(created.record),
      rawToken: created.rawToken,
    });
  }

  private async handleTokenUpdate(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = (await readJsonBody(req)) as TokenMutationBody;
    const status = body.status;
    if (status !== undefined && !isValidStatus(status)) {
      throw new Error('status_invalid');
    }

    const updated = this.deps.syncTokenStore.update(id, {
      name: body.name !== undefined ? normalizeRequiredName(body.name) : undefined,
      note: normalizeOptionalString(body.note, 'note'),
      expiresAt: normalizeExpiresAt(body.expiresAt),
      status,
    });

    if (!updated) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    sendJson(res, 200, { token: sanitizeTokenRecord(updated) });
  }

  private handleTokenDelete(res: ServerResponse, id: string): void {
    const revoked = this.deps.syncTokenStore.revoke(id);
    if (!revoked) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    sendJson(res, 200, { token: sanitizeTokenRecord(revoked) });
  }

  private handleTokenRotate(res: ServerResponse, id: string): void {
    const rotated = this.deps.syncTokenStore.rotate(id);
    if (!rotated) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    sendJson(res, 200, {
      token: sanitizeTokenRecord(rotated.record),
      rawToken: rotated.rawToken,
    });
  }

  private getSnapshotStore(): SnapshotStore {
    if (!this.deps.snapshotStore) {
      throw new Error('snapshot_store_not_configured');
    }
    return this.deps.snapshotStore;
  }

  private async handleAdminSnapshotList(res: ServerResponse, vaultId: string): Promise<void> {
    const snapshots = await this.getSnapshotStore().list(vaultId);
    sendJson(res, 200, { snapshots });
  }

  private async handleAdminSnapshotCreate(res: ServerResponse, vaultId: string): Promise<void> {
    const room = await this.deps.roomManager.getOrCreate(vaultId);
    const meta = await room.snapshotNow('admin-api');
    sendJson(res, 201, meta);
  }

  private async handleAdminSnapshotManifest(
    res: ServerResponse,
    vaultId: string,
    snapshotId: string,
  ): Promise<void> {
    const stored = await this.getSnapshotStore().get(vaultId, snapshotId);
    if (!stored) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const doc = docFromPayload(stored.payload);
    sendJson(res, 200, {
      snapshotId: stored.meta.snapshotId,
      createdAt: stored.meta.createdAt,
      files: listAllFiles(doc),
    });
  }

  private async handleAdminSnapshotDownload(
    res: ServerResponse,
    vaultId: string,
    snapshotId: string,
  ): Promise<void> {
    const stored = await this.getSnapshotStore().get(vaultId, snapshotId);
    if (!stored) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const doc = docFromPayload(stored.payload);
    const allFiles = listAllFiles(doc);
    const mtime = zipDate(stored.meta.createdAt);
    const entries: Array<{ zipPath: string; buffer: Buffer; mtime: Date }> = [];

    for (const file of allFiles) {
      if (file.type === 'markdown') {
        const text = extractMarkdown(doc, file.path);
        if (text != null) {
          entries.push({ zipPath: file.path, buffer: Buffer.from(text, 'utf-8'), mtime });
        }
        continue;
      }

      if (!this.deps.blobStore) continue;
      const blob = await this.deps.blobStore.get({ vaultId, hash: file.hash }).catch(() => null);
      if (blob) {
        entries.push({ zipPath: file.path, buffer: Buffer.from(blob.bytes), mtime });
      }
    }

    const dateStr = stored.meta.createdAt.slice(0, 10);
    const filename = `vault-${snapshotId.slice(0, 8)}-${dateStr}.zip`;
    this.streamZip(res, entries, filename);
  }

  private async handleAdminSnapshotDelete(
    res: ServerResponse,
    vaultId: string,
    snapshotId: string,
  ): Promise<void> {
    const store = this.getSnapshotStore();
    const existing = await store.get(vaultId, snapshotId);
    if (!existing) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    await store.delete(vaultId, snapshotId);
    sendJson(res, 200, { deleted: true, snapshotId });
  }

  private async handleAdminSnapshotRestore(
    res: ServerResponse,
    vaultId: string,
    snapshotId: string,
  ): Promise<void> {
    const stored = await this.getSnapshotStore().get(vaultId, snapshotId);
    if (!stored) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const room = await this.deps.roomManager.getOrCreate(vaultId);
    await room.restoreFromSnapshotPayload(stored.payload, 'admin-api');
    sendJson(res, 200, {
      restored: true,
      snapshotId,
      meta: stored.meta,
    });
  }

  private async handleAdminBlobGc(res: ServerResponse, vaultId: string): Promise<void> {
    if (!this.deps.blobStore) {
      sendJson(res, 501, { error: 'blob_store_not_configured' });
      return;
    }

    const s3Store = this.deps.blobStore as S3BlobStore;
    if (typeof s3Store.listHashes !== 'function') {
      sendJson(res, 501, { error: 'gc_not_supported_by_store' });
      return;
    }

    const room = await this.deps.roomManager.getOrCreate(vaultId);
    await room.load();
    const liveHashes = new Set<string>();
    for (const [, ref] of room.pathToBlob as unknown as Map<string, BlobRef>) {
      liveHashes.add(ref.hash);
    }

    if (this.deps.snapshotStore) {
      const snapshots = await this.deps.snapshotStore.list(vaultId);
      for (const snap of snapshots) {
        for (const hash of snap.referencedBlobHashes ?? []) {
          liveHashes.add(hash);
        }
      }
    }

    const allObjects = await s3Store.listHashes(vaultId);
    const cutoff = Date.now() - BLOB_GC_STALE_MS;
    const orphans = allObjects.filter((o) => !liveHashes.has(o.hash));
    const stale = orphans.filter(
      (o) => o.lastModified !== null && o.lastModified.getTime() < cutoff,
    );
    const skippedTooNew = orphans.length - stale.length;

    for (const { hash } of stale) {
      await s3Store.delete(vaultId, hash).catch((err) => {
        console.error(`[AdminApiRouter] GC delete error for ${hash}:`, err);
      });
    }

    sendJson(res, 200, {
      checked: allObjects.length,
      deleted: stale.length,
      kept: liveHashes.size,
      skippedTooNew,
    });
  }

  private streamZip(
    res: ServerResponse,
    entries: Array<{ zipPath: string; buffer: Buffer; mtime?: Date }>,
    filename: string,
  ): void {
    const zip = new ZipFile();

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Transfer-Encoding': 'chunked',
    });

    zip.outputStream.pipe(res);
    for (const { zipPath, buffer, mtime } of entries) {
      zip.addBuffer(buffer, zipPath, mtime ? { mtime } : undefined);
    }
    zip.end();
  }
}
