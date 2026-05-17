# PLUGIN SYNC KNOWLEDGE BASE

## OVERVIEW

Core sync domain. One `VaultSyncEngine` runs per primary vault or shared mount and coordinates markdown, blobs, editor bindings, transport, local cache, and path translation.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Scope lifecycle | `syncManager.ts` | Creates engines, routes snapshot scopes, validates mount overlap. |
| Startup sequence | `vaultSync.ts` | Cache restore, WS auth, initial sync, reconcile, blob maintenance, editor bind. |
| Markdown disk sync | `filesystemBridge.ts` | Dirty queue, diff import, flush queue, echo suppression. |
| Markdown tombstones | `markdownTombstoneState.ts` | Receipt provenance and replay decisions. |
| Blob sync | `blobSync.ts` | Upload/download/tombstone/candidate/runtime state. |
| Blob hash cache | `blobHashCache.ts` | mtime+size keyed SHA-256 cache. |
| Editor binding | `editorBinding.ts` | yCollab extension, health checks, heal/rebind. |
| Host CM6 access | `hostCm6.ts` | Probe/reconfigure Obsidian's host editor view. |
| Transport | `roomClient.ts` | Auth handshake, binary frames, reconnect backoff. |
| User ignore | `userIgnore.ts` | Optional gitignore-like vault ignore file. |
| Path guards | `pathSafety.ts` | Shared mount overlap validation and ignored path bridge. |

## CORE FLOW

1. Construct `BlobSync` and enter startup gate.
2. Load IndexedDB cache and apply Y.Doc update with origin `cache`.
3. Register outbound `ydoc.on('update')` and inbound `afterTransaction` side effects.
4. Connect WebSocket and register Obsidian vault/workspace events.
5. On `auth_ok`, send state vector and await initial `sync_update`.
6. Complete initial sync: markdown reconcile, blob maintenance, bind open editors, validate bindings.

## INVARIANTS

- `pathToId` / `idToPath` map markdown paths to stable file ids; `docs` maps file id to `Y.Text`.
- `pathToBlob` and `blobTombstones` are attachment LWW surfaces. Tombstone wins for same key.
- Pending local blob deletions flush before pending remote downloads/deletes.
- Reconcile/rescan also flush pending deletions first.
- Markdown deletion compensation is conservative: only paths known locally on this device may become deletion tombstones.
- Blob restart-missing deletion needs concrete evidence hash equal to current remote ref hash.
- `knownLocalPaths` is migration/weak evidence only.
- `pendingLocalDeletions.hash === null` must not borrow a future remote hash.
- `BlobRef.updatedAt` is metadata, not causal version evidence.
- Ignored paths must not enter CRDT maps, runtime state, local imports, or local deletes.

## Y.DOC ORIGINS

| Origin | Meaning |
|--------|---------|
| `remote` | Server update applied to local Y.Doc. |
| `cache` | IndexedDB restore. |
| `load` | Server room load from persistence. |
| `local-disk` | Markdown imported from disk. |
| `local-meta` | Path/id map creation. |
| `local-blob` | Blob map/tombstone changes. |
| `local-rename` | Local markdown rename. |
| `local-delete` | Local markdown delete. |
| `restore` | Snapshot restore transaction. |

## ANTI-PATTERNS

- Do not reorder startup gates without checking `VaultSyncEngine.completeInitialSync()` and `BlobSync.openRemoteApplyGate()`.
- Do not write remote flushes to open files without considering binding health and recent editor activity.
- Do not bypass per-path queues for markdown flush/import or blob operations.
- Do not recreate a tombstoned markdown path during remote side effects.
- Do not turn pure remote files on a new device into local deletes.
- Do not clear pending/candidate blob state without preserving the intended retry/download behavior.
- Do not use `hashCache.has()` as strong deletion evidence; only a concrete hash comparison matters.

## TESTS

```bash
corepack pnpm --filter @salt-sync/plugin test -- test/unit/vaultSync.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/unit/blobSync.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/unit/filesystemBridge.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/unit/editorBinding.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/unit/syncManager.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/e2e/twoEngine.test.ts
```

## NOTES

- Active plan context may exist at `.opencode/plans/safer-blob-deletion-semantics/`; use it for BlobSync deletion work.
- `filesystemBridge.ts` uses `fast-diff` via `applyDiffToYText`; do not replace with whole-text overwrites unless tests prove editor safety.
- `EditorBindingManager` handles ambiguous CM6 candidates; split panes and stale host views are expected cases.
