import type { Plugin } from 'obsidian';
import type { SnapshotMeta } from '@salt-sync/shared';
import type { SharedDirectoryMount } from '@salt-sync/shared';
import type { SaltSyncSettings } from '../settings';
import { VaultSyncEngine } from './vaultSync';
import type { SnapshotManifest, DownloadedFile } from './vaultSync';

// ── SyncScope ─────────────────────────────────────────────────────────────────

/**
 * 某个同步范围（主库或某个共享目录挂载）对外暴露的快照/文件 API。
 * SnapshotDetailModal、ScopePickerModal 等 UI 组件只依赖此接口，
 * 不直接持有 SyncManager 或 VaultSyncEngine。
 */
export interface SyncScope {
  /** 显示名称，用于 scope 选择器（主库 / 共享目录本地路径） */
  readonly label: string;
  listSnapshots(): Promise<SnapshotMeta[]>;
  getSnapshotManifest(snapshotId: string): Promise<SnapshotManifest>;
  downloadSnapshotZip(snapshotId: string): Promise<ArrayBuffer>;
  /**
   * 下载快照中某个文件。
   * vaultPath：vault 相对路径（含挂载前缀）；scope 内部转换为 docPath。
   */
  downloadSnapshotFile(snapshotId: string, vaultPath: string): Promise<DownloadedFile>;
  restoreSnapshot(snapshotId: string): Promise<void>;
  createSnapshot(): Promise<SnapshotMeta>;
  exportVaultZip(): Promise<ArrayBuffer>;
}

// ── helpers ───────────────────────────────────────────────────────────────────

interface ManagedMountEngine {
  mount: SharedDirectoryMount;
  engine: VaultSyncEngine;
}

export interface SyncStartResult {
  primaryStarted: boolean;
  primaryError?: Error;
  failedMounts: Array<{ mount: SharedDirectoryMount; error: Error }>;
  startedMountCount: number;
}

// ── SyncManager ───────────────────────────────────────────────────────────────

/**
 * 管理主 vault + 所有共享目录挂载的生命周期。
 * main.ts 只与 SyncManager 交互，不直接持有 VaultSyncEngine。
 *
 * 初始化顺序：先构造全部引擎（以确定各挂载前缀），再统一 start()。
 */
export class SyncManager {
  private readonly primaryEngine: VaultSyncEngine | null;
  private readonly mountEngines: ManagedMountEngine[];

  constructor(plugin: Plugin, settings: SaltSyncSettings) {
    const enabledMounts = (settings.sharedMounts ?? []).filter((mount) => mount.enabled);
    const mountPrefixes = enabledMounts.map((m) => m.localPath);

    this.primaryEngine = settings.vaultSyncEnabled
      ? new VaultSyncEngine(plugin, settings, null, mountPrefixes)
      : null;

    this.mountEngines = enabledMounts.map(
      (mount) => ({ mount, engine: new VaultSyncEngine(plugin, settings, mount, []) }),
    );
  }

  async start(): Promise<SyncStartResult> {
    let primaryStarted = false;
    let primaryError: Error | undefined;
    const failedMounts: Array<{ mount: SharedDirectoryMount; error: Error }> = [];
    let startedMountCount = 0;

    if (this.primaryEngine) {
      try {
        await this.primaryEngine.start();
        primaryStarted = true;
      } catch (err) {
        primaryError = err instanceof Error ? err : new Error(String(err));
        await this.primaryEngine.stop().catch(console.error);
      }
    }

    for (const { mount, engine } of this.mountEngines) {
      try {
        await engine.start();
        startedMountCount++;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[SyncManager] Failed to start mount engine ${mount.localPath}:`, error);
        failedMounts.push({ mount, error });
        await engine.stop().catch(console.error);
      }
    }

    return { primaryStarted, primaryError, failedMounts, startedMountCount };
  }

  async stop(): Promise<void> {
    if (this.primaryEngine) {
      await this.primaryEngine.stop();
    }
    for (const { engine } of this.mountEngines) {
      await engine.stop().catch((err) => {
        console.error(`[SyncManager] Failed to stop mount engine:`, err);
      });
    }
  }

  async reconcile(): Promise<void> {
    if (this.primaryEngine) {
      await this.primaryEngine.reconcile();
    }
    for (const { engine } of this.mountEngines) {
      await engine.reconcile().catch((err) => {
        console.error(`[SyncManager] Mount reconcile error:`, err);
      });
    }
  }

  // ── Scope API ─────────────────────────────────────────────────────────────

  /** 是否有任意同步引擎（主库或挂载）正在运行 */
  get hasAnySync(): boolean {
    return this.primaryEngine !== null || this.mountEngines.length > 0;
  }

  /** 兼容旧调用：是否启用了主库同步 */
  get hasPrimarySync(): boolean {
    return this.primaryEngine !== null;
  }

  /**
   * 返回所有可用的同步范围（主库在前，挂载按顺序在后）。
   * 用于命令面板的 scope 选择器。
   */
  getAvailableScopes(): SyncScope[] {
    const scopes: SyncScope[] = [];
    if (this.primaryEngine) {
      scopes.push(this.makeScope(this.primaryEngine, '主库', null));
    }
    for (const { mount, engine } of this.mountEngines) {
      scopes.push(this.makeScope(engine, mount.localPath, mount.localPath));
    }
    return scopes;
  }

  /**
   * 按 vault 路径返回对应的同步范围。
   * 先匹配挂载前缀，找不到则 fallback 到主库。
   */
  getScopeForPath(vaultPath: string): SyncScope | null {
    for (const { mount, engine } of this.mountEngines) {
      if (vaultPath.startsWith(mount.localPath + '/') || vaultPath === mount.localPath) {
        return this.makeScope(engine, mount.localPath, mount.localPath);
      }
    }
    if (this.primaryEngine) {
      return this.makeScope(this.primaryEngine, '主库', null);
    }
    return null;
  }

  /**
   * 将引擎包装为 SyncScope。
   * mountPrefix: 该挂载的本地路径前缀，用于将 vaultPath 转换为 docPath；
   *              主库传 null（vaultPath === docPath）。
   */
  private makeScope(
    engine: VaultSyncEngine,
    label: string,
    mountPrefix: string | null,
  ): SyncScope {
    const toDocPath = (vaultPath: string): string => {
      if (!mountPrefix) return vaultPath;
      const prefix = mountPrefix + '/';
      return vaultPath.startsWith(prefix) ? vaultPath.slice(prefix.length) : vaultPath;
    };

    return {
      label,
      listSnapshots: () => engine.listSnapshots(),
      getSnapshotManifest: (id) => engine.getSnapshotManifest(id),
      downloadSnapshotZip: (id) => engine.downloadSnapshotZip(id),
      downloadSnapshotFile: (id, vaultPath) => engine.downloadSnapshotFile(id, toDocPath(vaultPath)),
      restoreSnapshot: (id) => engine.restoreSnapshot(id),
      createSnapshot: () => engine.createSnapshot(),
      exportVaultZip: () => engine.exportVaultZip(),
    };
  }
}
