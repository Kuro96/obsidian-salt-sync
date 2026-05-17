# SERVER KNOWLEDGE BASE

## OVERVIEW

Node server for sync rooms, binary WebSocket transport, SQLite checkpoint+journal persistence, S3/MinIO blob and snapshot storage, HTTP file APIs, and admin APIs.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Process startup | `src/index.ts` | Env, SQLite/WAL, migrations, S3 stores, listen, idle sweep. |
| App composition | `src/app.ts` | HTTP routes, WS upgrade, hello/auth/schema checks. |
| Room state | `src/rooms/vaultRoom.ts` | Y.Doc, sessions, awareness, persistence, snapshots, restore. |
| Room cache | `src/rooms/roomManager.ts` | Lazy `VaultRoom` creation and idle disposal. |
| SQLite store | `src/persistence/sqliteDocumentStore.ts` | Checkpoint+journal with SHA-256 verification. |
| Migrations | `src/persistence/migrations.ts` | Schema version boundary. |
| Auth | `src/auth.ts` | Env fallback, per-vault token, DB token mode. |
| DB tokens | `src/auth/syncTokenStore.ts` | Token CRUD, rotate, revoke, expiry, `hasAny()` cache. |
| Blob API | `src/blobs/blobRouter.ts` | exists/PUT/GET/GC. |
| Blob S3 store | `src/blobs/s3BlobStore.ts` | S3 key convention and object IO. |
| Snapshot API | `src/snapshots/snapshotRouter.ts` | create/list/get. |
| Snapshot store | `src/snapshots/s3SnapshotStore.ts` | `.bin` payload + `.meta.json`, prune. |
| File routes | `src/files/fileRouter.ts` | Current file, snapshot file, ZIP export. |
| Admin shell | `src/admin/adminRouter.ts` | Public `/admin` HTML and `/admin/app.js`. |
| Admin API | `src/admin/adminApiRouter.ts` | Protected overview/config/tokens/snapshots/GC/cleanup. |
| S3 bootstrap | `src/s3/ensureBucket.ts` | Head/create bucket with race handling. |

## CONVENTIONS

- `createApp()` has no background lifecycle ownership beyond HTTP/WS close; `index.ts` owns process timers and shutdown.
- Route order in `app.ts` matters: `/admin/api/*` before blob/file/snapshot routes; public admin shell last.
- WebSocket upgrade only accepts `/vault/sync/:vaultId` and the first frame must be `hello`.
- `SCHEMA_VERSION` mismatch closes the socket before attaching a room.
- `VaultRoom.load()` applies checkpoint and deltas with origin `load`, then initializes `sys` metadata with origin `init`.
- `VaultRoom.saveNow()` writes incremental updates from `lastSavedSv`; empty updates are skipped.
- Blob GC must load the room and include snapshot-referenced blob hashes before deleting orphans.
- DB token mode is global: once any DB token exists, sync auth stops accepting env fallback tokens.

## ANTI-PATTERNS

- Do not protect `/admin` HTML as if it were authenticated. Only `/admin/api/*` requires admin token.
- Do not GC blobs from an unloaded/empty live-hash view.
- Do not change frame tags or `TransportMessage` shape only on server; shared/plugin must change together.
- Do not bypass `SqliteDocumentStore` hash checks when loading checkpoint/journal payloads.
- Do not put admin SPA code under `src/admin/`; browser entry is `admin-src/main.tsx`.
- Do not assume env tokens remain valid after creating DB tokens.

## TESTS

```bash
corepack pnpm --filter @salt-sync/server test
corepack pnpm --filter @salt-sync/server test -- test/vaultRoom.test.ts
corepack pnpm --filter @salt-sync/server test -- test/sqliteDocumentStore.test.ts
corepack pnpm --filter @salt-sync/server test -- test/auth.test.ts
corepack pnpm --filter @salt-sync/server test -- test/integration/ws.test.ts
corepack pnpm --filter @salt-sync/server test -- test/integration/fileRouter.test.ts
corepack pnpm --filter @salt-sync/server test -- test/integration/blobs.test.ts
corepack pnpm --filter @salt-sync/server test -- test/integration/snapshots.test.ts
corepack pnpm --filter @salt-sync/server test -- test/integration/adminApi.test.ts
```

## NOTES

- MinIO-backed tests probe `http://localhost:19000/minio/health/live` and skip unavailable S3 branches.
- `test/helpers/integrationServer.ts` starts real HTTP/WS with in-memory SQLite and temporary env overrides.
- `admin-src/App.tsx` is large and browser-only; `server` build bundles it into `dist/admin.js`.
- Local full stack: `docker compose -f docker/docker-compose.yml up -d --build`.
