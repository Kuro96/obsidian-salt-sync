import { describe, expect, it, vi } from 'vitest';
import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { ensureS3Bucket } from '../src/s3/ensureBucket';

const CONFIG = {
  endpoint: 'http://localhost:19000',
  region: 'us-east-1',
  bucket: 'salt-sync-test',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
};

describe('ensureS3Bucket', () => {
  it('does not create the bucket when it already exists', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(HeadBucketCommand);
      return {};
    });
    const destroy = vi.fn();

    await ensureS3Bucket(CONFIG, { send, destroy });

    expect(send).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(0);
  });

  it('creates the bucket when head returns missing-bucket', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
      .mockResolvedValueOnce({});

    await ensureS3Bucket(CONFIG, { send });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(CreateBucketCommand);
  });

  it('ignores create races when another process created the bucket first', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } })
      .mockRejectedValueOnce({ name: 'BucketAlreadyOwnedByYou', $metadata: { httpStatusCode: 409 } });

    await expect(ensureS3Bucket(CONFIG, { send })).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
