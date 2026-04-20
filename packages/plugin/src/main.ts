import { Plugin, Notice, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, SaltSyncSettingTab } from './settings';
import type { SaltSyncSettings } from './settings';
import { SyncManager } from './sync/syncManager';
import type { SyncScope } from './sync/syncManager';
import { resolveDeviceId } from './storage/deviceId';
import { SnapshotPickerModal } from './ui/snapshotPickerModal';
import { SnapshotDetailModal } from './ui/snapshotDetailModal';
import { ScopePickerModal } from './ui/scopePickerModal';
import { DiffPreviewModal } from './ui/diffPreviewModal';

export default class SaltSyncPlugin extends Plugin {
  settings!: SaltSyncSettings;
  private manager: SyncManager | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new SaltSyncSettingTab(this.app, this));

    this.addCommand({
      id: 'start-sync',
      name: 'Start sync',
      callback: () => this.startSync(),
    });

    this.addCommand({
      id: 'stop-sync',
      name: 'Stop sync',
      callback: () => this.stopSync(),
    });

    this.addCommand({
      id: 'create-snapshot',
      name: 'Create snapshot',
      callback: () => this.runWithScope((scope) => {
        scope.createSnapshot()
          .then((meta) => new Notice(`快照已创建：${meta.snapshotId.slice(0, 8)}`))
          .catch((err) => { console.error('[salt-sync] create snapshot error:', err); new Notice('创建快照失败'); });
      }),
    });

    this.addCommand({
      id: 'browse-snapshots',
      name: 'Browse snapshots',
      callback: () => this.runWithScope((scope) => {
        scope.listSnapshots()
          .then((snapshots) => {
            if (snapshots.length === 0) { new Notice('暂无快照'); return; }
            new SnapshotPickerModal(this.app, snapshots, (meta) => {
              new SnapshotDetailModal(this.app, meta, scope).open();
            }).open();
          })
          .catch((err) => { console.error('[salt-sync] list snapshots error:', err); new Notice('加载快照列表失败'); });
      }),
    });

    this.addCommand({
      id: 'export-vault',
      name: 'Export current vault as ZIP',
      callback: () => this.runWithScope((scope) => {
        new Notice('Salt Sync：正在导出…');
        scope.exportVaultZip()
          .then(async (zipData) => {
            const filename = `vault-export-${new Date().toISOString().slice(0, 10)}.zip`;
            await this.app.vault.adapter.writeBinary(filename, zipData);
            new Notice(`导出完成：${filename}`);
          })
          .catch((err) => { console.error('[salt-sync] export vault error:', err); new Notice('导出失败，请查看控制台日志'); });
      }),
    });

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, abstractFile) => {
        if (!(abstractFile instanceof TFile)) return;
        if (!this.manager?.hasAnySync) return;
        const file = abstractFile;
        const manager = this.manager;
        menu.addItem((item) => {
          item.setTitle('查看历史版本').setIcon('history').onClick(() => {
            const scope = manager.getScopeForPath(file.path);
            if (!scope) { new Notice('Salt Sync：该文件没有对应的同步范围'); return; }
            scope.listSnapshots()
              .then((snapshots) => {
                if (snapshots.length === 0) { new Notice('暂无快照'); return; }
                new SnapshotPickerModal(this.app, snapshots, (meta) => {
                  this.restoreFileFromSnapshot(scope, meta.snapshotId, file);
                }).open();
              })
              .catch((err) => { console.error('[salt-sync] list snapshots error:', err); new Notice('加载快照列表失败'); });
          });
        });
      }),
    );

    if (this.shouldStartAnySync()) {
      this.app.workspace.onLayoutReady(() => {
        this.startSync().catch(console.error);
      });
    }

    console.log('[salt-sync] plugin loaded');
  }

  async onunload(): Promise<void> {
    await this.stopSync();
    console.log('[salt-sync] plugin unloaded');
  }

  async startSync(): Promise<void> {
    const enabledMounts = (this.settings.sharedMounts ?? []).filter((mount) => mount.enabled);
    const needsDefaultServerUrl = this.settings.vaultSyncEnabled || enabledMounts.some((mount) => !mount.serverUrl?.trim());

    if (this.manager) return;
    if (!this.shouldStartAnySync()) return;

    if (needsDefaultServerUrl && !this.settings.serverUrl) {
      new Notice('Salt Sync：请先配置主库/默认服务器地址。');
      return;
    }

    if (this.settings.vaultSyncEnabled && (!this.settings.vaultId || !this.settings.token)) {
      new Notice('Salt Sync：请先配置主库同步所需的 Vault ID 和令牌。');
      return;
    }

    if (!this.settings.vaultSyncEnabled && enabledMounts.length === 0) {
      new Notice('Salt Sync：当前没有启用任何同步项。');
      return;
    }

    this.manager = new SyncManager(this, this.settings);
    try {
      const result = await this.manager.start();

      if (result.primaryError) {
        console.error('[salt-sync] primary sync start error:', result.primaryError);
        this.settings.vaultSyncEnabled = false;
        new Notice(`Salt Sync：主库连接失败，已自动关闭。${result.primaryError.message}`);
      }

      if (result.failedMounts.length > 0) {
        const failedPaths = new Set(result.failedMounts.map(({ mount }) => mount.localPath));
        this.settings.sharedMounts = (this.settings.sharedMounts ?? []).map((mount) => (
          failedPaths.has(mount.localPath) ? { ...mount, enabled: false } : mount
        ));
        for (const { mount, error } of result.failedMounts) {
          console.error(`[salt-sync] mount sync start error (${mount.localPath}):`, error);
          new Notice(`Salt Sync：共享目录 ${mount.localPath} 连接失败，已自动关闭。${error.message}`);
        }
      }

      if (result.primaryError || result.failedMounts.length > 0) {
        await this.saveSettings();
      }

      if (!result.primaryStarted && result.startedMountCount === 0) {
        await this.manager.stop().catch(console.error);
        this.manager = null;
        return;
      }

      new Notice('Salt Sync：已连接');
    } catch (err) {
      console.error('[salt-sync] startSync error:', err);
      this.manager = null;
      new Notice('Salt Sync：连接失败，请查看控制台日志');
    }
  }

  async stopSync(): Promise<void> {
    if (!this.manager) return;
    await this.manager.stop();
    this.manager = null;
    new Notice('Salt Sync：已断开连接');
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<SaltSyncSettings> & { deviceId?: string } | null;
    const legacySharedMountSyncEnabled = saved?.sharedMountSyncEnabled ?? saved?.enabled ?? false;
    const sharedMounts = (saved?.sharedMounts ?? DEFAULT_SETTINGS.sharedMounts ?? []).map((mount) => ({
      ...mount,
      enabled: mount.enabled ?? legacySharedMountSyncEnabled,
    }));

    this.settings = { ...DEFAULT_SETTINGS, ...saved, sharedMounts };

    if (saved && typeof saved.enabled === 'boolean') {
      if (saved.vaultSyncEnabled === undefined) {
        this.settings.vaultSyncEnabled = saved.enabled;
      }
    }

    this.settings.deviceId = await resolveDeviceId(saved?.deviceId ?? undefined);

    let needsSave = false;

    const legacyName = (saved as { deviceName?: string } | null)?.deviceName ?? '';
    if (legacyName && !this.settings.deviceNames?.[this.settings.deviceId]) {
      this.settings.deviceNames = {
        ...(this.settings.deviceNames ?? {}),
        [this.settings.deviceId]: legacyName,
      };
      needsSave = true;
    }

    this.settings.deviceName = this.settings.deviceNames?.[this.settings.deviceId] ?? '';

    if (saved?.deviceId) needsSave = true;

    if (needsSave) await this.saveSettings();
  }

  async refreshSync(): Promise<void> {
    const wasRunning = !!this.manager;
    if (wasRunning) {
      await this.stopSync();
    }
    if (this.shouldStartAnySync()) {
      await this.startSync();
    }
  }

  private shouldStartAnySync(): boolean {
    return this.settings.vaultSyncEnabled || (this.settings.sharedMounts ?? []).some((mount) => mount.enabled);
  }

  async saveSettings(): Promise<void> {
    const { enabled, sharedMountSyncEnabled, deviceId, deviceName, ...settings } = this.settings;
    void enabled;
    void sharedMountSyncEnabled;
    void deviceId;
    await this.saveData({
      ...settings,
      deviceNames: {
        ...(settings.deviceNames ?? {}),
        [this.settings.deviceId]: deviceName,
      },
    });
  }

  /**
   * 对命令面板操作执行 scope 路由：
   * - 未启动同步：提示错误
   * - 单一 scope：直接执行
   * - 多个 scope：弹出选择器后执行
   */
  private runWithScope(action: (scope: SyncScope) => void): void {
    if (!this.manager) { new Notice('Salt Sync：请先启动同步'); return; }
    const scopes = this.manager.getAvailableScopes();
    if (scopes.length === 0) { new Notice('Salt Sync：请先启动同步'); return; }
    if (scopes.length === 1) {
      action(scopes[0]);
      return;
    }
    new ScopePickerModal(this.app, scopes, action).open();
  }

  private restoreFileFromSnapshot(scope: SyncScope, snapshotId: string, file: TFile): void {
    scope.downloadSnapshotFile(snapshotId, file.path)
      .then(async (downloaded) => {
        if ('text' in downloaded) {
          // Markdown 文件：展示 diff 预览，用户确认后再覆盖
          const currentContent = await this.app.vault.read(file);
          const historicalContent = downloaded.text;
          new DiffPreviewModal(
            this.app,
            currentContent,
            historicalContent,
            file.name,
            async () => {
              try {
                await this.app.vault.modify(file, historicalContent);
                new Notice(`已恢复：${file.name}`);
              } catch (err) {
                console.error('[salt-sync] restore file write error:', err);
                new Notice('写入失败，请查看控制台日志');
              }
            },
          ).open();
        } else {
          // 附件（blob）：直接另存为 .bak，无需 diff
          const bakPath = file.path.replace(/(\.[^.]+)$/, `.${Date.now()}.bak$1`);
          await this.app.vault.adapter.writeBinary(bakPath, downloaded.binary);
          new Notice(`附件已另存为：${bakPath}`);
        }
      })
      .catch((err) => {
        console.error('[salt-sync] restore file from snapshot error:', err);
        new Notice('恢复失败，请查看控制台日志');
      });
  }
}
