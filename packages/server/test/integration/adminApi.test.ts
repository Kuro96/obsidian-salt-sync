import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { SnapshotMeta } from '@salt-sync/shared';
import { startTestServer, TEST_S3, type TestServer } from '../helpers/integrationServer';

let srv: TestServer;

afterEach(async () => {
  if (srv) await srv.cleanup();
});

const minioAvailable = await fetch(`${TEST_S3.endpoint}/minio/health/live`).then(
  (r) => r.ok,
  () => false,
);

const skipIfNoMinio = minioAvailable ? describe : describe.skip;

describe('Admin API integration', () => {
  it('GET /admin/api/overview returns health-like summary plus token mode', async () => {
    srv = await startTestServer({ serverToken: 'admin' });

    const res = await fetch(`${srv.baseUrl}/admin/api/overview`, {
      headers: { Authorization: 'Bearer admin' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      rooms: { active: number };
      tokenMode: string;
      schemaVersion: number;
    };
    expect(body.status).toBe('ok');
    expect(body.rooms.active).toBe(0);
    expect(body.tokenMode).toBe('env-fallback');
    expect(body.schemaVersion).toBeTypeOf('number');
  });

  it('GET /admin/api/rooms/:vaultId returns room and persistence details', async () => {
    srv = await startTestServer({ serverToken: 'admin' });

    const room = await srv.app.roomManager.getOrCreate('vault-a');
    await room.load();
    const doc = new Y.Doc();
    const text = new Y.Text();
    text.insert(0, 'hello admin');
    doc.getMap<string>('pathToId').set('hello.md', 'f1');
    doc.getMap<string>('idToPath').set('f1', 'hello.md');
    doc.getMap<Y.Text>('docs').set('f1', text);
    await room.applyClientUpdate('seed', Y.encodeStateAsUpdate(doc));
    await room.saveNow();

    const res = await fetch(`${srv.baseUrl}/admin/api/rooms/vault-a`, {
      headers: { Authorization: 'Bearer admin' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      vaultId: string;
      active: boolean;
      room: { connectedClientCount: number; loaded: boolean; updatedAt?: string };
      state: { markdownPathCount: number; markdownDocCount: number };
      persistence: { nextSeq: number; journalEntryCount: number };
    };
    expect(body.vaultId).toBe('vault-a');
    expect(body.active).toBe(true);
    expect(body.room.loaded).toBe(true);
    expect(body.room.updatedAt).toBeTruthy();
    expect(body.state.markdownPathCount).toBe(1);
    expect(body.state.markdownDocCount).toBe(1);
    expect(body.persistence.nextSeq).toBe(1);
    expect(body.persistence.journalEntryCount).toBe(1);
  });

  it('GET /admin/api/config redacts config and requires admin auth', async () => {
    srv = await startTestServer({ serverToken: 'admin', dbTokens: [{ name: 'primary' }] });

    const unauthorized = await fetch(`${srv.baseUrl}/admin/api/config`);
    expect(unauthorized.status).toBe(401);

    const res = await fetch(`${srv.baseUrl}/admin/api/config`, {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auth: { tokenMode: string; dbTokenCount: number };
      storage: { s3Endpoint: string | null };
    };
    expect(body.auth.tokenMode).toBe('db');
    expect(body.auth.dbTokenCount).toBe(1);
    if (body.storage.s3Endpoint) {
      expect(body.storage.s3Endpoint).not.toContain('minioadmin');
    }
  });

  it('supports token create and list without leaking tokenHash', async () => {
    srv = await startTestServer({ serverToken: 'admin' });

    const createRes = await fetch(`${srv.baseUrl}/admin/api/tokens`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Laptop', note: 'main device' }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      token: { id: string; name: string; tokenPrefix: string; note: string | null };
      rawToken: string;
    };
    expect(created.rawToken).toBeTruthy();
    expect(created.token.name).toBe('Laptop');
    expect(created.token.note).toBe('main device');
    expect(created.rawToken.startsWith(created.token.tokenPrefix)).toBe(true);

    const listRes = await fetch(`${srv.baseUrl}/admin/api/tokens`, {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      tokens: Array<Record<string, unknown>>;
      tokenMode: string;
    };
    expect(listed.tokenMode).toBe('db');
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens[0].name).toBe('Laptop');
    expect(listed.tokens[0].tokenHash).toBeUndefined();
  });

  it('supports token patch and revoke, and revoked token immediately fails sync auth', async () => {
    srv = await startTestServer({ serverToken: 'admin' });

    const createRes = await fetch(`${srv.baseUrl}/admin/api/tokens`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Phone' }),
    });
    const created = (await createRes.json()) as {
      token: { id: string };
      rawToken: string;
    };

    const patchRes = await fetch(`${srv.baseUrl}/admin/api/tokens/${created.token.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer admin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Phone 2', note: 'updated', status: 'active' }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      token: { name: string; note: string | null; tokenHash?: string };
    };
    expect(patched.token.name).toBe('Phone 2');
    expect(patched.token.note).toBe('updated');
    expect(patched.token.tokenHash).toBeUndefined();

    const beforeRevoke = await fetch(`${srv.baseUrl}/vault/v1/files/missing.md`, {
      headers: { Authorization: `Bearer ${created.rawToken}` },
    });
    expect(beforeRevoke.status).toBe(404);

    const deleteRes = await fetch(`${srv.baseUrl}/admin/api/tokens/${created.token.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin' },
    });
    expect(deleteRes.status).toBe(200);
    const revoked = (await deleteRes.json()) as { token: { status: string } };
    expect(revoked.token.status).toBe('revoked');

    const afterRevoke = await fetch(`${srv.baseUrl}/vault/v1/files/missing.md`, {
      headers: { Authorization: `Bearer ${created.rawToken}` },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it('supports token rotate and only returns the new raw token once', async () => {
    srv = await startTestServer({ serverToken: 'admin' });

    const createRes = await fetch(`${srv.baseUrl}/admin/api/tokens`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Tablet' }),
    });
    const created = (await createRes.json()) as {
      token: { id: string };
      rawToken: string;
    };

    const rotateRes = await fetch(`${srv.baseUrl}/admin/api/tokens/${created.token.id}/rotate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin' },
    });
    expect(rotateRes.status).toBe(200);
    const rotated = (await rotateRes.json()) as {
      token: { id: string; tokenPrefix: string; tokenHash?: string };
      rawToken: string;
    };
    expect(rotated.token.id).toBe(created.token.id);
    expect(rotated.rawToken).toBeTruthy();
    expect(rotated.rawToken).not.toBe(created.rawToken);
    expect(rotated.rawToken.startsWith(rotated.token.tokenPrefix)).toBe(true);
    expect(rotated.token.tokenHash).toBeUndefined();

    const oldTokenRes = await fetch(`${srv.baseUrl}/vault/v1/files/missing.md`, {
      headers: { Authorization: `Bearer ${created.rawToken}` },
    });
    expect(oldTokenRes.status).toBe(401);

    const newTokenRes = await fetch(`${srv.baseUrl}/vault/v1/files/missing.md`, {
      headers: { Authorization: `Bearer ${rotated.rawToken}` },
    });
    expect(newTokenRes.status).toBe(404);

    const listRes = await fetch(`${srv.baseUrl}/admin/api/tokens`, {
      headers: { Authorization: 'Bearer admin' },
    });
    const listed = (await listRes.json()) as { tokens: Array<Record<string, unknown>> };
    expect(listed.tokens[0].rawToken).toBeUndefined();
    expect(listed.tokens[0].tokenHash).toBeUndefined();
  });
});

skipIfNoMinio('Admin snapshot API integration', () => {
  it('supports admin snapshot list, manifest, download, delete', async () => {
    srv = await startTestServer({ serverToken: 'admin', withS3: true });

    const room = await srv.app.roomManager.getOrCreate('vault-snap');
    await room.load();
    const text = new Y.Text();
    text.insert(0, 'snapshot admin body');
    room.pathToId.set('note.md', 'f1');
    room.idToPath.set('f1', 'note.md');
    room.docs.set('f1', text);

    const createRes = await fetch(`${srv.baseUrl}/admin/api/vaults/vault-snap/snapshots`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin' },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as SnapshotMeta;

    const listRes = await fetch(`${srv.baseUrl}/admin/api/vaults/vault-snap/snapshots`, {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { snapshots: SnapshotMeta[] };
    expect(listBody.snapshots.some((snapshot) => snapshot.snapshotId === created.snapshotId)).toBe(true);

    const manifestRes = await fetch(
      `${srv.baseUrl}/admin/api/vaults/vault-snap/snapshots/${created.snapshotId}/manifest`,
      { headers: { Authorization: 'Bearer admin' } },
    );
    expect(manifestRes.status).toBe(200);
    const manifest = (await manifestRes.json()) as {
      files: Array<{ path: string; type: string }>;
    };
    expect(manifest.files.some((file) => file.path === 'note.md' && file.type === 'markdown')).toBe(true);

    const downloadRes = await fetch(
      `${srv.baseUrl}/admin/api/vaults/vault-snap/snapshots/${created.snapshotId}/download`,
      { headers: { Authorization: 'Bearer admin' } },
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('Content-Type')).toContain('application/zip');

    const deleteRes = await fetch(
      `${srv.baseUrl}/admin/api/vaults/vault-snap/snapshots/${created.snapshotId}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin' },
      },
    );
    expect(deleteRes.status).toBe(200);

    const afterDeleteRes = await fetch(
      `${srv.baseUrl}/admin/api/vaults/vault-snap/snapshots/${created.snapshotId}/manifest`,
      { headers: { Authorization: 'Bearer admin' } },
    );
    expect(afterDeleteRes.status).toBe(404);
  });

  it('supports admin snapshot restore and updates current vault state', async () => {
    srv = await startTestServer({ serverToken: 'admin', withS3: true });

    const room = await srv.app.roomManager.getOrCreate('vault-restore');
    await room.load();
    const original = new Y.Text();
    original.insert(0, 'before restore');
    room.pathToId.set('restore.md', 'restore-file');
    room.idToPath.set('restore-file', 'restore.md');
    room.docs.set('restore-file', original);

    const createRes = await fetch(`${srv.baseUrl}/admin/api/vaults/vault-restore/snapshots`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin' },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as SnapshotMeta;

    const changed = new Y.Doc();
    const changedText = new Y.Text();
    changedText.insert(0, 'after change');
    changed.getMap<string>('pathToId').set('restore.md', 'restore-file');
    changed.getMap<string>('idToPath').set('restore-file', 'restore.md');
    changed.getMap<Y.Text>('docs').set('restore-file', changedText);
    await room.restoreFromSnapshotPayload(Y.encodeStateAsUpdate(changed), 'test-change');

    const beforeRestoreFile = await fetch(`${srv.baseUrl}/vault/vault-restore/files/restore.md`, {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(beforeRestoreFile.status).toBe(200);
    expect(await beforeRestoreFile.text()).toBe('after change');

    const restoreRes = await fetch(
      `${srv.baseUrl}/admin/api/vaults/vault-restore/snapshots/${created.snapshotId}/restore`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin' },
      },
    );
    expect(restoreRes.status).toBe(200);
    const restoreBody = (await restoreRes.json()) as { restored: boolean; snapshotId: string };
    expect(restoreBody.restored).toBe(true);
    expect(restoreBody.snapshotId).toBe(created.snapshotId);

    const afterRestoreFile = await fetch(`${srv.baseUrl}/vault/vault-restore/files/restore.md`, {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(afterRestoreFile.status).toBe(200);
    expect(await afterRestoreFile.text()).toBe('before restore');
  });
});

describe('Admin API — rooms 404 and snapshot 404 paths', () => {
  it('GET /admin/api/rooms/:vaultId returns 404 for a completely unknown vault', async () => {
    srv = await startTestServer({ serverToken: 'admin' });

    const res = await fetch(`${srv.baseUrl}/admin/api/rooms/totally-unknown-vault`, {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});

skipIfNoMinio('Admin snapshot API — 404 paths', () => {
  it('POST /admin/api/.../snapshots/:id/restore returns 404 when snapshotId does not exist', async () => {
    srv = await startTestServer({ serverToken: 'admin', withS3: true });

    const res = await fetch(
      `${srv.baseUrl}/admin/api/vaults/some-vault/snapshots/00000000-0000-0000-0000-000000000000/restore`,
      { method: 'POST', headers: { Authorization: 'Bearer admin' } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});

describe('Admin API — error and edge cases', () => {
  it('returns 501 when blob store is not configured for Blob GC', async () => {
    // startTestServer without withS3 → blobStore is null
    srv = await startTestServer({ serverToken: 'admin' });

    const res = await fetch(`${srv.baseUrl}/admin/api/vaults/some-vault/blobs/gc`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin' },
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('blob_store_not_configured');
  });

  it('returns 501 when snapshot store is not configured for snapshot operations', async () => {
    srv = await startTestServer({ serverToken: 'admin' });

    const res = await fetch(`${srv.baseUrl}/admin/api/vaults/some-vault/snapshots`, {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('snapshot_store_not_configured');
  });

  it('returns 400 when PATCH status is set to "expired"', async () => {
    srv = await startTestServer({ serverToken: 'admin' });

    const createRes = await fetch(`${srv.baseUrl}/admin/api/tokens`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-token' }),
    });
    const created = (await createRes.json()) as { token: { id: string } };

    const patchRes = await fetch(`${srv.baseUrl}/admin/api/tokens/${created.token.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'expired' }),
    });
    expect(patchRes.status).toBe(400);
    const body = (await patchRes.json()) as { error: string };
    expect(body.error).toBe('status_invalid');
  });

  it('returns 400 when PATCH status is an unrecognised value', async () => {
    srv = await startTestServer({ serverToken: 'admin' });

    const createRes = await fetch(`${srv.baseUrl}/admin/api/tokens`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-token-2' }),
    });
    const created = (await createRes.json()) as { token: { id: string } };

    const patchRes = await fetch(`${srv.baseUrl}/admin/api/tokens/${created.token.id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'invalid-status' }),
    });
    expect(patchRes.status).toBe(400);
    const body = (await patchRes.json()) as { error: string };
    expect(body.error).toBe('status_invalid');
  });

  it('returns 413 when request body exceeds 1 MB', async () => {
    srv = await startTestServer({ serverToken: 'admin' });

    const largeBody = JSON.stringify({ name: 'x'.repeat(1_100_000) });
    const res = await fetch(`${srv.baseUrl}/admin/api/tokens`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: largeBody,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('payload_too_large');
  });
});
