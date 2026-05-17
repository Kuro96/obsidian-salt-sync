# PLUGIN KNOWLEDGE BASE

## OVERVIEW

Obsidian plugin package. Thin shell/UI around a complex sync core built from Yjs, WebSocket frames, CodeMirror 6/yCollab, and IndexedDB runtime state.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Plugin commands/lifecycle | `src/main.ts` | Commands, file menu, settings tab, sync start/stop. |
| Settings model | `src/settings.ts` | Persisted settings plus runtime device fields. |
| Primary + mount engines | `src/sync/syncManager.ts` | Constructs one `VaultSyncEngine` per sync scope. |
| Sync engine | `src/sync/vaultSync.ts` | Y.Doc owner and startup/shutdown orchestration. |
| Attachments | `src/sync/blobSync.ts` | Blob refs, tombstones, candidate deletes, runtime state. |
| Markdown disk bridge | `src/sync/filesystemBridge.ts` | File events, imports, flushes, echo suppression. |
| Editor collaboration | `src/sync/editorBinding.ts` | CM6/yCollab binding, heal, rebind. |
| Transport | `src/sync/roomClient.ts` | WebSocket reconnect and binary frame protocol. |
| Local persistence | `src/storage/indexedDbStore.ts` | Y.Doc cache, pending markdown/blob state, device id. |
| Settings UI | `src/components/` | React settings sections and status badge. |
| Snapshot/diff modals | `src/ui/` | Obsidian modals for scope, snapshot, diff, restore. |
| Obsidian test mock | `test/mocks/obsidian.ts` | Vault/workspace/plugin/requestUrl behavior. |
| Full-stack e2e | `test/e2e/twoEngine.test.ts` | Real server + two engines + optional MinIO. |

## CONVENTIONS

- Keep `src/main.ts` and UI components thin. Sync rules belong in `src/sync/`.
- `VaultSyncEngine` is the only object that owns Y.Doc, `RoomClient`, `BlobSync`, `ObsidianFilesystemBridge`, and `EditorBindingManager` together.
- Use `SyncManager` for all primary-vault/shared-mount lifecycle and scope routing.
- `vaultPath` is Obsidian vault-relative and may include a shared mount prefix; `docPath` is the shared model path.
- `toDocPath` / `toVaultPath` are injected into bridge/blob/binding code. Do not recompute mount stripping ad hoc.
- Runtime-only device identity is not written directly into synced `data.json`; device names are keyed by device id.
- Plugin tests run in Node with `obsidian` aliased to `test/mocks/obsidian.ts`.
- Network/e2e tests must install globals from `test/helpers/setupNetwork.ts` before loading sync code.

## ANTI-PATTERNS

- Do not put sync invariants in React settings components or Obsidian modals.
- Do not treat `readOnly` mounts as local mirrors; they suppress local upload, not local extra files.
- Do not touch `dist/` by hand. Build it with `corepack pnpm --filter @salt-sync/plugin build`.
- Do not bundle CM6/Lezer/Obsidian/Electron. The bundle safety gate must pass.
- Do not use path-only blob evidence as deletion proof. See `src/sync/AGENTS.md`.

## TESTS

```bash
corepack pnpm --filter @salt-sync/plugin test
corepack pnpm --filter @salt-sync/plugin test -- test/unit/vaultSync.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/unit/blobSync.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/unit/filesystemBridge.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/unit/editorBinding.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/e2e/twoEngine.test.ts
corepack pnpm --filter @salt-sync/plugin build
corepack pnpm --filter @salt-sync/plugin check:bundle-safety
```

## NOTES

- `blobSync.test.ts` and `vaultSync.test.ts` are the largest regression anchors.
- `twoEngine.test.ts` covers cross-stack sync, reconnect, startup binding, stale rebind, snapshots, and optional blob flows when MinIO is available.
- `MockVault` requires parent folders before nested creates; use `seedFolder` or create folders explicitly.
- `MockWorkspace.getActiveViewOfType()` returns `null`; tests must seed leaves when open editor behavior matters.
