import { describe, expect, it } from 'vitest';
import { BlobHashCache } from '../../src/sync/blobHashCache';

describe('BlobHashCache', () => {
  it('returns cached hash only when mtime and size match', () => {
    const cache = new BlobHashCache();
    cache.set('assets/image.png', 100, 12, 'hash-a');

    expect(cache.get('assets/image.png', 100, 12)).toBe('hash-a');
    expect(cache.get('assets/image.png', 101, 12)).toBeNull();
    expect(cache.get('assets/image.png', 100, 13)).toBeNull();
  });

  it('deletes cache entries', () => {
    const cache = new BlobHashCache();
    cache.set('assets/image.png', 100, 12, 'hash-a');
    cache.delete('assets/image.png');
    expect(cache.get('assets/image.png', 100, 12)).toBeNull();
  });
});
