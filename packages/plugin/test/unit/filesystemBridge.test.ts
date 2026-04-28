import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { MockVault } from '../mocks/obsidian';
import { ObsidianFilesystemBridge } from '../../src/sync/filesystemBridge';
import type { Vault } from 'obsidian';

function setup(options?: { isBindingHealthy?: (vaultPath: string) => boolean }) {
  const ydoc = new Y.Doc();
  const ytextByPath = new Map<string, Y.Text>();
  const getYText = (docPath: string): Y.Text | null => ytextByPath.get(docPath) ?? null;
  const vault = new MockVault();
  const bridge = new ObsidianFilesystemBridge(
    vault as unknown as Vault,
    getYText,
    ydoc,
    'primary',
    undefined,
    undefined,
    undefined,
    options?.isBindingHealthy,
  );
  return { ydoc, vault, bridge, ytextByPath };
}

describe('ObsidianFilesystemBridge', () => {
  it('drain imports disk content into Y.Text via fastDiff', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytextByPath.set('note.md', ytext);
    vault.seedText('note.md', 'hello');

    bridge.markDirty('note.md');
    await bridge.drain();

    expect(ytext.toString()).toBe('hello');
  });

  it('flushFile writes Y.Text content and records suppression fingerprint', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'from-ydoc');
    ytextByPath.set('note.md', ytext);

    await bridge.flushFile('note.md');

    const file = vault.getFileByPath('note.md')!;
    expect(await vault.read(file)).toBe('from-ydoc');
    // The just-written content must be flagged as self-write and suppressed
    expect(bridge.isSuppressed('note.md', 'from-ydoc')).toBe(true);
    // Non-matching content is not suppressed
    bridge.suppressExpectedWrite('note.md', { sha256: 'x', byteLength: 1 });
    expect(bridge.isSuppressed('note.md', 'something-else')).toBe(false);
  });

  it('deleteFile removes the file and flags expectedDelete', async () => {
    const { bridge, vault } = setup();
    vault.seedText('gone.md', 'bye');

    await bridge.deleteFile('gone.md');

    expect(vault.getFileByPath('gone.md')).toBeNull();
    // Echo suppression: the synthetic delete event should be recognized once.
    expect(bridge.isExpectedDelete('gone.md')).toBe(true);
    // And only once.
    expect(bridge.isExpectedDelete('gone.md')).toBe(false);
  });

  it('flushFile is serialized per path (writes do not interleave)', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'x');
    ytextByPath.set('n.md', ytext);

    const events: string[] = [];
    const origCreate = vault.create.bind(vault);
    const origModify = vault.modify.bind(vault);
    let tick = 0;
    vault.create = async (p, c) => {
      const id = ++tick;
      events.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, 10));
      const res = await origCreate(p, c);
      // After first write, change Y.Text so the second flush sees different content
      ytext.insert(ytext.length, 'y');
      events.push(`end:${id}`);
      return res;
    };
    vault.modify = async (f, c) => {
      const id = ++tick;
      events.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, 10));
      await origModify(f, c);
      events.push(`end:${id}`);
    };

    const p1 = bridge.flushFile('n.md');
    const p2 = bridge.flushFile('n.md');
    await Promise.all([p1, p2]);

    // start/end must alternate — never two starts in a row
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('tracks open files and flushes remote updates through per-file observers', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'hello');
    ytextByPath.set('open.md', ytext);
    vault.seedText('open.md', 'hello');

    bridge.notifyFileOpened('open.md');
    ydoc.transact(() => {
      ytext.insert(5, ' world');
    }, 'remote');

    await new Promise((r) => setTimeout(r, 600));

    const file = vault.getFileByPath('open.md')!;
    expect(await vault.read(file)).toBe('hello world');
  });

  it('flushes remote updates for closed files through afterTransaction routing', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'base');
    ytextByPath.set('closed.md', ytext);
    vault.seedText('closed.md', 'base');
    const docs = new Map<string, Y.Text>([['file-1', ytext]]);
    const idToPath = new Map<string, string>([['file-1', 'closed.md']]);

    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });

    ydoc.transact(() => {
      ytext.insert(4, ' updated');
    }, 'remote');

    bridge.handleRemoteTransaction(remoteTxn!, docs, idToPath, []);
    await new Promise((r) => setTimeout(r, 0));

    const file = vault.getFileByPath('closed.md')!;
    expect(await vault.read(file)).toBe('base updated');
  });

  it('defers disk import for open files when external edit policy is closed-only', async () => {
    const ydoc = new Y.Doc();
    const ytextByPath = new Map<string, Y.Text>();
    const getYText = (docPath: string): Y.Text | null => ytextByPath.get(docPath) ?? null;
    const vault = new MockVault();
    const bridge = new ObsidianFilesystemBridge(
      vault as unknown as Vault,
      getYText,
      ydoc,
      'primary',
      undefined,
      undefined,
      () => 'closed-only',
    );
    const ytext = ydoc.getText('f');
    ytextByPath.set('note.md', ytext);
    vault.seedText('note.md', 'from-disk');

    bridge.notifyFileOpened('note.md');
    bridge.markDirty('note.md');
    await bridge.drain();
    expect(ytext.toString()).toBe('');

    bridge.notifyFileClosed('note.md');
    await bridge.drain();
    expect(ytext.toString()).toBe('from-disk');
  });

  it('delays open-file remote writes when there was recent editor activity', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'hello');
    ytextByPath.set('note.md', ytext);
    vault.seedText('note.md', 'hello');

    bridge.notifyFileOpened('note.md');
    bridge.notifyEditorActivity('note.md');
    ydoc.transact(() => {
      ytext.insert(5, '!');
    }, 'remote');

    await new Promise((r) => setTimeout(r, 600));
    expect(await vault.read(vault.getFileByPath('note.md')!)).toBe('hello');

    await new Promise((r) => setTimeout(r, 1000));
    expect(await vault.read(vault.getFileByPath('note.md')!)).toBe('hello!');
  });

  it('schedules open write even when text observer is active (fallback path)', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'hello');
    ytextByPath.set('open.md', ytext);
    vault.seedText('open.md', 'hello');

    // notifyFileOpened attaches a textObserver
    bridge.notifyFileOpened('open.md');

    const docs = new Map<string, Y.Text>([['file-1', ytext]]);
    const idToPath = new Map<string, string>([['file-1', 'open.md']]);

    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });

    ydoc.transact(() => {
      ytext.insert(5, ' world');
    }, 'remote');

    // handleRemoteTransaction should schedule a write even with observer present
    bridge.handleRemoteTransaction(remoteTxn!, docs, idToPath, ['file-1']);

    // Wait for the open write delay to fire
    await new Promise((r) => setTimeout(r, 600));

    const file = vault.getFileByPath('open.md')!;
    expect(await vault.read(file)).toBe('hello world');
  });

  it('skips disk write in doFlushFile when content already matches', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'same');
    ytextByPath.set('note.md', ytext);
    vault.seedText('note.md', 'same');

    let modifyCalled = false;
    const origModify = vault.modify.bind(vault);
    vault.modify = async (file, content) => {
      modifyCalled = true;
      await origModify(file, content);
    };

    await bridge.flushFile('note.md');

    // vault.modify should NOT have been called since content matches
    expect(modifyCalled).toBe(false);
    // isSuppressed should NOT have been set since we skipped
    expect(bridge.isSuppressed('note.md', 'same')).toBe(false);
  });

  it('uses reduced delay when isBindingHealthy returns false', async () => {
    const ydoc = new Y.Doc();
    const ytextByPath = new Map<string, Y.Text>();
    const getYText = (docPath: string): Y.Text | null => ytextByPath.get(docPath) ?? null;
    const vault = new MockVault();
    const bridge = new ObsidianFilesystemBridge(
      vault as unknown as Vault,
      getYText,
      ydoc,
      'primary',
      undefined,
      undefined,
      undefined,
      () => false, // binding always unhealthy
    );
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'hello');
    ytextByPath.set('note.md', ytext);
    vault.seedText('note.md', 'hello');

    bridge.notifyFileOpened('note.md');

    ydoc.transact(() => {
      ytext.insert(5, '!');
    }, 'remote');

    // With unhealthy binding, delay should be 150ms — content should arrive
    // well before the normal 500ms timeout.
    await new Promise((r) => setTimeout(r, 250));
    expect(await vault.read(vault.getFileByPath('note.md')!)).toBe('hello!');
  });

  it('calls onExternalDeletion callback when importFromDisk finds file missing', async () => {
    const externallyDeleted: string[] = [];
    const ydoc = new Y.Doc();
    const ytextByPath = new Map<string, Y.Text>();
    const getYText = (docPath: string): Y.Text | null => ytextByPath.get(docPath) ?? null;
    const vault = new MockVault();
    const bridge = new ObsidianFilesystemBridge(
      vault as unknown as Vault,
      getYText,
      ydoc,
      'primary',
      undefined,
      undefined,
      undefined,
      undefined,
      (docPath) => externallyDeleted.push(docPath),
    );
    // Register path in the shared model so importFromDisk runs
    const ytext = ydoc.getText('f');
    ytextByPath.set('deleted.md', ytext);
    // Do NOT seed the vault — file does not exist on disk

    bridge.markDirty('deleted.md');
    await bridge.drain();

    expect(externallyDeleted).toContain('deleted.md');
  });

  it('does not call onExternalDeletion when file exists on disk', async () => {
    const externallyDeleted: string[] = [];
    const ydoc = new Y.Doc();
    const ytextByPath = new Map<string, Y.Text>();
    const getYText = (docPath: string): Y.Text | null => ytextByPath.get(docPath) ?? null;
    const vault = new MockVault();
    const bridge = new ObsidianFilesystemBridge(
      vault as unknown as Vault,
      getYText,
      ydoc,
      'primary',
      undefined,
      undefined,
      undefined,
      undefined,
      (docPath) => externallyDeleted.push(docPath),
    );
    const ytext = ydoc.getText('f');
    ytextByPath.set('present.md', ytext);
    vault.seedText('present.md', 'content');

    bridge.markDirty('present.md');
    await bridge.drain();

    expect(externallyDeleted).not.toContain('present.md');
  });

  it('serializes importFromDisk with flushFile — concurrent operations do not race', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'remote-base');
    ytextByPath.set('race.md', ytext);
    vault.seedText('race.md', 'local-edit');

    // Start both operations concurrently:
    // 1. drain (importFromDisk) will read "local-edit" from disk → apply diff to Y.Text
    // 2. flushFile will write Y.Text ("remote-base") to disk
    // Without serialization, (2) could write disk before (1) reads, losing "local-edit".
    bridge.markDirty('race.md');
    const drainPromise = bridge.drain();
    const flushPromise = bridge.flushFile('race.md');

    await Promise.all([drainPromise, flushPromise]);

    // After serialized execution: importFromDisk runs first (drain was queued first),
    // reads "local-edit" from disk, applies diff to Y.Text. Then flushFile runs
    // and writes the merged Y.Text content back to disk.
    // The key assertion: "local-edit" content must have been imported into Y.Text
    // (not lost due to race).
    expect(ytext.toString()).toBe('local-edit');
  });

  it('importFromDisk cancels pending openWriteTimer to prevent stale flush', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup({
      isBindingHealthy: () => false,
    });
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'crdt-state');
    ytextByPath.set('note.md', ytext);
    vault.seedText('note.md', 'crdt-state');

    bridge.notifyFileOpened('note.md');

    // Trigger a remote update that schedules an openWriteTimer
    ydoc.transact(() => {
      ytext.insert(0, 'remote-');
    }, 'remote');

    // Now simulate a local disk edit arriving before the timer fires
    vault.seedText('note.md', 'local-disk-edit');
    bridge.markDirty('note.md');
    await bridge.drain();

    // importFromDisk should have cancelled the pending timer and imported
    // the local disk content into Y.Text
    expect(ytext.toString()).toBe('local-disk-edit');

    // Wait past the original timer — the stale flush should NOT have fired
    await new Promise((r) => setTimeout(r, 600));
    expect(await vault.read(vault.getFileByPath('note.md')!)).toBe('local-disk-edit');
  });

  it('quarantines remote flush side effects for selected closed doc paths until release', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'local-recovered');
    ytextByPath.set('startup.md', ytext);
    vault.seedText('startup.md', 'local-recovered');
    const docs = new Map<string, Y.Text>([['file-1', ytext]]);
    const idToPath = new Map<string, string>([['file-1', 'startup.md']]);

    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });

    bridge.quarantineRemoteFlushes(['startup.md']);
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, 'stale-remote');
    }, 'remote');

    bridge.handleRemoteTransaction(remoteTxn!, docs, idToPath, ['file-1']);
    await new Promise((r) => setTimeout(r, 0));

    expect(await vault.read(vault.getFileByPath('startup.md')!)).toBe('local-recovered');

    bridge.releaseRemoteFlushQuarantine(['startup.md']);
    ydoc.transact(() => {
      ytext.insert(ytext.length, '-future');
    }, 'remote');
    bridge.handleRemoteTransaction(remoteTxn!, docs, idToPath, ['file-1']);
    await new Promise((r) => setTimeout(r, 0));

    expect(await vault.read(vault.getFileByPath('startup.md')!)).toBe('stale-remote-future');
  });

  it('does not replay a closed-file flush that was already queued before quarantine', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'original');
    ytextByPath.set('queued.md', ytext);
    vault.seedText('queued.md', 'original');
    const docs = new Map<string, Y.Text>([['file-1', ytext]]);
    const idToPath = new Map<string, string>([['file-1', 'queued.md']]);

    const originalModify = vault.modify.bind(vault);
    let releaseFirstModify!: () => void;
    const firstModifyStarted = new Promise<void>((resolve) => {
      vault.modify = async (file, content) => {
        resolve();
        await new Promise<void>((release) => {
          releaseFirstModify = release;
        });
        await originalModify(file, content);
      };
    });

    ytext.delete(0, ytext.length);
    ytext.insert(0, 'first-remote');
    const firstFlush = bridge.flushFile('queued.md');
    await firstModifyStarted;

    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, 'queued-stale-remote');
    }, 'remote');
    bridge.handleRemoteTransaction(remoteTxn!, docs, idToPath, ['file-1']);

    bridge.quarantineRemoteFlushes(['queued.md']);
    releaseFirstModify();
    await firstFlush;
    await new Promise((r) => setTimeout(r, 0));

    expect(await vault.read(vault.getFileByPath('queued.md')!)).toBe('first-remote');
  });

  it('carries quarantine and write invalidation state across rename bookkeeping', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup();
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'local-recovered');
    ytextByPath.set('new.md', ytext);
    vault.seedText('new.md', 'local-recovered');
    const docs = new Map<string, Y.Text>([['file-1', ytext]]);
    const idToPath = new Map<string, string>([['file-1', 'new.md']]);

    bridge.quarantineRemoteFlushes(['old.md']);
    bridge.updatePathAfterRename('old.md', 'new.md');

    let remoteTxn: Y.Transaction | null = null;
    ydoc.on('afterTransaction', (txn) => {
      if (txn.origin === 'remote') remoteTxn = txn;
    });
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, 'stale-remote-after-rename');
    }, 'remote');
    bridge.handleRemoteTransaction(remoteTxn!, docs, idToPath, ['file-1']);
    await new Promise((r) => setTimeout(r, 0));

    expect(await vault.read(vault.getFileByPath('new.md')!)).toBe('local-recovered');
  });

  it('force-imports disk content even when normal open-file policy would defer', async () => {
    const ydoc = new Y.Doc();
    const ytextByPath = new Map<string, Y.Text>();
    const getYText = (docPath: string): Y.Text | null => ytextByPath.get(docPath) ?? null;
    const vault = new MockVault();
    const bridge = new ObsidianFilesystemBridge(
      vault as unknown as Vault,
      getYText,
      ydoc,
      'primary',
      undefined,
      undefined,
      () => 'closed-only',
      () => true,
    );
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'stale-remote');
    ytextByPath.set('open.md', ytext);
    vault.seedText('open.md', 'local-recovered');

    bridge.notifyFileOpened('open.md');
    bridge.markDirty('open.md');
    await bridge.drain();
    expect(ytext.toString()).toBe('stale-remote');

    await bridge.forceImportFromDisk('open.md');

    expect(ytext.toString()).toBe('local-recovered');
  });

  it('force-import invalidates pending open remote writes before quarantine release', async () => {
    const { bridge, vault, ytextByPath, ydoc } = setup({
      isBindingHealthy: () => false,
    });
    const ytext = ydoc.getText('f');
    ytext.insert(0, 'original');
    ytextByPath.set('open.md', ytext);
    vault.seedText('open.md', 'original');

    bridge.notifyFileOpened('open.md');
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, 'stale-remote');
    }, 'remote');

    bridge.quarantineRemoteFlushes(['open.md']);
    vault.seedText('open.md', 'local-recovered');
    await bridge.forceImportFromDisk('open.md');
    bridge.releaseRemoteFlushQuarantine(['open.md']);

    await new Promise((r) => setTimeout(r, 250));

    expect(ytext.toString()).toBe('local-recovered');
    expect(await vault.read(vault.getFileByPath('open.md')!)).toBe('local-recovered');
  });
});
