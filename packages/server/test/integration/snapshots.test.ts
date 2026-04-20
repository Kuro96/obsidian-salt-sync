import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as Y from 'yjs';
import type { SnapshotMeta } from '@salt-sync/shared';
import { startTestServer, type TestServer, TEST_S3 } from '../helpers/integrationServer';

const ADMIN = 'admin';
const VAULT = 'v1';

let srv: TestServer;
afterEach(async () => {
  if (srv) await srv.cleanup();
});

const minioAvailable = await fetch(`${TEST_S3.endpoint}/minio/health/live`).then(
  (r) => r.ok,
  () => false,
);

const skipIfNoMinio = minioAvailable ? describe : describe.skip;

skipIfNoMinio('Snapshot HTTP integration (MinIO)', () => {
  beforeAll(() => {
    if (!minioAvailable) console.log('[snapshots.test] MinIO not reachable; skipping');
  });

  it('POST /snapshots creates, GET /snapshots lists, GET /snapshots/:id round-trips payload', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });

    // Seed the room with some content so the snapshot is non-trivial.
    // Use the real shared-model structure: pathToId → fileId → docs(fileId).
    const room = await srv.app.roomManager.getOrCreate(VAULT);
    await room.load();
    const fileId = 'file-readme';
    const text = new Y.Text();
    text.insert(0, 'hello snapshot');
    room.pathToId.set('readme.md', fileId);
    room.idToPath.set(fileId, 'readme.md');
    room.docs.set(fileId, text);

    // create
    const createRes = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(createRes.status).toBe(201);
    const meta = (await createRes.json()) as SnapshotMeta;
    expect(meta.snapshotId).toMatch(/[0-9a-f-]{36}/);
    expect(meta.vaultId).toBe(VAULT);
    expect(meta.markdownFileCount).toBeGreaterThanOrEqual(1);

    // list
    const listRes = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { snapshots: SnapshotMeta[] };
    expect(listJson.snapshots.some((s) => s.snapshotId === meta.snapshotId)).toBe(true);

    // get payload + meta header
    const getRes = await fetch(
      `${srv.baseUrl}/vault/${VAULT}/snapshots/${meta.snapshotId}`,
      { headers: { Authorization: `Bearer ${ADMIN}` } },
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toBe('application/octet-stream');
    const headerMeta = JSON.parse(getRes.headers.get('X-Snapshot-Meta') ?? '{}') as SnapshotMeta;
    expect(headerMeta.snapshotId).toBe(meta.snapshotId);

    // payload should be a valid Y.Doc update reproducing our text via the
    // real shared-model structure: pathToId → fileId → docs(fileId).
    const payload = new Uint8Array(await getRes.arrayBuffer());
    const verify = new Y.Doc();
    Y.applyUpdate(verify, payload);
    const verifyPathToId = verify.getMap<string>('pathToId');
    const verifyDocs = verify.getMap<Y.Text>('docs');
    const verifyFileId = verifyPathToId.get('readme.md');
    expect(verifyFileId).toBeDefined();
    const docText = verifyDocs.get(verifyFileId!);
    expect(docText).toBeDefined();
    expect(docText!.toString()).toBe('hello snapshot');
  });

  it('returns 404 for unknown snapshot id', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    const r = await fetch(
      `${srv.baseUrl}/vault/${VAULT}/snapshots/00000000-0000-0000-0000-000000000000`,
      { headers: { Authorization: `Bearer ${ADMIN}` } },
    );
    expect(r.status).toBe(404);
  });

  it('rejects requests without proper per-vault token', async () => {
    srv = await startTestServer({
      serverToken: ADMIN,
      vaultTokens: { [VAULT]: 't1' },
      withS3: true,
    });
    // Wrong token (admin) for a vault that has its own per-vault token must fail
    const r = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      method: 'POST',
      headers: { Authorization: `Bearer wrong` },
    });
    expect(r.status).toBe(401);

    // Correct per-vault token works
    const ok = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      method: 'POST',
      headers: { Authorization: `Bearer t1` },
    });
    expect(ok.status).toBe(201);
  });

  it('list returns snapshots sorted newest-first across multiple creates', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN}` },
      });
      expect(r.status).toBe(201);
      const m = (await r.json()) as SnapshotMeta;
      ids.push(m.snapshotId);
      // Tiny delay so createdAt timestamps differ
      await new Promise((res) => setTimeout(res, 5));
    }

    const listRes = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    const listJson = (await listRes.json()) as { snapshots: SnapshotMeta[] };
    const orderedIds = listJson.snapshots.map((s) => s.snapshotId);
    // All three should be present, with the most-recent first
    for (const id of ids) expect(orderedIds).toContain(id);
    expect(orderedIds.indexOf(ids[2])).toBeLessThan(orderedIds.indexOf(ids[0]));
  });

  it('creates a correct snapshot even when the room was disposed before the HTTP request', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });

    const room = await srv.app.roomManager.getOrCreate(VAULT);
    await room.load();
    // Seed via a Y.Doc using the real shared-model structure.
    const seeded = new Y.Doc();
    const seededFileId = 'file-note';
    const seededText = new Y.Text();
    seededText.insert(0, 'persisted-before-dispose');
    (seeded.getMap('pathToId') as Y.Map<string>).set('note.md', seededFileId);
    (seeded.getMap('idToPath') as Y.Map<string>).set(seededFileId, 'note.md');
    (seeded.getMap('docs') as Y.Map<Y.Text>).set(seededFileId, seededText);
    await room.applyClientUpdate('seed', Y.encodeStateAsUpdate(seeded));
    await room.saveNow();
    await srv.app.roomManager.disposeIdleRooms();

    const createRes = await fetch(`${srv.baseUrl}/vault/${VAULT}/snapshots`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(createRes.status).toBe(201);
    const meta = (await createRes.json()) as SnapshotMeta;

    const getRes = await fetch(
      `${srv.baseUrl}/vault/${VAULT}/snapshots/${meta.snapshotId}`,
      { headers: { Authorization: `Bearer ${ADMIN}` } },
    );
    expect(getRes.status).toBe(200);

    const payload = new Uint8Array(await getRes.arrayBuffer());
    const verify = new Y.Doc();
    Y.applyUpdate(verify, payload);
    const verifyPtoId = verify.getMap<string>('pathToId');
    const verifyDocs = verify.getMap<Y.Text>('docs');
    const noteFid = verifyPtoId.get('note.md');
    expect(noteFid).toBeDefined();
    expect(verifyDocs.get(noteFid!)?.toString()).toBe('persisted-before-dispose');
  });
});
