# OfferFlow v0.4 后端与数据库计划

## 主题

新版 v0.4 的主题是：补齐 OfferFlow 的本地后端和项目内 SQLite 数据库。

技术栈固定为：

```txt
Vue 前端 -> HTTP API -> Node.js + Fastify -> data/offerflow.sqlite3
```

本轮废弃旧 v0.4 / v0.5 的 Tauri、Rust、localService 和桌面路线，不再保留 `src-tauri/` 作为项目路线。

## 数据库

DB 文件固定为：

```txt
data/offerflow.sqlite3
```

本轮允许提交该 DB 文件。仅忽略 SQLite sidecar：

```txt
data/*.sqlite3-wal
data/*.sqlite3-shm
```

schema 采用最小表设计：

- `app_meta`：保存 `schema_version=1`
- `profiles`：保存全局 profile 完整 JSON
- `jobs`：保存岗位完整 JSON，并抽取列表查询需要的索引列
- `import_logs`：记录 JSON 备份导入摘要

## 边界

v0.4 只补本地后端和数据库，不做：

1. 云同步
2. 账号 / 登录
3. AI API / BYOK
4. Boss 自动化
5. 远程数据库
6. Tauri / Rust / 桌面路线
7. 新增 Company / Contact / Message / JobStatusLog 等业务实体

## 启动

```bash
npm run dev
```

该命令同时启动：

- `npm run server`：Fastify API，监听 `http://127.0.0.1:17365`
- `npm run web`：Vite 前端，默认 `http://localhost:5173`

## 迁移

从浏览器 localStorage JSON 备份导入：

```bash
npm run import:backup -- path/to/offerflow-web-backup.json
```

导入规则：

- 只识别 `offerflow:profile`、`offerflow:job:*`、`offerpilot:profile`、`offerpilot:job:*`
- `offerflow` 优先于 `offerpilot`
- 坏 job JSON 进入 warnings，不中断整体导入
- upsert 写入，不清空已有 DB
- 不删除原 JSON
- 不删除浏览器 localStorage
