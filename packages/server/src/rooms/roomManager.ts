import type { VaultId } from '@salt-sync/shared';
import type { SqliteDocumentStore } from '../persistence/sqliteDocumentStore.js';
import type { S3SnapshotStore } from '../snapshots/s3SnapshotStore.js';
import { VaultRoom } from './vaultRoom.js';

export class RoomManager {
  private readonly rooms = new Map<VaultId, VaultRoom>();

  constructor(
    private readonly store: SqliteDocumentStore,
    private readonly snapshotStore: S3SnapshotStore | null = null,
  ) {}

  async getOrCreate(vaultId: VaultId): Promise<VaultRoom> {
    let room = this.rooms.get(vaultId);
    if (!room) {
      room = new VaultRoom(vaultId, this.store, this.snapshotStore);
      this.rooms.set(vaultId, room);
    }
    return room;
  }

  get(vaultId: VaultId): VaultRoom | null {
    return this.rooms.get(vaultId) ?? null;
  }

  /** 返回所有已加载的 room（含 vaultId 及基本元信息） */
  listActive(): VaultRoom[] {
    return [...this.rooms.values()];
  }

  async disposeIdleRooms(): Promise<void> {
    for (const [vaultId, room] of this.rooms) {
      const disposed = await room.disposeIfIdle();
      if (disposed) {
        this.rooms.delete(vaultId);
      }
    }
  }
}
