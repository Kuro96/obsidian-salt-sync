import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SCHEMA_VERSION,
  encodeFrame,
  decodeFrame,
} from '@salt-sync/shared';
import type {
  TransportClient,
  TransportMessage,
  ConnectInput,
  ConnectionStatus,
} from '@salt-sync/shared';

export class RoomClient implements TransportClient {
  private ws: WebSocket | null = null;
  private input: ConnectInput | null = null;
  private status: ConnectionStatus = 'idle';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private initialConnectPending = false;
  private connectPromise: { resolve: () => void; reject: (error: Error) => void } | null = null;

  private messageHandlers: Array<(msg: TransportMessage) => Promise<void> | void> = [];
  private statusHandlers: Array<(status: ConnectionStatus) => void> = [];

  async connect(input: ConnectInput): Promise<void> {
    this.input = input;
    this.destroyed = false;
    this.initialConnectPending = true;
    return new Promise<void>((resolve, reject) => {
      this.connectPromise = { resolve, reject };
      this.openSocket();
    });
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, 'disconnect');
    this.ws = null;
    this.rejectInitialConnect(new Error('disconnect'));
    this.setStatus('closed');
  }

  async send(message: TransportMessage): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(toExactArrayBuffer(encodeFrame(message)));
    }
  }

  onMessage(handler: (message: TransportMessage) => Promise<void> | void): void {
    this.messageHandlers.push(handler);
  }

  onStatusChange(handler: (status: ConnectionStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private openSocket(): void {
    if (!this.input || this.destroyed) return;

    const { serverUrl, vaultId } = this.input;
    const url = `${serverUrl}/vault/sync/${encodeURIComponent(vaultId)}`;

    this.setStatus('connecting');
    const ws = new WebSocket(url);
    // Electron/native WebSocket: default is 'blob' which would require an async
    // read; switching to arraybuffer keeps the onmessage handler synchronous.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.destroyed) { ws.close(); return; }
      this.reconnectAttempts = 0;
      this.resolveInitialConnect();
      this.setStatus('connected');

      // Send hello immediately after connection
      ws.send(toExactArrayBuffer(encodeFrame({
        type: 'hello',
        token: this.input!.token,
        deviceId: this.input!.deviceId,
        deviceName: this.input!.deviceName,
        schemaVersion: SCHEMA_VERSION,
      })));
    };

    ws.onmessage = (event) => {
      try {
        const data = event.data;
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data as ArrayBufferView as unknown as ArrayBuffer);
        const msg = decodeFrame(bytes);
        for (const h of this.messageHandlers) h(msg);
      } catch (err) {
        console.error('[RoomClient] message parse error:', err);
      }
    };

    ws.onclose = (event) => {
      if (this.initialConnectPending) {
        this.rejectInitialConnect(
          new Error(`WebSocket closed before connection was established (${event.code}: ${event.reason || 'no reason'})`),
        );
        this.setStatus('failed');
        return;
      }
      if (this.destroyed) return;
      console.warn(`[RoomClient] disconnected (${event.code}): ${event.reason}`);
      this.scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[RoomClient] ws error:', err);
      if (this.initialConnectPending) {
        this.rejectInitialConnect(new Error('WebSocket connection failed'));
      }
    };
  }

  private resolveInitialConnect(): void {
    if (!this.connectPromise) return;
    const { resolve } = this.connectPromise;
    this.connectPromise = null;
    this.initialConnectPending = false;
    resolve();
  }

  private rejectInitialConnect(error: Error): void {
    if (!this.connectPromise) return;
    const { reject } = this.connectPromise;
    this.connectPromise = null;
    this.initialConnectPending = false;
    reject(error);
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.setStatus('reconnecting');
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;
    console.log(`[RoomClient] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, delay);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const h of this.statusHandlers) h(status);
  }
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
