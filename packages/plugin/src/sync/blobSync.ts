import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import type { Vault, TFile, TAbstractFile } from 'obsidian';
import { requestUrl } from 'obsidian';
import type { VaultId, BlobHash, BlobRef, BlobTombstone } from '@salt-sync/shared';
import { changedMapKeys, mapChanged } from '../util';
import { BlobHashCache } from './blobHashCache';
import type { BlobRuntimeState } from '../storage/indexedDbStore';
import { isPathIgnoredBySync } from './pathSafety';
import { ensureParentFolders } from './ensureParentFolders';

interface BlobRuntimeStateStore {
  load(vaultId: VaultId): Promise<BlobRuntimeState | null>;
  save(vaultId: VaultId, state: BlobRuntimeState): Promise<void>;
  clear(vaultId: VaultId): Promise<void>;
}

export type BlobApplyGateState = 'startup-blocked' | 'maintenance-blocked' | 'open';

export type PendingBlobItemKind = 'download' | 'upload' | 'remote-delete' | 'local-delete';

export interface PendingBlobItem {
  kind: PendingBlobItemKind;
  path: string;
  hash?: string | null;
  size?: number;
  contentType?: string;
}

type KnownLocalBlob = NonNullable<BlobRuntimeState['knownLocalBlobs']>[number];
type PendingMissingBlob = NonNullable<BlobRuntimeState['pendingMissingBlobs']>[number];
type MissingBlobDecision =
  | { kind: 'confirm-delete'; hash: string; source: 'pending-local-delete' | 'hash-cache' | 'known-local-blob' }
  | { kind: 'candidate'; reason: PendingMissingBlob['reason'] }
  | { kind: 'download'; reason: 'no-evidence' | 'weak-path-only' | 'hash-mismatch' | 'candidate-expired' };

const DEFAULT_MISSING_BLOB_CANDIDATE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_KNOWN_LOCAL_BLOB_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PENDING_LOCAL_DELETION_TTL_MS = 24 * 60 * 60 * 1000;

// ── helpers ───────────────────────────────────────────────────────────────────

function sha256hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function wsUrlToHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//, 'http$1://');
}

function guessContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    wav: 'audio/wav',
  };
  return map[ext] ?? 'application/octet-stream';
}

function isRequestFailedStatus(error: unknown, status: number): boolean {
  return error instanceof Error && error.message.includes(`status ${status}`);
}

function redactBlobPath(path: string): string {
  const parts = path.split('/');
  const name = parts.at(-1) ?? path;
  return parts.length > 1 ? `.../${name}` : name;
}

function redactBlobHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}...` : hash;
}

// ── BlobSync ──────────────────────────────────────────────────────────────────

/**
 * 附件同步：负责非 .md 文件的上传、下载和 tombstone 传播。
 *
 * 路径语义：外部调用者传入 docPath（已去除挂载前缀），
 * 内部通过 toVaultPath 转换为实际 vault 路径再操作磁盘。
 * 主 vault 场景下 toVaultPath 为 identity，两种路径相同。
 *
 * 数据流：
 *   本地新增/修改 → handleLocalBlobChange(docPath) → 计算 SHA-256 → 上传 → 写 pathToBlob
 *   本地删除      → handleLocalBlobDeletion(docPath) → 写 blobTombstones
 *   远端变更      → handleRemoteBlobChanges → 下载缺失附件 / 删除 tombstone 文件
 */
export class BlobSync {
  private readonly httpBase: string;
  private readonly toVaultPath: (docPath: string) => string;
  private readonly hashCache = new BlobHashCache();
  /**
   * 已确认在本设备本地存在过的 blob 路径（持久化到 runtimeState）。
   * 跨会话后 hashCache 为空，此集合让 isMissingLocalBlob 仍能识别出
   * "曾经在本地、但在插件未运行期间被删除"的 blob。
   */
  private readonly knownLocalPaths = new Set<string>();
  private readonly knownLocalBlobs = new Map<string, KnownLocalBlob>();
  private readonly pendingMissingBlobs = new Map<string, PendingMissingBlob>();
  private readonly sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private readonly pathQueues = new Map<string, Promise<void>>();
  private readonly pendingRemoteDownloads = new Map<string, BlobRef>();
  private pendingDownloadsHandlers: Array<() => void> = [];
  private pendingUploadsHandlers: Array<() => void> = [];
  private pendingRemoteDeletesHandlers: Array<() => void> = [];
  private pendingLocalDeletionsHandlers: Array<() => void> = [];
  private readonly pendingRemoteDeletes = new Set<string>();
  private readonly pendingLocalUpserts = new Set<string>();
  private readonly pendingLocalDeletions = new Map<string, string | null>();
  private readonly pendingLocalDeletionFirstSeenAt = new Map<string, string>();
  private readonly candidateExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private gateState: BlobApplyGateState = 'startup-blocked';
  private runtimeStateRestored = false;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    wsUrl: string,
    private readonly vaultId: VaultId,
    private readonly token: string,
    private readonly vault: Vault,
    private readonly ydoc: Y.Doc,
    toVaultPath: (docPath: string) => string = (p) => p,
    private readonly toDocPath: (vaultPath: string) => string = (p) => p,
    private readonly isPathForThisEngine: (vaultPath: string) => boolean = () => true,
    private readonly runtimeStateStore: BlobRuntimeStateStore | null = null,
    private readonly runtimeStateKey: VaultId = vaultId,
    /** 共享目录的本地挂载路径（主 vault 为 undefined）。用于检测路径切换后跳过失效的 knownLocalPaths。 */
    private readonly localPath?: string,
    private readonly isIgnoredPath: (docPath: string) => boolean = (docPath) => isPathIgnoredBySync(docPath),
    /** 设备 ID（可选，用于 tombstone 溯源） */
    private readonly deviceId?: string,
    /** 设备名称（可选，用于 tombstone 溯源） */
    private readonly deviceName?: string,
  ) {
    this.httpBase = wsUrlToHttpUrl(wsUrl);
    this.toVaultPath = toVaultPath;
  }

  // ── Y.Map accessors ───────────────────────────────────────────────────────

  private get pathToBlob(): Y.Map<BlobRef> {
    return this.ydoc.getMap('pathToBlob') as Y.Map<BlobRef>;
  }

  private get blobTombstones(): Y.Map<BlobTombstone> {
    return this.ydoc.getMap('blobTombstones') as Y.Map<BlobTombstone>;
  }

  // ── Local → shared ────────────────────────────────────────────────────────

  /** 本地附件新建或修改时调用（path 为 docPath） */
  async handleLocalBlobChange(path: string): Promise<void> {
    if (this.isIgnoredDocPath(path)) return;
    this.pendingLocalUpserts.add(path);
    this.notifyPendingUploadsChange();
    this.persistRuntimeState();
    await this.enqueuePathOperation(path, () => this.processLocalBlobUpsert(path));
    await this.flushPersistChain();
  }

  /**
   * 本地附件删除时调用。
   *
   * 同步部分：立即登记 pending 并清缓存，确保在 upsert 读完文件但还没写 pathToBlob
   * 的窗口里，后续的 flush/processLocalBlobUpsert 都能看到"这条路径正在删除"。
   * 异步部分：与同路径的 upsert/delete 严格串行，真正写 tombstone。
   */
  async handleLocalBlobDeletion(path: string): Promise<void> {
    if (this.isIgnoredDocPath(path)) return;
    const cachedHash = this.hashCache.peek(path);
    const baselineHash = this.knownLocalBlobs.get(path)?.hash ?? null;
    const knownHash = cachedHash ?? baselineHash;
    this.forgetLocalBlobEvidence(path);

    // 无论 ref 是否在 shared model，都先登记 pending，确保启动窗口期的 delete 不丢。
    this.pendingLocalDeletions.set(path, knownHash);
    if (knownHash != null) {
      this.pendingLocalDeletionFirstSeenAt.set(path, new Date().toISOString());
    }
    this.notifyPendingLocalDeletionsChange();
    this.persistRuntimeState();

    await this.enqueuePathOperation(path, () => this.processLocalBlobDeletion(path));
    await this.flushPersistChain();
  }

  // ── Shared → local ────────────────────────────────────────────────────────

  /**
   * 远端 Y.Doc 事务提交后调用（origin === 'remote'）。
   * 处理 pathToBlob 和 blobTombstones 的变化。
   */
  async handleRemoteBlobChanges(txn: Y.Transaction): Promise<void> {
    // 新增或更新的 blob 引用 → 下载到本地
    const ptbMap = this.pathToBlob;
    if (mapChanged(txn, ptbMap)) {
      for (const path of changedMapKeys(txn, ptbMap)) {
        if (this.isIgnoredDocPath(path)) continue;
        const ref = ptbMap.get(path);
        if (ref) {
          this.pendingRemoteDeletes.delete(path);
          this.notifyPendingRemoteDeletesChange();
          this.pendingRemoteDownloads.set(path, ref);
          this.notifyPendingDownloadsChange();
          this.persistRuntimeState();
        }
      }
    }

    // Tombstone → 删除本地文件
    const tombMap = this.blobTombstones;
    if (mapChanged(txn, tombMap)) {
      for (const path of changedMapKeys(txn, tombMap)) {
        if (this.isIgnoredDocPath(path)) continue;
        if (tombMap.has(path)) {
          const removedPendingDownload = this.pendingRemoteDownloads.delete(path);
          if (removedPendingDownload) {
            this.notifyPendingDownloadsChange();
            this.persistRuntimeState();
          }
          // Tombstones received during the startup gate may be legacy server
          // pollution. Keep them in the shared model but do not queue local
          // delete side effects until future changes arrive after startup.
          if (this.gateState !== 'startup-blocked') {
            this.pendingRemoteDeletes.add(path);
            this.notifyPendingRemoteDeletesChange();
            this.persistRuntimeState();
          }
        }
      }
    }

    if (this.gateState === 'open') {
      await this.flushPendingRemoteChanges();
    }
    await this.flushPersistChain();
  }

  /** restore 等本地流程使用：按当前 pathToBlob 元数据物化到磁盘。 */
  async materializeBlob(docPath: string): Promise<void> {
    if (this.isIgnoredDocPath(docPath)) return;
    const ref = this.pathToBlob.get(docPath);
    if (!ref) return;
    await this.downloadIfMissing(docPath, ref);
  }

  async reconcile(mode: 'authoritative' | 'conservative'): Promise<void> {
    await this.syncLocalAndRemoteBlobs(mode);
  }

  async rescan(mode: 'authoritative' | 'conservative'): Promise<void> {
    await this.syncLocalAndRemoteBlobs(mode);
  }

  /** restore 等本地流程使用：删除某个本地附件。 */
  async deleteLocalBlob(docPath: string): Promise<void> {
    if (this.isIgnoredDocPath(docPath)) return;
    await this.enqueuePathOperation(docPath, async () => {
      await this.deleteLocalFile(docPath);
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.candidateExpiryTimers.values()) {
      clearTimeout(timer);
    }
    this.candidateExpiryTimers.clear();
  }

  enterStartupGate(): void {
    this.gateState = 'startup-blocked';
  }

  enterMaintenanceGate(): void {
    this.gateState = 'maintenance-blocked';
  }

  async openRemoteApplyGate(): Promise<void> {
    this.gateState = 'open';
    // 本地删除先于远端 apply 落地，避免远端 pathToBlob 到达时把刚删除的 blob 拉回来。
    this.flushPendingLocalDeletions();
    await this.flushPendingLocalUpserts();
    this.queueExistingRemoteTombstones();
    await this.flushPendingRemoteChanges();
    await this.flushPersistChain();
  }

  getRemoteApplyGateState(): BlobApplyGateState {
    return this.gateState;
  }

  get pendingDownloadCount(): number {
    return this.pendingRemoteDownloads.size;
  }

  get pendingUploadCount(): number {
    return this.pendingLocalUpserts.size;
  }

  get pendingRemoteDeleteCount(): number {
    return this.pendingRemoteDeletes.size;
  }

  get pendingLocalDeletionCount(): number {
    return this.pendingLocalDeletions.size;
  }

  getPendingBlobItems(): PendingBlobItem[] {
    return [
      ...[...this.pendingRemoteDownloads].map(([path, ref]) => ({
        kind: 'download' as const,
        path,
        hash: ref.hash,
        size: ref.size,
        contentType: ref.contentType,
      })),
      ...[...this.pendingLocalUpserts].map((path) => ({ kind: 'upload' as const, path })),
      ...[...this.pendingRemoteDeletes].map((path) => {
        const tombstone = this.blobTombstones.get(path);
        return { kind: 'remote-delete' as const, path, hash: tombstone?.hash };
      }),
      ...[...this.pendingLocalDeletions].map(([path, hash]) => ({ kind: 'local-delete' as const, path, hash })),
    ].filter((item) => !this.isIgnoredDocPath(item.path));
  }

  onPendingDownloadsChange(handler: () => void): () => void {
    this.pendingDownloadsHandlers.push(handler);
    return () => {
      const idx = this.pendingDownloadsHandlers.indexOf(handler);
      if (idx !== -1) this.pendingDownloadsHandlers.splice(idx, 1);
    };
  }

  onPendingUploadsChange(handler: () => void): () => void {
    this.pendingUploadsHandlers.push(handler);
    return () => {
      const idx = this.pendingUploadsHandlers.indexOf(handler);
      if (idx !== -1) this.pendingUploadsHandlers.splice(idx, 1);
    };
  }

  onPendingRemoteDeletesChange(handler: () => void): () => void {
    this.pendingRemoteDeletesHandlers.push(handler);
    return () => {
      const idx = this.pendingRemoteDeletesHandlers.indexOf(handler);
      if (idx !== -1) this.pendingRemoteDeletesHandlers.splice(idx, 1);
    };
  }

  onPendingLocalDeletionsChange(handler: () => void): () => void {
    this.pendingLocalDeletionsHandlers.push(handler);
    return () => {
      const idx = this.pendingLocalDeletionsHandlers.indexOf(handler);
      if (idx !== -1) this.pendingLocalDeletionsHandlers.splice(idx, 1);
    };
  }

  private notifyPendingDownloadsChange(): void {
    for (const handler of this.pendingDownloadsHandlers) {
      handler();
    }
  }

  private notifyPendingUploadsChange(): void {
    for (const handler of this.pendingUploadsHandlers) {
      handler();
    }
  }

  private notifyPendingRemoteDeletesChange(): void {
    for (const handler of this.pendingRemoteDeletesHandlers) {
      handler();
    }
  }

  private notifyPendingLocalDeletionsChange(): void {
    for (const handler of this.pendingLocalDeletionsHandlers) {
      handler();
    }
  }

  async restoreRuntimeState(): Promise<void> {
    if (!this.runtimeStateStore) return;
    if (this.runtimeStateRestored) return;
    this.runtimeStateRestored = true;
    const restored = await this.runtimeStateStore.load(this.runtimeStateKey);
    if (this.stopped) return;
    if (!restored) return;

    // 主 vault（两端均为 undefined）视为路径匹配，保持原有行为。
    const localPathMatches = restored.localPath === this.localPath;

    // 合并而非替换：注册 ydoc 监听和 restoreRuntimeState 之间可能已有新的 pending 写入，
    // 这里只补还 IDB 中尚未进入内存的条目，避免覆盖启动窗口期新产生的 pending。
    for (const item of restored.pendingRemoteDownloads) {
      if (this.isIgnoredDocPath(item.docPath)) continue;
      if (this.pendingRemoteDownloads.has(item.docPath)) continue;
      const ref = this.pathToBlob.get(item.docPath);
      if (ref && ref.hash === item.hash) {
        this.pendingRemoteDownloads.set(item.docPath, ref);
        this.notifyPendingDownloadsChange();
      }
    }

    for (const docPath of restored.pendingRemoteDeletes) {
      if (this.isIgnoredDocPath(docPath)) continue;
      if (this.pendingRemoteDeletes.has(docPath)) continue;
      if (this.blobTombstones.has(docPath)) {
        this.pendingRemoteDeletes.add(docPath);
      }
    }
    this.notifyPendingRemoteDeletesChange();

    for (const docPath of restored.pendingLocalUpserts) {
      if (this.isIgnoredDocPath(docPath)) continue;
      if (this.pendingLocalUpserts.has(docPath)) continue;
      if (this.vault.getAbstractFileByPath(this.toVaultPath(docPath))) {
        this.pendingLocalUpserts.add(docPath);
      }
    }
    this.notifyPendingUploadsChange();

    if (localPathMatches) {
      for (const item of restored.pendingLocalDeletions ?? []) {
        if (this.isIgnoredDocPath(item.docPath)) continue;
        if (this.pendingLocalDeletions.has(item.docPath)) continue;
        // 文件又出现了说明用户撤销了删除，放弃这条 pending。
        if (this.vault.getAbstractFileByPath(this.toVaultPath(item.docPath))) continue;
        // 远端已经有 tombstone → 同路径 LWW 已生效，跳过。
        if (this.blobTombstones.has(item.docPath)) continue;
        this.pendingLocalDeletions.set(item.docPath, item.hash);
        this.pendingLocalDeletionFirstSeenAt.set(item.docPath, item.firstSeenAt ?? new Date().toISOString());
      }
    }
    this.notifyPendingLocalDeletionsChange();

    // 若 localPath 与上次保存时不同（挂载路径已切换），上次记录的 knownLocalPaths
    // 是针对旧路径的，不能用于新路径的"缺失即删除"判断，直接跳过。
    if (localPathMatches) {
      for (const item of restored.knownLocalBlobs ?? []) {
        if (this.isIgnoredDocPath(item.docPath)) continue;
        if (this.blobTombstones.has(item.docPath)) continue;
        if (!this.persistedLocalPathMatches(item.localPath)) continue;
        this.knownLocalBlobs.set(item.docPath, item);
      }
      for (const item of restored.pendingMissingBlobs ?? []) {
        if (this.isIgnoredDocPath(item.docPath)) continue;
        if (this.blobTombstones.has(item.docPath)) continue;
        if (!this.persistedLocalPathMatches(item.localPath)) continue;
        const ref = this.pathToBlob.get(item.docPath);
        if (!ref || ref.hash !== item.remoteHashAtCreation) continue;
        if (this.vault.getAbstractFileByPath(this.toVaultPath(item.docPath))) continue;
        this.pendingMissingBlobs.set(item.docPath, item);
        this.scheduleMissingBlobCandidateExpiry(item);
      }
      for (const path of restored.knownLocalPaths ?? []) {
        if (this.isIgnoredDocPath(path)) continue;
        if (this.knownLocalPaths.has(path)) continue;
        // 已有 tombstone 说明删除已确认，无需再跟踪。
        if (this.blobTombstones.has(path)) continue;
        this.knownLocalPaths.add(path);
      }
    }

    this.persistRuntimeState();
    await this.flushPersistChain();
  }

  // ── private ───────────────────────────────────────────────────────────────

  private isIgnoredDocPath(docPath: string): boolean {
    return this.isIgnoredPath(docPath) || isPathIgnoredBySync(docPath) || isPathIgnoredBySync(this.toVaultPath(docPath));
  }

  private rememberLocalBlob(docPath: string, hash: BlobHash, file?: TFile, size?: number): void {
    this.knownLocalPaths.add(docPath);
    this.knownLocalBlobs.set(docPath, {
      docPath,
      hash,
      lastSeenAt: new Date().toISOString(),
      localPath: this.localPath,
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      size: size ?? file?.stat.size,
      mtime: file?.stat.mtime,
    });
    if (this.pendingMissingBlobs.delete(docPath)) {
      this.clearMissingBlobCandidateTimer(docPath);
    }
  }

  private forgetLocalBlobEvidence(docPath: string): void {
    this.hashCache.delete(docPath);
    this.knownLocalPaths.delete(docPath);
    this.knownLocalBlobs.delete(docPath);
    if (this.pendingMissingBlobs.delete(docPath)) {
      this.clearMissingBlobCandidateTimer(docPath);
    }
    this.clearMissingBlobCandidateTimer(docPath);
  }

  private deletePendingLocalDeletion(docPath: string): boolean {
    const removed = this.pendingLocalDeletions.delete(docPath);
    this.pendingLocalDeletionFirstSeenAt.delete(docPath);
    return removed;
  }

  private persistedLocalPathMatches(itemLocalPath: string | undefined): boolean {
    return itemLocalPath === undefined ? this.localPath === undefined : itemLocalPath === this.localPath;
  }

  private candidateExpired(candidate: PendingMissingBlob, now = Date.now()): boolean {
    const firstSeenAt = Date.parse(candidate.firstSeenAt);
    if (!Number.isFinite(firstSeenAt)) return true;
    return now - firstSeenAt >= DEFAULT_MISSING_BLOB_CANDIDATE_TTL_MS;
  }

  private knownLocalBlobExpired(item: KnownLocalBlob, now = Date.now()): boolean {
    const lastSeenAt = Date.parse(item.lastSeenAt);
    if (!Number.isFinite(lastSeenAt)) return true;
    return now - lastSeenAt >= DEFAULT_KNOWN_LOCAL_BLOB_TTL_MS;
  }

  private pendingLocalDeletionExpired(docPath: string, now = Date.now()): boolean {
    const firstSeenAt = Date.parse(this.pendingLocalDeletionFirstSeenAt.get(docPath) ?? '');
    if (!Number.isFinite(firstSeenAt)) return false;
    return now - firstSeenAt >= DEFAULT_PENDING_LOCAL_DELETION_TTL_MS;
  }

  private classifyMissingRemoteBlob(docPath: string, ref: BlobRef, mode: 'authoritative' | 'conservative'): MissingBlobDecision {
    if (mode !== 'authoritative') {
      const candidate = this.pendingMissingBlobs.get(docPath);
      if (candidate?.remoteHashAtCreation === ref.hash && this.candidateExpired(candidate)) {
        return { kind: 'download', reason: 'candidate-expired' };
      }
      if (this.pendingLocalDeletions.has(docPath) || this.hashCache.peek(docPath) != null || this.knownLocalBlobs.has(docPath)) {
        return { kind: 'candidate', reason: 'weak-evidence' };
      }
      return this.knownLocalPaths.has(docPath)
        ? { kind: 'download', reason: 'weak-path-only' }
        : { kind: 'download', reason: 'no-evidence' };
    }

    const pendingHash = this.pendingLocalDeletions.get(docPath);
    if (pendingHash != null) {
      return pendingHash === ref.hash
        ? { kind: 'confirm-delete', hash: pendingHash, source: 'pending-local-delete' }
        : { kind: 'download', reason: 'hash-mismatch' };
    }
    if (this.pendingLocalDeletions.has(docPath)) {
      const candidate = this.pendingMissingBlobs.get(docPath);
      if (candidate?.remoteHashAtCreation === ref.hash) {
        return this.candidateExpired(candidate)
          ? { kind: 'download', reason: 'candidate-expired' }
          : { kind: 'candidate', reason: candidate.reason };
      }
      return { kind: 'candidate', reason: 'pending-null-hash' };
    }

    const cachedHash = this.hashCache.peek(docPath);
    if (cachedHash != null) {
      return cachedHash === ref.hash
        ? { kind: 'confirm-delete', hash: cachedHash, source: 'hash-cache' }
        : { kind: 'download', reason: 'hash-mismatch' };
    }

    const baseline = this.knownLocalBlobs.get(docPath);
    if (baseline) {
      if (this.knownLocalBlobExpired(baseline)) {
        return baseline.hash === ref.hash
          ? { kind: 'candidate', reason: 'stale-baseline' }
          : { kind: 'download', reason: 'hash-mismatch' };
      }
      return baseline.hash === ref.hash
        ? { kind: 'confirm-delete', hash: baseline.hash, source: 'known-local-blob' }
        : { kind: 'download', reason: 'hash-mismatch' };
    }

    if (this.knownLocalPaths.has(docPath)) {
      return { kind: 'download', reason: 'weak-path-only' };
    }
    return { kind: 'download', reason: 'no-evidence' };
  }

  private trackMissingBlobCandidate(docPath: string, ref: BlobRef, reason: PendingMissingBlob['reason']): void {
    const existing = this.pendingMissingBlobs.get(docPath);
    if (existing?.remoteHashAtCreation === ref.hash && existing.reason === reason) return;
    this.pendingMissingBlobs.set(docPath, {
      docPath,
      remoteHashAtCreation: ref.hash,
      firstSeenAt: new Date().toISOString(),
      reason,
      localPath: this.localPath,
    });
    this.scheduleMissingBlobCandidateExpiry(this.pendingMissingBlobs.get(docPath)!);
    console.info(`[BlobSync] quarantined missing blob candidate path=${redactBlobPath(docPath)} hash=${redactBlobHash(ref.hash)} reason=${reason}`);
    this.persistRuntimeState();
  }

  private clearMissingBlobCandidate(docPath: string, reason: string): void {
    if (!this.pendingMissingBlobs.delete(docPath)) return;
    this.clearMissingBlobCandidateTimer(docPath);
    console.info(`[BlobSync] cleared missing blob candidate path=${redactBlobPath(docPath)} reason=${reason}`);
    this.persistRuntimeState();
  }

  private clearMissingBlobCandidateTimer(docPath: string): void {
    const timer = this.candidateExpiryTimers.get(docPath);
    if (!timer) return;
    clearTimeout(timer);
    this.candidateExpiryTimers.delete(docPath);
  }

  private scheduleMissingBlobCandidateExpiry(candidate: PendingMissingBlob): void {
    if (this.stopped) return;
    this.clearMissingBlobCandidateTimer(candidate.docPath);
    const firstSeenAt = Date.parse(candidate.firstSeenAt);
    const elapsed = Number.isFinite(firstSeenAt) ? Date.now() - firstSeenAt : DEFAULT_MISSING_BLOB_CANDIDATE_TTL_MS;
    const delay = Math.max(0, DEFAULT_MISSING_BLOB_CANDIDATE_TTL_MS - elapsed);
    const timer = setTimeout(() => {
      this.candidateExpiryTimers.delete(candidate.docPath);
      if (this.stopped) return;
      void this.resolveExpiredMissingBlobCandidate(candidate.docPath);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.candidateExpiryTimers.set(candidate.docPath, timer);
  }

  private async resolveExpiredMissingBlobCandidate(docPath: string): Promise<void> {
    if (this.stopped) return;
    const candidate = this.pendingMissingBlobs.get(docPath);
    if (!candidate) return;
    if (!this.candidateExpired(candidate)) {
      this.scheduleMissingBlobCandidateExpiry(candidate);
      return;
    }
    const ref = this.pathToBlob.get(docPath);
    if (!ref || ref.hash !== candidate.remoteHashAtCreation || this.blobTombstones.has(docPath)) {
      this.clearMissingBlobCandidate(docPath, 'candidate-invalidated');
      return;
    }
    if (this.vault.getAbstractFileByPath(this.toVaultPath(docPath))) {
      this.clearMissingBlobCandidate(docPath, 'local-reappeared');
      return;
    }
    let downloaded = false;
    let pendingDownloadRemoved = false;
    try {
      await this.enqueuePathOperation(docPath, async () => {
        if (this.stopped) return;
        const currentRef = this.pathToBlob.get(docPath);
        if (!currentRef || currentRef.hash !== ref.hash || this.blobTombstones.has(docPath)) {
          if (this.deletePendingLocalDeletion(docPath)) {
            this.notifyPendingLocalDeletionsChange();
          }
          this.clearMissingBlobCandidate(docPath, 'candidate-invalidated');
          return;
        }
        if (this.vault.getAbstractFileByPath(this.toVaultPath(docPath))) {
          if (this.deletePendingLocalDeletion(docPath)) {
            this.notifyPendingLocalDeletionsChange();
          }
          this.clearMissingBlobCandidate(docPath, 'local-reappeared');
          return;
        }
        if (this.pendingRemoteDownloads.get(docPath)?.hash === currentRef.hash) {
          this.pendingRemoteDownloads.delete(docPath);
          this.notifyPendingDownloadsChange();
          pendingDownloadRemoved = true;
        }
        await this.downloadIfMissing(docPath, currentRef);
        downloaded = true;
      });
    } catch (err) {
      if (pendingDownloadRemoved && this.pathToBlob.get(docPath)?.hash === ref.hash && !this.blobTombstones.has(docPath)) {
        this.pendingRemoteDownloads.set(docPath, ref);
        this.notifyPendingDownloadsChange();
      }
      console.error('[BlobSync] expired missing blob candidate download failed:', err);
      this.persistRuntimeState();
      await this.flushPersistChain();
      return;
    }
    if (downloaded && this.deletePendingLocalDeletion(docPath)) {
      this.notifyPendingLocalDeletionsChange();
    }
    if (downloaded) {
      this.clearMissingBlobCandidate(docPath, 'candidate-expired');
    }
    this.persistRuntimeState();
    await this.flushPersistChain();
  }

  private writeLocalBlobTombstone(docPath: string, hash: string): void {
    const ref = this.pathToBlob.get(docPath);
    if (!ref || ref.hash !== hash) return;
    this.ydoc.transact(() => {
      this.pathToBlob.delete(docPath);
      this.blobTombstones.set(docPath, {
        hash,
        deletedAt: new Date().toISOString(),
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        vaultId: this.vaultId,
        deleteSource: 'local-delete',
      });
    }, 'local-blob');
    this.deletePendingLocalDeletion(docPath);
    this.knownLocalPaths.delete(docPath);
    this.knownLocalBlobs.delete(docPath);
    if (this.pendingMissingBlobs.delete(docPath)) {
      this.clearMissingBlobCandidateTimer(docPath);
    }
  }

  private async uploadIfNeeded(
    hash: BlobHash,
    arrayBuffer: ArrayBuffer,
    contentType: string,
  ): Promise<void> {
    // Batch-check existence (single hash case)
    const resp = await requestUrl({
      url: `${this.httpBase}/vault/${this.vaultId}/blobs/exists`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hashes: [hash] }),
    });
    const { existing } = resp.json as { existing: BlobHash[] };
    if (existing.includes(hash)) return;

    await requestUrl({
      url: `${this.httpBase}/vault/${this.vaultId}/blobs/${hash}`,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': contentType,
      },
      body: arrayBuffer,
    });
  }

  private async downloadIfMissing(docPath: string, ref: BlobRef): Promise<void> {
    const vaultPath = this.toVaultPath(docPath);
    const existing = this.vault.getAbstractFileByPath(vaultPath) as TAbstractFile | null;

    // 文件已存在时检查 hash 是否一致，一致则跳过
    if (existing && 'stat' in existing) {
      const actualHash = await this.getLocalBlobHash(docPath, existing as TFile);
      if (actualHash === ref.hash) return;
    }

    let resp;
    try {
      resp = await requestUrl({
        url: `${this.httpBase}/vault/${this.vaultId}/blobs/${ref.hash}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (error) {
      if (isRequestFailedStatus(error, 404)) {
        throw new Error(
          `blob object missing for ${docPath} (hash=${ref.hash}, vault=${this.vaultId}); server metadata points to a non-existent blob`,
          { cause: error },
        );
      }
      throw error;
    }

    const bytes = resp.arrayBuffer;
    const actualHash = sha256hex(new Uint8Array(bytes));
    if (actualHash !== ref.hash) {
      throw new Error(`downloaded blob hash mismatch for ${docPath}: expected ${ref.hash}, got ${actualHash}`);
    }

    if (existing && 'stat' in existing) {
      await this.vault.modifyBinary(existing as TFile, bytes);
    } else {
      await ensureParentFolders(this.vault, vaultPath);
      await this.vault.createBinary(vaultPath, bytes);
    }
    const file = this.vault.getFileByPath(vaultPath);
    if (file) {
      this.hashCache.set(docPath, file.stat.mtime, file.stat.size, ref.hash);
      this.rememberLocalBlob(docPath, ref.hash, file, ref.size);
      this.persistRuntimeState();
    }
  }

  private async deleteLocalFile(docPath: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(this.toVaultPath(docPath));
    if (!file || !('stat' in file)) return;
    this.forgetLocalBlobEvidence(docPath);
    await this.vault.delete(file);
  }

  private listLocalBlobFiles(): TFile[] {
    return this.vault.getFiles().filter((file) => this.isPathForThisEngine(file.path) && !this.isIgnoredDocPath(this.toDocPath(file.path)) && !file.path.endsWith('.md'));
  }

  private async readLocalBlobSnapshot(docPath: string): Promise<{
    arrayBuffer: ArrayBuffer;
    hash: BlobHash;
    contentType: string;
    size: number;
  } | null> {
    const file = this.vault.getAbstractFileByPath(this.toVaultPath(docPath)) as TFile | null;
    if (!file || !('stat' in file)) return null;

    const arrayBuffer = await this.vault.readBinary(file);
    const cachedHash = this.hashCache.get(docPath, file.stat.mtime, file.stat.size);
    const hash = cachedHash ?? sha256hex(new Uint8Array(arrayBuffer));
    if (!cachedHash) {
      this.hashCache.set(docPath, file.stat.mtime, file.stat.size, hash);
    }

    return {
      arrayBuffer,
      hash,
      contentType: guessContentType(docPath),
      size: arrayBuffer.byteLength,
    };
  }

  private async getLocalBlobHash(docPath: string, file: TFile): Promise<BlobHash> {
    const cachedHash = this.hashCache.get(docPath, file.stat.mtime, file.stat.size);
    if (cachedHash) return cachedHash;
    const arrayBuffer = await this.vault.readBinary(file);
    const hash = sha256hex(new Uint8Array(arrayBuffer));
    this.hashCache.set(docPath, file.stat.mtime, file.stat.size, hash);
    return hash;
  }

  private async syncLocalAndRemoteBlobs(mode: 'authoritative' | 'conservative'): Promise<void> {
    // 入口先 flush pending deletions：上一会话崩溃、或启动窗口期用户删除但 ref 刚到，
    // 此时 pendingLocalDeletions 已有条目但 tombstone 还没写入；若直接进 loop，
    // 第二 loop 会把"pathToBlob 有 ref、本地无文件、tombstone 空"的路径误判成待下载，
    // 把用户删除的附件拉回磁盘。先 flush 一次，把有 hash 线索的 pending 全部转成 tombstone。
    this.flushPendingLocalDeletions();

    const localFiles = this.listLocalBlobFiles();
    const localSet = new Set<string>();
    let knownLocalPathsChanged = false;

    for (const file of localFiles) {
      const docPath = this.toDocPath(file.path);
      localSet.add(docPath);

      const ref = this.pathToBlob.get(docPath);
      if (!ref) {
        if (mode === 'authoritative') {
          await this.handleLocalBlobChange(docPath);
        }
        continue;
      }

      const localHash = await this.getLocalBlobHash(docPath, file);
      const before = this.knownLocalBlobs.get(docPath);
      const hadKnownLocalPath = this.knownLocalPaths.has(docPath);
      this.rememberLocalBlob(docPath, localHash, file, file.stat.size);
      const after = this.knownLocalBlobs.get(docPath);
      if (before?.hash !== localHash || before?.lastSeenAt !== after?.lastSeenAt || !hadKnownLocalPath) knownLocalPathsChanged = true;
      if (this.blobTombstones.has(docPath) && mode === 'authoritative') {
        if (this.pendingRemoteDeletes.has(docPath)) continue;
        await this.handleLocalBlobChange(docPath);
        continue;
      }
      if (ref.hash !== localHash && mode === 'authoritative') {
        await this.handleLocalBlobChange(docPath);
      }
    }

    for (const [docPath, ref] of this.pathToBlob) {
      if (this.isIgnoredDocPath(docPath)) continue;
      if (localSet.has(docPath)) continue;
      // Phase 10：tombstone 优先。pathToBlob 与 blobTombstones 可能同 key 并存（跨设备 LWW），
      // 此时必须以 tombstone 为准，不触发下载。
      if (this.blobTombstones.has(docPath)) continue;
      // 仍在 pending 中（例如 hash 未知、flushPendingLocalDeletions 保留）的删除意图
      // 同样不能下载；等 hash 线索到齐后由后续 flush 转成 tombstone。
      const decision = this.classifyMissingRemoteBlob(docPath, ref, mode);
      if (decision.kind === 'confirm-delete') {
        this.writeLocalBlobTombstone(docPath, decision.hash);
        this.notifyPendingLocalDeletionsChange();
        this.persistRuntimeState();
        continue;
      }
      if (decision.kind === 'candidate') {
        this.trackMissingBlobCandidate(docPath, ref, decision.reason);
        continue;
      }
      if (this.deletePendingLocalDeletion(docPath)) {
        this.notifyPendingLocalDeletionsChange();
        this.persistRuntimeState();
      }
      this.clearMissingBlobCandidate(docPath, decision.reason);
      await this.downloadIfMissing(docPath, ref);
    }

    if (knownLocalPathsChanged) {
      this.persistRuntimeState();
    }
    this.discardUnresolvableLocalDeletions();
  }

  private async flushPendingRemoteChanges(): Promise<void> {
    // 新到达的 pathToBlob 可能含有 pending local deletion 需要的 hash，
    // 先给它们一次 tombstone 机会，避免随后把删除的文件重新下载回来。
    this.flushPendingLocalDeletions();

    const errors: unknown[] = [];

    for (const docPath of [...this.pendingRemoteDeletes]) {
      if (this.isIgnoredDocPath(docPath)) {
        this.pendingRemoteDeletes.delete(docPath);
        this.notifyPendingRemoteDeletesChange();
        continue;
      }
      this.pendingRemoteDeletes.delete(docPath);
      this.notifyPendingRemoteDeletesChange();
      await this.enqueuePathOperation(docPath, async () => {
        if (!this.blobTombstones.has(docPath)) return;
        await this.deleteLocalFile(docPath);
      }).catch((err) => errors.push(err));
    }

    for (const [docPath, ref] of [...this.pendingRemoteDownloads]) {
      if (this.isIgnoredDocPath(docPath)) {
        this.pendingRemoteDownloads.delete(docPath);
        this.notifyPendingDownloadsChange();
        continue;
      }
      this.pendingRemoteDownloads.delete(docPath);
      this.notifyPendingDownloadsChange();
      await this.enqueuePathOperation(docPath, async () => {
        const currentRef = this.pathToBlob.get(docPath);
        if (!currentRef || currentRef.hash !== ref.hash) return;
        if (this.blobTombstones.has(docPath)) return;
        if (!this.vault.getAbstractFileByPath(this.toVaultPath(docPath))) {
          const decision = this.classifyMissingRemoteBlob(docPath, currentRef, 'authoritative');
          if (decision.kind === 'confirm-delete') {
            this.writeLocalBlobTombstone(docPath, decision.hash);
            this.notifyPendingLocalDeletionsChange();
            this.persistRuntimeState();
            return;
          }
          if (decision.kind === 'candidate') {
            this.trackMissingBlobCandidate(docPath, currentRef, decision.reason);
            this.pendingRemoteDownloads.set(docPath, currentRef);
            this.notifyPendingDownloadsChange();
            return;
          }
          if (this.deletePendingLocalDeletion(docPath)) {
            this.notifyPendingLocalDeletionsChange();
            this.persistRuntimeState();
          }
          this.clearMissingBlobCandidate(docPath, decision.reason);
        }
        await this.downloadIfMissing(docPath, ref);
      }).catch((err) => errors.push(err));
    }

    for (const err of errors) {
      console.error('[BlobSync] remote change error:', err);
    }
    this.persistRuntimeState();
  }

  private queueExistingRemoteTombstones(): void {
    let changed = false;
    for (const docPath of this.blobTombstones.keys()) {
      if (this.isIgnoredDocPath(docPath)) continue;
      if (this.pendingRemoteDeletes.has(docPath)) continue;
      this.pendingRemoteDeletes.add(docPath);
      changed = true;
    }
    if (changed) {
      this.notifyPendingRemoteDeletesChange();
      this.persistRuntimeState();
    }
  }

  private flushPendingLocalDeletions(): void {
    if (this.pendingLocalDeletions.size === 0) return;
    let mutated = false;
    const candidates: Array<{ docPath: string; ref: BlobRef; reason: PendingMissingBlob['reason'] }> = [];
    this.ydoc.transact(() => {
      for (const [docPath, knownHash] of [...this.pendingLocalDeletions]) {
        if (this.isIgnoredDocPath(docPath)) {
          this.deletePendingLocalDeletion(docPath);
          mutated = true;
          continue;
        }
        // 本地文件又出现了 → 用户可能撤销删除，让随后的 upsert/rescan 处理。
        if (this.vault.getAbstractFileByPath(this.toVaultPath(docPath))) {
          this.deletePendingLocalDeletion(docPath);
          mutated = true;
          continue;
        }
        if (this.blobTombstones.has(docPath)) {
          // 远端已墓碑，幂等移出 pending。
          this.deletePendingLocalDeletion(docPath);
          mutated = true;
          continue;
        }
        const ref = this.pathToBlob.get(docPath);
        if (!ref) {
          // 没有 current remote ref 时不能新建 tombstone，保留证据等待匹配 ref 或后续安全过期。
          continue;
        }
        if (knownHash == null) {
          candidates.push({ docPath, ref, reason: 'pending-null-hash' });
          continue;
        }
        if (knownHash !== ref.hash) {
          this.deletePendingLocalDeletion(docPath);
          this.pendingMissingBlobs.delete(docPath);
          mutated = true;
          continue;
        }
        this.pathToBlob.delete(docPath);
        this.blobTombstones.set(docPath, {
          hash: knownHash,
          deletedAt: new Date().toISOString(),
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          vaultId: this.vaultId,
          deleteSource: 'local-delete',
        });
        this.deletePendingLocalDeletion(docPath);
        this.knownLocalPaths.delete(docPath);
        this.knownLocalBlobs.delete(docPath);
        this.pendingMissingBlobs.delete(docPath);
        mutated = true;
      }
    }, 'local-blob');
    for (const { docPath, ref, reason } of candidates) {
      this.trackMissingBlobCandidate(docPath, ref, reason);
    }
    if (mutated) {
      this.notifyPendingLocalDeletionsChange();
      this.persistRuntimeState();
    }
  }

  private discardUnresolvableLocalDeletions(): void {
    let changed = false;
    for (const [docPath, knownHash] of [...this.pendingLocalDeletions]) {
      if (this.pathToBlob.has(docPath)) continue;
      if (this.blobTombstones.has(docPath)) continue;
      if (this.vault.getAbstractFileByPath(this.toVaultPath(docPath))) continue;
      if (knownHash && !this.pendingLocalDeletionExpired(docPath)) continue;
      this.deletePendingLocalDeletion(docPath);
      this.knownLocalPaths.delete(docPath);
      changed = true;
    }
    if (changed) {
      this.notifyPendingLocalDeletionsChange();
      this.persistRuntimeState();
    }
  }

  private async flushPendingLocalUpserts(): Promise<void> {
    const errors: unknown[] = [];
    for (const docPath of [...this.pendingLocalUpserts]) {
      if (this.isIgnoredDocPath(docPath)) {
        this.pendingLocalUpserts.delete(docPath);
        this.notifyPendingUploadsChange();
        continue;
      }
      await this.enqueuePathOperation(docPath, () => this.processLocalBlobUpsert(docPath)).catch((err) => {
        // 单条 upsert 失败不阻断后续；pendingLocalUpserts 里它仍在，下次 flush 会重试。
        errors.push(err);
      });
    }
    for (const err of errors) {
      console.error('[BlobSync] pending local upsert error:', err);
    }
    this.persistRuntimeState();
  }

  private enqueuePathOperation(docPath: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.pathQueues.get(docPath) ?? Promise.resolve();
    const current = previous.then(operation);
    const tracked = current.catch(() => {});
    this.pathQueues.set(docPath, tracked);
    return current.finally(() => {
      if (this.pathQueues.get(docPath) === tracked) {
        this.pathQueues.delete(docPath);
      }
    });
  }

  private async processLocalBlobUpsert(path: string): Promise<void> {
    let completed = false;
    try {
      const snapshot = await this.readLocalBlobSnapshot(path);
      if (!snapshot) {
        completed = true;
        return;
      }

      const { arrayBuffer, hash, contentType, size } = snapshot;

      const existingRef = this.pathToBlob.get(path);
      if (existingRef?.hash === hash) {
        const file = this.vault.getFileByPath(this.toVaultPath(path)) ?? undefined;
        this.rememberLocalBlob(path, hash, file, size);
        if (this.blobTombstones.has(path)) {
          if (this.pendingRemoteDeletes.has(path)) {
            completed = true;
            return;
          }
          this.ydoc.transact(() => {
            this.blobTombstones.delete(path);
          }, 'local-blob');
        }
        completed = true;
        return;
      }

      await this.uploadIfNeeded(hash, arrayBuffer, contentType);

      // 上传期间文件可能已被删除；再次确认本地状态，避免把刚被删除的 blob 复活
      // （或把 tombstone 清掉）。Phase 9 Issue A 的第二道防线。
      if (!this.vault.getAbstractFileByPath(this.toVaultPath(path))) {
        completed = true;
        return;
      }

      if (this.blobTombstones.has(path) && this.pendingRemoteDeletes.has(path)) {
        completed = true;
        return;
      }

      this.ydoc.transact(() => {
        this.pathToBlob.set(path, {
          hash,
          size,
          contentType,
          updatedAt: new Date().toISOString(),
        });
        if (this.blobTombstones.has(path)) {
          this.blobTombstones.delete(path);
        }
      }, 'local-blob');
      const file = this.vault.getFileByPath(this.toVaultPath(path)) ?? undefined;
      this.rememberLocalBlob(path, hash, file, size);
      completed = true;
    } finally {
      if (completed) {
        this.pendingLocalUpserts.delete(path);
        this.notifyPendingUploadsChange();
      }
      this.persistRuntimeState();
    }
  }

  private processLocalBlobDeletion(path: string): Promise<void> {
    // 文件又出现了 → 放弃这条 deletion，交给后续的 upsert/rescan 处理。
    if (this.vault.getAbstractFileByPath(this.toVaultPath(path))) {
      if (this.deletePendingLocalDeletion(path)) {
        this.notifyPendingLocalDeletionsChange();
        this.persistRuntimeState();
      }
      return Promise.resolve();
    }

    // 已有 tombstone（LWW 已生效或被并发写入）→ 幂等退出。
    if (this.blobTombstones.has(path)) {
      if (this.deletePendingLocalDeletion(path)) {
        this.notifyPendingLocalDeletionsChange();
        this.persistRuntimeState();
      }
      return Promise.resolve();
    }

    const ref = this.pathToBlob.get(path);
    const pendingHash = this.pendingLocalDeletions.get(path) ?? null;
    if (!ref) {
      // 没有 current remote ref 时不能新建 tombstone，保留 pending 供后续匹配 ref 或安全过期。
      return Promise.resolve();
    }
    if (pendingHash == null) {
      this.trackMissingBlobCandidate(path, ref, 'pending-null-hash');
      return Promise.resolve();
    }
    if (pendingHash !== ref.hash) {
      this.deletePendingLocalDeletion(path);
      this.notifyPendingLocalDeletionsChange();
      this.clearMissingBlobCandidate(path, 'remote-hash-mismatch');
      this.persistRuntimeState();
      return Promise.resolve();
    }

    this.ydoc.transact(() => {
      this.pathToBlob.delete(path);
      this.blobTombstones.set(path, {
        hash: pendingHash,
        deletedAt: new Date().toISOString(),
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        vaultId: this.vaultId,
        deleteSource: 'local-delete',
      });
    }, 'local-blob');
    this.deletePendingLocalDeletion(path);
    this.notifyPendingLocalDeletionsChange();
    this.knownLocalPaths.delete(path);
    this.knownLocalBlobs.delete(path);
    this.pendingMissingBlobs.delete(path);
    this.persistRuntimeState();
    return Promise.resolve();
  }

  private persistRuntimeState(): void {
    if (!this.runtimeStateStore) return;
    // 入口处立即对内存状态做快照，随后链式串行地写入 IDB，保证顺序与观察一致。
    const snapshot = this.takeRuntimeStateSnapshot();
    const store = this.runtimeStateStore;
    const key = this.runtimeStateKey;
    this.persistChain = this.persistChain
      .then(() => {
        if (snapshot === null) return store.clear(key);
        return store.save(key, snapshot);
      })
      .catch((err) => {
        // 单次 save/clear 失败不阻断后续链上的写入。
        console.error('[BlobSync] persist runtime state error:', err);
      });
  }

  /** 仅供测试：等待链上所有已排入的持久化操作完成。 */
  flushPersistChain(): Promise<void> {
    return this.persistChain;
  }

  private takeRuntimeStateSnapshot(): BlobRuntimeState | null {
    const pendingRemoteDownloads = [...this.pendingRemoteDownloads]
      .filter(([docPath]) => !this.isIgnoredDocPath(docPath))
      .map(([docPath, ref]) => ({
        docPath,
        hash: ref.hash,
      }));
    const pendingRemoteDeletes = [...this.pendingRemoteDeletes].filter((docPath) => !this.isIgnoredDocPath(docPath));
    const pendingLocalUpserts = [...this.pendingLocalUpserts].filter((docPath) => !this.isIgnoredDocPath(docPath));
    const pendingLocalDeletions = [...this.pendingLocalDeletions]
      .filter(([docPath]) => !this.isIgnoredDocPath(docPath))
      .map(([docPath, hash]) => {
        const firstSeenAt = this.pendingLocalDeletionFirstSeenAt.get(docPath);
        return firstSeenAt ? { docPath, hash, firstSeenAt } : { docPath, hash };
      });
    const knownLocalPaths = [...this.knownLocalPaths].filter((docPath) => !this.isIgnoredDocPath(docPath));
    const knownLocalBlobs = [...this.knownLocalBlobs.values()].filter((item) => !this.isIgnoredDocPath(item.docPath));
    const pendingMissingBlobs = [...this.pendingMissingBlobs.values()].filter((item) => !this.isIgnoredDocPath(item.docPath));

    if (
      pendingRemoteDownloads.length === 0 &&
      pendingRemoteDeletes.length === 0 &&
      pendingLocalUpserts.length === 0 &&
      pendingLocalDeletions.length === 0 &&
      knownLocalBlobs.length === 0 &&
      pendingMissingBlobs.length === 0 &&
      knownLocalPaths.length === 0
    ) {
      return null;
    }
    return {
      vaultId: this.runtimeStateKey,
      pendingRemoteDownloads,
      pendingRemoteDeletes,
      pendingLocalUpserts,
      pendingLocalDeletions,
      knownLocalBlobs,
      pendingMissingBlobs,
      knownLocalPaths,
      localPath: this.localPath,
      updatedAt: new Date().toISOString(),
    };
  }
}
