import React, { useState } from 'react';
import { Notice } from 'obsidian';
import type SaltSyncPlugin from '../main';
import { Toggle } from './common/Toggle';
import { randomUUID } from '../util';
import { useSyncStatus } from './common/useSyncStatus';
import { SyncStatusBadge } from './common/SyncStatusBadge';

function SettingItem({
  name,
  description,
  children,
}: {
  name: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-item">
      <div className="setting-item-info">
        <div className="setting-item-name">{name}</div>
        {description ? <div className="setting-item-description">{description}</div> : null}
      </div>
      <div className="setting-item-control">{children}</div>
    </div>
  );
}

function normalizeIgnoreFilePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\/+/g, '');
}

export function PrimaryVaultSettings({ plugin }: { plugin: SaltSyncPlugin }) {
  const [vaultSyncEnabled, setVaultSyncEnabled] = useState(plugin.settings.vaultSyncEnabled);
  const [serverUrl, setServerUrl] = useState(plugin.settings.serverUrl);
  const [vaultId, setVaultId] = useState(plugin.settings.vaultId);
  const [token, setToken] = useState(plugin.settings.token);
  const [deviceName, setDeviceName] = useState(plugin.settings.deviceName);
  const [ignoreFilePath, setIgnoreFilePath] = useState(plugin.settings.ignoreFilePath ?? '');
  const primaryStatus = useSyncStatus(plugin, 'primary');

  return (
    <>
      <SettingItem
        name="启用主库同步"
        description="同步当前 vault，但排除由共享目录挂载接管的子目录"
      >
        <Toggle
          checked={vaultSyncEnabled}
          ariaLabel="启用主库同步"
          onChange={async (v) => {
            plugin.settings.vaultSyncEnabled = v;
            await plugin.saveSettings();
            await plugin.refreshSync();
            setVaultSyncEnabled(v);
          }}
        />
      </SettingItem>

      {vaultSyncEnabled && (
        <div className="setting-item">
          <div className="setting-item-info">
            <div className="setting-item-name">同步状态</div>
          </div>
          <div className="setting-item-control">
            <SyncStatusBadge status={primaryStatus} />
          </div>
        </div>
      )}

      <SettingItem
        name="服务器地址"
        description="salt-sync 服务端的 WebSocket 地址，例如 ws://localhost:3000"
      >
        <input
          type="text"
          placeholder="ws://localhost:3000"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          onBlur={async () => {
            plugin.settings.serverUrl = serverUrl.trim();
            await plugin.saveSettings();
          }}
        />
      </SettingItem>

      <SettingItem
        name="主库 Vault ID"
        description="当前 vault 的唯一标识；留空时可自动生成"
      >
        <input
          type="text"
          placeholder="自动生成"
          value={vaultId}
          onChange={(e) => setVaultId(e.target.value)}
          onBlur={async () => {
            plugin.settings.vaultId = vaultId.trim();
            await plugin.saveSettings();
          }}
        />
        <button
          onClick={async () => {
            const newId = randomUUID();
            setVaultId(newId);
            plugin.settings.vaultId = newId;
            await plugin.saveSettings();
            new Notice('已生成新的 Vault ID');
          }}
        >
          生成
        </button>
      </SettingItem>

      <SettingItem
        name="主库令牌"
        description="访问主 vault 的鉴权令牌，需与服务端配置匹配"
      >
        <input
          type="text"
          placeholder="dev-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onBlur={async () => {
            plugin.settings.token = token.trim();
            await plugin.saveSettings();
          }}
        />
      </SettingItem>

      <SettingItem
        name="设备名称"
        description="当前设备的显示名称，可选"
      >
        <input
          type="text"
          placeholder="我的笔记本"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          onBlur={async () => {
            plugin.settings.deviceName = deviceName.trim();
            await plugin.saveSettings();
          }}
        />
      </SettingItem>

      <SettingItem
        name="可选忽略文件"
        description="语法遵循 .gitignore；留空时不启用额外忽略规则"
      >
        <input
          type="text"
          placeholder="例如 .salt-sync-ignore"
          value={ignoreFilePath}
          onChange={(e) => setIgnoreFilePath(e.target.value)}
          onBlur={async () => {
            const nextIgnoreFilePath = normalizeIgnoreFilePath(ignoreFilePath);
            const currentIgnoreFilePath = plugin.settings.ignoreFilePath ?? '';

            setIgnoreFilePath(nextIgnoreFilePath);
            if (nextIgnoreFilePath === currentIgnoreFilePath) return;

            plugin.settings.ignoreFilePath = nextIgnoreFilePath;
            await plugin.saveSettings();
            await plugin.refreshSync();
          }}
        />
      </SettingItem>

      <SettingItem
        name="设备 ID"
        description="稳定设备标识，自动生成，请勿手动修改"
      >
        <input
          type="text"
          value={plugin.settings.deviceId}
          disabled
        />
      </SettingItem>
    </>
  );
}
