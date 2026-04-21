import React from 'react';
import type { SyncStatus } from '../../sync/vaultSync';
import { formatBytes } from './formatBytes';

interface Props {
  status: SyncStatus | null;
}

const DOT: React.CSSProperties = {
  display: 'inline-block',
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  marginRight: '6px',
  verticalAlign: 'middle',
};

const COLORS: Record<string, string> = {
  disconnected: 'var(--text-muted)',
  connecting: '#e8a020',
  authenticating: '#e8a020',
  'syncing-blobs': 'var(--interactive-accent)',
  synced: '#4caf50',
  error: 'var(--text-error)',
};

function phaseLabel(status: SyncStatus): string {
  switch (status.phase) {
    case 'disconnected': return '未连接';
    case 'connecting':
    case 'authenticating': return '连接中…';
    case 'syncing-blobs': {
      const pending =
        status.pendingBlobDownloads +
        status.pendingBlobUploads +
        status.pendingBlobRemoteDeletes +
        status.pendingBlobLocalDeletions;
      return `同步中（附件 ${pending} 个待处理）`;
    }
    case 'synced': {
      const filePart = `${status.markdownFileCount + status.blobFileCount} 个文件`;
      const sizePart = status.totalBlobBytes > 0 ? `，${formatBytes(status.totalBlobBytes)} 附件` : '';
      return `已同步（${filePart}${sizePart}）`;
    }
    case 'error': return '连接失败';
  }
}

export function SyncStatusBadge({ status }: Props) {
  if (!status || status.phase === 'disconnected') return null;
  const color = COLORS[status.phase] ?? 'var(--text-muted)';
  return (
    <span style={{ fontSize: 'var(--font-ui-small)', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center' }}>
      <span style={{ ...DOT, backgroundColor: color }} />
      {phaseLabel(status)}
    </span>
  );
}
