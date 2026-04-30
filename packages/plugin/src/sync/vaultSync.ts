import * as Y from 'yjs';
import { MarkdownView, requestUrl } from 'obsidian';
import type { Plugin, TFile, TAbstractFile } from 'obsidian';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { SCHEMA_VERSION } from '@salt-sync/shared';
import type {
  SyncEngine,
  SnapshotMeta,
  SharedDirectoryMount,
  FileTombstone,
  BlobRef,
  BlobTombstone,
  ConnectionStatus,
} from '@salt-sync/shared';
import type { SaltSyncSettings } from '../settings';
import { IndexedDbBlobRuntimeStateStore, IndexedDbLocalCache, IndexedDbMarkdownPendingStore } from '../storage/indexedDbStore';
import { RoomClient } from './roomClient';
import { EditorBindingManager } from './editorBinding';
import { ObsidianFilesystemBridge } from './filesystemBridge';
import { BlobSync } from './blobSync';
import { applyDiffToYText } from './diff';
import { randomUUID, changedMapKeys, mapChanged } from '../util';
import { isPathIgnoredBySync, isSameOrChildPath, normalizeVaultPath } from './pathSafety';
import { MarkdownTombstoneState, type TombstoneReceiptOrigin, type TombstoneReceiptProvenance } from './markdownTombstoneState';

// ── Sync status types ─────────────────────────────────────────────────────────

export type SyncPhase =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'syncing-blobs'
  | 'synced'
  | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  /** 已知 markdown 文件总数（初始同步完成后有效） */
  markdownFileCount: number;
  /** 已知 blob 文件总数（初始同步完成后有效） */
  blobFileCount: number;
  /** 所有已知 blob 的字节数之和 */
  totalBlobBytes: number;
  /** 待下载的远端 blob 数量 */
  pendingBlobDownloads: number;
  /** 待上传的本地 blob 数量 */
  pendingBlobUploads: number;
  /** 待本地删除的远端 blob 数量 */
  pendingBlobRemoteDeletes: number;
  /** 待传播到服务器的本地删除数量 */
  pendingBlobLocalDeletions: number;
}

type MarkdownDeleteGateState = 'startup-blocked' | 'maintenance-blocked' | 'open';

// ── Snapshot API response types ───────────────────────────────────────────────

export type ManifestFileEntry =
  | { path: string; type: 'markdown'; size: number }
  | { path: string; type: 'blob'; hash: string; size: number; contentType?: string };

export interface SnapshotManifest {
  snapshotId: string;
  createdAt: string;
  files: ManifestFileEntry[];
}

export type DownloadedFile =
  | { text: string; contentType: string }
  | { binary: ArrayBuffer; contentType: string };

/**
 * VaultSyncEngine
 *
 * 单个 vault 或共享目录挂载的同步引擎。
 *
 * 主 vault（mount = null）：vaultPath === docPath，excludedPrefixes 过滤掉挂载子目录。
 * 挂载引擎（mount 非 null）：只处理 mount.localPath/ 下的文件；
 *   docPath = vaultPath.slice(mount.localPath.length + 1)
 *   vaultPath = mount.localPath + '/' + docPath
 */
export class VaultSyncEngine implements SyncEngine {
  private readonly ydoc = new Y.Doc();
  private readonly client = new RoomClient();
  private readonly cache = new IndexedDbLocalCache();
  private readonly blobRuntimeStateStore = new IndexedDbBlobRuntimeStateStore();
  private readonly markdownPendingStore = new IndexedDbMarkdownPendingStore();
  private readonly awareness = new Awareness(this.ydoc);
  private editorBindings!: EditorBindingManager;
  private bridge!: ObsidianFilesystemBridge;
  private blobSync!: BlobSync;
  /**
   * 本设备在当前会话中确认过存在于本地磁盘的 markdown 路径。
   * 只对这些路径做“缺失即 tombstone”的补偿，避免新设备首同步时把
   * 纯远端文件误判成本地删除。
   */
  private readonly knownLocalMarkdownPaths = new Set<string>();
  private readonly pendingLocalMarkdownDeletions = new Set<string>();
  /**
   * 引擎是否已通过 stop() 停止。停止后不再处理 vault 文件事件，
   * 防止用户在暂停同步期间移动文件时产生误删 tombstone。
   */
  private stopped = false;

  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private blobRescanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deviceName: string;
  private hasAuthenticated = false;
  private awaitingInitialSync = false;
  private initialSyncComplete = false;
  private markdownDeleteGateState: MarkdownDeleteGateState = 'startup-blocked';
  private readonly pendingRemoteMarkdownDeletes = new Set<string>();
  private readonly markdownTombstones = new MarkdownTombstoneState();
  private blobMaintenancePaused = true;
  private clientStatus: ConnectionStatus = 'idle';
  private statusHandlers: Array<(status: SyncStatus) => void> = [];
  /** Remote path deletions and their previous file IDs, captured from Y.MapEvent before afterTransaction runs. */
  private readonly remotePathRemovalFileIds = new WeakMap<Y.Transaction, Map<string, string>>();

  /** Effective settings for this engine (may differ from plugin settings for mounts) */
  private readonly effectiveSettings: SaltSyncSettings;

  private get remoteFileDeleteSideEffectsOpen(): boolean {
    return this.markdownDeleteGateState === 'open';
  }

  private set remoteFileDeleteSideEffectsOpen(open: boolean) {
    this.markdownDeleteGateState = open ? 'open' : 'startup-blocked';
  }

  private get localCacheKey(): string {
    return `${this.effectiveSettings.serverUrl}::${this.effectiveSettings.vaultId}`;
  }

  private async clearLegacyLocalCache(): Promise<void> {
    const cleared = await this.cache.clearLegacyVaultOnlyKey(
      this.localCacheKey,
      this.effectiveSettings.vaultId,
    );
    if (cleared) {
      console.info(`[VaultSync] cleared legacy local cache key for ${this.effectiveSettings.vaultId}`);
    }
  }

  constructor(
    private readonly plugin: Plugin,
    settings: SaltSyncSettings,
    /** Shared directory mount config, or null for the primary vault */
    private readonly mount: SharedDirectoryMount | null = null,
    /** Vault-relative path prefixes owned by sibling mount engines (primary engine only) */
    private readonly excludedPrefixes: string[] = [],
  ) {
    if (mount) {
      this.effectiveSettings = {
        ...settings,
        vaultId: mount.vaultId,
        token: mount.token,
        serverUrl: mount.serverUrl ?? settings.serverUrl,
      };
    } else {
      this.effectiveSettings = settings;
    }
    this.deviceName = this.effectiveSettings.deviceName || 'unknown';
    this.pathToId.observe((event, txn) => {
      if (txn.origin !== 'remote') return;
      for (const [path, change] of event.changes.keys) {
        if (change.action !== 'delete' || typeof change.oldValue !== 'string') continue;
        let removed = this.remotePathRemovalFileIds.get(txn);
        if (!removed) {
          removed = new Map<string, string>();
          this.remotePathRemovalFileIds.set(txn, removed);
        }
        removed.set(path, change.oldValue);
      }
    });
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  /** vault 路径 → 共享模型路径（去除挂载前缀） */
  private toDocPath = (vaultPath: string): string => {
    if (!this.mount) return vaultPath;
    const prefix = normalizeVaultPath(this.mount.localPath) + '/';
    return vaultPath.startsWith(prefix) ? vaultPath.slice(prefix.length) : vaultPath;
  };

  /** 共享模型路径 → vault 路径（还原挂载前缀） */
  private toVaultPath = (docPath: string): string => {
    if (!this.mount) return docPath;
    return normalizeVaultPath(this.mount.localPath) + '/' + docPath;
  };

  /**
   * 判断某个 vaultPath 是否归属本引擎处理：
   * - 主 vault：不在任何挂载前缀下
   * - 挂载引擎：必须在 mount.localPath/ 下
   * - 排除 Obsidian/Trash/Syncthing 内部路径和冲突文件
   */
  isPathForThisEngine(vaultPath: string): boolean {
    if (isPathIgnoredBySync(vaultPath)) return false;
    if (this.mount) {
      const mountPath = normalizeVaultPath(this.mount.localPath);
      return isSameOrChildPath(vaultPath, mountPath) && normalizeVaultPath(vaultPath) !== mountPath;
    }
    return !this.excludedPrefixes.some((p) => isSameOrChildPath(vaultPath, p));
  }

  // ── Shared model accessors ────────────────────────────────────────────────

  private get pathToId(): Y.Map<string> {
    return this.ydoc.getMap('pathToId');
  }

  private get idToPath(): Y.Map<string> {
    return this.ydoc.getMap('idToPath');
  }

  private get docs(): Y.Map<Y.Text> {
    return this.ydoc.getMap('docs');
  }

  private get fileTombstones(): Y.Map<FileTombstone> {
    return this.ydoc.getMap('fileTombstones') as Y.Map<FileTombstone>;
  }

  private get pathToBlob(): Y.Map<BlobRef> {
    return this.ydoc.getMap('pathToBlob') as Y.Map<BlobRef>;
  }

  private get blobTombstones(): Y.Map<BlobTombstone> {
    return this.ydoc.getMap('blobTombstones') as Y.Map<BlobTombstone>;
  }

  /** Look up an existing Y.Text by docPath */
  private getYText(docPath: string): Y.Text | null {
    const fileId = this.pathToId.get(docPath);
    if (!fileId) return null;
    return this.docs.get(fileId) ?? null;
  }

  private getOrCreateYText(docPath: string): Y.Text {
    if (this.pendingLocalMarkdownDeletions.delete(docPath)) {
      this.scheduleCacheSave();
    }
    let fileId = this.pathToId.get(docPath);
    if (!fileId) {
      fileId = randomUUID();
      this.ydoc.transact(() => {
        this.pathToId.set(docPath, fileId!);
        this.idToPath.set(fileId!, docPath);
        this.docs.set(fileId!, new Y.Text());
        // 用户在墓碑之上重新创建了同名文件 → 清除墓碑
        if (this.fileTombstones.has(docPath)) {
          this.fileTombstones.delete(docPath);
        }
      }, 'local-meta');
    }
    let ytext = this.docs.get(fileId);
    if (!ytext) {
      ytext = new Y.Text();
      this.ydoc.transact(() => {
        this.docs.set(fileId!, ytext!);
      }, 'local-meta');
    }
    return ytext;
  }

  // ── Status API ────────────────────────────────────────────────────────────

  getStatus(): SyncStatus {
    let phase: SyncPhase;
    if (this.clientStatus === 'failed') {
      phase = 'error';
    } else if (!this.hasAuthenticated && (this.clientStatus === 'connecting' || this.clientStatus === 'reconnecting')) {
      phase = 'connecting';
    } else if (this.hasAuthenticated && !this.initialSyncComplete) {
      phase = 'authenticating';
    } else if (this.initialSyncComplete && (
      (this.blobSync?.pendingDownloadCount ?? 0) > 0 ||
      (this.blobSync?.pendingUploadCount ?? 0) > 0 ||
      (this.blobSync?.pendingRemoteDeleteCount ?? 0) > 0 ||
      (this.blobSync?.pendingLocalDeletionCount ?? 0) > 0
    )) {
      phase = 'syncing-blobs';
    } else if (this.initialSyncComplete && (this.blobSync?.pendingDownloadCount ?? 0) === 0) {
      phase = 'synced';
    } else {
      phase = 'disconnected';
    }

    let totalBlobBytes = 0;
    for (const [, ref] of this.pathToBlob) {
      totalBlobBytes += ref.size;
    }

    return {
      phase,
      markdownFileCount: this.pathToId.size,
      blobFileCount: this.pathToBlob.size,
      totalBlobBytes,
      pendingBlobDownloads: this.blobSync?.pendingDownloadCount ?? 0,
      pendingBlobUploads: this.blobSync?.pendingUploadCount ?? 0,
      pendingBlobRemoteDeletes: this.blobSync?.pendingRemoteDeleteCount ?? 0,
      pendingBlobLocalDeletions: this.blobSync?.pendingLocalDeletionCount ?? 0,
    };
  }

  onStatusChange(handler: (status: SyncStatus) => void): () => void {
    this.statusHandlers.push(handler);
    return () => {
      const idx = this.statusHandlers.indexOf(handler);
      if (idx !== -1) this.statusHandlers.splice(idx, 1);
    };
  }

  private notifyStatusChange(): void {
    const status = this.getStatus();
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }

  // ── SyncEngine interface ──────────────────────────────────────────────────

  async start(): Promise<void> {
    const vault = this.plugin.app.vault;
    const isReadOnly = !!this.mount?.readOnly;

    this.editorBindings = new EditorBindingManager({
      awareness: this.awareness,
      readOnly: isReadOnly,
      deviceName: this.deviceName,
      isPathForThisEngine: (p) => this.isPathForThisEngine(p),
      toDocPath: (p) => this.toDocPath(p),
      getOrCreateYText: (p) => this.getOrCreateYText(p),
    });

    this.plugin.registerEditorExtension(this.editorBindings.getBaseExtension());

    // Publish device name into awareness so y-codemirror.next renders it
    // as the cursor label instead of "anonymous".
    this.awareness.setLocalStateField('user', {
      name: this.deviceName,
    });

    this.bridge = new ObsidianFilesystemBridge(
      vault,
      (docPath) => this.getYText(docPath),
      this.ydoc,
      this.effectiveSettings.vaultId,
      this.toDocPath,
      this.toVaultPath,
      undefined, // getExternalEditPolicy — use default ('always')
      (vaultPath) => this.editorBindings.isHealthyBinding(vaultPath),
      (docPath) => this.handleExternalMarkdownDeletion(docPath),
      (docPath) => this.shouldBlockRemoteMarkdownFlush(docPath),
    );

    this.blobSync = new BlobSync(
      this.effectiveSettings.serverUrl,
      this.effectiveSettings.vaultId,
      this.effectiveSettings.token,
      vault,
      this.ydoc,
      this.toVaultPath,
      this.toDocPath,
      (vaultPath) => this.isPathForThisEngine(vaultPath),
      this.blobRuntimeStateStore,
      `${this.effectiveSettings.serverUrl}::${this.effectiveSettings.vaultId}`,
      this.mount?.localPath,
    );
    this.enterMarkdownStartupGate();
    this.blobSync.enterStartupGate();
    this.blobSync.onPendingDownloadsChange(() => this.notifyStatusChange());
    this.blobSync.onPendingUploadsChange(() => this.notifyStatusChange());
    this.blobSync.onPendingRemoteDeletesChange(() => this.notifyStatusChange());
    this.blobSync.onPendingLocalDeletionsChange(() => this.notifyStatusChange());

    // Propagate local Y.Doc updates to server
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || origin === 'cache' || origin === 'load') return;
      if (this.mount?.readOnly) return; // read-only mounts don't push updates
      this.client.send({ type: 'sync_update', update }).catch(console.error);
      this.scheduleCacheSave();
    });

    // Track markdown tombstone provenance for both cached startup state and remote updates.
    this.ydoc.on('afterTransaction', (txn: Y.Transaction) => {
      if (txn.origin === 'remote') {
        this.handleRemoteTransactionSideEffects(txn);
      } else {
        this.recordMarkdownTombstoneTransaction(txn);
      }
    });

    // Restore local cache after transaction observers are registered so cached
    // startup tombstones are classified before initial reconcile.
    await this.clearLegacyLocalCache();
    const cached = await this.cache.load(this.localCacheKey);
    if (cached) {
      Y.applyUpdate(this.ydoc, cached.ydocUpdate, 'cache');
    }
    await this.restoreMarkdownPending();

    // Handle incoming server messages
    this.client.onMessage(async (msg) => {
      if (msg.type === 'sync_state_vector') {
        const diff = Y.encodeStateAsUpdate(this.ydoc, msg.sv);
        await this.client.send({ type: 'sync_update', update: diff });
      } else if (msg.type === 'sync_update') {
        await this.handleRemoteUpdate(msg.update);
        if (this.awaitingInitialSync && !this.initialSyncComplete) {
          await this.completeInitialSync();
        }
      } else if (msg.type === 'awareness_update') {
        applyAwarenessUpdate(this.awareness, msg.payload, 'remote');
      } else if (msg.type === 'auth_ok') {
        await this.handleAuthOk();
      } else if (msg.type === 'auth_failed') {
        console.error('[VaultSync] auth failed:', msg.reason);
      } else if (msg.type === 'schema_mismatch') {
        console.error(`[VaultSync] schema mismatch: server=${msg.serverSchemaVersion} local=${SCHEMA_VERSION}`);
      } else if (msg.type === 'server_error') {
        console.error(`[VaultSync] server error [${msg.code}]: ${msg.message}`);
      }
    });

    // Propagate local awareness state to the server. Read-only mounts still
    // send presence so other devices can see read-only viewers.
    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === 'remote') return;
        const changed = added.concat(updated, removed);
        if (changed.length === 0) return;
        const payload = encodeAwarenessUpdate(this.awareness, changed);
        this.client.send({ type: 'awareness_update', payload }).catch(console.error);
      },
    );

    this.client.onStatusChange((s) => {
      this.clientStatus = s;
      this.notifyStatusChange();
    });

    await this.client.connect({
      serverUrl: this.effectiveSettings.serverUrl,
      vaultId: this.effectiveSettings.vaultId,
      token: this.effectiveSettings.token,
      schemaVersion: SCHEMA_VERSION,
      deviceId: this.effectiveSettings.deviceId,
      deviceName: this.effectiveSettings.deviceName || undefined,
    });

    this.plugin.registerEvent(this.plugin.app.workspace.on('active-leaf-change', () => {
      this.bindAllOpenEditors();
      this.validateAllOpenBindings();
    }));

    this.plugin.registerEvent(this.plugin.app.workspace.on('file-open', () => {
      this.bindAllOpenEditors();
      this.validateAllOpenBindings();
    }));

    this.plugin.registerEvent(this.plugin.app.workspace.on('layout-change', () => {
      this.bindAllOpenEditors();
      this.validateAllOpenBindings();
    }));

    this.blobRescanTimer = setInterval(() => {
      if (!this.initialSyncComplete || this.blobMaintenancePaused || !this.blobSync) return;
      const mode = this.mount?.readOnly ? 'conservative' : 'authoritative';
      this.blobSync.rescan(mode).catch((err) => {
        console.error('[VaultSync] blob rescan error:', err);
      });
    }, 60_000);

    this.plugin.registerEvent(
      this.plugin.app.workspace.on('editor-change', (_editor, info) => {
        const path = info?.file?.path;
        if (path) {
          this.bridge.notifyEditorActivity(path);
        }
      }),
    );

    // 只读挂载：不监听本地磁盘事件。
    // 远端 → 磁盘方向（afterTransaction remote 分支）仍正常工作。
    // 首次启动等待服务端基线完成，避免本地空目录参与初始化竞争。
    if (isReadOnly) {
      console.log(`[VaultSync:mount(${this.mount!.localPath})] started (read-only)`);
      return;
    }

    // Vault file events
    this.plugin.registerEvent(
      vault.on('create', (file: TAbstractFile) => {
        if (this.stopped) return;
        if (!this.isPathForThisEngine(file.path)) return;
        if (file.path.endsWith('.md')) {
          this.handleLocalFileChange(file.path).catch(console.error);
        } else {
          this.blobSync.handleLocalBlobChange(this.toDocPath(file.path)).catch(console.error);
        }
      }),
    );

    this.plugin.registerEvent(
      vault.on('modify', (file: TAbstractFile) => {
        if (this.stopped) return;
        if (!this.isPathForThisEngine(file.path)) return;
        if (file.path.endsWith('.md')) {
          this.handleLocalFileChange(file.path).catch(console.error);
        } else {
          this.blobSync.handleLocalBlobChange(this.toDocPath(file.path)).catch(console.error);
        }
      }),
    );

    this.plugin.registerEvent(
      vault.on('delete', (file: TAbstractFile) => {
        if (this.stopped) return;
        if (!this.isPathForThisEngine(file.path)) return;
        if (this.bridge.isExpectedDelete(file.path)) return; // 自写回声
        if (file.path.endsWith('.md')) {
          this.handleLocalFileDeletion(this.toDocPath(file.path));
        } else {
          this.blobSync.handleLocalBlobDeletion(this.toDocPath(file.path)).catch(console.error);
        }
      }),
    );

    this.plugin.registerEvent(
      vault.on('rename', (file: TAbstractFile, oldVaultPath: string) => {
        if (this.stopped) return;
        const wasOurs = this.isPathForThisEngine(oldVaultPath);
        const isOurs = this.isPathForThisEngine(file.path);

        if (wasOurs && isOurs) {
          // Rename within this engine's scope
          const oldIsMd = oldVaultPath.endsWith('.md');
          const newIsMd = file.path.endsWith('.md');
          if (oldIsMd && newIsMd) {
            this.handleLocalFileRename(oldVaultPath, file.path);
          } else if (oldIsMd && !newIsMd) {
            // md → 非 md：删除 markdown 条目，作为 blob 上传
            this.handleLocalFileDeletion(this.toDocPath(oldVaultPath));
            this.blobSync.handleLocalBlobChange(this.toDocPath(file.path)).catch(console.error);
          } else if (!oldIsMd && newIsMd) {
            // 非 md → md：删除 blob 条目，作为 markdown 导入
            this.blobSync.handleLocalBlobDeletion(this.toDocPath(oldVaultPath)).catch(console.error);
            this.handleLocalFileChange(file.path).catch(console.error);
          } else {
            // 非 md → 非 md：blob 路径变更
            this.blobSync.handleLocalBlobDeletion(this.toDocPath(oldVaultPath)).catch(console.error);
            this.blobSync.handleLocalBlobChange(this.toDocPath(file.path)).catch(console.error);
          }
        } else if (wasOurs && !isOurs) {
          // File moved OUT of this engine's scope (cross-mount)
          if (oldVaultPath.endsWith('.md')) this.handleLocalFileDeletion(this.toDocPath(oldVaultPath));
          else this.blobSync.handleLocalBlobDeletion(this.toDocPath(oldVaultPath)).catch(console.error);
        } else if (!wasOurs && isOurs) {
          // File moved INTO this engine's scope — Obsidian does NOT fire a separate
          // create event for renames, so we must synthesize it here.
          if (file.path.endsWith('.md')) {
            this.handleLocalFileChange(file.path).catch(console.error);
          } else {
            this.blobSync.handleLocalBlobChange(this.toDocPath(file.path)).catch(console.error);
          }
        }
      }),
    );

    // Bind to the currently open file (if any). layoutReady avoids the case
    // where the active MarkdownView has not mounted its EditorView yet.
    this.plugin.app.workspace.onLayoutReady(async () => {
      this.bindAllOpenEditors();
      this.validateAllOpenBindings();
    });

    // Periodic health check: validate bindings every 5 seconds to catch
    // CM instance replacements, facet loss, and other runtime degradations.
    this.healthCheckTimer = setInterval(() => {
      this.validateAllOpenBindings();
    }, 5_000);

    const label = this.mount ? `mount(${this.mount.localPath})` : 'primary';
    console.log(`[VaultSync:${label}] started`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.blobRescanTimer) {
      clearInterval(this.blobRescanTimer);
      this.blobRescanTimer = null;
    }
    this.editorBindings.unbindAll();
    this.awareness.destroy();
    await this.client.disconnect();
    await this.flushCacheSave();
    this.notifyStatusChange();
    this.statusHandlers = [];
  }

  /**
   * 只读挂载的协调：不扫描磁盘、不调用 markDirty，
   * 仅把 Y.Doc 中已有的全部文件落盘（服务端是权威）。
   */
  private async reconcileReadOnly(): Promise<void> {
    const paths: string[] = [];
    for (const [docPath] of this.pathToId) {
      if (this.fileTombstones.has(docPath)) {
        this.markdownTombstones.classifyBaseline(docPath, 'authoritative-delete');
        this.queueRemoteMarkdownDelete(docPath);
        continue;
      }
      paths.push(docPath);
    }
    for (const docPath of this.fileTombstones.keys()) {
      this.markdownTombstones.classifyBaseline(docPath, 'authoritative-delete');
      this.queueRemoteMarkdownDelete(docPath);
    }
    for (const docPath of paths) {
      await this.bridge.flushFile(docPath).catch((err) => {
        console.error(`[VaultSync] readOnly reconcile flushFile error for ${docPath}:`, err);
      });
    }
    // Read-only mounts should never accumulate local deletion pending.
    // Defensive clear in case any leaked in through code paths that don't
    // check readOnly before calling handleLocalFileDeletion.
    this.pendingLocalMarkdownDeletions.clear();
    console.log(`[VaultSync] readOnly reconcile — ${paths.length} files`);
  }

  async reconcile(): Promise<void> {
    if (this.mount?.readOnly) {
      await this.reconcileReadOnly();
      return;
    }
    const allFiles = this.plugin.app.vault.getMarkdownFiles() as TFile[];
    const files = allFiles.filter((f) => this.isPathForThisEngine(f.path));
    const localDocPaths = new Set<string>();
    for (const file of files) {
      const docPath = this.toDocPath(file.path);
      localDocPaths.add(docPath);
      this.knownLocalMarkdownPaths.add(docPath);
      this.getOrCreateYText(docPath);
      if (this.fileTombstones.has(docPath)) {
        const decision = this.markdownTombstones.getDecision(docPath);
        if (decision.kind === 'startup-baseline') {
          this.bridge.quarantineRemoteFlushes([docPath]);
          try {
            await this.bridge.forceImportFromDisk(docPath);
            this.fileTombstones.delete(docPath);
            this.markdownTombstones.classifyBaseline(docPath, 'stale-cleared');
          } catch (err) {
            this.markdownTombstones.classifyBaseline(docPath, 'failed');
            throw err;
          } finally {
            this.bridge.releaseRemoteFlushQuarantine([docPath]);
          }
          continue;
        }
        if (this.pendingRemoteMarkdownDeletes.has(docPath)) {
          continue;
        }
        // A local file that is present during authoritative startup reconcile is
        // stronger evidence than a legacy server tombstone. Clear the tombstone
        // so polluted server state converges back to the user's recovered file.
        this.fileTombstones.delete(docPath);
      }
      this.bridge.markDirty(file.path); // markDirty takes vaultPath, bridge converts
    }
    await this.bridge.drain();
    this.flushPendingLocalMarkdownDeletions(localDocPaths);
    // Materialize shared files that are absent from disk unless this session
    // has already confirmed the same path existed locally and then disappeared.
    for (const docPath of [...this.pathToId.keys()]) {
      if (localDocPaths.has(docPath)) continue;
      if (this.fileTombstones.has(docPath)) continue;
      if (this.knownLocalMarkdownPaths.has(docPath)) continue; // missing from disk → tombstone loop
      // File exists in Y.Doc but was never seen locally: write it to the new path.
      this.knownLocalMarkdownPaths.add(docPath);
      localDocPaths.add(docPath);
      await this.bridge.flushFile(docPath).catch((err) => {
        console.error(`[VaultSync] reconcile flushFile error for ${docPath}:`, err);
      });
    }
    // Detect paths this session has confirmed locally, then later found absent.
    // Only those in-session misses are treated as local deletions.
    for (const docPath of [...this.pathToId.keys()]) {
      if (localDocPaths.has(docPath)) continue;
      if (this.fileTombstones.has(docPath)) continue;
      if (!this.knownLocalMarkdownPaths.has(docPath)) continue;
      this.handleLocalFileDeletion(docPath);
    }
    console.log(`[VaultSync] reconcile — ${files.length} files (${this.mount?.localPath ?? 'primary'})`);
  }

  async handleLocalFileChange(vaultPath: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(vaultPath) as TFile | null;
    if (!file) return;

    const content = await this.plugin.app.vault.read(file);
    if (this.bridge.isSuppressed(vaultPath, content)) return;

    // Ensure the shared model has an entry for this path before drain runs.
    // Without this, brand-new files created outside the editor flow (e.g. via
    // vault.create from another tool) never get a Y.Text and drain silently
    // skips them in importFromDisk.
    const docPath = this.toDocPath(vaultPath);
    if (this.pendingLocalMarkdownDeletions.delete(docPath)) {
      this.scheduleCacheSave();
    }
    this.knownLocalMarkdownPaths.add(docPath);
    this.getOrCreateYText(docPath);
    this.bridge.markDirty(vaultPath);
  }

  handleLocalFileRename(oldVaultPath: string, newVaultPath: string): void {
    this.editorBindings?.unbindByPath(oldVaultPath);
    this.editorBindings?.updatePathsAfterRename(new Map([[oldVaultPath, newVaultPath]]));
    this.bridge?.updatePathAfterRename(oldVaultPath, newVaultPath);
    const oldDocPath = this.toDocPath(oldVaultPath);
    const newDocPath = this.toDocPath(newVaultPath);
    if (this.knownLocalMarkdownPaths.delete(oldDocPath)) {
      this.knownLocalMarkdownPaths.add(newDocPath);
    }
    const fileId = this.pathToId.get(oldDocPath);

    if (!fileId) {
      if (newVaultPath.endsWith('.md')) {
        this.getOrCreateYText(newDocPath);
        this.bridge.markDirty(newVaultPath);
      }
      return;
    }

    this.ydoc.transact(() => {
      this.pathToId.delete(oldDocPath);
      this.pathToId.set(newDocPath, fileId);
      this.idToPath.set(fileId, newDocPath);
    }, 'local-rename');
  }

  handleLocalFileDeletion(docPath: string): void {
    this.editorBindings?.unbindByPath(this.toVaultPath(docPath));
    this.knownLocalMarkdownPaths.delete(docPath);
    const fileId = this.pathToId.get(docPath);
    if (!fileId) {
      if (this.markdownDeleteGateState !== 'open' && !this.fileTombstones.has(docPath)) {
        this.pendingLocalMarkdownDeletions.add(docPath);
        this.scheduleCacheSave();
      }
      return;
    }

    this.writeLocalMarkdownTombstone(docPath, fileId);
  }

  private getExistingPendingLocalMarkdownPaths(): Set<string> {
    const existing = new Set<string>();
    for (const docPath of this.pendingLocalMarkdownDeletions) {
      if (this.plugin.app.vault.getAbstractFileByPath(this.toVaultPath(docPath))) {
        existing.add(docPath);
      }
    }
    return existing;
  }

  private flushPendingLocalMarkdownDeletionsFromDiskState(): void {
    this.flushPendingLocalMarkdownDeletions(this.getExistingPendingLocalMarkdownPaths());
  }

  private shouldBlockRemoteMarkdownFlush(docPath: string): boolean {
    if (this.fileTombstones.has(docPath)) return true;
    if (!this.pendingLocalMarkdownDeletions.has(docPath)) return false;
    return !this.plugin.app.vault.getAbstractFileByPath(this.toVaultPath(docPath));
  }

  private flushPendingLocalMarkdownDeletions(localDocPaths: Set<string>): void {
    let pendingChanged = false;
    for (const docPath of [...this.pendingLocalMarkdownDeletions]) {
      if (localDocPaths.has(docPath)) {
        this.pendingLocalMarkdownDeletions.delete(docPath);
        pendingChanged = true;
        continue;
      }
      const fileId = this.pathToId.get(docPath);
      if (!fileId) continue;
      this.writeLocalMarkdownTombstone(docPath, fileId);
    }
    if (pendingChanged) this.scheduleCacheSave();
  }

  private writeLocalMarkdownTombstone(docPath: string, fileId: string): void {
    this.pendingLocalMarkdownDeletions.delete(docPath);
    this.ydoc.transact(() => {
      this.pathToId.delete(docPath);
      this.idToPath.delete(fileId);
      this.docs.delete(fileId);
      this.fileTombstones.set(docPath, { deletedAt: new Date().toISOString() });
    }, 'local-delete');
  }

  private handleExternalMarkdownDeletion(docPath: string): void {
    if (!this.knownLocalMarkdownPaths.has(docPath)) return;
    this.handleLocalFileDeletion(docPath);
  }

  async handleRemoteUpdate(update: Uint8Array): Promise<void> {
    Y.applyUpdate(this.ydoc, update, 'remote');
  }

  async createSnapshot(): Promise<SnapshotMeta> {
    const httpBase = this.effectiveSettings.serverUrl.replace(/^ws(s?):\/\//, 'http$1://');
    const resp = await requestUrl({
      url: `${httpBase}/vault/${this.effectiveSettings.vaultId}/snapshots`,
      method: 'POST',
      headers: { Authorization: `Bearer ${this.effectiveSettings.token}` },
    });
    return resp.json as SnapshotMeta;
  }

  async restoreSnapshot(snapshotId: string): Promise<void> {
    const httpBase = this.effectiveSettings.serverUrl.replace(/^ws(s?):\/\//, 'http$1://');
    const resp = await requestUrl({
      url: `${httpBase}/vault/${this.effectiveSettings.vaultId}/snapshots/${snapshotId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.effectiveSettings.token}` },
    });

    const payload = new Uint8Array(resp.arrayBuffer);
    const snapDoc = new Y.Doc();
    Y.applyUpdate(snapDoc, payload, 'snapshot-load');

    const snapPathToId = snapDoc.getMap('pathToId') as Y.Map<string>;
    const snapDocs = snapDoc.getMap('docs') as Y.Map<Y.Text>;
    const snapFileTombstones = snapDoc.getMap('fileTombstones') as Y.Map<FileTombstone>;
    const snapPathToBlob = snapDoc.getMap('pathToBlob') as Y.Map<BlobRef>;
    const snapBlobTombstones = snapDoc.getMap('blobTombstones') as Y.Map<BlobTombstone>;

    const restoredMarkdownPaths = new Set<string>();
    const removedMarkdownPaths = new Set<string>();
    const materializedBlobPaths = new Set<string>();
    const removedBlobPaths = new Set<string>();
    const deletedAt = new Date().toISOString();

    this.ydoc.transact(() => {
      for (const [docPath, fileId] of this.pathToId) {
        if (snapPathToId.has(docPath)) continue;
        this.pathToId.delete(docPath);
        this.idToPath.delete(fileId);
        this.docs.delete(fileId);
        this.fileTombstones.set(docPath, { deletedAt });
        removedMarkdownPaths.add(docPath);
      }

      for (const [docPath, fileId] of snapPathToId) {
        const snapText = snapDocs.get(fileId);
        if (!snapText) continue;

        const snapContent = snapText.toString();
        const currentYText = this.getOrCreateYText(docPath);
        const currentContent = currentYText.toString();

        if (currentContent !== snapContent) {
          applyDiffToYText(currentYText, currentContent, snapContent, 'restore');
        }

        this.fileTombstones.delete(docPath);
        restoredMarkdownPaths.add(docPath);
      }

      for (const [docPath, tombstone] of snapFileTombstones) {
        if (snapPathToId.has(docPath)) continue;
        this.fileTombstones.set(docPath, tombstone);
        removedMarkdownPaths.add(docPath);
      }

      for (const [docPath, ref] of this.pathToBlob) {
        if (snapPathToBlob.has(docPath)) continue;
        this.pathToBlob.delete(docPath);
        this.blobTombstones.set(docPath, { hash: ref.hash, deletedAt });
        removedBlobPaths.add(docPath);
      }

      for (const [docPath, ref] of snapPathToBlob) {
        this.pathToBlob.set(docPath, ref);
        this.blobTombstones.delete(docPath);
        materializedBlobPaths.add(docPath);
      }

      for (const [docPath, tombstone] of snapBlobTombstones) {
        if (snapPathToBlob.has(docPath)) continue;
        this.blobTombstones.set(docPath, tombstone);
        removedBlobPaths.add(docPath);
      }
    }, 'restore');

    for (const docPath of removedMarkdownPaths) {
      this.knownLocalMarkdownPaths.delete(docPath);
    }

    for (const docPath of restoredMarkdownPaths) {
      this.knownLocalMarkdownPaths.add(docPath);
    }

    for (const docPath of removedMarkdownPaths) {
      await this.bridge.deleteFile(docPath).catch((err) => {
        console.error(`[VaultSync] restore deleteFile error for ${docPath}:`, err);
      });
    }

    for (const docPath of restoredMarkdownPaths) {
      await this.bridge.flushFile(docPath).catch((err) => {
        console.error(`[VaultSync] restore flushFile error for ${docPath}:`, err);
      });
    }

    for (const docPath of removedBlobPaths) {
      await this.blobSync.deleteLocalBlob(docPath).catch((err) => {
        console.error(`[VaultSync] restore delete blob error for ${docPath}:`, err);
      });
    }

    for (const docPath of materializedBlobPaths) {
      await this.blobSync.materializeBlob(docPath).catch((err) => {
        console.error(`[VaultSync] restore materialize blob error for ${docPath}:`, err);
      });
    }

    this.bindAllOpenEditors();
    this.validateAllOpenBindings();

    snapDoc.destroy();
    console.log(
      `[VaultSync] restored snapshot ${snapshotId} — ${restoredMarkdownPaths.size} markdown, ${materializedBlobPaths.size} blobs`,
    );
  }

  // ── Local cache ───────────────────────────────────────────────────────────

  private scheduleCacheSave(): void {
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => {
      this.flushCacheSave().catch(console.error);
    }, 3_000);
  }

  private async flushCacheSave(): Promise<void> {
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer);
      this.cacheTimer = null;
    }
    const update = Y.encodeStateAsUpdate(this.ydoc);
    await this.cache.save(this.localCacheKey, {
      vaultId: this.localCacheKey,
      ydocUpdate: update,
      updatedAt: new Date().toISOString(),
    });
    await this.persistMarkdownPending();
  }

  private async persistMarkdownPending(): Promise<void> {
    await this.markdownPendingStore.save(this.localCacheKey, {
      vaultId: this.localCacheKey,
      pendingLocalDeletions: [...this.pendingLocalMarkdownDeletions],
      localPath: this.mount?.localPath,
      updatedAt: new Date().toISOString(),
    });
  }

  private async restoreMarkdownPending(): Promise<void> {
    const saved = await this.markdownPendingStore.load(this.localCacheKey);
    if (!saved) return;
    if (saved.localPath !== this.mount?.localPath) return;

    for (const docPath of saved.pendingLocalDeletions) {
      if (this.pendingLocalMarkdownDeletions.has(docPath)) continue;
      // File has reappeared on disk → user likely undid the delete
      if (this.plugin.app.vault.getAbstractFileByPath(this.toVaultPath(docPath))) continue;
      // Tombstone already written → no need to keep pending
      if (this.fileTombstones.has(docPath)) continue;
      this.pendingLocalMarkdownDeletions.add(docPath);
    }
  }

  private getUnambiguousRemoteRenameTarget(removedDocPath: string, txn: Y.Transaction): string | null {
    const removedFileId = this.remotePathRemovalFileIds.get(txn)?.get(removedDocPath);
    if (!removedFileId) return null;

    const changedPaths = changedMapKeys(txn, this.pathToId);
    const targets = changedPaths.filter((changedPath) => {
      return changedPath !== removedDocPath && this.pathToId.get(changedPath) === removedFileId;
    });
    return targets.length === 1 ? targets[0] : null;
  }

  private enterMarkdownStartupGate(): void {
    this.markdownDeleteGateState = 'startup-blocked';
  }

  private enterMarkdownMaintenanceGate(): void {
    this.markdownDeleteGateState = 'maintenance-blocked';
  }

  private queueRemoteMarkdownDelete(docPath: string): void {
    this.pendingRemoteMarkdownDeletes.add(docPath);
  }

  private async openMarkdownDeleteGate(): Promise<void> {
    this.markdownDeleteGateState = 'open';
    // Remote updates can attach fileIds to pending local deletions while the
    // gate is in maintenance. Flush them once the gate opens so the delete
    // intent does not wait for another remote transaction.
    this.flushPendingLocalMarkdownDeletionsFromDiskState();
    for (const decision of this.markdownTombstones.getReplayDecisions()) {
      this.queueRemoteMarkdownDelete(decision.path);
    }
    for (const docPath of this.fileTombstones.keys()) {
      if (this.markdownTombstones.getDecision(docPath).kind === 'absent') {
        this.queueRemoteMarkdownDelete(docPath);
      }
    }
    await this.flushPendingRemoteMarkdownDeletes();
  }

  private recordMarkdownTombstoneTransaction(txn: Y.Transaction): void {
    const tombMap = this.fileTombstones;
    if (!mapChanged(txn, tombMap)) return;

    const changes = changedMapKeys(txn, tombMap).map((path) => ({
      path,
      tombstone: tombMap.get(path),
    }));
    const origin = this.getTombstoneReceiptOrigin(txn.origin);
    const provenance = this.getTombstoneReceiptProvenance(origin);
    this.markdownTombstones.applyTransaction(changes, { origin, provenance });

    const startupBaselinePaths = changes
      .filter((change) => change.tombstone !== undefined)
      .map((change) => this.markdownTombstones.getDecision(change.path))
      .filter((decision) => decision.kind === 'startup-baseline' && decision.status === 'unclassified')
      .map((decision) => decision.path);
    if (startupBaselinePaths.length > 0 && this.bridge) {
      this.bridge.quarantineRemoteFlushes(startupBaselinePaths);
    }

    const clearedPaths = changes.filter((change) => change.tombstone === undefined).map((change) => change.path);
    if (clearedPaths.length > 0 && this.bridge) {
      this.bridge.releaseRemoteFlushQuarantine(clearedPaths);
    }
  }

  private getTombstoneReceiptOrigin(origin: unknown): TombstoneReceiptOrigin {
    if (origin === 'remote') return 'remote';
    if (origin === 'cache') return 'cache';
    if (origin === 'self') return 'self';
    return 'local';
  }

  private getTombstoneReceiptProvenance(origin: TombstoneReceiptOrigin): TombstoneReceiptProvenance {
    if (origin === 'cache') return 'cache-startup';
    if (this.markdownDeleteGateState === 'startup-blocked') return 'startup-remote';
    if (this.markdownDeleteGateState === 'maintenance-blocked') {
      // Both startup and reconnect maintenance set initialSyncComplete=true
      // before entering maintenance-blocked, so we can't reliably distinguish
      // them here. Both provenances are treated identically by
      // MarkdownTombstoneState (as live-delete), so this is cosmetic only.
      return this.initialSyncComplete ? 'reconnect-maintenance' : 'startup-maintenance';
    }
    return 'open';
  }

  private async flushPendingRemoteMarkdownDeletes(): Promise<void> {
    const pending = [...this.pendingRemoteMarkdownDeletes];
    this.pendingRemoteMarkdownDeletes.clear();
    for (const docPath of pending) {
      await this.applyRemoteMarkdownDelete(docPath);
    }
  }

  private async applyRemoteMarkdownDelete(docPath: string): Promise<void> {
    if (!this.fileTombstones.has(docPath)) return;
    this.editorBindings?.unbindByPath(this.toVaultPath(docPath));
    this.bridge.notifyFileClosed(this.toVaultPath(docPath));
    await this.bridge.deleteFile(docPath).catch((err) => {
      console.error(`[VaultSync] deleteFile error for ${docPath}:`, err);
    });
  }

  private handleRemoteTransactionSideEffects(txn: Y.Transaction): void {
    this.recordMarkdownTombstoneTransaction(txn);
    // Only flush pending local deletions when the gate is fully open.
    // During startup/maintenance the authoritative flush happens in reconcile()
    // with a proper localDocPaths set — flushing here with an empty set would
    // convert every pending path into a tombstone prematurely.
    if (this.markdownDeleteGateState === 'open') {
      this.flushPendingLocalMarkdownDeletionsFromDiskState();
    }
    const changedDocIds = mapChanged(txn, this.docs) ? changedMapKeys(txn, this.docs) : [];
    this.bridge.handleRemoteTransaction(txn, this.docs, this.idToPath, changedDocIds);

    // Remote markdown tombstones are replayed once startup/maintenance can
    // safely distinguish stale server pollution from authoritative deletes.
    const tombMap = this.fileTombstones;
    if (mapChanged(txn, tombMap)) {
      for (const docPath of changedMapKeys(txn, tombMap)) {
        if (tombMap.has(docPath)) {
          const decision = this.markdownTombstones.getDecision(docPath);
          const replayable = decision.replayable;
          if (this.markdownDeleteGateState === 'open' && replayable) {
            this.applyRemoteMarkdownDelete(docPath).catch((err) => {
              console.error(`[VaultSync] markdown delete side effect error for ${docPath}:`, err);
            });
          } else if (replayable) {
            this.queueRemoteMarkdownDelete(docPath);
          }
        }
      }
    }

    // 远端 markdown 重命名 → 本地同步路径变更
    // rename 只改 pathToId/idToPath，不改 docs（Y.Text 内容不变），
    // handleRemoteTransaction 检测不到，需要单独处理。
    if (mapChanged(txn, this.pathToId)) {
      for (const docPath of changedMapKeys(txn, this.pathToId)) {
        const fileId = this.pathToId.get(docPath);
        if (!fileId) {
          // 路径从 pathToId 中移除：只有同一事务能证明它是单目标 rename 的源路径时，才清理本地旧路径。
          if (!this.fileTombstones.has(docPath) && this.getUnambiguousRemoteRenameTarget(docPath, txn)) {
            this.editorBindings.unbindByPath(this.toVaultPath(docPath));
            this.bridge.notifyFileClosed(this.toVaultPath(docPath));
            this.bridge.deleteFile(docPath).catch((err) => {
              console.error(`[VaultSync] remote rename cleanup error for ${docPath}:`, err);
            });
          }
        } else {
          // 路径新增到 pathToId：如果 docs 有对应 Y.Text 且本地无该文件，
          // 说明是 rename 的目标路径，物化到磁盘。
          if (this.docs.get(fileId) && !this.plugin.app.vault.getAbstractFileByPath(this.toVaultPath(docPath))) {
            this.bridge.flushFile(docPath).catch((err) => {
              console.error(`[VaultSync] remote rename flush error for ${docPath}:`, err);
            });
          }
        }
      }
    }

    this.blobSync.handleRemoteBlobChanges(txn).catch((err) => {
      console.error('[VaultSync] blobSync remote changes error:', err);
    });
  }

  private getOpenMarkdownViews(): MarkdownView[] {
    const leaves = this.plugin.app.workspace.getLeavesOfType('markdown') as unknown as Array<{ view: MarkdownView }>;
    return leaves.map((leaf) => leaf.view).filter((view): view is MarkdownView => !!view && !!view.file);
  }

  private bindAllOpenEditors(): void {
    const views = this.getOpenMarkdownViews().filter((view) => this.isPathForThisEngine(view.file!.path));
    this.bridge.syncOpenFiles(views.map((view) => view.file!.path));
    this.editorBindings.bindAllOpenEditors(views, this.deviceName);
  }

  private validateAllOpenBindings(): void {
    const views = this.getOpenMarkdownViews().filter((view) => this.isPathForThisEngine(view.file!.path));
    this.editorBindings.validateAllOpenBindings(views, this.deviceName);
  }

  private async handleAuthOk(): Promise<void> {
    const sv = Y.encodeStateVector(this.ydoc);
    await this.client.send({ type: 'sync_state_vector', sv });
    if (this.hasAuthenticated) {
      this.enterMarkdownMaintenanceGate();
      await this.reconcile();
      await this.runBlobMaintenance(this.mount?.readOnly ? 'conservative' : 'authoritative');
      await this.openMarkdownDeleteGate();
      this.bindAllOpenEditors();
      this.validateAllOpenBindings();
    } else {
      this.awaitingInitialSync = true;
    }
    this.hasAuthenticated = true;
    this.notifyStatusChange();
  }

  private async completeInitialSync(): Promise<void> {
    this.awaitingInitialSync = false;
    this.initialSyncComplete = true;
    this.enterMarkdownMaintenanceGate();

    let maintenanceComplete = false;
    try {
      if (this.mount?.readOnly) {
        await this.reconcileReadOnly();
        await this.runBlobMaintenance('conservative');
      } else {
        await this.reconcile();
        await this.runBlobMaintenance('authoritative');
      }
      maintenanceComplete = true;
    } catch (err) {
      this.markPendingStartupTombstonesFailed();
      throw err;
    }
    if (maintenanceComplete) {
      await this.openMarkdownDeleteGate();
    }
    this.bindAllOpenEditors();
    this.validateAllOpenBindings();
    this.notifyStatusChange();
  }

  private markPendingStartupTombstonesFailed(): void {
    for (const docPath of this.markdownTombstones.getPendingPaths().baseline) {
      this.markdownTombstones.classifyBaseline(docPath, 'failed');
    }
  }

  private async runBlobMaintenance(mode: 'authoritative' | 'conservative'): Promise<void> {
    if (!this.blobSync) return;
    this.blobMaintenancePaused = true;
    this.blobSync.enterMaintenanceGate();
    try {
      await this.blobSync.restoreRuntimeState();
      await this.blobSync.reconcile(mode);
    } finally {
      await this.blobSync.openRemoteApplyGate();
      this.blobMaintenancePaused = false;
    }
  }

  // ── Snapshot / file download API ──────────────────────────────────────────

  async listSnapshots(): Promise<SnapshotMeta[]> {
    const httpBase = this.effectiveSettings.serverUrl.replace(/^ws(s?):\/\//, 'http$1://');
    const resp = await requestUrl({
      url: `${httpBase}/vault/${this.effectiveSettings.vaultId}/snapshots`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.effectiveSettings.token}` },
    });
    return (resp.json as { snapshots: SnapshotMeta[] }).snapshots;
  }

  async getSnapshotManifest(snapshotId: string): Promise<SnapshotManifest> {
    const httpBase = this.effectiveSettings.serverUrl.replace(/^ws(s?):\/\//, 'http$1://');
    const resp = await requestUrl({
      url: `${httpBase}/vault/${this.effectiveSettings.vaultId}/snapshots/${snapshotId}/manifest`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.effectiveSettings.token}` },
    });
    return resp.json as SnapshotManifest;
  }

  async downloadSnapshotFile(snapshotId: string, docPath: string): Promise<DownloadedFile> {
    const httpBase = this.effectiveSettings.serverUrl.replace(/^ws(s?):\/\//, 'http$1://');
    const encodedPath = docPath.split('/').map(encodeURIComponent).join('/');
    const resp = await requestUrl({
      url: `${httpBase}/vault/${this.effectiveSettings.vaultId}/snapshots/${snapshotId}/files/${encodedPath}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.effectiveSettings.token}` },
    });
    const contentType = resp.headers['content-type'] ?? 'application/octet-stream';
    if (contentType.includes('text/markdown')) {
      return { text: resp.text, contentType };
    }
    return { binary: resp.arrayBuffer, contentType };
  }

  async downloadCurrentFile(docPath: string): Promise<DownloadedFile> {
    const httpBase = this.effectiveSettings.serverUrl.replace(/^ws(s?):\/\//, 'http$1://');
    const encodedPath = docPath.split('/').map(encodeURIComponent).join('/');
    const resp = await requestUrl({
      url: `${httpBase}/vault/${this.effectiveSettings.vaultId}/files/${encodedPath}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.effectiveSettings.token}` },
    });
    const contentType = resp.headers['content-type'] ?? 'application/octet-stream';
    if (contentType.includes('text/markdown')) {
      return { text: resp.text, contentType };
    }
    return { binary: resp.arrayBuffer, contentType };
  }

  async exportVaultZip(): Promise<ArrayBuffer> {
    const httpBase = this.effectiveSettings.serverUrl.replace(/^ws(s?):\/\//, 'http$1://');
    const resp = await requestUrl({
      url: `${httpBase}/vault/${this.effectiveSettings.vaultId}/files/export`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.effectiveSettings.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paths: [] }),
    });
    return resp.arrayBuffer;
  }

  async downloadSnapshotZip(snapshotId: string): Promise<ArrayBuffer> {
    const httpBase = this.effectiveSettings.serverUrl.replace(/^ws(s?):\/\//, 'http$1://');
    const resp = await requestUrl({
      url: `${httpBase}/vault/${this.effectiveSettings.vaultId}/snapshots/${snapshotId}/download`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.effectiveSettings.token}` },
    });
    return resp.arrayBuffer;
  }
}
