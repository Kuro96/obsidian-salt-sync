/**
 * E2E test environment setup:
 *   - polyfill IndexedDB so plugin's IndexedDbLocalCache (idb package) works
 *   - polyfill WebSocket so plugin's RoomClient can dial the test server
 *
 * Importing this file for side effects mutates global state; tests that
 * touch network/storage should import it once at the top.
 */
import 'fake-indexeddb/auto';
import { WebSocket as WsClient } from 'ws';

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket: unknown }).WebSocket = WsClient as unknown;
}
