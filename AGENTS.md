# PROJECT KNOWLEDGE BASE

**Generated:** 2026-05-17
**Commit:** ec1cb51
**Branch:** master

## OVERVIEW

Salt Sync is a pnpm workspace for an Obsidian real-time sync plugin, a Node WebSocket/HTTP server, and a shared protocol/type package. Core stack: TypeScript, Yjs CRDT, Obsidian API, CodeMirror 6, SQLite, S3/MinIO, Vitest, esbuild.

## STRUCTURE

```text
obsidian-salt-sync/
|-- packages/shared/   # protocol, frame format, shared types, path rules
|-- packages/server/   # WebSocket/HTTP sync server, persistence, S3, admin API
|-- packages/plugin/   # Obsidian plugin, sync engines, UI, IndexedDB cache
|-- docs/              # architecture notes and local get-started guide
|-- docker/            # full local stack compose + server Dockerfile
|-- deploy/nginx/      # public reverse-proxy template
`-- docker-compose.yml # MinIO-only local helper
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Workspace scripts | `package.json` | Root only orchestrates packages. |
| Shared protocol/types | `packages/shared/src/` | Single source of truth for server + plugin. |
| Binary WS frames | `packages/shared/src/framing.ts` | Keep tag mapping symmetric. |
| Server startup | `packages/server/src/index.ts` | Env, SQLite/WAL, S3, room manager. |
| HTTP + WS composition | `packages/server/src/app.ts` | Route order and hello/auth handshake. |
| Server room state | `packages/server/src/rooms/vaultRoom.ts` | Y.Doc persistence, awareness, snapshots. |
| Admin API | `packages/server/src/admin/adminApiRouter.ts` | Tokens, snapshots, GC, cleanup. |
| Obsidian plugin entry | `packages/plugin/src/main.ts` | Commands, lifecycle, settings tab. |
| Sync engine | `packages/plugin/src/sync/vaultSync.ts` | Y.Doc, startup, markdown/blob orchestration. |
| Blob sync | `packages/plugin/src/sync/blobSync.ts` | Attachment sync and deletion evidence. |
| Markdown disk bridge | `packages/plugin/src/sync/filesystemBridge.ts` | Disk <-> CRDT, write queues, echo suppression. |
| Editor binding | `packages/plugin/src/sync/editorBinding.ts` | CM6/yCollab binding health and repair. |
| Plugin persistence | `packages/plugin/src/storage/indexedDbStore.ts` | Local cache, pending state, runtime state. |
| Plugin e2e | `packages/plugin/test/e2e/twoEngine.test.ts` | Cross-stack wiring; MinIO branches skip if unavailable. |
| Server integration | `packages/server/test/integration/` | HTTP/WS/S3/admin API behavior. |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `SaltSyncPlugin` | class | `packages/plugin/src/main.ts` | Obsidian plugin shell and command registration. |
| `SyncManager` | class | `packages/plugin/src/sync/syncManager.ts` | Primary vault + shared mount engine lifecycle. |
| `VaultSyncEngine` | class | `packages/plugin/src/sync/vaultSync.ts` | One sync scope, owns Y.Doc and all sync subsystems. |
| `BlobSync` | class | `packages/plugin/src/sync/blobSync.ts` | Attachment upload/download/tombstone/runtime state. |
| `ObsidianFilesystemBridge` | class | `packages/plugin/src/sync/filesystemBridge.ts` | Markdown disk/CRDT bridge. |
| `EditorBindingManager` | class | `packages/plugin/src/sync/editorBinding.ts` | CM6/yCollab binding manager. |
| `RoomClient` | class | `packages/plugin/src/sync/roomClient.ts` | Binary WebSocket client. |
| `createApp` | function | `packages/server/src/app.ts` | HTTP routes + WS upgrade composition. |
| `VaultRoom` | class | `packages/server/src/rooms/vaultRoom.ts` | Server-side room Y.Doc, persistence, broadcast. |
| `RoomManager` | class | `packages/server/src/rooms/roomManager.ts` | Lazy room cache and idle disposal. |
| `SqliteDocumentStore` | class | `packages/server/src/persistence/sqliteDocumentStore.ts` | Checkpoint+journal persistence. |
| `AdminApiRouter` | class | `packages/server/src/admin/adminApiRouter.ts` | Protected admin API. |
| `encodeFrame` / `decodeFrame` | functions | `packages/shared/src/framing.ts` | Transport frame codec. |

## CONVENTIONS

- Always use `corepack pnpm`, not bare `pnpm`.
- Workspace scope is only `packages/*`; generated `dist/`, `data/`, `tmp/`, and `.opencode/` are not product source.
- Root `package.json` orchestrates; package-specific behavior lives in each package's `package.json`.
- `shared` and `server` are ESM/Node16; `plugin` uses ESNext + Bundler + DOM/JSX for Obsidian/esbuild.
- No project references or path aliases; cross-package imports go through workspace packages, not deep source paths.
- Tests use Vitest with `test/**/*.test.ts`; plugin aliases `obsidian` to `test/mocks/obsidian.ts`.
- Path names are precise: `vaultPath` includes the Obsidian mount prefix; `docPath` is the shared-model path after stripping the mount prefix.
- Y.Doc origin strings are semantic control flow. Do not rename or collapse them casually: `remote`, `cache`, `load`, `local-disk`, `local-meta`, `local-blob`, `local-rename`, `local-delete`, `restore`.
- When changing structure, commands, tests, protocol boundaries, or sync invariants, update the nearest relevant `AGENTS.md` in the same change.

## ANTI-PATTERNS

- Do not use `knownLocalPaths` alone to confirm a blob tombstone. Path-only evidence is weak.
- Do not let `pendingLocalDeletions.hash === null` borrow a later remote hash.
- Do not tombstone a remote blob when evidence hash and current `pathToBlob` hash differ.
- Do not create a new blob tombstone without a current matching remote ref.
- Do not import, write, delete, or persist ignored paths such as Obsidian internals and Syncthing temp/conflict files.
- Do not treat `readOnly` shared mounts as strict local mirrors; they do not delete local extra files.
- Do not bundle Obsidian/Electron/CM6/Lezer into the plugin bundle. Run `check:bundle-safety` after plugin builds.
- Do not assume `/admin` HTML is protected. Protected surface is `/admin/api/*`.

## COMMANDS

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm -r typecheck
corepack pnpm -r test

corepack pnpm --filter @salt-sync/shared build
corepack pnpm --filter @salt-sync/server build
corepack pnpm --filter @salt-sync/plugin build
corepack pnpm --filter @salt-sync/plugin check:bundle-safety

SERVER_TOKEN=dev-token corepack pnpm dev:server
corepack pnpm --filter @salt-sync/server dev
corepack pnpm --filter @salt-sync/plugin dev

docker compose up -d
docker compose -f docker/docker-compose.yml up -d --build
```

## TEST TARGETS

```bash
corepack pnpm --filter @salt-sync/shared test -- test/framing.test.ts
corepack pnpm --filter @salt-sync/server test -- test/integration/ws.test.ts
corepack pnpm --filter @salt-sync/server test -- test/integration/blobs.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/unit/vaultSync.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/unit/blobSync.test.ts
corepack pnpm --filter @salt-sync/plugin test -- test/e2e/twoEngine.test.ts
```

## NOTES

- Node requirement is `>=22 <25`; CI uses Node 22 and pnpm 9.
- Plugin release artifacts are `packages/plugin/dist/main.js`, `packages/plugin/manifest.json`, and `packages/plugin/styles.css`.
- `packages/server` build is `tsc` plus an esbuild bundle for `admin-src/main.tsx`.
- `pnpm dev:server` watches server source but does not build the admin bundle first.
- MinIO defaults: S3 API `http://localhost:19000`, console `http://localhost:19001`, credentials `minioadmin/minioadmin`.
- Release tags use bare semver such as `0.4.1`, not `v0.4.1`.
- Active local planning context may exist under `.opencode/plans/*`; treat it as working context, not product docs.
