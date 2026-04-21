import { useState, useEffect } from 'react';
import type SaltSyncPlugin from '../../main';
import type { SyncStatus } from '../../sync/vaultSync';

export function useSyncStatus(plugin: SaltSyncPlugin, key: 'primary' | string): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(() => plugin.getSyncStatus(key));

  useEffect(() => {
    // 每次 plugin 或 key 变化时重新读取初始状态
    setStatus(plugin.getSyncStatus(key));
    const unsubscribe = plugin.onSyncStatusChange((changedKey, newStatus) => {
      if (changedKey === key) setStatus(newStatus);
    });
    return unsubscribe;
  }, [plugin, key]);

  return status;
}
