import type { BlobHash } from '@salt-sync/shared';

interface BlobHashCacheEntry {
  mtime: number;
  size: number;
  hash: BlobHash;
}

export class BlobHashCache {
  private readonly entries = new Map<string, BlobHashCacheEntry>();

  has(path: string): boolean {
    return this.entries.has(path);
  }

  get(path: string, mtime: number, size: number): BlobHash | null {
    const entry = this.entries.get(path);
    if (!entry) return null;
    return entry.mtime === mtime && entry.size === size ? entry.hash : null;
  }

  peek(path: string): BlobHash | null {
    return this.entries.get(path)?.hash ?? null;
  }

  set(path: string, mtime: number, size: number, hash: BlobHash): void {
    this.entries.set(path, { mtime, size, hash });
  }

  delete(path: string): void {
    this.entries.delete(path);
  }

  clear(): void {
    this.entries.clear();
  }
}
