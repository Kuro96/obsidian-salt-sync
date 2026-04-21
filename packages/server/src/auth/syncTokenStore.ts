import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type SyncTokenStatus = 'active' | 'revoked' | 'expired';
export type SyncTokenMode = 'env-fallback' | 'db';

export interface SyncTokenRecord {
  id: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  status: SyncTokenStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  note: string | null;
}

export interface CreateSyncTokenInput {
  name: string;
  note?: string | null;
  expiresAt?: string | null;
}

export interface UpdateSyncTokenInput {
  name?: string;
  note?: string | null;
  expiresAt?: string | null;
  /**
   * Full status type — internal callers (e.g. validateRawToken) may set 'expired'.
   * The admin API layer separately restricts external callers to 'active' | 'revoked' only.
   */
  status?: SyncTokenStatus;
}

export interface CreateSyncTokenResult {
  record: SyncTokenRecord;
  rawToken: string;
}

export interface SyncTokenValidationResult {
  ok: boolean;
  record: SyncTokenRecord | null;
  reason?: 'not_found' | 'revoked' | 'expired';
}

interface SyncTokenRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  status: SyncTokenStatus;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  note: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function sha256hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function tokenPrefix(rawToken: string): string {
  return rawToken.slice(0, 8);
}

function generateRawToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function mapRow(row: SyncTokenRow): SyncTokenRecord {
  return {
    id: row.id,
    name: row.name,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    note: row.note,
  };
}

export class SyncTokenStore {
  /**
   * In-memory cache for hasAny().
   * - `null`  → stale, next call will hit the DB and repopulate.
   * - `true`  → at least one active, non-expired token is known to exist.
   * - `false` → no active tokens are known to exist.
   *
   * Rules:
   *   create()  → set true  (we just added a guaranteed-active token)
   *   rotate()  → set true  (token is active again)
   *   update()  → set null  (status or expiresAt may have changed)
   *   validateRawToken() calls update() on expiry → already invalidated via update()
   */
  private _hasAnyCache: boolean | null = null;

  constructor(private readonly db: DatabaseSync) {}

  static hashToken(rawToken: string): string {
    return sha256hex(rawToken);
  }

  static generateTokenValue(): string {
    return generateRawToken();
  }

  static getTokenPrefix(rawToken: string): string {
    return tokenPrefix(rawToken);
  }

  hasAny(): boolean {
    if (this._hasAnyCache !== null) {
      return this._hasAnyCache;
    }
    // Only count tokens that are active and not yet past their expiry time.
    // Tokens whose expiresAt has passed are effectively invalid even if their status
    // column still reads 'active' (status is lazily updated by validateRawToken).
    const row = this.db
      .prepare(
        "SELECT 1 AS present FROM sync_tokens WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
      )
      .get(now()) as { present: number } | undefined;
    this._hasAnyCache = row?.present === 1;
    return this._hasAnyCache;
  }

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM sync_tokens')
      .get() as { count: number };
    return row.count;
  }

  list(): SyncTokenRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, token_hash, token_prefix, status,
                created_at, updated_at, last_used_at, expires_at, revoked_at, note
         FROM sync_tokens
         ORDER BY created_at DESC`,
      )
      .all() as unknown as SyncTokenRow[];
    return rows.map(mapRow);
  }

  getById(id: string): SyncTokenRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, name, token_hash, token_prefix, status,
                created_at, updated_at, last_used_at, expires_at, revoked_at, note
         FROM sync_tokens
         WHERE id = ?`,
      )
      .get(id) as SyncTokenRow | undefined;
    return row ? mapRow(row) : null;
  }

  create(input: CreateSyncTokenInput): CreateSyncTokenResult {
    const rawToken = SyncTokenStore.generateTokenValue();
    const createdAt = now();
    const id = crypto.randomUUID();
    const record: SyncTokenRecord = {
      id,
      name: input.name.trim(),
      tokenHash: SyncTokenStore.hashToken(rawToken),
      tokenPrefix: SyncTokenStore.getTokenPrefix(rawToken),
      status: 'active',
      createdAt,
      updatedAt: createdAt,
      lastUsedAt: null,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      note: input.note ?? null,
    };

    this.db
      .prepare(
        `INSERT INTO sync_tokens
           (id, name, token_hash, token_prefix, status, created_at, updated_at, last_used_at, expires_at, revoked_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.tokenHash,
        record.tokenPrefix,
        record.status,
        record.createdAt,
        record.updatedAt,
        record.lastUsedAt,
        record.expiresAt,
        record.revokedAt,
        record.note,
      );

    // Only cache true if the token is not already past its expiry.
    // A token created with expiresAt in the past is immediately expired.
    const alreadyExpired =
      record.expiresAt !== null && new Date(record.expiresAt).getTime() <= Date.now();
    this._hasAnyCache = alreadyExpired ? null : true;
    return { record, rawToken };
  }

  /**
   * Runs `fn` inside a SQLite transaction (BEGIN / COMMIT / ROLLBACK).
   * If `fn` throws, the transaction is rolled back and the error re-thrown.
   *
   * Note: node:sqlite's DatabaseSync is synchronous and Node.js is single-threaded,
   * so nested transactions cannot occur in practice. Still wrapping for correctness
   * and future-proofing (e.g. worker_threads, connection pools).
   */
  private withTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  update(id: string, input: UpdateSyncTokenInput): SyncTokenRecord | null {
    return this.withTransaction(() => {
      const current = this.getById(id);
      if (!current) return null;

      const nextStatus = input.status ?? current.status;
      const revokedAt = nextStatus === 'revoked' ? current.revokedAt ?? now() : null;
      const updated: SyncTokenRecord = {
        ...current,
        name: input.name !== undefined ? input.name.trim() : current.name,
        note: input.note !== undefined ? input.note : current.note,
        expiresAt: input.expiresAt !== undefined ? input.expiresAt : current.expiresAt,
        status: nextStatus,
        revokedAt,
        updatedAt: now(),
      };

      this.db
        .prepare(
          `UPDATE sync_tokens
           SET name = ?, status = ?, updated_at = ?, expires_at = ?, revoked_at = ?, note = ?
           WHERE id = ?`,
        )
        .run(
          updated.name,
          updated.status,
          updated.updatedAt,
          updated.expiresAt,
          updated.revokedAt,
          updated.note,
          updated.id,
        );

      // status or expiresAt may have changed — let hasAny() re-query on next call.
      this._hasAnyCache = null;
      return updated;
    });
  }

  revoke(id: string): SyncTokenRecord | null {
    return this.update(id, { status: 'revoked' });
  }

  rotate(id: string): CreateSyncTokenResult | null {
    const result = this.withTransaction(() => {
      const current = this.getById(id);
      if (!current) return null;

      const rawToken = SyncTokenStore.generateTokenValue();
      const updatedAt = now();
      const updated: SyncTokenRecord = {
        ...current,
        tokenHash: SyncTokenStore.hashToken(rawToken),
        tokenPrefix: SyncTokenStore.getTokenPrefix(rawToken),
        status: 'active',
        revokedAt: null,
        updatedAt,
        lastUsedAt: null,
      };

      this.db
        .prepare(
          `UPDATE sync_tokens
           SET token_hash = ?, token_prefix = ?, status = ?, updated_at = ?, last_used_at = ?, revoked_at = ?
           WHERE id = ?`,
        )
        .run(
          updated.tokenHash,
          updated.tokenPrefix,
          updated.status,
          updated.updatedAt,
          updated.lastUsedAt,
          updated.revokedAt,
          updated.id,
        );

      return { record: updated, rawToken };
    });

    // Rotation produces an active token — cache is definitively true if result is non-null.
    if (result !== null) this._hasAnyCache = true;
    return result;
  }

  validateRawToken(rawToken: string): SyncTokenValidationResult {
    const row = this.db
      .prepare(
        `SELECT id, name, token_hash, token_prefix, status,
                created_at, updated_at, last_used_at, expires_at, revoked_at, note
         FROM sync_tokens
         WHERE token_hash = ?`,
      )
      .get(SyncTokenStore.hashToken(rawToken)) as SyncTokenRow | undefined;

    if (!row) {
      return { ok: false, record: null, reason: 'not_found' };
    }

    const record = mapRow(row);
    if (record.status === 'revoked') {
      return { ok: false, record, reason: 'revoked' };
    }

    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
      const expired = this.update(record.id, { status: 'expired' }) ?? record;
      return { ok: false, record: expired, reason: 'expired' };
    }

    if (record.status === 'expired') {
      return { ok: false, record, reason: 'expired' };
    }

    // Defer the last_used_at update so it does not block the auth hot path.
    // updated_at is intentionally NOT touched here — it tracks admin mutations only.
    const touched = now();
    setImmediate(() => {
      try {
        this.db
          .prepare('UPDATE sync_tokens SET last_used_at = ? WHERE id = ?')
          .run(touched, record.id);
      } catch (err) {
        console.error('[SyncTokenStore] failed to update last_used_at:', err);
      }
    });

    return {
      ok: true,
      record: {
        ...record,
        lastUsedAt: touched,
      },
    };
  }

  getMode(): SyncTokenMode {
    return this.hasAny() ? 'db' : 'env-fallback';
  }
}
