import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDocumentStore } from '../src/persistence/sqliteDocumentStore';
import { runMigrations } from '../src/persistence/migrations';
import { MAX_JOURNAL_ENTRIES } from '@salt-sync/shared';

function freshStore() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return { db, store: new SqliteDocumentStore(db) };
}

const vault = 'v1';

describe('SqliteDocumentStore', () => {
  describe('append/load round-trip', () => {
    it('appends deltas and loads them in seq order', async () => {
      const { store } = freshStore();
      const p1 = new Uint8Array([1, 2, 3]);
      const p2 = new Uint8Array([4, 5]);

      const r1 = await store.appendDelta({ vaultId: vault, payload: p1 });
      const r2 = await store.appendDelta({ vaultId: vault, payload: p2 });

      expect(r1.seq).toBe(0);
      expect(r2.seq).toBe(1);
      expect(r2.entryCount).toBe(2);
      expect(r2.totalBytes).toBe(5);

      const loaded = await store.load(vault);
      expect(loaded.checkpoint).toBeNull();
      expect(loaded.deltas).toHaveLength(2);
      expect(loaded.deltas[0].payload).toEqual(p1);
      expect(loaded.deltas[1].payload).toEqual(p2);
      expect(loaded.meta?.nextSeq).toBe(2);
    });

    it('enforces expectedNextSeq', async () => {
      const { store } = freshStore();
      await store.appendDelta({ vaultId: vault, payload: new Uint8Array([1]) });
      expect(() =>
        store.appendDelta({
          vaultId: vault,
          payload: new Uint8Array([2]),
          expectedNextSeq: 99,
        }),
      ).toThrow(/Seq mismatch/);
    });
  });

  describe('SHA-256 mismatch detection', () => {
    it('throws when journal payload is tampered', async () => {
      const { db, store } = freshStore();
      await store.appendDelta({ vaultId: vault, payload: new Uint8Array([1, 2]) });

      // Tamper payload directly (bypass hash recompute)
      db.prepare(`UPDATE document_journal SET payload = ? WHERE vault_id = ? AND seq = 0`).run(
        new Uint8Array([9, 9, 9]),
        vault,
      );

      expect(() => store.load(vault)).toThrow(/Journal entry SHA256 mismatch/);
    });

    it('throws when checkpoint payload is tampered', async () => {
      const { db, store } = freshStore();
      const cp = new Uint8Array([1, 2, 3, 4]);
      const sv = new Uint8Array([0]);
      await store.writeCheckpoint({
        vaultId: vault,
        checkpoint: {
          version: 1,
          payload: cp,
          stateVector: sv,
          sha256: '',
          createdAt: new Date().toISOString(),
        },
      });
      // seed meta to point at version 1
      await store.writeMeta({
        vaultId: vault,
        currentCheckpointVersion: 1,
        nextSeq: 0,
        journalEntryCount: 0,
        journalTotalBytes: 0,
        updatedAt: new Date().toISOString(),
      });

      db.prepare(`UPDATE document_checkpoints SET payload = ? WHERE vault_id = ? AND version = 1`).run(
        new Uint8Array([9]),
        vault,
      );

      expect(() => store.load(vault)).toThrow(/Checkpoint SHA256 mismatch/);
    });
  });

  describe('writeCheckpoint with replaceUpToSeq', () => {
    it('trims journal and resets counters', async () => {
      const { store } = freshStore();
      await store.appendDelta({ vaultId: vault, payload: new Uint8Array([1]) });
      await store.appendDelta({ vaultId: vault, payload: new Uint8Array([2]) });

      await store.writeCheckpoint({
        vaultId: vault,
        checkpoint: {
          version: 1,
          payload: new Uint8Array([10, 20]),
          stateVector: new Uint8Array([0]),
          sha256: '',
          createdAt: new Date().toISOString(),
        },
        replaceUpToSeq: 1,
      });

      const loaded = await store.load(vault);
      expect(loaded.deltas).toHaveLength(0);
      expect(loaded.checkpoint?.version).toBe(1);
      expect(loaded.meta?.journalEntryCount).toBe(0);
      expect(loaded.meta?.journalTotalBytes).toBe(0);
      expect(loaded.meta?.currentCheckpointVersion).toBe(1);
    });
  });

  describe('needsCompact', () => {
    it('returns false when under threshold', async () => {
      const { store } = freshStore();
      await store.appendDelta({ vaultId: vault, payload: new Uint8Array([1]) });
      expect(store.needsCompact(vault)).toBe(false);
    });

    it('returns true when entry count reaches MAX_JOURNAL_ENTRIES', async () => {
      const { store } = freshStore();
      for (let i = 0; i < MAX_JOURNAL_ENTRIES; i++) {
        await store.appendDelta({ vaultId: vault, payload: new Uint8Array([i & 0xff]) });
      }
      expect(store.needsCompact(vault)).toBe(true);
    });
  });
});
