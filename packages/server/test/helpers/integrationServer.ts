import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AddressInfo } from 'node:net';
import {
  S3Client,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Auth } from '../../src/auth';
import { runMigrations } from '../../src/persistence/migrations';
import { SqliteDocumentStore } from '../../src/persistence/sqliteDocumentStore';
import { RoomManager } from '../../src/rooms/roomManager';
import { S3BlobStore } from '../../src/blobs/s3BlobStore';
import { S3SnapshotStore } from '../../src/snapshots/s3SnapshotStore';
import { ensureS3Bucket } from '../../src/s3/ensureBucket';
import { createApp, type AppHandle } from '../../src/app';

export const TEST_S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:19000',
  region: 'us-east-1',
  bucket: process.env.TEST_S3_BUCKET ?? 'salt-sync-test',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
};

export interface TestServer {
  app: AppHandle;
  port: number;
  baseUrl: string;
  wsUrl: (vaultId: string) => string;
  cleanup: () => Promise<void>;
}

export interface StartTestServerOpts {
  serverToken?: string;
  vaultTokens?: Record<string, string>;
  withS3?: boolean;
}

export async function ensureBucket(bucket = TEST_S3.bucket): Promise<void> {
  const config = { ...TEST_S3, bucket };
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
  });
  await ensureS3Bucket(config, s3);
  // Wipe contents for a fresh test run
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: config.bucket }),
  );
  const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
  if (keys.length > 0) {
    await s3.send(
      new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: keys } }),
    );
  }
  s3.destroy();
}

export async function startTestServer(opts: StartTestServerOpts = {}): Promise<TestServer> {
  // Inject env BEFORE constructing Auth
  const prevServer = process.env.SERVER_TOKEN;
  const prevVault = process.env.VAULT_TOKENS;
  if (opts.serverToken !== undefined) process.env.SERVER_TOKEN = opts.serverToken;
  if (opts.vaultTokens !== undefined) process.env.VAULT_TOKENS = JSON.stringify(opts.vaultTokens);

  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const store = new SqliteDocumentStore(db);
  const auth = new Auth();

  let blobStore: S3BlobStore | null = null;
  let snapshotStore: S3SnapshotStore | null = null;
  if (opts.withS3) {
    const s3Config = { ...TEST_S3, bucket: `${TEST_S3.bucket}-${randomUUID()}` };
    await ensureBucket(s3Config.bucket);
    blobStore = new S3BlobStore(s3Config);
    snapshotStore = new S3SnapshotStore(s3Config);
  }

  const roomManager = new RoomManager(store, snapshotStore);
  const app = createApp({ auth, store, roomManager, blobStore, snapshotStore });

  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
  const addr = app.server.address() as AddressInfo;
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = (vaultId: string) => `ws://127.0.0.1:${port}/vault/sync/${encodeURIComponent(vaultId)}`;

  return {
    app,
    port,
    baseUrl,
    wsUrl,
    async cleanup() {
      await app.close();
      db.close();
      // Restore env
      if (prevServer === undefined) delete process.env.SERVER_TOKEN;
      else process.env.SERVER_TOKEN = prevServer;
      if (prevVault === undefined) delete process.env.VAULT_TOKENS;
      else process.env.VAULT_TOKENS = prevVault;
    },
  };
}
