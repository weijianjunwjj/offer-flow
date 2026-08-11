# OfferFlow v0.9 快速启动 / 本地开发验证流程

> **版本：** 1.0  
> **对应 Plan：** `specs/001-daily-job-hunter/plan.md`  
> **创建日期：** 2026-08-11  

---

## 环境

- **操作系统**：Windows 11 Home（原生）
- **Shell**：Git Bash（所有命令使用 Bash，禁止 PowerShell/CMD）
- **Node.js**：≥ 18
- **包管理**：pnpm

---

## 1. 前置条件

```bash
# 确认仓库状态
cd /d/VSCode/offer-flow
git status
git branch  # 应在 feat/v0.9

# 确认依赖
pnpm install

# 确认现有测试通过
pnpm vitest run
pnpm vue-tsc --noEmit
pnpm build
```

---

## 2. 本地开发启动

```bash
# 启动开发模式
pnpm run dev

# 这会启动：
# - Fastify 后端（默认 127.0.0.1:3000）
# - Vite 前端（默认 127.0.0.1:5173）
# - 使用本地 SQLite 数据库
```

---

## 3. V9-0：Jooble Provider Validation Gate

在投入完整 Discovery 基建前，先验证 Jooble 的真实能力。

### 3.1 获取 API Key

1. 访问 `https://jooble.org/api/about`
2. 填写申请表单
3. Approval 后获得 API Key

### 3.2 真实 API 验证

```bash
# 设置 API Key（开发环境使用环境变量）
export OFFERFLOW_JOOLE_API_KEY="your-api-key-here"

# 运行 Provider Validation 脚本
pnpm run provider:validate
```

### 3.3 验证清单

1. API Key 能真实取得
2. 中国地区搜索可调用
3. 苏州 / 无锡等至少一个目标城市能获得真实结果
4. 返回字段和官方 contract 一致
5. 真实结果的数据完整度足以进入 Radar
6. 至少部分结果具备正式 MatchAnalysis 所需的最低事实
7. `source`/`link` 行为真实可追踪

### 3.4 如果验证失败

- 记录为 Provider Validation Failed
- 不偷改 Radar 规则
- 不爬专业招聘平台补数据
- 重新进行 Provider 决策

---

## 4. V9-1：Shared Radar Ingestion Core 验证

### 3.1 启动沙箱

```bash
# 启动 Radar 沙箱（隔离数据库，Radar 功能开启）
pnpm run dev:radar-sandbox
```

### 3.2 运行测试

```bash
# Radar Ingestion 测试
pnpm vitest run server/radar/service.spec.ts
pnpm vitest run server/radar/ingestion/  # V9-1 新增

# 现有 Browser Capture 回归
pnpm vitest run server/radar/routes.spec.ts
pnpm vitest run server/radar/radar.spec.ts

# 全量回归
pnpm vitest run
```

### 3.3 验证点

1. Browser Capture 旧行为不变（Snapshot/Candidate/Version 创建不变）
2. `capture_method='api_discovery'` Snapshot 可正常写入（需 schema v9）
3. `captureSessionId=null` Snapshot 不影响 Ingestion 逻辑
4. 同 source 同 externalId → 同一 Candidate（浏览器和 API 两路输入共用去重）
5. 表重建 migration（v8→v9）v0.8 Radar 回归通过

---

## 5. V9-2：SearchPlan + Scheduler + Jooble Discovery 验证

### 4.1 配置 Jooble API Key

```bash
# 开发环境使用环境变量注入
export OFFERFLOW_JOOLE_API_KEY="your-api-key-here"
```

### 4.2 配置 Secret Store

```bash
# 开发环境使用环境变量（Production 使用 Windows DPAPI）
export OFFERFLOW_SECRET_STORE_MODE="env"

# V9-4 阶段配置 QQ SMTP 授权码
export OFFERFLOW_QQ_SMTP_AUTH_CODE="your-smtp-auth-code"
```

### 4.3 运行测试

```bash
# SearchPlan API 测试
pnpm vitest run server/search-plan/

# Jooble Provider 测试（使用 mock）
pnpm vitest run server/search-provider/jooble.spec.ts

# Scheduler 测试
pnpm vitest run server/scheduler/

# SourceRun 测试
pnpm vitest run server/source-run/
```

### 4.4 手动验证

```bash
# 创建 SearchPlan（通过 API）
curl -X POST http://127.0.0.1:3000/api/daily-search-plans \
  -H "Content-Type: application/json" \
  -d '{
    "name": "每日前端岗位",
    "cities": [{"name":"苏州","priority":1}],
    "roleDirections": ["前端开发"],
    "baseKeywords": ["React","TypeScript"],
    "sourceConfigs": [{"providerKey":"jooble"}],
    "schedule": {"dailyAt":"09:00"},
    "scanBudget": {"maxPagesPerTask":1},
    "analysisBudget": {"maxAnalysesPerRun":5},
    "notificationPolicy": {"highPriorityEnabled":true,"dailyBriefEnabled":true}
  }'

# 手动触发运行
curl -X POST http://127.0.0.1:3000/api/daily-search-plans/<planId>/run-now

# 查看 SourceRun 状态
curl http://127.0.0.1:3000/api/source-runs
```

---

## 6. V9-3：DailyJobBrief 验证

### 5.1 运行测试

```bash
# Pipeline 测试
pnpm vitest run server/pipeline/

# DailyBrief 测试
pnpm vitest run server/daily-brief/

# Analysis + Recommendation 复用回归
pnpm vitest run server/radar/analysis/
pnpm vitest run server/radar/recommendation/
```

### 5.2 验证点

1. Pipeline：discover → ingest → analyze → recommend → buildBrief 完整链路
2. 不新增分析任务类型
3. DailyBrief 引用（不复制）RecommendationBatch
4. 0-8 推荐
5. 空 Brief + emptyReason
6. Cost Summary 展示

---

## 7. V9-4：QQ SMTP + Outbox 验证

### 6.1 配置 Secret Store

```bash
# 开发环境使用环境变量模式（Production 使用 Windows DPAPI）
export OFFERFLOW_SECRET_STORE_MODE="env"
```

### 6.2 配置邮箱 Channel

```bash
curl -X POST http://127.0.0.1:3000/api/notification-channels/email \
  -H "Content-Type: application/json" \
  -d '{
    "channelType": "QQ_SMTP_EMAIL",
    "displayName": "我的QQ邮箱",
    "senderAddress": "xxx@qq.com",
    "recipientAddress": "xxx@qq.com",
    "secret": "你的QQ邮箱SMTP授权码",
    "config": {
      "smtpHost": "smtp.qq.com",
      "smtpPort": 465,
      "tls": true,
      "highPriorityEnabled": true,
      "dailyBriefEnabled": true,
      "quietHours": {"start":"22:00","end":"08:00"}
    }
  }'

# 发送测试邮件
curl -X POST http://127.0.0.1:3000/api/notification-channels/<channelId>/test
```

### 6.3 运行测试

```bash
# Notification 测试
pnpm vitest run server/notification/

# Outbox 幂等测试
pnpm vitest run server/notification/outbox.spec.ts
```

### 6.4 验证点

1. 测试邮件成功送达
2. Outbox 状态转换：PENDING → SCHEDULED → SENDING → SENT
3. 幂等键防重复
4. SMTP 临时失败 → FAILED_RETRYABLE → 自动重试
5. SMTP 授权失败 → ACTION_REQUIRED（不无限重试）

---

## 8. V9-5 / V9-6：Judgment + Preference 验证

### 7.1 运行测试

```bash
# JobJudgment 测试
pnpm vitest run server/judgment/

# 审批进度派生测试
pnpm vitest run server/judgment/progress.spec.ts

# PreferenceSignal 测试
pnpm vitest run server/preference/signal.spec.ts

# PreferenceRule 测试
pnpm vitest run server/preference/rule.spec.ts

# RadarRuleAssessment category='preference' 集成测试
pnpm vitest run server/radar/ruleAssessment.spec.ts
```

### 7.2 验证点

1. 四档判断创建/修改/撤销
2. 审批进度派生（不用 currentIndex）
3. Signal 提取（source 区分）
4. Rule 激活阈值（2 强信号 / 3 中信号）
5. 高影响规则需 EXPLICIT_CONFIRM
6. Preference → RadarRuleAssessment 集成
7. Recommendation 受 Preference 影响

---

## 9. 全量回归

```bash
# 全量测试
pnpm vitest run

# TypeScript 编译
pnpm vue-tsc --noEmit

# 构建
pnpm build

# Migration selftest
pnpm migration:selftest

# DB 医生
pnpm db:doctor
```

---

## 10. 连续 3 自然日真实运行验收

1. 配置真实 SearchPlan（苏州/无锡，前端方向，Jooble Provider）
2. 确保服务开机自启动（`POST /api/local-service/autostart/enable`）
3. 第一天：验证 Scheduler 自动触发、Jooble 返回岗位、进入 Radar、完成分析、形成推荐、收到日报邮件
4. 第二天：验证重复岗位不重复创建 Candidate、变化岗位进入新 CandidateVersion、新岗位正常摄入
5. 第三天：验证 Preference 累积（做四档判断 → 确认 Signal → Rule 激活 → 下一轮推荐受偏好影响）
6. 中途测试：关机/睡眠后恢复 → Catch-up 机制
7. 中途测试：Provider 失败 → 显式错误（不伪装 0 岗位）

---

## 11. 开发命令速查

```bash
# 开发模式（前后端）
pnpm run dev

# 仅后端
pnpm run dev:server

# Radar 沙箱（隔离数据库）
pnpm run dev:radar-sandbox

# 运行特定波次测试
pnpm vitest run server/radar/ingestion/    # V9-1
pnpm vitest run server/search-plan/         # V9-2
pnpm vitest run server/search-provider/     # V9-2
pnpm vitest run server/scheduler/           # V9-2
pnpm vitest run server/pipeline/            # V9-3
pnpm vitest run server/notification/        # V9-4
pnpm vitest run server/judgment/            # V9-5
pnpm vitest run server/preference/          # V9-6

# Migration
pnpm migration:selftest

# DB 状态
pnpm db:doctor

# 构建
pnpm build
```
