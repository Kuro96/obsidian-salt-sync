import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import 'fake-indexeddb/auto';
import * as Y from 'yjs';
import { VaultSyncEngine } from '../../src/sync/vaultSync';
import { ObsidianFilesystemBridge } from '../../src/sync/filesystemBridge';
import type { Plugin } from 'obsidian';
import type { SaltSyncSettings } from '../../src/settings';
import type { SharedDirectoryMount, FileTombstone } from '@salt-sync/shared';
import { MockPlugin, MockVault } from '../mocks/obsidian';

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

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

    it('ignores Obsidian trash and Syncthing artifact paths', () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null, ['Shared']);
      expect(engine.isPathForThisEngine('.obsidian/app.json')).toBe(false);
      expect(engine.isPathForThisEngine('.trash/deleted.md')).toBe(false);
      expect(engine.isPathForThisEngine('notes/.stfolder')).toBe(false);
      expect(engine.isPathForThisEngine('notes/.stversions/old.md')).toBe(false);
      expect(engine.isPathForThisEngine('notes/foo.sync-conflict-20260428.md')).toBe(false);
    });
  });

  describe('remote rename cleanup detection', () => {
    function renameTarget(engine: VaultSyncEngine, removedPath: string, txn: Y.Transaction): string | null {
      return (engine as unknown as {
        getUnambiguousRemoteRenameTarget: (path: string, txn: Y.Transaction) => string | null;
      }).getUnambiguousRemoteRenameTarget(removedPath, txn);
    }

    it('returns null for ambiguous pathToId removal without a same-transaction target', () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs } = internals(engine);
      let remoteTxn: Y.Transaction | null = null;
      ydoc.transact(() => {
        pathToId.set('old.md', 'file-1');
        idToPath.set('file-1', 'old.md');
        docs.set('file-1', new Y.Text());
      });
      ydoc.on('afterTransaction', (txn) => {
        if (txn.origin === 'remote') remoteTxn = txn;
      });

      ydoc.transact(() => {
        pathToId.delete('old.md');
      }, 'remote');

      expect(renameTarget(engine, 'old.md', remoteTxn!)).toBeNull();
    });

    it('returns the target only for an unambiguous same-transaction rename', () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs } = internals(engine);
      let remoteTxn: Y.Transaction | null = null;
      ydoc.transact(() => {
        pathToId.set('old.md', 'file-1');
        idToPath.set('file-1', 'old.md');
        docs.set('file-1', new Y.Text());
      });
      ydoc.on('afterTransaction', (txn) => {
        if (txn.origin === 'remote') remoteTxn = txn;
      });

      ydoc.transact(() => {
        pathToId.delete('old.md');
        pathToId.set('new.md', 'file-1');
        idToPath.set('file-1', 'new.md');
      }, 'remote');

      expect(renameTarget(engine, 'old.md', remoteTxn!)).toBe('new.md');
    });
  });

  describe('remote markdown tombstones', () => {
    const readOnlyMount: SharedDirectoryMount = {
      localPath: 'Shared',
      vaultId: 'shared1',
      token: 't',
      readOnly: true,
    };

    function setupRemoteTombstone(remoteFileDeleteSideEffectsOpen: boolean) {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const vault = new MockVault();
      vault.seedText('kept.md', 'local content');
      const { ydoc, tombstones } = internals(engine);
      const self = engine as unknown as {
        bridge: ObsidianFilesystemBridge;
        blobSync: { handleRemoteBlobChanges: (txn: Y.Transaction) => Promise<void> };
        editorBindings: { unbindByPath: (path: string) => void };
        initialSyncComplete: boolean;
        remoteFileDeleteSideEffectsOpen: boolean;
        handleRemoteTransactionSideEffects: (txn: Y.Transaction) => void;
      };
      self.bridge = new ObsidianFilesystemBridge(vault as never, () => null, ydoc, 'primary');
      self.blobSync = { handleRemoteBlobChanges: vi.fn(async () => {}) };
      self.editorBindings = { unbindByPath: vi.fn() };
      self.initialSyncComplete = remoteFileDeleteSideEffectsOpen;
      self.remoteFileDeleteSideEffectsOpen = remoteFileDeleteSideEffectsOpen;
      const deleteSpy = vi.spyOn(vault, 'delete');

      let remoteTxn: Y.Transaction | null = null;
      ydoc.on('afterTransaction', (txn) => {
        if (txn.origin === 'remote') remoteTxn = txn;
      });
      ydoc.transact(() => {
        tombstones.set('kept.md', { deletedAt: new Date().toISOString() });
      }, 'remote');

      return { self, vault, tombstones, deleteSpy, remoteTxn: remoteTxn! };
    }

    it('does not delete local files for tombstones received before remote delete side effects open', async () => {
      const { self, vault, tombstones, deleteSpy, remoteTxn } = setupRemoteTombstone(false);

      self.handleRemoteTransactionSideEffects(remoteTxn);
      await flushPromises();

      expect(deleteSpy).not.toHaveBeenCalled();
      expect(vault.getFileByPath('kept.md')).not.toBeNull();
      expect(tombstones.has('kept.md')).toBe(true);
    });

    it('deletes local files for tombstones received after initial sync completes', async () => {
      const { self, vault, deleteSpy, remoteTxn } = setupRemoteTombstone(true);

      self.handleRemoteTransactionSideEffects(remoteTxn);
      await flushPromises();

      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(vault.getFileByPath('kept.md')).toBeNull();
    });

    it('replays read-only startup fileTombstones received while markdown side effects are closed after gate open', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('Shared/deleted.md', 'local content');
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), readOnlyMount);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);
      const self = engine as unknown as {
        bridge: ObsidianFilesystemBridge;
        blobSync: { handleRemoteBlobChanges: (txn: Y.Transaction) => Promise<void> };
        editorBindings: { unbindByPath: (path: string) => void };
        reconcileReadOnly: () => Promise<void>;
        runBlobMaintenance: () => Promise<void>;
        bindAllOpenEditors: () => void;
        validateAllOpenBindings: () => void;
        notifyStatusChange: () => void;
        completeInitialSync: () => Promise<void>;
      };
      const text = new Y.Text();
      text.insert(0, 'remote content');
      ydoc.transact(() => {
        pathToId.set('deleted.md', 'file-deleted');
        idToPath.set('file-deleted', 'deleted.md');
        docs.set('file-deleted', text);
        tombstones.set('deleted.md', { deletedAt: new Date().toISOString() });
      }, 'remote');
      self.bridge = new ObsidianFilesystemBridge(
        plugin.app.vault as never,
        (docPath) => docs.get(pathToId.get(docPath) ?? '') ?? null,
        ydoc,
        'shared1',
        (vaultPath) => vaultPath.replace(/^Shared\//, ''),
        (docPath) => `Shared/${docPath}`,
      );
      self.blobSync = { handleRemoteBlobChanges: vi.fn(async () => {}) };
      self.editorBindings = { unbindByPath: vi.fn() };
      self.runBlobMaintenance = async () => {};
      self.bindAllOpenEditors = () => {};
      self.validateAllOpenBindings = () => {};
      self.notifyStatusChange = () => {};
      const deleteSpy = vi.spyOn(plugin.app.vault, 'delete');

      await self.completeInitialSync();
      await flushPromises();

      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(plugin.app.vault.getFileByPath('Shared/deleted.md')).toBeNull();
      expect(tombstones.has('deleted.md')).toBe(true);
    });

    it('deletes a live remote markdown tombstone that arrives while completeInitialSync is awaiting maintenance', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('kept.md', 'local content');
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, tombstones } = internals(engine);
      const self = engine as unknown as {
        bridge: ObsidianFilesystemBridge;
        blobSync: { handleRemoteBlobChanges: (txn: Y.Transaction) => Promise<void> };
        editorBindings: { unbindByPath: (path: string) => void };
        initialSyncComplete: boolean;
        remoteFileDeleteSideEffectsOpen: boolean;
        reconcile: () => Promise<void>;
        runBlobMaintenance: () => Promise<void>;
        bindAllOpenEditors: () => void;
        validateAllOpenBindings: () => void;
        notifyStatusChange: () => void;
        completeInitialSync: () => Promise<void>;
        handleRemoteTransactionSideEffects: (txn: Y.Transaction) => void;
      };
      let finishReconcile!: () => void;
      self.bridge = new ObsidianFilesystemBridge(plugin.app.vault as never, () => null, ydoc, 'primary');
      self.blobSync = { handleRemoteBlobChanges: vi.fn(async () => {}) };
      self.editorBindings = { unbindByPath: vi.fn() };
      self.reconcile = () => new Promise<void>((resolve) => { finishReconcile = resolve; });
      self.runBlobMaintenance = async () => {};
      self.bindAllOpenEditors = () => {};
      self.validateAllOpenBindings = () => {};
      self.notifyStatusChange = () => {};
      const deleteSpy = vi.spyOn(plugin.app.vault, 'delete');

      const startup = self.completeInitialSync();
      await flushPromises();
      expect(self.initialSyncComplete).toBe(true);
      expect(self.remoteFileDeleteSideEffectsOpen).toBe(false);

      let remoteTxn: Y.Transaction | null = null;
      ydoc.on('afterTransaction', (txn) => {
        if (txn.origin === 'remote') remoteTxn = txn;
      });
      ydoc.transact(() => {
        tombstones.set('kept.md', { deletedAt: new Date().toISOString() });
      }, 'remote');

      self.handleRemoteTransactionSideEffects(remoteTxn!);
      await flushPromises();
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(plugin.app.vault.getFileByPath('kept.md')).not.toBeNull();
      expect(tombstones.has('kept.md')).toBe(true);

      finishReconcile();
      await startup;

      expect(self.remoteFileDeleteSideEffectsOpen).toBe(true);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(plugin.app.vault.getFileByPath('kept.md')).toBeNull();
      expect(tombstones.has('kept.md')).toBe(true);
    });

    it('keeps the markdown delete gate closed for pending remote tombstones when startup reconcile throws', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('kept.md', 'local content');
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, tombstones } = internals(engine);
      const self = engine as unknown as {
        bridge: ObsidianFilesystemBridge;
        blobSync: { handleRemoteBlobChanges: (txn: Y.Transaction) => Promise<void> };
        editorBindings: { unbindByPath: (path: string) => void };
        remoteFileDeleteSideEffectsOpen: boolean;
        reconcile: () => Promise<void>;
        runBlobMaintenance: () => Promise<void>;
        bindAllOpenEditors: () => void;
        validateAllOpenBindings: () => void;
        notifyStatusChange: () => void;
        completeInitialSync: () => Promise<void>;
        handleRemoteTransactionSideEffects: (txn: Y.Transaction) => void;
      };
      let failReconcile!: (err: Error) => void;
      self.bridge = new ObsidianFilesystemBridge(plugin.app.vault as never, () => null, ydoc, 'primary');
      self.blobSync = { handleRemoteBlobChanges: vi.fn(async () => {}) };
      self.editorBindings = { unbindByPath: vi.fn() };
      self.reconcile = () => new Promise<void>((_resolve, reject) => { failReconcile = reject; });
      self.runBlobMaintenance = async () => {};
      self.bindAllOpenEditors = () => {};
      self.validateAllOpenBindings = () => {};
      self.notifyStatusChange = () => {};
      const deleteSpy = vi.spyOn(plugin.app.vault, 'delete');

      const startup = self.completeInitialSync();
      await flushPromises();

      let remoteTxn: Y.Transaction | null = null;
      ydoc.on('afterTransaction', (txn) => {
        if (txn.origin === 'remote') remoteTxn = txn;
      });
      ydoc.transact(() => {
        tombstones.set('kept.md', { deletedAt: new Date().toISOString() });
      }, 'remote');

      self.handleRemoteTransactionSideEffects(remoteTxn!);
      await flushPromises();
      expect(deleteSpy).not.toHaveBeenCalled();

      const err = new Error('reconcile failed');
      failReconcile(err);
      await expect(startup).rejects.toThrow('reconcile failed');

      expect(self.remoteFileDeleteSideEffectsOpen).toBe(false);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(plugin.app.vault.getFileByPath('kept.md')).not.toBeNull();
      expect(tombstones.has('kept.md')).toBe(true);
    });

    it('does not duplicate delete side effects across repeated markdown gate opens', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('deleted.md', 'local content');
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, tombstones } = internals(engine);
      const self = engine as unknown as {
        bridge: ObsidianFilesystemBridge;
        editorBindings: { unbindByPath: (path: string) => void };
        openMarkdownDeleteGate: () => Promise<void>;
      };
      self.bridge = new ObsidianFilesystemBridge(plugin.app.vault as never, () => null, ydoc, 'primary');
      self.editorBindings = { unbindByPath: vi.fn() };
      tombstones.set('deleted.md', { deletedAt: new Date().toISOString() });
      const deleteSpy = vi.spyOn(plugin.app.vault, 'delete');

      await self.openMarkdownDeleteGate();
      await self.openMarkdownDeleteGate();

      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(plugin.app.vault.getFileByPath('deleted.md')).toBeNull();
    });

    it('authoritative startup still clears polluted server tombstones when a local markdown file exists', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('recovered.md', 'recovered content');
      const engine = new VaultSyncEngine(plugin as never, baseSettings(), null);
      const { ydoc, tombstones } = internals(engine);
      const self = engine as unknown as {
        bridge: ObsidianFilesystemBridge;
        reconcile: () => Promise<void>;
      };
      self.bridge = new ObsidianFilesystemBridge(plugin.app.vault as never, () => null, ydoc, 'primary');
      tombstones.set('recovered.md', { deletedAt: new Date().toISOString() });

      await self.reconcile();

      expect(tombstones.has('recovered.md')).toBe(false);
      expect(plugin.app.vault.getFileByPath('recovered.md')).not.toBeNull();
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
    function setupForReconcile(localFiles: string[], flushed?: string[]) {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const self = engine as unknown as {
        bridge: {
          markDirty: (p: string) => void;
          drain: () => Promise<void>;
          flushFile: (p: string) => Promise<void>;
        };
        plugin: {
          app: {
            vault: { getMarkdownFiles: () => Array<{ path: string }> };
          };
        };
      };
      // Stub out bridge (not initialized without start())
      self.bridge = {
        markDirty: () => {},
        drain: async () => {},
        flushFile: async (p) => { flushed?.push(p); },
      };
      // Stub vault to return only localFiles
      self.plugin = {
        app: {
          vault: { getMarkdownFiles: () => localFiles.map((p) => ({ path: p })) },
        },
      };
      return engine;
    }

    function setupReadOnlyForReconcile(flushed: string[]) {
      const mount: SharedDirectoryMount = {
        localPath: 'Shared',
        vaultId: 'shared1',
        token: 't',
        readOnly: true,
      };
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), mount);
      const self = engine as unknown as {
        bridge: { flushFile: (p: string) => Promise<void> };
      };
      self.bridge = {
        flushFile: async (p) => { flushed.push(p); },
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

    it('flushes Y.Doc files to disk when local directory is empty (localPath change)', async () => {
      const flushed: string[] = [];
      // Disk is empty — simulates a new mount localPath with no files yet
      const engine = setupForReconcile([], flushed);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      // Y.Doc has content (from IDB cache or prior remote sync)
      const fid = 'file-1';
      const text = new Y.Text();
      text.insert(0, 'hello');
      ydoc.transact(() => {
        pathToId.set('note.md', fid);
        idToPath.set(fid, 'note.md');
        docs.set(fid, text);
      });

      await engine.reconcile();

      // File should be flushed to disk
      expect(flushed).toContain('note.md');
      // No tombstone should be generated
      expect(tombstones.has('note.md')).toBe(false);
      // pathToId entry preserved
      expect(pathToId.get('note.md')).toBe(fid);
    });

    it('does not flush files that already have tombstones', async () => {
      const flushed: string[] = [];
      const engine = setupForReconcile([], flushed);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      const fid = 'file-1';
      ydoc.transact(() => {
        pathToId.set('deleted.md', fid);
        idToPath.set(fid, 'deleted.md');
        docs.set(fid, new Y.Text());
        tombstones.set('deleted.md', { deletedAt: new Date().toISOString() });
      });

      await engine.reconcile();

      expect(flushed).not.toContain('deleted.md');
    });

    it('read-only reconcile skips flushing paths present in fileTombstones', async () => {
      const flushed: string[] = [];
      const engine = setupReadOnlyForReconcile(flushed);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      const liveText = new Y.Text();
      liveText.insert(0, 'live');
      const deletedText = new Y.Text();
      deletedText.insert(0, 'deleted');
      ydoc.transact(() => {
        pathToId.set('live.md', 'file-live');
        idToPath.set('file-live', 'live.md');
        docs.set('file-live', liveText);
        pathToId.set('deleted.md', 'file-deleted');
        idToPath.set('file-deleted', 'deleted.md');
        docs.set('file-deleted', deletedText);
        tombstones.set('deleted.md', { deletedAt: new Date().toISOString() });
      });

      await engine.reconcile();

      expect(flushed).toEqual(['live.md']);
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

    it('queues live markdown tombstones during reconnect maintenance and replays them after maintenance', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('live-delete.md', 'local content');
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, tombstones } = internals(engine);
      const self = engine as unknown as {
        client: { send: (message: unknown) => Promise<void> };
        bridge: ObsidianFilesystemBridge;
        blobSync: { handleRemoteBlobChanges: (txn: Y.Transaction) => Promise<void> };
        editorBindings: { unbindByPath: (path: string) => void };
        hasAuthenticated: boolean;
        remoteFileDeleteSideEffectsOpen: boolean;
        reconcile: () => Promise<void>;
        runBlobMaintenance: () => Promise<void>;
        bindAllOpenEditors: () => void;
        validateAllOpenBindings: () => void;
        notifyStatusChange: () => void;
        handleAuthOk: () => Promise<void>;
        handleRemoteTransactionSideEffects: (txn: Y.Transaction) => void;
      };
      let finishReconcile!: () => void;
      self.client = { send: vi.fn(async () => {}) };
      self.bridge = new ObsidianFilesystemBridge(plugin.app.vault as never, () => null, ydoc, 'primary');
      self.blobSync = { handleRemoteBlobChanges: vi.fn(async () => {}) };
      self.editorBindings = { unbindByPath: vi.fn() };
      self.hasAuthenticated = true;
      self.remoteFileDeleteSideEffectsOpen = true;
      self.reconcile = () => new Promise<void>((resolve) => { finishReconcile = resolve; });
      self.runBlobMaintenance = async () => {};
      self.bindAllOpenEditors = () => {};
      self.validateAllOpenBindings = () => {};
      self.notifyStatusChange = () => {};
      const deleteSpy = vi.spyOn(plugin.app.vault, 'delete');

      const reconnect = self.handleAuthOk();
      await flushPromises();
      expect(self.remoteFileDeleteSideEffectsOpen).toBe(false);

      let remoteTxn: Y.Transaction | null = null;
      ydoc.on('afterTransaction', (txn) => {
        if (txn.origin === 'remote') remoteTxn = txn;
      });
      ydoc.transact(() => {
        tombstones.set('live-delete.md', { deletedAt: new Date().toISOString() });
      }, 'remote');

      self.handleRemoteTransactionSideEffects(remoteTxn!);
      await flushPromises();
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(plugin.app.vault.getFileByPath('live-delete.md')).not.toBeNull();

      finishReconcile();
      await reconnect;

      expect(self.remoteFileDeleteSideEffectsOpen).toBe(true);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(plugin.app.vault.getFileByPath('live-delete.md')).toBeNull();
    });
  });

  describe('markdown remote tombstone startup gate', () => {
    async function setupStartedEngine(localFiles: Record<string, string> = {}) {
      const plugin = new MockPlugin();
      for (const [path, content] of Object.entries(localFiles)) {
        plugin.app.vault.seedText(path, content);
      }

      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const self = engine as unknown as {
        cache: {
          load: () => Promise<null>;
          save: () => Promise<void>;
          clearLegacyVaultOnlyKey: () => Promise<boolean>;
        };
        client: {
          connect: () => Promise<void>;
          onMessage: (handler: (msg: { type: string; update?: Uint8Array }) => Promise<void>) => void;
          onStatusChange: () => void;
          send: () => Promise<void>;
          disconnect: () => Promise<void>;
        };
        bridge: {
          deleteFile: Mock;
          notifyFileClosed: Mock;
        };
        blobSync: {
          enterStartupGate: () => void;
          onPendingDownloadsChange: () => void;
          onPendingUploadsChange: () => void;
          onPendingRemoteDeletesChange: () => void;
          onPendingLocalDeletionsChange: () => void;
        };
        handleAuthOk: () => Promise<void>;
        handleRemoteUpdate: (update: Uint8Array) => Promise<void>;
        completeInitialSync: () => Promise<void>;
        runBlobMaintenance: () => Promise<void>;
      };
      self.cache = {
        load: async () => null,
        save: async () => {},
        clearLegacyVaultOnlyKey: async () => false,
      };
      self.client = {
        connect: async () => {},
        onMessage: () => {},
        onStatusChange: () => {},
        send: async () => {},
        disconnect: async () => {},
      };
      self.runBlobMaintenance = async () => {};

      await engine.start();

      self.bridge.deleteFile = vi.fn(async () => {});
      self.bridge.notifyFileClosed = vi.fn();
      return { engine, self };
    }

    function applyRemoteTombstone(engine: VaultSyncEngine, path: string): void {
      const { ydoc, tombstones } = internals(engine);
      ydoc.transact(() => {
        tombstones.set(path, {
          deletedAt: new Date().toISOString(),
        });
      }, 'remote');
    }

    function applyRemoteTombstoneUpdate(engine: VaultSyncEngine, path: string): void {
      const remoteDoc = new Y.Doc();
      (remoteDoc.getMap('fileTombstones') as Y.Map<FileTombstone>).set(path, {
        deletedAt: new Date().toISOString(),
      });
      const { ydoc } = internals(engine);
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc), 'remote');
    }

    it('does not delete for a remote startup tombstone before or after initial reconcile', async () => {
      const { engine, self } = await setupStartedEngine({ 'local.md': 'keep me' });

      await self.handleAuthOk();
      applyRemoteTombstoneUpdate(engine, 'local.md');

      expect(self.bridge.deleteFile).not.toHaveBeenCalled();

      await self.completeInitialSync();

      expect(self.bridge.deleteFile).not.toHaveBeenCalled();
      await engine.stop();
    });

    it('does not delete an unclassified startup tombstone if initial reconcile fails', async () => {
      const { engine, self } = await setupStartedEngine({ 'local.md': 'keep me' });

      await self.handleAuthOk();
      applyRemoteTombstone(engine, 'local.md');
      vi.spyOn(engine, 'reconcile').mockRejectedValueOnce(new Error('reconcile failed'));

      await expect(self.completeInitialSync()).rejects.toThrow('reconcile failed');

      expect(self.bridge.deleteFile).not.toHaveBeenCalled();
      await engine.stop();
    });

    it('does not delete for a remote tombstone received after initial reconcile fails', async () => {
      const { engine, self } = await setupStartedEngine({ 'local.md': 'keep me' });

      await self.handleAuthOk();
      vi.spyOn(engine, 'reconcile').mockRejectedValueOnce(new Error('reconcile failed'));

      await expect(self.completeInitialSync()).rejects.toThrow('reconcile failed');
      applyRemoteTombstone(engine, 'local.md');

      expect(self.bridge.deleteFile).not.toHaveBeenCalled();
      await engine.stop();
    });

    it('deletes for a remote tombstone received after initial sync maintenance completes', async () => {
      const { engine, self } = await setupStartedEngine({ 'live.md': 'delete me' });

      await self.handleAuthOk();
      await self.completeInitialSync();
      applyRemoteTombstone(engine, 'live.md');

      expect(self.bridge.deleteFile).toHaveBeenCalledWith('live.md');
      await engine.stop();
    });

    it('does not blindly delete pre-existing tombstones when opening the startup path', async () => {
      const { engine, self } = await setupStartedEngine({ 'cached.md': 'keep me' });
      const { tombstones } = internals(engine);
      tombstones.set('cached.md', { deletedAt: new Date().toISOString() });

      await self.handleAuthOk();
      await self.completeInitialSync();

      expect(self.bridge.deleteFile).not.toHaveBeenCalled();
      await engine.stop();
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

  describe('stop() event guard', () => {
    function setupWithMockPlugin(mount: SharedDirectoryMount | null = null) {
      const plugin = new MockPlugin();
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), mount);
      const self = engine as unknown as {
        stopped: boolean;
        client: {
          connect: () => Promise<void>;
          onMessage: () => void;
          onStatusChange: () => void;
          send: () => Promise<void>;
          disconnect: () => Promise<void>;
        };
        blobSync: {
          enterStartupGate: () => void;
          onPendingDownloadsChange: () => void;
          onPendingUploadsChange: () => void;
          onPendingRemoteDeletesChange: () => void;
          onPendingLocalDeletionsChange: () => void;
          handleLocalBlobDeletion: Mock;
          handleLocalBlobChange: Mock;
        };
        bridge: {
          markDirty: () => void;
          drain: () => Promise<void>;
          flushFile: () => Promise<void>;
          isExpectedDelete: () => boolean;
          syncOpenFiles: () => void;
        };
        editorBindings: {
          unbindAll: () => void;
          unbindByPath: () => void;
          bindAllOpenEditors: () => void;
          validateAllOpenBindings: () => void;
          updatePathsAfterRename: () => void;
          isHealthyBinding: () => boolean;
        };
        awareness: { destroy: () => void; on: () => void };
        cache: {
          clearLegacyVaultOnlyKey: () => Promise<boolean>;
          load: () => Promise<null>;
          save: () => Promise<void>;
        };
        blobRuntimeStateStore: { load: () => Promise<null>; save: () => Promise<void>; clear: () => Promise<void> };
        flushCacheSave: () => Promise<void>;
        notifyStatusChange: () => void;
        statusHandlers: unknown[];
      };

      const blobDeletion = vi.fn(async () => {});
      const blobChange = vi.fn(async () => {});

      self.client = {
        connect: async () => {},
        onMessage: () => {},
        onStatusChange: () => {},
        send: async () => {},
        disconnect: async () => {},
      };
      self.blobSync = {
        enterStartupGate: () => {},
        onPendingDownloadsChange: () => {},
        onPendingUploadsChange: () => {},
        onPendingRemoteDeletesChange: () => {},
        onPendingLocalDeletionsChange: () => {},
        handleLocalBlobDeletion: blobDeletion,
        handleLocalBlobChange: blobChange,
      };
      self.bridge = {
        markDirty: () => {},
        drain: async () => {},
        flushFile: async () => {},
        isExpectedDelete: () => false,
        syncOpenFiles: () => {},
      };
      self.editorBindings = {
        unbindAll: () => {},
        unbindByPath: () => {},
        bindAllOpenEditors: () => {},
        validateAllOpenBindings: () => {},
        updatePathsAfterRename: () => {},
        isHealthyBinding: () => false,
      };
      self.awareness = { destroy: () => {}, on: () => {}, setLocalStateField: () => {} };
      self.cache = {
        clearLegacyVaultOnlyKey: async () => false,
        load: async () => null,
        save: async () => {},
      };
      self.blobRuntimeStateStore = { load: async () => null, save: async () => {}, clear: async () => {} };
      self.flushCacheSave = async () => {};
      self.notifyStatusChange = () => {};
      self.statusHandlers = [];

      return { plugin, engine, self, blobDeletion, blobChange };
    }

    it('vault rename event does not write tombstone after stop()', async () => {
      const { plugin, engine } = setupWithMockPlugin();
      await engine.start();

      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);
      const fid = 'file-1';
      ydoc.transact(() => {
        pathToId.set('note.md', fid);
        idToPath.set(fid, 'note.md');
        docs.set(fid, new Y.Text());
      });

      await engine.stop();

      // Simulate user moving note.md out of the engine's localPath scope
      plugin.app.vault.emit('rename', { path: 'Other/note.md' }, 'note.md');

      expect(tombstones.has('note.md')).toBe(false);
      expect(pathToId.has('note.md')).toBe(true);
    });

    it('vault delete event does not write tombstone after stop()', async () => {
      const { plugin, engine } = setupWithMockPlugin();
      await engine.start();

      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);
      const fid = 'file-2';
      ydoc.transact(() => {
        pathToId.set('doc.md', fid);
        idToPath.set(fid, 'doc.md');
        docs.set(fid, new Y.Text());
      });

      await engine.stop();

      plugin.app.vault.emit('delete', { path: 'doc.md' });

      expect(tombstones.has('doc.md')).toBe(false);
      expect(pathToId.has('doc.md')).toBe(true);
    });

    it('vault rename event for blob does not enqueue deletion after stop()', async () => {
      const mount: SharedDirectoryMount = { localPath: 'Shared', vaultId: 'shared1', token: 't', readOnly: false };
      const { plugin, engine, blobDeletion } = setupWithMockPlugin(mount);
      await engine.start();

      await engine.stop();

      // Simulate blob moved out of Shared/ while plugin was stopped
      plugin.app.vault.emit('rename', { path: 'Other/image.png' }, 'Shared/image.png');

      expect(blobDeletion).not.toHaveBeenCalled();
    });

    it('vault events are processed normally before stop()', async () => {
      const { plugin, engine } = setupWithMockPlugin();
      await engine.start();

      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);
      const fid = 'file-3';
      ydoc.transact(() => {
        pathToId.set('alive.md', fid);
        idToPath.set(fid, 'alive.md');
        docs.set(fid, new Y.Text());
      });

      // Engine still running — delete event should create tombstone
      plugin.app.vault.emit('delete', { path: 'alive.md' });

      expect(tombstones.has('alive.md')).toBe(true);

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
