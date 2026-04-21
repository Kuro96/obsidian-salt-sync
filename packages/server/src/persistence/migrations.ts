import type { DatabaseSync } from 'node:sqlite';

/**
 * Current schema version. Increment this and add a new `if (version < N)` block
 * whenever the schema changes (new tables, new columns, index changes, etc.).
 *
 * SQLite's PRAGMA user_version stores an integer in the DB file header, making it
 * the canonical way to track schema state without a separate bookkeeping table.
 */
export const CURRENT_DB_VERSION = 1;

export function runMigrations(db: DatabaseSync): void {
  const { user_version: version } = db
    .prepare('PRAGMA user_version')
    .get() as { user_version: number };

  // ----- version 0 → 1 : initial schema (document store + sync tokens) -----
  if (version < 1) {
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

      CREATE TABLE IF NOT EXISTS sync_tokens (
        id           TEXT    PRIMARY KEY,
        name         TEXT    NOT NULL,
        token_hash   TEXT    NOT NULL UNIQUE,
        token_prefix TEXT    NOT NULL,
        status       TEXT    NOT NULL,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        last_used_at TEXT,
        expires_at   TEXT,
        revoked_at   TEXT,
        note         TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sync_tokens_status ON sync_tokens(status);
      CREATE INDEX IF NOT EXISTS idx_sync_tokens_created_at ON sync_tokens(created_at DESC);
    `);

    db.exec(`PRAGMA user_version = 1`);
  }

  // Future migrations go here, e.g.:
  // if (version < 2) {
  //   db.exec(`ALTER TABLE sync_tokens ADD COLUMN description TEXT`);
  //   db.exec(`PRAGMA user_version = 2`);
  // }
}
