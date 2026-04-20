import * as Y from 'yjs';
import type { SnapshotStore, VaultId, BlobRef } from '@salt-sync/shared';

// ── snapshot payload → 临时 Y.Doc ─────────────────────────────────────────────

/**
 * 将已有的 snapshot payload 反序列化为临时 Y.Doc。
 * 当调用方已持有 payload（如来自 store.get() 的结果）时优先使用此函数以避免重复 S3 请求。
 */
export function docFromPayload(payload: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, payload);
  return doc;
}

/**
 * 从 SnapshotStore 取出指定快照的 payload，反序列化为一个新的临时 Y.Doc 并返回。
 * 调用方负责在使用完毕后让该 doc 被 GC（无需手动 destroy）。
 */
export async function loadSnapshotDoc(
  store: SnapshotStore,
  vaultId: VaultId,
  snapshotId: string,
): Promise<Y.Doc> {
  const stored = await store.get(vaultId, snapshotId);
  if (!stored) {
    throw Object.assign(new Error(`Snapshot not found: ${snapshotId}`), { code: 'NOT_FOUND' });
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, stored.payload);
  return doc;
}

// ── 文件内容提取 ──────────────────────────────────────────────────────────────

/**
 * 从 Y.Doc 中提取指定路径的 Markdown 文本。
 * 通过 `pathToId` 将 docPath 解析为 fileId，再从 `docs` map 取 Y.Text。
 * 若该路径不存在则返回 null。
 */
export function extractMarkdown(doc: Y.Doc, docPath: string): string | null {
  const pathToId = doc.getMap<string>('pathToId');
  const fileId = pathToId.get(docPath);
  if (!fileId) return null;
  const docs = doc.getMap<Y.Text>('docs');
  const text = docs.get(fileId);
  return text != null ? text.toString() : null;
}

/**
 * 从 Y.Doc 的 `pathToBlob` map 中提取指定路径的 BlobRef。
 * 若该路径不存在则返回 null。
 */
export function extractBlobRef(doc: Y.Doc, docPath: string): BlobRef | null {
  const blobTombstones = doc.getMap('blobTombstones');
  if (blobTombstones.has(docPath)) return null;
  const pathToBlob = doc.getMap<BlobRef>('pathToBlob');
  return pathToBlob.get(docPath) ?? null;
}

// ── 全量文件清单 ──────────────────────────────────────────────────────────────

export type FileEntry =
  | { path: string; type: 'markdown'; size: number }
  | { path: string; type: 'blob'; hash: string; size: number; contentType?: string };

/**
 * 遍历 Y.Doc 中的 `pathToId` 和 `pathToBlob` map，返回所有文件的描述列表。
 * markdown 通过 pathToId → fileId → docs(fileId) 取内容；
 * 用于构建快照 manifest 端点的响应体，或 ZIP 导出时枚举所有文件。
 */
export function listAllFiles(doc: Y.Doc): FileEntry[] {
  const entries: FileEntry[] = [];

  const pathToId = doc.getMap<string>('pathToId');
  const docs = doc.getMap<Y.Text>('docs');
  for (const [path, fileId] of pathToId) {
    const text = docs.get(fileId);
    if (!text) continue;
    const content = text.toString();
    entries.push({ path, type: 'markdown', size: Buffer.byteLength(content, 'utf-8') });
  }

  const pathToBlob = doc.getMap<BlobRef>('pathToBlob');
  const blobTombstones = doc.getMap('blobTombstones');
  for (const [path, ref] of pathToBlob) {
    if (blobTombstones.has(path)) continue;
    entries.push({
      path,
      type: 'blob',
      hash: ref.hash,
      size: ref.size,
      contentType: ref.contentType,
    });
  }

  return entries;
}
