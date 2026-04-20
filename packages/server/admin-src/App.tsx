import React, { useState, useEffect, useCallback } from 'react';

// ── types ─────────────────────────────────────────────────────────────────────

interface Health {
  status: string;
  timestamp: string;
  uptimeSeconds: number;
  rooms: { active: number; vaultIds: string[] };
  schemaVersion: number;
}

interface RoomMeta {
  vaultId: string;
  connectedClientCount: number;
  loaded: boolean;
  updatedAt?: string;
}

interface SnapshotMeta {
  snapshotId: string;
  vaultId: string;
  createdAt: string;
  markdownFileCount: number;
  blobFileCount: number;
}

// ── helpers ───────────────────────────────────────────────────────────────────

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

function elapsed(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ── components ────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ borderBottom: '1px solid #ddd', paddingBottom: 8 }}>{title}</h2>
      {children}
    </section>
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      background: color, color: '#fff', fontSize: 12, marginLeft: 8,
    }}>
      {children}
    </span>
  );
}

// ── HealthPanel ───────────────────────────────────────────────────────────────

function HealthPanel({ token }: { token: string }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch('/health', token);
      setHealth(await r.json());
      setErr('');
    } catch (e: unknown) {
      setErr(String(e));
    }
  }, [token]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (err) return <p style={{ color: 'red' }}>Error: {err}</p>;
  if (!health) return <p>Loading…</p>;

  return (
    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
      {[
        ['Status', <><strong>{health.status}</strong>{health.status === 'ok' ? <Tag color="#2a9d8f">OK</Tag> : <Tag color="#e63946">DOWN</Tag>}</>],
        ['Uptime', `${health.uptimeSeconds}s`],
        ['Schema version', health.schemaVersion],
        ['Active rooms', health.rooms.active],
        ['Timestamp', health.timestamp],
      ].map(([k, v], i) => (
        <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
          <td style={{ padding: '6px 12px', color: '#666', width: 160 }}>{k}</td>
          <td style={{ padding: '6px 12px' }}>{v as React.ReactNode}</td>
        </tr>
      ))}
    </table>
  );
}

// ── RoomsPanel ────────────────────────────────────────────────────────────────

function RoomsPanel({ token }: { token: string }) {
  const [rooms, setRooms] = useState<RoomMeta[]>([]);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch('/admin/api/rooms', token);
      const payload = await r.json() as { rooms?: RoomMeta[]; error?: string };
      if (!r.ok) {
        throw new Error(payload.error ?? `HTTP ${r.status}`);
      }
      setRooms(Array.isArray(payload.rooms) ? payload.rooms : []);
      setErr('');
    } catch (e: unknown) {
      setRooms([]);
      setErr(String(e));
    }
  }, [token]);

  useEffect(() => { refresh(); }, [refresh]);

  if (err) return <p style={{ color: 'red' }}>Error: {err}</p>;
  if (rooms.length === 0) return <p style={{ color: '#888' }}>No active rooms</p>;

  return (
    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
      <thead>
        <tr style={{ background: '#f8f8f8' }}>
          {['Vault ID', 'Clients', 'Updated'].map((h) => (
            <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rooms.map((r) => (
          <tr key={r.vaultId} style={{ borderBottom: '1px solid #eee' }}>
            <td style={{ padding: '6px 12px', fontFamily: 'monospace' }}>{r.vaultId}</td>
            <td style={{ padding: '6px 12px' }}>{r.connectedClientCount}</td>
            <td style={{ padding: '6px 12px', color: '#888' }}>{r.updatedAt ? elapsed(r.updatedAt) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── SnapshotsPanel ────────────────────────────────────────────────────────────

function SnapshotsPanel({ token }: { token: string }) {
  const [vaultId, setVaultId] = useState('');
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!vaultId.trim()) return;
    setLoading(true);
    try {
      const r = await apiFetch(`/vault/${vaultId}/snapshots`, token);
      const { snapshots } = await r.json();
      setSnapshots(snapshots ?? []);
      setStatus('');
    } catch (e: unknown) {
      setStatus(`Error: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const create = async () => {
    if (!vaultId.trim()) return;
    setLoading(true);
    try {
      const r = await apiFetch(`/vault/${vaultId}/snapshots`, token, { method: 'POST' });
      const meta = await r.json() as SnapshotMeta;
      setStatus(`✓ Snapshot created: ${meta.snapshotId}`);
      await load();
    } catch (e: unknown) {
      setStatus(`Error: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <input
          placeholder="Vault ID"
          value={vaultId}
          onChange={(e) => setVaultId(e.target.value)}
          style={{ padding: '6px 10px', flex: 1, border: '1px solid #ccc', borderRadius: 4 }}
        />
        <button onClick={load} disabled={loading} style={btnStyle}>Load</button>
        <button onClick={create} disabled={loading} style={{ ...btnStyle, background: '#2a9d8f' }}>
          + Create Snapshot
        </button>
      </div>
      {status && <p style={{ color: status.startsWith('✓') ? '#2a9d8f' : 'red' }}>{status}</p>}
      {snapshots.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ background: '#f8f8f8' }}>
              {['Snapshot ID', 'Created', 'MD files', 'Blobs'].map((h) => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {snapshots.map((s) => (
              <tr key={s.snapshotId} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: 13 }}>{s.snapshotId}</td>
                <td style={{ padding: '6px 12px', color: '#888' }}>{elapsed(s.createdAt)}</td>
                <td style={{ padding: '6px 12px' }}>{s.markdownFileCount}</td>
                <td style={{ padding: '6px 12px' }}>{s.blobFileCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {snapshots.length === 0 && vaultId && !loading && (
        <p style={{ color: '#888' }}>No snapshots found</p>
      )}
    </div>
  );
}

// ── GcPanel ───────────────────────────────────────────────────────────────────

function GcPanel({ token }: { token: string }) {
  const [vaultId, setVaultId] = useState('');
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
    setLoading(true);
    setResult(null);
    try {
      const r = await apiFetch(`/vault/${vaultId}/blobs/gc`, token, { method: 'POST' });
      setResult(await r.json());
      setStatus('');
    } catch (e: unknown) {
      setStatus(`Error: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <p style={{ color: '#666', marginTop: 0 }}>
        扫描 S3 中的所有 blob，删除当前 vault 中已无 pathToBlob 引用的孤立对象。
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <input
          placeholder="Vault ID"
          value={vaultId}
          onChange={(e) => setVaultId(e.target.value)}
          style={{ padding: '6px 10px', flex: 1, border: '1px solid #ccc', borderRadius: 4 }}
        />
        <button onClick={runGc} disabled={loading} style={{ ...btnStyle, background: '#e63946' }}>
          {loading ? 'Running…' : 'Run GC'}
        </button>
      </div>
      {status && <p style={{ color: 'red' }}>{status}</p>}
      {result && (
        <table style={{ borderCollapse: 'collapse' }}>
          {[
            ['Checked', result.checked],
            ['Deleted', result.deleted],
            ['Kept (live)', result.kept],
            ['Skipped (too new)', result.skippedTooNew ?? 0],
          ].map(([k, v]) => (
            <tr key={k as string} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: '4px 12px', color: '#666', width: 120 }}>{k}</td>
              <td style={{ padding: '4px 12px', fontWeight: 600 }}>{v}</td>
            </tr>
          ))}
        </table>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '6px 14px', background: '#264653', color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer',
};

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('salt-sync-admin-token') ?? '');
  const [saved, setSaved] = useState(!!localStorage.getItem('salt-sync-admin-token'));

  const saveToken = () => {
    localStorage.setItem('salt-sync-admin-token', token);
    setSaved(true);
  };

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>
          Salt Sync <span style={{ color: '#2a9d8f' }}>Admin</span>
        </h1>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <input
            type="password"
            placeholder="Server token"
            value={token}
            onChange={(e) => { setToken(e.target.value); setSaved(false); }}
            style={{ padding: '6px 10px', border: '1px solid #ccc', borderRadius: 4, width: 240 }}
          />
          <button onClick={saveToken} style={btnStyle}>
            {saved ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </header>

      <Section title="Health"><HealthPanel token={token} /></Section>
      <Section title="Active Rooms"><RoomsPanel token={token} /></Section>
      <Section title="Snapshots"><SnapshotsPanel token={token} /></Section>
      <Section title="Blob GC"><GcPanel token={token} /></Section>
    </div>
  );
}
