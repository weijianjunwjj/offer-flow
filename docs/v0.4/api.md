# OfferFlow v0.4 HTTP API

Base URL:

```txt
http://127.0.0.1:17365
```

## Meta

### GET /health

返回：

```json
{ "ok": true }
```

### GET /meta/db-path

返回当前 SQLite 文件路径。

```json
{ "path": "D:\\VSCode\\offer-pilot\\data\\offerflow.sqlite3" }
```

## Profile

### GET /profile

没有数据时返回：

```json
null
```

有数据时返回完整 `JobSeekerProfile` JSON。

### PUT /profile

请求体为完整 `JobSeekerProfile` JSON。保存后返回同一份 JSON。

### DELETE /profile

幂等删除 profile。

```json
{ "ok": true }
```

## Jobs

### GET /jobs

按 `updatedAt desc` 返回完整 `JobRecord[]`。

### POST /jobs

请求体为岗位 JSON。没有 `id` 时服务端生成 id。

### GET /jobs/:id

返回完整 `JobRecord`。不存在返回 `404`。

### PUT /jobs/:id

完整替换岗位。服务端保留路径中的 `id`，并写入新的 `updatedAt`。

### PATCH /jobs/:id

局部更新岗位，未传字段保留。不存在返回 `404`。

### DELETE /jobs/:id

幂等删除岗位。

```json
{ "ok": true }
```

## Imports

### POST /imports/localstorage/preview

只解析 JSON 备份，不写 DB。

返回：

```json
{
  "profileCount": 1,
  "jobCount": 3,
  "ignoredKeyCount": 6,
  "parseErrorCount": 1,
  "warnings": [],
  "imported": false
}
```

### POST /imports/localstorage/apply

解析并 upsert 写入 DB，不清空已有数据。

返回同 preview 摘要，并额外返回 `importLogId`：

```json
{
  "profileCount": 1,
  "jobCount": 3,
  "ignoredKeyCount": 6,
  "parseErrorCount": 1,
  "warnings": [],
  "imported": true,
  "importLogId": "..."
}
```
