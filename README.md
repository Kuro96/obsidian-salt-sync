# Salt Sync

基于 Yjs CRDT 的 Obsidian 实时同步插件，包含插件端、服务端和快照/附件能力。

## 项目内容

- `packages/plugin`: Obsidian 插件，负责 Markdown、附件、编辑器绑定和本地缓存
- `packages/server`: WebSocket + HTTP 服务端，负责状态持久化、blob、snapshot 和管理接口
- `packages/shared`: 协议、类型和常量

## 适用场景

- 多设备同步同一个 Obsidian vault
- 多客户端同时编辑 Markdown
- Markdown + 附件统一同步
- 基于 snapshot 的回滚、下载和导出

## 快速入口

- 快速上手与联调：[`docs/get-started.md`](docs/get-started.md)
- 架构背景与设计草案：`docs/`

## Admin 与 Token 管理

服务端内置了一个简洁的管理页面：

- 入口：`/admin`
- 管理 API：`/admin/api/*`
- 管理鉴权：`SERVER_TOKEN`

当前 admin 页面已覆盖：

- 总览：服务状态、token mode、active rooms、schema、uptime
- Rooms：活动 room 列表与单 vault 详情
- Snapshots：列表、创建、manifest、下载、删除、恢复
- Tokens：同步 token 的增删改查、revoke、rotate
- Blob GC：带强确认流程的手动清理
- Ignored-path cleanup API：dry-run / 强确认清理旧版忽略路径污染
- Config：只读脱敏配置概览

同步 token 当前支持两种模式：

- `env fallback`：数据库里还没有任何 DB token 时，仍接受 `SERVER_TOKEN` / `VAULT_TOKENS`
- `db`：一旦创建了任意 DB token，vault 同步访问只接受 DB token，env token 立即失效

注意：

- `/admin` 页面 HTML 和静态资源默认可公开访问，真正受保护的是 `/admin/api/*`
- DB token 的明文值只会在创建或 rotate 成功时返回一次，之后不会再次显示

## 开发要求

- Node.js `22-24`
- `corepack pnpm`
- Docker（本地使用 MinIO 时需要）

安装与构建：

```bash
corepack enable
corepack pnpm install
corepack pnpm build
```

## 常用命令

```bash
corepack pnpm build
corepack pnpm -r typecheck
corepack pnpm -r test
corepack pnpm --filter @salt-sync/server dev
corepack pnpm --filter @salt-sync/plugin build
corepack pnpm --filter @salt-sync/plugin dev
```

## 与第三方文件同步工具共存

Salt Sync 可以和 Syncthing、iCloud Drive、Dropbox 等文件级同步工具同时作用于同一个 vault。当前已有这些防御：

- 内容指纹回声抑制：写盘前记录 SHA-256 + byteLength，短窗口内抑制相同内容回写事件
- `importFromDisk` 内容比对：磁盘内容与共享模型一致时不产生 Y.Doc 事务
- 忽略文件过滤：忽略 Obsidian 内部目录、默认新建文件名、Syncthing 产物（`.stfolder`、`.stversions`、`.stignore`、`.sync-conflict-*`、`~syncthing~*.tmp`）；插件设置里也可指定一个额外 ignore 文件，语法遵循 `.gitignore`，留空则不启用额外忽略规则
- 服务端 ignored-path cleanup：管理员可 dry-run / 强确认清理旧版本已写入共享模型的忽略路径污染

### 已知限制

- 附件的 `mtime` 扰动会让 `BlobHashCache` 失效，导致额外 SHA-256 计算，但不会重复上传错误内容
- 极端情况下，外部工具若在非原子写入过程中被读取，理论上可能被读到中间态；常见同步工具通常使用 rename-based 原子写入，因此实际风险较低

## 已知同步限制

下面这些是当前设计语义或架构特性，不视为 bug，但使用前需要知道。

### Markdown

#### 插件未运行时在 Obsidian 外删除的 Markdown，可能在下次启动后被重新同步回来

如果用户在插件未运行时通过 Finder、资源管理器或命令行删除了已同步 Markdown，下次启动时它可能被远端重新物化。可靠传播删除的方式是在插件运行期间通过 Obsidian 删除。

#### 外部工具对未打开 Markdown 的修改，可能被并发远端更新覆盖

如果外部工具修改一个当前未在编辑器中打开的 `.md` 文件，而远端更新恰好在 300ms drain 防抖窗口内到达，远端 flush 可能先写盘，导致这次本地外部修改未及时导入 CRDT。

规避方式：尽量通过 Obsidian 编辑同一文件；如果必须借助外部工具，避免多设备同时改同一 Markdown。

### 只读挂载

#### 只读挂载不会主动删除本地额外文件

`readOnly` 的含义是“本地不向服务端提交改动”，不是“本地目录严格镜像远端”。Salt Sync 会把远端内容同步到本地，但不会主动删除该目录下用户额外放入的文件。

### 附件

#### 插件未运行时在 Obsidian 外删除的附件，会在下次启动后被重新下载

如果用户在插件未运行时通过 Finder、资源管理器或命令行删除了已同步附件，下次启动时它可能被重新下载，因为插件无法可靠区分“用户主动删除”和“本地从未成功同步到位”。

规避方式：在插件运行时通过 Obsidian 删除，或接受其被重新下载后再删除一次。

#### 本地删除后，刚上传的 blob 内容可能短暂残留为服务端孤儿对象

如果附件在上传成功、但共享模型尚未写入 `pathToBlob` 前就被本地删除，对象会短暂残留在服务端，后续由 blob GC 清理。

#### 启动阶段删除且暂时拿不到 hash 的附件，会持续 pending，直到 hash 可用

如果附件在启动窗口期间被删除，且此时缓存和远端状态都还拿不到对应 hash，这次删除意图会先保留为 pending，等远端 `pathToBlob` 或 tombstone 到达后再完成收敛。

## 致谢

感谢这些开源项目公开分享代码与思路，为 Salt Sync 在 Obsidian 同步与协作方向上的设计和实现提供了参考：

- [`yaos`](https://github.com/kavinsood/yaos)
- [`Relay`](https://github.com/No-Instructions/Relay)
