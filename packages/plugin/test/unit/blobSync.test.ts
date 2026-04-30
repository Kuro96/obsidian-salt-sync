import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BlobSync } from '../../src/sync/blobSync';
import { MockVault } from '../mocks/obsidian';
import type { BlobRuntimeState } from '../../src/storage/indexedDbStore';

function sha256hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function binaryResponse(body: Uint8Array): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

function createRuntimeStateStore() {
  let state: BlobRuntimeState | null = null;
  return {
    store: {
      load: vi.fn(async () => state),
      save: vi.fn(async (_vaultId: string, next: BlobRuntimeState) => {
        state = structuredClone(next);
      }),
      clear: vi.fn(async () => {
        state = null;
      }),
    },
    snapshot: () => state,
  };
}

describe('BlobSync reconcile', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('authoritative reconcile uploads local-only blobs', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/image.png', bytes);

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/blobs/exists')) return jsonResponse({ existing: [] });
      if (url.endsWith(`/blobs/${hash}`) && init?.method === 'PUT') return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.reconcile('authoritative');

    const ref = (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number }>).get('assets/image.png');
    expect(ref?.hash).toBe(hash);
    expect(ref?.size).toBe(3);
  });

  it('conservative reconcile does not upload local-only blobs', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    vault.seedBinary('assets/image.png', new Uint8Array([1, 2, 3]));

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.reconcile('conservative');

    expect((ydoc.getMap('pathToBlob') as Y.Map<unknown>).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reconcile downloads remote-only blobs', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([9, 8, 7]);
    const hash = sha256hex(bytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/remote.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(`/blobs/${hash}`)) return binaryResponse(bytes);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.reconcile('authoritative');

    const file = vault.getFileByPath('assets/remote.png');
    expect(file).not.toBeNull();
    expect(new Uint8Array(await vault.readBinary(file!))).toEqual(bytes);
  });

  it('rejects downloaded blobs whose bytes do not match BlobRef hash', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const expectedBytes = new Uint8Array([9, 8, 7]);
    const wrongBytes = new Uint8Array([1, 2, 3]);
    const hash = sha256hex(expectedBytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/bad.png', {
      hash,
      size: expectedBytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(`/blobs/${hash}`)) return binaryResponse(wrongBytes);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await expect(sync.reconcile('authoritative')).rejects.toThrow(/hash mismatch/);
    expect(vault.getFileByPath('assets/bad.png')).toBeNull();
  });

  it('adds blob path and hash context when remote blob download returns 404', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const hash = sha256hex(new Uint8Array([9, 8, 7]));
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/missing.png', {
      hash,
      size: 3,
      updatedAt: new Date().toISOString(),
    });

    fetchMock.mockImplementation(async () => {
      throw new Error('Request failed, status 404');
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await expect(sync.reconcile('authoritative')).rejects.toThrow(
      /blob object missing for assets\/missing\.png \(hash=.*vault=vault-a\)/,
    );
    expect(vault.getFileByPath('assets/missing.png')).toBeNull();
  });

  it('authoritative reconcile uploads local blob when hashes conflict', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const localBytes = new Uint8Array([4, 5, 6]);
    const localHash = sha256hex(localBytes);
    vault.seedBinary('assets/conflict.png', localBytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/conflict.png', {
      hash: 'remote-hash',
      size: 999,
      updatedAt: new Date().toISOString(),
    });

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/blobs/exists')) return jsonResponse({ existing: [] });
      if (url.endsWith(`/blobs/${localHash}`) && init?.method === 'PUT') return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.reconcile('authoritative');

    const ref = (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number }>).get('assets/conflict.png');
    expect(ref?.hash).toBe(localHash);
    expect(ref?.size).toBe(localBytes.byteLength);
  });

  it('defers remote materialization until remote apply is resumed', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([7, 7, 7]);
    const hash = sha256hex(bytes);
    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });

    ydoc.transact(() => {
      (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/gated.png', {
        hash,
        size: bytes.byteLength,
        updatedAt: new Date().toISOString(),
      });
    }, 'remote');

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(`/blobs/${hash}`)) return binaryResponse(bytes);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    expect(sync.getRemoteApplyGateState()).toBe('startup-blocked');
    await sync.handleRemoteBlobChanges(remoteTxn!);
    expect(vault.getFileByPath('assets/gated.png')).toBeNull();

    sync.enterMaintenanceGate();
    expect(sync.getRemoteApplyGateState()).toBe('maintenance-blocked');
    await sync.openRemoteApplyGate();
    expect(sync.getRemoteApplyGateState()).toBe('open');
    const file = vault.getFileByPath('assets/gated.png');
    expect(file).not.toBeNull();
    expect(new Uint8Array(await vault.readBinary(file!))).toEqual(bytes);
  });

  it('applies startup remote tombstones after conservative startup maintenance opens the gate', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([4, 4, 4]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/deleted.png', bytes);

    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });
    ydoc.transact(() => {
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/deleted.png', {
        hash,
        deletedAt: new Date().toISOString(),
      });
    }, 'remote');

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.handleRemoteBlobChanges(remoteTxn!);
    expect(sync.getRemoteApplyGateState()).toBe('startup-blocked');
    expect(sync.pendingRemoteDeleteCount).toBe(0);
    expect(vault.getFileByPath('assets/deleted.png')).not.toBeNull();

    await sync.reconcile('conservative');
    expect(vault.getFileByPath('assets/deleted.png')).not.toBeNull();

    await sync.openRemoteApplyGate();
    expect(vault.getFileByPath('assets/deleted.png')).toBeNull();
  });

  it('does not delete authoritative recovered blobs after startup tombstones are cleared', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([5, 5, 5]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/recovered.png', bytes);

    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });
    ydoc.transact(() => {
      (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/recovered.png', {
        hash,
        size: bytes.byteLength,
        updatedAt: new Date().toISOString(),
      });
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/recovered.png', {
        hash,
        deletedAt: new Date().toISOString(),
      });
    }, 'remote');

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.handleRemoteBlobChanges(remoteTxn!);
    expect(sync.pendingRemoteDeleteCount).toBe(0);

    await sync.reconcile('authoritative');
    expect((ydoc.getMap('blobTombstones') as Y.Map<unknown>).has('assets/recovered.png')).toBe(false);

    await sync.openRemoteApplyGate();
    const file = vault.getFileByPath('assets/recovered.png');
    expect(file).not.toBeNull();
    expect(new Uint8Array(await vault.readBinary(file!))).toEqual(bytes);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips stale pending remote downloads after local reconcile updates the blob ref', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const remoteBytes = new Uint8Array([7, 8, 9]);
    const remoteHash = sha256hex(remoteBytes);
    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });

    ydoc.transact(() => {
      (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/gated.png', {
        hash: remoteHash,
        size: remoteBytes.byteLength,
        updatedAt: new Date().toISOString(),
      });
    }, 'remote');

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.handleRemoteBlobChanges(remoteTxn!);

    const localBytes = new Uint8Array([1, 1, 1]);
    const localHash = sha256hex(localBytes);
    vault.seedBinary('assets/gated.png', localBytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/gated.png', {
      hash: localHash,
      size: localBytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    await sync.openRemoteApplyGate();
    expect(fetchMock).not.toHaveBeenCalled();
    const file = vault.getFileByPath('assets/gated.png');
    expect(new Uint8Array(await vault.readBinary(file!))).toEqual(localBytes);
  });

  it('rescan uploads local-only blobs even when no file event was observed', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([2, 4, 6]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/rescan.png', bytes);

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/blobs/exists')) return jsonResponse({ existing: [] });
      if (url.endsWith(`/blobs/${hash}`) && init?.method === 'PUT') return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.rescan('authoritative');

    const ref = (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string }>).get('assets/rescan.png');
    expect(ref?.hash).toBe(hash);
  });

  it('rescan reuses cached hash for unchanged local blobs', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([3, 3, 3]);
    const hash = sha256hex(bytes);
    const file = vault.seedBinary('assets/cached.png', bytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/cached.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    const readSpy = vi.spyOn(vault, 'readBinary');

    await sync.rescan('authoritative');
    expect(readSpy).toHaveBeenCalledTimes(1);

    readSpy.mockClear();
    await sync.rescan('authoritative');
    expect(readSpy).not.toHaveBeenCalled();

    expect(vault.getFileByPath(file.path)).not.toBeNull();
  });

  it('authoritative rescan writes a tombstone for missed local blob deletions', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([8, 8, 8]);
    const hash = sha256hex(bytes);
    const file = vault.seedBinary('assets/deleted.png', bytes);
    const updatedAt = new Date().toISOString();
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/deleted.png', {
      hash,
      size: bytes.byteLength,
      updatedAt,
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.rescan('authoritative');

    await vault.delete(file);
    await sync.rescan('authoritative');

    const pathToBlob = ydoc.getMap('pathToBlob') as Y.Map<unknown>;
    const tombstones = ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>;
    expect(pathToBlob.has('assets/deleted.png')).toBe(false);
    expect(tombstones.get('assets/deleted.png')?.hash).toBe(hash);
  });

  it('conservative rescan does not revive missed local blob deletions', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([9, 9, 9]);
    const hash = sha256hex(bytes);
    const file = vault.seedBinary('assets/deleted.png', bytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/deleted.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.rescan('authoritative');

    await vault.delete(file);
    fetchMock.mockImplementation(async () => {
      throw new Error('should not download missed deletion');
    });

    await sync.rescan('conservative');

    expect(vault.getFileByPath('assets/deleted.png')).toBeNull();
    expect((ydoc.getMap('pathToBlob') as Y.Map<unknown>).has('assets/deleted.png')).toBe(true);
    expect((ydoc.getMap('blobTombstones') as Y.Map<unknown>).has('assets/deleted.png')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('authoritative reconcile respects shared mount path translation when uploading local blobs', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([5, 4, 3]);
    const hash = sha256hex(bytes);
    vault.seedBinary('Shared/image.png', bytes);
    vault.seedBinary('Other/skip.png', new Uint8Array([1]));

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/blobs/exists')) return jsonResponse({ existing: [] });
      if (url.endsWith(`/blobs/${hash}`) && init?.method === 'PUT') return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      (docPath) => `Shared/${docPath}`,
      (vaultPath) => vaultPath.slice('Shared/'.length),
      (vaultPath) => vaultPath.startsWith('Shared/'),
    );

    await sync.reconcile('authoritative');

    const pathToBlob = ydoc.getMap('pathToBlob') as Y.Map<{ hash: string }>;
    expect(pathToBlob.get('image.png')?.hash).toBe(hash);
    expect(pathToBlob.has('Shared/image.png')).toBe(false);
    expect(pathToBlob.has('skip.png')).toBe(false);
  });

  it('reconcile downloads remote-only blobs into the shared mount directory', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([6, 6, 6]);
    const hash = sha256hex(bytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('remote.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(`/blobs/${hash}`)) return binaryResponse(bytes);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      (docPath) => `Shared/${docPath}`,
      (vaultPath) => vaultPath.slice('Shared/'.length),
      (vaultPath) => vaultPath.startsWith('Shared/'),
    );

    await sync.reconcile('authoritative');

    const file = vault.getFileByPath('Shared/remote.png');
    expect(file).not.toBeNull();
    expect(new Uint8Array(await vault.readBinary(file!))).toEqual(bytes);
  });

  it('remote blob delete does not delete a folder at the blob path', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    vault.seedFolder('assets/folder.png');
    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.openRemoteApplyGate();
    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });

    ydoc.transact(() => {
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/folder.png', {
        hash: 'hash',
        deletedAt: new Date().toISOString(),
      });
    }, 'remote');

    await sync.handleRemoteBlobChanges(remoteTxn!);

    expect(vault.getAbstractFileByPath('assets/folder.png')).toBe(vault.folders.get('assets/folder.png'));
  });

  it('quarantines blob tombstones received before the startup gate opens', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    vault.seedBinary('assets/kept.png', new Uint8Array([1, 2, 3]));
    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    const deleteSpy = vi.spyOn(vault, 'delete');
    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });

    ydoc.transact(() => {
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/kept.png', {
        hash: 'legacy-hash',
        deletedAt: new Date().toISOString(),
      });
    }, 'remote');

    await sync.handleRemoteBlobChanges(remoteTxn!);

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(vault.getFileByPath('assets/kept.png')).not.toBeNull();
    expect((ydoc.getMap('blobTombstones') as Y.Map<unknown>).has('assets/kept.png')).toBe(true);
  });

  it('deletes local files for blob tombstones received after the startup gate opens', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    vault.seedBinary('assets/deleted.png', new Uint8Array([1, 2, 3]));
    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.openRemoteApplyGate();
    const deleteSpy = vi.spyOn(vault, 'delete');
    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });

    ydoc.transact(() => {
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/deleted.png', {
        hash: 'future-hash',
        deletedAt: new Date().toISOString(),
      });
    }, 'remote');

    await sync.handleRemoteBlobChanges(remoteTxn!);

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(vault.getFileByPath('assets/deleted.png')).toBeNull();
  });

  it('clears a polluted blob tombstone when the local file exists during authoritative reconcile', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([9, 8, 7]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/recovered.png', bytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; contentType: string; updatedAt: string }>).set('assets/recovered.png', {
      hash,
      size: bytes.byteLength,
      contentType: 'image/png',
      updatedAt: new Date().toISOString(),
    });
    (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/recovered.png', {
      hash,
      deletedAt: new Date().toISOString(),
    });
    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    const deleteSpy = vi.spyOn(vault, 'delete');

    await sync.reconcile('authoritative');

    expect(deleteSpy).not.toHaveBeenCalled();
    expect((ydoc.getMap('blobTombstones') as Y.Map<unknown>).has('assets/recovered.png')).toBe(false);
    expect(vault.getFileByPath('assets/recovered.png')).not.toBeNull();
  });

  it('preserves maintenance-blocked remote tombstones through authoritative reconcile and replays the delete', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([1, 3, 5]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/queued-delete.png', bytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/queued-delete.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.openRemoteApplyGate();
    sync.enterMaintenanceGate();

    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });
    ydoc.transact(() => {
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/queued-delete.png', {
        hash,
        deletedAt: new Date().toISOString(),
      });
    }, 'remote');

    await sync.handleRemoteBlobChanges(remoteTxn!);
    expect(sync.pendingRemoteDeleteCount).toBe(1);

    await sync.reconcile('authoritative');

    expect((ydoc.getMap('blobTombstones') as Y.Map<unknown>).has('assets/queued-delete.png')).toBe(true);
    expect(sync.pendingRemoteDeleteCount).toBe(1);
    expect(vault.getFileByPath('assets/queued-delete.png')).not.toBeNull();

    await sync.openRemoteApplyGate();

    expect(sync.pendingRemoteDeleteCount).toBe(0);
    expect(vault.getFileByPath('assets/queued-delete.png')).toBeNull();
  });

  it('does not let pending local upserts clear queued remote tombstones before replay', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([2, 4, 8]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/upsert-vs-delete.png', bytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/upsert-vs-delete.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });
    (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/upsert-vs-delete.png', {
      hash,
      deletedAt: new Date().toISOString(),
    });
    const store = {
      load: vi.fn(async (): Promise<BlobRuntimeState> => ({
        vaultId: 'vault-a',
        pendingRemoteDownloads: [],
        pendingRemoteDeletes: ['assets/upsert-vs-delete.png'],
        pendingLocalUpserts: ['assets/upsert-vs-delete.png'],
        pendingLocalDeletions: [],
        knownLocalPaths: [],
        updatedAt: new Date().toISOString(),
      })),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc, undefined, undefined, undefined, store);
    await sync.restoreRuntimeState();
    expect(sync.pendingUploadCount).toBe(1);
    expect(sync.pendingRemoteDeleteCount).toBe(1);

    await sync.openRemoteApplyGate();

    expect(sync.pendingUploadCount).toBe(0);
    expect(sync.pendingRemoteDeleteCount).toBe(0);
    expect((ydoc.getMap('blobTombstones') as Y.Map<unknown>).has('assets/upsert-vs-delete.png')).toBe(true);
    expect(vault.getFileByPath('assets/upsert-vs-delete.png')).toBeNull();
  });

  it('reconcile ignores Obsidian trash and Syncthing artifact blobs', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    vault.seedBinary('.obsidian/cache.dat', new Uint8Array([1]));
    vault.seedBinary('.trash/deleted.png', new Uint8Array([2]));
    vault.seedBinary('notes/.stversions/old.png', new Uint8Array([3]));
    vault.seedBinary('notes/foo.sync-conflict-20260428.png', new Uint8Array([4]));
    vault.seedBinary('notes/~syncthing~foo.png.tmp', new Uint8Array([5]));

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.reconcile('authoritative');

    expect((ydoc.getMap('pathToBlob') as Y.Map<unknown>).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('filters ignored pending runtime state and exposes pending details', async () => {
    const runtime = createRuntimeStateStore();
    await runtime.store.save('vault-a', {
      vaultId: 'vault-a',
      pendingRemoteDownloads: [
        { docPath: 'assets/download.png', hash: 'download-hash' },
        { docPath: '~syncthing~download.png.tmp', hash: 'ignored-download' },
      ],
      pendingRemoteDeletes: ['assets/delete.png', '~syncthing~delete.png.tmp'],
      pendingLocalUpserts: ['assets/upload.png', '~syncthing~upload.png.tmp'],
      pendingLocalDeletions: [
        { docPath: 'assets/local-delete.png', hash: 'local-delete-hash' },
        { docPath: '~syncthing~local-delete.png.tmp', hash: null },
      ],
      knownLocalPaths: ['assets/known.png', '~syncthing~known.png.tmp'],
      updatedAt: new Date().toISOString(),
    });

    const vault = new MockVault();
    vault.seedBinary('assets/upload.png', new Uint8Array([1]));
    const ydoc = new Y.Doc();
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/download.png', {
      hash: 'download-hash',
      size: 42,
      updatedAt: new Date().toISOString(),
    });
    (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/delete.png', {
      hash: 'delete-hash',
      deletedAt: new Date().toISOString(),
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc, undefined, undefined, undefined, runtime.store);
    await sync.restoreRuntimeState();

    expect(sync.getPendingBlobItems().map((item) => `${item.kind}:${item.path}`)).toEqual([
      'download:assets/download.png',
      'upload:assets/upload.png',
      'remote-delete:assets/delete.png',
      'local-delete:assets/local-delete.png',
    ]);
    expect(runtime.snapshot()?.knownLocalPaths).toEqual(['assets/known.png']);
  });

  it('restores pending remote downloads after reload', async () => {
    const bytes = new Uint8Array([4, 4, 4]);
    const hash = sha256hex(bytes);
    const ydoc = new Y.Doc();
    const runtime = createRuntimeStateStore();
    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });
    ydoc.transact(() => {
      (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/recover.png', {
        hash,
        size: bytes.byteLength,
        updatedAt: new Date().toISOString(),
      });
    }, 'remote');

    const firstVault = new MockVault();
    const firstSync = new BlobSync('ws://server.test', 'vault-a', 'token-a', firstVault as never, ydoc, undefined, undefined, undefined, runtime.store);
    await firstSync.handleRemoteBlobChanges(remoteTxn!);
    expect(runtime.snapshot()?.pendingRemoteDownloads).toEqual([{ docPath: 'assets/recover.png', hash }]);

    const secondVault = new MockVault();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(`/blobs/${hash}`)) return binaryResponse(bytes);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const restoredSync = new BlobSync('ws://server.test', 'vault-a', 'token-a', secondVault as never, ydoc, undefined, undefined, undefined, runtime.store);
    await restoredSync.restoreRuntimeState();
    await restoredSync.openRemoteApplyGate();

    const file = secondVault.getFileByPath('assets/recover.png');
    expect(file).not.toBeNull();
    expect(new Uint8Array(await secondVault.readBinary(file!))).toEqual(bytes);
  });

  it('restores pending local upserts after reload', async () => {
    const bytes = new Uint8Array([5, 5, 5]);
    const hash = sha256hex(bytes);
    const ydoc = new Y.Doc();
    const runtime = createRuntimeStateStore();
    const firstVault = new MockVault();
    firstVault.seedBinary('assets/upload.png', bytes);

    let allowPut = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/blobs/exists')) return jsonResponse({ existing: [] });
      if (url.endsWith(`/blobs/${hash}`) && init?.method === 'PUT') {
        if (!allowPut) {
          throw new Error('simulated upload interruption');
        }
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });

    const firstSync = new BlobSync('ws://server.test', 'vault-a', 'token-a', firstVault as never, ydoc, undefined, undefined, undefined, runtime.store);
    await expect(firstSync.handleLocalBlobChange('assets/upload.png')).rejects.toThrow('simulated upload interruption');
    expect(runtime.snapshot()?.pendingLocalUpserts).toEqual(['assets/upload.png']);

    const secondVault = new MockVault();
    secondVault.seedBinary('assets/upload.png', bytes);
    allowPut = true;
    const restoredSync = new BlobSync('ws://server.test', 'vault-a', 'token-a', secondVault as never, ydoc, undefined, undefined, undefined, runtime.store);
    await restoredSync.restoreRuntimeState();
    await restoredSync.openRemoteApplyGate();

    const ref = (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string }>).get('assets/upload.png');
    expect(ref?.hash).toBe(hash);
    expect(runtime.snapshot()).toMatchObject({
      pendingLocalUpserts: [],
      pendingLocalDeletions: [],
      pendingRemoteDeletes: [],
      pendingRemoteDownloads: [],
      knownLocalPaths: ['assets/upload.png'],
    });
  });

  it('tracks pending local deletion when ref is absent and flushes tombstone when ref arrives later', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([3, 1, 4]);
    const hash = sha256hex(bytes);
    const file = vault.seedBinary('assets/startup-delete.png', bytes);
    const runtime = createRuntimeStateStore();

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      runtime.store,
    );

    // 启动窗口期用户删除：pathToBlob 空、hashCache 也空，pending 必须登记但 hash 为 null。
    await vault.delete(file);
    await sync.handleLocalBlobDeletion('assets/startup-delete.png');
    expect(runtime.snapshot()?.pendingLocalDeletions).toEqual([
      { docPath: 'assets/startup-delete.png', hash: null },
    ]);

    // gate 打开时还没有任何 ref → flushPendingLocalDeletions 保留条目。
    await sync.openRemoteApplyGate();
    expect((ydoc.getMap('blobTombstones') as Y.Map<unknown>).has('assets/startup-delete.png')).toBe(false);
    expect(runtime.snapshot()?.pendingLocalDeletions).toEqual([
      { docPath: 'assets/startup-delete.png', hash: null },
    ]);

    // 服务端随后推来 pathToBlob → handleRemoteBlobChanges 在 flush 前会先尝试处理 pending deletion。
    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });
    ydoc.transact(() => {
      (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/startup-delete.png', {
        hash,
        size: bytes.byteLength,
        updatedAt: new Date().toISOString(),
      });
    }, 'remote');
    await sync.handleRemoteBlobChanges(remoteTxn!);

    expect((ydoc.getMap('blobTombstones') as Y.Map<{ hash: string }>).get('assets/startup-delete.png')?.hash).toBe(hash);
    expect(vault.getFileByPath('assets/startup-delete.png')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toBeNull();
  });

  it('writes tombstone immediately when deletion sees an existing ref', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([9, 0, 9]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/existing.png', bytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/existing.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });
    const runtime = createRuntimeStateStore();

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      runtime.store,
    );

    // Phase 9：deletion 入队列串行执行，调用方必须 await 以便断言 tombstone 已写入。
    await vault.delete(vault.getFileByPath('assets/existing.png')!);
    await sync.handleLocalBlobDeletion('assets/existing.png');

    expect((ydoc.getMap('pathToBlob') as Y.Map<unknown>).has('assets/existing.png')).toBe(false);
    expect((ydoc.getMap('blobTombstones') as Y.Map<{ hash: string }>).get('assets/existing.png')?.hash).toBe(hash);
    expect(runtime.snapshot()).toBeNull();
  });

  it('restores pending local deletions and flushes them once ref is available after reload', async () => {
    const bytes = new Uint8Array([2, 7, 1]);
    const hash = sha256hex(bytes);
    const runtime = createRuntimeStateStore();
    const firstVault = new MockVault();
    const ydoc1 = new Y.Doc();
    const file = firstVault.seedBinary('assets/lost.png', bytes);

    const firstSync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      firstVault as never,
      ydoc1,
      undefined,
      undefined,
      undefined,
      runtime.store,
    );
    await firstVault.delete(file);
    await firstSync.handleLocalBlobDeletion('assets/lost.png');
    expect(runtime.snapshot()?.pendingLocalDeletions).toEqual([{ docPath: 'assets/lost.png', hash: null }]);

    // 模拟重启：全新 ydoc 与 vault，仅有 runtime 状态。
    const secondVault = new MockVault();
    const ydoc2 = new Y.Doc();
    const restoredSync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      secondVault as never,
      ydoc2,
      undefined,
      undefined,
      undefined,
      runtime.store,
    );
    await restoredSync.restoreRuntimeState();
    await restoredSync.openRemoteApplyGate();

    // 此时还没有 ref，pending 应该保留。
    expect(runtime.snapshot()?.pendingLocalDeletions).toEqual([{ docPath: 'assets/lost.png', hash: null }]);

    // 服务端随后推来 pathToBlob → 依据 ref.hash 写 tombstone。
    let remoteTxn: Y.Transaction | null = null;
    ydoc2.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });
    ydoc2.transact(() => {
      (ydoc2.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/lost.png', {
        hash,
        size: bytes.byteLength,
        updatedAt: new Date().toISOString(),
      });
    }, 'remote');
    await restoredSync.handleRemoteBlobChanges(remoteTxn!);

    expect((ydoc2.getMap('blobTombstones') as Y.Map<{ hash: string }>).get('assets/lost.png')?.hash).toBe(hash);
    expect(runtime.snapshot()).toBeNull();
  });

  it('drops orphan pending local deletions when no remote ref or hash exists after reconcile', async () => {
    const runtime = createRuntimeStateStore();
    await runtime.store.save('vault-a', {
      vaultId: 'vault-a',
      pendingRemoteDownloads: [],
      pendingRemoteDeletes: [],
      pendingLocalUpserts: [],
      pendingLocalDeletions: [{ docPath: '未命名', hash: null }],
      knownLocalPaths: ['未命名'],
      updatedAt: new Date().toISOString(),
    });

    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      runtime.store,
    );

    await sync.restoreRuntimeState();
    expect(sync.getPendingBlobItems()).toEqual([{ kind: 'local-delete', path: '未命名', hash: null }]);

    await sync.reconcile('authoritative');
    await sync.flushPersistChain();

    expect(sync.getPendingBlobItems()).toEqual([]);
    expect(runtime.snapshot()).toBeNull();
  });

  it('does not restore pending local deletions saved for a different shared mount localPath', async () => {
    const bytes = new Uint8Array([4, 2, 0]);
    const hash = sha256hex(bytes);
    const runtime = createRuntimeStateStore();
    await runtime.store.save('vault-a', {
      vaultId: 'vault-a',
      pendingRemoteDownloads: [],
      pendingRemoteDeletes: [],
      pendingLocalUpserts: [],
      pendingLocalDeletions: [{ docPath: 'assets/old-mount.png', hash: null }],
      knownLocalPaths: [],
      localPath: '/vault/OldShared',
      updatedAt: new Date().toISOString(),
    });

    const vault = new MockVault();
    const ydoc = new Y.Doc();
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/old-mount.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      (docPath) => `NewShared/${docPath}`,
      (vaultPath) => vaultPath.slice('NewShared/'.length),
      (vaultPath) => vaultPath.startsWith('NewShared/'),
      runtime.store,
      'vault-a',
      '/vault/NewShared',
    );

    await sync.restoreRuntimeState();
    await sync.openRemoteApplyGate();

    expect(sync.pendingLocalDeletionCount).toBe(0);
    expect((ydoc.getMap('pathToBlob') as Y.Map<unknown>).has('assets/old-mount.png')).toBe(true);
    expect((ydoc.getMap('blobTombstones') as Y.Map<unknown>).has('assets/old-mount.png')).toBe(false);
  });

  it('restores pending local deletions saved for the same shared mount localPath', async () => {
    const bytes = new Uint8Array([4, 2, 1]);
    const hash = sha256hex(bytes);
    const runtime = createRuntimeStateStore();
    await runtime.store.save('vault-a', {
      vaultId: 'vault-a',
      pendingRemoteDownloads: [],
      pendingRemoteDeletes: [],
      pendingLocalUpserts: [],
      pendingLocalDeletions: [{ docPath: 'assets/same-mount.png', hash: null }],
      knownLocalPaths: [],
      localPath: '/vault/Shared',
      updatedAt: new Date().toISOString(),
    });

    const vault = new MockVault();
    const ydoc = new Y.Doc();
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/same-mount.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      (docPath) => `Shared/${docPath}`,
      (vaultPath) => vaultPath.slice('Shared/'.length),
      (vaultPath) => vaultPath.startsWith('Shared/'),
      runtime.store,
      'vault-a',
      '/vault/Shared',
    );

    await sync.restoreRuntimeState();
    await sync.openRemoteApplyGate();

    expect((ydoc.getMap('pathToBlob') as Y.Map<unknown>).has('assets/same-mount.png')).toBe(false);
    expect((ydoc.getMap('blobTombstones') as Y.Map<{ hash: string }>).get('assets/same-mount.png')?.hash).toBe(hash);
    expect(sync.pendingLocalDeletionCount).toBe(0);
  });

  it('drops pending deletion if the file reappears before flush', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([6, 6, 6]);
    const file = vault.seedBinary('assets/resurrect.png', bytes);
    const runtime = createRuntimeStateStore();

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      runtime.store,
    );
    await vault.delete(file);
    const deletionPromise = sync.handleLocalBlobDeletion('assets/resurrect.png');

    // 用户又把文件恢复回来（在 deletion 的 async 部分执行之前）。
    vault.seedBinary('assets/resurrect.png', bytes);

    await deletionPromise;
    await sync.openRemoteApplyGate();

    expect((ydoc.getMap('blobTombstones') as Y.Map<unknown>).has('assets/resurrect.png')).toBe(false);
    expect(runtime.snapshot()).toBeNull();
  });

  it('restoreRuntimeState is idempotent', async () => {
    const ydoc = new Y.Doc();
    const runtime = createRuntimeStateStore();
    const vault = new MockVault();
    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      runtime.store,
    );

    await sync.restoreRuntimeState();
    await sync.restoreRuntimeState();
    expect(runtime.store.load).toHaveBeenCalledTimes(1);
  });

  it('keeps pending remote changes blocked until the gate is opened', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([6, 7, 8]);
    const hash = sha256hex(bytes);
    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });
    ydoc.transact(() => {
      (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/stateful.png', {
        hash,
        size: bytes.byteLength,
        updatedAt: new Date().toISOString(),
      });
    }, 'remote');

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(`/blobs/${hash}`)) return binaryResponse(bytes);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.handleRemoteBlobChanges(remoteTxn!);
    expect(sync.getRemoteApplyGateState()).toBe('startup-blocked');
    expect(vault.getFileByPath('assets/stateful.png')).toBeNull();

    sync.enterMaintenanceGate();
    expect(sync.getRemoteApplyGateState()).toBe('maintenance-blocked');
    expect(vault.getFileByPath('assets/stateful.png')).toBeNull();

    await sync.openRemoteApplyGate();
    expect(sync.getRemoteApplyGateState()).toBe('open');
    expect(vault.getFileByPath('assets/stateful.png')).not.toBeNull();
  });

  // ── Phase 9: 本地路径严格串行化 ───────────────────────────────────────────
  // Issue A：同一路径 modify 与 delete 事件交错时不应互相覆盖。

  it('delete after in-flight upsert produces tombstone and skips late pathToBlob write', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([9, 1, 2, 3]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/race.png', bytes);

    let releaseUpload!: () => void;
    let uploadStarted!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploadStartedPromise = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/blobs/exists')) return jsonResponse({ existing: [] });
      if (url.endsWith(`/blobs/${hash}`) && init?.method === 'PUT') {
        uploadStarted();
        await uploadGate; // 模拟慢上传：delete 有窗口介入。
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);

    const upsertPromise = sync.handleLocalBlobChange('assets/race.png');
    // 等 upsert 实际读完并进入 PUT 阶段，才能构造 "读到 hash 再被删除" 的 race。
    await uploadStartedPromise;
    await vault.delete(vault.getFileByPath('assets/race.png')!);
    const deletionPromise = sync.handleLocalBlobDeletion('assets/race.png');

    // 放行上传让 upsert 进入最后的 re-check 分支。
    releaseUpload();
    await upsertPromise;
    await deletionPromise;

    expect((ydoc.getMap('pathToBlob') as Y.Map<unknown>).has('assets/race.png')).toBe(false);
    const tomb = (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string }>).get('assets/race.png');
    expect(tomb?.hash).toBe(hash);
  });

  it('delete after completed upsert writes tombstone without being undone', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([4, 5, 6, 7]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/finished.png', bytes);

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/blobs/exists')) return jsonResponse({ existing: [] });
      if (url.endsWith(`/blobs/${hash}`) && init?.method === 'PUT') {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.handleLocalBlobChange('assets/finished.png');
    expect(
      (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string }>).get('assets/finished.png')?.hash,
    ).toBe(hash);

    await vault.delete(vault.getFileByPath('assets/finished.png')!);
    await sync.handleLocalBlobDeletion('assets/finished.png');

    expect((ydoc.getMap('pathToBlob') as Y.Map<unknown>).has('assets/finished.png')).toBe(false);
    expect(
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string }>).get('assets/finished.png')?.hash,
    ).toBe(hash);
  });

  // ── Phase 10: Tombstone 优先的 reconcile ──────────────────────────────────
  // Issue C：pathToBlob 与 blobTombstones 同 key 并存时，reconcile 必须以 tombstone 为准。

  it('authoritative reconcile does not download blobs that are also tombstoned', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([5, 5, 5, 1]);
    const hash = sha256hex(bytes);
    ydoc.transact(() => {
      (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/ghost.png', {
        hash,
        size: bytes.byteLength,
        updatedAt: new Date().toISOString(),
      });
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/ghost.png', {
        hash,
        deletedAt: new Date().toISOString(),
      });
    });

    fetchMock.mockImplementation(async () => {
      throw new Error('should not fetch when tombstone is present');
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.reconcile('authoritative');

    expect(vault.getFileByPath('assets/ghost.png')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('conservative reconcile does not download blobs that are also tombstoned', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([5, 5, 5, 2]);
    const hash = sha256hex(bytes);
    ydoc.transact(() => {
      (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/ghost.png', {
        hash,
        size: bytes.byteLength,
        updatedAt: new Date().toISOString(),
      });
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/ghost.png', {
        hash,
        deletedAt: new Date().toISOString(),
      });
    });

    fetchMock.mockImplementation(async () => {
      throw new Error('should not fetch when tombstone is present');
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.reconcile('conservative');

    expect(vault.getFileByPath('assets/ghost.png')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Phase 11: RuntimeState 持久化串行化 ────────────────────────────────────
  // Issue D：连续 persist 必须按顺序落盘；单次失败不能阻塞后续写入。

  it('serializes runtime state persistence and matches the last snapshot', async () => {
    const ydoc = new Y.Doc();
    const vault = new MockVault();
    const saves: BlobRuntimeState[] = [];
    let clears = 0;
    const store = {
      load: vi.fn(async () => null),
      save: vi.fn(async (_vaultId: string, next: BlobRuntimeState) => {
        saves.push(structuredClone(next));
      }),
      clear: vi.fn(async () => {
        clears++;
      }),
    };

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      store,
    );

    const bytes = new Uint8Array([1, 2, 3]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/chain.png', bytes);

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/blobs/exists')) return jsonResponse({ existing: [] });
      if (url.endsWith(`/blobs/${hash}`) && init?.method === 'PUT') return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });

    await sync.handleLocalBlobChange('assets/chain.png');
    await sync.flushPersistChain();

    // 上面一次完整的 upsert 会产生若干次 persist（add pending → success 后 delete pending → clear）。
    // 最关键的验证：最终落盘状态等于最后一次内存快照。
    const lastSaveHadUpsert = saves.some((s) => s.pendingLocalUpserts.includes('assets/chain.png'));
    expect(lastSaveHadUpsert).toBe(true);
    // 现在成功后会保留 knownLocalPaths，用于跨会话识别“曾在本地、随后被删除”的 blob。
    expect(saves.at(-1)).toMatchObject({
      pendingLocalUpserts: [],
      pendingLocalDeletions: [],
      pendingRemoteDeletes: [],
      pendingRemoteDownloads: [],
      knownLocalPaths: ['assets/chain.png'],
    });
    expect(clears).toBe(0);
  });

  it('keeps persisting after a single save failure', async () => {
    const ydoc = new Y.Doc();
    const vault = new MockVault();
    let callCount = 0;
    const saved: BlobRuntimeState[] = [];
    const store = {
      load: vi.fn(async () => null),
      save: vi.fn(async (_vaultId: string, next: BlobRuntimeState) => {
        callCount++;
        if (callCount === 1) throw new Error('transient IDB failure');
        saved.push(structuredClone(next));
      }),
      clear: vi.fn(async () => {}),
    };

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      store,
    );

    // 两次 persist：第一次 save 抛错后，第二次仍应落地。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bytes = new Uint8Array([3, 1, 4]);
    const file = vault.seedBinary('assets/resilient.png', bytes);
    await vault.delete(file);
    await sync.handleLocalBlobDeletion('assets/resilient.png'); // 第 1 次 persist：save 会抛错
    vault.seedBinary('assets/resilient.png', bytes); // restore 让下一次 persist 触发不同路径
    await sync.handleLocalBlobDeletion('assets/resilient.png'); // 额外触发 persist
    await sync.flushPersistChain();

    expect(callCount).toBeGreaterThan(1);
    expect(saved.length).toBeGreaterThan(0);
    consoleError.mockRestore();
  });

  // ── Phase 12: 组合场景 ────────────────────────────────────────────────────

  it('combines Phase 9 race with Phase 11 serialized persistence', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([8, 1, 6, 2]);
    const hash = sha256hex(bytes);
    vault.seedBinary('assets/combo.png', bytes);
    const runtime = createRuntimeStateStore();

    let releaseUpload!: () => void;
    let uploadStarted!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploadStartedPromise = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/blobs/exists')) return jsonResponse({ existing: [] });
      if (url.endsWith(`/blobs/${hash}`) && init?.method === 'PUT') {
        uploadStarted();
        await uploadGate;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      runtime.store,
    );

    const upsertPromise = sync.handleLocalBlobChange('assets/combo.png');
    await uploadStartedPromise;
    // upsert 卡住的窗口期里用户删除文件 → 触发 persist 链上的多次写入。
    await vault.delete(vault.getFileByPath('assets/combo.png')!);
    const deletionPromise = sync.handleLocalBlobDeletion('assets/combo.png');
    releaseUpload();
    await upsertPromise;
    await deletionPromise;
    await sync.flushPersistChain();

    expect((ydoc.getMap('pathToBlob') as Y.Map<unknown>).has('assets/combo.png')).toBe(false);
    expect(
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string }>).get('assets/combo.png')?.hash,
    ).toBe(hash);
    // 顺序性：最后一次 persist 产出空状态 → 最终结果是 null（clear）。
    expect(runtime.snapshot()).toBeNull();
  });

  it('combines Phase 8 startup deletion with Phase 10 tombstone short-circuit', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([7, 7, 7, 1]);
    const hash = sha256hex(bytes);
    const file = vault.seedBinary('assets/combo-ghost.png', bytes);
    const runtime = createRuntimeStateStore();

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      runtime.store,
    );

    // 启动窗口期：本地删除登记到 pending（hash 未知）。
    await vault.delete(file);
    await sync.handleLocalBlobDeletion('assets/combo-ghost.png');

    // 远端同一路径并发推送 pathToBlob 与 blobTombstones（跨设备 LWW 并存）。
    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });
    ydoc.transact(() => {
      (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/combo-ghost.png', {
        hash,
        size: bytes.byteLength,
        updatedAt: new Date().toISOString(),
      });
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>).set('assets/combo-ghost.png', {
        hash,
        deletedAt: new Date().toISOString(),
      });
    }, 'remote');

    fetchMock.mockImplementation(async () => {
      throw new Error('should not fetch when tombstone already present');
    });

    await sync.handleRemoteBlobChanges(remoteTxn!);
    await sync.openRemoteApplyGate();
    await sync.reconcile('authoritative');

    expect(vault.getFileByPath('assets/combo-ghost.png')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // pending 已在 flushPendingLocalDeletions 中被 tombstone 的存在消化。
    expect(runtime.snapshot()).toBeNull();
  });

  it('delete-then-create same path ends with new ref and no tombstone', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const oldBytes = new Uint8Array([1, 1, 1]);
    const newBytes = new Uint8Array([2, 2, 2]);
    const oldHash = sha256hex(oldBytes);
    const newHash = sha256hex(newBytes);
    vault.seedBinary('assets/cycle.png', oldBytes);

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/blobs/exists')) return jsonResponse({ existing: [] });
      if (url.endsWith(`/blobs/${oldHash}`) && init?.method === 'PUT') return new Response(null, { status: 200 });
      if (url.endsWith(`/blobs/${newHash}`) && init?.method === 'PUT') return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });

    const sync = new BlobSync('ws://server.test', 'vault-a', 'token-a', vault as never, ydoc);
    await sync.handleLocalBlobChange('assets/cycle.png');
    await vault.delete(vault.getFileByPath('assets/cycle.png')!);
    await sync.handleLocalBlobDeletion('assets/cycle.png');

    expect(
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string }>).get('assets/cycle.png')?.hash,
    ).toBe(oldHash);

    vault.seedBinary('assets/cycle.png', newBytes);
    await sync.handleLocalBlobChange('assets/cycle.png');

    expect(
      (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string }>).get('assets/cycle.png')?.hash,
    ).toBe(newHash);
    expect((ydoc.getMap('blobTombstones') as Y.Map<unknown>).has('assets/cycle.png')).toBe(false);
  });

  // ── F1: reconcile 尊重 pendingLocalDeletions ──────────────────────────────

  it('reconcile does not resurrect blob when pendingLocalDeletions is restored before reconcile', async () => {
    // 模拟上次会话用户删除了附件但崩溃，pendingLocalDeletions 已落到 IDB。
    const bytes = new Uint8Array([7, 7, 7]);
    const hash = sha256hex(bytes);
    const runtime = createRuntimeStateStore();

    // 预置 runtime 状态（模拟上次会话落盘的 pending）。
    await runtime.store.save('vault-a', {
      vaultId: 'vault-a',
      pendingRemoteDownloads: [],
      pendingRemoteDeletes: [],
      pendingLocalUpserts: [],
      pendingLocalDeletions: [{ docPath: 'assets/ghost.png', hash }],
      updatedAt: new Date().toISOString(),
    });

    const vault = new MockVault(); // 本地无该文件
    const ydoc = new Y.Doc();
    // 模拟本地 cache 还原：pathToBlob 有 ref，但 blobTombstones 为空。
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set(
      'assets/ghost.png',
      { hash, size: bytes.byteLength, updatedAt: new Date().toISOString() },
    );

    fetchMock.mockImplementation(async () => {
      throw new Error('should not fetch — blob was deleted by user');
    });

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      runtime.store,
    );

    // 模拟 runBlobMaintenance 的执行顺序：restoreRuntimeState → reconcile
    await sync.restoreRuntimeState();
    await sync.reconcile('authoritative');

    // 不应触发任何下载请求
    expect(fetchMock).not.toHaveBeenCalled();
    // tombstone 已写入，pathToBlob 已移除
    expect((ydoc.getMap('pathToBlob') as Y.Map<unknown>).has('assets/ghost.png')).toBe(false);
    expect(
      (ydoc.getMap('blobTombstones') as Y.Map<{ hash: string }>).get('assets/ghost.png')?.hash,
    ).toBe(hash);
    // 本地仍无文件
    expect(vault.getFileByPath('assets/ghost.png')).toBeNull();
  });

  // ── F2: flushPendingLocalUpserts 错误兜底 ─────────────────────────────────

  it('flushPendingLocalUpserts continues after a single upsert failure', async () => {
    const bytesA = new Uint8Array([1, 0, 1]);
    const bytesB = new Uint8Array([2, 0, 2]);
    const hashA = sha256hex(bytesA);
    const hashB = sha256hex(bytesB);
    const runtime = createRuntimeStateStore();

    // 预置 runtime 状态：两个 pending upsert。
    await runtime.store.save('vault-a', {
      vaultId: 'vault-a',
      pendingRemoteDownloads: [],
      pendingRemoteDeletes: [],
      pendingLocalUpserts: ['assets/fail.png', 'assets/ok.png'],
      pendingLocalDeletions: [],
      updatedAt: new Date().toISOString(),
    });

    const vault = new MockVault();
    vault.seedBinary('assets/fail.png', bytesA);
    vault.seedBinary('assets/ok.png', bytesB);
    const ydoc = new Y.Doc();

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/blobs/exists')) return jsonResponse({ existing: [] });
      // fail.png 的上传抛错
      if (url.endsWith(`/blobs/${hashA}`) && init?.method === 'PUT') {
        throw new Error('simulated upload failure for fail.png');
      }
      // ok.png 的上传成功
      if (url.endsWith(`/blobs/${hashB}`) && init?.method === 'PUT') {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });

    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      runtime.store,
    );

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sync.restoreRuntimeState();
    await sync.openRemoteApplyGate();

    // ok.png 应该上传成功并写入 pathToBlob
    const pathToBlob = ydoc.getMap('pathToBlob') as Y.Map<{ hash: string }>;
    expect(pathToBlob.get('assets/ok.png')?.hash).toBe(hashB);

    // fail.png 上传失败：不应写入 pathToBlob，仍保留在 pendingLocalUpserts 待重试
    expect(pathToBlob.has('assets/fail.png')).toBe(false);
    const snap = runtime.snapshot();
    expect(snap?.pendingLocalUpserts).toContain('assets/fail.png');

    consoleError.mockRestore();
  });

  it('detects missed local deletion even when hashCache is empty (cross-session)', async () => {
    // Scenario: blob was present on device in a previous session (knownLocalPaths persisted),
    // then deleted while the plugin was stopped.  On restart hashCache is empty.
    // Without knownLocalPaths, isMissingLocalBlob would return false and re-download the file.
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = sha256hex(bytes);
    const runtime = createRuntimeStateStore();

    // ── Session 1: file is present, reconcile → populates knownLocalPaths ──
    vault.seedBinary('assets/will-delete.png', bytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set(
      'assets/will-delete.png',
      { hash, size: bytes.byteLength, updatedAt: new Date().toISOString() },
    );

    const sync1 = new BlobSync(
      'ws://server.test', 'vault-a', 'token-a', vault as never, ydoc,
      undefined, undefined, undefined, runtime.store,
    );
    await sync1.reconcile('authoritative'); // populates knownLocalPaths
    await sync1.flushPersistChain();
    expect(runtime.snapshot()?.knownLocalPaths).toContain('assets/will-delete.png');

    // ── Between sessions: file is deleted from vault ──
    await vault.delete(vault.getFileByPath('assets/will-delete.png')!);

    // ── Session 2: hashCache is empty (new instance), but knownLocalPaths restored ──
    const sync2 = new BlobSync(
      'ws://server.test', 'vault-a', 'token-a', vault as never, ydoc,
      undefined, undefined, undefined, runtime.store,
    );
    await sync2.restoreRuntimeState(); // restores knownLocalPaths

    // No network calls expected — should tombstone, not download
    fetchMock.mockImplementation(async () => {
      throw new Error('should not attempt download of deleted blob');
    });

    await sync2.reconcile('authoritative');

    const tombstones = ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>;
    expect(tombstones.has('assets/will-delete.png')).toBe(true);
    expect(tombstones.get('assets/will-delete.png')?.hash).toBe(hash);
    // File must NOT have been re-downloaded
    expect(vault.getFileByPath('assets/will-delete.png')).toBeNull();
  });

  it('knownLocalPaths is cleared when tombstone is committed', async () => {
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    const bytes = new Uint8Array([5, 5, 5]);
    const hash = sha256hex(bytes);
    const runtime = createRuntimeStateStore();

    vault.seedBinary('assets/to-tombstone.png', bytes);
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set(
      'assets/to-tombstone.png',
      { hash, size: bytes.byteLength, updatedAt: new Date().toISOString() },
    );

    const sync = new BlobSync(
      'ws://server.test', 'vault-a', 'token-a', vault as never, ydoc,
      undefined, undefined, undefined, runtime.store,
    );
    await sync.reconcile('authoritative'); // file present → added to knownLocalPaths
    await sync.flushPersistChain();
    expect(runtime.snapshot()?.knownLocalPaths).toContain('assets/to-tombstone.png');

    // Delete the file and write tombstone via handleLocalBlobDeletion
    await vault.delete(vault.getFileByPath('assets/to-tombstone.png')!);
    await sync.handleLocalBlobDeletion('assets/to-tombstone.png');
    await sync.flushPersistChain();

    // knownLocalPaths should no longer include the path after tombstone is written
    const snap = runtime.snapshot();
    expect(snap?.knownLocalPaths ?? []).not.toContain('assets/to-tombstone.png');
  });
});

describe('BlobSync localPath guard (Bug 2: mount path change)', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips knownLocalPaths restore when localPath has changed, preventing false blob deletion', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = sha256hex(bytes);
    const runtime = createRuntimeStateStore();

    // Simulate saved state from previous session where localPath was 'OldDir'
    await runtime.store.save('ws://server.test::vault-a', {
      vaultId: 'ws://server.test::vault-a',
      pendingRemoteDownloads: [],
      pendingRemoteDeletes: [],
      pendingLocalUpserts: [],
      pendingLocalDeletions: [],
      knownLocalPaths: ['image.png'],
      localPath: 'OldDir',
      updatedAt: new Date().toISOString(),
    });

    const vault = new MockVault();
    // New directory is empty — simulates localPath changed to 'NewDir', no files there yet
    const ydoc = new Y.Doc();
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('image.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith(`/blobs/${hash}`)) return binaryResponse(bytes);
      throw new Error(`unexpected fetch: ${url}`);
    });

    // New engine with localPath = 'NewDir'
    const sync = new BlobSync(
      'ws://server.test',
      'vault-a',
      'token-a',
      vault as never,
      ydoc,
      (docPath) => `NewDir/${docPath}`,
      (vaultPath) => vaultPath.slice('NewDir/'.length),
      (vaultPath) => vaultPath.startsWith('NewDir/'),
      runtime.store,
      'ws://server.test::vault-a',
      'NewDir',
    );

    await sync.restoreRuntimeState();
    await sync.reconcile('authoritative');

    // knownLocalPaths was NOT restored (path changed) → isMissingLocalBlob = false
    // → file should be downloaded, not tombstoned
    const blobTombstones = ydoc.getMap('blobTombstones') as Y.Map<unknown>;
    expect(blobTombstones.has('image.png')).toBe(false);

    const file = vault.getFileByPath('NewDir/image.png');
    expect(file).not.toBeNull();
  });

  it('restores knownLocalPaths normally when localPath is unchanged', async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const hash = sha256hex(bytes);
    const runtime = createRuntimeStateStore();

    // Simulate saved state from previous session with same localPath 'SharedDir'
    await runtime.store.save('ws://server.test::vault-b', {
      vaultId: 'ws://server.test::vault-b',
      pendingRemoteDownloads: [],
      pendingRemoteDeletes: [],
      pendingLocalUpserts: [],
      pendingLocalDeletions: [],
      knownLocalPaths: ['photo.png'],
      localPath: 'SharedDir',
      updatedAt: new Date().toISOString(),
    });

    // New session: file was deleted while plugin was stopped, SharedDir still same path
    const vault = new MockVault();
    const ydoc = new Y.Doc();
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('photo.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    // New engine with same localPath = 'SharedDir'
    const sync = new BlobSync(
      'ws://server.test',
      'vault-b',
      'token-b',
      vault as never,
      ydoc,
      (docPath) => `SharedDir/${docPath}`,
      (vaultPath) => vaultPath.slice('SharedDir/'.length),
      (vaultPath) => vaultPath.startsWith('SharedDir/'),
      runtime.store,
      'ws://server.test::vault-b',
      'SharedDir',
    );

    await sync.restoreRuntimeState();
    await sync.reconcile('authoritative');

    // knownLocalPaths WAS restored (same path) → file not on disk → treated as deleted → tombstone
    const blobTombstones = ydoc.getMap('blobTombstones') as Y.Map<{ hash: string }>;
    expect(blobTombstones.get('photo.png')?.hash).toBe(hash);

    // File should not be re-downloaded
    expect(vault.getFileByPath('SharedDir/photo.png')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('primary vault (localPath undefined) behaves as before — knownLocalPaths restored', async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const hash = sha256hex(bytes);
    const runtime = createRuntimeStateStore();

    // Primary vault: localPath is undefined on both sides
    await runtime.store.save('ws://server.test::vault-c', {
      vaultId: 'ws://server.test::vault-c',
      pendingRemoteDownloads: [],
      pendingRemoteDeletes: [],
      pendingLocalUpserts: [],
      pendingLocalDeletions: [],
      knownLocalPaths: ['assets/note.png'],
      // localPath intentionally omitted (primary vault)
      updatedAt: new Date().toISOString(),
    });

    const vault = new MockVault();
    const ydoc = new Y.Doc();
    (ydoc.getMap('pathToBlob') as Y.Map<{ hash: string; size: number; updatedAt: string }>).set('assets/note.png', {
      hash,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
    });

    // Primary vault BlobSync: no localPath param
    const sync = new BlobSync(
      'ws://server.test',
      'vault-c',
      'token-c',
      vault as never,
      ydoc,
      undefined,
      undefined,
      undefined,
      runtime.store,
      'ws://server.test::vault-c',
      // localPath omitted → undefined
    );

    await sync.restoreRuntimeState();
    await sync.reconcile('authoritative');

    // Primary vault: undefined === undefined → knownLocalPaths restored → file missing → tombstone
    const blobTombstones = ydoc.getMap('blobTombstones') as Y.Map<{ hash: string }>;
    expect(blobTombstones.get('assets/note.png')?.hash).toBe(hash);
  });

});
