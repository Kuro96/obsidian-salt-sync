# SHARED KNOWLEDGE BASE

## OVERVIEW

Cross-package single source of truth for protocol messages, binary framing, shared data types, interfaces, constants, and ignored path rules.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Public exports | `src/index.ts` | Re-exports every shared module. |
| Message protocol | `src/protocol.ts` | `TransportMessage` union and handshake/update message shapes. |
| Binary frame codec | `src/framing.ts` | One-byte tag + JSON/binary body mapping. |
| Shared types | `src/types.ts` | Blob, tombstone, snapshot, config, cache, mount types. |
| Shared interfaces | `src/interfaces.ts` | Transport, room, store, bridge, engine contracts. |
| Constants | `src/constants.ts` | `SCHEMA_VERSION`, journal/snapshot/blob thresholds. |
| Ignored path segments | `src/ignoredPathRules.ts` | Obsidian/Syncthing/default-name filters. |
| Path helpers | `src/pathSafety.ts` | Normalize and ignored-path checks. |
| Framing tests | `test/framing.test.ts` | Codec and buffer-copy regressions. |
| Path tests | `test/pathSafety.test.ts` | Ignored-path behavior. |

## CONVENTIONS

- Consumers should import from `@salt-sync/shared`, not deep package internals.
- `package.json` exports only `.` with `dist/index.js` and `dist/index.d.ts`.
- Protocol and frame changes are cross-stack changes. Update server, plugin, and tests together.
- Data tags (`0x10-0x1f`) carry raw Yjs/awareness bytes; control/diag tags carry UTF-8 JSON with `type` encoded by tag.
- `decodeFrame()` slices binary payloads so callers do not retain the WebSocket receive buffer.
- `SCHEMA_VERSION` is handshake compatibility. Bump only when old clients/servers must reject each other.
- `pathSafety.ts` normalizes vault path strings and applies project ignore rules; it is not a filesystem path resolver.

## ANTI-PATTERNS

- Do not add message types without updating both `TYPE_TO_TAG` and `TAG_TO_TYPE`.
- Do not reuse frame tags for different semantics.
- Do not make plugin/server define local copies of shared protocol or tombstone types.
- Do not weaken ignored path rules without checking server cleanup, plugin imports, and existing tests.
- Do not treat `BlobRef.updatedAt` as causal ordering for deletion safety.

## TESTS

```bash
corepack pnpm --filter @salt-sync/shared test
corepack pnpm --filter @salt-sync/shared test -- test/framing.test.ts
corepack pnpm --filter @salt-sync/shared test -- test/pathSafety.test.ts
corepack pnpm --filter @salt-sync/shared build
```

## NOTES

- `BlobTombstone` and `FileTombstone` include optional provenance for old-format compatibility.
- `SharedDirectoryMount` drives plugin multi-engine path translation; changing it affects UI, sync manager, and tests.
- `SnapshotMeta.referencedBlobHashes` protects blobs from GC while snapshots reference them.
