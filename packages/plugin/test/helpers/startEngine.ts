import { VaultSyncEngine } from '../../src/sync/vaultSync';
import type { SaltSyncSettings } from '../../src/settings';
import type { SharedDirectoryMount } from '@salt-sync/shared';
import { MockApp, MockPlugin, MockVault, MockWorkspace } from '../mocks/obsidian';

export interface StartEngineContext {
  vault: MockVault;
  workspace: MockWorkspace;
  app: MockApp;
  plugin: MockPlugin;
}

export interface StartedEngine {
  vault: MockVault;
  workspace: MockWorkspace;
  app: MockApp;
  plugin: MockPlugin;
  engine: VaultSyncEngine;
  settings: SaltSyncSettings;
  stop: () => Promise<void>;
}

export interface StartEngineOpts {
  serverUrl: string; // e.g. ws://127.0.0.1:1234
  vaultId: string;
  token: string;
  deviceId: string;
  mount?: SharedDirectoryMount;
  beforeStart?: (context: StartEngineContext) => void | Promise<void>;
}

/**
 * Build a VaultSyncEngine bound to a fresh MockApp/MockVault and start it
 * against a real test server. Caller is responsible for calling stop() in
 * afterEach to close the WS and clear timers.
 */
export async function startEngine(opts: StartEngineOpts): Promise<StartedEngine> {
  const vault = new MockVault();
  const workspace = new MockWorkspace();
  const app = new MockApp(vault, workspace);
  const plugin = new MockPlugin(app);

  await opts.beforeStart?.({ vault, workspace, app, plugin });

  const settings: SaltSyncSettings = {
    serverUrl: opts.serverUrl,
    vaultId: opts.vaultId,
    token: opts.token,
    deviceId: opts.deviceId,
    deviceName: opts.deviceId,
    enabled: true,
    sharedMounts: opts.mount ? [opts.mount] : [],
  };

  // Cast through unknown because VaultSyncEngine expects an obsidian Plugin,
  // and our mock is a structural subset that satisfies all calls made by start().
  const engine = new VaultSyncEngine(plugin as unknown as never, settings, opts.mount ?? null);
  await engine.start();

  return {
    vault,
    workspace,
    app,
    plugin,
    engine,
    settings,
    async stop() {
      await engine.stop();
    },
  };
}

/** Wait until predicate() returns true, or throw after timeoutMs. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
