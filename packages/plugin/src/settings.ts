import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type SaltSyncPlugin from './main';
import type { SharedDirectoryMount } from '@salt-sync/shared';
import { SharedMountsSettings } from './components/SharedMountsSettings';
import { randomUUID } from './util';

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

export class SaltSyncSettingTab extends PluginSettingTab {
  private mountsRoot: Root | null = null;

  constructor(
    app: App,
    private plugin: SaltSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Tear down previous React root if any
    this.mountsRoot?.unmount();
    this.mountsRoot = null;

    containerEl.createEl('h2', { text: 'Salt Sync 设置' });

    new Setting(containerEl)
      .setName('启用主库同步')
      .setDesc('同步当前 vault，但排除由共享目录挂载接管的子目录')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.vaultSyncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.vaultSyncEnabled = value;
            await this.plugin.saveSettings();
            await this.plugin.refreshSync();
          }),
      );

    new Setting(containerEl)
      .setName('服务器地址')
      .setDesc('salt-sync 服务端的 WebSocket 地址，例如 ws://localhost:3000')
      .addText((text) =>
        text
          .setPlaceholder('ws://localhost:3000')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('主库 Vault ID')
      .setDesc('当前 vault 的唯一标识；留空时可自动生成')
      .addText((text) =>
        text
          .setPlaceholder('自动生成')
          .setValue(this.plugin.settings.vaultId)
          .onChange(async (value) => {
            this.plugin.settings.vaultId = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText('生成').onClick(async () => {
          this.plugin.settings.vaultId = randomUUID();
          await this.plugin.saveSettings();
          this.display();
          new Notice('已生成新的 Vault ID');
        }),
      );

    new Setting(containerEl)
      .setName('主库令牌')
      .setDesc('访问主 vault 的鉴权令牌，需与服务端配置匹配')
      .addText((text) =>
        text
          .setPlaceholder('dev-token')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('设备名称')
      .setDesc('当前设备的显示名称，可选')
      .addText((text) =>
        text
          .setPlaceholder('我的笔记本')
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('设备 ID')
      .setDesc('稳定设备标识，自动生成，请勿手动修改')
      .addText((text) =>
        text.setValue(this.plugin.settings.deviceId).setDisabled(true),
      );

    // ── 共享目录挂载（React）────────────────────────────────────────────────
    containerEl.createEl('hr');
    const mountsContainer = containerEl.createDiv('salt-sync-mounts-container');
    this.mountsRoot = createRoot(mountsContainer);
    this.mountsRoot.render(
      React.createElement(SharedMountsSettings, {
        mounts: this.plugin.settings.sharedMounts ?? [],
        onSave: async (mounts: SharedDirectoryMount[]) => {
          this.plugin.settings.sharedMounts = mounts;
          await this.plugin.saveSettings();
          await this.plugin.refreshSync();
        },
      }),
    );
  }

  hide(): void {
    this.mountsRoot?.unmount();
    this.mountsRoot = null;
  }
}
