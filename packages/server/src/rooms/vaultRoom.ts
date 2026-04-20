import crypto from 'node:crypto';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import {
  SAVE_DEBOUNCE_MS,
  SCHEMA_VERSION,
  AUTO_SNAPSHOT_ENTRIES,
} from '@salt-sync/shared';
import type {
  VaultId,
  TransportSession,
  RoomMeta,
  SnapshotMeta,
  BlobRef,
  BlobTombstone,
  FileTombstone,
} from '@salt-sync/shared';
import type { SqliteDocumentStore } from '../persistence/sqliteDocumentStore.js';
import type { S3SnapshotStore } from '../snapshots/s3SnapshotStore.js';

function sha256hex(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export class VaultRoom {
  readonly vaultId: VaultId;

  private readonly ydoc = new Y.Doc();
  private readonly awareness = new Awareness(this.ydoc);
  private readonly sessions = new Map<string, TransportSession>();
  private readonly awarenessOwners = new Map<string, Set<number>>();
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * State vector of the last successfully persisted state.
   * Initialized from the empty Y.Doc so encodeStateAsUpdate(doc, lastSavedSv)
   * always gets a valid encoded SV (an empty Uint8Array is not a valid SV).
   */
  private lastSavedSv: Uint8Array = Y.encodeStateVector(this.ydoc);
  private lastCheckpointVersion = 0;
  /** 距离下次自动 snapshot 还剩多少次 journal 写入 */
  private snapshotCountdown = AUTO_SNAPSHOT_ENTRIES;

  constructor(
    vaultId: VaultId,
    private readonly store: SqliteDocumentStore,
    private readonly snapshotStore: S3SnapshotStore | null = null,
  ) {
    this.vaultId = vaultId;

    // Broadcast any update to all sessions except the originator,
    // then schedule a debounced save.
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      const originId = typeof origin === 'string' ? origin : null;
      for (const [sid, session] of this.sessions) {
        if (sid !== originId) {
          session.send({ type: 'sync_update', update }).catch((err) => {
            console.error(`[VaultRoom:${this.vaultId}] send error to ${sid}:`, err);
          });
        }
      }
      this.scheduleSave();
    });

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = added.concat(updated, removed);
        if (changed.length === 0) return;

        const originSessionId = typeof origin === 'string' ? origin : null;
        if (originSessionId) {
          this.trackAwarenessOwners(originSessionId, added, updated, removed);
        }

        const payload = encodeAwarenessUpdate(this.awareness, changed);
        for (const [sid, session] of this.sessions) {
          if (sid === originSessionId) continue;
          session.send({ type: 'awareness_update', payload }).catch((err) => {
            console.error(`[VaultRoom:${this.vaultId}] awareness send error to ${sid}:`, err);
          });
        }
      },
    );
  }

  // ── Shared model accessors ────────────────────────────────────────────────

  get pathToId(): Y.Map<string> {
    return this.ydoc.getMap('pathToId');
  }

  get idToPath(): Y.Map<string> {
    return this.ydoc.getMap('idToPath');
  }

  get docs(): Y.Map<Y.Text> {
    return this.ydoc.getMap('docs');
  }

  get sys(): Y.Map<unknown> {
    return this.ydoc.getMap('sys');
  }

  get pathToBlob(): Y.Map<BlobRef> {
    return this.ydoc.getMap('pathToBlob') as Y.Map<BlobRef>;
  }

  get fileTombstones(): Y.Map<FileTombstone> {
    return this.ydoc.getMap('fileTombstones') as Y.Map<FileTombstone>;
  }

  get blobTombstones(): Y.Map<BlobTombstone> {
    return this.ydoc.getMap('blobTombstones') as Y.Map<BlobTombstone>;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    if (this.loaded) return;

    const { checkpoint, deltas } = await this.store.load(this.vaultId);

    if (checkpoint) {
      Y.applyUpdate(this.ydoc, checkpoint.payload, 'load');
      this.lastSavedSv = Y.encodeStateVector(this.ydoc);
      this.lastCheckpointVersion = checkpoint.version;
    }

    for (const delta of deltas) {
      Y.applyUpdate(this.ydoc, delta.payload, 'load');
    }

    if (deltas.length > 0) {
      this.lastSavedSv = Y.encodeStateVector(this.ydoc);
    }

    // Ensure sys metadata is set
    if (!this.sys.get('schemaVersion')) {
      this.ydoc.transact(() => {
        this.sys.set('schemaVersion', SCHEMA_VERSION);
        this.sys.set('vaultId', this.vaultId);
        this.sys.set('createdAt', new Date().toISOString());
      }, 'init');
    }

    this.loaded = true;
    console.log(
      `[VaultRoom:${this.vaultId}] loaded — checkpoint v${this.lastCheckpointVersion}, ${deltas.length} journal entries`,
    );
  }

  async disposeIfIdle(): Promise<boolean> {
    if (this.sessions.size > 0) return false;
    await this.saveNow();
    console.log(`[VaultRoom:${this.vaultId}] disposed (idle)`);
    return true;
  }

  // ── Session management ────────────────────────────────────────────────────

  async attachSession(session: TransportSession): Promise<void> {
    await this.load();
    this.sessions.set(session.id, session);

    // Send current state vector so client can request missing updates
    const sv = Y.encodeStateVector(this.ydoc);
    await session.send({ type: 'sync_state_vector', sv });

    // Respond to client messages
    session.onMessage(async (msg) => {
      if (msg.type === 'sync_update') {
        await this.applyClientUpdate(session.id, msg.update);
      } else if (msg.type === 'sync_state_vector') {
        // Client sent its state vector — reply with what the client is missing.
        // Guard: an empty SV means client has nothing, send full state.
        const sv = msg.sv.length > 0 ? msg.sv : undefined;
        const diff = Y.encodeStateAsUpdate(this.ydoc, sv);
        await session.send({ type: 'sync_update', update: diff });
      } else if (msg.type === 'awareness_update') {
        await this.applyAwareness(session.id, msg.payload);
      }
    });

    session.onClose(async () => {
      this.sessions.delete(session.id);
      await this.cleanupAwareness(session.id);
      console.log(`[VaultRoom:${this.vaultId}] session ${session.id} disconnected (${this.sessions.size} remaining)`);
    });

    console.log(
      `[VaultRoom:${this.vaultId}] session ${session.id} attached (${this.sessions.size} total)`,
    );
  }

  async detachSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async applyClientUpdate(sessionId: string, update: Uint8Array): Promise<void> {
    Y.applyUpdate(this.ydoc, update, sessionId);
  }

  async applyAwareness(sessionId: string, payload: Uint8Array): Promise<void> {
    applyAwarenessUpdate(this.awareness, payload, sessionId);
  }

  async getMeta(): Promise<RoomMeta> {
    return {
      vaultId: this.vaultId,
      schemaVersion: SCHEMA_VERSION,
      connectedClientCount: this.sessions.size,
      loaded: this.loaded,
      updatedAt: new Date().toISOString(),
    };
  }

  async snapshotNow(triggeredBy?: string): Promise<SnapshotMeta> {
    if (!this.snapshotStore) {
      throw new Error('[VaultRoom] snapshotStore not configured');
    }

    await this.load();

    const snapshotId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const payload = Y.encodeStateAsUpdate(this.ydoc);

    const referencedBlobHashes: string[] = [];
    for (const [, ref] of this.pathToBlob) {
      referencedBlobHashes.push(ref.hash);
    }

    const meta: SnapshotMeta = {
      snapshotId,
      vaultId: this.vaultId,
      createdAt,
      schemaVersion: SCHEMA_VERSION,
      markdownFileCount: this.docs.size,
      blobFileCount: this.pathToBlob.size,
      referencedBlobHashes,
    };

    await this.snapshotStore.put({ vaultId: this.vaultId, snapshotId, payload, meta });

    console.log(
      `[VaultRoom:${this.vaultId}] snapshot ${snapshotId} created (triggered by ${triggeredBy ?? 'manual'})`,
    );

    // 快照创建后立即按保留策略清理过期快照
    await this.snapshotStore.prune(this.vaultId).catch((err) => {
      console.error(`[VaultRoom:${this.vaultId}] prune error:`, err);
    });

    return meta;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveNow().catch((err) => {
        console.error(`[VaultRoom:${this.vaultId}] save error:`, err);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const currentSv = Y.encodeStateVector(this.ydoc);
    const delta = Y.encodeStateAsUpdate(this.ydoc, this.lastSavedSv);

    // Empty delta check (Yjs encodes an empty update as 2 bytes: 0x00 0x00)
    if (delta.length <= 2) return;

    await this.store.appendDelta({
      vaultId: this.vaultId,
      payload: delta,
    });

    this.lastSavedSv = currentSv;

    // 自动 snapshot：每 AUTO_SNAPSHOT_ENTRIES 次 journal 写入触发一次
    if (this.snapshotStore) {
      this.snapshotCountdown--;
      if (this.snapshotCountdown <= 0) {
        this.snapshotCountdown = AUTO_SNAPSHOT_ENTRIES;
        this.snapshotNow('auto').catch((err) => {
          console.error(`[VaultRoom:${this.vaultId}] auto snapshot error:`, err);
        });
      }
    }

    // Check if we need to compact
    if (this.store.needsCompact(this.vaultId)) {
      await this.compact();
    }
  }

  private async compact(): Promise<void> {
    const meta = await this.store.readMeta(this.vaultId);
    if (!meta) return;

    const fullState = Y.encodeStateAsUpdate(this.ydoc);
    const sv = Y.encodeStateVector(this.ydoc);
    const newVersion = this.lastCheckpointVersion + 1;
    const createdAt = new Date().toISOString();

    await this.store.writeCheckpoint({
      vaultId: this.vaultId,
      checkpoint: {
        version: newVersion,
        payload: fullState,
        stateVector: sv,
        sha256: sha256hex(fullState),
        createdAt,
      },
      replaceUpToSeq: meta.nextSeq - 1,
    });

    this.lastCheckpointVersion = newVersion;
    console.log(`[VaultRoom:${this.vaultId}] compacted to checkpoint v${newVersion}`);
  }

  private trackAwarenessOwners(
    sessionId: string,
    added: number[],
    updated: number[],
    removed: number[],
  ): void {
    let owned = this.awarenessOwners.get(sessionId);
    if (!owned) {
      owned = new Set<number>();
      this.awarenessOwners.set(sessionId, owned);
    }

    for (const clientId of added.concat(updated)) {
      owned.add(clientId);
    }
    for (const clientId of removed) {
      owned.delete(clientId);
    }

    if (owned.size === 0) {
      this.awarenessOwners.delete(sessionId);
    }
  }

  private async cleanupAwareness(sessionId: string): Promise<void> {
    const owned = this.awarenessOwners.get(sessionId);
    if (!owned || owned.size === 0) {
      this.awarenessOwners.delete(sessionId);
      return;
    }

    this.awarenessOwners.delete(sessionId);
    removeAwarenessStates(this.awareness, [...owned], null);
  }
}
