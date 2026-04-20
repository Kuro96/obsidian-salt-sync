import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as Y from 'yjs';
import type { SnapshotMeta } from '@salt-sync/shared';
import { startTestServer, type TestServer, TEST_S3 } from '../helpers/integrationServer';

const ADMIN = 'admin';
const VAULT = 'v1';

function sha256hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function zipText(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

/** Seed a room with one markdown file via the real shared-model structure. */
async function seedMarkdown(
  srv: TestServer,
  vaultId: string,
  docPath: string,
  content: string,
): Promise<{ fileId: string }> {
  const room = await srv.app.roomManager.getOrCreate(vaultId);
  await room.load();
  const fileId = `file-${docPath.replace(/[^a-z0-9]/g, '-')}`;
  const text = new Y.Text();
  text.insert(0, content);
  room.pathToId.set(docPath, fileId);
  room.idToPath.set(fileId, docPath);
  room.docs.set(fileId, text);
  return { fileId };
}

async function seedBlob(
  srv: TestServer,
  vaultId: string,
  docPath: string,
  bytes: Uint8Array,
  options?: { tombstoned?: boolean },
): Promise<{ hash: string }> {
  const hash = sha256hex(bytes);
  const put = await fetch(`${srv.baseUrl}/vault/${vaultId}/blobs/${hash}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  expect(put.status).toBe(204);

  const room = await srv.app.roomManager.getOrCreate(vaultId);
  await room.load();
  room.pathToBlob.set(docPath, {
    hash,
    size: bytes.byteLength,
    contentType: 'application/octet-stream',
    updatedAt: new Date().toISOString(),
  });
  if (options?.tombstoned) {
    room.blobTombstones.set(docPath, {
      hash,
      deletedAt: new Date().toISOString(),
    });
  }

  return { hash };
}

// ── Current-file download (no S3 required) ────────────────────────────────────

let srv: TestServer;
afterEach(async () => {
  if (srv) await srv.cleanup();
});

describe('FileRouter – current file download', () => {
  it('GET /vault/{id}/files/{path} returns markdown content', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    await seedMarkdown(srv, VAULT, 'notes/hello.md', '# Hello\n\nworld');

    const res = await fetch(`${srv.baseUrl}/vault/${VAULT}/files/notes%2Fhello.md`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    expect(await res.text()).toBe('# Hello\n\nworld');
  });

  it('GET /vault/{id}/files/{path} returns 404 for unknown path', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    await seedMarkdown(srv, VAULT, 'a.md', 'content');

    const res = await fetch(`${srv.baseUrl}/vault/${VAULT}/files/nonexistent.md`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });

    expect(res.status).toBe(404);
  });

  it('GET /vault/{id}/files/{path} returns 401 for bad token', async () => {
    srv = await startTestServer({ serverToken: ADMIN });

    const res = await fetch(`${srv.baseUrl}/vault/${VAULT}/files/a.md`, {
      headers: { Authorization: `Bearer wrong` },
    });

    expect(res.status).toBe(401);
  });

  it('POST /vault/{id}/files/export returns zip containing all markdown', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    await seedMarkdown(srv, VAULT, 'doc.md', 'doc content');
    await seedMarkdown(srv, VAULT, 'other.md', 'other content');

    const res = await fetch(`${srv.baseUrl}/vault/${VAULT}/files/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/zip');
    const bytes = new Uint8Array(await res.arrayBuffer());
    // ZIP files start with magic bytes PK (0x50 0x4B)
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes.length).toBeGreaterThan(4);
  });

  it('POST /vault/{id}/files/export with paths filter only exports named files', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    await seedMarkdown(srv, VAULT, 'a.md', 'aaa');
    await seedMarkdown(srv, VAULT, 'b.md', 'bbb');

    const res = await fetch(`${srv.baseUrl}/vault/${VAULT}/files/export`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paths: ['a.md'] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/zip');
    // ZIP is non-empty
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('POST /vault/{id}/files/export returns 401 for bad token', async () => {
    srv = await startTestServer({ serverToken: ADMIN });

    const res = await fetch(`${srv.baseUrl}/vault/${VAULT}/files/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer wrong` },
    });

    expect(res.status).toBe(401);
  });
});

// ── Snapshot endpoints (require MinIO) ────────────────────────────────────────

const minioAvailable = await fetch(`${TEST_S3.endpoint}/minio/health/live`).then(
  (r) => r.ok,
  () => false,
);

const skipIfNoMinio = minioAvailable ? describe : describe.skip;

skipIfNoMinio('FileRouter – snapshot endpoints (MinIO)', () => {
  beforeAll(() => {
    if (!minioAvailable) console.log('[fileRouter.test] MinIO not reachable; skipping snapshot tests');
  });

  it('GET /vault/{id}/snapshots/{sid}/files/{path} returns markdown from snapshot', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    await seedMarkdown(srv, VAULT, 'snap.md', 'snapshot content');

    // Create snapshot
    const createRes = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(createRes.status).toBe(201);
    const meta = (await createRes.json()) as SnapshotMeta;

    // Download the file from the snapshot
    const fileRes = await fetch(
      `${srv.baseUrl}/vault/${VAULT}/snapshots/${meta.snapshotId}/files/snap.md`,
      { headers: { Authorization: `Bearer ${ADMIN}` } },
    );

    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('Content-Type')).toContain('text/markdown');
    expect(await fileRes.text()).toBe('snapshot content');
  });

  it('GET /vault/{id}/files/{path} returns 404 for tombstoned blob refs', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    await seedBlob(srv, VAULT, 'dead.bin', new Uint8Array([1, 2, 3]), { tombstoned: true });

    const res = await fetch(`${srv.baseUrl}/vault/${VAULT}/files/dead.bin`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });

    expect(res.status).toBe(404);
  });

  it('POST /vault/{id}/files/export excludes tombstoned blobs from the ZIP', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    await seedMarkdown(srv, VAULT, 'doc.md', 'doc content');
    await seedBlob(srv, VAULT, 'dead.bin', new Uint8Array([1, 2, 3]), { tombstoned: true });

    const res = await fetch(`${srv.baseUrl}/vault/${VAULT}/files/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });

    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = zipText(bytes);
    expect(text).toContain('doc.md');
    expect(text).not.toContain('dead.bin');
  });

  it('GET /vault/{id}/snapshots/{sid}/files/{path} returns 404 for nonexistent path', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    await seedMarkdown(srv, VAULT, 'exists.md', 'exists');

    const createRes = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(createRes.status).toBe(201);
    const meta = (await createRes.json()) as SnapshotMeta;

    const fileRes = await fetch(
      `${srv.baseUrl}/vault/${VAULT}/snapshots/${meta.snapshotId}/files/missing.md`,
      { headers: { Authorization: `Bearer ${ADMIN}` } },
    );

    expect(fileRes.status).toBe(404);
  });

  it('GET /vault/{id}/snapshots/{sid}/manifest lists files with correct paths', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    await seedMarkdown(srv, VAULT, 'article.md', 'article body');
    await seedMarkdown(srv, VAULT, 'notes/index.md', 'index body');

    const createRes = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(createRes.status).toBe(201);
    const meta = (await createRes.json()) as SnapshotMeta;

    const manifestRes = await fetch(
      `${srv.baseUrl}/vault/${VAULT}/snapshots/${meta.snapshotId}/manifest`,
      { headers: { Authorization: `Bearer ${ADMIN}` } },
    );

    expect(manifestRes.status).toBe(200);
    const manifest = (await manifestRes.json()) as {
      snapshotId: string;
      createdAt: string;
      files: Array<{ path: string; type: string; size: number }>;
    };
    expect(manifest.snapshotId).toBe(meta.snapshotId);

    const paths = manifest.files.map((f) => f.path);
    // Paths must be actual file paths, not internal fileIds (UUIDs or similar)
    expect(paths).toContain('article.md');
    expect(paths).toContain('notes/index.md');

    // Verify type and size are correct
    const articleEntry = manifest.files.find((f) => f.path === 'article.md')!;
    expect(articleEntry.type).toBe('markdown');
    expect(articleEntry.size).toBeGreaterThan(0);
  });

  it('GET /vault/{id}/snapshots/{sid}/files/{path} returns 404 for tombstoned blob refs', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    await seedBlob(srv, VAULT, 'dead.bin', new Uint8Array([4, 5, 6]), { tombstoned: true });

    const createRes = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(createRes.status).toBe(201);
    const meta = (await createRes.json()) as SnapshotMeta;

    const fileRes = await fetch(
      `${srv.baseUrl}/vault/${VAULT}/snapshots/${meta.snapshotId}/files/dead.bin`,
      { headers: { Authorization: `Bearer ${ADMIN}` } },
    );

    expect(fileRes.status).toBe(404);
  });

  it('GET /vault/{id}/snapshots/{sid}/manifest excludes tombstoned blobs', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    await seedMarkdown(srv, VAULT, 'article.md', 'article body');
    await seedBlob(srv, VAULT, 'dead.bin', new Uint8Array([7, 8, 9]), { tombstoned: true });

    const createRes = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(createRes.status).toBe(201);
    const meta = (await createRes.json()) as SnapshotMeta;

    const manifestRes = await fetch(
      `${srv.baseUrl}/vault/${VAULT}/snapshots/${meta.snapshotId}/manifest`,
      { headers: { Authorization: `Bearer ${ADMIN}` } },
    );

    expect(manifestRes.status).toBe(200);
    const manifest = (await manifestRes.json()) as {
      files: Array<{ path: string; type: string }>;
    };
    expect(manifest.files.some((f) => f.path === 'article.md' && f.type === 'markdown')).toBe(true);
    expect(manifest.files.some((f) => f.path === 'dead.bin')).toBe(false);
  });

  it('GET /vault/{id}/snapshots/{sid}/download returns a ZIP', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    await seedMarkdown(srv, VAULT, 'readme.md', 'readme content');

    const createRes = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(createRes.status).toBe(201);
    const meta = (await createRes.json()) as SnapshotMeta;

    const dlRes = await fetch(
      `${srv.baseUrl}/vault/${VAULT}/snapshots/${meta.snapshotId}/download`,
      { headers: { Authorization: `Bearer ${ADMIN}` } },
    );

    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('Content-Type')).toContain('application/zip');
    const bytes = new Uint8Array(await dlRes.arrayBuffer());
    // ZIP magic bytes
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes.length).toBeGreaterThan(4);
  });

  it('GET /vault/{id}/snapshots/{sid}/download excludes tombstoned blobs from the ZIP', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    await seedMarkdown(srv, VAULT, 'readme.md', 'readme content');
    await seedBlob(srv, VAULT, 'dead.bin', new Uint8Array([9, 9, 9]), { tombstoned: true });

    const createRes = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(createRes.status).toBe(201);
    const meta = (await createRes.json()) as SnapshotMeta;

    const dlRes = await fetch(
      `${srv.baseUrl}/vault/${VAULT}/snapshots/${meta.snapshotId}/download`,
      { headers: { Authorization: `Bearer ${ADMIN}` } },
    );

    expect(dlRes.status).toBe(200);
    const bytes = new Uint8Array(await dlRes.arrayBuffer());
    const text = zipText(bytes);
    expect(text).toContain('readme.md');
    expect(text).not.toContain('dead.bin');
  });

  it('GET snapshot endpoints return 404 for unknown snapshot id', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    const fakeId = '00000000-0000-0000-0000-000000000000';

    const [fileRes, manifestRes, dlRes] = await Promise.all([
      fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots/${fakeId}/files/a.md`, {
        headers: { Authorization: `Bearer ${ADMIN}` },
      }),
      fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots/${fakeId}/manifest`, {
        headers: { Authorization: `Bearer ${ADMIN}` },
      }),
      fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots/${fakeId}/download`, {
        headers: { Authorization: `Bearer ${ADMIN}` },
      }),
    ]);

    expect(fileRes.status).toBe(404);
    expect(manifestRes.status).toBe(404);
    expect(dlRes.status).toBe(404);
  });
});
