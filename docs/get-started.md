# Get Started

这份文档对应当前仓库实现，目标是让你把本地 server、MinIO 和 Obsidian 插件跑起来，并完成一次最小同步联调。

## 1. 前置条件

- Node.js `22-24`
- `corepack pnpm`
- Docker
- 已安装 Obsidian

启用 `pnpm`：

```bash
corepack enable
```

## 2. 安装依赖

在仓库根目录执行：

```bash
corepack pnpm install
```

## 3. 启动本地 MinIO

仓库根目录的 `docker-compose.yml` 只负责本地开发用 MinIO：

```bash
docker compose up -d
```

默认地址：

- S3 API: `http://localhost:19000`
- MinIO Console: `http://localhost:19001`
- 用户名: `minioadmin`
- 密码: `minioadmin`

## 4. 启动服务端

最小开发启动方式：

```bash
SERVER_TOKEN=dev-token corepack pnpm dev:server
```

等价命令：

```bash
SERVER_TOKEN=dev-token corepack pnpm --filter @salt-sync/server dev
```

默认环境变量：

- `PORT=3000`
- `DATA_DIR=./data`
- `S3_ENDPOINT=http://localhost:19000`
- `S3_REGION=us-east-1`
- `S3_BUCKET=salt-sync`
- `S3_ACCESS_KEY=minioadmin`
- `S3_SECRET_KEY=minioadmin`
- `SERVER_TOKEN=dev-token`

如果要按 vault 配置独立 token：

```bash
VAULT_TOKENS='{"vault-a":"token-a","vault-b":"token-b"}' SERVER_TOKEN=dev-token corepack pnpm dev:server
```

## 5. 验证服务端是否正常

健康检查：

```bash
curl http://localhost:3000/health
```

正常返回示例：

```json
{
  "status": "ok",
  "rooms": {
    "active": 0,
    "vaultIds": []
  }
}
```

## 6. 管理页面

管理页面入口：

- `http://localhost:3000/admin`

注意：`pnpm dev:server` 只 watch server 源码，不会自动构建管理页 bundle。第一次启动开发环境前先执行：

```bash
corepack pnpm --filter @salt-sync/server build
```

管理 API 示例：

```bash
curl -H 'Authorization: Bearer dev-token' http://localhost:3000/admin/api/rooms
```

当前 `/admin` 可做的事：

- 查看总览、token mode 与运行态摘要
- 查看活跃 rooms 与单 vault 详情
- 查看、创建、下载、删除、恢复 snapshots
- 管理同步 token：创建、编辑、revoke、rotate
- 触发带强确认的 blob GC
- 查看脱敏后的只读配置摘要

当前限制：

- `/admin` 页面本身没有独立登录系统，受保护的是 `/admin/api/*`
- 页面本身会把 admin token 保存在浏览器 `sessionStorage`（关闭标签页后自动清除）

### 6.1 同步 token 模式切换

当前服务端支持两种同步 token 模式：

- `env fallback`：当数据库里还没有任何 sync token 时，继续接受 `SERVER_TOKEN` / `VAULT_TOKENS`
- `db`：当数据库里存在至少一个 sync token 时，只接受 DB token，env token 会立即失效

建议迁移流程：

1. 用 `SERVER_TOKEN` 登录 `/admin`
2. 在 `Tokens` 页面创建首个 DB token
3. 把插件配置中的 token 改成新生成的 DB token
4. 之后再决定是否保留环境变量里的旧 token 配置

注意：

- DB token 的明文只会在创建或 rotate 成功时展示一次
- 如果你丢失了明文值，只能重新 rotate 一个新 token

## 7. 构建插件

插件构建：

```bash
corepack pnpm --filter @salt-sync/plugin build
```

插件 watch：

```bash
corepack pnpm --filter @salt-sync/plugin dev
```

构建产物输出到：

- `packages/plugin/dist/main.js`

## 8. 安装到 Obsidian

在你的 vault 中创建：

```text
<your-vault>/.obsidian/plugins/salt-sync/
```

然后复制这些文件：

- `packages/plugin/dist/main.js` -> `<vault>/.obsidian/plugins/salt-sync/main.js`
- `packages/plugin/manifest.json` -> `<vault>/.obsidian/plugins/salt-sync/manifest.json`
- `packages/plugin/styles.css` -> `<vault>/.obsidian/plugins/salt-sync/styles.css`
- `packages/plugin/versions.json` -> `<vault>/.obsidian/plugins/salt-sync/versions.json`

如果你在跑 `corepack pnpm --filter @salt-sync/plugin dev`，每次重新构建后都需要把 `dist/main.js` 同步到插件目录里的 `main.js`。

## 9. 在 Obsidian 中配置插件

启用插件后，至少填写：

- `Server URL`: `ws://localhost:3000`
- `Vault ID`: 例如 `dev-vault`
- `Token`: `dev-token`
- `Enable sync`: 打开

说明：

- `Vault ID` 必须在同一逻辑 vault 的所有设备上一致
- `Token` 在 `env fallback` 模式下可以匹配 `SERVER_TOKEN`，或匹配 `VAULT_TOKENS` 中该 vault 的 token
- 一旦服务端进入 `db` token mode，插件里的 `Token` 必须改成在 `/admin` 的 `Tokens` 页面创建出来的 DB token
- `Device ID` 会自动生成

## 10. 最小联调流程

1. 启动 MinIO：`docker compose up -d`
2. 首次本地开发时，先构建 server：`corepack pnpm --filter @salt-sync/server build`
3. 启动 server：`SERVER_TOKEN=dev-token corepack pnpm dev:server`
4. 构建插件：`corepack pnpm --filter @salt-sync/plugin build`
5. 把插件产物复制到 Obsidian 插件目录
6. 在 Obsidian 中启用 `Salt Sync`
7. 配置 `Server URL=ws://localhost:3000`、`Vault ID=dev-vault`、`Token=dev-token`
8. 修改一个 Markdown 文件，观察 server 日志是否出现对应 vault 的连接和同步日志

如果要验证实时同步，可以在两个 Obsidian 实例中使用同一个 `Vault ID` 和 token 连接同一服务端。

## 11. Docker Compose 部署整套服务

如果你要同时跑 server + MinIO，可使用 `docker/docker-compose.yml`：

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

停止但保留数据：

```bash
docker compose -f docker/docker-compose.yml down
```

查看 server 日志：

```bash
docker compose -f docker/docker-compose.yml logs -f salt-sync
```

默认暴露端口：

- Server HTTP: `http://localhost:3000`
- Server WebSocket: `ws://localhost:3000`
- MinIO API: `http://localhost:19000`
- MinIO Console: `http://localhost:19001`

默认容器内关键环境变量：

- `SERVER_TOKEN=dev-token`
- `S3_BUCKET=salt-sync`
- `S3_ENDPOINT=http://minio:9000`

如果需要自定义 token：

```bash
SERVER_TOKEN=prod-token docker compose -f docker/docker-compose.yml up -d --build
```

如果需要按 vault 配置 token：

```bash
VAULT_TOKENS='{"vault-a":"token-a","vault-b":"token-b"}' docker compose -f docker/docker-compose.yml up -d --build
```

## 12. 测试与构建命令

```bash
corepack pnpm build
corepack pnpm -r typecheck
corepack pnpm -r test
corepack pnpm --filter @salt-sync/server build
corepack pnpm --filter @salt-sync/server dev
corepack pnpm --filter @salt-sync/plugin build
corepack pnpm --filter @salt-sync/plugin dev
corepack pnpm --filter @salt-sync/plugin check:bundle-safety
```

## 13. 公网部署前的安全清单

至少先完成这些事项：

1. 使用反向代理提供 `HTTPS/WSS`，不要直接裸露 `http://` / `ws://`
2. 替换 `SERVER_TOKEN=dev-token` 和默认 MinIO 凭据
3. 优先在 `/admin` 中创建 DB token，并尽快从 env token 迁移过去
4. 限制 `/admin` 和 `/health` 的访问面
5. 在反向代理层增加限流和请求体大小限制，尤其是 blob 上传接口
6. 为 SQLite 数据目录和 S3/MinIO bucket 做备份
7. 给对象存储使用最小权限凭据

当前实现上的已知注意点：

- `/admin` HTML 和静态资源默认可公开访问，真正受 token 保护的是 `/admin/api/*`
- `/health` 默认无鉴权，并会返回活跃 vault 信息
- blob 上传当前按整请求体读入内存，更适合放在可信网络或带网关限制的环境中

## 14. 常见问题

### 服务端启动了，但 blob 上传或 snapshot 创建失败

优先检查：

- MinIO 是否已启动
- `S3_ENDPOINT`、`S3_BUCKET`、凭据是否一致
- 当前凭据是否有创建 bucket 的权限

### Obsidian 提示找不到插件主文件

通常是因为只复制了 `manifest.json`，但没有把 `packages/plugin/dist/main.js` 复制并重命名为插件目录根下的 `main.js`。

### 插件无法连接服务端

优先检查：

- `Server URL` 是否为 `ws://localhost:3000`
- 插件中的 `Token` 是否和服务端一致
- `curl http://localhost:3000/health` 是否正常
- 服务端日志里是否出现 `auth_failed` 或 `schema_mismatch`

### 修改了插件源码，但 Obsidian 里没生效

大多数情况下是因为你只重新跑了 `build`/`dev`，但没有把新的 `packages/plugin/dist/main.js` 再复制到 Obsidian 插件目录。
