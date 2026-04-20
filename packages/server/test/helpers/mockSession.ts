import type { TransportMessage } from '@salt-sync/shared';
import type { TransportSession, VaultId } from '@salt-sync/shared';

export class MockSession implements TransportSession {
  readonly id: string;
  readonly vaultId: VaultId;
  readonly outbox: TransportMessage[] = [];
  private msgHandler: ((m: TransportMessage) => Promise<void> | void) | null = null;
  private closeHandler: (() => Promise<void> | void) | null = null;

  constructor(id: string, vaultId: VaultId) {
    this.id = id;
    this.vaultId = vaultId;
  }

  send(message: TransportMessage): Promise<void> {
    this.outbox.push(message);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.closeHandler) await this.closeHandler();
  }

  onMessage(handler: (m: TransportMessage) => Promise<void> | void): void {
    this.msgHandler = handler;
  }

  onClose(handler: () => Promise<void> | void): void {
    this.closeHandler = handler;
  }

  /** Simulate receiving a message from this client */
  async receive(m: TransportMessage): Promise<void> {
    if (this.msgHandler) await this.msgHandler(m);
  }

  /** Drain messages of a given type */
  popByType<T extends TransportMessage['type']>(
    type: T,
  ): Extract<TransportMessage, { type: T }>[] {
    const kept: TransportMessage[] = [];
    const taken: Extract<TransportMessage, { type: T }>[] = [];
    for (const m of this.outbox) {
      if (m.type === type) taken.push(m as Extract<TransportMessage, { type: T }>);
      else kept.push(m);
    }
    this.outbox.length = 0;
    this.outbox.push(...kept);
    return taken;
  }
}
