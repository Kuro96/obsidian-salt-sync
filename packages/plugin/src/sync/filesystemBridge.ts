import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import type { Vault, TFile } from 'obsidian';
import type { FileFingerprint, FilesystemBridge, VaultId } from '@salt-sync/shared';
import { applyDiffToYText } from './diff';
import { evaluateExternalEditPolicy, type ExternalEditPolicy } from './externalEditPolicy';

function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

const identity = (p: string) => p;

/**
 * ObsidianFilesystemBridge
 *
 * 磁盘 → 共享状态：markDirty → drain → importFromDisk → Y.Text diff
 * 共享状态 → 磁盘：flushFile → suppressExpectedWrite → vault.modify
 *
 * 自写回声：写磁盘前记录内容指纹，后续文件事件若指纹匹配则抑制。
 * 路径串行化：每个路径维护一条 Promise 链，防止并发写同一文件。
 *
 * 路径语义：
 *   vaultPath — Obsidian Vault 中的完整相对路径（含挂载前缀）
 *   docPath   — 共享模型（Y.Doc）中的路径（挂载场景下已去除前缀）
 *
 * toDocPath / toVaultPath 在构造时注入，主 vault 场景下均为 identity。
 */
export class ObsidianFilesystemBridge implements FilesystemBridge {
  private readonly dirtySet = new Set<string>(); // keyed by docPath
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly writeQueues = new Map<string, Promise<void>>(); // keyed by docPath
  private readonly writeGenerations = new Map<string, number>(); // keyed by docPath
  private readonly openWriteTimers = new Map<string, ReturnType<typeof setTimeout>>(); // keyed by docPath
  private readonly remoteFlushQuarantine = new Set<string>(); // keyed by docPath
  private readonly expectedWrites = new Map<string, FileFingerprint>(); // keyed by docPath
  /** 预期由我们发起的自写删除（docPath 集合），避免 vault.on('delete') 回声 */
  private readonly expectedDeletes = new Set<string>();
  private readonly openDocPaths = new Set<string>();
  private readonly textObservers = new Map<string, { ytext: Y.Text; handler: (_: Y.YTextEvent, txn: Y.Transaction) => void }>();
  private readonly deferredImports = new Set<string>();
  private readonly recentEditorActivity = new Map<string, number>();
  private activeDocPath: string | null = null;

  constructor(
    private readonly vault: Vault,
    /** Returns the Y.Text for a given docPath, or null if not in shared model yet */
    private readonly getYText: (docPath: string) => Y.Text | null,
    private readonly ydoc: Y.Doc,
    private readonly primaryVaultId: VaultId,
    private readonly toDocPath: (vaultPath: string) => string = identity,
    private readonly toVaultPath: (docPath: string) => string = identity,
    private readonly getExternalEditPolicy: () => ExternalEditPolicy = () => 'always',
    /** Optional: query whether a vaultPath has a healthy yCollab editor binding */
    private readonly isBindingHealthy: (vaultPath: string) => boolean = () => true,
    /** Optional: called when a file is found missing on disk during importFromDisk */
    private readonly onExternalDeletion?: (docPath: string) => void,
    /** Optional: returns true if the docPath has been tombstoned and must not be recreated */
    private readonly isDeletedPath?: (docPath: string) => boolean,
  ) {}

  // ── FilesystemBridge interface ────────────────────────────────────────────

  /** 磁盘 -> 共享状态：将 vaultPath 转换为 docPath 后加入 dirty set */
  markDirty(vaultPath: string): void {
    this.dirtySet.add(this.toDocPath(vaultPath));
    this.scheduleDrain();
  }

  /** 消费 dirty set，读取磁盘内容，将差异导入共享状态 */
  async drain(): Promise<void> {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    const paths = [...this.dirtySet];
    this.dirtySet.clear();
    for (const docPath of paths) {
      // Route through writeQueues so importFromDisk is serialized with
      // flushFile — prevents the race where a concurrent remote flush
      // overwrites the disk content that importFromDisk is about to read.
      const prev = this.writeQueues.get(docPath) ?? Promise.resolve();
      const current = prev.then(() => this.importFromDisk(docPath));
      this.writeQueues.set(docPath, current.catch(() => {}));
      await current.catch((err) => {
        console.error(`[SaltSync:Bridge] drain error for ${docPath}:`, err);
      });
    }
  }

  /** 共享状态 -> 磁盘：串行写回指定 docPath */
  async flushFile(docPath: string): Promise<void> {
    return this.enqueueFlushFile(docPath, this.currentWriteGeneration(docPath));
  }

  quarantineRemoteFlushes(docPaths: Iterable<string>): void {
    for (const docPath of docPaths) {
      this.remoteFlushQuarantine.add(docPath);
      this.invalidateQueuedWrites(docPath);
    }
  }

  /**
   * Re-enable future remote flushes for these paths. Updates observed while a path was
   * quarantined are intentionally dropped rather than deferred; startup recovery code
   * must explicitly call forceImportFromDisk() before release when local disk content
   * should win over a stale remote snapshot.
   */
  releaseRemoteFlushQuarantine(docPaths: Iterable<string>): void {
    for (const docPath of docPaths) {
      this.remoteFlushQuarantine.delete(docPath);
    }
  }

  async forceImportFromDisk(docPath: string): Promise<void> {
    this.invalidateQueuedWrites(docPath);
    this.cancelOpenWriteTimer(docPath);
    this.dirtySet.delete(docPath);
    this.deferredImports.delete(docPath);

    const prev = this.writeQueues.get(docPath) ?? Promise.resolve();
    const current = prev.then(() => this.importFromDisk(docPath, { force: true }));
    this.writeQueues.set(docPath, current.catch(() => {}));
    return current;
  }

  notifyFileOpened(vaultPath: string): void {
    const docPath = this.toDocPath(vaultPath);
    this.openDocPaths.add(docPath);
    this.activeDocPath = docPath;
    this.attachTextObserver(docPath);
  }

  notifyFileClosed(vaultPath: string): void {
    const docPath = this.toDocPath(vaultPath);
    this.openDocPaths.delete(docPath);
    if (this.activeDocPath === docPath) {
      this.activeDocPath = null;
    }
    this.detachTextObserver(docPath);
    if (this.deferredImports.has(docPath)) {
      this.deferredImports.delete(docPath);
      this.markDirty(vaultPath);
    }
  }

  notifyEditorActivity(vaultPath: string): void {
    const docPath = this.toDocPath(vaultPath);
    this.recentEditorActivity.set(docPath, Date.now());
    this.activeDocPath = docPath;
  }

  syncOpenFiles(vaultPaths: string[]): void {
    const nextDocPaths = new Set(vaultPaths.map((path) => this.toDocPath(path)));
    for (const docPath of [...this.openDocPaths]) {
      if (!nextDocPaths.has(docPath)) {
        this.notifyFileClosed(this.toVaultPath(docPath));
      }
    }
    for (const vaultPath of vaultPaths) {
      this.notifyFileOpened(vaultPath);
    }
  }

  updatePathAfterRename(oldVaultPath: string, newVaultPath: string): void {
    const oldDocPath = this.toDocPath(oldVaultPath);
    const newDocPath = this.toDocPath(newVaultPath);
    if (oldDocPath === newDocPath) return;

    if (this.openDocPaths.delete(oldDocPath)) {
      this.openDocPaths.add(newDocPath);
    }
    if (this.activeDocPath === oldDocPath) {
      this.activeDocPath = newDocPath;
    }
    if (this.deferredImports.delete(oldDocPath)) {
      this.deferredImports.add(newDocPath);
    }
    const recent = this.recentEditorActivity.get(oldDocPath);
    if (recent !== undefined) {
      this.recentEditorActivity.delete(oldDocPath);
      this.recentEditorActivity.set(newDocPath, recent);
    }
    const expected = this.expectedWrites.get(oldDocPath);
    if (expected) {
      this.expectedWrites.delete(oldDocPath);
      this.expectedWrites.set(newDocPath, expected);
    }
    if (this.expectedDeletes.delete(oldDocPath)) {
      this.expectedDeletes.add(newDocPath);
    }
    if (this.remoteFlushQuarantine.delete(oldDocPath)) {
      this.remoteFlushQuarantine.add(newDocPath);
    }
    const generation = this.writeGenerations.get(oldDocPath);
    if (generation !== undefined) {
      this.writeGenerations.delete(oldDocPath);
      this.writeGenerations.set(newDocPath, generation);
    }
    const observer = this.textObservers.get(oldDocPath);
    if (observer) {
      this.textObservers.delete(oldDocPath);
      this.textObservers.set(newDocPath, observer);
    }
    const timer = this.openWriteTimers.get(oldDocPath);
    if (timer) {
      this.openWriteTimers.delete(oldDocPath);
      this.openWriteTimers.set(newDocPath, timer);
    }
  }

  handleRemoteTransaction(
    txn: Y.Transaction,
    docs: Iterable<[string, Y.Text]>,
    idToPath: { get(key: string): string | undefined },
    changedDocIds: Iterable<string> = [],
  ): void {
    if (txn.origin !== 'remote') return;

    for (const fileId of changedDocIds) {
      const docPath = idToPath.get(fileId);
      if (!docPath) continue;
      if (this.openDocPaths.has(docPath)) {
        const hasObserver = this.textObservers.has(docPath);
        console.debug(`[SaltSync:Bridge] remote update for open file, scheduling write as fallback`, {
          docPath, hasObserver,
        });
        this.scheduleOpenWrite(docPath);
        continue;
      }
      console.debug(`[SaltSync:Bridge] remote update for closed file, scheduling write`, { docPath });
      this.scheduleClosedWrite(docPath);
    }

    for (const [fileId, ytext] of docs) {
      if (!mapChanged(txn, ytext)) continue;
      const docPath = idToPath.get(fileId);
      if (!docPath) continue;
      if (this.openDocPaths.has(docPath)) {
        const hasObserver = this.textObservers.has(docPath);
        console.debug(`[SaltSync:Bridge] remote Y.Text change for open file, scheduling write as fallback`, {
          docPath, hasObserver,
        });
        this.scheduleOpenWrite(docPath);
        continue;
      }
      console.debug(`[SaltSync:Bridge] remote Y.Text change for closed file, scheduling write`, { docPath });
      this.scheduleClosedWrite(docPath);
    }
  }

  /** 共享状态 -> 磁盘：远端 tombstone 触发本地删除，走同一串行队列 */
  async deleteFile(docPath: string, shouldDelete: (file: TFile | null) => boolean = () => true): Promise<void> {
    const prev = this.writeQueues.get(docPath) ?? Promise.resolve();
    const current = prev.then(() => this.doDeleteFile(docPath, shouldDelete));
    this.writeQueues.set(docPath, current.catch(() => {}));
    return current;
  }

  /** 判断某个 vault 删除事件是否是我们刚发起的自写删除 */
  isExpectedDelete(vaultPath: string): boolean {
    const docPath = this.toDocPath(vaultPath);
    if (this.expectedDeletes.has(docPath)) {
      this.expectedDeletes.delete(docPath);
      return true;
    }
    return false;
  }

  /** 注册预期的自写内容指纹（以 docPath 为 key），TTL 5 秒以覆盖第三方同步工具的回声 */
  suppressExpectedWrite(docPath: string, fingerprint: FileFingerprint): void {
    this.expectedWrites.set(docPath, { ...fingerprint, expiresAt: Date.now() + 5000 });
  }

  /** 根据文件路径判断归属哪个 room（Phase 5 支持共享目录时扩展） */
  resolveVaultId(_path: string): VaultId {
    return this.primaryVaultId;
  }

  // ── public helpers ────────────────────────────────────────────────────────

  /**
   * 检查某个 vault 文件事件是否应该被抑制（自写回声检测）。
   * 由 handleLocalFileChange 调用，传入 vaultPath + 已读取的 content。
   */
  isSuppressed(vaultPath: string, content: string): boolean {
    const docPath = this.toDocPath(vaultPath);
    const expected = this.expectedWrites.get(docPath);
    if (!expected) return false;

    // TTL 过期则清理并放行
    if (expected.expiresAt && Date.now() > expected.expiresAt) {
      this.expectedWrites.delete(docPath);
      return false;
    }

    const actualSha256 = sha256hex(content);
    const actualByteLength = byteLength(content);

    if (actualSha256 === expected.sha256 && actualByteLength === expected.byteLength) {
      // 不删除——在 TTL 窗口内持续抑制相同内容的重复事件（如 Syncthing 回写）
      return true;
    }
    // 内容不匹配说明是真实编辑，清除指纹并放行
    this.expectedWrites.delete(docPath);
    return false;
  }

  // ── private ───────────────────────────────────────────────────────────────

  private scheduleDrain(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain().catch(console.error);
    }, 300);
  }

  private currentWriteGeneration(docPath: string): number {
    return this.writeGenerations.get(docPath) ?? 0;
  }

  private invalidateQueuedWrites(docPath: string): void {
    this.writeGenerations.set(docPath, this.currentWriteGeneration(docPath) + 1);
  }

  private enqueueFlushFile(docPath: string, generation: number): Promise<void> {
    const prev = this.writeQueues.get(docPath) ?? Promise.resolve();
    const current = prev.then(() => this.doFlushFile(docPath, generation));
    this.writeQueues.set(docPath, current.catch(() => {}));
    return current;
  }

  private cancelOpenWriteTimer(docPath: string): void {
    const timer = this.openWriteTimers.get(docPath);
    if (!timer) return;
    clearTimeout(timer);
    this.openWriteTimers.delete(docPath);
  }

  private attachTextObserver(docPath: string): void {
    if (this.textObservers.has(docPath)) return;
    const ytext = this.getYText(docPath);
    if (!ytext) return;

    const handler = (_event: Y.YTextEvent, txn: Y.Transaction) => {
      if (txn.origin !== 'remote') return;
      this.scheduleOpenWrite(docPath);
    };
    ytext.observe(handler);
    this.textObservers.set(docPath, { ytext, handler });
  }

  private detachTextObserver(docPath: string): void {
    const observer = this.textObservers.get(docPath);
    if (!observer) return;
    observer.ytext.unobserve(observer.handler);
    this.textObservers.delete(docPath);

    const timer = this.openWriteTimers.get(docPath);
    if (timer) {
      clearTimeout(timer);
      this.openWriteTimers.delete(docPath);
    }
  }

  private scheduleOpenWrite(docPath: string): void {
    if (this.remoteFlushQuarantine.has(docPath)) {
      console.debug(`[SaltSync:Bridge] scheduleOpenWrite skipped (remote flush quarantined)`, { docPath });
      return;
    }
    const existing = this.openWriteTimers.get(docPath);
    if (existing) clearTimeout(existing);
    const generation = this.currentWriteGeneration(docPath);
    const lastActivityAt = this.recentEditorActivity.get(docPath) ?? 0;
    const recentlyEdited = Date.now() - lastActivityAt < 1500;
    const vaultPath = this.toVaultPath(docPath);
    const bindingHealthy = this.isBindingHealthy(vaultPath);
    // When binding is healthy, yCollab handles editor updates directly — disk
    // write is just a fallback and can afford a longer delay.  When unhealthy,
    // the disk write IS the update path, so minimise delay.
    const delay = !bindingHealthy
      ? 150
      : this.activeDocPath === docPath && recentlyEdited
        ? 1500
        : 500;
    console.debug(`[SaltSync:Bridge] scheduleOpenWrite`, { docPath, delay, recentlyEdited, bindingHealthy });
    this.openWriteTimers.set(
      docPath,
      setTimeout(() => {
        this.openWriteTimers.delete(docPath);
        this.enqueueFlushFile(docPath, generation).catch((err) => {
          console.error(`[SaltSync:Bridge] open flush error`, { docPath, err });
        });
      }, delay),
    );
  }

  private scheduleClosedWrite(docPath: string): void {
    if (this.remoteFlushQuarantine.has(docPath)) {
      console.debug(`[SaltSync:Bridge] scheduleClosedWrite skipped (remote flush quarantined)`, { docPath });
      return;
    }
    console.debug(`[SaltSync:Bridge] scheduleClosedWrite`, { docPath });
    this.enqueueFlushFile(docPath, this.currentWriteGeneration(docPath)).catch((err) => {
      console.error(`[SaltSync:Bridge] closed flush error`, { docPath, err });
    });
  }

  /**
   * 磁盘 -> 共享状态：以 docPath 定位 Y.Text，以 vaultPath 读取磁盘文件。
   */
  private async importFromDisk(docPath: string, options: { force?: boolean } = {}): Promise<void> {
    const vaultPath = this.toVaultPath(docPath);
    const file = this.vault.getFileByPath(vaultPath) as TFile | null;

    if (!file) {
      this.handleExternalDeletion(docPath);
      return;
    }

    if (!options.force) {
      const decision = evaluateExternalEditPolicy(this.getExternalEditPolicy(), this.openDocPaths.has(docPath));
      if (!decision.allowed) {
        if (decision.deferred) {
          this.deferredImports.add(docPath);
          console.debug(`[SaltSync:Bridge] importFromDisk deferred (policy: ${decision.reason})`, { docPath });
        }
        return;
      }
    }

    // When the file is open AND the editor binding is healthy, yCollab is the
    // authoritative bridge between Y.Text and the editor. Importing from disk
    // in this state is dangerous: the disk content may lag behind Y.Text (due
    // to flush debounce), and applying the stale diff would revert recent edits.
    //
    // We still allow import when the binding is NOT healthy (fallback mode) or
    // when the file is closed (no editor, disk is the only source of truth).
    if (!options.force && this.openDocPaths.has(docPath) && this.isBindingHealthy(vaultPath)) {
      console.debug(`[SaltSync:Bridge] importFromDisk skipped (open file with healthy binding)`, { docPath });
      return;
    }

    // importFromDisk now runs inside writeQueues (serialized with flushFile),
    // but a pending openWriteTimer could fire after we read disk and enqueue
    // a flush that overwrites our import. Cancel it — the import is fresher.
    if (this.openWriteTimers.has(docPath)) {
      this.cancelOpenWriteTimer(docPath);
      console.info(`[SaltSync:Bridge] importFromDisk cancelled pending openWriteTimer`, { docPath });
    }

    const content = await this.vault.read(file);

    const ytext = this.getYText(docPath);
    if (!ytext) {
      // Path not yet registered in shared model — will be picked up by reconcile
      return;
    }

    const oldContent = ytext.toString();
    if (oldContent === content) return;

    console.debug(`[SaltSync:Bridge] importFromDisk applying diff`, { docPath, oldLen: oldContent.length, newLen: content.length });
    applyDiffToYText(ytext, oldContent, content, 'local-disk');
  }

  /** 共享状态 -> 磁盘：实际写入逻辑，在串行队列中执行 */
  private async doFlushFile(docPath: string, generation: number): Promise<void> {
    if (this.remoteFlushQuarantine.has(docPath)) return;
    if (generation !== this.currentWriteGeneration(docPath)) return;
    if (this.isDeletedPath?.(docPath)) return;

    const ytext = this.getYText(docPath);
    if (!ytext) return;

    const content = ytext.toString();
    const vaultPath = this.toVaultPath(docPath);

    // Skip write if disk content already matches Y.Text (avoids redundant IO
    // when yCollab already updated the editor and the fallback flush fires)
    const file = this.vault.getFileByPath(vaultPath) as TFile | null;
    if (file) {
      const diskContent = await this.vault.read(file);
      if (diskContent === content) {
        console.debug(`[SaltSync:Bridge] doFlushFile skipped (disk matches Y.Text)`, { docPath });
        return;
      }
    }

    // Record fingerprint before writing (self-echo suppression)
    this.suppressExpectedWrite(docPath, {
      sha256: sha256hex(content),
      byteLength: byteLength(content),
    });

    if (file) {
      await this.vault.modify(file, content);
    } else {
      await this.vault.create(vaultPath, content);
    }
  }

  private async doDeleteFile(docPath: string, shouldDelete: (file: TFile | null) => boolean): Promise<void> {
    const vaultPath = this.toVaultPath(docPath);
    const file = this.vault.getFileByPath(vaultPath) as TFile | null;
    if (!shouldDelete(file)) return;
    if (!file) return;
    this.expectedDeletes.add(docPath);
    await this.vault.delete(file);
  }

  private handleExternalDeletion(docPath: string): void {
    console.log(`[SaltSync:Bridge] external deletion detected: ${docPath}`);
    this.onExternalDeletion?.(docPath);
  }
}

function mapChanged(txn: Y.Transaction, target: unknown): boolean {
  return txn.changed.has(target as any);
}
