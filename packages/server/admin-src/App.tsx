import React, { useCallback, useEffect, useMemo, useState } from 'react';

type NavKey = 'overview' | 'rooms' | 'snapshots' | 'tokens' | 'blob-gc' | 'config';
type ThemeMode = 'dark' | 'light';
type StatusTone = 'default' | 'success' | 'danger';
type TokenStatus = 'active' | 'revoked' | 'expired';

interface OverviewPayload {
  status: string;
  timestamp: string;
  uptimeSeconds: number;
  rooms: { active: number; vaultIds: string[] };
  schemaVersion: number;
  tokenMode: string;
}

interface RoomMeta {
  vaultId: string;
  connectedClientCount: number;
  loaded: boolean;
  updatedAt?: string;
}

interface RoomDetailPayload {
  vaultId: string;
  active: boolean;
  room: RoomMeta | null;
  state: {
    markdownPathCount: number;
    markdownDocCount: number;
    blobPathCount: number;
    fileTombstoneCount: number;
    blobTombstoneCount: number;
    loaded: boolean;
  } | null;
  persistence: {
    currentCheckpointVersion: number;
    nextSeq: number;
    journalEntryCount: number;
    journalTotalBytes: number;
    updatedAt: string;
  } | null;
}

interface SnapshotMeta {
  snapshotId: string;
  vaultId: string;
  createdAt: string;
  markdownFileCount: number;
  blobFileCount: number;
}

interface TokenRecord {
  id: string;
  name: string;
  tokenPrefix: string;
  status: TokenStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  note: string | null;
}

interface ConfigPayload {
  auth: {
    tokenMode: string;
    adminTokenConfigured: boolean;
    envFallbackAvailable: boolean;
    legacyVaultTokenCount: number;
    dbTokenCount: number;
  };
  storage: {
    dataDir: string | null;
    s3Endpoint: string | null;
    s3Region: string | null;
    s3Bucket: string | null;
  };
  snapshot: {
    retentionDays: number | null;
    maxCount: number | null;
  };
}

interface ApiError {
  error?: string;
}

interface TokensListPayload {
  tokens: TokenRecord[];
  tokenMode: string;
}

interface TokenMutationPayload {
  token: TokenRecord;
  rawToken?: string;
}

interface SnapshotManifestPayload {
  snapshotId: string;
  createdAt: string;
  files: Array<{
    path: string;
    type: string;
    size: number;
    hash?: string;
    contentType?: string;
  }>;
}

function apiFetch(path: string, token: string, init: RequestInit = {}) {
  return fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function requestJson<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, token, init);
  const payload = await readJson<T | ApiError>(response);
  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'error' in payload && payload.error
      ? payload.error
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function requestBlob(path: string, token: string, init?: RequestInit): Promise<Blob> {
  const response = await apiFetch(path, token, init);
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = await readJson<ApiError>(response);
      if (payload.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  return response.blob();
}

function elapsed(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function statusTone(status: string): StatusTone {
  if (status === 'active' || status === 'ok') return 'success';
  if (status === 'revoked' || status === 'expired' || status === 'error') return 'danger';
  return 'default';
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function AppStyles() {
  return (
    <style>{`
      :root {
        color-scheme: dark;
        --bg-primary: #131319;
        --bg-secondary: #1a1b24;
        --bg-tertiary: #202230;
        --bg-hover: rgba(167, 139, 250, 0.12);
        --border-color: rgba(255, 255, 255, 0.08);
        --border-strong: rgba(255, 255, 255, 0.16);
        --text-primary: #e7e7ef;
        --text-secondary: #b1b2c4;
        --text-muted: #87889b;
        --accent: #a78bfa;
        --accent-strong: #8b5cf6;
        --accent-contrast: #f5f3ff;
        --success: #38b28a;
        --danger: #dd5e73;
        --warning: #f2b44f;
        --shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
        --radius-lg: 16px;
        --radius-md: 12px;
        --radius-sm: 10px;
        --nav-width: 232px;
        --font-stack: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      :root[data-theme='light'] {
        color-scheme: light;
        --bg-primary: #f4f4fa;
        --bg-secondary: #ffffff;
        --bg-tertiary: #f5f1ff;
        --bg-hover: rgba(139, 92, 246, 0.1);
        --border-color: rgba(31, 41, 55, 0.08);
        --border-strong: rgba(31, 41, 55, 0.14);
        --text-primary: #232335;
        --text-secondary: #4f5268;
        --text-muted: #72758b;
        --accent: #7c5cff;
        --accent-strong: #6740ff;
        --accent-contrast: #f8f6ff;
        --success: #1b936f;
        --danger: #c94561;
        --warning: #ba7a10;
        --shadow: 0 16px 30px rgba(93, 79, 133, 0.12);
      }

      * { box-sizing: border-box; }
      html, body, #root { min-height: 100%; }
      body {
        margin: 0;
        font-family: var(--font-stack);
        background: radial-gradient(circle at top, rgba(124, 92, 255, 0.12), transparent 36%), var(--bg-primary);
        color: var(--text-primary);
      }
      button, input, textarea, select { font: inherit; }
      button { color: inherit; }
      a { color: inherit; }

      .admin-shell {
        width: min(1240px, calc(100vw - 24px));
        margin: 16px auto;
        min-height: calc(100vh - 32px);
        display: grid;
        grid-template-columns: var(--nav-width) minmax(0, 1fr);
        gap: 18px;
      }

      .sidebar,
      .content-card,
      .hero,
      .surface,
      .field,
      .placeholder,
      .stat-card,
      .notice,
      .status-message,
      .empty-state,
      .detail-card,
      .secret-panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        box-shadow: var(--shadow);
      }

      .sidebar {
        border-radius: var(--radius-lg);
        padding: 20px 16px;
        display: flex;
        flex-direction: column;
        gap: 18px;
        position: sticky;
        top: 16px;
        height: fit-content;
      }

      .brand {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px 10px;
      }

      .brand-title {
        font-size: 20px;
        font-weight: 700;
        letter-spacing: 0.01em;
      }

      .brand-title span { color: var(--accent); }

      .brand-copy {
        color: var(--text-muted);
        font-size: 13px;
        line-height: 1.45;
      }

      .nav-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .nav-button {
        width: 100%;
        border: 1px solid transparent;
        background: transparent;
        color: var(--text-secondary);
        border-radius: 12px;
        padding: 11px 12px;
        text-align: left;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
      }

      .nav-button:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      .nav-button.is-active {
        background: var(--bg-tertiary);
        border-color: rgba(167, 139, 250, 0.28);
        color: var(--text-primary);
      }

      .nav-label { font-weight: 600; }
      .nav-hint { color: var(--text-muted); font-size: 12px; }

      .content {
        display: flex;
        flex-direction: column;
        gap: 16px;
        min-width: 0;
      }

      .hero, .content-card { border-radius: var(--radius-lg); }

      .hero {
        padding: 20px 22px;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
      }

      .hero-title { margin: 0; font-size: 24px; line-height: 1.2; }
      .hero-copy {
        margin: 10px 0 0;
        color: var(--text-secondary);
        max-width: 62ch;
        line-height: 1.55;
      }

      .hero-tools {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .theme-toggle {
        display: inline-flex;
        padding: 4px;
        border-radius: 999px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
      }

      .theme-option {
        border: none;
        background: transparent;
        color: var(--text-secondary);
        padding: 8px 12px;
        border-radius: 999px;
        min-width: 64px;
      }

      .theme-option.is-active {
        background: var(--accent);
        color: var(--accent-contrast);
      }

      .content-card { padding: 20px 22px 24px; min-width: 0; }

      .content-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 14px;
        margin-bottom: 18px;
      }

      .section-title { margin: 0; font-size: 18px; }
      .section-copy { color: var(--text-muted); margin: 6px 0 0; font-size: 14px; }

      .field, .detail-card, .secret-panel {
        border-radius: var(--radius-md);
        padding: 16px;
      }

      .field-label {
        display: block;
        color: var(--text-muted);
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 8px;
      }

      .field-row, .inline-row, .stack-row {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }

      .stack-row { align-items: stretch; }

      .input, .textarea, .button, .ghost-button, .select {
        border-radius: 10px;
        min-height: 40px;
      }

      .input, .textarea, .select {
        width: 100%;
        border: 1px solid var(--border-strong);
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: 0 12px;
        outline: none;
      }

      .textarea {
        min-height: 88px;
        padding: 10px 12px;
        resize: vertical;
      }

      .input:focus, .textarea:focus, .select:focus {
        border-color: rgba(167, 139, 250, 0.7);
        box-shadow: 0 0 0 3px rgba(167, 139, 250, 0.15);
      }

      .button, .ghost-button {
        border: 1px solid transparent;
        padding: 0 14px;
        cursor: pointer;
        transition: transform 120ms ease, opacity 120ms ease, border-color 120ms ease, background 120ms ease;
      }

      .button:hover, .ghost-button:hover { transform: translateY(-1px); }
      .button:disabled, .ghost-button:disabled {
        opacity: 0.58;
        cursor: default;
        transform: none;
      }

      .button {
        background: var(--accent-strong);
        color: var(--accent-contrast);
      }

      .button.is-success { background: var(--success); }
      .button.is-danger { background: var(--danger); }

      .ghost-button {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border-color);
      }

      .ghost-button.is-active {
        color: var(--text-primary);
        border-color: rgba(167, 139, 250, 0.28);
        background: var(--bg-hover);
      }

      .status-message, .empty-state, .notice {
        border-radius: var(--radius-md);
        padding: 14px 16px;
        line-height: 1.5;
      }

      .status-message.is-error {
        border-color: rgba(221, 94, 115, 0.35);
        color: var(--danger);
      }

      .status-message.is-success {
        border-color: rgba(56, 178, 138, 0.35);
        color: var(--success);
      }

      .empty-state, .notice { color: var(--text-secondary); }

      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--border-color);
        border-radius: 14px;
      }

      table { width: 100%; border-collapse: collapse; }

      th, td {
        padding: 12px 14px;
        text-align: left;
        white-space: nowrap;
        border-bottom: 1px solid var(--border-color);
        vertical-align: top;
      }

      th {
        background: rgba(167, 139, 250, 0.08);
        color: var(--text-secondary);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      tbody tr:last-child td { border-bottom: none; }

      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
      }

      .muted { color: var(--text-muted); }

      .tag {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        background: rgba(167, 139, 250, 0.12);
        color: var(--accent);
      }

      .tag.is-success {
        background: rgba(56, 178, 138, 0.14);
        color: var(--success);
      }

      .tag.is-danger {
        background: rgba(221, 94, 115, 0.14);
        color: var(--danger);
      }

      .stat-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
        margin-bottom: 18px;
      }

      .stat-card {
        border-radius: 14px;
        padding: 16px;
      }

      .stat-label {
        color: var(--text-muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .stat-value {
        font-size: 26px;
        font-weight: 700;
        margin-top: 6px;
      }

      .placeholder {
        border-radius: 16px;
        padding: 28px 24px;
      }

      .placeholder h3 { margin: 0 0 10px; }
      .placeholder p { margin: 0; color: var(--text-secondary); line-height: 1.6; }

      .split-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.9fr);
        gap: 14px;
      }

      .key-value-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
      }

      .detail-key {
        color: var(--text-muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 6px;
      }

      .detail-value {
        font-size: 15px;
        line-height: 1.5;
        overflow-wrap: anywhere;
      }

      .toolbar {
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        margin-bottom: 14px;
      }

      .toolbar-left, .toolbar-right {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }

      .secret-panel {
        border-color: rgba(167, 139, 250, 0.25);
      }

      .secret-value {
        display: block;
        margin-top: 8px;
        padding: 12px;
        border-radius: 10px;
        background: var(--bg-primary);
        border: 1px dashed rgba(167, 139, 250, 0.4);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        overflow-wrap: anywhere;
      }

      @media (max-width: 1024px) {
        .split-grid { grid-template-columns: 1fr; }
      }

      @media (max-width: 960px) {
        .admin-shell {
          width: calc(100vw - 24px);
          grid-template-columns: 1fr;
        }

        .sidebar {
          position: static;
          gap: 14px;
        }

        .nav-list {
          overflow-x: auto;
          flex-direction: row;
          padding-bottom: 4px;
        }

        .nav-button { min-width: 164px; }
        .hero, .content-header { flex-direction: column; align-items: stretch; }
        .hero-tools { justify-content: flex-start; }
      }
    `}</style>
  );
}

function Tag({ tone = 'default', children }: { tone?: StatusTone; children: React.ReactNode }) {
  return <span className={cx('tag', tone !== 'default' && `is-${tone}`)}>{children}</span>;
}

function Button(
  { tone = 'primary', className, ...props }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'success' | 'danger' },
) {
  return <button {...props} className={cx('button', tone !== 'primary' && `is-${tone}`, className)} />;
}

function GhostButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  const { active = false, className, ...rest } = props;
  return <button {...rest} className={cx('ghost-button', active && 'is-active', className)} />;
}

function StatusMessage({ tone, children }: { tone: 'error' | 'success'; children: React.ReactNode }) {
  return <div className={cx('status-message', `is-${tone}`)}>{children}</div>;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

function SectionCard(
  { title, description, actions, children }:
  { title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode },
) {
  return (
    <section className="content-card">
      <div className="content-header">
        <div>
          <h2 className="section-title">{title}</h2>
          {description ? <p className="section-copy">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function DetailCard({ title, value, mono = false }: { title: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="detail-card">
      <div className="detail-key">{title}</div>
      <div className={cx('detail-value', mono && 'mono')}>{value}</div>
    </div>
  );
}

function PlaceholderPanel({ title, description }: { title: string; description: string }) {
  return (
    <section className="content-card">
      <div className="placeholder">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </section>
  );
}

function OverviewPage({ token }: { token: string }) {
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await requestJson<OverviewPayload>('/admin/api/overview', token);
      setOverview(payload);
      setErr('');
    } catch (error: unknown) {
      setErr(String(error));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <SectionCard
      title="Overview"
      description="Server-wide summary from the dedicated admin API."
      actions={<GhostButton onClick={refresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</GhostButton>}
    >
      {err ? <StatusMessage tone="error">Error: {err}</StatusMessage> : null}
      {!overview && !err ? <EmptyState>Loading overview…</EmptyState> : null}
      {overview ? (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-label">Status</div>
              <div className="stat-value">{overview.status === 'ok' ? 'OK' : overview.status}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Token Mode</div>
              <div className="stat-value">{overview.tokenMode}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Active Rooms</div>
              <div className="stat-value">{overview.rooms.active}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Schema</div>
              <div className="stat-value">{overview.schemaVersion}</div>
            </div>
          </div>
          <div className="key-value-grid">
            <DetailCard title="Timestamp" value={overview.timestamp} />
            <DetailCard title="Uptime" value={`${overview.uptimeSeconds}s`} />
            <DetailCard title="Vault IDs" value={overview.rooms.vaultIds.join(', ') || 'None'} mono />
            <DetailCard title="Health" value={<Tag tone={statusTone(overview.status)}>{overview.status}</Tag>} />
          </div>
        </>
      ) : null}
    </SectionCard>
  );
}

function RoomsPage({ token }: { token: string }) {
  const [rooms, setRooms] = useState<RoomMeta[]>([]);
  const [selectedVaultId, setSelectedVaultId] = useState('');
  const [detail, setDetail] = useState<RoomDetailPayload | null>(null);
  const [search, setSearch] = useState('');
  const [err, setErr] = useState('');
  const [detailErr, setDetailErr] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await requestJson<{ rooms: RoomMeta[] }>('/admin/api/rooms', token);
      setRooms(payload.rooms ?? []);
      setErr('');
    } catch (error: unknown) {
      setRooms([]);
      setErr(String(error));
    } finally {
      setLoading(false);
    }
  }, [token]);

  const loadDetail = useCallback(async (vaultId: string) => {
    try {
      const payload = await requestJson<RoomDetailPayload>(`/admin/api/rooms/${encodeURIComponent(vaultId)}`, token);
      setDetail(payload);
      setDetailErr('');
    } catch (error: unknown) {
      setDetail(null);
      setDetailErr(String(error));
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedVaultId) {
      setDetail(null);
      return;
    }
    loadDetail(selectedVaultId);
  }, [selectedVaultId, loadDetail]);

  const filteredRooms = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return rooms;
    return rooms.filter((room) => room.vaultId.toLowerCase().includes(normalized));
  }, [rooms, search]);

  return (
    <SectionCard
      title="Rooms"
      description="List active rooms and inspect per-vault in-memory and persistence state."
      actions={<GhostButton onClick={refresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</GhostButton>}
    >
      {err ? <StatusMessage tone="error">Error: {err}</StatusMessage> : null}
      <div className="split-grid">
        <div>
          <div className="toolbar">
            <div className="toolbar-left">
              <input
                className="input"
                placeholder="Filter by vault ID"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          {filteredRooms.length === 0 ? (
            <EmptyState>No rooms match the current filter.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Vault ID</th>
                    <th>Clients</th>
                    <th>Loaded</th>
                    <th>Updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRooms.map((room) => (
                    <tr key={room.vaultId}>
                      <td className="mono">{room.vaultId}</td>
                      <td>{room.connectedClientCount}</td>
                      <td><Tag tone={room.loaded ? 'success' : 'default'}>{room.loaded ? 'Loaded' : 'Idle'}</Tag></td>
                      <td className="muted">{room.updatedAt ? elapsed(room.updatedAt) : '—'}</td>
                      <td>
                        <GhostButton active={selectedVaultId === room.vaultId} onClick={() => setSelectedVaultId(room.vaultId)}>
                          {selectedVaultId === room.vaultId ? 'Selected' : 'Details'}
                        </GhostButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          {detailErr ? <StatusMessage tone="error">Error: {detailErr}</StatusMessage> : null}
          {!selectedVaultId ? <EmptyState>Select a room to inspect details.</EmptyState> : null}
          {selectedVaultId && detail ? (
            <div className="stack-row">
              <DetailCard title="Vault ID" value={detail.vaultId} mono />
              <DetailCard title="Room Active" value={<Tag tone={detail.active ? 'success' : 'default'}>{detail.active ? 'Yes' : 'No'}</Tag>} />
              <DetailCard title="Clients" value={detail.room?.connectedClientCount ?? 0} />
              <DetailCard title="Last Activity" value={detail.room?.updatedAt ? elapsed(detail.room.updatedAt) : '—'} />
              <DetailCard title="Markdown Paths" value={detail.state?.markdownPathCount ?? 0} />
              <DetailCard title="Markdown Docs" value={detail.state?.markdownDocCount ?? 0} />
              <DetailCard title="Blob Paths" value={detail.state?.blobPathCount ?? 0} />
              <DetailCard title="Checkpoint Version" value={detail.persistence?.currentCheckpointVersion ?? 0} />
              <DetailCard title="Journal Entries" value={detail.persistence?.journalEntryCount ?? 0} />
              <DetailCard title="Journal Bytes" value={detail.persistence?.journalTotalBytes ?? 0} />
            </div>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

function SnapshotsPage({ token }: { token: string }) {
  const [vaultId, setVaultId] = useState('');
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [manifest, setManifest] = useState<SnapshotManifestPayload | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!vaultId.trim()) return;
    setLoading(true);
    try {
      const payload = await requestJson<{ snapshots: SnapshotMeta[] }>(`/admin/api/vaults/${encodeURIComponent(vaultId)}/snapshots`, token);
      setSnapshots(payload.snapshots ?? []);
      setManifest(null);
      setStatus('');
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const create = async () => {
    if (!vaultId.trim()) return;
    setLoading(true);
    try {
      const payload = await requestJson<SnapshotMeta>(`/admin/api/vaults/${encodeURIComponent(vaultId)}/snapshots`, token, { method: 'POST' });
      setStatus(`Created snapshot ${payload.snapshotId}`);
      await load();
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const viewManifest = async (snapshotId: string) => {
    if (!vaultId.trim()) return;
    setLoading(true);
    try {
      const payload = await requestJson<SnapshotManifestPayload>(
        `/admin/api/vaults/${encodeURIComponent(vaultId)}/snapshots/${encodeURIComponent(snapshotId)}/manifest`,
        token,
      );
      setSelectedSnapshotId(snapshotId);
      setManifest(payload);
      setStatus(`Loaded manifest for ${snapshotId}`);
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const downloadSnapshot = async (snapshotId: string) => {
    if (!vaultId.trim()) return;
    setLoading(true);
    try {
      const blob = await requestBlob(
        `/admin/api/vaults/${encodeURIComponent(vaultId)}/snapshots/${encodeURIComponent(snapshotId)}/download`,
        token,
      );
      triggerBrowserDownload(blob, `snapshot-${snapshotId.slice(0, 8)}.zip`);
      setStatus(`Downloaded snapshot ${snapshotId}`);
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const deleteSnapshot = async (snapshotId: string) => {
    if (!vaultId.trim()) return;
    if (!window.confirm(`Delete snapshot "${snapshotId}"? This cannot be undone.`)) return;
    setLoading(true);
    try {
      await requestJson<{ deleted: boolean }>(
        `/admin/api/vaults/${encodeURIComponent(vaultId)}/snapshots/${encodeURIComponent(snapshotId)}`,
        token,
        { method: 'DELETE' },
      );
      if (selectedSnapshotId === snapshotId) {
        setSelectedSnapshotId('');
        setManifest(null);
      }
      setStatus(`Deleted snapshot ${snapshotId}`);
      await load();
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const restoreSnapshot = async (snapshotId: string) => {
    if (!vaultId.trim()) return;
    if (!window.confirm(`Restore snapshot "${snapshotId}"? This will overwrite the current vault state with the snapshot contents.`)) return;
    setLoading(true);
    try {
      await requestJson<{ restored: boolean }>(
        `/admin/api/vaults/${encodeURIComponent(vaultId)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
        token,
        { method: 'POST' },
      );
      setStatus(`Restored snapshot ${snapshotId}`);
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SectionCard
      title="Snapshots"
      description="Manage snapshot history through the admin snapshot APIs, including manifest inspection, download, delete, and restore."
      actions={<GhostButton onClick={load} disabled={loading || !vaultId.trim()}>{loading ? 'Working…' : 'Refresh'}</GhostButton>}
    >
      <div className="split-grid">
        <div>
          <div className="field">
            <label className="field-label" htmlFor="snapshot-vault-id">Vault ID</label>
            <div className="field-row">
              <input
                id="snapshot-vault-id"
                className="input"
                placeholder="vault-id"
                value={vaultId}
                onChange={(event) => setVaultId(event.target.value)}
              />
              <GhostButton onClick={load} disabled={loading}>Load</GhostButton>
              <Button tone="success" onClick={create} disabled={loading}>Create Snapshot</Button>
            </div>
          </div>
          <div className="notice">
            Restore is destructive: it rewrites the current room state from the selected snapshot and persists it immediately.
          </div>
          {status ? (
            <StatusMessage tone={status.startsWith('Error:') ? 'error' : 'success'}>{status}</StatusMessage>
          ) : null}
          {snapshots.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Snapshot ID</th>
                    <th>Created</th>
                    <th>Markdown</th>
                    <th>Blobs</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((snapshot) => (
                    <tr key={snapshot.snapshotId}>
                      <td className="mono">{snapshot.snapshotId}</td>
                      <td className="muted">{elapsed(snapshot.createdAt)}</td>
                      <td>{snapshot.markdownFileCount}</td>
                      <td>{snapshot.blobFileCount}</td>
                      <td>
                        <div className="inline-row">
                          <GhostButton active={selectedSnapshotId === snapshot.snapshotId} onClick={() => viewManifest(snapshot.snapshotId)}>
                            Manifest
                          </GhostButton>
                          <GhostButton onClick={() => downloadSnapshot(snapshot.snapshotId)}>Download</GhostButton>
                          <GhostButton onClick={() => restoreSnapshot(snapshot.snapshotId)}>Restore</GhostButton>
                          <Button tone="danger" onClick={() => deleteSnapshot(snapshot.snapshotId)}>Delete</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : vaultId && !loading ? (
            <EmptyState>No snapshots found for this vault.</EmptyState>
          ) : null}
        </div>

        <div>
          {!manifest ? (
            <EmptyState>Select a snapshot and open its manifest to inspect the files captured in that restore point.</EmptyState>
          ) : (
            <div className="field">
              <div className="field-label">Manifest</div>
              <div className="key-value-grid" style={{ marginBottom: 12 }}>
                <DetailCard title="Snapshot ID" value={manifest.snapshotId} mono />
                <DetailCard title="Created" value={manifest.createdAt} />
                <DetailCard title="Files" value={manifest.files.length} />
              </div>
              {manifest.files.length === 0 ? (
                <EmptyState>This snapshot does not contain any files.</EmptyState>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Path</th>
                        <th>Type</th>
                        <th>Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {manifest.files.map((file) => (
                        <tr key={`${file.type}:${file.path}`}>
                          <td className="mono">{file.path}</td>
                          <td><Tag tone={file.type === 'markdown' ? 'default' : 'success'}>{file.type}</Tag></td>
                          <td>{file.size}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function TokensPage({ token }: { token: string }) {
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [tokenMode, setTokenMode] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [status, setStatus] = useState('');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: '',
    note: '',
    expiresAt: '',
  });
  const [editForm, setEditForm] = useState({
    name: '',
    note: '',
    expiresAt: '',
    status: 'active' as TokenStatus,
  });

  const loadTokens = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await requestJson<TokensListPayload>('/admin/api/tokens', token);
      setTokens(payload.tokens ?? []);
      setTokenMode(payload.tokenMode);
      setStatus('');
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
      setTokens([]);
      setTokenMode('');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const selectedToken = useMemo(
    () => tokens.find((current) => current.id === selectedId) ?? null,
    [tokens, selectedId],
  );

  useEffect(() => {
    if (!selectedToken) return;
    setEditForm({
      name: selectedToken.name,
      note: selectedToken.note ?? '',
      expiresAt: selectedToken.expiresAt ?? '',
      status: selectedToken.status,
    });
  }, [selectedToken]);

  const createToken = async () => {
    // Warn before the first DB token because env-based sync access becomes disabled immediately.
    if (tokenMode === 'env-fallback') {
      const confirmed = window.confirm(
        'Creating the first DB token will immediately disable env-variable sync access (SERVER_TOKEN / VAULT_TOKENS).\n\nMake sure clients are ready to use DB tokens before proceeding.',
      );
      if (!confirmed) return;
    }
    setLoading(true);
    try {
      const payload = await requestJson<TokenMutationPayload>('/admin/api/tokens', token, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          note: form.note || null,
          expiresAt: form.expiresAt || null,
        }),
      });
      setSecret(payload.rawToken ?? '');
      setStatus(`Created token ${payload.token.name}`);
      setForm({ name: '', note: '', expiresAt: '' });
      await loadTokens();
      setSelectedId(payload.token.id);
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const saveEdits = async () => {
    if (!selectedToken) return;
    setLoading(true);
    try {
      const payload = await requestJson<TokenMutationPayload>(`/admin/api/tokens/${selectedToken.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editForm.name,
          note: editForm.note || null,
          expiresAt: editForm.expiresAt || null,
          status: editForm.status,
        }),
      });
      setStatus(`Updated token ${payload.token.name}`);
      await loadTokens();
      setSelectedId(payload.token.id);
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const revokeToken = async () => {
    if (!selectedToken) return;
    if (!window.confirm(`Revoke token "${selectedToken.name}"? This takes effect immediately.`)) return;
    setLoading(true);
    try {
      const payload = await requestJson<TokenMutationPayload>(`/admin/api/tokens/${selectedToken.id}`, token, {
        method: 'DELETE',
      });
      setStatus(`Revoked token ${payload.token.name}`);
      await loadTokens();
      setSelectedId(payload.token.id);
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const rotateToken = async () => {
    if (!selectedToken) return;
    if (!window.confirm(`Rotate token "${selectedToken.name}"? The old value will stop working immediately.`)) return;
    setLoading(true);
    try {
      const payload = await requestJson<TokenMutationPayload>(`/admin/api/tokens/${selectedToken.id}/rotate`, token, {
        method: 'POST',
      });
      setSecret(payload.rawToken ?? '');
      setStatus(`Rotated token ${payload.token.name}`);
      await loadTokens();
      setSelectedId(payload.token.id);
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SectionCard
      title="Tokens"
      description="Manage sync tokens from the admin API. Raw token values are only shown once on create or rotate."
      actions={<GhostButton onClick={loadTokens} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</GhostButton>}
    >
      {status ? <StatusMessage tone={status.startsWith('Error:') ? 'error' : 'success'}>{status}</StatusMessage> : null}
      {secret ? (
        <div className="secret-panel">
          <strong>One-time raw token</strong>
          <div className="muted">Store this now. It will not be returned again from list or detail responses.</div>
          <span className="secret-value">{secret}</span>
          <div className="inline-row" style={{ marginTop: 12 }}>
            <GhostButton onClick={async () => {
              const ok = await copyText(secret);
              setStatus(ok ? 'Copied raw token to clipboard' : 'Error: clipboard copy failed');
            }}>Copy</GhostButton>
            <GhostButton onClick={() => setSecret('')}>Dismiss</GhostButton>
          </div>
        </div>
      ) : null}

      <div className="split-grid">
        <div className="stack-row">
          <div className="field">
            <div className="field-label">Create Token</div>
            <div className="stack-row" style={{ flexDirection: 'column' }}>
              <input
                className="input"
                placeholder="Token name"
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
              <input
                className="input"
                placeholder="Expires At (ISO, optional)"
                value={form.expiresAt}
                onChange={(event) => setForm((current) => ({ ...current, expiresAt: event.target.value }))}
              />
              <textarea
                className="textarea"
                placeholder="Note (optional)"
                value={form.note}
                onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
              />
              <div className="inline-row">
                <Button onClick={createToken} disabled={loading || !form.name.trim()}>Create</Button>
                <Tag tone={statusTone(tokenMode)}>{tokenMode || 'unknown'}</Tag>
              </div>
            </div>
          </div>

          {tokens.length === 0 ? (
            <EmptyState>No DB tokens yet. In env fallback mode, creating the first one will disable env-based sync access.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Prefix</th>
                    <th>Status</th>
                    <th>Last Used</th>
                    <th>Expires</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.name}</td>
                      <td className="mono">{entry.tokenPrefix}</td>
                      <td><Tag tone={statusTone(entry.status)}>{entry.status}</Tag></td>
                      <td className="muted">{entry.lastUsedAt ? elapsed(entry.lastUsedAt) : 'Never'}</td>
                      <td className="muted">{entry.expiresAt ? elapsed(entry.expiresAt) : '—'}</td>
                      <td>
                        <GhostButton active={selectedId === entry.id} onClick={() => setSelectedId(entry.id)}>
                          {selectedId === entry.id ? 'Selected' : 'Manage'}
                        </GhostButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          {!selectedToken ? (
            <EmptyState>Select a token to edit metadata, revoke, or rotate it.</EmptyState>
          ) : (
            <div className="field">
              <div className="field-label">Manage Token</div>
              <div className="stack-row" style={{ flexDirection: 'column' }}>
                <DetailCard title="Token Prefix" value={selectedToken.tokenPrefix} mono />
                <input
                  className="input"
                  placeholder="Token name"
                  value={editForm.name}
                  onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))}
                />
                <select
                  className="select"
                  value={editForm.status}
                  onChange={(event) => setEditForm((current) => ({ ...current, status: event.target.value as TokenStatus }))}
                >
                  <option value="active">active</option>
                  <option value="revoked">revoked</option>
                  <option value="expired">expired</option>
                </select>
                <input
                  className="input"
                  placeholder="Expires At (ISO, optional)"
                  value={editForm.expiresAt}
                  onChange={(event) => setEditForm((current) => ({ ...current, expiresAt: event.target.value }))}
                />
                <textarea
                  className="textarea"
                  placeholder="Note"
                  value={editForm.note}
                  onChange={(event) => setEditForm((current) => ({ ...current, note: event.target.value }))}
                />
                <div className="inline-row">
                  <Button onClick={saveEdits} disabled={loading || !editForm.name.trim()}>Save</Button>
                  <Button tone="danger" onClick={revokeToken} disabled={loading}>Revoke</Button>
                  <GhostButton onClick={rotateToken} disabled={loading}>Rotate</GhostButton>
                </div>
                <div className="key-value-grid">
                  <DetailCard title="Created" value={selectedToken.createdAt} />
                  <DetailCard title="Updated" value={selectedToken.updatedAt} />
                  <DetailCard title="Last Used" value={selectedToken.lastUsedAt || 'Never'} />
                  <DetailCard title="Revoked At" value={selectedToken.revokedAt || '—'} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function BlobGcPage({ token }: { token: string }) {
  const [vaultId, setVaultId] = useState('');
  const [confirmValue, setConfirmValue] = useState('');
  const [result, setResult] = useState<{
    checked: number;
    deleted: number;
    kept: number;
    skippedTooNew?: number;
  } | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const runGc = async () => {
    if (!vaultId.trim()) return;
    if (confirmValue.trim() !== vaultId.trim()) {
      setStatus('Error: confirmation does not match vault ID');
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const payload = await requestJson<typeof result>(`/admin/api/vaults/${encodeURIComponent(vaultId)}/blobs/gc`, token, { method: 'POST' });
      setResult(payload);
      setStatus(`GC completed for ${vaultId}`);
    } catch (error: unknown) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SectionCard
      title="Blob GC"
      description="Run blob garbage collection for a single vault. This remains a dangerous maintenance action and now requires explicit confirmation."
    >
      <div className="notice">
        Blob GC removes orphaned objects from storage. Type the vault ID exactly before running it. There is no dry-run endpoint yet, so this page uses strong confirmation instead.
      </div>
      <div className="split-grid">
        <div className="field">
          <label className="field-label" htmlFor="gc-vault-id">Vault ID</label>
          <input
            id="gc-vault-id"
            className="input"
            placeholder="vault-id"
            value={vaultId}
            onChange={(event) => {
              setVaultId(event.target.value);
              setConfirmValue('');
            }}
          />
          <label className="field-label" htmlFor="gc-confirm" style={{ marginTop: 12 }}>
            Confirm by typing the same vault ID
          </label>
          <div className="field-row">
            <input
              id="gc-confirm"
              className="input"
              placeholder="type vault-id again"
              value={confirmValue}
              onChange={(event) => setConfirmValue(event.target.value)}
            />
            <Button tone="danger" onClick={runGc} disabled={loading || !vaultId.trim() || confirmValue.trim() !== vaultId.trim()}>
              {loading ? 'Running…' : 'Run GC'}
            </Button>
          </div>
        </div>
        <div className="field">
          <div className="field-label">Confirmation State</div>
          <div className="key-value-grid">
            <DetailCard title="Vault ID" value={vaultId || '—'} mono />
            <DetailCard title="Typed Confirm" value={confirmValue || '—'} mono />
            <DetailCard title="Ready" value={<Tag tone={confirmValue.trim() === vaultId.trim() && vaultId.trim() ? 'success' : 'danger'}>{confirmValue.trim() === vaultId.trim() && vaultId.trim() ? 'Yes' : 'No'}</Tag>} />
          </div>
        </div>
      </div>
      {status ? <StatusMessage tone={status.startsWith('Error:') ? 'error' : 'success'}>{status}</StatusMessage> : null}
      {result ? (
        <div className="table-wrap">
          <table>
            <tbody>
              <tr><td>Checked</td><td>{result.checked}</td></tr>
              <tr><td>Deleted</td><td>{result.deleted}</td></tr>
              <tr><td>Kept</td><td>{result.kept}</td></tr>
              <tr><td>Skipped (too new)</td><td>{result.skippedTooNew ?? 0}</td></tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </SectionCard>
  );
}

function ConfigPage({ token }: { token: string }) {
  const [config, setConfig] = useState<ConfigPayload | null>(null);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      const payload = await requestJson<ConfigPayload>('/admin/api/config', token);
      setConfig(payload);
      setErr('');
    } catch (error: unknown) {
      setErr(String(error));
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <SectionCard
      title="Config"
      description="Read-only runtime configuration summary from the admin API. Sensitive fields stay redacted."
      actions={<GhostButton onClick={refresh}>Refresh</GhostButton>}
    >
      {err ? <StatusMessage tone="error">Error: {err}</StatusMessage> : null}
      {!config && !err ? <EmptyState>Loading config…</EmptyState> : null}
      {config ? (
        <div className="stack-row" style={{ flexDirection: 'column' }}>
          <div className="key-value-grid">
            <DetailCard title="Token Mode" value={<Tag tone={statusTone(config.auth.tokenMode)}>{config.auth.tokenMode}</Tag>} />
            <DetailCard title="DB Tokens" value={config.auth.dbTokenCount} />
            <DetailCard title="Legacy Vault Tokens" value={config.auth.legacyVaultTokenCount} />
            <DetailCard title="Env Fallback" value={config.auth.envFallbackAvailable ? 'Available' : 'Disabled'} />
            <DetailCard title="Admin Token" value={config.auth.adminTokenConfigured ? 'Configured' : 'Missing'} />
            <DetailCard title="Data Dir" value={config.storage.dataDir || 'Not set'} />
            <DetailCard title="S3 Endpoint" value={config.storage.s3Endpoint || 'Not set'} mono />
            <DetailCard title="S3 Region" value={config.storage.s3Region || 'Not set'} />
            <DetailCard title="S3 Bucket" value={config.storage.s3Bucket || 'Not set'} />
            <DetailCard title="Snapshot Retention" value={config.snapshot.retentionDays ?? 'Default'} />
            <DetailCard title="Snapshot Max Count" value={config.snapshot.maxCount ?? 'Default'} />
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

const NAV_ITEMS: Array<{ key: NavKey; label: string; hint: string }> = [
  { key: 'overview', label: 'Overview', hint: 'Service summary' },
  { key: 'rooms', label: 'Rooms', hint: 'Room details' },
  { key: 'snapshots', label: 'Snapshots', hint: 'History and restore' },
  { key: 'tokens', label: 'Tokens', hint: 'CRUD and rotate' },
  { key: 'blob-gc', label: 'Blob GC', hint: 'Maintenance action' },
  { key: 'config', label: 'Config', hint: 'Read-only runtime' },
];

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('salt-sync-admin-token') ?? '');
  const [saved, setSaved] = useState(() => Boolean(sessionStorage.getItem('salt-sync-admin-token')));
  const [nav, setNav] = useState<NavKey>('overview');
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const persisted = localStorage.getItem('salt-sync-admin-theme');
    return persisted === 'light' ? 'light' : 'dark';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('salt-sync-admin-theme', theme);
  }, [theme]);

  const saveToken = () => {
    sessionStorage.setItem('salt-sync-admin-token', token);
    setSaved(true);
  };

  const page = useMemo(() => {
    switch (nav) {
      case 'overview':
        return <OverviewPage token={token} />;
      case 'rooms':
        return <RoomsPage token={token} />;
      case 'snapshots':
        return <SnapshotsPage token={token} />;
      case 'tokens':
        return <TokensPage token={token} />;
      case 'blob-gc':
        return <BlobGcPage token={token} />;
      case 'config':
        return <ConfigPage token={token} />;
      default:
        return <PlaceholderPanel title="Unknown" description="Unknown section." />;
    }
  }, [nav, token]);

  return (
    <>
      <AppStyles />
      <div className="admin-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-title">Salt Sync <span>Admin</span></div>
            <div className="brand-copy">
              Minimal admin UI aligned with the Obsidian visual tone: restrained surfaces, dark-first layout, and a purple accent.
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="admin-server-token">Server Token</label>
            <div className="field-row">
              <input
                id="admin-server-token"
                className="input"
                type="password"
                placeholder="SERVER_TOKEN"
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                  setSaved(false);
                }}
              />
              <Button onClick={saveToken}>{saved ? 'Saved' : 'Save Token'}</Button>
            </div>
          </div>

          <nav className="nav-list" aria-label="Admin sections">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={cx('nav-button', nav === item.key && 'is-active')}
                onClick={() => setNav(item.key)}
              >
                <span className="nav-label">{item.label}</span>
                <span className="nav-hint">{item.hint}</span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="content">
          <section className="hero">
            <div>
              <h1 className="hero-title">{NAV_ITEMS.find((item) => item.key === nav)?.label}</h1>
              <p className="hero-copy">
                The admin shell now covers overview, room inspection, snapshot operations, token lifecycle management, config visibility, and guarded blob cleanup through the current server APIs.
              </p>
            </div>
            <div className="hero-tools">
              <div className="theme-toggle" role="group" aria-label="Theme mode">
                <button
                  type="button"
                  className={cx('theme-option', theme === 'dark' && 'is-active')}
                  onClick={() => setTheme('dark')}
                >
                  Dark
                </button>
                <button
                  type="button"
                  className={cx('theme-option', theme === 'light' && 'is-active')}
                  onClick={() => setTheme('light')}
                >
                  Light
                </button>
              </div>
              <GhostButton active={saved} disabled>
                {saved ? 'Token stored locally' : 'Unsaved token'}
              </GhostButton>
            </div>
          </section>

          {page}
        </main>
      </div>
    </>
  );
}
