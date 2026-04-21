import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App, PluginSettingTab } from 'obsidian';
import type SaltSyncPlugin from './main';
import type { SharedDirectoryMount } from '@salt-sync/shared';
import { SharedMountsSettings } from './components/SharedMountsSettings';
import { PrimaryVaultSettings } from './components/PrimaryVaultSettings';

export interface SaltSyncSettings {
  serverUrl: string;
  vaultId: string;
  token: string;
  /**
   * 当前设备的唯一标识（运行时字段，不持久化到 data.json）。
   * Desktop 由 OS 信息确定性派生；Mobile 存于 IndexedDB。
   * 两种方式都不会被 Syncthing 等工具同步到其他设备。
   */
  deviceId: string;
  /**
   * 当前设备的显示名称（运行时字段，不直接持久化）。
   * 持久化时写入 deviceNames[deviceId]，加载时从中读出。
   */
  deviceName: string;
  /**
   * 各设备显示名称的 map，以 deviceId 为 key。
   * data.json 通过 Syncthing 等工具同步时，各设备名称互不覆盖。
   */
  deviceNames?: Record<string, string>;
  vaultSyncEnabled: boolean;
  /** 兼容旧配置：逐条挂载启用前的全局共享目录开关 */
  sharedMountSyncEnabled?: boolean;
  enabled?: boolean;
  /** 共享目录挂载列表（Phase 5） */
  sharedMounts?: SharedDirectoryMount[];
}

export const DEFAULT_SETTINGS: SaltSyncSettings = {
  serverUrl: 'ws://localhost:3000',
  vaultId: '',
  token: 'dev-token',
  deviceId: '',      // 占位，onload 时由 resolveDeviceId() 覆盖
  deviceName: '',    // 占位，loadSettings() 时从 deviceNames[deviceId] 读取
  deviceNames: {},
  vaultSyncEnabled: false,
  sharedMounts: [],
};

function SettingsRoot({ plugin }: { plugin: SaltSyncPlugin }) {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('h2', null, 'Salt Sync 设置'),
    React.createElement(PrimaryVaultSettings, { plugin }),
    React.createElement('hr', null),
    React.createElement(SharedMountsSettings, {
      plugin,
      mounts: plugin.settings.sharedMounts ?? [],
      onSave: async (mounts: SharedDirectoryMount[]) => {
        plugin.settings.sharedMounts = mounts;
        await plugin.saveSettings();
        await plugin.refreshSync();
      },
    }),
  );
}

export class SaltSyncSettingTab extends PluginSettingTab {
  private root: Root | null = null;

  constructor(
    app: App,
    private plugin: SaltSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    this.root?.unmount();
    this.root = null;
    containerEl.empty();
    this.root = createRoot(containerEl);
    this.root.render(React.createElement(SettingsRoot, { plugin: this.plugin }));
  }

  hide(): void {
    this.root?.unmount();
    this.root = null;
  }
}
