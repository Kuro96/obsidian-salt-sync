import React, { useState } from 'react';
import type { SharedDirectoryMount } from '@salt-sync/shared';
import type SaltSyncPlugin from '../main';
import { Toggle } from './common/Toggle';
import { useSyncStatus } from './common/useSyncStatus';
import { SyncStatusBadge } from './common/SyncStatusBadge';

interface Props {
  mounts: SharedDirectoryMount[];
  onSave: (mounts: SharedDirectoryMount[]) => void;
  plugin?: SaltSyncPlugin;
}

interface FormState {
  localPath: string;
  vaultId: string;
  token: string;
  serverUrl: string;
  readOnly: boolean;
}

const emptyForm = (): FormState => ({
  localPath: '',
  vaultId: '',
  token: '',
  serverUrl: '',
  readOnly: false,
});

function MountField({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-item">
      <div className="setting-item-info">
        <div className="setting-item-name">{label}</div>
        {description ? <div className="setting-item-description">{description}</div> : null}
      </div>
      <div className="setting-item-control">{children}</div>
    </div>
  );
}

function MountStatusBadge({ plugin, vaultId }: { plugin: SaltSyncPlugin; vaultId: string }) {
  const status = useSyncStatus(plugin, vaultId);
  return <SyncStatusBadge status={status} />;
}

export function SharedMountsSettings({ mounts: initialMounts, onSave, plugin }: Props) {
  const [mounts, setMounts] = useState<SharedDirectoryMount[]>(initialMounts);
  const [adding, setAdding] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [error, setError] = useState('');

  const save = (updated: SharedDirectoryMount[]) => {
    setMounts(updated);
    onSave(updated);
  };

  const remove = (index: number) => {
    save(mounts.filter((_, i) => i !== index));
  };

  const validate = (): boolean => {
    const normalizedPath = form.localPath.trim();
    if (!form.localPath.trim()) { setError('本地路径不能为空'); return false; }
    if (!form.vaultId.trim()) { setError('Vault ID 不能为空'); return false; }
    if (!form.token.trim()) { setError('Token 不能为空'); return false; }
    if (mounts.some((m, i) => m.localPath === normalizedPath && i !== editingIndex)) {
      setError('该本地路径已存在挂载');
      return false;
    }
    setError('');
    return true;
  };

  const submit = () => {
    if (!validate()) return;
    const mount: SharedDirectoryMount = {
      enabled: editingIndex === null ? true : mounts[editingIndex].enabled ?? true,
      localPath: form.localPath.trim(),
      vaultId: form.vaultId.trim(),
      token: form.token.trim(),
      ...(form.serverUrl.trim() ? { serverUrl: form.serverUrl.trim() } : {}),
      ...(form.readOnly ? { readOnly: true } : {}),
    };
    if (editingIndex === null) {
      save([...mounts, mount]);
    } else {
      save(mounts.map((item, index) => (index === editingIndex ? mount : item)));
    }
    setForm(emptyForm());
    setAdding(false);
    setEditingIndex(null);
  };

  const edit = (index: number) => {
    const mount = mounts[index];
    setForm({
      localPath: mount.localPath,
      vaultId: mount.vaultId,
      token: mount.token,
      serverUrl: mount.serverUrl ?? '',
      readOnly: !!mount.readOnly,
    });
    setEditingIndex(index);
    setAdding(true);
    setError('');
  };

  const cancel = () => {
    setForm(emptyForm());
    setError('');
    setAdding(false);
    setEditingIndex(null);
  };

  const toggleEnabled = (index: number, enabled: boolean) => {
    save(mounts.map((item, itemIndex) => (itemIndex === index ? { ...item, enabled } : item)));
  };

  return (
    <div className="salt-sync-mounts">
      <div className="setting-item setting-item-heading">共享目录挂载</div>
      <div className="setting-item-description" style={{ paddingBottom: 8 }}>
        将 vault 中的某个子目录与独立的服务端 vault room 绑定，并为每个挂载单独控制是否启用同步。
      </div>

      {mounts.length === 0 && !adding && (
        <div className="setting-item-description">暂无共享目录挂载</div>
      )}

      {mounts.map((mount, i) => (
        <div key={i} className="salt-sync-mount-row">
          <div className="salt-sync-mount-info">
            <span className="salt-sync-mount-path">{mount.localPath}/</span>
            <span className="salt-sync-mount-meta">
              → {mount.vaultId}
              {mount.enabled === false ? ' [已停用]' : ''}
              {mount.readOnly ? ' [只读]' : ''}
              {mount.serverUrl ? ` (${mount.serverUrl})` : ''}
            </span>
            {plugin && mount.enabled !== false && (
              <MountStatusBadge plugin={plugin} vaultId={mount.vaultId} />
            )}
          </div>
          <div className="salt-sync-mount-actions">
            <Toggle
              checked={mount.enabled !== false}
              onChange={(enabled) => toggleEnabled(i, enabled)}
              ariaLabel={`${mount.localPath} 挂载同步开关`}
            />
            <button
              aria-label="编辑挂载"
              onClick={() => edit(i)}
            >
              编辑
            </button>
            <button
              aria-label="删除挂载"
              onClick={() => remove(i)}
            >
              ✕
            </button>
          </div>
        </div>
      ))}

      {adding ? (
        <div className="salt-sync-mount-form">
          <MountField label="本地路径" description="Vault 内的子目录，例如 Shared">
            <input
              type="text"
              placeholder="例如 Shared"
              value={form.localPath}
              onChange={(e) => setForm({ ...form, localPath: e.target.value })}
            />
          </MountField>
          <MountField label="远端 Vault ID" description="该共享目录对应的远端 room 标识">
            <input
              type="text"
              placeholder="服务端 Vault ID"
              value={form.vaultId}
              onChange={(e) => setForm({ ...form, vaultId: e.target.value })}
            />
          </MountField>
          <MountField label="鉴权令牌" description="访问该共享目录 room 的鉴权令牌">
            <input
              type="text"
              placeholder="鉴权令牌"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
          </MountField>
          <MountField label="服务器地址" description="留空时复用主库的服务器地址">
            <input
              type="text"
              placeholder="留空则使用主库服务器地址"
              value={form.serverUrl}
              onChange={(e) => setForm({ ...form, serverUrl: e.target.value })}
            />
          </MountField>
          <MountField label="只读模式" description="启用后不会把本地修改上传到远端">
            <Toggle
              checked={form.readOnly}
              onChange={(readOnly) => setForm({ ...form, readOnly })}
              ariaLabel="只读模式开关"
            />
          </MountField>
          {error && <div className="salt-sync-error">{error}</div>}
          <div className="salt-sync-form-actions">
            <button className="mod-cta" onClick={submit}>{editingIndex === null ? '确认添加' : '保存修改'}</button>
            <button onClick={cancel}>取消</button>
          </div>
        </div>
      ) : (
        <div className="setting-item">
          <button className="mod-cta" onClick={() => setAdding(true)}>
            添加共享目录挂载
          </button>
        </div>
      )}
    </div>
  );
}
