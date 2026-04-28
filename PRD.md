# Tombstone Startup Refactor PRD

These docs are intentionally committed in `fix/tombstone-quarantine` for PR #2 on `Kuro96/obsidian-salt-sync` at the user's request, despite earlier PR #1 docs being removed.

## Goals

- Replace symptom-by-symptom tombstone startup fixes with one explicit deletion-side-effect architecture for markdown and blobs.
- Make startup behavior deterministic across primary vaults, writable shared mounts, and read-only shared mounts.
- Encode deletion semantics for `authoritative`, `conservative`, and `read-only` modes as a complete behavior matrix.
- Preserve local user data during startup when server tombstones may be polluted or stale.
- Ensure live remote deletions that arrive during startup are replayed after gates open instead of being ignored forever.
- Require TDD-first implementation: every phase starts by adding or tightening failing tests before production changes.

## Scope

- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/src/sync/blobSync.ts`
- `packages/plugin/src/sync/filesystemBridge.ts` only if bridge APIs need small side-effect helpers.
- `packages/plugin/test/unit/vaultSync.test.ts`
- `packages/plugin/test/unit/blobSync.test.ts`
- `packages/plugin/test/e2e/twoEngine.test.ts`
- Test helpers under `packages/plugin/test/helpers/*` only if needed to exercise startup ordering.

## Non-Goals

- No server protocol or shared schema changes.
- No rewrite of Yjs document layout: keep `pathToId`, `idToPath`, `docs`, `fileTombstones`, `pathToBlob`, and `blobTombstones`.
- No broad filesystem bridge rewrite.
- No UI/settings changes.
- No attempt to repair arbitrary historical server pollution beyond deterministic startup handling and existing tombstone clearing rules.

## Constraints

- Use `corepack pnpm`, never bare `pnpm`.
- Keep path semantics intact: `docPath` in shared model, `vaultPath` on disk, translated by `toDocPath`/`toVaultPath`.
- Preserve read-only mounts as remote-to-local only: no local Y.Doc updates are sent by read-only mounts.
- Preserve conservative deletion compensation: markdown deletion compensation only tombstones paths known to have existed locally on this device; blob deletion compensation uses `knownLocalPaths`/hash cache/runtime state.
- Preserve tombstone-wins behavior when metadata and tombstone coexist for the same blob path.
- Do not drop local files because a startup baseline tombstone exists unless the mode explicitly says remote tombstones are authoritative.
- Gate opening must run in `finally` paths where possible so failures do not leave deletion side effects closed forever.

## Current Problem Analysis

`VaultSyncEngine` and `BlobSync` currently solve the same startup hazard differently.

- Markdown in `vaultSync.ts` uses `remoteFileDeleteSideEffectsOpen: boolean`.
- Blob sync in `blobSync.ts` uses `BlobApplyGateState = 'startup-blocked' | 'maintenance-blocked' | 'open'` plus pending queues.
- Markdown tombstones received while `remoteFileDeleteSideEffectsOpen` is false are retained in `fileTombstones` but not queued.
- Blob tombstones received while startup-blocked are not immediately applied, but `openRemoteApplyGate()` calls `queueExistingRemoteTombstones()` and replays existing tombstones.
- Read-only markdown startup calls `reconcileReadOnly()`, which flushes `pathToId` files to disk but is not tombstone-aware and does not replay `fileTombstones` after the gate opens.
- Because `sync_update` handling is async, “gate closed” can include both startup baseline state and live updates that arrive during startup maintenance. Treating all gate-closed tombstones as discard/quarantine loses legitimate live deletes.
- `runBlobMaintenance()` uses `finally` to open the blob gate, but markdown gate opening is split across `completeInitialSync()` and has no reusable state machine.
- Reconnect path in `handleAuthOk()` reruns reconcile/blob maintenance after sending state vector, but markdown deletion side effects are already open and do not have a maintenance-blocked mode.

## Desired Architecture

Introduce a shared deletion-side-effect concept in `VaultSyncEngine` that mirrors the useful parts of `BlobSync` without overgeneralizing prematurely.

- Replace markdown boolean gate with explicit markdown state: `startup-blocked`, `maintenance-blocked`, `open`.
- Track markdown remote deletes in a pending queue when side effects cannot run immediately.
- On gate open, replay existing `fileTombstones` and queued live tombstones using mode-aware rules.
- Keep blob state machine but align names/semantics with markdown where practical.
- Make `reconcileReadOnly()` tombstone-aware: it must not flush files that are tombstoned, and it must delete local files for remote tombstones at the correct gate phase.
- Distinguish “startup baseline tombstone” from “live tombstone received during startup” by explicit transaction timing/queueing rather than relying on the gate boolean alone.
- Centralize mode decisions so tests assert behavior from the matrix below rather than individual historical bugs.

## Behavior Matrix

Definitions:

- `startup baseline`: tombstone already present after cache/server initial state is applied before startup maintenance finishes.
- `live update during startup`: remote tombstone transaction observed while gate is `startup-blocked` or `maintenance-blocked` after the engine has begun startup.
- `gate-open update`: remote tombstone transaction observed while gate is `open`.
- `authoritative`: writable primary/writable mount startup where local disk is allowed to repair stale server tombstones for present local files.
- `conservative`: writable logic that does not infer upload/delete from local-only state unless path was known locally; used by blob read-only maintenance today.
- `read-only`: shared mount with no local-to-remote writes; server model is authoritative for local materialization, but startup must not ignore live deletes.

| Kind | Mode | Startup Baseline Tombstone | Live Update During Startup | Gate-Open Update |
| --- | --- | --- | --- | --- |
| Markdown | authoritative | If local file exists, clear polluted `fileTombstones` and keep local file. If local file is absent and path was known locally, local delete compensation may write/keep tombstone. Do not flush tombstoned path. | Queue/replay after maintenance. If local file still exists and tombstone was not cleared by authoritative reconcile, delete local file and unbind editor. | Delete local file, notify bridge closed, unbind editor. |
| Markdown | conservative | Do not clear tombstone based only on local presence unless an explicit local write/upsert wins. Do not generate tombstones for unknown remote-only missing files. Do not flush tombstoned path. | Queue/replay after maintenance, then delete local file if tombstone still exists. | Delete local file, notify bridge closed, unbind editor. |
| Markdown | read-only | Server tombstone wins for local materialization. `reconcileReadOnly()` must skip flushing tombstoned paths and queue existing tombstones for deletion once the gate opens. | Queue/replay after maintenance. Must not be ignored forever. | Delete local file, notify bridge closed, unbind editor. |
| Blob | authoritative | If local blob exists and matches/represents recovered content, clear polluted `blobTombstones` through existing authoritative reconcile/upsert behavior. If local blob is absent and known locally, write/keep tombstone. Tombstone wins over `pathToBlob` for downloads. | Queue/replay through `pendingRemoteDeletes`/existing tombstone replay after gate opens. | Delete local blob, clear pending downloads for same path. |
| Blob | conservative | Do not upload local-only blobs. Do not clear tombstones unless an explicit local upsert wins. Tombstone wins over `pathToBlob`; no download for tombstoned path. | Queue/replay after gate opens. | Delete local blob, clear pending downloads for same path. |
| Blob | read-only | Treat same as conservative for no local-to-remote writes, but server tombstones win for local materialization after startup gate opens. Do not download tombstoned path. | Queue/replay after gate opens. | Delete local blob, clear pending downloads for same path. |

## Phase Breakdown

1. Test lock current gaps.
2. Introduce markdown deletion gate state and pending/replay mechanics.
3. Make read-only markdown reconcile tombstone-aware.
4. Align startup/live update classification for markdown and blob.
5. Harden failure/reconnect paths so gates open or intentionally remain closed with retryable pending state.
6. Add e2e coverage for read-only startup/live tombstones.
7. Cleanup names/comments after behavior is locked by tests.

## Expected Outputs

- Failing tests first for markdown read-only replay, live startup tombstone replay, and tombstone-aware read-only materialization.
- Production changes in `vaultSync.ts` implementing markdown gate state and replay.
- Minimal adjustments in `blobSync.ts` only where matrix alignment reveals asymmetry.
- Updated unit/e2e tests proving markdown/blob parity for startup tombstones.
- No production/test changes before this PRD/progress planning commit.

## Acceptance Criteria

- Markdown tombstones received while startup/maintenance gate is closed are never silently ignored; they are either cleared by explicit authoritative repair or replayed when the gate opens.
- Read-only markdown mounts delete local tombstoned files after startup and never flush tombstoned markdown back to disk.
- Live remote markdown deletes arriving during async startup maintenance apply after maintenance completes.
- Blob behavior remains passing, including tombstone-wins, pending local deletion flush, and startup gate replay.
- Failure paths do not leave gates closed indefinitely after recoverable maintenance errors; pending work remains retryable and visible in tests.
- All relevant commands pass:
  - `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts`
  - `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/blobSync.test.ts`
  - `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/e2e/twoEngine.test.ts`
  - `corepack pnpm -r typecheck`
  - `corepack pnpm --filter @salt-sync/plugin build`
  - `corepack pnpm --filter @salt-sync/plugin check:bundle-safety`
