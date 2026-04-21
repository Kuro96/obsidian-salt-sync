import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Auth } from './auth.js';
import { SyncTokenStore } from './auth/syncTokenStore.js';
import { runMigrations } from './persistence/migrations.js';
import { SqliteDocumentStore } from './persistence/sqliteDocumentStore.js';
import { RoomManager } from './rooms/roomManager.js';
import { S3BlobStore } from './blobs/s3BlobStore.js';
import { S3SnapshotStore } from './snapshots/s3SnapshotStore.js';
import { SNAPSHOT_RETENTION_DAYS, SNAPSHOT_MAX_COUNT } from '@salt-sync/shared';
import { createApp } from './app.js';
import { ensureS3Bucket } from './s3/ensureBucket.js';

async function main(): Promise<void> {
  const START_TIME = Date.now();
  const PORT = parseInt(process.env.PORT ?? '3000', 10);
  const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new DatabaseSync(path.join(DATA_DIR, 'salt-sync.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);

  const syncTokenStore = new SyncTokenStore(db);
  const auth = new Auth(syncTokenStore);
  const store = new SqliteDocumentStore(db);

  const s3Config = {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:19000',
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_BUCKET ?? 'salt-sync',
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
  };

  await ensureS3Bucket(s3Config);

  const validRetentionDays = [3, 7, 14, 30];
  const validMaxCounts = [3, 5, 10, 20];
  const retentionDays = validRetentionDays.includes(parseInt(process.env.SNAPSHOT_RETENTION_DAYS ?? '', 10))
    ? parseInt(process.env.SNAPSHOT_RETENTION_DAYS!, 10)
    : SNAPSHOT_RETENTION_DAYS;
  const maxCount = validMaxCounts.includes(parseInt(process.env.SNAPSHOT_MAX_COUNT ?? '', 10))
    ? parseInt(process.env.SNAPSHOT_MAX_COUNT!, 10)
    : SNAPSHOT_MAX_COUNT;

  console.log(`[salt-sync/server] snapshot retention: ${retentionDays} days, max ${maxCount} versions`);

  const blobStore = new S3BlobStore(s3Config);
  const snapshotStore = new S3SnapshotStore({ ...s3Config, retentionDays, maxCount });
  const roomManager = new RoomManager(store, snapshotStore);

  const app = createApp({
    auth,
    syncTokenStore,
    store,
    roomManager,
    blobStore,
    snapshotStore,
    startTime: START_TIME,
  });

  setInterval(() => {
    roomManager.disposeIdleRooms().catch(console.error);
  }, 60_000);

  app.server.listen(PORT, () => {
    console.log(`[salt-sync/server] listening on port ${PORT}`);
  });

  process.on('SIGTERM', () => {
    roomManager
      .disposeIdleRooms()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

main().catch((err) => {
  console.error('[salt-sync/server] startup failed:', err);
  process.exit(1);
});
