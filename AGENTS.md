# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
# Build all packages
corepack pnpm --filter @salt-sync/{shared,server,plugin} build

# Type check all packages
corepack pnpm -r typecheck

# Run all tests
corepack pnpm -r test

# Plugin bundle safety gate
corepack pnpm --filter @salt-sync/plugin build
corepack pnpm --filter @salt-sync/plugin check:bundle-safety
```

Always use `corepack pnpm` (not bare `pnpm`).

## Architecture

### Monorepo layout

- **`packages/shared`** — Types, protocol definitions, interfaces, constants, binary framing. Single source of truth for the WebSocket protocol and data model. Both server and plugin depend on this.
- **`packages/server`** — WebSocket server: SQLite+WAL persistence for Y.Doc state, S3 for blobs and snapshots, Express HTTP for blob upload/download and admin.
- **`packages/plugin`** — Obsidian plugin client: real-time sync via Yjs CRDT, CodeMirror 6 editor binding, IndexedDB local cache.

### Plugin sync architecture (the complex part)

The plugin runs one `VaultSyncEngine` per sync scope (primary vault + one per shared directory mount). Each engine owns:

1. **RoomClient** — WebSocket connection with auto-reconnect. Binary frame protocol (shared `encodeFrame`/`decodeFrame`). Auth handshake → `auth_ok` → state vector exchange → incremental `sync_update` messages.

2. **Y.Doc** — The CRDT document containing four key Y.Maps:
   - `pathToId` / `idToPath` — Markdown file path ↔ fileId mapping
   - `docs` — fileId → `Y.Text` (markdown content)
   - `fileTombstones` — Markdown deletion markers
   - `pathToBlob` — Attachment path → `BlobRef` (hash, size, contentType)
   - `blobTombstones` — Attachment deletion markers

3. **ObsidianFilesystemBridge** — Bidirectional sync between Y.Doc and disk for markdown:
   - Disk → CRDT: `markDirty` → debounced `drain` → `importFromDisk` (diff-based via `fast-diff`)
   - CRDT → Disk: `flushFile` → `vault.modify`/`vault.create`
   - Open/closed file split, deferred import, recent-editor-activity protection
   - Self-echo suppression via SHA-256 fingerprinting (`expectedWrites`, `expectedDeletes`)
   - Per-path write queue serialization

4. **EditorBindingManager** — Host CM6 + `yCollab` integration for live editing. Tracks live `EditorView`s, binds via `Compartment.reconfigure(...)`, and supports health check / heal / rebind.

5. **BlobSync** — Attachment sync with its own complexity:
   - Three-state gate: `startup-blocked` → `maintenance-blocked` → `open`
   - Per-path operation queue (`enqueuePathOperation`) for serializing upsert/delete races
   - `pendingLocalDeletions` for startup-window deletions (before shared model is synced)
   - `persistChain` for serialized IDB writes of runtime state
   - Hash cache (in-memory, mtime+size keyed) to avoid redundant SHA-256 computations
   - Startup flow: `enterStartupGate` → `restoreRuntimeState` (merge semantics) → `reconcile` → `openRemoteApplyGate`

### Startup sequence

1. Construct `BlobSync`, enter startup gate
2. Load local IDB cache → `Y.applyUpdate(ydoc, cached, 'cache')`
3. Register `ydoc.on('update')` (outbound) and `ydoc.on('afterTransaction')` (inbound)
4. Connect WebSocket, register vault file events
5. `auth_ok` → send state vector → await initial `sync_update`
6. `completeInitialSync` → `reconcile` (markdown) → `runBlobMaintenance` (restore → reconcile → open gate) → `bindAllOpenEditors` → `validateAllOpenBindings`

### Key design invariants

- **Y.Doc origins**: `'remote'` (server), `'cache'` (IDB restore), `'local-disk'` (import from disk), `'local-meta'` (path map changes), `'local-blob'` (blob transacts), `'local-rename'`, `'local-delete'`, `'restore'`. Update handlers filter on origin.
- **Markdown deletion compensation is conservative**: only markdown paths known to have existed locally on this device may be tombstoned during reconcile / external deletion handling; do not treat pure remote files on a new device as local deletes.
- **Tombstone wins**: When `pathToBlob` and `blobTombstones` have the same key (cross-device LWW), tombstone takes precedence — no download.
- **Pending deletions flush before remote apply**: `openRemoteApplyGate` calls `flushPendingLocalDeletions` before `flushPendingRemoteChanges` to prevent resurrection.
- **reconcile/rescan also flushes pending deletions first** (entry of `syncLocalAndRemoteBlobs`).

### Testing

- Plugin tests mock Obsidian APIs via `test/mocks/obsidian.ts` (`MockVault`, `MockWorkspace`, `requestUrl` wrapping `fetch`)
- vitest config aliases `obsidian` → the mock module
- Blob sync tests use `fake-indexeddb` for IDB and `vi.stubGlobal('fetch', fetchMock)` for HTTP
- `packages/plugin/test/e2e/twoEngine.test.ts` is the main cross-stack wiring test: text sync, delete, rename, reconnect catch-up, startup binding, stale binding rebind, snapshot restore propagation, plus blob/snapshot flows when MinIO is available
- `packages/plugin/scripts/check-bundle-safety.mjs` is the bundle gate for CM6 externalization and dynamic import regressions

### Path semantics

Two path systems throughout the codebase:
- **vaultPath** — Full Obsidian vault-relative path (includes mount prefix)
- **docPath** — Shared model path (mount prefix stripped)

`toDocPath` / `toVaultPath` are injected at construction. For the primary vault they're identity functions.
