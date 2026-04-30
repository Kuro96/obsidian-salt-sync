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
  isPathIgnoredBySync,
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
import { docFromPayload } from '../snapshots/snapshotUtils.js';

function sha256hex(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export type IgnoredPathCleanupMap =
  | 'pathToId'
  | 'idToPath'
  | 'docs'
  | 'fileTombstones'
  | 'pathToBlob'
  | 'blobTombstones';

export interface IgnoredPathCleanupEntry {
  map: IgnoredPathCleanupMap;
  path: string;
  fileId?: string;
  hash?: string;
  replacementPath?: string;
}

export interface IgnoredPathCleanupResult {
  dryRun: boolean;
  removed: IgnoredPathCleanupEntry[];
  counts: Record<IgnoredPathCleanupMap, number>;
}

const EMPTY_IGNORED_COUNTS: Record<IgnoredPathCleanupMap, number> = {
  pathToId: 0,
  idToPath: 0,
  docs: 0,
  fileTombstones: 0,
  pathToBlob: 0,
  blobTombstones: 0,
};

function makeIgnoredCleanupResult(dryRun: boolean, removed: IgnoredPathCleanupEntry[]): IgnoredPathCleanupResult {
  const counts = { ...EMPTY_IGNORED_COUNTS };
  for (const entry of removed) {
    counts[entry.map] += 1;
  }
  return { dryRun, removed, counts };
}

export class VaultRoom {
  readonly vaultId: VaultId;

  private readonly ydoc = new Y.Doc();
  private readonly awareness = new Awareness(this.ydoc);
  private readonly sessions = new Map<string, TransportSession>();
  private readonly awarenessOwners = new Map<string, Set<number>>();
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityAt: string | null = null;

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
      this.markActivity();
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
        this.markActivity();

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
    this.markActivity();
    console.log(
      `[VaultRoom:${this.vaultId}] loaded — checkpoint v${this.lastCheckpointVersion}, ${deltas.length} journal entries`,
    );
  }

  async disposeIfIdle(): Promise<boolean> {
    if (this.sessions.size > 0) return false;
    await this.saveNow();
    this.markActivity();
    console.log(`[VaultRoom:${this.vaultId}] disposed (idle)`);
    return true;
  }

  // ── Session management ────────────────────────────────────────────────────

  async attachSession(session: TransportSession): Promise<void> {
    await this.load();
    this.sessions.set(session.id, session);
    this.markActivity();

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
      this.markActivity();
      console.log(`[VaultRoom:${this.vaultId}] session ${session.id} disconnected (${this.sessions.size} remaining)`);
    });

    console.log(
      `[VaultRoom:${this.vaultId}] session ${session.id} attached (${this.sessions.size} total)`,
    );
  }

  async detachSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.markActivity();
  }

  async applyClientUpdate(sessionId: string, update: Uint8Array): Promise<void> {
    this.markActivity();
    this.ydoc.transact(() => {
      Y.applyUpdate(this.ydoc, update);
      this.applyIgnoredPathCleanupEntries(this.collectIgnoredPathCleanupEntries());
    }, sessionId);
  }

  async applyAwareness(sessionId: string, payload: Uint8Array): Promise<void> {
    this.markActivity();
    applyAwarenessUpdate(this.awareness, payload, sessionId);
  }

  async getMeta(): Promise<RoomMeta> {
    return {
      vaultId: this.vaultId,
      schemaVersion: SCHEMA_VERSION,
      connectedClientCount: this.sessions.size,
      loaded: this.loaded,
      updatedAt: this.lastActivityAt ?? undefined,
    };
  }

  getAdminState(): {
    markdownPathCount: number;
    markdownDocCount: number;
    blobPathCount: number;
    fileTombstoneCount: number;
    blobTombstoneCount: number;
    loaded: boolean;
  } {
    return {
      markdownPathCount: this.pathToId.size,
      markdownDocCount: this.docs.size,
      blobPathCount: this.pathToBlob.size,
      fileTombstoneCount: this.fileTombstones.size,
      blobTombstoneCount: this.blobTombstones.size,
      loaded: this.loaded,
    };
  }

  async inspectIgnoredPathPollution(): Promise<IgnoredPathCleanupResult> {
    await this.load();
    return makeIgnoredCleanupResult(true, this.collectIgnoredPathCleanupEntries());
  }

  async cleanupIgnoredPathPollution(): Promise<IgnoredPathCleanupResult> {
    await this.load();
    const removed = this.collectIgnoredPathCleanupEntries();
    if (removed.length === 0) return makeIgnoredCleanupResult(false, []);

    this.ydoc.transact(() => this.applyIgnoredPathCleanupEntries(removed), 'admin-ignored-cleanup');

    await this.saveNow();
    this.markActivity();
    return makeIgnoredCleanupResult(false, removed);
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
    this.markActivity();

    console.log(
      `[VaultRoom:${this.vaultId}] snapshot ${snapshotId} created (triggered by ${triggeredBy ?? 'manual'})`,
    );

    // 快照创建后立即按保留策略清理过期快照
    await this.snapshotStore.prune(this.vaultId).catch((err) => {
      console.error(`[VaultRoom:${this.vaultId}] prune error:`, err);
    });

    return meta;
  }

  async restoreFromSnapshotPayload(payload: Uint8Array, restoredBy = 'admin'): Promise<void> {
    await this.load();

    const snapshotDoc = docFromPayload(payload);
    const snapshotPathToId = snapshotDoc.getMap<string>('pathToId');
    const snapshotIdToPath = snapshotDoc.getMap<string>('idToPath');
    const snapshotDocs = snapshotDoc.getMap<Y.Text>('docs');
    const snapshotSys = snapshotDoc.getMap<unknown>('sys');
    const snapshotPathToBlob = snapshotDoc.getMap<BlobRef>('pathToBlob');
    const snapshotFileTombstones = snapshotDoc.getMap<FileTombstone>('fileTombstones') as Y.Map<FileTombstone>;
    const snapshotBlobTombstones = snapshotDoc.getMap<BlobTombstone>('blobTombstones') as Y.Map<BlobTombstone>;

    // Restore is modeled as a single Y transaction that rewrites the known shared maps
    // to the exact snapshot state so connected sessions converge via normal update flow.
    this.ydoc.transact(() => {
      this.replaceScalarMap(this.pathToId, snapshotPathToId);
      this.replaceScalarMap(this.idToPath, snapshotIdToPath);
      this.replaceTextMap(this.docs, snapshotDocs);
      this.replaceScalarMap(this.sys as Y.Map<unknown>, snapshotSys as Y.Map<unknown>);
      this.replaceScalarMap(this.pathToBlob, snapshotPathToBlob);
      this.replaceScalarMap(this.fileTombstones, snapshotFileTombstones);
      this.replaceScalarMap(this.blobTombstones, snapshotBlobTombstones);
      this.sys.set('restoredAt', new Date().toISOString());
      this.sys.set('restoredBy', restoredBy);
    }, 'restore');

    await this.saveNow();
    this.markActivity();
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
    this.markActivity();

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
    this.markActivity();
    console.log(`[VaultRoom:${this.vaultId}] compacted to checkpoint v${newVersion}`);
  }

  private collectIgnoredPathCleanupEntries(): IgnoredPathCleanupEntry[] {
    const entries: IgnoredPathCleanupEntry[] = [];
    const ignoredFileIds = new Set<string>();

    for (const [path, fileId] of this.pathToId) {
      if (!isPathIgnoredBySync(path)) continue;
      entries.push({ map: 'pathToId', path, fileId });
      ignoredFileIds.add(fileId);
    }

    for (const [fileId, path] of this.idToPath) {
      if (!isPathIgnoredBySync(path)) continue;
      const replacementPath = this.findNonIgnoredPathForFileId(fileId);
      entries.push({ map: 'idToPath', path, fileId, replacementPath });
      ignoredFileIds.add(fileId);
    }

    for (const fileId of ignoredFileIds) {
      const hasNonIgnoredPath = this.hasNonIgnoredPathForFileId(fileId);
      if (!hasNonIgnoredPath && this.docs.has(fileId)) {
        entries.push({ map: 'docs', path: this.idToPath.get(fileId) ?? fileId, fileId });
      }
    }

    for (const [path] of this.fileTombstones) {
      if (isPathIgnoredBySync(path)) entries.push({ map: 'fileTombstones', path });
    }

    for (const [path, ref] of this.pathToBlob) {
      if (isPathIgnoredBySync(path)) entries.push({ map: 'pathToBlob', path, hash: ref.hash });
    }

    for (const [path, tombstone] of this.blobTombstones) {
      if (isPathIgnoredBySync(path)) entries.push({ map: 'blobTombstones', path, hash: tombstone.hash });
    }

    return entries;
  }

  private applyIgnoredPathCleanupEntries(entries: IgnoredPathCleanupEntry[]): void {
    for (const entry of entries) {
      if (entry.map === 'pathToId') this.pathToId.delete(entry.path);
      else if (entry.map === 'idToPath' && entry.fileId && entry.replacementPath) this.idToPath.set(entry.fileId, entry.replacementPath);
      else if (entry.map === 'idToPath' && entry.fileId) this.idToPath.delete(entry.fileId);
      else if (entry.map === 'docs' && entry.fileId) this.docs.delete(entry.fileId);
      else if (entry.map === 'fileTombstones') this.fileTombstones.delete(entry.path);
      else if (entry.map === 'pathToBlob') this.pathToBlob.delete(entry.path);
      else if (entry.map === 'blobTombstones') this.blobTombstones.delete(entry.path);
    }
  }

  private findNonIgnoredPathForFileId(fileId: string): string | undefined {
    for (const [path, mappedFileId] of this.pathToId) {
      if (mappedFileId === fileId && !isPathIgnoredBySync(path)) return path;
    }
    return undefined;
  }

  private hasNonIgnoredPathForFileId(fileId: string): boolean {
    if (this.findNonIgnoredPathForFileId(fileId)) return true;
    const reversePath = this.idToPath.get(fileId);
    return !!reversePath && !isPathIgnoredBySync(reversePath);
  }

  private markActivity(): void {
    this.lastActivityAt = new Date().toISOString();
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

  private replaceScalarMap<T>(target: Y.Map<T>, source: Y.Map<T>): void {
    for (const key of [...target.keys()]) {
      if (!source.has(key)) {
        target.delete(key);
      }
    }

    for (const [key, value] of source) {
      target.set(key, value);
    }
  }

  private replaceTextMap(target: Y.Map<Y.Text>, source: Y.Map<Y.Text>): void {
    for (const key of [...target.keys()]) {
      if (!source.has(key)) {
        target.delete(key);
      }
    }

    for (const [key, value] of source) {
      const next = new Y.Text();
      next.insert(0, value.toString());
      target.set(key, next);
    }
  }
}
