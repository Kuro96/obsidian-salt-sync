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

- [ ] Add a unit test proving a `fileTombstones` entry received while markdown startup side effects are closed is replayed after gate open for read-only mounts.
- [ ] Add a unit test proving `reconcileReadOnly()` skips flushing paths present in `fileTombstones`.
- [ ] Add a unit test proving a live remote markdown tombstone arriving while `completeInitialSync()` is awaiting maintenance deletes the local file after startup completes.
- [ ] Add a regression assertion that authoritative startup still clears polluted `fileTombstones` when a local markdown file is present.
- [ ] Add or adjust e2e coverage for read-only shared mount markdown delete during startup if helper support exists.

Validation:

- [ ] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts`

Completion criteria:

- [ ] New tests fail against current code for the replay/read-only gaps.
- [ ] Existing tests continue to compile.

## Phase 2: Markdown Gate State And Replay

Files/modules:

- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/test/unit/vaultSync.test.ts`

Checklist:

- [ ] Replace `remoteFileDeleteSideEffectsOpen: boolean` with a markdown gate state equivalent to `startup-blocked | maintenance-blocked | open`.
- [ ] Add a `pendingRemoteMarkdownDeletes` queue keyed by `docPath`.
- [ ] Add helper methods for markdown gate transitions: enter startup, enter maintenance, open gate.
- [ ] In `handleRemoteTransactionSideEffects()`, queue `fileTombstones` changes when gate is not open instead of dropping side effects.
- [ ] When gate is open, apply markdown tombstone side effects through one helper that unbinds editors, notifies bridge closed, and deletes the local file.
- [ ] On markdown gate open, queue/replay existing `fileTombstones` so startup baseline tombstones are handled consistently by mode.
- [ ] Ensure authoritative startup can still clear polluted markdown tombstones before replay.

Validation:

- [ ] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts`
- [ ] `corepack pnpm -r typecheck`

Completion criteria:

- [ ] Phase 1 markdown unit tests pass.
- [ ] No blob tests are changed in this phase.

## Phase 3: Read-Only Markdown Reconcile Semantics

Files/modules:

- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/test/unit/vaultSync.test.ts`

Checklist:

- [ ] Make `reconcileReadOnly()` collect `pathToId` paths excluding paths present in `fileTombstones`.
- [ ] Make `reconcileReadOnly()` queue existing `fileTombstones` for local delete replay after the markdown gate opens.
- [ ] Confirm read-only mounts still do not register local vault file event listeners.
- [ ] Confirm read-only mounts still do not send local Y.Doc updates from `ydoc.on('update')`.

Validation:

- [ ] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts`

Completion criteria:

- [ ] Read-only markdown never writes tombstoned files to disk during startup.
- [ ] Read-only markdown deletes local files for remote tombstones after startup gate open.

## Phase 4: Blob Alignment Check

Files/modules:

- `packages/plugin/src/sync/blobSync.ts`
- `packages/plugin/test/unit/blobSync.test.ts`
- `packages/plugin/src/sync/vaultSync.ts` only if orchestration changes are needed.

Checklist:

- [ ] Add tests only if the PRD matrix exposes missing blob behavior not already covered.
- [ ] Verify `openRemoteApplyGate()` still calls `flushPendingLocalDeletions()`, `flushPendingLocalUpserts()`, `queueExistingRemoteTombstones()`, and `flushPendingRemoteChanges()` in safe order.
- [ ] Verify conservative/read-only blob startup does not download paths that have both `pathToBlob` and `blobTombstones`.
- [ ] Verify authoritative blob startup still clears polluted tombstones when local file recovery should win.
- [ ] Avoid refactoring blob code unless tests show an actual asymmetry.

Validation:

- [ ] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/blobSync.test.ts`
- [ ] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts`

Completion criteria:

- [ ] Blob behavior remains unchanged where already correct.
- [ ] Any blob changes are covered by failing-first tests.

## Phase 5: Startup, Failure, And Reconnect Hardening

Files/modules:

- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/src/sync/blobSync.ts` if blob gate failure behavior needs matching tests.
- `packages/plugin/test/unit/vaultSync.test.ts`
- `packages/plugin/test/unit/blobSync.test.ts`

Checklist:

- [ ] Add a unit test for `completeInitialSync()` where reconcile or blob maintenance throws, asserting gates do not remain permanently closed without retryable pending state.
- [ ] Add a unit test for reconnect `handleAuthOk()` proving maintenance does not race live markdown deletes.
- [ ] Wrap markdown gate opening in `finally` where safe, mirroring `runBlobMaintenance()`.
- [ ] Confirm status notifications still happen after startup completion and after gate-open replay.
- [ ] Confirm pending markdown deletes are idempotent across repeated gate opens.

Validation:

- [ ] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts`
- [ ] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/blobSync.test.ts`

Completion criteria:

- [ ] Recoverable startup failures do not cause permanent ignored remote deletes.
- [ ] Reconnect path preserves gate semantics.

## Phase 6: End-To-End Coverage

Files/modules:

- `packages/plugin/test/e2e/twoEngine.test.ts`
- `packages/plugin/test/helpers/startEngine.ts`
- `packages/plugin/test/mocks/obsidian.ts` only if read-only mount behavior cannot be simulated cleanly.

Checklist:

- [ ] Add e2e test for remote markdown delete propagated to a read-only mount after startup.
- [ ] Add e2e test for startup live markdown tombstone arriving while target engine is still in maintenance, if controllable without brittle sleeps.
- [ ] Keep e2e waits using `waitFor()` and observable state, not fixed timeouts.

Validation:

- [ ] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/e2e/twoEngine.test.ts`

Completion criteria:

- [ ] Full-stack behavior matches the PRD matrix for markdown delete replay.
- [ ] Tests are deterministic in local runs.

## Phase 7: Final Validation And Cleanup

Files/modules:

- `packages/plugin/src/sync/vaultSync.ts`
- `packages/plugin/src/sync/blobSync.ts`
- All touched tests.

Checklist:

- [ ] Remove stale comments that describe the old boolean markdown gate.
- [ ] Keep new comments concise and behavior-focused.
- [ ] Check for naming parity between markdown and blob gate concepts.
- [ ] Ensure no docs-only planning text leaks into production comments.

Validation:

- [ ] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/vaultSync.test.ts`
- [ ] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/unit/blobSync.test.ts`
- [ ] `corepack pnpm --filter @salt-sync/plugin test -- packages/plugin/test/e2e/twoEngine.test.ts`
- [ ] `corepack pnpm -r typecheck`
- [ ] `corepack pnpm --filter @salt-sync/plugin build`
- [ ] `corepack pnpm --filter @salt-sync/plugin check:bundle-safety`

Completion criteria:

- [ ] All validation commands pass.
- [ ] Behavior matches `PRD.md` acceptance criteria.
- [ ] Diff is limited to implementation/tests needed for the tombstone startup refactor plus these requested docs.
