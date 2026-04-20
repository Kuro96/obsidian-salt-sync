import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { BlobStore, VaultId, BlobHash, PutBlobInput, GetBlobInput, StoredBlob } from '@salt-sync/shared';

export interface S3BlobStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO 和本地 S3 兼容服务需要开启 path-style（默认 true） */
  forcePathStyle?: boolean;
}

export class S3BlobStore implements BlobStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(config: S3BlobStoreConfig) {
    this.bucket = config.bucket;
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

  private key(vaultId: VaultId, hash: BlobHash): string {
    return `${vaultId}/${hash}`;
  }

  async has(vaultId: VaultId, hash: BlobHash): Promise<boolean> {
    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(vaultId, hash) }),
      );
      return true;
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
      throw err;
    }
  }

  async hasMany(vaultId: VaultId, hashes: BlobHash[]): Promise<Set<BlobHash>> {
    const checks = await Promise.all(
      hashes.map(async (hash) => ({ hash, exists: await this.has(vaultId, hash) })),
    );
    return new Set(checks.filter((c) => c.exists).map((c) => c.hash));
  }

  async put(input: PutBlobInput): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(input.vaultId, input.hash),
        Body: input.bytes,
        ContentType: input.contentType ?? 'application/octet-stream',
      }),
    );
  }

  async get(input: GetBlobInput): Promise<StoredBlob | null> {
    try {
      const resp = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(input.vaultId, input.hash) }),
      );
      if (!resp.Body) return null;
      const bytes = await resp.Body.transformToByteArray();
      return {
        hash: input.hash,
        bytes: new Uint8Array(bytes),
        contentType: resp.ContentType,
        size: bytes.length,
      };
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(vaultId: VaultId, hash: BlobHash): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(vaultId, hash) }),
    );
  }

  /**
   * 列出某个 vault 下所有已存储的 blob hash 及其 S3 LastModified
   * （排除 snapshots/ 子目录）。GC 用这些时间戳做 staleness 过滤，
   * 避免误删刚上传但 Y.Doc 引用尚未传播到 room 的对象。
   */
  async listHashes(vaultId: VaultId): Promise<{ hash: BlobHash; lastModified: Date | null }[]> {
    const prefix = `${vaultId}/`;
    const snapshotPrefix = `${vaultId}/snapshots/`;
    const results: { hash: BlobHash; lastModified: Date | null }[] = [];
    let continuationToken: string | undefined;

    do {
      const resp = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of resp.Contents ?? []) {
        const key = obj.Key ?? '';
        if (key.startsWith(snapshotPrefix)) continue;
        const hash = key.slice(prefix.length);
        if (hash) {
          results.push({ hash, lastModified: obj.LastModified ?? null });
        }
      }

      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    return results;
  }
}
