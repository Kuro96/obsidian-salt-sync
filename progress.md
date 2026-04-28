# Delete-Safety Refactor Progress

## Overall status

- Phase 0 — repo exploration and planning: completed
- Phase 1 — path ownership and ignore policy: completed and verified
- Phase 2 — remote delete/rename safety guards: completed and verified
- Phase 3 — shared mount overlap validation: completed and verified
- Phase 4 — broader destructive-operation hardening: deferred/future scope

## Phase 0: Explore repo and define product scope

### Modules reviewed

- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/src/sync/blobSync.ts`
- `packages/plugin/src/sync/syncManager.ts`
- `packages/plugin/src/sync/filesystemBridge.ts`
- `packages/plugin/src/components/SharedMountsSettings.tsx`
- `packages/plugin/test/unit/*.test.ts`
- `packages/plugin/test/e2e/twoEngine.test.ts`

### Checklist

- [x] Identify paths that can issue local deletes from remote state.
- [x] Identify paths that can treat local missing files as tombstones.
- [x] Identify mount routing risks.
- [x] Create `PRD.md` with goals, constraints, phases, and acceptance criteria.
- [x] Create `progress.md` with executable phase checklists.

### Done criteria

- [x] The repo has explicit docs describing the refactor goal and staged execution plan.
- [x] The planned phases map directly to the observed Syncthing/Obsidian failure modes.

## Phase 1: Path ownership and ignore policy

### Modules changed

- Added `packages/plugin/src/sync/pathSafety.ts`
- Updated `packages/plugin/src/sync/vaultSync.ts`
- Updated `packages/plugin/src/sync/blobSync.ts`
- Updated `packages/plugin/src/sync/syncManager.ts`

### Checklist

- [x] Add `normalizeVaultPath()` for slash normalization and trailing slash cleanup.
- [x] Add `isPathIgnoredBySync()` for `.obsidian`, `.trash`, `.stfolder`, `.stversions`, `.stignore`, and `.sync-conflict-` artifacts.
- [x] Add `isSameOrChildPath()` to avoid prefix bugs such as `Shared` matching `SharedOther`.
- [x] Use the ignore policy in markdown engine routing.
- [x] Use the ignore policy in blob scans.
- [x] Keep mount engines from treating the mount folder itself as a sync file.

### Verification

- [x] Unit coverage added for ignored Obsidian/trash/Syncthing paths.
- [x] Unit coverage added for blob scans ignoring internal/artifact paths.
- [x] Existing e2e normal create/edit/delete/rename flows still pass.

### Done criteria

- [x] Internal Obsidian metadata and Syncthing artifacts are not treated as user sync content.
- [x] Segment-aware matching prevents sibling-prefix misrouting.

## Phase 2: Remote delete and rename safety guards

### Modules changed

- `packages/plugin/src/sync/blobSync.ts`
- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/test/mocks/obsidian.ts`
- `packages/plugin/test/unit/blobSync.test.ts`
- `packages/plugin/test/unit/vaultSync.test.ts`

### Checklist

- [x] Guard `BlobSync.deleteLocalFile()` so it only deletes objects with `TFile`-like file metadata and no-ops on folders.
- [x] Preserve normal remote blob delete behavior for real files.
- [x] Capture remote `pathToId` delete old values from `Y.MapEvent` before `afterTransaction` cleanup runs.
- [x] Only delete a removed markdown path when the same remote transaction proves exactly one target path now owns the removed file id.
- [x] Treat ambiguous `pathToId` removals as metadata-only changes, not local file delete instructions.
- [x] Keep existing remote rename behavior working for valid one-to-one renames.

### Verification

- [x] Unit coverage added for refusing to delete a folder at a blob path.
- [x] Unit coverage added for ambiguous remote `pathToId` removal returning no cleanup target.
- [x] Unit coverage added for valid same-transaction rename target detection.
- [x] Existing e2e rename test passes and confirms the old path is removed for a real rename.

### Done criteria

- [x] Remote blob tombstones cannot delete local folders.
- [x] Remote markdown cleanup cannot delete a local old path unless it is an unambiguous same-transaction rename source.
- [x] Normal remote delete and rename functionality remains intact.

## Phase 3: Shared mount overlap validation

### Modules changed

- `packages/plugin/src/sync/pathSafety.ts`
- `packages/plugin/src/sync/syncManager.ts`
- `packages/plugin/src/components/SharedMountsSettings.tsx`
- `packages/plugin/test/unit/syncManager.test.ts`

### Checklist

- [x] Add `validateSharedMountOverlaps()` for enabled mounts.
- [x] Reject duplicate mount paths after normalization.
- [x] Reject parent/child mount overlaps among enabled mounts.
- [x] Allow overlaps when one mount is disabled.
- [x] Enforce validation in `SyncManager` construction before engines start.
- [x] Surface the same validation in the settings UI before saving.

### Verification

- [x] Unit coverage added for duplicate enabled mount rejection.
- [x] Unit coverage added for parent/child enabled mount rejection.
- [x] Unit coverage added for disabled overlap allowance.

### Done criteria

- [x] A single vault path cannot be claimed by two enabled shared mount engines.
- [x] Invalid mount configuration is blocked both in UI and runtime construction.

## Phase 4: Future hardening / deferred scope

These items are intentionally not completed in this pass because they are broader behavior changes and need product decisions or schema work.

### Candidate checklist

- [ ] Add mass-delete guard/batch confirmation thresholds for remote tombstones and local missing-file reconciliation.
- [ ] Add tombstone provenance fields such as device id/name, source event, and timestamp in a schema-compatible way.
- [ ] Add an operator-visible quarantine/review queue for suspicious destructive operations.
- [ ] Add migration guidance for existing installs that already synced `.obsidian` or Syncthing artifacts.

### Done criteria for a future phase

- [ ] Bulk destructive changes require explicit policy handling instead of automatic delete propagation.
- [ ] Operators can inspect which device or code path produced a tombstone.

## Verification log

All verification below used Node `v22.21.1` from `/opt/data/node-v22.21.1-linux-x64/bin`.

- [x] `corepack pnpm install`
- [x] `corepack pnpm --filter @salt-sync/shared build`
- [x] `corepack pnpm --filter @salt-sync/plugin test` — 11 test files passed, 147 tests passed, 3 skipped.
- [x] `corepack pnpm --filter @salt-sync/plugin typecheck`
- [x] `corepack pnpm --filter @salt-sync/shared build`
- [x] `corepack pnpm --filter @salt-sync/server build`
- [x] `corepack pnpm --filter @salt-sync/plugin build`
- [x] `corepack pnpm -r typecheck`
