import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { SNAPSHOT_RETENTION_DAYS, SNAPSHOT_MAX_COUNT } from '@salt-sync/shared';
import type { SnapshotStore, VaultId, PutSnapshotInput, StoredSnapshot, SnapshotMeta } from '@salt-sync/shared';
import type { S3BlobStoreConfig } from '../blobs/s3BlobStore.js';

export interface S3SnapshotStoreConfig extends S3BlobStoreConfig {
  retentionDays?: number;
  maxCount?: number;
}

export class S3SnapshotStore implements SnapshotStore {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly retentionDays: number;
  private readonly maxCount: number;

  constructor(config: S3SnapshotStoreConfig) {
    this.bucket = config.bucket;
    this.retentionDays = config.retentionDays ?? SNAPSHOT_RETENTION_DAYS;
    this.maxCount = config.maxCount ?? SNAPSHOT_MAX_COUNT;
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
    });
  }

  private payloadKey(vaultId: VaultId, snapshotId: string): string {
    return `${vaultId}/snapshots/${snapshotId}.bin`;
  }

  private metaKey(vaultId: VaultId, snapshotId: string): string {
    return `${vaultId}/snapshots/${snapshotId}.meta.json`;
  }

  async put(input: PutSnapshotInput): Promise<SnapshotMeta> {
    // Write binary payload
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.payloadKey(input.vaultId, input.snapshotId),
        Body: input.payload,
        ContentType: 'application/octet-stream',
      }),
    );

    // Write metadata as JSON
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.metaKey(input.vaultId, input.snapshotId),
        Body: JSON.stringify(input.meta),
        ContentType: 'application/json',
      }),
    );

    return input.meta;
  }

  async list(vaultId: VaultId): Promise<SnapshotMeta[]> {
    const prefix = `${vaultId}/snapshots/`;
    const resp = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    );

    const metaKeys = (resp.Contents ?? [])
      .map((obj) => obj.Key ?? '')
      .filter((key) => key.endsWith('.meta.json'));

    const metas = await Promise.all(
      metaKeys.map(async (key) => {
        try {
          const obj = await this.s3.send(
            new GetObjectCommand({ Bucket: this.bucket, Key: key }),
          );
          const text = await obj.Body!.transformToString('utf-8');
          return JSON.parse(text) as SnapshotMeta;
        } catch {
          return null;
        }
      }),
    );

    return (metas.filter(Boolean) as SnapshotMeta[]).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async get(vaultId: VaultId, snapshotId: string): Promise<StoredSnapshot | null> {
    try {
      const [payloadResp, metaResp] = await Promise.all([
        this.s3.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: this.payloadKey(vaultId, snapshotId) }),
        ),
        this.s3.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: this.metaKey(vaultId, snapshotId) }),
        ),
      ]);

      const bytes = await payloadResp.Body!.transformToByteArray();
      const metaText = await metaResp.Body!.transformToString('utf-8');

      return {
        meta: JSON.parse(metaText) as SnapshotMeta,
        payload: new Uint8Array(bytes),
      };
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(vaultId: VaultId, snapshotId: string): Promise<void> {
    await Promise.all([
      this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.payloadKey(vaultId, snapshotId) }),
      ),
      this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.metaKey(vaultId, snapshotId) }),
      ),
    ]);
  }

  async prune(vaultId: VaultId): Promise<{ deleted: number }> {
    const snapshots = await this.list(vaultId); // 已按 createdAt 降序排列
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);

    const toDelete = new Set<string>();

    // 按数量截断：超出 maxCount 的尾部（较旧的）
    for (let i = this.maxCount; i < snapshots.length; i++) {
      toDelete.add(snapshots[i].snapshotId);
    }

    // 按天数截断：createdAt 早于阈值的（保留最新一条，即使超龄）
    for (let i = 1; i < snapshots.length; i++) {
      if (new Date(snapshots[i].createdAt) < cutoff) {
        toDelete.add(snapshots[i].snapshotId);
      }
    }

    for (const snapshotId of toDelete) {
      await this.delete(vaultId, snapshotId).catch((err) => {
        console.error(`[S3SnapshotStore] prune delete error for ${snapshotId}:`, err);
      });
    }

    if (toDelete.size > 0) {
      console.log(`[S3SnapshotStore] pruned ${toDelete.size} snapshot(s) for vault ${vaultId}`);
    }

    return { deleted: toDelete.size };
  }
}
