import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import * as Y from 'yjs';
import { VaultSyncEngine } from '../../src/sync/vaultSync';
import type { Plugin } from 'obsidian';
import type { SaltSyncSettings } from '../../src/settings';
import type { SharedDirectoryMount, FileTombstone } from '@salt-sync/shared';
import { MockPlugin } from '../mocks/obsidian';

function baseSettings(): SaltSyncSettings {
  return {
    serverUrl: 'ws://localhost:8080',
    vaultId: 'primary',
    token: 'dev',
    deviceId: 'dev1',
    deviceName: 'test',
    sharedMounts: [],
  };
}

function fakePlugin(): Plugin {
  // VaultSyncEngine's ctor only stores the reference — start() is what touches it.
  return {} as unknown as Plugin;
}

function internals(engine: VaultSyncEngine) {
  // Access private Y.Doc and maps via the instance's internal state.
  const self = engine as unknown as {
    ydoc: Y.Doc;
    knownLocalMarkdownPaths: Set<string>;
  };
  const ydoc = self.ydoc;
  return {
    ydoc,
    knownLocalMarkdownPaths: self.knownLocalMarkdownPaths,
    pathToId: ydoc.getMap('pathToId') as Y.Map<string>,
    idToPath: ydoc.getMap('idToPath') as Y.Map<string>,
    docs: ydoc.getMap('docs') as Y.Map<Y.Text>,
    tombstones: ydoc.getMap('fileTombstones') as Y.Map<FileTombstone>,
  };
}

describe('VaultSyncEngine', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isPathForThisEngine', () => {
    it('primary engine accepts top-level paths, rejects excluded mount prefixes', () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null, ['Shared']);
      expect(engine.isPathForThisEngine('foo.md')).toBe(true);
      expect(engine.isPathForThisEngine('a/b.md')).toBe(true);
      expect(engine.isPathForThisEngine('Shared/x.md')).toBe(false);
      // a path that just starts with the same letters but a different segment is OK
      expect(engine.isPathForThisEngine('SharedOther.md')).toBe(true);
    });

    it('mount engine accepts only its prefix', () => {
      const mount: SharedDirectoryMount = {
        localPath: 'Shared',
        vaultId: 'shared1',
        token: 't',
        readOnly: false,
      };
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), mount);
      expect(engine.isPathForThisEngine('Shared/x.md')).toBe(true);
      expect(engine.isPathForThisEngine('Shared/a/b.md')).toBe(true);
      expect(engine.isPathForThisEngine('other.md')).toBe(false);
      expect(engine.isPathForThisEngine('SharedOther/y.md')).toBe(false);
    });
  });

  describe('handleLocalFileDeletion', () => {
    it('writes a tombstone and drops pathToId / idToPath / docs', () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      // Seed: create a file entry directly (mirrors getOrCreateYText effect).
      const fileId = 'file-1';
      ydoc.transact(() => {
        pathToId.set('n.md', fileId);
        idToPath.set(fileId, 'n.md');
        docs.set(fileId, new Y.Text());
      });

      engine.handleLocalFileDeletion('n.md');

      expect(pathToId.has('n.md')).toBe(false);
      expect(idToPath.has(fileId)).toBe(false);
      expect(docs.has(fileId)).toBe(false);
      expect(tombstones.has('n.md')).toBe(true);
      const ts = tombstones.get('n.md')!;
      expect(typeof ts.deletedAt).toBe('string');
    });

    it('is a no-op when path is unknown', () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const { tombstones } = internals(engine);
      engine.handleLocalFileDeletion('ghost.md');
      expect(tombstones.size).toBe(0);
    });
  });

  describe('handleLocalFileRename', () => {
    it('updates pathToId / idToPath keeping the same fileId', () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs } = internals(engine);

      const fileId = 'file-1';
      ydoc.transact(() => {
        pathToId.set('a.md', fileId);
        idToPath.set(fileId, 'a.md');
        docs.set(fileId, new Y.Text());
      });

      engine.handleLocalFileRename('a.md', 'b.md');

      expect(pathToId.get('a.md')).toBeUndefined();
      expect(pathToId.get('b.md')).toBe(fileId);
      expect(idToPath.get(fileId)).toBe('b.md');
    });
  });

  describe('mount path translation', () => {
    it('handleLocalFileDeletion on mount engine operates on docPath (prefix stripped)', () => {
      const mount: SharedDirectoryMount = {
        localPath: 'Shared',
        vaultId: 'shared1',
        token: 't',
        readOnly: false,
      };
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), mount);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      // Shared model always uses docPath (prefix-stripped).
      const fileId = 'file-1';
      ydoc.transact(() => {
        pathToId.set('doc.md', fileId);
        idToPath.set(fileId, 'doc.md');
        docs.set(fileId, new Y.Text());
      });

      engine.handleLocalFileDeletion('doc.md');

      expect(tombstones.has('doc.md')).toBe(true);
      expect(pathToId.has('doc.md')).toBe(false);
    });
  });

  describe('reconcile()', () => {
    function setupForReconcile(localFiles: string[]) {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const self = engine as unknown as {
        bridge: {
          markDirty: (p: string) => void;
          drain: () => Promise<void>;
        };
        plugin: {
          app: {
            vault: { getMarkdownFiles: () => Array<{ path: string }> };
          };
        };
      };
      // Stub out bridge (not initialized without start())
      self.bridge = { markDirty: () => {}, drain: async () => {} };
      // Stub vault to return only localFiles
      self.plugin = {
        app: {
          vault: { getMarkdownFiles: () => localFiles.map((p) => ({ path: p })) },
        },
      };
      return engine;
    }

    it('writes tombstone for files in shared model but absent from disk', async () => {
      const engine = setupForReconcile(['present.md']);
      const { ydoc, knownLocalMarkdownPaths, pathToId, idToPath, docs, tombstones } = internals(engine);

      const fid1 = 'file-1';
      const fid2 = 'file-2';
      ydoc.transact(() => {
        pathToId.set('present.md', fid1);
        idToPath.set(fid1, 'present.md');
        docs.set(fid1, new Y.Text());
        pathToId.set('missing.md', fid2);
        idToPath.set(fid2, 'missing.md');
        docs.set(fid2, new Y.Text());
      });
      knownLocalMarkdownPaths.add('missing.md');

      await engine.reconcile();

      expect(tombstones.has('missing.md')).toBe(true);
      expect(tombstones.has('present.md')).toBe(false);
      // pathToId entry for missing.md should be cleaned up
      expect(pathToId.has('missing.md')).toBe(false);
    });

    it('does not tombstone files already in fileTombstones', async () => {
      const engine = setupForReconcile([]);
      const { ydoc, knownLocalMarkdownPaths, pathToId, idToPath, docs, tombstones } = internals(engine);

      const fid = 'file-1';
      const existingTs = new Date(Date.now() - 1000).toISOString();
      ydoc.transact(() => {
        pathToId.set('gone.md', fid);
        idToPath.set(fid, 'gone.md');
        docs.set(fid, new Y.Text());
        tombstones.set('gone.md', { deletedAt: existingTs });
      });
      knownLocalMarkdownPaths.add('gone.md');

      await engine.reconcile();

      // Already tombstoned → reconcile skips it; existing tombstone preserved
      expect(tombstones.get('gone.md')?.deletedAt).toBe(existingTs);
    });

    it('does not tombstone files that are locally present', async () => {
      const engine = setupForReconcile(['note.md']);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      const fid = 'file-1';
      ydoc.transact(() => {
        pathToId.set('note.md', fid);
        idToPath.set(fid, 'note.md');
        docs.set(fid, new Y.Text());
      });

      await engine.reconcile();

      expect(tombstones.has('note.md')).toBe(false);
      expect(pathToId.has('note.md')).toBe(true);
    });

    it('does not tombstone remote-only files that were never known locally', async () => {
      const engine = setupForReconcile([]);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      const fid = 'file-remote';
      ydoc.transact(() => {
        pathToId.set('remote.md', fid);
        idToPath.set(fid, 'remote.md');
        docs.set(fid, new Y.Text());
      });

      await engine.reconcile();

      expect(tombstones.has('remote.md')).toBe(false);
      expect(pathToId.get('remote.md')).toBe(fid);
    });
  });

  describe('handleAuthOk', () => {
    it('reconciles and rebinds only after the initial auth has completed', async () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const self = engine as unknown as {
        client: { send: (message: unknown) => Promise<void> };
        reconcile: () => Promise<void>;
        bindAllOpenEditors: () => void;
        validateAllOpenBindings: () => void;
        handleAuthOk: () => Promise<void>;
      };

      const sent: unknown[] = [];
      let reconciles = 0;
      let binds = 0;
      let validates = 0;

      self.client = {
        send: async (message: unknown) => {
          sent.push(message);
        },
      };
      self.reconcile = async () => {
        reconciles += 1;
      };
      self.bindAllOpenEditors = () => {
        binds += 1;
      };
      self.validateAllOpenBindings = () => {
        validates += 1;
      };

      await self.handleAuthOk();
      expect(sent).toHaveLength(1);
      expect(reconciles).toBe(0);
      expect(binds).toBe(0);
      expect(validates).toBe(0);

      await self.handleAuthOk();
      expect(sent).toHaveLength(2);
      expect(reconciles).toBe(1);
      expect(binds).toBe(1);
      expect(validates).toBe(1);
    });
  });

  describe('local cache namespacing', () => {
    it('does not inherit legacy vault-only cache entries after switching server', async () => {
      const plugin = new MockPlugin();
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const self = engine as unknown as {
        cache: {
          load: (key: string) => Promise<{ vaultId: string; ydocUpdate: Uint8Array; updatedAt: string } | null>;
          save: (key: string, state: { vaultId: string; ydocUpdate: Uint8Array; updatedAt: string }) => Promise<void>;
          clearLegacyVaultOnlyKey: (currentKey: string, legacyVaultId: string) => Promise<boolean>;
        };
        client: {
          connect: (input: unknown) => Promise<void>;
          onMessage: (handler: unknown) => void;
          onStatusChange: (handler: unknown) => void;
          send: (message: unknown) => Promise<void>;
          disconnect: () => Promise<void>;
        };
      };

      const legacyDoc = new Y.Doc();
      legacyDoc.getMap('pathToId').set('stale.md', 'file-stale');
      legacyDoc.getMap('idToPath').set('file-stale', 'stale.md');
      const staleText = new Y.Text();
      staleText.insert(0, 'stale content');
      legacyDoc.getMap('docs').set('file-stale', staleText);
      const legacyUpdate = Y.encodeStateAsUpdate(legacyDoc);

      const loadSpy = vi.fn(async (key: string) => {
        if (key === 'primary') {
          return {
            vaultId: 'primary',
            ydocUpdate: legacyUpdate,
            updatedAt: new Date().toISOString(),
          };
        }
        return null;
      });
      const clearLegacySpy = vi.fn(async () => true);

      self.cache = {
        clearLegacyVaultOnlyKey: clearLegacySpy,
        load: loadSpy,
        save: async () => {},
      };
      self.client = {
        connect: async () => {},
        onMessage: () => {},
        onStatusChange: () => {},
        send: async () => {},
        disconnect: async () => {},
      };

      await engine.start();

      const { pathToId, docs } = internals(engine);
      expect(clearLegacySpy).toHaveBeenCalledWith('ws://localhost:8080::primary', 'primary');
      expect(loadSpy).toHaveBeenCalledWith('ws://localhost:8080::primary');
      expect(loadSpy).not.toHaveBeenCalledWith('primary');
      expect(pathToId.has('stale.md')).toBe(false);
      expect(docs.size).toBe(0);

      await engine.stop();
    });
  });

  describe('restoreSnapshot()', () => {
    it('updates knownLocalMarkdownPaths to match restored and removed markdown paths', async () => {
      const plugin = new MockPlugin();
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, knownLocalMarkdownPaths, pathToId, idToPath, docs, tombstones } = internals(engine);
      const self = engine as unknown as {
        bridge: { deleteFile: (path: string) => Promise<void>; flushFile: (path: string) => Promise<void> };
        blobSync: { deleteLocalBlob: (path: string) => Promise<void>; materializeBlob: (path: string) => Promise<void> };
        bindAllOpenEditors: () => void;
        validateAllOpenBindings: () => void;
      };

      const deleted: string[] = [];
      const flushed: string[] = [];
      self.bridge = {
        deleteFile: async (path) => {
          deleted.push(path);
        },
        flushFile: async (path) => {
          flushed.push(path);
        },
      };
      self.blobSync = {
        deleteLocalBlob: async () => {},
        materializeBlob: async () => {},
      };
      self.bindAllOpenEditors = () => {};
      self.validateAllOpenBindings = () => {};

      ydoc.transact(() => {
        pathToId.set('old.md', 'file-old');
        idToPath.set('file-old', 'old.md');
        const text = new Y.Text();
        text.insert(0, 'old content');
        docs.set('file-old', text);
      });
      knownLocalMarkdownPaths.add('old.md');

      const snapDoc = new Y.Doc();
      (snapDoc.getMap('pathToId') as Y.Map<string>).set('restored.md', 'file-restored');
      (snapDoc.getMap('idToPath') as Y.Map<string>).set('file-restored', 'restored.md');
      const restoredText = new Y.Text();
      restoredText.insert(0, 'restored content');
      (snapDoc.getMap('docs') as Y.Map<Y.Text>).set('file-restored', restoredText);
      (snapDoc.getMap('fileTombstones') as Y.Map<FileTombstone>).set('old.md', {
        deletedAt: new Date().toISOString(),
      });
      const payload = Y.encodeStateAsUpdate(snapDoc);
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue(
        new Response(payload, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
      );

      await engine.restoreSnapshot('snap-1');

      expect(knownLocalMarkdownPaths.has('restored.md')).toBe(true);
      expect(knownLocalMarkdownPaths.has('old.md')).toBe(false);
      expect(pathToId.has('old.md')).toBe(false);
      const restoredFileId = pathToId.get('restored.md');
      expect(restoredFileId).toBeDefined();
      expect(docs.get(restoredFileId!)?.toString()).toBe('restored content');
      expect(tombstones.has('old.md')).toBe(true);
      expect(deleted).toEqual(['old.md']);
      expect(flushed).toEqual(['restored.md']);
    });
  });
});
