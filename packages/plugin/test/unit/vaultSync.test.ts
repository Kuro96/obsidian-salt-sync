import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import 'fake-indexeddb/auto';
import * as Y from 'yjs';
import { VaultSyncEngine } from '../../src/sync/vaultSync';
import { ObsidianFilesystemBridge } from '../../src/sync/filesystemBridge';
import type { Plugin } from 'obsidian';
import type { SaltSyncSettings } from '../../src/settings';
import type { SharedDirectoryMount, FileTombstone } from '@salt-sync/shared';
import { MockPlugin, MockVault, TFile } from '../mocks/obsidian';
import { UserIgnoreMatcher } from '../../src/sync/userIgnore';

function baseSettings(): SaltSyncSettings {
  return {
    serverUrl: 'ws://localhost:8080',
    vaultId: 'primary',
    token: 'dev',
    deviceId: 'dev1',
    deviceName: 'test',
    vaultSyncEnabled: false,
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
    pendingLocalMarkdownDeletions: Set<string>;
  };
  const ydoc = self.ydoc;
  return {
    ydoc,
    knownLocalMarkdownPaths: self.knownLocalMarkdownPaths,
    pendingLocalMarkdownDeletions: self.pendingLocalMarkdownDeletions,
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

  describe('lifecycle', () => {
    it('stop is safe before start finishes initialization', async () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);

      await expect(engine.stop()).resolves.toBeUndefined();
      await expect(engine.stop()).resolves.toBeUndefined();
    });
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
      expect(engine.isPathForThisEngine('notes/~syncthing~foo.md.tmp')).toBe(false);
      expect(engine.isPathForThisEngine('notes/draft.tmp')).toBe(true);
    });

    it('applies configured ignore file rules to engine path filtering', async () => {
      const vault = new MockVault();
      vault.seedText('.salt-sync-ignore', 'private/**\n*.draft.md');
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      (engine as unknown as { userIgnoreMatcher: UserIgnoreMatcher }).userIgnoreMatcher = await UserIgnoreMatcher.load(
        vault as never,
        '.salt-sync-ignore',
      );

      expect(engine.isPathForThisEngine('private/secret.md')).toBe(false);
      expect(engine.isPathForThisEngine('notes/day.draft.md')).toBe(false);
      expect(engine.isPathForThisEngine('notes/day.md')).toBe(true);
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

    it('guards queued remote rename cleanup against deleting a recreated old path', () => {
      const plugin = new MockPlugin();
      const originalFile = plugin.app.vault.seedText('old.md', 'original local');
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs, knownLocalMarkdownPaths } = internals(engine);
      const self = engine as unknown as {
        bridge: { deleteFile: Mock; notifyFileClosed: Mock; handleRemoteTransaction: Mock; flushFile: Mock };
        editorBindings: { unbindByPath: Mock };
        blobSync: { handleRemoteBlobChanges: Mock };
        handleRemoteTransactionSideEffects: (txn: Y.Transaction) => void;
      };
      self.bridge = { deleteFile: vi.fn(async () => {}), notifyFileClosed: vi.fn(), handleRemoteTransaction: vi.fn(), flushFile: vi.fn(async () => {}) };
      self.editorBindings = { unbindByPath: vi.fn() };
      self.blobSync = { handleRemoteBlobChanges: vi.fn(async () => {}) };
      knownLocalMarkdownPaths.add('old.md');

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

      self.handleRemoteTransactionSideEffects(remoteTxn!);

      expect(self.bridge.deleteFile).toHaveBeenCalledWith('old.md', expect.any(Function));
      expect(knownLocalMarkdownPaths.has('old.md')).toBe(false);
      const shouldDelete = self.bridge.deleteFile.mock.calls[0][1] as (file: TFile | null) => boolean;
      expect(shouldDelete(originalFile)).toBe(true);
      plugin.app.vault.files.delete('old.md');
      plugin.app.vault.contents.delete('old.md');
      const recreatedFile = plugin.app.vault.seedText('old.md', 'recreated local');
      expect(shouldDelete(recreatedFile)).toBe(false);
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
      const { ydoc, tombstones, knownLocalMarkdownPaths } = internals(engine);
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
      knownLocalMarkdownPaths.add('kept.md');

      let remoteTxn: Y.Transaction | null = null;
      ydoc.on('afterTransaction', (txn) => {
        if (txn.origin === 'remote') remoteTxn = txn;
      });
      ydoc.transact(() => {
        tombstones.set('kept.md', { deletedAt: new Date().toISOString() });
      }, 'remote');

      return { self, vault, tombstones, deleteSpy, knownLocalMarkdownPaths, remoteTxn: remoteTxn! };
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
      const { self, vault, deleteSpy, knownLocalMarkdownPaths, remoteTxn } = setupRemoteTombstone(true);

      self.handleRemoteTransactionSideEffects(remoteTxn);
      await flushPromises();

      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(vault.getFileByPath('kept.md')).toBeNull();
      expect(knownLocalMarkdownPaths.has('kept.md')).toBe(false);
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

    it('does not open destructive markdown replay when startup reconcile throws', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('kept.md', 'local content');
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, tombstones } = internals(engine);
      const self = engine as unknown as {
        bridge: ObsidianFilesystemBridge;
        blobSync: { handleRemoteBlobChanges: (txn: Y.Transaction) => Promise<void> };
        editorBindings: { unbindByPath: (path: string) => void };
        remoteFileDeleteSideEffectsOpen: boolean;
        markdownDeleteGateState: string;
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
      expect(self.markdownDeleteGateState).toBe('maintenance-blocked');
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

    it('classifies same-path startup remote tombstone with recovered local file as stale without flushing remote content', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('recovered.md', 'local recovered content');
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);
      const self = engine as unknown as {
        bridge: ObsidianFilesystemBridge;
        blobSync: { handleRemoteBlobChanges: (txn: Y.Transaction) => Promise<void> };
        editorBindings: { unbindByPath: (path: string) => void };
        runBlobMaintenance: () => Promise<void>;
        bindAllOpenEditors: () => void;
        validateAllOpenBindings: () => void;
        notifyStatusChange: () => void;
        completeInitialSync: () => Promise<void>;
        handleRemoteTransactionSideEffects: (txn: Y.Transaction) => void;
      };
      self.bridge = new ObsidianFilesystemBridge(
        plugin.app.vault as never,
        (docPath) => docs.get(pathToId.get(docPath) ?? '') ?? null,
        ydoc,
        'primary',
      );
      self.blobSync = { handleRemoteBlobChanges: vi.fn(async () => {}) };
      self.editorBindings = { unbindByPath: vi.fn() };
      self.runBlobMaintenance = async () => {};
      self.bindAllOpenEditors = () => {};
      self.validateAllOpenBindings = () => {};
      self.notifyStatusChange = () => {};
      const deleteSpy = vi.spyOn(plugin.app.vault, 'delete');

      let remoteTxn: Y.Transaction | null = null;
      ydoc.on('afterTransaction', (txn) => {
        if (txn.origin === 'remote') remoteTxn = txn;
      });
      ydoc.transact(() => {
        const text = new Y.Text();
        text.insert(0, 'stale remote content');
        pathToId.set('recovered.md', 'file-recovered');
        idToPath.set('file-recovered', 'recovered.md');
        docs.set('file-recovered', text);
        tombstones.set('recovered.md', { deletedAt: new Date().toISOString() });
      }, 'remote');

      self.handleRemoteTransactionSideEffects(remoteTxn!);
      await flushPromises();
      await self.completeInitialSync();
      await flushPromises();

      expect(deleteSpy).not.toHaveBeenCalled();
      expect(plugin.app.vault.getFileByPath('recovered.md')).not.toBeNull();
      await expect(plugin.app.vault.read(plugin.app.vault.getFileByPath('recovered.md')!)).resolves.toBe('local recovered content');
      expect(tombstones.has('recovered.md')).toBe(false);
      expect(docs.get(pathToId.get('recovered.md')!)?.toString()).toBe('local recovered content');
    });

    it('classifies cached startup tombstone through start cache path with writable recovered local as stale', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('cached.md', 'local cached recovery');
      const cacheDoc = new Y.Doc();
      const cachePathToId = cacheDoc.getMap('pathToId') as Y.Map<string>;
      const cacheIdToPath = cacheDoc.getMap('idToPath') as Y.Map<string>;
      const cacheDocs = cacheDoc.getMap('docs') as Y.Map<Y.Text>;
      const cacheTombstones = cacheDoc.getMap('fileTombstones') as Y.Map<FileTombstone>;
      const staleText = new Y.Text();
      staleText.insert(0, 'cached stale remote');
      cachePathToId.set('cached.md', 'file-cached');
      cacheIdToPath.set('file-cached', 'cached.md');
      cacheDocs.set('file-cached', staleText);
      cacheTombstones.set('cached.md', { deletedAt: new Date().toISOString() });

      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const self = engine as unknown as {
        cache: { clearLegacyVaultOnlyKey: () => Promise<boolean>; load: () => Promise<{ vaultId: string; ydocUpdate: Uint8Array; updatedAt: string }>; save: () => Promise<void> };
        client: { connect: () => Promise<void>; onMessage: () => void; onStatusChange: () => void; send: () => Promise<void>; disconnect: () => Promise<void> };
        blobSync: { restoreRuntimeState: () => Promise<void>; reconcile: () => Promise<void>; enterMaintenanceGate: () => void; openRemoteApplyGate: () => Promise<void> };
        runBlobMaintenance: () => Promise<void>;
        completeInitialSync: () => Promise<void>;
      };
      self.cache = {
        clearLegacyVaultOnlyKey: async () => false,
        load: async () => ({ vaultId: 'primary', ydocUpdate: Y.encodeStateAsUpdate(cacheDoc), updatedAt: new Date().toISOString() }),
        save: async () => {},
      };
      self.client = { connect: async () => {}, onMessage: () => {}, onStatusChange: () => {}, send: async () => {}, disconnect: async () => {} };
      self.runBlobMaintenance = async () => {};
      const deleteSpy = vi.spyOn(plugin.app.vault, 'delete');

      await engine.start();
      await self.completeInitialSync();
      await flushPromises();

      const { pathToId, docs, tombstones } = internals(engine);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(plugin.app.vault.getFileByPath('cached.md')).not.toBeNull();
      expect(tombstones.has('cached.md')).toBe(false);
      expect(docs.get(pathToId.get('cached.md')!)?.toString()).toBe('local cached recovery');
      await engine.stop();
    });

    it('keeps startup tombstone when force-import of recovered local file fails', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('recover-fails.md', 'local recovery');
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);
      const self = engine as unknown as {
        bridge: ObsidianFilesystemBridge;
        blobSync: { handleRemoteBlobChanges: (txn: Y.Transaction) => Promise<void> };
        editorBindings: { unbindByPath: (path: string) => void };
        runBlobMaintenance: () => Promise<void>;
        completeInitialSync: () => Promise<void>;
        handleRemoteTransactionSideEffects: (txn: Y.Transaction) => void;
      };
      self.bridge = new ObsidianFilesystemBridge(
        plugin.app.vault as never,
        (docPath) => docs.get(pathToId.get(docPath) ?? '') ?? null,
        ydoc,
        'primary',
      );
      self.blobSync = { handleRemoteBlobChanges: vi.fn(async () => {}) };
      self.editorBindings = { unbindByPath: vi.fn() };
      self.runBlobMaintenance = async () => {};
      vi.spyOn(self.bridge, 'forceImportFromDisk').mockRejectedValueOnce(new Error('disk import failed'));
      let remoteTxn: Y.Transaction | null = null;
      ydoc.on('afterTransaction', (txn) => {
        if (txn.origin === 'remote') remoteTxn = txn;
      });
      ydoc.transact(() => {
        const text = new Y.Text();
        text.insert(0, 'stale remote');
        pathToId.set('recover-fails.md', 'file-recover-fails');
        idToPath.set('file-recover-fails', 'recover-fails.md');
        docs.set('file-recover-fails', text);
        tombstones.set('recover-fails.md', { deletedAt: new Date().toISOString() });
      }, 'remote');

      self.handleRemoteTransactionSideEffects(remoteTxn!);
      await expect(self.completeInitialSync()).rejects.toThrow('disk import failed');

      expect(tombstones.has('recover-fails.md')).toBe(true);
      expect(docs.get(pathToId.get('recover-fails.md')!)?.toString()).toBe('stale remote');
      await expect(plugin.app.vault.read(plugin.app.vault.getFileByPath('recover-fails.md')!)).resolves.toBe('local recovery');
    });

    it('releases quarantine for authoritative startup tombstone when remote later restores the file', async () => {
      const plugin = new MockPlugin();
      const cacheDoc = new Y.Doc();
      const cachePathToId = cacheDoc.getMap('pathToId') as Y.Map<string>;
      const cacheIdToPath = cacheDoc.getMap('idToPath') as Y.Map<string>;
      const cacheDocs = cacheDoc.getMap('docs') as Y.Map<Y.Text>;
      const cacheTombstones = cacheDoc.getMap('fileTombstones') as Y.Map<FileTombstone>;
      const text = new Y.Text();
      text.insert(0, 'deleted snapshot');
      cachePathToId.set('restored.md', 'file-restored');
      cacheIdToPath.set('file-restored', 'restored.md');
      cacheDocs.set('file-restored', text);
      cacheTombstones.set('restored.md', { deletedAt: new Date().toISOString() });

      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const self = engine as unknown as {
        cache: { clearLegacyVaultOnlyKey: () => Promise<boolean>; load: () => Promise<{ vaultId: string; ydocUpdate: Uint8Array; updatedAt: string }>; save: () => Promise<void> };
        client: { connect: () => Promise<void>; onMessage: () => void; onStatusChange: () => void; send: () => Promise<void>; disconnect: () => Promise<void> };
        runBlobMaintenance: () => Promise<void>;
        completeInitialSync: () => Promise<void>;
        handleRemoteTransactionSideEffects: (txn: Y.Transaction) => void;
        bridge: ObsidianFilesystemBridge;
      };
      self.cache = {
        clearLegacyVaultOnlyKey: async () => false,
        load: async () => ({ vaultId: 'primary', ydocUpdate: Y.encodeStateAsUpdate(cacheDoc), updatedAt: new Date().toISOString() }),
        save: async () => {},
      };
      self.client = { connect: async () => {}, onMessage: () => {}, onStatusChange: () => {}, send: async () => {}, disconnect: async () => {} };
      self.runBlobMaintenance = async () => {};

      await engine.start();
      await self.completeInitialSync();
      expect((self.bridge as unknown as { remoteFlushQuarantine: Set<string> }).remoteFlushQuarantine.has('restored.md')).toBe(false);
      const { ydoc, docs, tombstones } = internals(engine);
      let remoteTxn: Y.Transaction | null = null;
      ydoc.on('afterTransaction', (txn) => {
        if (txn.origin === 'remote') remoteTxn = txn;
      });
      ydoc.transact(() => {
        tombstones.delete('restored.md');
        docs.get('file-restored')!.delete(0, docs.get('file-restored')!.length);
        docs.get('file-restored')!.insert(0, 'remote restored');
      }, 'remote');

      self.handleRemoteTransactionSideEffects(remoteTxn!);
      await flushPromises();

      expect(plugin.app.vault.getFileByPath('restored.md')).not.toBeNull();
      await expect(plugin.app.vault.read(plugin.app.vault.getFileByPath('restored.md')!)).resolves.toBe('remote restored');
      await engine.stop();
    });

    it('keeps read-only cached startup tombstone authoritative and deletes local copy', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('Shared/deleted.md', 'read only local copy');
      const cacheDoc = new Y.Doc();
      (cacheDoc.getMap('pathToId') as Y.Map<string>).set('deleted.md', 'file-deleted');
      (cacheDoc.getMap('idToPath') as Y.Map<string>).set('file-deleted', 'deleted.md');
      const text = new Y.Text();
      text.insert(0, 'remote stale');
      (cacheDoc.getMap('docs') as Y.Map<Y.Text>).set('file-deleted', text);
      (cacheDoc.getMap('fileTombstones') as Y.Map<FileTombstone>).set('deleted.md', { deletedAt: new Date().toISOString() });
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), readOnlyMount);
      const self = engine as unknown as {
        cache: { clearLegacyVaultOnlyKey: () => Promise<boolean>; load: () => Promise<{ vaultId: string; ydocUpdate: Uint8Array; updatedAt: string }>; save: () => Promise<void> };
        client: { connect: () => Promise<void>; onMessage: () => void; onStatusChange: () => void; send: () => Promise<void>; disconnect: () => Promise<void> };
        runBlobMaintenance: () => Promise<void>;
        completeInitialSync: () => Promise<void>;
      };
      self.cache = {
        clearLegacyVaultOnlyKey: async () => false,
        load: async () => ({ vaultId: 'shared1', ydocUpdate: Y.encodeStateAsUpdate(cacheDoc), updatedAt: new Date().toISOString() }),
        save: async () => {},
      };
      self.client = { connect: async () => {}, onMessage: () => {}, onStatusChange: () => {}, send: async () => {}, disconnect: async () => {} };
      self.runBlobMaintenance = async () => {};
      const deleteSpy = vi.spyOn(plugin.app.vault, 'delete');

      await engine.start();
      await self.completeInitialSync();
      await flushPromises();

      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(plugin.app.vault.getFileByPath('Shared/deleted.md')).toBeNull();
      expect(internals(engine).tombstones.has('deleted.md')).toBe(true);
      await engine.stop();
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

    it('records pending deletion when path is unknown', () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const { pendingLocalMarkdownDeletions, tombstones } = internals(engine);
      engine.handleLocalFileDeletion('ghost.md');
      expect(pendingLocalMarkdownDeletions.has('ghost.md')).toBe(true);
      expect(tombstones.size).toBe(0);
    });

    it('does not record pending deletion for unknown path after markdown delete gate is open', () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const self = engine as unknown as { remoteFileDeleteSideEffectsOpen: boolean };
      const { pendingLocalMarkdownDeletions, tombstones } = internals(engine);

      self.remoteFileDeleteSideEffectsOpen = true;
      engine.handleLocalFileDeletion('unknown.md');

      expect(pendingLocalMarkdownDeletions.has('unknown.md')).toBe(false);
      expect(tombstones.size).toBe(0);
    });
  });

  describe('tombstone provenance metadata', () => {
    it('local markdown tombstone includes deviceId, deviceName, vaultId, and deleteSource', () => {
      const settings = baseSettings();
      settings.deviceId = 'dev-abc-123';
      settings.deviceName = 'Test Device';
      const engine = new VaultSyncEngine(fakePlugin(), settings, null);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      const fileId = 'file-provenance-1';
      ydoc.transact(() => {
        pathToId.set('provenance.md', fileId);
        idToPath.set(fileId, 'provenance.md');
        docs.set(fileId, new Y.Text());
      });

      engine.handleLocalFileDeletion('provenance.md');

      expect(tombstones.has('provenance.md')).toBe(true);
      const ts = tombstones.get('provenance.md')!;
      expect(ts.deviceId).toBe('dev-abc-123');
      expect(ts.deviceName).toBe('Test Device');
      expect(ts.vaultId).toBe('primary');
      expect(ts.deleteSource).toBe('local-delete');
      expect(typeof ts.deletedAt).toBe('string');
    });

    it('mount engine tombstone carries mount vaultId, not primary vaultId', () => {
      const settings = baseSettings();
      settings.deviceId = 'dev-mount-1';
      const mount: SharedDirectoryMount = {
        localPath: 'Shared',
        vaultId: 'mount-vault-id',
        token: 't',
      };
      const engine = new VaultSyncEngine(fakePlugin(), settings, mount);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      const fileId = 'file-mount-1';
      ydoc.transact(() => {
        pathToId.set('test.md', fileId);
        idToPath.set(fileId, 'test.md');
        docs.set(fileId, new Y.Text());
      });

      engine.handleLocalFileDeletion('test.md');

      const ts = tombstones.get('test.md')!;
      expect(ts.vaultId).toBe('mount-vault-id');
      expect(ts.deleteSource).toBe('local-delete');
    });
  });

  describe('handleLocalFileRename', () => {
    async function setupRenameTestEngine() {
      const plugin = new MockPlugin();
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const self = engine as unknown as {
        cache: { load: () => Promise<null>; save: () => Promise<void>; clearLegacyVaultOnlyKey: () => Promise<boolean> };
        client: { connect: () => Promise<void>; onMessage: () => void; onStatusChange: () => void; send: () => Promise<void>; disconnect: () => Promise<void> };
        runBlobMaintenance: () => Promise<void>;
      };
      self.cache = {
        load: async () => null,
        save: async () => {},
        clearLegacyVaultOnlyKey: async () => false,
      };
      self.client = { connect: async () => {}, onMessage: () => {}, onStatusChange: () => {}, send: async () => {}, disconnect: async () => {} };
      self.runBlobMaintenance = async () => {};
      await engine.start();
      return { engine, plugin };
    }

    it('updates pathToId / idToPath keeping the same fileId', async () => {
      const engine = new VaultSyncEngine(fakePlugin(), baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs } = internals(engine);

      const fileId = 'file-1';
      ydoc.transact(() => {
        pathToId.set('a.md', fileId);
        idToPath.set(fileId, 'a.md');
        docs.set(fileId, new Y.Text());
      });

      await engine.handleLocalFileRename('a.md', 'b.md');

      expect(pathToId.get('a.md')).toBeUndefined();
      expect(pathToId.get('b.md')).toBe(fileId);
      expect(idToPath.get(fileId)).toBe('b.md');
    });

    it('removes replaced target fileId when renaming over an existing shared path', async () => {
      const { engine, plugin } = await setupRenameTestEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      const oldFileId = 'file-old';
      const replacedFileId = 'file-replaced';
      ydoc.transact(() => {
        pathToId.set('source.md', oldFileId);
        idToPath.set(oldFileId, 'source.md');
        const oldText = new Y.Text();
        oldText.insert(0, 'stale source content');
        docs.set(oldFileId, oldText);
        pathToId.set('target.md', replacedFileId);
        idToPath.set(replacedFileId, 'target.md');
        docs.set(replacedFileId, new Y.Text());
        tombstones.set('target.md', { deletedAt: new Date().toISOString() });
      });
      plugin.app.vault.seedText('target.md', 'renamed disk content');

      await engine.handleLocalFileRename('source.md', 'target.md');

      expect(pathToId.get('target.md')).toBe(oldFileId);
      expect(idToPath.get(oldFileId)).toBe('target.md');
      expect(docs.get(oldFileId)?.toString()).toBe('renamed disk content');
      expect(idToPath.has(replacedFileId)).toBe(false);
      expect(docs.has(replacedFileId)).toBe(false);
      expect(tombstones.has('target.md')).toBe(false);

      await engine.stop();
    });

    it('keeps tombstone if renaming over a tombstoned target fails to import disk content', async () => {
      const { engine, plugin } = await setupRenameTestEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);
      const self = engine as unknown as { bridge: ObsidianFilesystemBridge };

      const oldFileId = 'file-old-fail';
      ydoc.transact(() => {
        pathToId.set('source-fail.md', oldFileId);
        idToPath.set(oldFileId, 'source-fail.md');
        const oldText = new Y.Text();
        oldText.insert(0, 'stale source content');
        docs.set(oldFileId, oldText);
        tombstones.set('target-fail.md', { deletedAt: new Date().toISOString() });
      });
      plugin.app.vault.seedText('target-fail.md', 'renamed disk content');
      vi.spyOn(self.bridge, 'forceImportFromDisk').mockRejectedValueOnce(new Error('disk import failed'));

      await expect(engine.handleLocalFileRename('source-fail.md', 'target-fail.md')).rejects.toThrow('disk import failed');

      expect(tombstones.has('target-fail.md')).toBe(true);
      expect(docs.get(oldFileId)?.toString()).toBe('stale source content');

      await engine.stop();
    });

    it('clears tombstone when renaming an unknown local file onto an existing shared path', async () => {
      const { engine, plugin } = await setupRenameTestEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      const existingFileId = 'file-existing';
      ydoc.transact(() => {
        pathToId.set('target.md', existingFileId);
        idToPath.set(existingFileId, 'target.md');
        docs.set(existingFileId, new Y.Text());
        tombstones.set('target.md', { deletedAt: new Date().toISOString() });
      });
      plugin.app.vault.seedText('target.md', 'renamed local content');

      await engine.handleLocalFileRename('unknown.md', 'target.md');

      expect(pathToId.get('target.md')).toBe(existingFileId);
      expect(tombstones.has('target.md')).toBe(false);
      expect(docs.get(existingFileId)?.toString()).toBe('renamed local content');

      await engine.stop();
    });

    it('imports and clears pending deletion when a file is renamed back to that path', async () => {
      const { engine, plugin } = await setupRenameTestEngine();
      const { pathToId, docs, pendingLocalMarkdownDeletions } = internals(engine);

      engine.handleLocalFileDeletion('restored-by-rename.md');
      expect(pendingLocalMarkdownDeletions.has('restored-by-rename.md')).toBe(true);

      plugin.app.vault.seedText('restored-by-rename.md', 'renamed content');
      await engine.handleLocalFileRename('tmp.md', 'restored-by-rename.md');

      expect(pendingLocalMarkdownDeletions.has('restored-by-rename.md')).toBe(false);
      expect(pathToId.has('restored-by-rename.md')).toBe(true);
      expect(docs.get(pathToId.get('restored-by-rename.md')!)?.toString()).toBe('renamed content');

      await engine.stop();
    });

    it('keeps pending deletion if rename target is not visible on disk yet', async () => {
      const { engine } = await setupRenameTestEngine();
      const { pendingLocalMarkdownDeletions, tombstones } = internals(engine);

      engine.handleLocalFileDeletion('rename-not-visible.md');
      await engine.handleLocalFileRename('tmp.md', 'rename-not-visible.md');

      expect(pendingLocalMarkdownDeletions.has('rename-not-visible.md')).toBe(true);
      expect(tombstones.has('rename-not-visible.md')).toBe(false);

      await engine.stop();
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
            vault: {
              getMarkdownFiles: () => Array<{ path: string }>;
              getFileByPath: (path: string) => { path: string; stat: { size: number; mtime: number; ctime: number } } | null;
              getAbstractFileByPath: (path: string) => { path: string; stat: { size: number; mtime: number; ctime: number } } | null;
            };
          };
        };
      };
      // Stub out bridge (not initialized without start())
      const materialized = new Set(localFiles);
      self.bridge = {
        markDirty: () => {},
        drain: async () => {},
        flushFile: async (p) => {
          flushed?.push(p);
          materialized.add(p);
        },
      };
      // Stub vault to return only the startup scan's localFiles; flushFile can materialize files afterwards.
      self.plugin = {
        app: {
          vault: {
            getMarkdownFiles: () => localFiles.map((p) => ({ path: p })),
            getFileByPath: (p: string) => materialized.has(p) ? ({ path: p, stat: { size: 0, mtime: 0, ctime: 0 } }) : null,
            getAbstractFileByPath: (p: string) => materialized.has(p) ? ({ path: p, stat: { size: 0, mtime: 0, ctime: 0 } }) : null,
          },
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
      expect(tombstones.get('missing.md')?.deleteSource).toBe('reconcile-missing');
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

    it('defers tombstones when a partial local scan would delete many known markdown paths', async () => {
      const engine = setupForReconcile(['survivor.md']);
      const { ydoc, pathToId, idToPath, docs, tombstones, knownLocalMarkdownPaths } = internals(engine);
      ydoc.transact(() => {
        pathToId.set('survivor.md', 'file-survivor');
        idToPath.set('file-survivor', 'survivor.md');
        docs.set('file-survivor', new Y.Text());
        for (let i = 0; i < 25; i += 1) {
          const docPath = `missing-${i}.md`;
          const fileId = `file-missing-${i}`;
          pathToId.set(docPath, fileId);
          idToPath.set(fileId, docPath);
          docs.set(fileId, new Y.Text());
          knownLocalMarkdownPaths.add(docPath);
        }
      });

      await engine.reconcile();

      for (let i = 0; i < 25; i += 1) {
        const docPath = `missing-${i}.md`;
        expect(tombstones.has(docPath)).toBe(false);
        expect(pathToId.get(docPath)).toBe(`file-missing-${i}`);
      }
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

    it('does not remember remote-only markdown as local when initial materialization fails', async () => {
      const engine = setupForReconcile([]);
      const { ydoc, pathToId, idToPath, docs, tombstones, knownLocalMarkdownPaths } = internals(engine);
      const self = engine as unknown as {
        bridge: {
          markDirty: (p: string) => void;
          drain: () => Promise<void>;
          flushFile: (p: string) => Promise<void>;
        };
      };
      self.bridge = {
        markDirty: () => {},
        drain: async () => {},
        flushFile: async () => { throw new Error('disk unavailable'); },
      };

      const fid = 'file-remote-fails';
      ydoc.transact(() => {
        pathToId.set('remote-fails.md', fid);
        idToPath.set(fid, 'remote-fails.md');
        docs.set(fid, new Y.Text());
      });

      await engine.reconcile();

      expect(knownLocalMarkdownPaths.has('remote-fails.md')).toBe(false);
      expect(tombstones.has('remote-fails.md')).toBe(false);
      expect(pathToId.get('remote-fails.md')).toBe(fid);
    });

    it('does not remember remote-only markdown as local when materialization is skipped', async () => {
      const engine = setupForReconcile([]);
      const { ydoc, pathToId, idToPath, docs, tombstones, knownLocalMarkdownPaths } = internals(engine);
      const self = engine as unknown as {
        bridge: {
          markDirty: (p: string) => void;
          drain: () => Promise<void>;
          flushFile: (p: string) => Promise<void>;
        };
        plugin: {
          app: {
            vault: {
              getMarkdownFiles: () => Array<{ path: string }>;
              getFileByPath: (path: string) => TFile | null;
              getAbstractFileByPath: (path: string) => TFile | null;
            };
          };
        };
      };
      self.bridge = {
        markDirty: () => {},
        drain: async () => {},
        flushFile: async () => {},
      };
      self.plugin.app.vault.getFileByPath = () => null;
      self.plugin.app.vault.getAbstractFileByPath = () => null;

      const fid = 'file-remote-skipped';
      ydoc.transact(() => {
        pathToId.set('remote-skipped.md', fid);
        idToPath.set(fid, 'remote-skipped.md');
        docs.set(fid, new Y.Text());
      });

      await engine.reconcile();

      expect(knownLocalMarkdownPaths.has('remote-skipped.md')).toBe(false);
      expect(tombstones.has('remote-skipped.md')).toBe(false);
      expect(pathToId.get('remote-skipped.md')).toBe(fid);
    });

    it('converts startup pending deletion to tombstone before materializing remote markdown', async () => {
      const flushed: string[] = [];
      const engine = setupForReconcile([], flushed);
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      engine.handleLocalFileDeletion('deleted-before-baseline.md');

      const fid = 'file-late-remote';
      const text = new Y.Text();
      text.insert(0, 'remote baseline');
      ydoc.transact(() => {
        pathToId.set('deleted-before-baseline.md', fid);
        idToPath.set(fid, 'deleted-before-baseline.md');
        docs.set(fid, text);
      }, 'remote');

      await engine.reconcile();

      expect(tombstones.has('deleted-before-baseline.md')).toBe(true);
      expect(pathToId.has('deleted-before-baseline.md')).toBe(false);
      expect(idToPath.has(fid)).toBe(false);
      expect(docs.has(fid)).toBe(false);
      expect(flushed).not.toContain('deleted-before-baseline.md');
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

    it('read-only reconcile clears pending local markdown deletions', async () => {
      const flushed: string[] = [];
      const engine = setupReadOnlyForReconcile(flushed);
      const { pendingLocalMarkdownDeletions } = internals(engine);

      // Artificially add a pending deletion (shouldn't happen in practice for read-only)
      pendingLocalMarkdownDeletions.add('leaked.md');

      await engine.reconcile();

      expect(pendingLocalMarkdownDeletions.size).toBe(0);
    });

    it('preserves old tombstones because age alone cannot prove all devices observed deletes', async () => {
      const engine = setupForReconcile([]);
      const { ydoc, tombstones } = internals(engine);
      const blobTombstones = ydoc.getMap('blobTombstones') as Y.Map<{ hash: string; deletedAt: string }>;

      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      ydoc.transact(() => {
        tombstones.set('old.md', { deletedAt: oldDate });
        tombstones.set('recent.md', { deletedAt: recentDate });
        blobTombstones.set('old.png', { hash: 'abc', deletedAt: oldDate });
        blobTombstones.set('recent.png', { hash: 'def', deletedAt: recentDate });
      });

      await engine.reconcile();

      expect(tombstones.has('old.md')).toBe(true);
      expect(tombstones.has('recent.md')).toBe(true);
      expect(blobTombstones.has('old.png')).toBe(true);
      expect(blobTombstones.has('recent.png')).toBe(true);
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
        markdownDeleteGateState: string;
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
      return { engine, self, plugin };
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

      expect(self.bridge.deleteFile).toHaveBeenCalledWith('live.md', expect.any(Function));
      await engine.stop();
    });

    it('does not flush pending local markdown deletions while gate is blocked', async () => {
      const { engine, self } = await setupStartedEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      // User deletes a file before reconcile — no fileId yet, so it goes to pending
      engine.handleLocalFileDeletion('pending-del.md');
      expect(internals(engine).pendingLocalMarkdownDeletions.has('pending-del.md')).toBe(true);

      // Remote transaction arrives and creates the fileId for this path
      await self.handleAuthOk();
      const fid = 'file-pending';
      const text = new Y.Text();
      text.insert(0, 'remote content');
      ydoc.transact(() => {
        pathToId.set('pending-del.md', fid);
        idToPath.set(fid, 'pending-del.md');
        docs.set(fid, text);
      }, 'remote');

      // The pending deletion must NOT have been flushed by the remote transaction
      // (gate is startup-blocked → maintenance-blocked, not open)
      expect(tombstones.has('pending-del.md')).toBe(false);
      expect(internals(engine).pendingLocalMarkdownDeletions.has('pending-del.md')).toBe(true);

      await engine.stop();
    });

    it('flushes maintenance pending local markdown deletions when opening the gate', async () => {
      const { engine, self } = await setupStartedEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones, pendingLocalMarkdownDeletions } = internals(engine);

      engine.handleLocalFileDeletion('pending-during-maintenance.md');
      expect(pendingLocalMarkdownDeletions.has('pending-during-maintenance.md')).toBe(true);

      await self.handleAuthOk();
      let finishBlobMaintenance!: () => void;
      self.runBlobMaintenance = () => new Promise<void>((resolve) => {
        finishBlobMaintenance = resolve;
      });
      const initialSync = self.completeInitialSync();
      await flushPromises();
      expect(self.markdownDeleteGateState).toBe('maintenance-blocked');

      const fid = 'file-maintenance-pending';
      const text = new Y.Text();
      text.insert(0, 'remote content');
      ydoc.transact(() => {
        pathToId.set('pending-during-maintenance.md', fid);
        idToPath.set(fid, 'pending-during-maintenance.md');
        docs.set(fid, text);
      }, 'remote');

      expect(tombstones.has('pending-during-maintenance.md')).toBe(false);

      finishBlobMaintenance();
      await initialSync;

      expect(tombstones.has('pending-during-maintenance.md')).toBe(true);
      expect(pathToId.has('pending-during-maintenance.md')).toBe(false);
      expect(pendingLocalMarkdownDeletions.has('pending-during-maintenance.md')).toBe(false);

      await engine.stop();
    });

    it('does not tombstone pending local markdown deletion if file is restored before gate opens', async () => {
      const { engine, self, plugin } = await setupStartedEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones, pendingLocalMarkdownDeletions } = internals(engine);

      engine.handleLocalFileDeletion('restored-before-open.md');
      expect(pendingLocalMarkdownDeletions.has('restored-before-open.md')).toBe(true);

      await self.handleAuthOk();
      let finishBlobMaintenance!: () => void;
      self.runBlobMaintenance = () => new Promise<void>((resolve) => {
        finishBlobMaintenance = resolve;
      });
      const initialSync = self.completeInitialSync();
      await flushPromises();

      const fid = 'file-restored-before-open';
      const text = new Y.Text();
      text.insert(0, 'remote content');
      ydoc.transact(() => {
        pathToId.set('restored-before-open.md', fid);
        idToPath.set(fid, 'restored-before-open.md');
        docs.set(fid, text);
      }, 'remote');
      plugin.app.vault.seedText('restored-before-open.md', 'local restored');

      finishBlobMaintenance();
      await initialSync;

      expect(tombstones.has('restored-before-open.md')).toBe(false);
      expect(pathToId.has('restored-before-open.md')).toBe(true);
      expect(pendingLocalMarkdownDeletions.has('restored-before-open.md')).toBe(false);
      const file = plugin.app.vault.getFileByPath('restored-before-open.md')!;
      expect(await plugin.app.vault.read(file)).toBe('local restored');
      expect(docs.get(pathToId.get('restored-before-open.md')!)?.toString()).toBe('local restored');

      await engine.stop();
    });

    it('reconcile imports restored pending markdown before queued remote flush can overwrite it', async () => {
      const { engine, plugin } = await setupStartedEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones, pendingLocalMarkdownDeletions } = internals(engine);

      engine.handleLocalFileDeletion('restored-during-reconcile.md');
      expect(pendingLocalMarkdownDeletions.has('restored-during-reconcile.md')).toBe(true);

      const fid = 'file-restored-during-reconcile';
      const text = new Y.Text();
      text.insert(0, 'remote content');
      ydoc.transact(() => {
        pathToId.set('restored-during-reconcile.md', fid);
        idToPath.set(fid, 'restored-during-reconcile.md');
        docs.set(fid, text);
      }, 'remote');
      plugin.app.vault.seedText('restored-during-reconcile.md', 'local restored');

      await engine.reconcile();

      expect(tombstones.has('restored-during-reconcile.md')).toBe(false);
      expect(pathToId.has('restored-during-reconcile.md')).toBe(true);
      expect(pendingLocalMarkdownDeletions.has('restored-during-reconcile.md')).toBe(false);
      const file = plugin.app.vault.getFileByPath('restored-during-reconcile.md')!;
      expect(await plugin.app.vault.read(file)).toBe('local restored');
      expect(docs.get(pathToId.get('restored-during-reconcile.md')!)?.toString()).toBe('local restored');

      await engine.stop();
    });

    it('clears remote tombstone when pending markdown path is restored locally', async () => {
      const { engine, self, plugin } = await setupStartedEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones, pendingLocalMarkdownDeletions } = internals(engine);

      engine.handleLocalFileDeletion('restored-with-tombstone.md');
      expect(pendingLocalMarkdownDeletions.has('restored-with-tombstone.md')).toBe(true);

      const fid = 'file-restored-with-tombstone';
      const text = new Y.Text();
      text.insert(0, 'remote content');
      ydoc.transact(() => {
        pathToId.set('restored-with-tombstone.md', fid);
        idToPath.set(fid, 'restored-with-tombstone.md');
        docs.set(fid, text);
        tombstones.set('restored-with-tombstone.md', { deletedAt: new Date().toISOString() });
      }, 'remote');
      plugin.app.vault.seedText('restored-with-tombstone.md', 'local restored');

      await engine.reconcile();

      expect(tombstones.has('restored-with-tombstone.md')).toBe(false);
      expect(pathToId.has('restored-with-tombstone.md')).toBe(true);
      expect(pendingLocalMarkdownDeletions.has('restored-with-tombstone.md')).toBe(false);
      expect(docs.get(pathToId.get('restored-with-tombstone.md')!)?.toString()).toBe('local restored');

      await self.handleAuthOk();
      await self.completeInitialSync();
      expect(self.bridge.deleteFile).not.toHaveBeenCalled();
      expect(plugin.app.vault.getFileByPath('restored-with-tombstone.md')).not.toBeNull();

      await engine.stop();
    });

    it('clears remote tombstone when an existing shared markdown path changes locally', async () => {
      const { engine, self, plugin } = await setupStartedEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones } = internals(engine);

      const fid = 'file-local-change-restored';
      const text = new Y.Text();
      text.insert(0, 'remote content');
      ydoc.transact(() => {
        pathToId.set('local-change-restored.md', fid);
        idToPath.set(fid, 'local-change-restored.md');
        docs.set(fid, text);
        tombstones.set('local-change-restored.md', { deletedAt: new Date().toISOString() });
      }, 'remote');
      plugin.app.vault.seedText('local-change-restored.md', 'local restored');

      await engine.handleLocalFileChange('local-change-restored.md');

      expect(tombstones.has('local-change-restored.md')).toBe(false);
      expect(pathToId.has('local-change-restored.md')).toBe(true);
      expect(docs.get(pathToId.get('local-change-restored.md')!)?.toString()).toBe('local restored');

      await self.handleAuthOk();
      await self.completeInitialSync();
      expect(self.bridge.deleteFile).not.toHaveBeenCalled();
      expect(plugin.app.vault.getFileByPath('local-change-restored.md')).not.toBeNull();

      await engine.stop();
    });

    it('does not tombstone open-gate pending deletion when remote fileId arrives after local restore', async () => {
      const { engine, self, plugin } = await setupStartedEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones, pendingLocalMarkdownDeletions } = internals(engine);

      engine.handleLocalFileDeletion('restored-while-open.md');
      await self.handleAuthOk();
      await self.completeInitialSync();
      expect(pendingLocalMarkdownDeletions.has('restored-while-open.md')).toBe(true);

      plugin.app.vault.seedText('restored-while-open.md', 'local restored');
      const fid = 'file-restored-while-open';
      const text = new Y.Text();
      text.insert(0, 'remote content');
      ydoc.transact(() => {
        pathToId.set('restored-while-open.md', fid);
        idToPath.set(fid, 'restored-while-open.md');
        docs.set(fid, text);
      }, 'remote');
      await flushPromises();

      expect(tombstones.has('restored-while-open.md')).toBe(false);
      expect(pathToId.has('restored-while-open.md')).toBe(true);
      expect(pendingLocalMarkdownDeletions.has('restored-while-open.md')).toBe(false);
      const file = plugin.app.vault.getFileByPath('restored-while-open.md')!;
      expect(await plugin.app.vault.read(file)).toBe('local restored');
      expect(docs.get(pathToId.get('restored-while-open.md')!)?.toString()).toBe('local restored');

      await engine.stop();
    });

    it('does not open markdown delete gate or flush pending when reconnect maintenance fails', async () => {
      const { engine, self } = await setupStartedEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones, pendingLocalMarkdownDeletions } = internals(engine);

      await self.handleAuthOk();
      await self.completeInitialSync();

      const fid = 'file-reconnect-fail';
      const text = new Y.Text();
      text.insert(0, 'remote content');
      ydoc.transact(() => {
        pathToId.set('pending-reconnect-fail.md', fid);
        idToPath.set(fid, 'pending-reconnect-fail.md');
        docs.set(fid, text);
      });
      pendingLocalMarkdownDeletions.add('pending-reconnect-fail.md');
      vi.spyOn(engine, 'reconcile').mockRejectedValueOnce(new Error('reconnect failed'));

      await expect(self.handleAuthOk()).rejects.toThrow('reconnect failed');

      expect(self.markdownDeleteGateState).toBe('maintenance-blocked');
      expect(tombstones.has('pending-reconnect-fail.md')).toBe(false);
      expect(pendingLocalMarkdownDeletions.has('pending-reconnect-fail.md')).toBe(true);

      await engine.stop();
    });

    it('flushes pending local markdown deletions when gate is open', async () => {
      const { engine, self } = await setupStartedEngine();
      const { ydoc, pathToId, idToPath, docs, tombstones, pendingLocalMarkdownDeletions } = internals(engine);

      // Add a pending deletion while gate is startup-blocked (before reconcile)
      engine.handleLocalFileDeletion('pending-flush.md');
      expect(pendingLocalMarkdownDeletions.has('pending-flush.md')).toBe(true);

      // Complete initial sync — reconcile will try to flush but 'pending-flush.md'
      // still has no fileId so it stays in pending
      await self.handleAuthOk();
      await self.completeInitialSync();
      // Gate is now open; pending is still there (no fileId to write tombstone for)
      expect(pendingLocalMarkdownDeletions.has('pending-flush.md')).toBe(true);

      // A remote transaction arrives and provides the fileId
      const fid = 'file-late';
      const text = new Y.Text();
      text.insert(0, 'content');
      ydoc.transact(() => {
        pathToId.set('pending-flush.md', fid);
        idToPath.set(fid, 'pending-flush.md');
        docs.set(fid, text);
      }, 'remote');

      // Gate is open, so the pending deletion should now be flushed
      expect(tombstones.has('pending-flush.md')).toBe(true);
      expect(pathToId.has('pending-flush.md')).toBe(false);

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
        awareness: { destroy: () => void; on: () => void; setLocalStateField: () => void };
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
      const { ydoc, knownLocalMarkdownPaths, pendingLocalMarkdownDeletions, pathToId, idToPath, docs, tombstones } = internals(engine);
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
          plugin.app.vault.seedText(path, 'restored content');
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
      pendingLocalMarkdownDeletions.add('restored.md');

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
        new Response(payload as BodyInit, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
      );

      await engine.restoreSnapshot('snap-1');

      expect(knownLocalMarkdownPaths.has('restored.md')).toBe(true);
      expect(knownLocalMarkdownPaths.has('old.md')).toBe(false);
      expect(pendingLocalMarkdownDeletions.has('restored.md')).toBe(false);
      expect(pathToId.has('old.md')).toBe(false);
      const restoredFileId = pathToId.get('restored.md');
      expect(restoredFileId).toBeDefined();
      expect(docs.get(restoredFileId!)?.toString()).toBe('restored content');
      expect(tombstones.has('old.md')).toBe(true);
      expect(deleted).toEqual(['old.md']);
      expect(flushed).toEqual(['restored.md']);
    });

    it('does not remember restored markdown as local when snapshot materialization fails to create a file', async () => {
      const plugin = new MockPlugin();
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { knownLocalMarkdownPaths, pathToId, docs, tombstones } = internals(engine);
      const self = engine as unknown as {
        bridge: { deleteFile: (path: string) => Promise<void>; flushFile: (path: string) => Promise<void> };
        blobSync: { deleteLocalBlob: (path: string) => Promise<void>; materializeBlob: (path: string) => Promise<void> };
        bindAllOpenEditors: () => void;
        validateAllOpenBindings: () => void;
      };
      const flushed: string[] = [];
      self.bridge = {
        deleteFile: async () => {},
        flushFile: async (path) => { flushed.push(path); },
      };
      self.blobSync = {
        deleteLocalBlob: async () => {},
        materializeBlob: async () => {},
      };
      self.bindAllOpenEditors = () => {};
      self.validateAllOpenBindings = () => {};

      const snapDoc = new Y.Doc();
      (snapDoc.getMap('pathToId') as Y.Map<string>).set('not-written.md', 'file-not-written');
      (snapDoc.getMap('idToPath') as Y.Map<string>).set('file-not-written', 'not-written.md');
      const restoredText = new Y.Text();
      restoredText.insert(0, 'restored content');
      (snapDoc.getMap('docs') as Y.Map<Y.Text>).set('file-not-written', restoredText);
      const payload = Y.encodeStateAsUpdate(snapDoc);
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValue(
        new Response(payload as BodyInit, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
      );

      await engine.restoreSnapshot('snap-failed-materialize');

      expect(flushed).toEqual(['not-written.md']);
      expect(plugin.app.vault.getFileByPath('not-written.md')).toBeNull();
      expect(knownLocalMarkdownPaths.has('not-written.md')).toBe(false);
      expect(tombstones.has('not-written.md')).toBe(false);
      const restoredFileId = pathToId.get('not-written.md');
      expect(restoredFileId).toBeDefined();
      expect(docs.get(restoredFileId!)?.toString()).toBe('restored content');
    });
  });

  describe('markdown pending persistence', () => {
    it('restores known local markdown paths and tombstones restart-missing files', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('other.md', 'other content');
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs, tombstones, knownLocalMarkdownPaths } = internals(engine);
      const flushed: string[] = [];
      const self = engine as unknown as {
        bridge: {
          markDirty: (path: string) => void;
          drain: () => Promise<void>;
          flushFile: (path: string) => Promise<void>;
        };
        markdownPendingStore: {
          load: () => Promise<{ pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[] } | null>;
          save: (_key: string, state: { pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[] }) => Promise<void>;
        };
        restoreMarkdownPending: () => Promise<void>;
      };

      self.bridge = {
        markDirty: () => {},
        drain: async () => {},
        flushFile: async (path) => { flushed.push(path); },
      };
      self.markdownPendingStore = {
        load: async () => ({
          pendingLocalDeletions: [],
          knownLocalMarkdownPaths: ['missing-after-restart.md'],
          vaultId: 'test',
          updatedAt: '',
        }),
        save: vi.fn(async () => {}),
      };
      const fid = 'file-missing-after-restart';
      ydoc.transact(() => {
        pathToId.set('missing-after-restart.md', fid);
        idToPath.set(fid, 'missing-after-restart.md');
        docs.set(fid, new Y.Text());
      });

      await self.restoreMarkdownPending();
      await engine.reconcile();

      expect(knownLocalMarkdownPaths.has('missing-after-restart.md')).toBe(false);
      expect(tombstones.has('missing-after-restart.md')).toBe(true);
      expect(tombstones.get('missing-after-restart.md')?.deleteSource).toBe('reconcile-missing');
      expect(pathToId.has('missing-after-restart.md')).toBe(false);
      expect(flushed).not.toContain('missing-after-restart.md');
    });

    it('tombstones restart-missing markdown when the local markdown scan is empty', async () => {
      const plugin = new MockPlugin();
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs, tombstones, knownLocalMarkdownPaths } = internals(engine);
      const self = engine as unknown as {
        bridge: {
          markDirty: (path: string) => void;
          drain: () => Promise<void>;
          flushFile: (path: string) => Promise<void>;
        };
        markdownPendingStore: {
          load: () => Promise<{ pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[] } | null>;
          save: (_key: string, state: { pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[] }) => Promise<void>;
        };
        restoreMarkdownPending: () => Promise<void>;
      };
      self.bridge = {
        markDirty: () => {},
        drain: async () => {},
        flushFile: async () => {},
      };
      self.markdownPendingStore = {
        load: async () => ({
          pendingLocalDeletions: [],
          knownLocalMarkdownPaths: ['missing-while-empty.md'],
          vaultId: 'test',
          updatedAt: '',
        }),
        save: vi.fn(async () => {}),
      };
      const fid = 'file-missing-while-empty';
      ydoc.transact(() => {
        pathToId.set('missing-while-empty.md', fid);
        idToPath.set(fid, 'missing-while-empty.md');
        docs.set(fid, new Y.Text());
      });

      await self.restoreMarkdownPending();
      await engine.reconcile();

      expect(knownLocalMarkdownPaths.has('missing-while-empty.md')).toBe(false);
      expect(tombstones.has('missing-while-empty.md')).toBe(true);
      expect(tombstones.get('missing-while-empty.md')?.deleteSource).toBe('reconcile-missing');
      expect(pathToId.has('missing-while-empty.md')).toBe(false);
    });

    it('tombstones restart-missing markdown when an empty scan deleted many known markdown paths', async () => {
      const plugin = new MockPlugin();
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs, tombstones, knownLocalMarkdownPaths } = internals(engine);
      const self = engine as unknown as {
        bridge: {
          markDirty: (path: string) => void;
          drain: () => Promise<void>;
          flushFile: (path: string) => Promise<void>;
        };
        markdownPendingStore: {
          load: () => Promise<{ pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[] } | null>;
          save: (_key: string, state: { pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[] }) => Promise<void>;
        };
        restoreMarkdownPending: () => Promise<void>;
      };
      const knownPaths = Array.from({ length: 25 }, (_, index) => `missing-while-empty-${index}.md`);
      self.bridge = {
        markDirty: () => {},
        drain: async () => {},
        flushFile: async () => {},
      };
      self.markdownPendingStore = {
        load: async () => ({
          pendingLocalDeletions: [],
          knownLocalMarkdownPaths: knownPaths,
          vaultId: 'test',
          updatedAt: '',
        }),
        save: vi.fn(async () => {}),
      };
      ydoc.transact(() => {
        for (const docPath of knownPaths) {
          const fileId = `file-${docPath}`;
          pathToId.set(docPath, fileId);
          idToPath.set(fileId, docPath);
          docs.set(fileId, new Y.Text());
        }
      });

      await self.restoreMarkdownPending();
      await engine.reconcile();

      for (const docPath of knownPaths) {
        expect(knownLocalMarkdownPaths.has(docPath)).toBe(false);
        expect(tombstones.has(docPath)).toBe(true);
        expect(tombstones.get(docPath)?.deleteSource).toBe('reconcile-missing');
        expect(pathToId.has(docPath)).toBe(false);
      }
    });

    it('defers restart-missing tombstones when the shared mount root is missing', async () => {
      const plugin = new MockPlugin();
      const mount: SharedDirectoryMount = {
        localPath: 'Shared',
        vaultId: 'shared-vault',
        token: 'shared-token',
      };
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), mount);
      const { ydoc, pathToId, idToPath, docs, tombstones, knownLocalMarkdownPaths } = internals(engine);
      const self = engine as unknown as {
        bridge: {
          markDirty: (path: string) => void;
          drain: () => Promise<void>;
          flushFile: (path: string) => Promise<void>;
        };
        markdownPendingStore: {
          load: () => Promise<{ pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[]; localPath?: string } | null>;
          save: (_key: string, state: { pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[]; localPath?: string }) => Promise<void>;
        };
        restoreMarkdownPending: () => Promise<void>;
      };
      const knownPaths = Array.from({ length: 25 }, (_, index) => `missing-mount-${index}.md`);
      self.bridge = {
        markDirty: () => {},
        drain: async () => {},
        flushFile: async () => {},
      };
      self.markdownPendingStore = {
        load: async () => ({
          pendingLocalDeletions: [],
          knownLocalMarkdownPaths: knownPaths,
          localPath: 'Shared',
          vaultId: 'test',
          updatedAt: '',
        }),
        save: vi.fn(async () => {}),
      };
      ydoc.transact(() => {
        for (const docPath of knownPaths) {
          const fileId = `file-${docPath}`;
          pathToId.set(docPath, fileId);
          idToPath.set(fileId, docPath);
          docs.set(fileId, new Y.Text());
        }
      });

      await self.restoreMarkdownPending();
      await engine.reconcile();

      for (const docPath of knownPaths) {
        expect(knownLocalMarkdownPaths.has(docPath)).toBe(true);
        expect(tombstones.has(docPath)).toBe(false);
        expect(pathToId.has(docPath)).toBe(true);
      }
    });

    it('does not restore known local markdown paths from a different shared mount localPath', async () => {
      const plugin = new MockPlugin();
      const mount: SharedDirectoryMount = {
        localPath: 'NewShared',
        vaultId: 'shared-vault',
        token: 'shared-token',
      };
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), mount);
      const { ydoc, pathToId, idToPath, docs, tombstones, knownLocalMarkdownPaths } = internals(engine);
      const flushed: string[] = [];
      const self = engine as unknown as {
        bridge: {
          markDirty: (path: string) => void;
          drain: () => Promise<void>;
          flushFile: (path: string) => Promise<void>;
        };
        markdownPendingStore: {
          load: () => Promise<{ pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[]; localPath?: string } | null>;
          save: (_key: string, state: { pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[]; localPath?: string }) => Promise<void>;
        };
        restoreMarkdownPending: () => Promise<void>;
      };

      self.bridge = {
        markDirty: () => {},
        drain: async () => {},
        flushFile: async (path) => {
          flushed.push(path);
          plugin.app.vault.seedText(`NewShared/${path}`, 'remote content');
        },
      };
      self.markdownPendingStore = {
        load: async () => ({
          pendingLocalDeletions: [],
          knownLocalMarkdownPaths: ['old-mount.md'],
          localPath: 'OldShared',
          vaultId: 'test',
          updatedAt: '',
        }),
        save: vi.fn(async () => {}),
      };
      const fid = 'file-old-mount';
      ydoc.transact(() => {
        pathToId.set('old-mount.md', fid);
        idToPath.set(fid, 'old-mount.md');
        docs.set(fid, new Y.Text());
      });

      await self.restoreMarkdownPending();
      await engine.reconcile();

      expect(knownLocalMarkdownPaths.has('old-mount.md')).toBe(true);
      expect(tombstones.has('old-mount.md')).toBe(false);
      expect(pathToId.get('old-mount.md')).toBe(fid);
      expect(flushed).toEqual(['old-mount.md']);
    });

    it('persists local delete cleanup after tombstone commit removes known path', async () => {
      const plugin = new MockPlugin();
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { ydoc, pathToId, idToPath, docs, tombstones, knownLocalMarkdownPaths } = internals(engine);
      const savedStates: Array<{ pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[] }> = [];
      const self = engine as unknown as {
        markdownPendingStore: {
          load: () => Promise<{ pendingLocalDeletions: string[] } | null>;
          save: (_key: string, state: { pendingLocalDeletions: string[]; knownLocalMarkdownPaths?: string[] }) => Promise<void>;
        };
        cache: { save: () => Promise<void> };
        flushCacheSave: () => Promise<void>;
      };
      const fid = 'file-delete-known';
      ydoc.transact(() => {
        pathToId.set('delete-known.md', fid);
        idToPath.set(fid, 'delete-known.md');
        docs.set(fid, new Y.Text());
      });
      knownLocalMarkdownPaths.add('delete-known.md');
      self.cache = { save: vi.fn(async () => {}) };
      self.markdownPendingStore = {
        load: async () => ({ pendingLocalDeletions: [], vaultId: 'test', updatedAt: '' }),
        save: vi.fn(async (_key, state) => { savedStates.push(state); }),
      };

      engine.handleLocalFileDeletion('delete-known.md');
      await self.flushCacheSave();

      expect(tombstones.has('delete-known.md')).toBe(true);
      expect(knownLocalMarkdownPaths.has('delete-known.md')).toBe(false);
      expect(savedStates.at(-1)?.knownLocalMarkdownPaths).not.toContain('delete-known.md');
    });

    it('pending local markdown deletions survive engine restart via markdownPendingStore', async () => {
      const plugin = new MockPlugin();
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { pendingLocalMarkdownDeletions } = internals(engine);
      const self = engine as unknown as {
        markdownPendingStore: {
          load: () => Promise<{ pendingLocalDeletions: string[] } | null>;
          save: (_key: string, state: { pendingLocalDeletions: string[] }) => Promise<void>;
        };
        restoreMarkdownPending: () => Promise<void>;
      };

      // Simulate prior session: store has a pending deletion
      self.markdownPendingStore = {
        load: async () => ({ pendingLocalDeletions: ['orphan.md'], vaultId: 'test', updatedAt: '' }),
        save: vi.fn(async () => {}),
      };

      await self.restoreMarkdownPending();

      expect(pendingLocalMarkdownDeletions.has('orphan.md')).toBe(true);
    });

    it('restored pending skips paths that exist on disk', async () => {
      const plugin = new MockPlugin();
      plugin.app.vault.seedText('recovered.md', 'back');
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { pendingLocalMarkdownDeletions } = internals(engine);
      const self = engine as unknown as {
        markdownPendingStore: {
          load: () => Promise<{ pendingLocalDeletions: string[] } | null>;
          save: (_key: string, state: { pendingLocalDeletions: string[] }) => Promise<void>;
        };
        restoreMarkdownPending: () => Promise<void>;
      };

      self.markdownPendingStore = {
        load: async () => ({ pendingLocalDeletions: ['recovered.md'], vaultId: 'test', updatedAt: '' }),
        save: vi.fn(async () => {}),
      };

      await self.restoreMarkdownPending();

      expect(pendingLocalMarkdownDeletions.has('recovered.md')).toBe(false);
    });

    it('restored pending skips paths with existing tombstones', async () => {
      const plugin = new MockPlugin();
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), null);
      const { tombstones, pendingLocalMarkdownDeletions } = internals(engine);
      tombstones.set('already-dead.md', { deletedAt: new Date().toISOString() });

      const self = engine as unknown as {
        markdownPendingStore: {
          load: () => Promise<{ pendingLocalDeletions: string[] } | null>;
          save: (_key: string, state: { pendingLocalDeletions: string[] }) => Promise<void>;
        };
        restoreMarkdownPending: () => Promise<void>;
      };

      self.markdownPendingStore = {
        load: async () => ({ pendingLocalDeletions: ['already-dead.md'], vaultId: 'test', updatedAt: '' }),
        save: vi.fn(async () => {}),
      };

      await self.restoreMarkdownPending();

      expect(pendingLocalMarkdownDeletions.has('already-dead.md')).toBe(false);
    });

    it('restored pending skips entries from a different shared mount localPath', async () => {
      const plugin = new MockPlugin();
      const mount: SharedDirectoryMount = {
        localPath: 'NewShared',
        vaultId: 'shared-vault',
        token: 'shared-token',
      };
      const engine = new VaultSyncEngine(plugin as unknown as Plugin, baseSettings(), mount);
      const { pendingLocalMarkdownDeletions } = internals(engine);
      const self = engine as unknown as {
        markdownPendingStore: {
          load: () => Promise<{ pendingLocalDeletions: string[]; localPath?: string } | null>;
          save: (_key: string, state: { pendingLocalDeletions: string[]; localPath?: string }) => Promise<void>;
        };
        restoreMarkdownPending: () => Promise<void>;
      };

      self.markdownPendingStore = {
        load: async () => ({ pendingLocalDeletions: ['old-path.md'], localPath: 'OldShared', vaultId: 'test', updatedAt: '' }),
        save: vi.fn(async () => {}),
      };

      await self.restoreMarkdownPending();

      expect(pendingLocalMarkdownDeletions.has('old-path.md')).toBe(false);
    });
  });
});
