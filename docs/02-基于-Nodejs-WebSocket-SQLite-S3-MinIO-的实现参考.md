# 基于 Node.js + WebSocket + SQLite + S3/MinIO 的实现参考

这份文档回答的是一个更工程化的问题：

如果不依赖某个云厂商，而是想用一套常见、自托管、可迁移的技术栈来实现“实时 Obsidian 同步 + snapshot”，应该怎么落地？

这里给出的不是唯一答案，而是一套足够小、足够稳、容易做出 MVP 的参考方案。

目标是实现：

- Markdown 实时同步
- 离线后重连合并
- 外部编辑兼容
- 附件同步
- snapshot 创建与恢复

参考技术栈：

- 客户端：Obsidian Plugin API + Yjs + CodeMirror binding + IndexedDB
- 服务端：Node.js + WebSocket
- 文档持久化：SQLite
- 对象存储：S3 或 MinIO

## 1. 为什么这套栈适合做第一版

### 1.1 Node.js

适合原因：

- WebSocket 生态成熟
- 与 Obsidian 插件同为 TypeScript / JavaScript 生态，心智成本低
- Yjs、y-websocket、partyserver 思路都容易迁移过来

### 1.2 WebSocket

适合原因：

- 适合实时、双向、低延迟更新
- 可以天然承载 CRDT update 广播
- 也可承载 presence / awareness 类信息

### 1.3 SQLite

适合原因：

- 单机部署简单
- 足够支撑个人或小团队 vault
- 做 checkpoint + journal 非常顺手
- 可作为 MVP 的 durable store

### 1.4 S3 / MinIO

适合原因：

- 用于附件和 snapshot 都合适
- MinIO 可以纯本地或自建部署
- 后续切云对象存储时 API 迁移成本低

## 2. 系统分层

建议分成六层。

### 2.1 插件层

负责：

- 读取和写入 vault 文件
- 管理设置
- 监听文件事件
- 建立编辑器绑定
- 管理本地缓存
- 连接服务端 room

### 2.2 同步核心层

负责：

- 维护共享 vault 模型
- 管理 fileId、path、Y.Text、blob 引用、tombstone
- 处理 reconcile、diff、外部编辑导入

### 2.3 传输层

负责：

- 建立 WebSocket 连接
- 发送本地 update
- 接收远端 update
- 维护 room 级连接状态

### 2.4 room 服务层

负责：

- 按 vaultId 组织客户端会话
- 将 update 应用到内存中的共享状态
- 广播 update 给其他连接
- 控制保存节奏

### 2.5 持久化层

负责：

- checkpoint + journal 的读写
- room 重启后的恢复
- 元数据校验

### 2.6 blob/snapshot 层

负责：

- 附件上传、下载、查重
- snapshot 创建、列表、下载、恢复

## 3. 建议的模块目录

服务端可以先按这个方式拆：

```text
server/
  src/
    index.ts                # HTTP/WebSocket 入口
    auth.ts                 # token 校验
    rooms/
      roomManager.ts        # room 注册与查找
      vaultRoom.ts          # 单个 vault 的内存 room
    persistence/
      documentStore.ts      # 抽象接口
      sqliteDocumentStore.ts
      migrations.ts
    blobs/
      blobStore.ts          # 抽象接口
      s3BlobStore.ts
    snapshots/
      snapshotService.ts
    protocol/
      messages.ts
      schema.ts
    utils/
      hash.ts
      compression.ts
```

客户端插件可以先按这个方式拆：

```text
src/
  main.ts
  sync/
    syncManager.ts        # 管理主 vault + 所有共享目录的 SyncEngine 实例
    vaultSync.ts          # 单个 vault/共享目录的同步引擎
    diskMirror.ts
    editorBinding.ts
    blobSync.ts
    localCache.ts
    roomClient.ts
  storage/
    indexedDbStore.ts
  protocol/
    messages.ts
  settings.ts
  types.ts
```

`syncManager.ts` 是多 sync context 的编排入口：它持有主 vault 的 `vaultSync` 实例，以及每个共享目录挂载对应的 `vaultSync` 实例，并在文件事件到来时根据路径前缀路由到正确的实例。

## 4. 共享数据模型怎么设计

一个实用的 vault 级共享模型至少要包含这些结构：

### 4.1 Markdown 相关

- `pathToId: Map<string, string>`
- `idToPath: Map<string, string>`
- `docs: Map<string, Y.Text>`

用途：

- 稳定文件身份
- 文件重命名时不丢失逻辑身份
- 让编辑器绑定和磁盘路径解耦

### 4.2 附件相关

- `pathToBlob: Map<string, BlobRef>`
- `blobMeta: Map<string, BlobMeta>`
- `blobTombstones: Map<string, Tombstone>`

用途：

- 跟踪当前路径绑定到哪个 blob
- 保存大小、hash、类型等元数据
- 支持删除同步与恢复

### 4.3 系统元数据

- `sys: Map<string, unknown>`

典型字段：

- `schemaVersion`
- `createdAt`
- `updatedAt`
- `vaultId`

## 5. WebSocket 协议建议

第一版不需要设计得太复杂，但需要分清几类消息。

### 5.1 连接与握手

- `hello`
- `auth_ok`
- `auth_failed`
- `schema_mismatch`

### 5.2 文档更新

- `sync_update`
- `sync_state_vector`
- `sync_request_missing`

### 5.3 awareness

- `awareness_update`

### 5.4 控制与诊断

- `room_meta`
- `server_error`
- `trace_event`

设计原则：

- 文本复制的 payload 尽量直接复用 Yjs update
- 控制消息和数据消息分开
- schemaVersion 必须在握手期校验

## 6. room 该如何实现

### 6.1 RoomManager

维护：

- `Map<vaultId, VaultRoom>`

职责：

- 根据 `vaultId` 找到或创建 room
- 追踪 room 生命周期
- 空闲 room 的回收

### 6.2 VaultRoom

每个 room 维护：

- 一个共享 `Y.Doc`
- 当前连接集合
- 加载状态
- save debounce 状态
- 最近一次已保存的基线状态信息

主要方法建议：

- `load()`
- `applyClientUpdate()`
- `broadcastUpdate()`
- `scheduleSave()`
- `saveNow()`
- `disposeIfIdle()`

### 6.3 为什么每个 vault 一个 room

因为这样最符合问题本身：

- 一个 vault 的所有客户端天然属于一个同步房间
- room 是 update 广播和持久化的协调边界
- 它比“全局单例”更容易扩展，也比“每文件一个服务”更容易做第一版

## 7. SQLite 持久化应该怎么做

### 7.1 不建议的方式

不要每次 `onSave` 都把整个 `Y.Doc` 全量覆盖保存。

问题是：

- 写放大严重
- 文档稍大就会卡
- 高频编辑下磁盘压力大

### 7.2 建议的 checkpoint + journal 模型

建议两张主表。

`document_checkpoints`

- `vault_id`
- `version`
- `payload`
- `state_vector`
- `created_at`
- `sha256`

`document_journal`

- `vault_id`
- `seq`
- `payload`
- `created_at`
- `sha256`

再加一张元数据表：

`document_meta`

- `vault_id`
- `current_checkpoint_version`
- `next_seq`
- `journal_entry_count`
- `journal_total_bytes`
- `updated_at`

### 7.3 保存流程

1. 计算当前 `stateVector`
2. 如果与上次基线一致，跳过
3. 生成从基线到当前状态的增量 update
4. 把增量写入 `document_journal`
5. journal 超阈值时生成新 checkpoint
6. compact 完成后删除旧 journal 段

### 7.4 恢复流程

1. 读取当前 checkpoint
2. 校验 hash
3. 加载 checkpoint 到 `Y.Doc`
4. 按 seq 顺序加载 journal
5. 逐条回放
6. 得到最新文档状态

### 7.5 需要的正确性保证

- journal 序号严格递增
- journal 回放必须按顺序
- 任一段损坏时不能静默跳过
- checkpoint 与 state vector 要一并保存

## 8. 附件同步应该怎么做

### 8.1 为什么附件不进 CRDT

因为附件的属性和文本不同：

- 大
- 不需要字符级 merge
- 更适合 immutable blob

### 8.2 推荐模型

客户端：

1. 读取附件字节
2. 计算 SHA-256
3. 请求服务端检查该 hash 是否存在
4. 若不存在则上传到对象存储
5. 上传成功后写共享模型里的附件引用

服务端：

1. 提供 `exists / put / get` 接口
2. 将内容存到 S3/MinIO
3. 返回对象存在状态和元数据

共享模型中只记录：

- `hash`
- `size`
- `contentType`
- `updatedAt`

### 8.3 MinIO 的好处

- 本地测试方便
- 自建简单
- 与 S3 API 兼容

## 9. snapshot 应该怎么做

### 9.1 snapshot 的本质

snapshot 不是“导出几个文件”。

它更准确地说是：

- 某个时刻的共享 vault 状态归档
- 外加恢复所需的元数据

### 9.2 推荐 snapshot 内容

- 压缩后的 `Y.Doc` 全量状态
- snapshot index JSON
- 可选的 `referencedBlobHashes`

### 9.3 snapshot 存储位置

推荐直接放对象存储：

- 查询方便
- 下载方便
- 归档成本低
- 不占 SQLite 主库空间

### 9.4 创建流程

1. 从 room 当前 `Y.Doc` 生成全量 update
2. 压缩
3. 上传到对象存储
4. 写 snapshot index
5. 返回 snapshotId 和元数据

### 9.5 恢复流程

1. 客户端拉取 snapshot archive
2. 解压并恢复成临时 `Y.Doc`
3. 与当前状态做 diff
4. 允许用户选择全量恢复或部分恢复
5. 把恢复结果重新写回共享模型
6. 再由文件系统桥接回写本地磁盘

重点：

- 恢复不要绕过共享模型直接改文件
- 否则容易让本地状态、远端状态和缓存状态重新撕裂

## 10. 客户端本地缓存怎么做

第一版建议继续使用 IndexedDB。

原因：

- 在 Obsidian 桌面端可用
- 与浏览器环境更自然
- 适合缓存 CRDT 状态和部分队列信息

本地缓存负责：

- 保存最近一次同步状态
- 支持离线编辑后重连
- 减少冷启动完全依赖远端

但它不是：

- 全局权威
- 恢复系统的唯一来源

## 11. 鉴权和多租户建议

第一版最简单的方式：

- 每个服务实例一个主 token
- 每个 vault 一个 `vaultId`
- 连接时携带 token + vaultId

**关键约束：token 必须与允许访问的 vaultId 集合绑定校验。** 服务端在握手阶段应验证"该 token 是否有权访问该 vaultId"，而不是只验证 token 合法性。这个检查是防止 A 用户的 token 访问 B 用户 vault 的基本屏障，在引入共享目录（多 vaultId 场景）时尤其重要——共享目录的 token 只应对其对应的共享 vaultId 有效，不能扩散到主 vault。

如果以后要扩展：

- 可加用户表
- 可加 vault 成员关系（每个 vault 配置允许访问的 token 或用户列表）
- 可加 token 轮换

但第一版没必要先做复杂 IAM。

## 12. 推荐的服务端 HTTP / WebSocket 接口

### 12.1 WebSocket

- `GET /vault/sync/:vaultId`

### 12.2 blob

- `POST /vault/:vaultId/blobs/exists`
- `PUT /vault/:vaultId/blobs/:sha256`
- `GET /vault/:vaultId/blobs/:sha256`

### 12.3 snapshot

- `POST /vault/:vaultId/snapshots` — 立即创建一个 snapshot
- `POST /vault/:vaultId/snapshots/auto` — 按策略判断是否创建：若距上次 snapshot 时间未超过阈值、或文档自上次 snapshot 以来变化量低于阈值，则跳过；否则创建。适合客户端定时触发，避免频繁冗余写入。
- `GET /vault/:vaultId/snapshots` — 列出所有 snapshot
- `GET /vault/:vaultId/snapshots/:snapshotId` — 获取单个 snapshot

## 13. MVP 实现顺序

建议按这个顺序做，不要一开始就做全家桶。

### 阶段 1：文本实时同步 MVP

目标：

- 单 vault
- Markdown 实时同步
- SQLite checkpoint + journal

要做的事：

1. 定义 room 协议
2. 做 `RoomManager` 和 `VaultRoom`
3. 用 SQLite 实现 `DocumentStore`
4. 客户端接入 WebSocket + Yjs
5. 打通打开文档的编辑器绑定

### 阶段 2：文件系统桥接

目标：

- 支持外部编辑
- 支持未打开文件的同步

要做的事：

1. 实现 dirty set drain
2. 实现按路径串行写回
3. 实现内容指纹 suppress
4. 实现 diff 导入

### 阶段 3：附件同步

目标：

- 支持图片、PDF 等附件

要做的事：

1. 定义 blob metadata
2. 接入 S3/MinIO
3. 做 `exists/put/get`
4. 客户端上传、下载、去重

### 阶段 4：snapshot

目标：

- 支持手动创建和恢复

要做的事：

1. 设计 snapshot index
2. 导出压缩后的共享状态
3. 做 snapshot 列表与下载
4. 做 diff 和恢复

### 阶段 5：增强项

- 多 vault 管理
- 更细粒度权限模型
- 后台压缩与 GC
- 更完善的 trace 和观测
- 失败重试和健康检查

## 14. 最重要的工程纪律

如果你真的开始实现，这几条比“选什么库”更重要：

1. 文本同步、附件同步、snapshot 恢复必须分层。
2. 不要把文件系统事件当作强因果流。
3. 不要把对象存储当数据库。
4. 不要让本地缓存和远端持久化都自称权威。
5. 恢复路径必须复用主状态机。
6. 先做一个可恢复的小系统，再做复杂优化。

## 15. 一句话总结

如果你想构建一套不和供应商绑定的 Obsidian 实时同步系统，最务实的第一版方案就是：

- 用 `Yjs` 解决文本并发
- 用 `WebSocket` 解决实时传输
- 用 `SQLite checkpoint + journal` 解决 room 持久化
- 用 `S3/MinIO` 解决附件和 snapshot
- 用 `文件系统桥接层` 解决 Obsidian 真实文件世界的噪声和外部编辑

这套架构已经足够做出一个真正能用、能恢复、能继续演进的系统。
