import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZipFile } from 'yazl';
import type { Auth } from '../auth.js';
import type { BlobStore, SnapshotStore } from '@salt-sync/shared';
import type { RoomManager } from '../rooms/roomManager.js';
import { docFromPayload, listAllFiles, extractMarkdown, extractBlobRef } from '../snapshots/snapshotUtils.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function zipDate(iso: string): Date {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date() : d;
}

// ── FileRouter ────────────────────────────────────────────────────────────────

/**
 * 处理文件下载相关 HTTP 路由：
 *   GET  /vault/{id}/files/{path...}                        当前版本单文件
 *   POST /vault/{id}/files/export                           当前版本批量 ZIP
 *   GET  /vault/{id}/snapshots/{sid}/files/{path...}        快照历史版本单文件
 *   GET  /vault/{id}/snapshots/{sid}/download               完整快照 ZIP
 *   GET  /vault/{id}/snapshots/{sid}/manifest               快照文件清单
 */
export class FileRouter {
  constructor(
    private readonly blobStore: BlobStore | null,
    private readonly snapshotStore: SnapshotStore | null,
    private readonly roomManager: RoomManager,
    private readonly auth: Auth,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    const method = req.method ?? '';

    const token =
      (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('token') ||
      '';

    // ── POST routes ────────────────────────────────────────────────────────
    if (method === 'POST') {
      const exportMatch = pathname.match(/^\/vault\/([^/]+)\/files\/export$/);
      if (!exportMatch) return false;

      const vaultId = decodeURIComponent(exportMatch[1]);
      if (!this.auth.validateTokenForVault(token, vaultId)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return true;
      }
      try {
        await this.handleExport(req, res, vaultId);
      } catch (err) {
        console.error('[FileRouter] export error:', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      }
      return true;
    }

    // ── GET routes ─────────────────────────────────────────────────────────
    if (method !== 'GET') return false;

    // More-specific patterns first
    const snapshotFileMatch     = pathname.match(/^\/vault\/([^/]+)\/snapshots\/([^/]+)\/files\/(.+)$/);
    const snapshotDownloadMatch = pathname.match(/^\/vault\/([^/]+)\/snapshots\/([^/]+)\/download$/);
    const manifestMatch         = pathname.match(/^\/vault\/([^/]+)\/snapshots\/([^/]+)\/manifest$/);
    const currentFileMatch      = pathname.match(/^\/vault\/([^/]+)\/files\/(.+)$/);

    if (!snapshotFileMatch && !snapshotDownloadMatch && !manifestMatch && !currentFileMatch) return false;

    const vaultId = decodeURIComponent(
      (snapshotFileMatch ?? snapshotDownloadMatch ?? manifestMatch ?? currentFileMatch!)[1],
    );

    if (!this.auth.validateTokenForVault(token, vaultId)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    // Snapshot routes require snapshotStore; return 501 when not configured
    const isSnapshotRoute = !!(snapshotFileMatch ?? snapshotDownloadMatch ?? manifestMatch);
    if (isSnapshotRoute && !this.snapshotStore) {
      sendJson(res, 501, { error: 'snapshot store not configured' });
      return true;
    }

    try {
      if (currentFileMatch) {
        await this.handleCurrentFile(res, vaultId, decodeURIComponent(currentFileMatch[2]));
        return true;
      }

      const snapshotId = decodeURIComponent(
        (snapshotFileMatch ?? snapshotDownloadMatch ?? manifestMatch!)[2],
      );

      if (snapshotFileMatch) {
        await this.handleSnapshotFile(res, vaultId, snapshotId, decodeURIComponent(snapshotFileMatch[3]));
        return true;
      }
      if (snapshotDownloadMatch) {
        await this.handleSnapshotDownload(res, vaultId, snapshotId);
        return true;
      }
      await this.handleManifest(res, vaultId, snapshotId);
      return true;
    } catch (err) {
      console.error('[FileRouter] error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      return true;
    }
  }

  // ── route handlers ────────────────────────────────────────────────────────

  private async handleCurrentFile(res: ServerResponse, vaultId: string, docPath: string): Promise<void> {
    const room = await this.roomManager.getOrCreate(vaultId);
    await room.load();

    const fileId = room.pathToId.get(docPath);
    const text = fileId != null ? room.docs.get(fileId) : undefined;
    if (text != null) {
      const bytes = Buffer.from(text.toString(), 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': bytes.length,
      });
      res.end(bytes);
      return;
    }

    if (this.blobStore) {
      if (room.blobTombstones.has(docPath)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const ref = room.pathToBlob.get(docPath);
      if (ref) {
        const blob = await this.blobStore.get({ vaultId, hash: ref.hash });
        if (blob) {
          res.writeHead(200, {
            'Content-Type': blob.contentType ?? 'application/octet-stream',
            'Content-Length': blob.size,
          });
          res.end(Buffer.from(blob.bytes));
          return;
        }
      }
    }

    res.writeHead(404);
    res.end();
  }

  private async handleExport(req: IncomingMessage, res: ServerResponse, vaultId: string): Promise<void> {
    const body = await readBody(req);
    let paths: string[] | null = null;
    if (body.length > 0) {
      const parsed = JSON.parse(body.toString()) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>).paths)
      ) {
        paths = (parsed as { paths: string[] }).paths;
      }
    }

    const room = await this.roomManager.getOrCreate(vaultId);
    await room.load();

    // Collect entries to zip
    type ZipEntry = { zipPath: string; buffer: Buffer };
    const entries: ZipEntry[] = [];

    const addMarkdown = (path: string) => {
      if (paths !== null && paths.length > 0 && !paths.includes(path)) return;
      const fileId = room.pathToId.get(path);
      const text = fileId != null ? room.docs.get(fileId) : undefined;
      if (text == null) return;
      entries.push({ zipPath: path, buffer: Buffer.from(text.toString(), 'utf-8') });
    };

    const addBlob = async (path: string) => {
      if (!this.blobStore) return;
      if (paths !== null && paths.length > 0 && !paths.includes(path)) return;
      if (room.blobTombstones.has(path)) return;
      const ref = room.pathToBlob.get(path);
      if (!ref) return;
      const blob = await this.blobStore.get({ vaultId, hash: ref.hash });
      if (!blob) return;
      entries.push({ zipPath: path, buffer: Buffer.from(blob.bytes) });
    };

    for (const [path] of room.pathToId) addMarkdown(path);
    await Promise.all([...room.pathToBlob.keys()].map(addBlob));

    // If specific paths requested, also try blobs for any path not found yet
    // (already handled above via the same paths filter)

    this.streamZip(res, entries, 'vault-export.zip');
  }

  private async handleSnapshotFile(
    res: ServerResponse,
    vaultId: string,
    snapshotId: string,
    docPath: string,
  ): Promise<void> {
    const stored = await this.snapshotStore!.get(vaultId, snapshotId);
    if (!stored) {
      res.writeHead(404);
      res.end();
      return;
    }

    const doc = docFromPayload(stored.payload);

    const markdown = extractMarkdown(doc, docPath);
    if (markdown != null) {
      const bytes = Buffer.from(markdown, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': bytes.length,
      });
      res.end(bytes);
      return;
    }

    if (this.blobStore) {
      const blobRef = extractBlobRef(doc, docPath);
      if (blobRef) {
        const blob = await this.blobStore.get({ vaultId, hash: blobRef.hash });
        if (blob) {
          res.writeHead(200, {
            'Content-Type': blob.contentType ?? 'application/octet-stream',
            'Content-Length': blob.size,
          });
          res.end(Buffer.from(blob.bytes));
          return;
        }
      }
    }

    res.writeHead(404);
    res.end();
  }

  private async handleSnapshotDownload(
    res: ServerResponse,
    vaultId: string,
    snapshotId: string,
  ): Promise<void> {
    const stored = await this.snapshotStore!.get(vaultId, snapshotId);
    if (!stored) {
      res.writeHead(404);
      res.end();
      return;
    }

    const doc = docFromPayload(stored.payload);
    const allFiles = listAllFiles(doc);
    const mtime = zipDate(stored.meta.createdAt);

    type ZipEntry = { zipPath: string; buffer: Buffer; mtime: Date };
    const entries: ZipEntry[] = [];

    for (const f of allFiles) {
      if (f.type === 'markdown') {
        const text = extractMarkdown(doc, f.path);
        if (text != null) {
          entries.push({ zipPath: f.path, buffer: Buffer.from(text, 'utf-8'), mtime });
        }
      } else if (this.blobStore) {
        const blob = await this.blobStore.get({ vaultId, hash: f.hash }).catch(() => null);
        if (blob) {
          entries.push({ zipPath: f.path, buffer: Buffer.from(blob.bytes), mtime });
        } else {
          console.warn(`[FileRouter] snapshot ${snapshotId}: blob missing for ${f.path} (hash ${f.hash})`);
        }
      }
    }

    const dateStr = stored.meta.createdAt.slice(0, 10);
    const filename = `vault-${snapshotId.slice(0, 8)}-${dateStr}.zip`;
    this.streamZip(res, entries, filename);
  }

  private async handleManifest(res: ServerResponse, vaultId: string, snapshotId: string): Promise<void> {
    const stored = await this.snapshotStore!.get(vaultId, snapshotId);
    if (!stored) {
      res.writeHead(404);
      res.end();
      return;
    }

    const doc = docFromPayload(stored.payload);
    const files = listAllFiles(doc);

    sendJson(res, 200, {
      snapshotId: stored.meta.snapshotId,
      createdAt: stored.meta.createdAt,
      files,
    });
  }

  // ── ZIP streaming ─────────────────────────────────────────────────────────

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
