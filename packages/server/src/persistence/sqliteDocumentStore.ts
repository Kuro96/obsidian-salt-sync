import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_JOURNAL_ENTRIES, MAX_JOURNAL_BYTES } from '@salt-sync/shared';
import type {
  DocumentStore,
  VaultId,
  LoadedDocumentState,
  AppendDeltaInput,
  AppendDeltaResult,
  WriteCheckpointInput,
  DocumentStoreMeta,
  CompactResult,
  PersistedCheckpoint,
  PersistedDelta,
} from '@salt-sync/shared';

function sha256hex(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function now(): string {
  return new Date().toISOString();
}

/** node:sqlite 的 TypeScript 类型尚未暴露 transaction()，手动封装 */
function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export class SqliteDocumentStore implements DocumentStore {
  constructor(private readonly db: DatabaseSync) {}

  load(vaultId: VaultId): Promise<LoadedDocumentState> {
    const meta = this.readMetaSync(vaultId);
    let checkpoint: PersistedCheckpoint | null = null;

    if (meta && meta.currentCheckpointVersion > 0) {
      const row = this.db
        .prepare(
          `SELECT version, payload, state_vector, sha256, created_at
           FROM document_checkpoints
           WHERE vault_id = ? AND version = ?`,
        )
        .get(vaultId, meta.currentCheckpointVersion) as
        | { version: number; payload: Buffer; state_vector: Buffer; sha256: string; created_at: string }
        | undefined;

      if (row) {
        const actual = sha256hex(new Uint8Array(row.payload));
        if (actual !== row.sha256) {
          throw new Error(
            `[DocumentStore] Checkpoint SHA256 mismatch for vault ${vaultId} v${row.version}`,
          );
        }
        checkpoint = {
          version: row.version,
          payload: new Uint8Array(row.payload),
          stateVector: new Uint8Array(row.state_vector),
          sha256: row.sha256,
          createdAt: row.created_at,
        };
      }
    }

    const deltaRows = this.db
      .prepare(
        `SELECT seq, payload, sha256, created_at
         FROM document_journal
         WHERE vault_id = ?
         ORDER BY seq ASC`,
      )
      .all(vaultId) as { seq: number; payload: Buffer; sha256: string; created_at: string }[];

    const deltas: PersistedDelta[] = deltaRows.map((row) => {
      const actual = sha256hex(new Uint8Array(row.payload));
      if (actual !== row.sha256) {
        throw new Error(
          `[DocumentStore] Journal entry SHA256 mismatch for vault ${vaultId} seq ${row.seq}`,
        );
      }
      return {
        seq: row.seq,
        payload: new Uint8Array(row.payload),
        sha256: row.sha256,
        createdAt: row.created_at,
      };
    });

    return Promise.resolve({ checkpoint, deltas, meta });
  }

  appendDelta(input: AppendDeltaInput): Promise<AppendDeltaResult> {
    const result = withTx(this.db, () => {
      const meta = this.readMetaSync(input.vaultId);
      const seq = meta?.nextSeq ?? 0;

      if (input.expectedNextSeq !== undefined && input.expectedNextSeq !== seq) {
        throw new Error(
          `[DocumentStore] Seq mismatch: expected ${input.expectedNextSeq}, got ${seq}`,
        );
      }

      const hash = sha256hex(input.payload);
      this.db
        .prepare(
          `INSERT INTO document_journal (vault_id, seq, payload, sha256, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.vaultId, seq, input.payload, hash, now());

      const newEntryCount = (meta?.journalEntryCount ?? 0) + 1;
      const newTotalBytes = (meta?.journalTotalBytes ?? 0) + input.payload.byteLength;

      this.writeMetaSync({
        vaultId: input.vaultId,
        currentCheckpointVersion: meta?.currentCheckpointVersion ?? 0,
        nextSeq: seq + 1,
        journalEntryCount: newEntryCount,
        journalTotalBytes: newTotalBytes,
        updatedAt: now(),
      });

      return { seq, entryCount: newEntryCount, totalBytes: newTotalBytes };
    });

    return Promise.resolve(result as AppendDeltaResult);
  }

  writeCheckpoint(input: WriteCheckpointInput): Promise<void> {
    withTx(this.db, () => {
      const hash = sha256hex(input.checkpoint.payload);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO document_checkpoints
           (vault_id, version, payload, state_vector, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.vaultId,
          input.checkpoint.version,
          input.checkpoint.payload,
          input.checkpoint.stateVector,
          hash,
          input.checkpoint.createdAt,
        );

      if (input.replaceUpToSeq !== undefined) {
        this.db
          .prepare(`DELETE FROM document_journal WHERE vault_id = ? AND seq <= ?`)
          .run(input.vaultId, input.replaceUpToSeq);

        // Update meta: reset journal counters and set checkpoint version
        const meta = this.readMetaSync(input.vaultId);
        if (meta) {
          this.writeMetaSync({
            ...meta,
            currentCheckpointVersion: input.checkpoint.version,
            journalEntryCount: 0,
            journalTotalBytes: 0,
            updatedAt: now(),
          });
        }
      }
    });

    return Promise.resolve();
  }

  readMeta(vaultId: VaultId): Promise<DocumentStoreMeta | null> {
    return Promise.resolve(this.readMetaSync(vaultId));
  }

  writeMeta(meta: DocumentStoreMeta): Promise<void> {
    this.writeMetaSync(meta);
    return Promise.resolve();
  }

  compactIfNeeded(_vaultId: VaultId): Promise<CompactResult> {
    // Compact is triggered by VaultRoom.saveNow() via needsCompact() check.
    return Promise.resolve({ compacted: false });
  }

  needsCompact(vaultId: VaultId): boolean {
    const meta = this.readMetaSync(vaultId);
    if (!meta) return false;
    return meta.journalEntryCount >= MAX_JOURNAL_ENTRIES || meta.journalTotalBytes >= MAX_JOURNAL_BYTES;
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private readMetaSync(vaultId: VaultId): DocumentStoreMeta | null {
    const row = this.db
      .prepare(
        `SELECT vault_id, current_checkpoint_version, next_seq,
                journal_entry_count, journal_total_bytes, updated_at
         FROM document_meta WHERE vault_id = ?`,
      )
      .get(vaultId) as
      | {
          vault_id: string;
          current_checkpoint_version: number;
          next_seq: number;
          journal_entry_count: number;
          journal_total_bytes: number;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;
    return {
      vaultId: row.vault_id,
      currentCheckpointVersion: row.current_checkpoint_version,
      nextSeq: row.next_seq,
      journalEntryCount: row.journal_entry_count,
      journalTotalBytes: row.journal_total_bytes,
      updatedAt: row.updated_at,
    };
  }

  private writeMetaSync(meta: DocumentStoreMeta): void {
    this.db
      .prepare(
        `INSERT INTO document_meta
           (vault_id, current_checkpoint_version, next_seq,
            journal_entry_count, journal_total_bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(vault_id) DO UPDATE SET
           current_checkpoint_version = excluded.current_checkpoint_version,
           next_seq                   = excluded.next_seq,
           journal_entry_count        = excluded.journal_entry_count,
           journal_total_bytes        = excluded.journal_total_bytes,
           updated_at                 = excluded.updated_at`,
      )
      .run(
        meta.vaultId,
        meta.currentCheckpointVersion,
        meta.nextSeq,
        meta.journalEntryCount,
        meta.journalTotalBytes,
        meta.updatedAt,
      );
  }
}
