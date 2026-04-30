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

const MAX_PENDING_DETAIL_ROWS = 20;

const BLOB_KIND_LABELS: Record<SyncStatus['pendingBlobItems'][number]['kind'], string> = {
  download: '下载',
  upload: '上传',
  'remote-delete': '远端删除',
  'local-delete': '本地删除',
};

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

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
  const pendingDetailsId = React.useId();
  const [isPendingDetailsOpen, setIsPendingDetailsOpen] = React.useState(false);
  if (!status || status.phase === 'disconnected') return null;
  const color = COLORS[status.phase] ?? 'var(--text-muted)';
  const pendingBlobItems = status.phase === 'syncing-blobs' ? status.pendingBlobItems : [];
  const visiblePendingBlobItems = pendingBlobItems.slice(0, MAX_PENDING_DETAIL_ROWS);
  const hiddenPendingBlobItemCount = pendingBlobItems.length - visiblePendingBlobItems.length;
  const hasPendingBlobItems = status.phase === 'syncing-blobs' && pendingBlobItems.length > 0;
  return (
    <span
      tabIndex={hasPendingBlobItems ? 0 : undefined}
      aria-describedby={hasPendingBlobItems && isPendingDetailsOpen ? pendingDetailsId : undefined}
      onMouseEnter={hasPendingBlobItems ? () => setIsPendingDetailsOpen(true) : undefined}
      onMouseLeave={hasPendingBlobItems ? () => setIsPendingDetailsOpen(false) : undefined}
      onFocus={hasPendingBlobItems ? () => setIsPendingDetailsOpen(true) : undefined}
      onBlur={hasPendingBlobItems ? () => setIsPendingDetailsOpen(false) : undefined}
      style={{
        position: 'relative',
        fontSize: 'var(--font-ui-small)',
        color: 'var(--text-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        maxWidth: '100%',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <span style={{ ...DOT, backgroundColor: color }} />
        {phaseLabel(status)}
      </span>
      {hasPendingBlobItems && isPendingDetailsOpen ? (
        <span
          id={pendingDetailsId}
          role="tooltip"
          style={{
            position: 'absolute',
            zIndex: 'var(--layer-popover)',
            top: 'calc(100% + var(--size-2-2))',
            right: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--size-2-1)',
            minWidth: 'min(320px, calc(100vw - var(--size-4-8)))',
            maxWidth: 'min(420px, calc(100vw - var(--size-4-8)))',
            maxHeight: 'min(320px, 40vh)',
            overflowY: 'auto',
            padding: 'var(--size-4-2) var(--size-4-3)',
            border: '1px solid var(--background-modifier-border)',
            borderRadius: 'var(--radius-m)',
            background: 'var(--background-primary)',
            boxShadow: 'var(--shadow-s)',
            color: 'var(--text-muted)',
            lineHeight: 'var(--line-height-tight)',
          }}
        >
          {visiblePendingBlobItems.map((item, index) => (
            <span key={`${item.kind}:${item.path}:${item.hash ?? ''}:${index}`} style={{ display: 'block', wordBreak: 'break-word' }}>
              <span style={{ color: 'var(--text-normal)' }}>{BLOB_KIND_LABELS[item.kind]}</span>
              <span>{`：${item.path}`}</span>
              {item.hash ? <span style={{ color: 'var(--text-faint)' }}>{` · hash ${shortHash(item.hash)}`}</span> : null}
            </span>
          ))}
          {hiddenPendingBlobItemCount > 0 ? (
            <span style={{ color: 'var(--text-faint)' }}>{`另有 ${hiddenPendingBlobItemCount} 个附件待处理`}</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
