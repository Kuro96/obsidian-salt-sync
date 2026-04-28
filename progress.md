# Tombstone Startup Refactor Progress

These docs are intentionally committed in `fix/tombstone-quarantine` for PR #2 on `Kuro96/obsidian-salt-sync` at the user's request, despite earlier PR #1 docs being removed.

## Phase 0: Planning Docs Only

- [x] Add root-level `PRD.md`.
- [x] Add root-level `progress.md`.
- [x] Do not modify production code.
- [x] Do not modify tests.

Validation:

- [x] `git diff -- PRD.md progress.md`

Completion criteria:

- [x] Only `PRD.md` and `progress.md` are changed.

## Phase 1: TDD Lock For Markdown Gate Gaps

Files/modules:

- `packages/plugin/test/unit/vaultSync.test.ts`
- `packages/plugin/test/e2e/twoEngine.test.ts`
- `packages/plugin/test/helpers/startEngine.ts` if a read-only mount helper is needed.

Checklist:

- [x] Add a unit test proving a `fileTombstones` entry received while markdown startup side effects are closed is replayed after gate open for read-only mounts.
- [x] Add a unit test proving `reconcileReadOnly()` skips flushing paths present in `fileTombstones`.
- [x] Add a unit test proving a live remote markdown tombstone arriving while `completeInitialSync()` is awaiting maintenance deletes the local file after startup completes.
- [x] Add a regression assertion that authoritative startup still clears polluted `fileTombstones` when a local markdown file is present.
- [x] Add or adjust e2e coverage for read-only shared mount markdown delete during startup if helper support exists.

Validation:

- [x] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts` RED: 3 expected failures for missing markdown tombstone replay/read-only skip behavior.

Completion criteria:

- [x] New tests fail against current code for the replay/read-only gaps.
- [x] Existing tests continue to compile.

## Phase 2: Markdown Gate State And Replay

Files/modules:

- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/test/unit/vaultSync.test.ts`

Checklist:

- [x] Replace `remoteFileDeleteSideEffectsOpen: boolean` with a markdown gate state equivalent to `startup-blocked | maintenance-blocked | open`.
- [x] Add a `pendingRemoteMarkdownDeletes` queue keyed by `docPath`.
- [x] Add helper methods for markdown gate transitions: enter startup, enter maintenance, open gate.
- [x] In `handleRemoteTransactionSideEffects()`, queue `fileTombstones` changes when gate is not open instead of dropping side effects.
- [x] When gate is open, apply markdown tombstone side effects through one helper that unbinds editors, notifies bridge closed, and deletes the local file.
- [x] On markdown gate open, queue/replay existing `fileTombstones` so startup baseline tombstones are handled consistently by mode.
- [x] Ensure authoritative startup can still clear polluted markdown tombstones before replay.

Validation:

- [x] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts`
- [x] `corepack pnpm -r typecheck`

Completion criteria:

- [x] Phase 1 markdown unit tests pass.
- [x] No blob tests are changed in this phase.

## Phase 3: Read-Only Markdown Reconcile Semantics

Files/modules:

- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/test/unit/vaultSync.test.ts`

Checklist:

- [x] Make `reconcileReadOnly()` collect `pathToId` paths excluding paths present in `fileTombstones`.
- [x] Make `reconcileReadOnly()` queue existing `fileTombstones` for local delete replay after the markdown gate opens.
- [x] Confirm read-only mounts still do not register local vault file event listeners.
- [x] Confirm read-only mounts still do not send local Y.Doc updates from `ydoc.on('update')`.

Validation:

- [x] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts`

Completion criteria:

- [x] Read-only markdown never writes tombstoned files to disk during startup.
- [x] Read-only markdown deletes local files for remote tombstones after startup gate open.

## Phase 4: Blob Alignment Check

Files/modules:

- `packages/plugin/src/sync/blobSync.ts`
- `packages/plugin/test/unit/blobSync.test.ts`
- `packages/plugin/src/sync/vaultSync.ts` only if orchestration changes are needed.

Checklist:

- [x] Add tests only if the PRD matrix exposes missing blob behavior not already covered.
- [x] Verify `openRemoteApplyGate()` still calls `flushPendingLocalDeletions()`, `flushPendingLocalUpserts()`, `queueExistingRemoteTombstones()`, and `flushPendingRemoteChanges()` in safe order.
- [x] Verify conservative/read-only blob startup does not download paths that have both `pathToBlob` and `blobTombstones`.
- [x] Verify authoritative blob startup still clears polluted tombstones when local file recovery should win.
- [x] Avoid refactoring blob code unless tests show an actual asymmetry.

Validation:

- [x] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/blobSync.test.ts`
- [x] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts`

Completion criteria:

- [x] Blob behavior remains unchanged where already correct.
- [x] Any blob changes are covered by failing-first tests.

## Phase 5: Startup, Failure, And Reconnect Hardening

Files/modules:

- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/src/sync/blobSync.ts` if blob gate failure behavior needs matching tests.
- `packages/plugin/test/unit/vaultSync.test.ts`
- `packages/plugin/test/unit/blobSync.test.ts`

Checklist:

- [x] Add a unit test for `completeInitialSync()` where reconcile or blob maintenance throws, asserting gates do not remain permanently closed without retryable pending state.
- [x] Add a unit test for reconnect `handleAuthOk()` proving maintenance does not race live markdown deletes.
- [x] Wrap markdown gate opening in `finally` where safe, mirroring `runBlobMaintenance()`.
- [x] Confirm status notifications still happen after startup completion and after gate-open replay.
- [x] Confirm pending markdown deletes are idempotent across repeated gate opens.

Validation:

- [x] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts` RED: 2 expected failures for startup failure gate opening and reconnect maintenance gating.
- [x] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts`
- [x] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/blobSync.test.ts` (covered by full plugin test run)

Completion criteria:

- [x] Recoverable startup failures do not cause permanent ignored remote deletes.
- [x] Reconnect path preserves gate semantics.

## Phase 6: End-To-End Coverage

Files/modules:

- `packages/plugin/test/e2e/twoEngine.test.ts`
- `packages/plugin/test/helpers/startEngine.ts`
- `packages/plugin/test/mocks/obsidian.ts` only if read-only mount behavior cannot be simulated cleanly.

Checklist:

- [x] Add e2e test for remote markdown delete propagated to a read-only mount after startup.
- [x] Evaluate e2e test for startup live markdown tombstone arriving while target engine is still in maintenance; do not add because it is not controllable without brittle sleeps in the current harness.
- [x] Keep e2e waits using `waitFor()` and observable state, not fixed timeouts.

Notes:

- Added deterministic read-only mount e2e coverage by starting a normal engine in the shared room and a second `VaultSyncEngine` as a read-only mount at `Shared/`; remote create/delete is asserted via observable vault state only.
- Did not add a startup-live tombstone e2e because the current harness has no clean control point to pause the target engine inside initial maintenance while injecting a remote delete. The deterministic guard remains the Phase 1/5 unit coverage that directly controls `completeInitialSync()`/maintenance ordering without fixed sleeps.

Validation:

- [x] `corepack pnpm --filter @salt-sync/plugin test test/e2e/twoEngine.test.ts`
- [x] `corepack pnpm --filter @salt-sync/plugin test -- test/e2e/twoEngine.test.ts` (passes but runs the package's full default test set because the extra `--` is forwarded to Vitest)

Completion criteria:

- [x] Full-stack behavior matches the PRD matrix for post-startup read-only markdown delete replay.
- [x] Tests are deterministic in local runs.

## Phase 7: Final Validation And Cleanup

Files/modules:

- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/src/sync/blobSync.ts`
- All touched tests.

Checklist:

- [x] Remove stale comments that describe the old boolean markdown gate.
- [x] Keep new comments concise and behavior-focused.
- [x] Check for naming parity between markdown and blob gate concepts.
- [x] Ensure no docs-only planning text leaks into production comments.

Validation:

- [x] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts` (covered by full plugin test run)
- [x] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/blobSync.test.ts` (covered by full plugin test run)
- [x] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/e2e/twoEngine.test.ts` (covered by full plugin test run; targeted e2e also passed as `corepack pnpm --filter @salt-sync/plugin test test/e2e/twoEngine.test.ts`)
- [x] `corepack pnpm -r typecheck`
- [x] `corepack pnpm --filter @salt-sync/plugin build`
- [x] `corepack pnpm --filter @salt-sync/plugin check:bundle-safety`

Completion criteria:

- [x] All validation commands pass.
- [x] Behavior matches `PRD.md` acceptance criteria.
- [x] Diff is limited to implementation/tests needed for the tombstone startup refactor plus these requested docs.
