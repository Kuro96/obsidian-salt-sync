import type { DatabaseSync } from 'node:sqlite';

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_checkpoints (
      vault_id     TEXT    NOT NULL,
      version      INTEGER NOT NULL,
      payload      BLOB    NOT NULL,
      state_vector BLOB    NOT NULL,
      sha256       TEXT    NOT NULL,
      created_at   TEXT    NOT NULL,
      PRIMARY KEY (vault_id, version)
    );

    CREATE TABLE IF NOT EXISTS document_journal (
      vault_id   TEXT    NOT NULL,
      seq        INTEGER NOT NULL,
      payload    BLOB    NOT NULL,
      sha256     TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      PRIMARY KEY (vault_id, seq)
    );

    CREATE TABLE IF NOT EXISTS document_meta (
      vault_id                   TEXT    PRIMARY KEY,
      current_checkpoint_version INTEGER NOT NULL DEFAULT 0,
      next_seq                   INTEGER NOT NULL DEFAULT 0,
      journal_entry_count        INTEGER NOT NULL DEFAULT 0,
      journal_total_bytes        INTEGER NOT NULL DEFAULT 0,
      updated_at                 TEXT    NOT NULL
    );
  `);
}
