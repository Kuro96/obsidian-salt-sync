import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { S3BlobStoreConfig } from '../blobs/s3BlobStore.js';

type S3Like = Pick<S3Client, 'send'> & { destroy?: () => void };

function isMissingBucketError(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NotFound' ||
    e.name === 'NoSuchBucket' ||
    e.Code === 'NotFound' ||
    e.Code === 'NoSuchBucket' ||
    e.$metadata?.httpStatusCode === 404
  );
}

function isAlreadyExistsError(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'BucketAlreadyOwnedByYou' ||
    e.name === 'BucketAlreadyExists' ||
    e.Code === 'BucketAlreadyOwnedByYou' ||
    e.Code === 'BucketAlreadyExists' ||
    e.$metadata?.httpStatusCode === 409
  );
}

export async function ensureS3Bucket(
  config: S3BlobStoreConfig,
  s3?: S3Like,
): Promise<void> {
  const client =
    s3 ??
    new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
    });
  const shouldDestroy = !s3;

  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      return;
    } catch (err) {
      if (!isMissingBucketError(err)) throw err;
    }

    try {
      await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
      console.log(`[salt-sync/server] created S3 bucket ${config.bucket}`);
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;
    }
  } finally {
    if (shouldDestroy) client.destroy?.();
  }
}
