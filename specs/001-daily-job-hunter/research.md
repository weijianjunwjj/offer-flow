# OfferFlow v0.9 技术研究报告

> **版本：** 2.0  
> **对应 Plan：** `specs/001-daily-job-hunter/plan.md`  
> **创建日期：** 2026-08-11  
> **最后修订：** 2026-08-11（Plan Amendment 修正 Jooble API 假设 / Secret Storage / Autostart / Migration）

---

## 1. Jooble REST API Contract

### 1.1 基本信息

| 项目 | 内容 |
|------|------|
| API 类型 | REST API（POST） |
| Endpoint | `POST /api/{api_Key}` |
| 认证方式 | API Key 嵌入 URL 路径 |
| Content-Type | `application/json` |
| 响应格式 | JSON |

### 1.2 请求格式

```json
{
  "keywords": "前端 React TypeScript",
  "location": "苏州",
  "radius": 50,
  "salary": 150000,
  "page": 1,
  "ResultOnPage": 20,
  "SearchMode": 0
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `keywords` | string | 是 | 搜索关键词，空格分隔多词 |
| `location` | string | 否 | 城市/地区 |
| `radius` | number | 否 | 搜索半径（单位待确认） |
| `salary` | number | 否 | 薪资过滤（具体语义验证后确认） |
| `page` | number | 否 | 页码（从 1 开始） |
| `ResultOnPage` | number | 否 | 每页结果数 |
| `SearchMode` | number | 否 | 搜索模式 |
| `companysearch` | boolean | 否 | 公司搜索 |

### 1.3 响应格式

```json
{
  "jobs": [
    {
      "id": "12345678",
      "title": "高级前端开发工程师",
      "company": "某科技有限公司",
      "location": "苏州",
      "salary": "15K-25K",
      "snippet": "负责Web前端开发，使用React、TypeScript...",
      "source": "BOSS 直聘",
      "type": "full-time",
      "link": "https://...",
      "updated": "2026-08-10T12:00:00Z"
    }
  ],
  "totalCount": 42
}
```

| 字段 | 类型 | 说明 | 映射到 |
|------|------|------|--------|
| `id` | string | Jooble 内部 ID | `externalRecordId` / 幂等键 |
| `title` | string | 岗位标题 | `title` → `recognizedFields.role` |
| `company` | string | 公司名 | `company` → `recognizedFields.company` |
| `location` | string | 工作地点 | `location` → `recognizedFields.city` |
| `salary` | string | 薪资范围（文本） | `salary` → 解析到 `salaryMinK/salaryMaxK` |
| `snippet` | string | **岗位摘要（Snippet，非完整 JD）** | `snippet` → `visibleText` |
| `source` | string | 原始来源站名 | `source` → Snapshot metadata（provenance） |
| `link` | string | 原始岗位 URL | `link` → `sourceUrl` |
| `updated` | string | 更新时间 | `updated` → `capturedAt` 参考 |
| `type` | string | 岗位类型 | `type` → Snapshot metadata |

### 1.4 关键假设与限制

**Jooble 官方 API 当前确认提供的是 `snippet`（岗位摘要），不是完整 JD。**

Plan 明确不假定 Jooble API 一定返回完整 JD。因此：

- Jooble Result → 保存完整 API 原始 payload + provenance → Radar Ingestion → 数据质量评估
- 只有事实充分的 CandidateVersion 才进入正式 MatchAnalysis
- 信息不足时：保留 Candidate + Data Quality / insufficient evidence
- **禁止**：根据 snippet 编造完整 JD
- **禁止**：为补全 JD 自动去抓 BOSS/拉勾/猎聘/智联/前程无忧等专业招聘平台页面
- 如果 `link`/`source` 指向允许主动读取的公开来源，未来由对应 Provider 独立处理

### 1.5 分页

- 通过 `page` 参数控制
- `ResultOnPage` 控制每页返回数量
- `totalCount` 表示总岗位数
- v0.9 默认每 SearchTask 最多 1 页（受 `scanBudget.maxPagesPerTask` 控制）
- 达到 Scan Budget 后停止后续 page 请求

### 1.6 错误处理

| 情况 | HTTP Status | 处理 |
|------|------------|------|
| 正常搜索，0 结果 | 200, `jobs=[]` | `VALID_EMPTY` |
| API Key 无效 | 401 或特定 error body | `AUTH_ERROR` |
| 频率限制 | 429 | `RATE_LIMITED` |
| 请求超时 | 无响应 | `TIMEOUT` |
| 网络错误 | 连接失败 | `NETWORK_ERROR` |
| 响应格式异常 | 200, 但 JSON 结构不符 | `MALFORMED_RESPONSE` |
| Provider 服务故障 | 5xx | `PROVIDER_UNAVAILABLE` |

**关键**：`VALID_EMPTY` 仅当 HTTP 200 + 响应 JSON 合法 + `jobs` 为空数组时成立。其余一切异常都进入 FAILED / ACTION_REQUIRED 对应状态。

### 1.7 Source Provenance

Jooble 聚合来自多个招聘来源的岗位。`source` 字段标识原始来源站名（如"BOSS 直聘"、"拉勾"、"前程无忧"），`link` 指向原始岗位 URL。两者均必须保存到 Snapshot metadata，用于：
- 后续 Browser Manual Capture 去重（同一岗位可能被 Jooble 发现 + 用户手动采集）
- 来源可信度评估
- 用户点击原岗位链接

---

## 2. Jooble Authentication

### 2.1 API Key 获取

- 在 `https://jooble.org/api/about` 提交申请表单
- 申请信息：姓名、职位、邮箱、网站、电话
- Approval 后获得 API Key

### 2.2 Secret 管理

- API Key 不进 Git、不进普通日志、不进前端代码
- 存储方式：通过 SecretStore（Windows DPAPI / 开发环境变量）
- 运行时由 Provider Adapter 读取
- API 响应不返回明文 Key
- DB backup 不含 Key 明文

---

## 3. Rate Limit / Usage Policy

### 3.1 Provider Quota

**当前具体额度未冻结。** 取得真实 API Key 后验证。

无论官方额度如何，OfferFlow 自身仍实施：
- 有限请求（Scan Budget 控制单次 SourceRun 总页数）
- Provider Adapter 内退避策略（最小请求间隔）
- 达到 API 返回的速率限制后 → `RATE_LIMITED` 错误码
- SourceRun 标记 FAILED / PARTIALLY_SUCCEEDED
- 不绕过限制
- 次日自动恢复

---

## 4. Pagination

### 4.1 Jooble Pagination

- `page` 参数：整数，从 1 开始
- `ResultOnPage`：每页返回数量
- 响应 `totalCount`：总岗位数

### 4.2 v0.9 分页策略

- 默认每 SearchTask 只请求第 1 页
- `scanBudget.maxPagesPerTask` 可配置（默认 1）
- `scanBudget.maxTotalPages` 单次 SourceRun 总页数上限
- 达到任一限制立即停止

---

## 5. Empty / Error Semantics

### 5.1 Valid Empty

```
HTTP 200 + JSON 合法 + jobs.length === 0
→ VALID_EMPTY
→ SourceRun 记录 scannedCount=0
→ DailyJobBrief.emptyReason = "所有搜索范围均未返回职位列表"
```

### 5.2 Error 分类

```
AUTH_ERROR          → SourceRun FAILED + ACTION_REQUIRED Outbox
RATE_LIMITED        → SourceRun FAILED（次日自动恢复）
TIMEOUT             → SourceRun FAILED（可 RETRY）
NETWORK_ERROR       → SourceRun FAILED（可 RETRY）
MALFORMED_RESPONSE  → SourceRun FAILED
PROVIDER_UNAVAILABLE → SourceRun FAILED（可 RETRY）
```

---

## 6. Source Provenance

### 6.1 Jooble Source 字段

- `source`: 字符串，标识原始招聘来源（如 "BOSS 直聘"、"拉勾"、"前程无忧"）
- `link`: URL 字符串，指向原始岗位页面
- 两者均保存到 `radar_capture_snapshots.raw_snapshot_json` 中

### 6.2 去重考虑

- 同一岗位可能被 Jooble 发现 + 用户通过 Browser Manual Capture 采集
- 去重优先使用 `normalized_source_url`（对 `link` URL 做标准化）
- 其次使用 `providerKey + externalRecordId`（jooble + jooble_id）

---

## 7. Windows Autostart

### 7.1 推荐方案

**P0 canonical mechanism**：

> `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

原因：
- 单用户 local-first，不需要管理员权限
- 可以明确 enable / disable
- 可以由 UI 显示安装状态
- Windows 登录后启动即可
- Scheduler Catch-up 已负责补偿错过的任务

### 7.2 Fallback

仅当真实兼容性问题出现后才评估启动文件夹（`Start Menu\Programs\Startup`）方案。

### 7.3 实现方式

- `POST /api/local-service/autostart/enable` → 写入注册表 Run 键
- `POST /api/local-service/autostart/disable` → 删除注册表 Run 键
- `GET /api/local-service/status` → 返回 `autostart: boolean`
- 启动命令：通过注册表配置，指向 `bash -c "cd /d/VSCode/offer-flow && pnpm run dev"`

### 7.4 与开发环境的区分

- 开发命令：Bash-only（`pnpm run dev`）
- 产品运行时 Autostart：Windows 注册表 Run 键（通过 API 管理）
- Runtime 调用 Windows 原生能力 ≠ PowerShell 作为开发 Shell

---

## 8. Node SMTP Implementation

### 8.1 库选择

推荐 `nodemailer`——成熟、零配置 SMTP 库，支持 QQ SMTP。

```bash
pnpm add nodemailer
pnpm add -D @types/nodemailer
```

### 8.2 QQ SMTP 配置

```ts
const transporter = nodemailer.createTransport({
  host: 'smtp.qq.com',
  port: 465,
  secure: true,  // TLS
  auth: {
    user: 'xxx@qq.com',
    pass: '授权码',  // QQ 邮箱 SMTP 授权码（不是 QQ 密码）
  },
});
```

### 8.3 授权码获取

- QQ 邮箱 → 设置 → 账户 → POP3/IMAP/SMTP 服务 → 生成授权码
- 授权码 = SMTP 密码，不是 QQ 登录密码

### 8.4 v0.9 集成

- SMTP 配置存储在 `notification_channels` 表
- 授权码通过 SecretStore 保护
- `POST /api/notification-channels/:id/test` 发送测试邮件
- Outbox Worker 负责实际发送

---

## 9. Local Secret Storage

### 9.1 需求

- 存储 Jooble API Key
- 存储 QQ SMTP 授权码
- 不进 Git
- 不进日志
- API 不返回明文
- DB backup 不包含明文 Secret

### 9.2 方案

**`SecretStore` 抽象**：

```
Production / Windows：
→ Windows DPAPI 或等价 Windows Credential 机制
→ Secret 加密结果可存入本地配置/数据库
→ 解密能力绑定当前 Windows 用户/机器

Development / Test：
→ 允许环境变量注入
```

**P0 目标**：
- 加密结果可存储在本地配置/数据库
- 解密能力绑定当前 Windows 用户/机器
- 备份数据库不包含明文 Secret
- 跨机器 restore 后 Secret 需要重新配置
- 用户 Windows 凭据异常 → `ACTION_REQUIRED`
- 不为两个 Secret 构建 Vault / KMS

**实施注意事项**：
- 任务阶段研究最小可靠 Node ↔ Windows DPAPI 实现方式
- 不需要现在绑定特定第三方 Node package
- SecretStore 抽象使未来实现方式可替换

---

## 10. Provider Validation Gate

### 10.1 目的

在投入完整 Discovery 基建前，先验证 Jooble 的真实能力。

### 10.2 验证清单

1. API Key 能真实取得
2. 中国地区搜索可调用
3. 苏州 / 无锡等至少一个目标城市能获得真实结果
4. 返回字段和官方 contract 一致
5. 真实结果的数据完整度足以进入 Radar
6. 至少部分结果具备正式 MatchAnalysis 所需的最低事实
7. `source`/`link` 行为真实可追踪

### 10.3 失败处理

如果验证失败：
- 记录为 **Provider Validation Failed**
- 不偷改 Radar 规则
- 不爬专业招聘平台补数据
- 重新进行 Provider 决策

---

## 11. Existing Radar Ingestion Extraction Strategy

### 11.1 当前架构

`RadarCaptureService`（`server/radar/service.ts`）已实现完整的 ingestion 链：

```
materializeItem(item, sessionId)
  → buildSnapshot(sessionId, item, now)
    → insertSnapshot
  → normalizeCandidateFields({ recognizedFields, rawDescription })
  → resolveIdentity({ providerKey, externalRecordId, sourceUrl })
  → decideCommit({ identity, previousNormalized, nextNormalized, snapshotId })
  → 分路径执行:
    - identity_conflict → 仅 Snapshot
    - no_change / snapshot_only / extraction_regression / ambiguous_change → 不建版本
    - material_change → insertNewVersion('source_change')
    - new_identity → insert SourceRecord + Candidate + Version('captured')
```

### 11.2 抽取策略

将 `materializeItem` 的核心逻辑拆分为 `RadarIngestionService.ingest(IngestionInput)`：

**保留在 `RadarCaptureService`**：
- Session 管理（createSession, addItem, cancelSession, commitSession）
- Preview item 校验
- 纠错（corrections）
- Session 幂等（committed replay）

**抽取到 `RadarIngestionService`**：
- Snapshot 构造与写入
- normalize
- identity resolution
- fingerprint
- material change decision
- Candidate/Version/SourceRecord 创建与更新

**输入契约 `IngestionInput`** 不包含 `RadarPreviewItem` 特有概念（如 `index`、`captureSessionId` 虽保留但可选），使 Browser Capture 和 SearchProvider 均可调用。

### 11.3 兼容性保证

- 所有现有 Browser Capture 测试继续通过
- `captureSessionId` 从 `RadarCaptureService` 传入（非 null）
- `captureMethod='boss_current_page'` 或 `'generic_visible_text'` 保持不变
- Active Discovery 传入 `captureSessionId=null` + `captureMethod='api_discovery'`

### 11.4 `capture_method` CHECK 迁移

真实当前 schema（`server/migrations/radarDomainSchemaV7.ts`）：
```sql
capture_method TEXT NOT NULL CHECK (
  capture_method IN (
    'boss_current_page', 'generic_visible_text',
    'pasted_text', 'shared_link_and_text', 'json_import'
  )
)
```

新增 `'api_discovery'` 需要 SQLite 表重建 migration（与 schema v8 的 `radar_actions` 重建流程一致）。

详见 `plan.md §2.2` 和 `data-model.md §2.1`。
