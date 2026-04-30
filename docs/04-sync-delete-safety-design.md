# 同步删除安全性：问题分析与架构修复方案

> 状态：RFC Draft
> 日期：2026-04-30

## 1. 问题概述

同步引擎在**启动阶段**可能错误删除用户文件。根本原因是引擎启动时面临一个信息不完整的窗口期：本地缓存中的 tombstone 可能是"陈旧的服务端污染"，也可能是"真实的远端删除"，而引擎在完成与服务端的初始同步之前无法区分二者。

近期 PR #1 ~ #7 引入了 gate 状态机、tombstone 分类器、quarantine 等机制来缓解此问题，但仍存在以下未解决的缺陷。

## 2. 现有架构回顾

### 2.1 删除传播路径

```
┌─────────────────────────────────────────────────────────┐
│                    Markdown 路径                         │
│                                                         │
│  本地删除:                                               │
│    vault.on('delete') → handleLocalFileDeletion()       │
│      → writeLocalMarkdownTombstone()                    │
│      → Y.Doc: pathToId.delete, docs.delete,             │
│               fileTombstones.set                        │
│                                                         │
│  远端删除:                                               │
│    Y.Doc afterTransaction(remote)                       │
│      → recordMarkdownTombstoneTransaction()             │
│      → 分类 → gate open 时 applyRemoteMarkdownDelete()  │
│      → bridge.deleteFile() → vault.delete()             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                     Blob 路径                            │
│                                                         │
│  本地删除:                                               │
│    vault.on('delete') → handleLocalBlobDeletion()       │
│      → pendingLocalDeletions.set(path, hash)            │
│      → processLocalBlobDeletion() → blobTombstones.set  │
│                                                         │
│  远端删除:                                               │
│    handleRemoteBlobChanges(txn)                         │
│      → pendingRemoteDeletes.add(path)                   │
│      → gate open 时 flushPendingRemoteChanges()         │
│      → deleteLocalFile() → vault.delete()               │
└─────────────────────────────────────────────────────────┘
```

### 2.2 启动生命周期

```
start()
  ├─ markdownDeleteGateState = 'startup-blocked'
  ├─ blobSync.gateState = 'startup-blocked'
  ├─ 加载本地缓存 → Y.applyUpdate(cache) → tombstone 分类为 cache-startup
  ├─ 注册 vault 文件事件
  └─ 连接服务端
       ↓
  handleAuthOk() [首次]
  ├─ 发送 sync_state_vector
  └─ awaitingInitialSync = true
       ↓
  收到 sync_update → completeInitialSync()
  ├─ markdownDeleteGateState = 'maintenance-blocked'
  ├─ reconcile()
  │   ├─ 扫描磁盘 markdown 文件
  │   ├─ startup-baseline tombstone → quarantine + forceImportFromDisk → stale-cleared
  │   ├─ flushPendingLocalMarkdownDeletions(localDocPaths)
  │   └─ 物化远端独有的文件到磁盘
  ├─ runBlobMaintenance()
  │   ├─ restoreRuntimeState()
  │   └─ blobSync.reconcile(authoritative)
  └─ openMarkdownDeleteGate()
       ├─ markdownDeleteGateState = 'open'
       ├─ replay authoritative-delete + live-delete tombstones
       └─ flushPendingRemoteMarkdownDeletes()
```

### 2.3 Gate 状态机

```
  startup-blocked ──────→ maintenance-blocked ──────→ open
       │                        │                      │
  忽略远端 tombstone       分类 tombstone          立即执行 tombstone
  的删除副作用             但不执行删除             所有排队的删除
```

### 2.4 Tombstone 分类体系 (MarkdownTombstoneState)

| Kind | 来源 | 是否 Replayable |
|------|------|----------------|
| `ignored-local` | 本设备本地删除 / self-origin | 否 |
| `startup-baseline` (unclassified) | cache-startup / startup-remote | 否，等待分类 |
| `startup-baseline` (authoritative-delete) | 经 reconcile 确认 | 是 |
| `startup-baseline` (stale-cleared) | reconcile 发现本地存在 | 否 |
| `startup-baseline` (cancelled) | 用户重建同名文件 | 否 |
| `startup-baseline` (failed) | reconcile 出错 | 否 |
| `live-delete` | maintenance/reconnect/open | 是 |

## 3. 已识别缺陷

### 3.1 [Critical] 远端事务过早 flush pending 本地删除

**位置**: `vaultSync.ts:1032`

```typescript
private handleRemoteTransactionSideEffects(txn: Y.Transaction): void {
  this.recordMarkdownTombstoneTransaction(txn);
  this.flushPendingLocalMarkdownDeletions(new Set()); // ← 空集合!
  // ...
}
```

**问题**: 每次收到远端事务时，`flushPendingLocalMarkdownDeletions` 被传入空的 `localDocPaths`。该方法的语义是"如果 pending 路径不在 localDocPaths 中，就写 tombstone"。空集合意味着**所有 pending 都会被立即 flush**。

**影响场景**:
1. 引擎启动，用户在 reconcile 之前删除了 `foo.md`（无 fileId，加入 pending）
2. 远端事务到达（任意内容），触发 `handleRemoteTransactionSideEffects`
3. `flushPendingLocalMarkdownDeletions(new Set())` 执行
4. 如果此时 `foo.md` 恰好从远端获得了 fileId（pathToId 已有值），立即写 tombstone
5. 但文件可能仍在磁盘上（用户可能只是重命名后又改回来了）

**严重性**: 可能导致本地文件被误标记为 tombstone。

### 3.2 [Critical] doFlushFile 可以重建刚被删除的文件

**位置**: `filesystemBridge.ts:471-503`

```typescript
private async doFlushFile(docPath: string, generation: number): Promise<void> {
  if (this.remoteFlushQuarantine.has(docPath)) return;
  if (generation !== this.currentWriteGeneration(docPath)) return;

  const ytext = this.getYText(docPath);
  if (!ytext) return;

  const content = ytext.toString();
  // ...
  if (file) {
    await this.vault.modify(file, content);
  } else {
    await this.vault.create(vaultPath, content);  // ← 重建!
  }
}
```

**问题**: `doFlushFile` 不检查目标路径是否已有 tombstone。如果用户删除了文件，但此前已有一个远端更新调度了 `scheduleClosedWrite`，写队列中的 flush 会在删除之后执行，通过 `vault.create` 将文件重新创建出来。

**竞态时序**:
```
T1: 远端更新 foo.md → scheduleClosedWrite(foo.md, gen=1)
T2: 用户删除 foo.md → writeLocalMarkdownTombstone()
    → pathToId.delete → docs.delete → fileTombstones.set
T3: 写队列执行 doFlushFile(foo.md, gen=1)
    → getYText(foo.md) 返回 null（docs 已清空）→ 短路退出 ✓
```

当前代码因为 `docs.delete` 使得 `getYText` 返回 null 而偶然安全。但如果删除和 flush 之间存在另一个事务重新创建了 Y.Text（如 `getOrCreateYText`），或者事务顺序略有不同，文件就会被重建。**依赖实现细节的偶然安全性不是可靠的保证。**

### 3.3 [High] reconcileReadOnly 不 flush pending 本地删除

**位置**: `vaultSync.ts:609-629`

```typescript
private async reconcileReadOnly(): Promise<void> {
  // ... 只做 flushFile，不调用 flushPendingLocalMarkdownDeletions
}
```

**问题**: 只读挂载在 reconcile 阶段不处理 `pendingLocalMarkdownDeletions`。虽然只读挂载通常不监听本地事件（`vault.on('delete')` 被跳过），但如果挂载在启动后从读写切换为只读，或者在某些代码路径中直接调用了 `handleLocalFileDeletion`，pending 会永远滞留。

**影响**: 低概率，但违反了"pending 最终都必须被处理"的不变量。

### 3.4 [High] Blob 删除时 vault.delete 不走 expectedDeletes 保护

**位置**: `blobSync.ts:459-465`

```typescript
private async deleteLocalFile(docPath: string): Promise<void> {
  const file = this.vault.getAbstractFileByPath(this.toVaultPath(docPath));
  if (!file || !('stat' in file)) return;
  this.hashCache.delete(docPath);
  this.knownLocalPaths.delete(docPath);
  await this.vault.delete(file);  // ← 没有 expectedDeletes
}
```

**问题**: BlobSync 的 `deleteLocalFile` 直接调用 `vault.delete` 但不通知 bridge 的 `expectedDeletes`。如果 blob 和 markdown 共用 vault 事件监听（它们确实共用同一个 `vault.on('delete')`），且 `isPathForThisEngine` 认定该路径，那么删除事件可能被 vaultSync 的 `vault.on('delete')` 回调捕获。

**当前保护**: 非 `.md` 文件走 `blobSync.handleLocalBlobDeletion` 分支，不会进入 markdown 删除路径。因此这不是一个实际 bug，但架构上 blob 删除缺少回声抑制，如果 blob 删除事件被 blobSync 自己收到，可能产生重复 tombstone。

### 3.5 [High] Markdown 与 Blob 删除路径的结构性不对称

| 方面 | Markdown | Blob |
|------|----------|------|
| pending 数据结构 | `Set<string>`（无 hash） | `Map<string, hash \| null>`（保留 hash） |
| 跨会话持久化 | 无（仅内存） | IndexedDB (`BlobRuntimeState`) |
| mount 路径切换保护 | 无 | `localPathMatches` 检查 |
| 回声抑制 | `bridge.isExpectedDelete` | 无 |
| Quarantine 机制 | `bridge.remoteFlushQuarantine` | 仅靠 gate state |

**影响**: Markdown 的 `pendingLocalMarkdownDeletions` 在引擎崩溃或 Obsidian 意外退出时会丢失。如果用户删除了一个文件，该删除被记录到 pending 但未来得及写入 tombstone，引擎重启后该删除意图会丢失，文件会从服务端重新物化回来。

### 3.6 [Medium] Tombstone 永远堆积，无 GC 机制

**位置**: `fileTombstones` 和 `blobTombstones` 都是 Y.Map，条目只增不减（除非同名文件重建时 `getOrCreateYText` 清除）。

**问题**: 长期使用后 tombstone map 会持续增长，增加 Y.Doc 大小和同步开销。目前没有任何过期清理机制。

### 3.7 [Not a bug] Blob tombstone 在 maintenance-blocked 阶段的处理

**位置**: `blobSync.ts:185`

**结论**: 经分析，maintenance-blocked 阶段的 blob tombstone 加入 `pendingRemoteDeletes` 是安全的。原因：

1. `pendingRemoteDeletes` 不会在 maintenance 阶段被 flush（需要 gate open）
2. `reconcile(authoritative)` 在 openGate 之前运行，会检查"本地有文件 + 有 tombstone + 不在 pendingRemoteDeletes"的情况并重新上传（清除 tombstone）
3. 如果文件在 `pendingRemoteDeletes` 中，reconcile 会跳过（让 openGate 执行删除），这是正确行为——另一台设备明确删除了文件
4. startup-blocked 阶段的 tombstone 仍然被完全忽略，避免了陈旧污染

尝试引入 deferred 分类反而会破坏合法的跨设备删除传播。

### 3.8 [Low] getTombstoneReceiptProvenance 对 reconnect 场景分类错误

**位置**: `vaultSync.ts:1004-1011`

```typescript
private getTombstoneReceiptProvenance(origin: TombstoneReceiptOrigin): TombstoneReceiptProvenance {
  if (origin === 'cache') return 'cache-startup';
  if (this.markdownDeleteGateState === 'startup-blocked') return 'startup-remote';
  if (this.markdownDeleteGateState === 'maintenance-blocked') {
    return this.initialSyncComplete ? 'startup-maintenance' : 'reconnect-maintenance';
  }
  return 'open';
}
```

**问题**: `reconnect-maintenance` 的判断逻辑是 `initialSyncComplete === true`（即已完成过初始同步，这次是重连），`startup-maintenance` 是 `initialSyncComplete === false`。但命名暗示的语义恰好相反。虽然 `MarkdownTombstoneState.applyTransaction` 对 `startup-maintenance` 和 `reconnect-maintenance` 的处理完全相同（都归为 `live-delete`），所以不影响行为，但命名混淆会导致后续维护困难。

## 4. 修复方案

### 4.1 总体原则

1. **Tombstone 是延迟执行的**：tombstone 被观察到后不应立即产生副作用，而是进入分类 → 确认 → 执行的管道
2. **Gate 是单向的**：`startup-blocked → maintenance-blocked → open`，不可回退（重连可以重新进入 maintenance，但不会回到 startup-blocked）
3. **磁盘是权威的**：在 reconcile 阶段，本地磁盘上存在的文件永远优先于远端 tombstone
4. **删除必须幂等**：同一文件的多次删除请求不应产生异常行为
5. **Pending 必须最终收敛**：所有 pending 队列都必须在 gate open 之后清空

### 4.2 修复 3.1：收紧 pending flush 的触发条件

**方案**: `handleRemoteTransactionSideEffects` 中不再直接 flush pending，改为仅在 gate open 且 reconcile 完成后才 flush。

```typescript
private handleRemoteTransactionSideEffects(txn: Y.Transaction): void {
  this.recordMarkdownTombstoneTransaction(txn);

  // 只在 gate 完全打开后才 flush pending 本地删除。
  // 启动/maintenance 阶段的 flush 由 reconcile() 统一处理。
  if (this.markdownDeleteGateState === 'open') {
    this.flushPendingLocalMarkdownDeletions(new Set());
  }

  // ... 其余逻辑不变
}
```

**影响**: 启动阶段收到远端事务时不再过早 flush。reconcile 的 `flushPendingLocalMarkdownDeletions(localDocPaths)` 带有完整的磁盘路径集合，是安全的。

### 4.3 修复 3.2：doFlushFile 增加 tombstone 守卫

**方案**: 在 `doFlushFile` 开头检查 `fileTombstones`。

由于 bridge 不直接访问 `fileTombstones`（属于 vaultSync 层），可以通过一个回调注入：

```typescript
// filesystemBridge.ts 构造函数增加参数
constructor(
  // ... 现有参数
  private readonly isDeletedPath?: (docPath: string) => boolean,
) {}

private async doFlushFile(docPath: string, generation: number): Promise<void> {
  if (this.remoteFlushQuarantine.has(docPath)) return;
  if (generation !== this.currentWriteGeneration(docPath)) return;
  if (this.isDeletedPath?.(docPath)) return;  // ← 新增

  // ... 其余不变
}
```

```typescript
// vaultSync.ts — 构造 bridge 时注入
this.bridge = new ObsidianFilesystemBridge(
  vault,
  (docPath) => this.getYText(docPath),
  this.ydoc,
  this.effectiveSettings.vaultId,
  this.toDocPath,
  this.toVaultPath,
  undefined,
  (vaultPath) => this.editorBindings.isHealthyBinding(vaultPath),
  (docPath) => this.handleExternalMarkdownDeletion(docPath),
  (docPath) => this.fileTombstones.has(docPath),  // ← 新增
);
```

### 4.4 修复 3.3：reconcileReadOnly 处理 pending

**方案**: 在 `reconcileReadOnly` 末尾清空 pending（只读挂载不应有 pending，清空是防御性保证）。

```typescript
private async reconcileReadOnly(): Promise<void> {
  // ... 现有逻辑

  // 只读挂载不应积累本地删除 pending，防御性清空。
  this.pendingLocalMarkdownDeletions.clear();
}
```

### 4.5 修复 3.5：Markdown pending 持久化到 IndexedDB

**方案**: 将 `pendingLocalMarkdownDeletions` 纳入本地缓存持久化，类似 blob 的 `BlobRuntimeState`。

扩展 `IndexedDbLocalCache` 的存储格式，在 `scheduleCacheSave` 时同时保存 pending 集合：

```typescript
// 扩展缓存数据结构
interface LocalCacheEntry {
  ydocUpdate: Uint8Array;
  pendingLocalMarkdownDeletions?: string[];  // ← 新增
}

// start() 中恢复
const cached = await this.cache.load(this.localCacheKey);
if (cached) {
  Y.applyUpdate(this.ydoc, cached.ydocUpdate, 'cache');
  if (cached.pendingLocalMarkdownDeletions) {
    for (const docPath of cached.pendingLocalMarkdownDeletions) {
      this.pendingLocalMarkdownDeletions.add(docPath);
    }
  }
}

// scheduleCacheSave 中保存
private async flushCacheSave(): Promise<void> {
  await this.cache.save(this.localCacheKey, {
    ydocUpdate: Y.encodeStateAsUpdate(this.ydoc),
    pendingLocalMarkdownDeletions: [...this.pendingLocalMarkdownDeletions],
  });
}
```

### 4.6 修复 3.6：Tombstone GC

**结论**: 当前协议不能安全实现基于时间的 tombstone GC。GC 必须等到系统能证明所有仍被支持的设备都已观察到删除后才能删除共享 tombstone。

不能使用 TTL 的原因：如果设备离线超过 TTL，重连时服务端已经删除 tombstone，该设备仍可能带着本地旧文件和旧缓存完成同步；由于 tombstone guard 不存在，reconcile 会把旧文件重新导入或重新上传，复活已删除数据。

安全 GC 的前置条件：

1. 设备注册表：服务端或共享模型需要记录已知 `deviceId`，并区分活跃、退役、超期不再支持的设备。
2. Tombstone ack：每个设备完成初始同步和本地删除副作用后，持久记录“已观察到 tombstone X”。
3. GC 判定：只有当 tombstone 的 `ackedBy` 覆盖全部活跃设备，或未 ack 设备已显式退役/超过产品定义的离线支持窗口，才允许删除 tombstone。
4. GC 原子性：删除 tombstone 的事务必须保留底层 `pathToId`/`pathToBlob` 删除结果，并不能被长离线设备的本地磁盘文件重新解释为新建。

本轮实现保持 tombstone 不自动 GC；同名文件重建、snapshot restore 等已有路径仍可显式清除对应 tombstone。后续若引入设备 ack，需要同步更新 shared protocol、server persistence、plugin reconcile 和迁移测试。

### 4.7 修复 3.7：Blob tombstone 增加 startup-baseline 分类

**方案**: 将 `MarkdownTombstoneState` 的分类逻辑泛化为 `TombstoneClassifier`，同时用于 markdown 和 blob。

这是一个较大的重构。最小可行方案是在 BlobSync 中增加类似的 gate 逻辑：

```typescript
// blobSync.ts
async handleRemoteBlobChanges(txn: Y.Transaction): Promise<void> {
  // ...
  if (tombMap.has(path)) {
    // startup-blocked: 完全忽略（现有行为）
    // maintenance-blocked: 记录但不入队（新增）
    // open: 入队（现有行为）
    if (this.gateState === 'open') {
      this.pendingRemoteDeletes.add(path);
    } else if (this.gateState === 'maintenance-blocked') {
      // 在 reconcile 中根据本地是否存在来决定是否入队
      this.deferredRemoteTombstones.add(path);
    }
    // startup-blocked: 不做任何事
  }
}

async openRemoteApplyGate(): Promise<void> {
  this.gateState = 'open';
  // 对 deferred tombstones 做分类
  for (const docPath of this.deferredRemoteTombstones) {
    if (this.vault.getAbstractFileByPath(this.toVaultPath(docPath))) {
      // 本地存在 → stale，不入队
      continue;
    }
    this.pendingRemoteDeletes.add(docPath);
  }
  this.deferredRemoteTombstones.clear();
  // ... 现有逻辑
}
```

## 5. 实施优先级

| 优先级 | 缺陷 | 修复 | 复杂度 | 影响 |
|--------|------|------|--------|------|
| P0 | 3.1 过早 flush pending | 4.2 gate guard | 低 | 阻止启动误删 |
| P0 | 3.2 doFlushFile 重建文件 | 4.3 tombstone 守卫 | 低 | 阻止删后复活 |
| P1 | 3.5 Markdown pending 不持久化 | 4.5 IndexedDB | 中 | 崩溃后删除意图丢失 |
| P1 | 3.7 Blob tombstone 无分类 | 4.7 deferred set | 中 | 启动阶段 blob 误删 |
| P2 | 3.3 ReadOnly pending 滞留 | 4.4 防御性清空 | 低 | 内存泄漏 |
| P2 | 3.6 Tombstone 无 GC | 4.6 ack-gated GC（暂不实现 TTL） | 高 | 长期膨胀 |
| P3 | 3.4 Blob 回声抑制 | — | 低 | 重复 tombstone |
| P3 | 3.8 Provenance 命名混淆 | 改名 | 低 | 可维护性 |

## 6. 实施计划

### Phase 1: 紧急修复 (P0)

**目标**: 消除已知的启动误删和删后复活 bug。

1. **4.2** — `handleRemoteTransactionSideEffects` 中 gate guard pending flush
2. **4.3** — `doFlushFile` 增加 `isDeletedPath` 回调守卫
3. 补充测试：
   - 启动窗口期远端事务到达时 pending 不被 flush
   - 删除后 pending flush 不重建文件
   - 删除和远端更新交叉的竞态时序

### Phase 2: 健壮性加固 (P1)

**目标**: 消除崩溃恢复和 blob 启动阶段的数据丢失风险。

4. **4.5** — Markdown pending 持久化到 IndexedDB
5. **4.7** — Blob tombstone deferred 分类
6. 补充测试：
   - 引擎崩溃后重启，pending 正确恢复
   - Blob startup-baseline tombstone 在本地文件存在时被忽略

### Phase 3: 长期健康 (P2+)

**目标**: 控制资源增长，修复边缘场景。

7. **4.4** — reconcileReadOnly 防御性清空
8. **4.6** — 设计 ack-gated Tombstone GC；在缺少 ack 前不启用自动 GC
9. **3.8** — 修正 provenance 命名

## 7. 测试策略

### 7.1 需新增的单元测试

```
vaultSync.test.ts:
  ✗ "启动阶段远端事务不 flush pending 本地删除"
  ✗ "gate open 后远端事务正常 flush pending"
  ✗ "reconcile 后 pending 被正确 flush（带 localDocPaths）"
  ✗ "只读挂载 reconcile 清空 pending"

filesystemBridge.test.ts:
  ✗ "doFlushFile 跳过已 tombstone 的路径"
  ✗ "远端更新调度 flush → 本地删除 → flush 不重建文件"

blobSync.test.ts:
  ✗ "maintenance 阶段 blob tombstone 被 defer 而非入队"
  ✗ "openGate 时本地存在的 blob 的 deferred tombstone 被忽略"
  ✗ "openGate 时本地不存在的 blob 的 deferred tombstone 被执行"
```

### 7.2 需新增的 E2E 测试

```
twoEngine.test.ts:
  ✗ "设备 A 删除文件 → 设备 B 启动时不丢失 B 本地新建的同名文件"
  ✗ "设备 A 删除 blob → 设备 B 启动时如果 blob 仍在磁盘则保留"
  ✗ "引擎崩溃恢复后 pending markdown 删除正确传播"
```

## 8. 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| Gate guard 导致合法 pending 永远不 flush | reconcile 阶段的 flush 带 localDocPaths，是 pending 的最终出口 |
| isDeletedPath 回调增加 bridge 耦合 | 回调是可选的（`?.`），不影响现有测试 |
| Tombstone GC 删除仍在传播中的 tombstone | 不使用年龄 TTL；必须等设备 ack/退役机制可证明删除已被所有受支持设备观察 |
| Markdown pending 持久化增加 cache 大小 | pending 通常很小（< 100 条），可忽略 |
