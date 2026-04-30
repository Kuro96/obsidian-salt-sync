import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { VaultRoom } from '../src/rooms/vaultRoom';
import { SqliteDocumentStore } from '../src/persistence/sqliteDocumentStore';
import { runMigrations } from '../src/persistence/migrations';
import { MockSession } from './helpers/mockSession';
import { AUTO_SNAPSHOT_ENTRIES } from '@salt-sync/shared';
import type {
  SnapshotMeta,
  PutSnapshotInput,
  StoredSnapshot,
  VaultId,
  SnapshotStore,
} from '@salt-sync/shared';
import type { S3SnapshotStore } from '../src/snapshots/s3SnapshotStore';

function freshRoom(snapshotStore: SnapshotStore | null = null) {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const store = new SqliteDocumentStore(db);
  const room = new VaultRoom('v1', store, snapshotStore as unknown as S3SnapshotStore | null);
  return { db, store, room };
}

function makeUpdate(mutate: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  mutate(doc);
  return Y.encodeStateAsUpdate(doc);
}

class MemorySnapshotStore implements SnapshotStore {
  readonly puts: PutSnapshotInput[] = [];
  async put(input: PutSnapshotInput): Promise<SnapshotMeta> {
    this.puts.push(input);
    return input.meta;
  }
  async list(): Promise<SnapshotMeta[]> {
    return this.puts.map((p) => p.meta);
  }
  async get(_vaultId: VaultId, snapshotId: string): Promise<StoredSnapshot | null> {
    const hit = this.puts.find((p) => p.snapshotId === snapshotId);
    if (!hit) return null;
    return { meta: hit.meta, payload: hit.payload };
  }
}

describe('VaultRoom', () => {
  it('loads and initializes sys metadata', async () => {
    const { room } = freshRoom();
    await room.load();
    const meta = await room.getMeta();
    expect(meta.vaultId).toBe('v1');
    expect(meta.loaded).toBe(true);
  });

  it('broadcasts sync_update to other sessions, skips originator', async () => {
    const { room } = freshRoom();
    const a = new MockSession('a', 'v1');
    const b = new MockSession('b', 'v1');
    await room.attachSession(a);
    await room.attachSession(b);

    a.outbox.length = 0;
    b.outbox.length = 0;
    await a.receive({
      type: 'sync_update',
      update: makeUpdate((d) => d.getText('t').insert(0, 'hello')),
    });

    expect(a.popByType('sync_update')).toHaveLength(0);
    const received = b.popByType('sync_update');
    expect(received).toHaveLength(1);
    expect(received[0].update.length).toBeGreaterThan(2);
  });

  it('forwards awareness_update to peers only', async () => {
    const { room } = freshRoom();
    const a = new MockSession('a', 'v1');
    const b = new MockSession('b', 'v1');
    await room.attachSession(a);
    await room.attachSession(b);

    const sourceDoc = new Y.Doc();
    const sourceAwareness = new Awareness(sourceDoc);
    sourceAwareness.setLocalState({ user: { name: 'A' } });
    const payload = encodeAwarenessUpdate(sourceAwareness, [sourceDoc.clientID]);

    a.outbox.length = 0;
    b.outbox.length = 0;
    await a.receive({ type: 'awareness_update', payload });

    expect(b.popByType('awareness_update')).toHaveLength(1);
    expect(a.popByType('awareness_update')).toHaveLength(0);
  });

  it('broadcasts awareness removal when a session disconnects', async () => {
    const { room } = freshRoom();
    const a = new MockSession('a', 'v1');
    const b = new MockSession('b', 'v1');
    await room.attachSession(a);
    await room.attachSession(b);

    const sourceDoc = new Y.Doc();
    const sourceAwareness = new Awareness(sourceDoc);
    sourceAwareness.setLocalState({ user: { name: 'A' } });
    const payload = encodeAwarenessUpdate(sourceAwareness, [sourceDoc.clientID]);

    a.outbox.length = 0;
    b.outbox.length = 0;
    await a.receive({ type: 'awareness_update', payload });
    b.popByType('awareness_update');

    await a.close();

    const removals = b.popByType('awareness_update');
    expect(removals).toHaveLength(1);

    const verifyDoc = new Y.Doc();
    const verifyAwareness = new Awareness(verifyDoc);
    applyAwarenessUpdate(verifyAwareness, payload, 'seed');
    applyAwarenessUpdate(verifyAwareness, removals[0].payload, 'remote');
    expect(verifyAwareness.getStates().has(sourceDoc.clientID)).toBe(false);
  });

  it('responds to empty sync_state_vector with full state diff', async () => {
    const { room } = freshRoom();
    const a = new MockSession('a', 'v1');
    await room.attachSession(a);

    await room.applyClientUpdate(
      'seed',
      makeUpdate((d) => d.getText('t').insert(0, 'abc')),
    );

    a.outbox.length = 0;
    await a.receive({ type: 'sync_state_vector', sv: new Uint8Array() });

    const diffs = a.popByType('sync_update');
    expect(diffs).toHaveLength(1);
    expect(diffs[0].update.length).toBeGreaterThan(2);
  });

  it('cleans ignored paths from inbound client updates before storing state', async () => {
    const { room } = freshRoom();
    await room.load();

    await room.applyClientUpdate('seed', makeUpdate((doc) => {
      const ignoredText = new Y.Text();
      ignoredText.insert(0, 'ignored');
      const validText = new Y.Text();
      validText.insert(0, 'valid');
      doc.getMap<string>('pathToId').set('~syncthing~note.md.tmp', 'ignored-md');
      doc.getMap<string>('idToPath').set('ignored-md', '~syncthing~note.md.tmp');
      doc.getMap<Y.Text>('docs').set('ignored-md', ignoredText);
      doc.getMap<string>('pathToId').set('valid.md', 'valid-md');
      doc.getMap<string>('idToPath').set('valid-md', 'valid.md');
      doc.getMap<Y.Text>('docs').set('valid-md', validText);
      doc.getMap('pathToBlob').set('~syncthing~blob.png.tmp', { hash: 'ignored-hash', size: 1, updatedAt: new Date().toISOString() });
    }));

    expect(room.pathToId.has('~syncthing~note.md.tmp')).toBe(false);
    expect(room.idToPath.has('ignored-md')).toBe(false);
    expect(room.docs.has('ignored-md')).toBe(false);
    expect(room.pathToBlob.has('~syncthing~blob.png.tmp')).toBe(false);
    expect(room.pathToId.get('valid.md')).toBe('valid-md');
    expect(room.idToPath.get('valid-md')).toBe('valid.md');
    expect(room.docs.has('valid-md')).toBe(true);
  });

  it('disposeIfIdle returns false while sessions attached', async () => {
    const { room } = freshRoom();
    const s = new MockSession('s', 'v1');
    await room.attachSession(s);
    expect(await room.disposeIfIdle()).toBe(false);
  });

  it('disposeIfIdle returns true and persists journal', async () => {
    const { room, store } = freshRoom();
    await room.load();

    await room.applyClientUpdate(
      'seed',
      makeUpdate((d) => d.getText('t').insert(0, 'hi')),
    );

    const disposed = await room.disposeIfIdle();
    expect(disposed).toBe(true);

    const loaded = await store.load('v1');
    expect(loaded.deltas.length).toBeGreaterThanOrEqual(1);

    // Replay and verify content survives reload
    const recovered = new Y.Doc();
    if (loaded.checkpoint) Y.applyUpdate(recovered, loaded.checkpoint.payload);
    for (const d of loaded.deltas) Y.applyUpdate(recovered, d.payload);
    expect(recovered.getText('t').toString()).toBe('hi');
  });

  it('auto snapshot fires after AUTO_SNAPSHOT_ENTRIES saveNow cycles', async () => {
    const snaps = new MemorySnapshotStore();
    const { room } = freshRoom(snaps);
    await room.load();

    for (let i = 0; i < AUTO_SNAPSHOT_ENTRIES; i++) {
      await room.applyClientUpdate(
        `c${i}`,
        makeUpdate((d) => d.getText('t').insert(0, `v${i}`)),
      );
      await room.saveNow();
    }

    await new Promise((r) => setImmediate(r));
    expect(snaps.puts.length).toBeGreaterThanOrEqual(1);
    expect(snaps.puts[0].meta.vaultId).toBe('v1');
  });

  it('dry-runs and applies ignored path cleanup without touching valid paths', async () => {
    const { room } = freshRoom();
    await room.load();
    const ignoredText = new Y.Text();
    ignoredText.insert(0, 'ignored');
    const validText = new Y.Text();
    validText.insert(0, 'valid');

    room.pathToId.set('~syncthing~note.md.tmp', 'ignored-md');
    room.idToPath.set('ignored-md', '~syncthing~note.md.tmp');
    room.docs.set('ignored-md', ignoredText);
    room.pathToId.set('valid.md', 'valid-md');
    room.idToPath.set('valid-md', 'valid.md');
    room.docs.set('valid-md', validText);
    room.fileTombstones.set('~syncthing~dead.md.tmp', { deletedAt: new Date().toISOString() });
    room.pathToBlob.set('~syncthing~blob.png.tmp', { hash: 'ignored-hash', size: 1, updatedAt: new Date().toISOString() });
    room.pathToBlob.set('assets/valid.png', { hash: 'valid-hash', size: 2, updatedAt: new Date().toISOString() });
    room.blobTombstones.set('~syncthing~deleted.png.tmp', { hash: 'deleted-hash', deletedAt: new Date().toISOString() });

    const dryRun = await room.inspectIgnoredPathPollution();
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.counts.pathToId).toBe(1);
    expect(dryRun.counts.docs).toBe(1);
    expect(room.pathToId.has('~syncthing~note.md.tmp')).toBe(true);

    const applied = await room.cleanupIgnoredPathPollution();
    expect(applied.dryRun).toBe(false);
    expect(applied.counts.pathToBlob).toBe(1);
    expect(applied.counts.blobTombstones).toBe(1);
    expect(room.pathToId.has('~syncthing~note.md.tmp')).toBe(false);
    expect(room.idToPath.has('ignored-md')).toBe(false);
    expect(room.docs.has('ignored-md')).toBe(false);
    expect(room.fileTombstones.has('~syncthing~dead.md.tmp')).toBe(false);
    expect(room.pathToBlob.has('~syncthing~blob.png.tmp')).toBe(false);
    expect(room.blobTombstones.has('~syncthing~deleted.png.tmp')).toBe(false);
    expect(room.pathToId.has('valid.md')).toBe(true);
    expect(room.pathToBlob.has('assets/valid.png')).toBe(true);
  });

  it('repairs ignored reverse markdown mappings without orphaning valid docs', async () => {
    const { room } = freshRoom();
    await room.load();
    const aliasedText = new Y.Text();
    aliasedText.insert(0, 'valid through alias');
    const reverseOnlyText = new Y.Text();
    reverseOnlyText.insert(0, 'valid reverse only');

    room.pathToId.set('valid.md', 'aliased-file');
    room.pathToId.set('~syncthing~valid.md.tmp', 'aliased-file');
    room.idToPath.set('aliased-file', '~syncthing~valid.md.tmp');
    room.docs.set('aliased-file', aliasedText);

    room.pathToId.set('~syncthing~reverse.md.tmp', 'reverse-file');
    room.idToPath.set('reverse-file', 'reverse-valid.md');
    room.docs.set('reverse-file', reverseOnlyText);

    const applied = await room.cleanupIgnoredPathPollution();

    expect(applied.counts.pathToId).toBe(2);
    expect(applied.counts.idToPath).toBe(1);
    expect(applied.counts.docs).toBe(0);
    expect(room.pathToId.has('~syncthing~valid.md.tmp')).toBe(false);
    expect(room.pathToId.has('~syncthing~reverse.md.tmp')).toBe(false);
    expect(room.pathToId.get('valid.md')).toBe('aliased-file');
    expect(room.idToPath.get('aliased-file')).toBe('valid.md');
    expect(room.idToPath.get('reverse-file')).toBe('reverse-valid.md');
    expect(room.docs.has('aliased-file')).toBe(true);
    expect(room.docs.has('reverse-file')).toBe(true);
  });
});
