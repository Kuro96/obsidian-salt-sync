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
} from '@salt-sync/shared';
import type { SaltSyncSettings } from '../settings';
import { IndexedDbBlobRuntimeStateStore, IndexedDbLocalCache } from '../storage/indexedDbStore';
import { RoomClient } from './roomClient';
import { EditorBindingManager } from './editorBinding';
import { ObsidianFilesystemBridge } from './filesystemBridge';
import { BlobSync } from './blobSync';
import { applyDiffToYText } from './diff';
import { randomUUID, changedMapKeys, mapChanged } from '../util';

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

  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private blobRescanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deviceName: string;
  private hasAuthenticated = false;
  private awaitingInitialSync = false;
  private initialSyncComplete = false;
  private blobMaintenancePaused = true;

  /** Effective settings for this engine (may differ from plugin settings for mounts) */
  private readonly effectiveSettings: SaltSyncSettings;

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
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  /** vault 路径 → 共享模型路径（去除挂载前缀） */
  private toDocPath = (vaultPath: string): string => {
    if (!this.mount) return vaultPath;
    const prefix = this.mount.localPath + '/';
    return vaultPath.startsWith(prefix) ? vaultPath.slice(prefix.length) : vaultPath;
  };

  /** 共享模型路径 → vault 路径（还原挂载前缀） */
  private toVaultPath = (docPath: string): string => {
    if (!this.mount) return docPath;
    return this.mount.localPath + '/' + docPath;
  };

  /** Syncthing 产生的元数据目录和冲突文件，不应被同步 */
  private static isSyncthingArtifact(vaultPath: string): boolean {
    const segments = vaultPath.split('/');
    return segments.some((s) => s === '.stfolder' || s === '.stversions' || s === '.stignore')
      || segments.some((s) => s.includes('.sync-conflict-'));
  }

  /**
   * 判断某个 vaultPath 是否归属本引擎处理：
   * - 主 vault：不在任何挂载前缀下
   * - 挂载引擎：必须在 mount.localPath/ 下
   * - 排除 Syncthing 产生的元数据和冲突文件
   */
  isPathForThisEngine(vaultPath: string): boolean {
    if (VaultSyncEngine.isSyncthingArtifact(vaultPath)) return false;
    if (this.mount) {
      return vaultPath.startsWith(this.mount.localPath + '/');
    }
    return !this.excludedPrefixes.some((p) => vaultPath.startsWith(p + '/'));
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
    );
    this.blobSync.enterStartupGate();

    // Restore local cache
    const cached = await this.cache.load(this.effectiveSettings.vaultId);
    if (cached) {
      Y.applyUpdate(this.ydoc, cached.ydocUpdate, 'cache');
    }

    // Propagate local Y.Doc updates to server
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || origin === 'cache' || origin === 'load') return;
      if (this.mount?.readOnly) return; // read-only mounts don't push updates
      this.client.send({ type: 'sync_update', update }).catch(console.error);
      this.scheduleCacheSave();
    });

    // Flush changed files / blobs to disk after remote updates
    this.ydoc.on('afterTransaction', (txn: Y.Transaction) => {
      if (txn.origin !== 'remote') return;

      const changedDocIds = mapChanged(txn, this.docs) ? changedMapKeys(txn, this.docs) : [];
      this.bridge.handleRemoteTransaction(txn, this.docs, this.idToPath, changedDocIds);

      // 远端 markdown 删除 → 本地删除对应文件
      const tombMap = this.fileTombstones;
      if (mapChanged(txn, tombMap)) {
        for (const docPath of changedMapKeys(txn, tombMap)) {
          if (tombMap.has(docPath)) {
            this.editorBindings.unbindByPath(this.toVaultPath(docPath));
            this.bridge.notifyFileClosed(this.toVaultPath(docPath));
            this.bridge.deleteFile(docPath).catch((err) => {
              console.error(`[VaultSync] deleteFile error for ${docPath}:`, err);
            });
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
            // 路径从 pathToId 中移除：如果没有 tombstone，说明是 rename 的源路径，清理本地文件。
            if (!this.fileTombstones.has(docPath)) {
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
    });

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
  }

  /**
   * 只读挂载的协调：不扫描磁盘、不调用 markDirty，
   * 仅把 Y.Doc 中已有的全部文件落盘（服务端是权威）。
   */
  private async reconcileReadOnly(): Promise<void> {
    const paths: string[] = [];
    for (const [docPath] of this.pathToId) paths.push(docPath);
    for (const docPath of paths) {
      await this.bridge.flushFile(docPath).catch((err) => {
        console.error(`[VaultSync] readOnly reconcile flushFile error for ${docPath}:`, err);
      });
    }
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
      this.bridge.markDirty(file.path); // markDirty takes vaultPath, bridge converts
    }
    await this.bridge.drain();
    // Detect files present in the shared model but absent locally.
    // These were deleted while the plugin was not running (or the delete event
    // was missed). Write a tombstone so the remote copy is not written back.
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
    if (!fileId) return;

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
    await this.cache.save(this.effectiveSettings.vaultId, {
      vaultId: this.effectiveSettings.vaultId,
      ydocUpdate: update,
      updatedAt: new Date().toISOString(),
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
      await this.reconcile();
      await this.runBlobMaintenance(this.mount?.readOnly ? 'conservative' : 'authoritative');
      this.bindAllOpenEditors();
      this.validateAllOpenBindings();
    } else {
      this.awaitingInitialSync = true;
    }
    this.hasAuthenticated = true;
  }

  private async completeInitialSync(): Promise<void> {
    this.awaitingInitialSync = false;
    this.initialSyncComplete = true;

    if (this.mount?.readOnly) {
      await this.reconcileReadOnly();
      await this.runBlobMaintenance('conservative');
    } else {
      await this.reconcile();
      await this.runBlobMaintenance('authoritative');
    }
    this.bindAllOpenEditors();
    this.validateAllOpenBindings();
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
