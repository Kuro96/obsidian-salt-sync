import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import type { Vault, TFile, TAbstractFile } from 'obsidian';
import { requestUrl } from 'obsidian';
import type { VaultId, BlobHash, BlobRef, BlobTombstone } from '@salt-sync/shared';
import { changedMapKeys, mapChanged } from '../util';
import { BlobHashCache } from './blobHashCache';
import type { BlobRuntimeState } from '../storage/indexedDbStore';

interface BlobRuntimeStateStore {
  load(vaultId: VaultId): Promise<BlobRuntimeState | null>;
  save(vaultId: VaultId, state: BlobRuntimeState): Promise<void>;
  clear(vaultId: VaultId): Promise<void>;
}

export type BlobApplyGateState = 'startup-blocked' | 'maintenance-blocked' | 'open';

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
  private readonly pathQueues = new Map<string, Promise<void>>();
  private readonly pendingRemoteDownloads = new Map<string, BlobRef>();
  private readonly pendingRemoteDeletes = new Set<string>();
  private readonly pendingLocalUpserts = new Set<string>();
  private readonly pendingLocalDeletions = new Map<string, string | null>();
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
    this.pendingLocalUpserts.add(path);
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
    const ref = this.pathToBlob.get(path);
    const cachedHash = this.hashCache.peek(path);
    const knownHash = ref?.hash ?? cachedHash ?? null;
    this.hashCache.delete(path);
    this.knownLocalPaths.delete(path);

    // 无论 ref 是否在 shared model，都先登记 pending，确保启动窗口期的 delete 不丢。
    this.pendingLocalDeletions.set(path, knownHash);
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
        const ref = ptbMap.get(path);
        if (ref) {
          this.pendingRemoteDeletes.delete(path);
          this.pendingRemoteDownloads.set(path, ref);
          this.persistRuntimeState();
        }
      }
    }

    // Tombstone → 删除本地文件
    const tombMap = this.blobTombstones;
    if (mapChanged(txn, tombMap)) {
      for (const path of changedMapKeys(txn, tombMap)) {
        if (tombMap.has(path)) {
          this.pendingRemoteDownloads.delete(path);
          this.pendingRemoteDeletes.add(path);
          this.persistRuntimeState();
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
    await this.enqueuePathOperation(docPath, async () => {
      await this.deleteLocalFile(docPath);
    });
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
    await this.flushPendingRemoteChanges();
    await this.flushPersistChain();
  }

  getRemoteApplyGateState(): BlobApplyGateState {
    return this.gateState;
  }

  async restoreRuntimeState(): Promise<void> {
    if (!this.runtimeStateStore) return;
    if (this.runtimeStateRestored) return;
    this.runtimeStateRestored = true;
    const restored = await this.runtimeStateStore.load(this.runtimeStateKey);
    if (!restored) return;

    // 合并而非替换：注册 ydoc 监听和 restoreRuntimeState 之间可能已有新的 pending 写入，
    // 这里只补还 IDB 中尚未进入内存的条目，避免覆盖启动窗口期新产生的 pending。
    for (const item of restored.pendingRemoteDownloads) {
      if (this.pendingRemoteDownloads.has(item.docPath)) continue;
      const ref = this.pathToBlob.get(item.docPath);
      if (ref && ref.hash === item.hash) {
        this.pendingRemoteDownloads.set(item.docPath, ref);
      }
    }

    for (const docPath of restored.pendingRemoteDeletes) {
      if (this.pendingRemoteDeletes.has(docPath)) continue;
      if (this.blobTombstones.has(docPath)) {
        this.pendingRemoteDeletes.add(docPath);
      }
    }

    for (const docPath of restored.pendingLocalUpserts) {
      if (this.pendingLocalUpserts.has(docPath)) continue;
      if (this.vault.getAbstractFileByPath(this.toVaultPath(docPath))) {
        this.pendingLocalUpserts.add(docPath);
      }
    }

    for (const item of restored.pendingLocalDeletions ?? []) {
      if (this.pendingLocalDeletions.has(item.docPath)) continue;
      // 文件又出现了说明用户撤销了删除，放弃这条 pending。
      if (this.vault.getAbstractFileByPath(this.toVaultPath(item.docPath))) continue;
      // 远端已经有 tombstone → 同路径 LWW 已生效，跳过。
      if (this.blobTombstones.has(item.docPath)) continue;
      this.pendingLocalDeletions.set(item.docPath, item.hash);
    }

    for (const path of restored.knownLocalPaths ?? []) {
      if (this.knownLocalPaths.has(path)) continue;
      // 已有 tombstone 说明删除已确认，无需再跟踪。
      if (this.blobTombstones.has(path)) continue;
      this.knownLocalPaths.add(path);
    }

    this.persistRuntimeState();
    await this.flushPersistChain();
  }

  // ── private ───────────────────────────────────────────────────────────────

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

    const resp = await requestUrl({
      url: `${this.httpBase}/vault/${this.vaultId}/blobs/${ref.hash}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    });

    const bytes = resp.arrayBuffer;
    const actualHash = sha256hex(new Uint8Array(bytes));
    if (actualHash !== ref.hash) {
      throw new Error(`downloaded blob hash mismatch for ${docPath}: expected ${ref.hash}, got ${actualHash}`);
    }

    if (existing && 'stat' in existing) {
      await this.vault.modifyBinary(existing as TFile, bytes);
    } else {
      await this.vault.createBinary(vaultPath, bytes);
    }
    const file = this.vault.getFileByPath(vaultPath);
    if (file) {
      this.hashCache.set(docPath, file.stat.mtime, file.stat.size, ref.hash);
      if (!this.knownLocalPaths.has(docPath)) {
        this.knownLocalPaths.add(docPath);
        this.persistRuntimeState();
      }
    }
  }

  private async deleteLocalFile(docPath: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(this.toVaultPath(docPath));
    if (!file) return;
    this.hashCache.delete(docPath);
    this.knownLocalPaths.delete(docPath);
    await this.vault.delete(file);
  }

  private listLocalBlobFiles(): TFile[] {
    return this.vault.getFiles().filter((file) => this.isPathForThisEngine(file.path) && !file.path.endsWith('.md'));
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
      if (!this.knownLocalPaths.has(docPath)) {
        this.knownLocalPaths.add(docPath);
        knownLocalPathsChanged = true;
      }

      const ref = this.pathToBlob.get(docPath);
      if (!ref) {
        if (mode === 'authoritative') {
          await this.handleLocalBlobChange(docPath);
        }
        continue;
      }

      const localHash = await this.getLocalBlobHash(docPath, file);
      this.knownLocalPaths.add(docPath);
      if (ref.hash !== localHash && mode === 'authoritative') {
        await this.handleLocalBlobChange(docPath);
      }
    }

    for (const [docPath, ref] of this.pathToBlob) {
      if (localSet.has(docPath)) continue;
      // Phase 10：tombstone 优先。pathToBlob 与 blobTombstones 可能同 key 并存（跨设备 LWW），
      // 此时必须以 tombstone 为准，不触发下载。
      if (this.blobTombstones.has(docPath)) continue;
      // 仍在 pending 中（例如 hash 未知、flushPendingLocalDeletions 保留）的删除意图
      // 同样不能下载；等 hash 线索到齐后由后续 flush 转成 tombstone。
      if (this.pendingLocalDeletions.has(docPath)) continue;
      if (this.isMissingLocalBlob(docPath)) {
        if (mode === 'authoritative') {
          await this.handleLocalBlobDeletion(docPath);
        }
        continue;
      }
      await this.downloadIfMissing(docPath, ref);
    }

    if (knownLocalPathsChanged) {
      this.persistRuntimeState();
    }
  }

  private isMissingLocalBlob(docPath: string): boolean {
    // hashCache.has: file was seen in the current session (and since deleted).
    // knownLocalPaths.has: file was confirmed present in a previous session.
    // blobTombstones check is redundant here (outer loop already guards it),
    // but kept for safety against direct calls.
    return (this.hashCache.has(docPath) || this.knownLocalPaths.has(docPath))
      && !this.blobTombstones.has(docPath);
  }

  private async flushPendingRemoteChanges(): Promise<void> {
    // 新到达的 pathToBlob 可能含有 pending local deletion 需要的 hash，
    // 先给它们一次 tombstone 机会，避免随后把删除的文件重新下载回来。
    this.flushPendingLocalDeletions();

    const errors: unknown[] = [];

    for (const docPath of [...this.pendingRemoteDeletes]) {
      this.pendingRemoteDeletes.delete(docPath);
      await this.enqueuePathOperation(docPath, async () => {
        if (!this.blobTombstones.has(docPath)) return;
        await this.deleteLocalFile(docPath);
      }).catch((err) => errors.push(err));
    }

    for (const [docPath, ref] of [...this.pendingRemoteDownloads]) {
      this.pendingRemoteDownloads.delete(docPath);
      await this.enqueuePathOperation(docPath, async () => {
        const currentRef = this.pathToBlob.get(docPath);
        if (!currentRef || currentRef.hash !== ref.hash) return;
        if (this.blobTombstones.has(docPath)) return;
        await this.downloadIfMissing(docPath, ref);
      }).catch((err) => errors.push(err));
    }

    for (const err of errors) {
      console.error('[BlobSync] remote change error:', err);
    }
    this.persistRuntimeState();
  }

  private flushPendingLocalDeletions(): void {
    if (this.pendingLocalDeletions.size === 0) return;
    let mutated = false;
    this.ydoc.transact(() => {
      for (const [docPath, knownHash] of [...this.pendingLocalDeletions]) {
        // 本地文件又出现了 → 用户可能撤销删除，让随后的 upsert/rescan 处理。
        if (this.vault.getAbstractFileByPath(this.toVaultPath(docPath))) {
          this.pendingLocalDeletions.delete(docPath);
          mutated = true;
          continue;
        }
        if (this.blobTombstones.has(docPath)) {
          // 远端已墓碑，幂等移出 pending。
          this.pendingLocalDeletions.delete(docPath);
          mutated = true;
          continue;
        }
        const ref = this.pathToBlob.get(docPath);
        const hash = ref?.hash ?? knownHash;
        if (!hash) {
          // 没有任何 hash 线索 → 保留在 pending，等 pathToBlob 或 hashCache 到齐后再 flush。
          continue;
        }
        if (ref) this.pathToBlob.delete(docPath);
        this.blobTombstones.set(docPath, {
          hash,
          deletedAt: new Date().toISOString(),
        });
        this.pendingLocalDeletions.delete(docPath);
        this.knownLocalPaths.delete(docPath);
        mutated = true;
      }
    }, 'local-blob');
    if (mutated) this.persistRuntimeState();
  }

  private async flushPendingLocalUpserts(): Promise<void> {
    const errors: unknown[] = [];
    for (const docPath of [...this.pendingLocalUpserts]) {
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
      if (existingRef?.hash === hash) return;

      await this.uploadIfNeeded(hash, arrayBuffer, contentType);

      // 上传期间文件可能已被删除；再次确认本地状态，避免把刚被删除的 blob 复活
      // （或把 tombstone 清掉）。Phase 9 Issue A 的第二道防线。
      if (!this.vault.getAbstractFileByPath(this.toVaultPath(path))) {
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
      this.knownLocalPaths.add(path);
      completed = true;
    } finally {
      if (completed) {
        this.pendingLocalUpserts.delete(path);
      }
      this.persistRuntimeState();
    }
  }

  private processLocalBlobDeletion(path: string): Promise<void> {
    // 文件又出现了 → 放弃这条 deletion，交给后续的 upsert/rescan 处理。
    if (this.vault.getAbstractFileByPath(this.toVaultPath(path))) {
      if (this.pendingLocalDeletions.delete(path)) this.persistRuntimeState();
      return Promise.resolve();
    }

    // 已有 tombstone（LWW 已生效或被并发写入）→ 幂等退出。
    if (this.blobTombstones.has(path)) {
      if (this.pendingLocalDeletions.delete(path)) this.persistRuntimeState();
      return Promise.resolve();
    }

    const ref = this.pathToBlob.get(path);
    const pendingHash = this.pendingLocalDeletions.get(path) ?? null;
    const hash = ref?.hash ?? pendingHash;
    if (!hash) {
      // 没有任何 hash 线索 → 保留在 pending，等 flushPendingLocalDeletions 处理。
      return Promise.resolve();
    }

    this.ydoc.transact(() => {
      if (ref) this.pathToBlob.delete(path);
      this.blobTombstones.set(path, {
        hash,
        deletedAt: new Date().toISOString(),
      });
    }, 'local-blob');
    this.pendingLocalDeletions.delete(path);
    this.knownLocalPaths.delete(path);
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
    if (
      this.pendingRemoteDownloads.size === 0 &&
      this.pendingRemoteDeletes.size === 0 &&
      this.pendingLocalUpserts.size === 0 &&
      this.pendingLocalDeletions.size === 0 &&
      this.knownLocalPaths.size === 0
    ) {
      return null;
    }
    return {
      vaultId: this.runtimeStateKey,
      pendingRemoteDownloads: [...this.pendingRemoteDownloads].map(([docPath, ref]) => ({
        docPath,
        hash: ref.hash,
      })),
      pendingRemoteDeletes: [...this.pendingRemoteDeletes],
      pendingLocalUpserts: [...this.pendingLocalUpserts],
      pendingLocalDeletions: [...this.pendingLocalDeletions].map(([docPath, hash]) => ({
        docPath,
        hash,
      })),
      knownLocalPaths: [...this.knownLocalPaths],
      updatedAt: new Date().toISOString(),
    };
  }
}
