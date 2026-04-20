/**
 * End-to-end: two VaultSyncEngine instances against a real test server.
 *
 * This is the only test that exercises the full client + server stack
 * (VaultSyncEngine → RoomClient → ws → server → SQLite + Y.Doc). Most paths
 * are also covered by unit tests; this file's job is to catch wiring breaks.
 *
 * Network globals (IndexedDB, WebSocket) are polyfilled at the top via
 * setupNetwork — that import MUST come before vaultSync transitively loads.
 */
import './../helpers/setupNetwork';
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { startTestServer, type TestServer, TEST_S3 } from '../../../server/test/helpers/integrationServer';
import { startEngine, waitFor, type StartedEngine } from '../helpers/startEngine';
import type { RoomClient } from '../../src/sync/roomClient';
import { MarkdownView } from '../mocks/obsidian';

const ADMIN = 'admin';
const VAULT_PREFIX = 'e2e-vault';

let srv: TestServer;
const engines: StartedEngine[] = [];

afterEach(async () => {
  // Stop engines first so they cleanly close their WS, then tear down the server.
  for (const e of engines.splice(0)) {
    await e.stop().catch(() => {});
  }
  if (srv) await srv.cleanup();
});

let vaultSeq = 0;

function makeVaultId(): string {
  vaultSeq += 1;
  return `${VAULT_PREFIX}-${vaultSeq}`;
}

const minioAvailable = await fetch(`${TEST_S3.endpoint}/minio/health/live`).then(
  (r) => r.ok,
  () => false,
);

function getClient(started: StartedEngine): RoomClient {
  return (started.engine as unknown as { client: RoomClient }).client;
}

function waitForStatus(client: RoomClient, expected: string, timeoutMs = 6000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`waitForStatus: expected ${expected}`)), timeoutMs);
    client.onStatusChange((status) => {
      if (status === expected) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function getBindingManager(started: StartedEngine): {
  getBindingDebugInfo: (path: string) => { leafId: string; path: string; cmId: string } | null;
} {
  return (started.engine as unknown as {
    editorBindings: {
      getBindingDebugInfo: (path: string) => { leafId: string; path: string; cmId: string } | null;
    };
  }).editorBindings;
}

function makeCmView() {
  const dispatched: unknown[] = [];
  return {
    state: {
      facet: () => ({ ok: true }),
    },
    dispatch: (payload: unknown) => {
      dispatched.push(payload);
    },
    dispatched,
  };
}

function openMarkdownLeaf(started: StartedEngine, path: string, leafId: string) {
  const file = started.vault.getFileByPath(path);
  if (!file) throw new Error(`openMarkdownLeaf: missing file ${path}`);
  const view = new MarkdownView() as MarkdownView & { leaf?: { id?: string } };
  view.file = file;
  view.leaf = { id: leafId };
  (view.editor as unknown as { cm: unknown }).cm = makeCmView();
  started.workspace.leaves.push({ view });
  started.workspace.emit('layout-change');
  return view;
}

describe('Two-engine end-to-end (text + delete)', () => {
  it('A creates a markdown file → B sees the same content', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    const b = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'B' });
    engines.push(a, b);

    // A side: simulate a real Obsidian "file created" event by going through
    // the vault.create API; the bridge subscribes to 'create' via plugin events.
    await a.vault.create('hello.md', 'world');

    // Wait for B's vault to receive the file via remote update → bridge flush.
    await waitFor(() => b.vault.contents.get('hello.md') === 'world', 4000);

    expect(b.vault.contents.get('hello.md')).toBe('world');
  });

  it('A modifies a file → B sees the updated content', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    const b = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'B' });
    engines.push(a, b);

    await a.vault.create('edit-me.md', 'original');
    await waitFor(() => b.vault.contents.get('edit-me.md') === 'original', 4000);

    // A modifies the file — bridge detects via vault 'modify' event
    const file = a.vault.getFileByPath('edit-me.md')!;
    await a.vault.modify(file, 'updated by A');

    await waitFor(() => b.vault.contents.get('edit-me.md') === 'updated by A', 4000);
    expect(b.vault.contents.get('edit-me.md')).toBe('updated by A');
  });

  it('A and B create different files concurrently → both sides see both files', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    const b = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'B' });
    engines.push(a, b);

    // Both sides create files concurrently
    await Promise.all([
      a.vault.create('from-a.md', 'content-a'),
      b.vault.create('from-b.md', 'content-b'),
    ]);

    // Both sides should eventually see both files
    await waitFor(() =>
      a.vault.contents.get('from-b.md') === 'content-b' &&
      b.vault.contents.get('from-a.md') === 'content-a',
      4000,
    );

    expect(a.vault.contents.get('from-b.md')).toBe('content-b');
    expect(b.vault.contents.get('from-a.md')).toBe('content-a');
  });

  it('A deletes a markdown file → B applies the delete', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    const b = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'B' });
    engines.push(a, b);

    await a.vault.create('doomed.md', 'bye');
    await waitFor(() => b.vault.contents.has('doomed.md'), 4000);

    // Now delete on A side and expect B to remove it from its vault
    const fileA = a.vault.getFileByPath('doomed.md')!;
    await a.vault.delete(fileA);

    await waitFor(() => !b.vault.contents.has('doomed.md'), 4000);
    expect(b.vault.files.has('doomed.md')).toBe(false);
  });

  it('remote markdown delete also clears the open-file editor binding on the peer', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    const b = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'B' });
    engines.push(a, b);

    await a.vault.create('bound-delete.md', 'bye');
    await waitFor(() => b.vault.contents.get('bound-delete.md') === 'bye', 4000);

    openMarkdownLeaf(b, 'bound-delete.md', 'leaf:bound-delete');
    const bindings = getBindingManager(b);
    await waitFor(() => bindings.getBindingDebugInfo('bound-delete.md') !== null, 4000);

    const fileA = a.vault.getFileByPath('bound-delete.md')!;
    await a.vault.delete(fileA);

    await waitFor(() => !b.vault.contents.has('bound-delete.md'), 4000);
    await waitFor(() => bindings.getBindingDebugInfo('bound-delete.md') === null, 4000);

    expect(b.vault.files.has('bound-delete.md')).toBe(false);
    expect(bindings.getBindingDebugInfo('bound-delete.md')).toBeNull();
  });

  it('A renames a markdown file → B applies the rename without leaving the old path behind', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    const b = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'B' });
    engines.push(a, b);

    await a.vault.create('rename-me.md', 'before-rename');
    await waitFor(() => b.vault.contents.get('rename-me.md') === 'before-rename', 4000);

    const fileA = a.vault.getFileByPath('rename-me.md')!;
    await a.vault.rename(fileA, 'renamed.md');

    await waitFor(() => b.vault.contents.get('renamed.md') === 'before-rename', 4000);
    expect(b.vault.contents.has('rename-me.md')).toBe(false);
    expect(b.vault.contents.get('renamed.md')).toBe('before-rename');
  });

  it('B disconnects and reconnects → catches up via baseline sync', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    const b = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'B' });
    engines.push(a, b);

    await a.vault.create('reconnect.md', 'v1');
    await waitFor(() => b.vault.contents.get('reconnect.md') === 'v1', 4000);

    const clientB = getClient(b);
    const reconnecting = waitForStatus(clientB, 'reconnecting');
    const reconnected = waitForStatus(clientB, 'connected', 6000);
    await (clientB as unknown as { ws: WebSocket | null }).ws?.close(4001, 'test-reconnect');
    await reconnecting;

    const fileA = a.vault.getFileByPath('reconnect.md')!;
    await a.vault.modify(fileA, 'v2-while-b-offline');

    await reconnected;
    await waitFor(() => b.vault.contents.get('reconnect.md') === 'v2-while-b-offline', 6000);
    expect(b.vault.contents.get('reconnect.md')).toBe('v2-while-b-offline');
  });

  it('reconnect audits open editors and rebinds when the CM view instance became stale', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    const b = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'B' });
    engines.push(a, b);

    await a.vault.create('binding-reconnect.md', 'binding-state');
    await waitFor(() => b.vault.contents.get('binding-reconnect.md') === 'binding-state', 4000);

    const view = openMarkdownLeaf(b, 'binding-reconnect.md', 'leaf:binding-reconnect');
    const bindings = getBindingManager(b);
    await waitFor(() => bindings.getBindingDebugInfo('binding-reconnect.md') !== null, 4000);
    const initialBinding = bindings.getBindingDebugInfo('binding-reconnect.md');
    expect(initialBinding).not.toBeNull();

    (view.editor as unknown as { cm: unknown }).cm = makeCmView();

    const clientB = getClient(b);
    const reconnecting = waitForStatus(clientB, 'reconnecting');
    const reconnected = waitForStatus(clientB, 'connected', 6000);
    await (clientB as unknown as { ws: WebSocket | null }).ws?.close(4002, 'test-binding-audit');
    await reconnecting;
    await reconnected;

    await waitFor(() => {
      const rebound = bindings.getBindingDebugInfo('binding-reconnect.md');
      return rebound !== null && rebound.cmId !== initialBinding!.cmId;
    }, 6000);

    const rebound = bindings.getBindingDebugInfo('binding-reconnect.md');
    expect(rebound).not.toBeNull();
    expect(rebound!.path).toBe('binding-reconnect.md');
    expect(rebound!.cmId).not.toBe(initialBinding!.cmId);
  });

  it('startup binds pre-opened markdown views after initial sync', async () => {
    srv = await startTestServer({ serverToken: ADMIN });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    engines.push(a);

    await a.vault.create('startup-open.md', 'from-server');
    await new Promise((r) => setTimeout(r, 700));

    const b = await startEngine({
      serverUrl: wsBase,
      vaultId,
      token: ADMIN,
      deviceId: 'B',
      beforeStart: ({ vault, workspace }) => {
        const file = vault.seedText('startup-open.md', 'from-server');
        const view = new MarkdownView() as MarkdownView & { leaf?: { id?: string } };
        view.file = file;
        view.leaf = { id: 'leaf:startup-open' };
        (view.editor as unknown as { cm: unknown }).cm = makeCmView();
        workspace.leaves.push({ view });
      },
    });
    engines.push(b);

    const bindings = getBindingManager(b);
    await waitFor(() => bindings.getBindingDebugInfo('startup-open.md') !== null, 4000);
    expect(bindings.getBindingDebugInfo('startup-open.md')).not.toBeNull();
    expect(b.vault.contents.get('startup-open.md')).toBe('from-server');
  });
});

const skipIfNoMinio = minioAvailable ? describe : describe.skip;

skipIfNoMinio('Two-engine end-to-end with MinIO (blobs + snapshots)', () => {
  beforeAll(() => {
    if (!minioAvailable) console.log('[twoEngine.test] MinIO not reachable; skipping');
  });

  it('A uploads a binary attachment → B downloads identical bytes', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    const b = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'B' });
    engines.push(a, b);

    const bytes = new Uint8Array([0xff, 0x10, 0x42, 0x00, 0x99, 0xab]);
    await a.vault.createBinary('image.png', bytes.slice().buffer);

    // Wait for B to receive the blob ref + download it
    await waitFor(() => {
      const got = b.vault.contents.get('image.png');
      return got instanceof Uint8Array && got.byteLength === bytes.byteLength;
    }, 6000);

    const got = b.vault.contents.get('image.png') as Uint8Array;
    expect(Array.from(got)).toEqual(Array.from(bytes));
  });

  it('createSnapshot then restoreSnapshot restores markdown and blobs to the snapshot state', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    engines.push(a);

    await a.vault.create('versioned.md', 'v1');
    const v1Bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    await a.vault.createBinary('image.png', v1Bytes.slice().buffer);
    // Wait for bridge debounce (300ms) + ws round-trip so server-side ydoc
    // observes 'v1' before we ask it to snapshot.
    await new Promise((r) => setTimeout(r, 700));

    const meta = await a.engine.createSnapshot();
    expect(meta.snapshotId).toMatch(/[0-9a-f-]{36}/);

    // Mutate after the snapshot — bridge will push v2 into the Y.Doc
    const file = a.vault.getFileByPath('versioned.md')!;
    await a.vault.modify(file, 'v2-after-snapshot');
    await a.vault.create('extra.md', 'created-after-snapshot');
    const image = a.vault.getFileByPath('image.png')!;
    const v2Bytes = new Uint8Array([0x09, 0x08, 0x07]);
    await a.vault.modifyBinary(image, v2Bytes.slice().buffer);
    await new Promise((r) => setTimeout(r, 500));

    // Restore — should roll markdown and blob state back to the snapshot.
    await a.engine.restoreSnapshot(meta.snapshotId);

    await waitFor(() => a.vault.contents.get('versioned.md') === 'v1', 4000);
    expect(a.vault.contents.get('versioned.md')).toBe('v1');
    expect(a.vault.contents.has('extra.md')).toBe(false);
    await waitFor(() => {
      const content = a.vault.contents.get('image.png');
      return content instanceof Uint8Array && Array.from(content).join(',') === Array.from(v1Bytes).join(',');
    }, 4000);
    expect(Array.from(a.vault.contents.get('image.png') as Uint8Array)).toEqual(Array.from(v1Bytes));
  });

  it('restoreSnapshot propagates restored markdown state to the other engine', async () => {
    srv = await startTestServer({ serverToken: ADMIN, withS3: true });
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    const vaultId = makeVaultId();

    const a = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'A' });
    const b = await startEngine({ serverUrl: wsBase, vaultId, token: ADMIN, deviceId: 'B' });
    engines.push(a, b);

    await a.vault.create('shared.md', 'snapshot-v1');
    await waitFor(() => b.vault.contents.get('shared.md') === 'snapshot-v1', 4000);
    await new Promise((r) => setTimeout(r, 700));

    const meta = await a.engine.createSnapshot();

    const fileA = a.vault.getFileByPath('shared.md')!;
    await a.vault.modify(fileA, 'snapshot-v2');
    await a.vault.create('after-snapshot.md', 'created-later');
    await waitFor(() => b.vault.contents.get('shared.md') === 'snapshot-v2', 4000);
    await waitFor(() => b.vault.contents.get('after-snapshot.md') === 'created-later', 4000);

    await a.engine.restoreSnapshot(meta.snapshotId);

    await waitFor(() => a.vault.contents.get('shared.md') === 'snapshot-v1', 4000);
    await waitFor(() => b.vault.contents.get('shared.md') === 'snapshot-v1', 4000);
    await waitFor(() => !b.vault.contents.has('after-snapshot.md'), 4000);

    expect(a.vault.contents.get('shared.md')).toBe('snapshot-v1');
    expect(b.vault.contents.get('shared.md')).toBe('snapshot-v1');
    expect(b.vault.contents.has('after-snapshot.md')).toBe(false);
  });
});
