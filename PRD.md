# Delete-Safety Refactor PRD

## Background

A production investigation found repeated remote deletions of newly-created Obsidian notes and directories after synchronization. The failure pattern pointed to several high-risk paths in the plugin:

- Remote markdown tombstones delete local files directly.
- Remote `pathToId` removals without tombstones are treated as rename-source cleanup.
- Blob tombstone handling can call Obsidian `vault.delete()` on a `TAbstractFile`, which can be a folder.
- Blob scans and markdown routing do not share one ignore policy for Obsidian/Syncthing internal paths.
- Shared mount configurations can overlap, allowing the same vault path to be claimed by multiple sync engines.
- `.obsidian` plugin data and Syncthing artifacts can be observed as ordinary blob files.

This refactor reduces destructive-operation risk while preserving normal plugin behavior for ordinary file create, edit, delete, rename, and blob sync flows.

## Goals

1. Define a single path-safety policy for ignored/internal vault paths.
2. Prevent folder deletion through blob tombstone paths.
3. Make remote markdown rename cleanup conservative and transaction-proven.
4. Reject overlapping shared mount paths in both UI and runtime construction.
5. Add focused unit/e2e coverage proving safety guards do not break normal sync behavior.
6. Document remaining high-risk follow-up work that needs product/schema decisions.

## Non-goals

- Redesign the CRDT schema.
- Change server persistence or historical checkpoint format.
- Remove existing remote single-file delete semantics.
- Disable valid same-transaction markdown rename cleanup.
- Implement a full mass-delete quarantine system in this pass.
- Add tombstone provenance fields in this pass.

## Scope

### In scope

- `packages/plugin/src/sync/pathSafety.ts`
- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/src/sync/blobSync.ts`
- `packages/plugin/src/sync/syncManager.ts`
- `packages/plugin/src/components/SharedMountsSettings.tsx`
- Focused plugin unit/e2e tests and mocks

### Out of scope / future phase

- Server-side policy enforcement.
- Persisted tombstone provenance migrations.
- Operator approval UI for mass deletes.
- Recovery tooling for already-deleted user files.

## Constraints

- Existing single-file remote delete must continue to work.
- Existing normal markdown rename must continue to remove the old path and materialize the new path.
- Existing shared mount behavior must remain valid for non-overlapping enabled mounts.
- Ignored paths should be filtered consistently across markdown and blob flows.
- Changes should be small and targeted; avoid unrelated rewrites.
- Tests must run on the repo-supported Node engine (`>=22 <25`).

## Phase plan

### Phase 0: Explore and plan

**Objective:** Map delete-risk surfaces across the repo and document the refactor.

**Deliverables:**

- Root `PRD.md`
- Root `progress.md`
- Phase checklist that ties modules, behaviors, and completion criteria together

### Phase 1: Path ownership and ignore policy

**Objective:** Ensure Obsidian and Syncthing internal paths are never treated as user sync content.

**Required changes:**

- Add centralized helpers for path normalization, ignored-path detection, and segment-aware parent/child matching.
- Apply ignore policy in `VaultSyncEngine.isPathForThisEngine()`.
- Apply ignore policy in `BlobSync` local blob scanning.
- Replace naive prefix checks with segment-aware path ownership checks.

**Expected output:**

- `.obsidian`, `.trash`, `.stfolder`, `.stversions`, `.stignore`, and `.sync-conflict-` artifacts are ignored.
- `Shared` does not accidentally match `SharedOther`.

### Phase 2: Delete and rename safety guards

**Objective:** Keep normal deletes/renames working while preventing ambiguous or folder-destructive operations.

**Required changes:**

- Guard blob local deletion so only file objects are deleted; folder objects are ignored.
- Capture remote Yjs `pathToId` delete old values from map events.
- Delete an old markdown path for remote rename cleanup only when the same transaction provides exactly one matching target path for the removed file id.
- Treat ambiguous `pathToId` removal as metadata cleanup only.

**Expected output:**

- Remote blob tombstones cannot delete local folders.
- Ambiguous remote markdown path removals no longer delete local files.
- Valid markdown rename still removes the old path and creates the new path.

### Phase 3: Shared mount overlap validation

**Objective:** Prevent configuration that routes one vault path through multiple engines.

**Required changes:**

- Normalize mount paths before validation.
- Reject duplicate enabled mount paths.
- Reject parent/child overlaps among enabled mounts.
- Enforce validation in `SyncManager` construction.
- Surface validation in `SharedMountsSettings` UI.

**Expected output:**

- Invalid mount configuration is blocked before sync engines start.
- The settings UI uses the same validation semantics as runtime.

### Phase 4: Future destructive-operation hardening

**Objective:** Reduce risk of large-scale delete propagation and improve auditability.

**Candidate future work:**

- Mass-delete threshold/confirmation/quarantine for remote tombstones and local missing-file reconciliation.
- Tombstone provenance fields (`deletedByDeviceId`, `deletedByDeviceName`, `source`, `deletedAt`).
- Operator-visible suspicious delete review UI.
- Migration or cleanup guide for installs that already synced internal `.obsidian` paths.

## Acceptance criteria

- [x] `PRD.md` and `progress.md` exist at repo root and describe goals, constraints, phases, and executable checklists.
- [x] Ignored Obsidian/Syncthing paths are excluded from markdown routing and blob scans.
- [x] Blob tombstone cleanup cannot delete folders.
- [x] Ambiguous remote `pathToId` removals cannot delete local markdown files.
- [x] Valid same-transaction remote markdown rename still works.
- [x] Overlapping enabled shared mounts are rejected in runtime and settings UI.
- [x] Focused unit tests cover the new guards.
- [x] Existing plugin e2e sync flows still pass.
- [x] Build and typecheck pass for shared, server, and plugin packages.

## Verification commands

Use Node `>=22 <25`, then run:

```bash
corepack pnpm install
corepack pnpm --filter @salt-sync/shared build
corepack pnpm --filter @salt-sync/plugin test
corepack pnpm --filter @salt-sync/plugin typecheck
corepack pnpm --filter @salt-sync/shared build
corepack pnpm --filter @salt-sync/server build
corepack pnpm --filter @salt-sync/plugin build
corepack pnpm -r typecheck
```
