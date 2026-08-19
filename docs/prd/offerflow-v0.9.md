# OfferFlow v0.9 PRD

> **版本名称：** 每日岗位猎手  
> **产品版本：** v0.9.0  
> **PRD 版本：** 2.4 FROZEN  
> **编制日期：** 2026-08-11  
> **最终冻结日期：** 2026-08-19  
> **前置版本：** OfferFlow v0.8.0 GA  
> **状态：** FROZEN / RELEASE CANDIDATE  
> **基线约束：** v0.7 / v0.8 已冻结事实、数据模型和领域语义不得被 v0.9 反向改写  
> **一句话定位：** OfferFlow 在电脑端每天主动替用户寻找可能合适的真实岗位，复用 v0.8 Radar 完成可信分析与有限推荐，把主动发现的机会汇总到每日简报；用户在电脑端查看推荐结果并做出决策。  
> **Scope Amendment：** Notification / JobJudgment / Preference Learning 已迁移至 v1.0（详见 §28 和 `docs/prd/offerflow-v1.0.md`）

---

**Final Scope Amendment — 2026-08-19**

v0.9 最终冻结范围已从初始规划中移除以下能力，迁移至 v1.0：

1. **Notification / QQ SMTP** — NotificationChannel、HIGH_PRIORITY_ALERT、DAILY_BRIEF 邮件等
2. **JobJudgment / 四档审批** — VERY_SUITABLE/SOMEWHAT_SUITABLE/NOT_VERY_SUITABLE/VERY_UNSUITABLE 判断
3. **Preference Learning** — PreferenceSignal、PreferenceRule、Repeated Mistake Protection 等

**v0.9 最终交付：** Discovery + Analysis + Recommendation + DailyJobBrief + 前端展示。用户可在电脑端查看推荐，使用现有 RadarAction 标记岗位。

详细迁移记录见 `docs/prd/offerflow-v1.0.md` 和本文档 §28。

---

## 0. 唯一版本主题

v0.9 只有一个核心主题：

> **让用户不再每天亲自大范围刷岗位。电脑端 OfferFlow 持续值班，主动寻找、分析和筛选岗位，把真正值得看的机会主动汇报给用户；用户只负责少量最终判断。**

完整闭环只有一条：

```text
DailySearchPlan
  ↓
本地 Scheduler 到点触发
  ↓
SearchProviderAdapter 主动寻找真实岗位
  ↓
Radar Ingestion Core
  ↓
复用 v0.8：
Snapshot
→ SourceRecord
→ RadarCandidate
→ CandidateVersion
→ RuleAssessment
→ AnalysisTask
→ MatchAnalysis
→ RecommendationBatch
  ↓
DailyJobBrief
  ↓
电脑端查看推荐结果
  ↓
使用现有 RadarAction（收藏/忽略/重点/已投递）标记岗位
```

v0.9 的核心价值：

- **主动发现真实岗位**：系统根据计划在公开 Web 搜索，无需用户手动查找
- **有限高质量推荐**：每日 0～8 条精选推荐，不凑数
- **完整覆盖追踪**：哪些成功、哪些失败，来源失败不伪装成"0 个新岗位"

v0.9 **不以自动投递、移动 App、长期人格记忆、HR 回复分析、公司情报平台或通用 Agent Runtime 为核心主题。**

---

# 1. 发布契约摘要

## 1.1 v0.9 必须交付的用户结果

1. 用户可以配置一份每日找岗计划：
   - 城市及优先级；
   - 岗位方向；
   - 基础关键词；
   - 可扩展关键词；
   - 薪资、经验、学历、公司类型等约束；
   - 明确排除项；
   - 岗位来源；
   - 每日运行时间；
   - 最晚补偿时间；
   - 单日扫描预算；
   - 单日正式分析预算；
   - 即时提醒策略；
   - 每日汇报策略。

2. 系统至少接入 **一个真实、可连续运行的主动岗位来源**。

3. P0 来源必须真的能够根据搜索计划主动寻找岗位，不能用以下能力冒充完成：
   - 手工复制 JD；
   - 浏览器扩展“采集当前页”；
   - Mock Provider；
   - Fixture；
   - 静态 JSON。

4. 每日任务运行在现有 OfferFlow 后端进程中，不依赖用户保持浏览器页面打开。

5. 本地服务能够随操作系统登录启动。

6. 计划时间因关机、睡眠、断网或服务未运行而错过时，恢复后可以执行一次受控 `CATCH_UP`。

7. 每次主动找岗必须展示真实覆盖：
   - 搜了什么；
   - 搜了多少；
   - 哪些成功；
   - 哪些失败；
   - 哪些等待用户处理；
   - 实际获得多少岗位。

8. 登录失效、验证码、安全验证、来源异常、解析失败和异常空结果不得伪装成“今天没有岗位”。

9. 主动来源获得的岗位必须进入 **现有 v0.8 Radar 数据链**，不得新建第二套 Candidate / Job / Opportunity。

10. 主动来源与现有浏览器手工采集最终必须共享同一套 Radar Ingestion Core。

11. v0.9 正式推荐继续使用现有 `RadarRecommendationBatch`。

12. 每日正式汇报数量为：

```text
0 ～ 8 条
```

不得为了数量下限塞入低质量岗位。

13. 系统每天形成一份 `DailyJobBrief`，它负责：
   - 今天发生了什么；
   - 今天覆盖了哪里；
   - 哪些运行失败；
   - 使用哪个 RecommendationBatch；
   - 当前审批进度；
   - 邮件发送情况。

14. `DailyJobBrief` 不拥有第二套独立推荐结果。

15. 支持 QQ SMTP：
   - 配置；
   - Secret 安全保存；
   - 测试邮件；
   - 每日汇报；
   - 高优先级即时提醒；
   - 发送失败追踪。

16. 所有正式邮件必须经过持久化 Outbox。

17. 同一 CandidateVersion、同一通知类型、同一接收人不得因为：
   - 多关键词命中；
   - 来源重跑；
   - 服务重启；
   - SMTP retry  
   
   重复通知。

18. 邮件只负责通知和预览，正式四档审批继续在电脑端完成。

19. 用户可以逐条选择：

```text
VERY_SUITABLE
SOMEWHAT_SUITABLE
NOT_VERY_SUITABLE
VERY_UNSUITABLE
```

20. JobJudgment 必须绑定：
   - RadarCandidate；
   - CandidateVersion；
   - 来源 MatchAnalysis；
   - DailyJobBrief；
   - 当时系统推荐结论。

21. 系统不得把四档判断等同于：
   - 收藏；
   - 已投递；
   - Application；
   - 客观招聘反馈；
   - 能力事实。

22. 极端判断、明显系统误判或高信息增益场景可以追问。

23. 默认每个岗位最多一个追问。

24. 用户原始理由必须和 AI 派生结论分开保存。

25. 单次判断只生成 PreferenceSignal，不自动生成永久硬规则。

26. 稳定 PreferenceRule 可以反哺：
   - 搜索关键词扩展；
   - 候选抑制；
   - 推荐排序；
   - 推荐解释。

27. 高影响规则必须由用户明确确认。

28. 系统再次推荐与强负向规则高度相似的岗位时：
   - 默认抑制；
   - 如果因为新差异重新推荐，必须解释新差异。

29. 系统必须保留一定探索能力，避免反馈闭环越用越窄。

30. v0.9 必须让成本可见：
   - 当日分析调用数量；
   - 模型使用信息；
   - 可获得时展示 Token / 实际成本；
   - 无可靠成本数据时明确标记“未计价”，不得估算冒充事实。

---

## 1.2 v0.9 明确不承诺

v0.9 不做：

- iOS App；
- 公网 OfferFlow；
- 跨设备同步；
- 邮件直接写回审批；
- 云端 7×24 常驻；
- 自动投递；
- 自动发送招呼；
- 自动上传简历；
- 自动添加 HR；
- 绕过验证码；
- 绕过登录、安全验证、频控或平台限制；
- 多招聘平台同时成熟接入；
- 第二套 Opportunity；
- 第二套 Job / Application；
- 第二套 CandidateVersion；
- 第二套 AI Task Runtime；
- PostgreSQL；
- Redis；
- BullMQ；
- 微服务；
- LangGraph；
- Prime Agent；
- Temporal；
- 通用 checkpoint engine；
- Agent 自动自主规划长期任务；
- 自动修改正式职业战略；
- 自动修改能力基线；
- 自动修改薪资底线；
- 自动改变目标城市；
- NovaWing 长期人格 Memory；
- 大而全公司数据库。

---

## 1.3 以下情况不等于 v0.9 完成

- 只有 SearchProvider 接口，没有真实来源；
- 只能手工点击搜索；
- Scheduler 放在 Vue 页面里；
- 页面关闭后任务停止；
- 新建了一套与 Radar 平行的岗位模型；
- SearchProvider 结果没有进入现有 CandidateVersion；
- 又写了一套 AI 分析任务系统；
- 又写了一套推荐表；
- 只有测试邮件，没有真实日报；
- 邮件不经过 Outbox；
- SMTP 失败直接丢失；
- 多关键词命中造成重复邮件；
- 没有覆盖报告；
- 来源失败却显示“0 个新岗位”；
- 用户点了四档，但下一轮完全没有变化；
- 每条岗位都追问；
- 用户否决过的岗位类型继续无解释重复出现；
- 没有合适岗位时硬凑数量；
- 为了所谓“断点续跑”提前建设 v1.0 Task Runtime。

---

# 2. v0.8 基线与 v0.9 架构原则

## 2.1 v0.8 已经拥有的能力

v0.9 将以下能力视为既有基础设施，不重新设计业务语义：

```text
RadarCaptureSnapshot
RadarSourceRecord
RadarCandidate
RadarCandidateVersion
RadarCandidateRelation
RadarRuleAssessment
AnalysisTask
JobMatchAnalysisRecord
RadarRecommendationBatch
RadarAction
RadarPromotion
```

因此 v0.9 的核心不是：

> 再造一个岗位雷达。

而是：

> **给现有 Radar 接上主动输入、每日值班、主动汇报和用户纠错闭环。**

---

## 2.2 三段新增能力

```text
前段：
Discovery
主动搜索 + 调度 + 运行覆盖

中段：
Delivery
DailyJobBrief + QQ Email + Outbox

后段：
Learning
JobJudgment + Reason + Preference
```

Radar 中间主干继续复用 v0.8。

---

## 2.3 Shared Radar Ingestion Core

现有浏览器采集与 v0.9 主动来源不得分别实现：

- normalize；
- identity resolution；
- fingerprint；
- material change；
- Candidate 创建；
- CandidateVersion 创建；
- Snapshot；
- SourceRecord 更新。

v0.9 必须把这段能力收敛为共享内部服务，例如：

```text
RadarIngestionService
```

调用关系：

```text
Browser Capture
      ↓
RadarIngestionService
      ↑
SearchProviderAdapter
```

主动来源不得通过“伪造浏览器 CaptureSession”的方式接入。

---

## 2.4 Adapter 原则

P0 至少存在：

```ts
interface SearchProviderAdapter {
  search(task: SearchTask, signal: AbortSignal): Promise<SearchResult>
}
```

来源实现不拥有 Candidate 业务语义。

Provider 只负责返回：

```text
来源身份
岗位 URL
externalRecordId（如果有）
岗位原文/可见文本
来源结构化字段
采集时间
来源版本
必要的 fetch 元数据
```

后续统一交给 Radar Ingestion。

未来更换来源不得要求修改 Candidate / Analysis / Recommendation 核心。

---

## 2.5 不建设通用 Task Runtime

v0.9 使用：

> **明确、简单、可测试的本地 Pipeline。**

不引入通用 Agent Runtime。

Pipeline 可以有步骤：

```text
discover
→ ingest
→ assess
→ analyze
→ recommend
→ buildBrief
→ enqueueNotifications
```

但这些是 v0.9 产品流程，不等于：

```text
session
goal
subagent
generic checkpoint
generic resume
agent heartbeat runtime
```

真正跨步骤 checkpoint / resume 留给后续版本。

---

# 3. 产品定位

OfferFlow v0.9 是：

> **受用户管理的个人岗位猎手。**

系统负责：

- 找；
- 收；
- 去重；
- 判断哪些值得 AI 正式分析；
- 调现有分析能力；
- 收敛成有限推荐；
- 主动汇报；
- 记住用户的纠错。

用户负责：

- 定义方向；
- 查看少量真正值得处理的岗位；
- 最终判断；
- 必要时补充原因；
- 决定哪些稳定偏好应长期生效。

核心体验原则：

1. 广泛寻找，有限汇报。
2. 主动通知，而不是等用户打开网页。
3. 手机读情报，电脑做决策。
4. 复用已有事实，不创造平行宇宙。
5. 一条条判断，不依赖神秘总分。
6. 理由比按钮更有长期价值。
7. 追问要有信息增益。
8. 单次反馈不过拟合。
9. 负反馈不能形成推荐黑洞。
10. 没好岗位就诚实汇报空结果。
11. 外部失败必须显式。
12. 所有可重试副作用都必须幂等。

---

# 4. 核心流程

## 4.1 每日主动找岗

```text
Scheduler 到达计划时间
↓
冻结本次 DailySearchPlanVersion
↓
展开 SearchTask
↓
SearchProviderAdapter 主动搜索
↓
真实岗位结果
↓
RadarIngestionService
↓
新建 / 未变化 / Material Change / 重复 / 冲突
↓
规则预检
↓
符合资格的 CandidateVersion 创建/复用 AnalysisTask
↓
复用 v0.8 MatchAnalysis
↓
应用 PreferenceRule
↓
生成/复用 RadarRecommendationBatch
↓
创建 DailyJobBrief
↓
写 NotificationOutbox
↓
QQ 邮箱
```

---

## 4.2 补偿运行

```text
原计划：09:00
↓
电脑关机/睡眠/服务关闭
↓
11:20 服务恢复
↓
检测今天该 PlanVersion 尚未形成有效运行
↓
且未超过 latestCatchUpTime
↓
创建新的 CATCH_UP SourceRun
↓
执行一次
```

要求：

- 一个计划版本同一自然日最多自动补偿一次；
- 已存在有效成功运行不得再补；
- 用户可以 Skip Today；
- 超过最晚补偿时间不自动运行；
- 补偿不得造成重复 CandidateVersion、Analysis 或邮件。

---

## 4.3 高优先级即时提醒

```text
新增 / Material Change
↓
规则未阻断
↓
current MatchAnalysis 成功
↓
达到即时提醒标准
↓
未被有效强负向 PreferenceRule 抑制
↓
尚未通知相同 CandidateVersion
↓
创建 HIGH_PRIORITY_ALERT Outbox
```

---

## 4.4 每日老板汇报

```text
本轮 Discovery 完成
↓
形成真实 Coverage
↓
生成 RadarRecommendationBatch（0～8）
↓
DailyJobBrief 引用该 Batch
↓
创建 DAILY_BRIEF
↓
QQ 邮箱收到
↓
用户手机预览
↓
回电脑端正式审批
```

---

## 4.5 用户审批

```text
打开今日汇报
↓
第一条
↓
看：
岗位事实
系统建议
主要理由
主要风险
原岗位链接
命中偏好
↓
四档判断
↓
有必要？
 ├─ 否 → 下一条
 └─ 是 → 最多一个具体追问 → 下一条
```

审批进度不依赖一个“当前 index”作为唯一事实。

系统通过：

```text
RecommendationBatch 中的候选
-
已有有效 JobJudgment
```

推导下一条未处理岗位。

因此应用重启后自然可以继续。

---

# 5. DailySearchPlan 与调度

## 5.1 DailySearchPlan

至少包括：

```text
cities
roleDirections
baseKeywords
expandedKeywords
hardConstraints
sourceConfigs
schedule
latestCatchUpTime
scanBudget
analysisBudget
briefPolicy
notificationPolicy
explorationPolicy
```

---

## 5.2 Plan Version

所有正式运行必须绑定不可变：

```text
DailySearchPlanVersion
```

修改计划时创建新版本。

旧 SourceRun 永远指向旧版本，不允许历史运行被新配置解释。

---

## 5.3 搜索任务展开

基础：

```text
city
× roleDirection
× keyword
× source
```

扩展关键词必须记录：

```text
来源 PreferenceRule
规则版本
为何扩展
```

用户可关闭系统扩展关键词。

---

## 5.4 Scheduler

Scheduler 运行于现有 OfferFlow 后端进程中。

不建设独立微服务。

要求：

- 网页关闭后仍运行；
- 同一计划同一调度窗口最多一个 active run；
- 支持：
  - SCHEDULED
  - CATCH_UP
  - MANUAL
  - RETRY
- RETRY 创建新 SourceRun，不覆盖旧失败 Run；
- 支持 Skip Today；
- 支持 Pause / Resume Plan；
- 服务恢复时检查错过计划；
- UI 可查看下一次运行时间。

---

## 5.5 本地服务

v0.9 **复用现有 OfferFlow Fastify Service**。

新增的只是：

```text
Scheduler
Discovery Pipeline
Notification Outbox Worker
SMTP Sender
Heartbeat / Status Projection
OS Autostart Integration
```

不得建立第二个长期业务后端。

需要明确一个现实边界：

> 已经停止的 OfferFlow Service 不能通过自己的 HTTP API 把自己启动。

因此 P0：

- UI 能显示在线/离线；
- Service 在线时可管理 Scheduler；
- UI 可管理“开机自动启动”安装状态；
- 手工启动由本机 launcher / 启动脚本完成；
- 不为“从网页启动一个已经不存在的进程”额外建设守护进程。

---

# 6. 主动岗位发现

## 6.1 P0 来源

v0.9 发布前必须冻结：

```text
P0 SearchProvider
```

要求：

- 真实；
- 可主动搜索；
- 能覆盖用户主要目标城市和岗位方向；
- 能连续真实运行；
- 能发现新岗位；
- 能读取足够内容进入 Radar；
- 登录/风控失败可显式识别；
- 不依赖违反平台安全机制的绕过手段。

**P0 来源当前为 Final Candidate 唯一待冻结项。**

---

## 6.2 当前浏览器扩展的定位

现有浏览器扩展继续作为：

```text
Manual Capture Source
```

用于：

- 当前页面采集；
- 人工补充；
- 来源验证；
- 手动兜底。

它不是 v0.9：

```text
Active SearchProvider
```

不得为了节省开发量扩大其安全边界并偷偷变成后台自动爬取器。

---

## 6.3 SearchResult → Radar

来源结果经过 Provider 后进入：

```text
RadarIngestionService
```

继续生成现有：

```text
RadarCaptureSnapshot
RadarSourceRecord
RadarCandidate
RadarCandidateVersion
RadarCandidateRelation
```

主动发现可以产生：

```text
captureSessionId = null
```

不得因此新建第二种 Snapshot。

---

## 6.4 SourceRun Coverage

每次运行必须产生真实 Coverage：

```text
plannedTasks
completedTasks
failedTasks
waitingForUserTasks

cities
roleDirections
keywords
expandedKeywords
sources

scannedCount
ingestedCount
newCandidateCount
materialChangeCount
duplicateCount
conflictCount
blockedCount
analysisRequestedCount
analysisSucceededCount
recommendationCount
alertCount
```

还必须列出：

```text
failedScopes[]
waitingForUserScopes[]
```

不能只给一个总数字。

---

# 7. 分析与推荐复用

## 7.1 分析

v0.9 不新增：

```text
SearchAnalysisTask
JobHunterAnalysisTask
DailyAnalysisTask
```

岗位正式分析继续使用现有：

```text
analysis_tasks
job_match_analysis_records
AnalysisService
```

只有满足资格的新 CandidateVersion 才进入正式分析。

---

## 7.2 重试与进程重启

现有 AnalysisTask 的可靠性语义继续保持。

v0.9 不把进程中断描述成“从模型思考中间继续”。

对于 SourceRun：

```text
旧 Run = INTERRUPTED / FAILED
```

随后：

```text
创建新的 RETRY Run
```

重新执行允许重放的 Pipeline。

由于 Radar Ingestion、Analysis 和 Notification 均必须幂等，重放不得制造重复事实。

---

## 7.3 RecommendationBatch 是唯一正式推荐集合

每天汇报使用现有：

```text
RadarRecommendationBatch
```

正式推荐：

```text
0～8 条
```

`DailyJobBrief` 不再保存：

```text
selectedCandidateIds[]
```

作为第二权威集合。

---

## 7.4 推荐基本门禁

继续遵循：

- stale analysis 不进入正式推荐；
- hard constraint 阻断；
- skip 不作为推荐；
- ignored 且内容未变化的岗位抑制；
- applied pending 抑制；
- Candidate 去重；
- 不凑数。

---

## 7.5 v0.9 Preference 对推荐的扩展

现有 Recommendation Projection 在 v0.9 增加：

```text
PreferenceRule / preference assessment
```

输入。

影响仅允许：

### 正向

```text
ranking boost
search expansion
explanation
```

### 负向

```text
ranking penalty
suppression
explanation
```

不得通过 Preference 绕过：

```text
hard constraint
applied pending
明确 ignore
数据质量阻断
```

---

## 7.6 探索位

每日 0～8 条中允许：

```text
0～1 条 exploration
```

目的：

- 防止反馈闭环过窄；
- 测试边界；
- 发现用户没有主动表达过的新偏好。

探索位仍必须：

- 有 current 分析；
- 不触碰 hard constraint；
- 非已投待反馈；
- 非已忽略未变化；
- 有明确“为什么值得探索”的解释。

探索位属于同一个 RecommendationBatch，不建立第二推荐集合。

---

# 8. QQ 邮箱与通知

## 8.1 通知类型

```ts
type NotificationType =
  | 'HIGH_PRIORITY_ALERT'
  | 'DAILY_BRIEF'
  | 'RUN_FAILED'
  | 'ACTION_REQUIRED'
  | 'TEST_EMAIL'
```

---

## 8.2 P0 默认策略

```text
HIGH_PRIORITY_ALERT
默认开启，可关闭

DAILY_BRIEF
每日最多一份正式日报

ACTION_REQUIRED
需要登录、安全验证、配置处理

RUN_FAILED
当日有效找岗无法完成

TEST_EMAIL
仅配置测试
```

---

## 8.3 Email 配置

至少包括：

```text
sender
recipient
smtpHost
smtpPort
tls
secretRef

highPriorityEnabled
dailyBriefEnabled
dailyBriefTime
quietHours
failureNoticeEnabled
```

Secret：

- 不进 Git；
- 不进普通日志；
- API 不返回明文；
- SQLite 普通备份不得包含授权码明文；
- 删除 Channel 时可删除对应 Secret。

---

## 8.4 即时邮件内容

至少包含：

```text
岗位
公司
城市
薪资
首次发现/发布时间

系统建议
2～3 个核心理由
主要风险
最大不确定性

命中的正向 Preference
原岗位链接

“正式审批请回到电脑端 OfferFlow”
```

禁止只发：

```text
匹配度 87 分
```

之类缺少解释的通知。

---

## 8.5 每日邮件内容

### Coverage

```text
计划时间
实际时间
是否补偿

城市
方向
关键词组合
来源

扫描
新增
变化
重复
阻断
分析
推荐

失败范围
等待用户范围
```

### 今日建议

展示 RecommendationBatch 的 0～8 条。

每条：

```text
岗位 / 公司
城市 / 薪资
recommendation
核心理由
主要风险
是否 exploration
是否已经即时提醒
原始链接
```

### 审批

```text
待审批
已审批
四档分布
```

---

## 8.6 空汇报

允许：

```text
【OfferFlow 日报】今天没有发现值得你处理的新岗位
```

必须解释：

- 今天实际搜了什么；
- 哪些来源成功；
- 哪些失败；
- 扫描了多少；
- 为什么没有进入推荐；
- 为什么没有拿低质量岗位凑数。

---

## 8.7 NotificationOutbox

所有正式发送流程：

```text
Business Event
↓
INSERT Outbox
↓
Worker Claim
↓
SMTP
↓
SENT
```

临时失败：

```text
FAILED_RETRYABLE
↓
有限退避
```

不可恢复：

```text
FAILED_FINAL
```

授权问题：

```text
ACTION_REQUIRED
```

邮件失败不得回滚：

```text
SourceRun
RadarCandidate
Analysis
RecommendationBatch
DailyJobBrief
JobJudgment
```

---

## 8.8 幂等

即时通知：

```text
candidateVersionId
+ notificationType
+ recipient
+ notificationRuleVersion
```

日报：

```text
dailyBriefId
+ recipient
+ templateVersion
```

相同幂等键不得存在两个有效发送。

---

# 9. DailyJobBrief

## 9.1 定位

DailyJobBrief 不是：

> 新的 RecommendationBatch。

而是：

> **某一天主动找岗执行结果、推荐批次、邮件和审批进度的业务汇报容器。**

---

## 9.2 核心结构

```ts
interface DailyJobBrief {
  id: string
  briefDate: string

  searchPlanVersionId: string
  sourceRunIds: string[]

  recommendationBatchId: string

  status:
    | 'GENERATING'
    | 'READY'
    | 'IN_REVIEW'
    | 'COMPLETED'
    | 'FAILED'

  coverageSummary: unknown
  costSummary: unknown

  emptyReason: string | null

  generatedAt: string
  completedAt: string | null
}
```

推荐岗位读取：

```text
recommendationBatch.selectedCandidateVersionIds
```

不得复制进 DailyJobBrief。

---

## 9.3 审批卡

至少展示：

- 岗位；
- 公司；
- 城市；
- 薪资；
- 发布时间；
- JD 核心职责；
- 系统建议；
- 核心理由；
- 主要风险；
- 最大不确定性；
- 命中 Preference；
- 原始来源；
- 最新 Snapshot；
- 完整 JD；
- 原岗位链接；
- 四档按钮；
- 补充理由。

---

## 9.4 审批效率

目标：

- 四档判断后自动下一条；
- 支持键盘快捷键；
- 可返回修改；
- 可中途退出；
- 页面刷新不丢；
- 服务重启不丢；
- 默认不填写文字；
- 只有高信息增益才追问。

---

## 9.5 完成摘要

完成后展示：

```text
VERY_SUITABLE 数量
SOMEWHAT_SUITABLE 数量
NOT_VERY_SUITABLE 数量
VERY_UNSUITABLE 数量

新增理由
新增 PreferenceSignal
待确认 PreferenceRule

本轮主要系统误判
下一轮预计变化
邮件送达情况
当日搜索/分析成本
```

---

# 10. 四档 JobJudgment

```ts
type JobSuitabilityJudgment =
  | 'VERY_SUITABLE'
  | 'SOMEWHAT_SUITABLE'
  | 'NOT_VERY_SUITABLE'
  | 'VERY_UNSUITABLE'
```

语义：

| Judgment | 用户语义 | 默认影响 |
|---|---|---|
| VERY_SUITABLE | 值得优先研究或行动 | 强正向信号 |
| SOMEWHAT_SUITABLE | 有价值但存在顾虑 | 弱正向 + 顾虑 |
| NOT_VERY_SUITABLE | 整体不值得投入 | 弱负向 |
| VERY_UNSUITABLE | 明显浪费时间或触碰偏好底线 | 强负向 |

---

## 10.1 与系统建议分开

保存系统当时的原始：

```text
apply_now
stretch
verify
skip
```

以及 confidence。

不要只存一个二次映射后的“系统四档”。

需要检测判断距离时，可以由规则层临时映射：

```text
apply_now = 4
stretch   = 3
verify    = 2
skip      = 1
```

但原始 Recommendation 永远保留。

---

## 10.2 修改与撤销

用户修改判断时：

- 旧判断保留历史；
- 新判断成为有效版本；
- 旧 PreferenceSignal 失效；
- 派生 PreferenceRule 重新计算；
- 不物理删除历史事实。

---

# 11. 理由追问

## 11.1 可以追问

满足以下之一：

- VERY_SUITABLE 且原因未知；
- VERY_UNSUITABLE 且原因未知；
- 用户判断与系统建议明显冲突；
- 当前判断和历史相似岗位冲突；
- 出现新的强偏好特征；
- 用户主动点“补充理由”。

---

## 11.2 不应该追问

- 已有 PreferenceRule 足够解释；
- 最近相似岗位已回答；
- 信息增益低；
- 用户跳过；
- 用户开启快速审批；
- AI 不确定自己应该问什么。

---

## 11.3 约束

每岗位：

```text
自动追问 ≤ 1
```

问题必须：

- 基于当前 JD；
- 具体；
- 优先 2～4 个选项；
- 允许“其他”；
- 允许跳过；
- 不诱导答案。

AI 失败时：

> 直接完成 JobJudgment，不阻塞审批。

---

# 12. Preference Memory

## 12.1 三层模型

```text
JobJudgment
↓
PreferenceSignal
↓
PreferenceRule
```

### JobJudgment

具体岗位的用户判断。

### PreferenceSignal

一次局部偏好证据。

### PreferenceRule

重复信号或用户确认后的稳定规则。

---

## 12.2 Preference 不是长期人格 Memory

v0.9 Preference 的 Scope 是：

> **求职岗位筛选。**

不得直接提升为：

- 人生价值观；
- 长期人格；
- NovaWing Core Memory；
- 通用用户 Memory。

未来需要跨产品长期记忆时，通过显式 Adapter / Proposal 再处理。

---

## 12.3 激活

稳定规则可以在：

- 用户明确确认；
- 至少 2 个独立岗位形成相同强信号；
- 至少 3 个独立岗位形成相同中等信号；

之后激活。

---

## 12.4 高影响规则

以下必须用户明确确认：

- 屏蔽城市；
- 屏蔽行业；
- 改主岗位方向；
- 改最低薪资；
- 把技术路线变硬排除；
- 全局屏蔽某类公司。

---

## 12.5 防过拟合

- 单个岗位不形成永久硬排除；
- 正向规则主要用于加权；
- 负向规则分“降权”和“抑制”；
- 保留 exploration；
- 新事实可以挑战旧 Preference；
- 规则可停用；
- 规则可删除；
- 规则可追溯来源 Judgment；
- 删除/撤销 Judgment 后重算派生结果。

---

## 12.6 与 RadarRuleAssessment 的关系

PreferenceRule 是：

```text
规则定义
```

对具体 CandidateVersion 执行后，应投影为现有：

```text
RadarRuleAssessment
category = 'preference'
```

Recommendation Pipeline 消费这些评估。

因此不建立：

```text
PreferenceCandidateAssessment
```

第二套候选规则评估体系。

---

# 13. 页面与信息架构

```text
岗位雷达
├─ 今日汇报
├─ 历史汇报
├─ 全部岗位
├─ 每日找岗计划
├─ 来源运行
├─ 通知中心
└─ 偏好记忆

设置
├─ 本地服务
└─ QQ 邮箱通知
```

---

## 13.1 `/radar/daily-brief`

- Coverage；
- 当前 RecommendationBatch；
- 邮件状态；
- 审批进度；
- 四档；
- 动态追问；
- 下一条；
- 完成总结。

---

## 13.2 `/radar/search-plan`

- Plan；
- 当前 Version；
- 城市；
- 方向；
- 关键词；
- 来源；
- Schedule；
- Catch-up；
- Scan Budget；
- Analysis Budget；
- 0～8 汇报上限；
- Exploration；
- 即时提醒；
- Pause；
- Run Now；
- Skip Today；
- Version History。

---

## 13.3 `/radar/source-runs`

- triggerType；
- status；
- phase；
- planned / actual time；
- Coverage；
- Count；
- failures；
- waiting for user；
- Cost；
- Retry 来源；
- 关联 DailyBrief。

---

## 13.4 `/notifications`

- Outbox；
- 类型；
- 状态；
- 收件人；
- Attempts；
- 错误；
- 发送时间；
- Retry；
- 业务实体；
- Idempotency Key 摘要。

---

## 13.5 `/radar/preferences`

- Signals；
- Active Rules；
- Proposed Rules；
- 正/负方向；
- 来源岗位；
- 最近命中；
- 影响 Scope；
- 激活方式；
- Disable；
- Delete。

---

## 13.6 `/settings/local-service`

在线时：

- Heartbeat；
- Scheduler；
- 下一次任务；
- 今日状态；
- missed schedule；
- Autostart 状态。

离线时：

```text
OfferFlow 本地服务未运行
定时找岗不会执行
```

不得显示一个实际上无法工作的“HTTP 启动服务”按钮。

---

# 14. 数据模型

表名允许实施时根据现有 Repo 命名调整，但领域关系冻结。

---

## 14.1 `daily_search_plans`

```text
id
name
status
active_version_id

created_at
updated_at
deleted_at
```

---

## 14.2 `daily_search_plan_versions`

```text
id
search_plan_id
version

cities_json
role_directions_json

base_keywords_json
expanded_keywords_json

hard_constraints_json
source_configs_json

schedule_json
scan_budget_json
analysis_budget_json

brief_policy_json
exploration_policy_json
notification_policy_json

created_at
activated_at
supersedes_version_id
```

---

## 14.3 `source_runs`

```text
id
search_plan_version_id

source_key
source_version

trigger_type
retry_of_run_id

status
phase

scheduled_for
started_at
finished_at

planned_task_count
completed_task_count

scanned_count
ingested_count

new_count
changed_count
duplicate_count
conflict_count

blocked_count

analysis_requested_count
analysis_succeeded_count

selected_count
alerted_count
failed_count

coverage_json
progress_json
cost_summary_json

error_code
error_message

created_at
updated_at
```

### `progress_json`

只能表示：

> **当前运行的进度和覆盖信息。**

它不是：

```text
generic checkpoint
agent checkpoint
resume token
```

不得被扩展为通用 Runtime 存档。

---

## 14.4 SourceRun Trigger

```text
SCHEDULED
CATCH_UP
MANUAL
RETRY
```

`RETRY` 是新的 Run。

不得把失败 Run 原地改回 Running 来覆盖历史。

---

## 14.5 `daily_job_briefs`

```text
id
brief_date

search_plan_version_id
source_run_ids_json

recommendation_batch_id

status

coverage_json
cost_summary_json
empty_reason

generated_at
completed_at
created_at
updated_at
```

**删除：**

```text
selected_candidate_ids_json
```

RecommendationBatch 是唯一权威推荐集合。

---

## 14.6 `job_judgments`

```text
id

daily_brief_id

radar_candidate_id
candidate_version_id
match_analysis_id

judgment

system_recommendation
system_confidence

judged_at

supersedes_judgment_id
reverted_at

created_at
updated_at
```

---

## 14.7 `judgment_reasons`

```text
id
judgment_id

reason_code
reason_text

polarity

related_jd_evidence_json

source
created_at
```

`source` 至少区分：

```text
USER_SELECTED
USER_TEXT
AI_EXTRACTED
```

AI_EXTRACTED 不得伪装成用户原话。

---

## 14.8 `preference_signals`

```text
id
judgment_id

feature_key
feature_value_json

direction
strength

scope_json
confidence

created_at
invalidated_at
```

---

## 14.9 `preference_rules`

```text
id

rule_type
feature_key

condition_json
effect_json

status
explanation

activation_mode

created_at
updated_at
disabled_at
```

建议 `rule_type`：

```text
RANK_BOOST
RANK_PENALTY
SUPPRESS
SEARCH_EXPAND
```

P0 不新增“修改职业战略”规则。

---

## 14.10 `notification_channels`

```text
id
channel_type
display_name

status

sender_address
recipient_address
secret_ref

config_json

last_tested_at
last_success_at
last_failure_at

created_at
updated_at
```

P0：

```text
QQ_SMTP_EMAIL
```

---

## 14.11 `notification_outbox`

```text
id

channel_id
notification_type

idempotency_key

subject
payload_json

status
priority

scheduled_at
locked_at

attempt_count
next_retry_at

last_error_code
last_error_message

sent_at

created_at
updated_at
```

---

## 14.12 `notification_links`

```text
notification_id
entity_type
entity_id
created_at
```

允许：

```text
RADAR_CANDIDATE
CANDIDATE_VERSION
RADAR_RECOMMENDATION_BATCH
DAILY_JOB_BRIEF
SOURCE_RUN
```

---

## 14.13 明确复用、不新增

不新增：

```text
RawSourceSnapshot
Opportunity
第二套 Candidate
第二套 CandidateVersion
第二套 AnalysisRecord
第二套 Recommendation
第二套 RuleAssessment
第二套 Job
第二套 Application
```

---

# 15. API 契约建议

最终路径以现有 `/radar/*` API 风格收敛，以下冻结的是能力而非字符串路径。

## 15.1 Search Plan

```http
GET   /api/daily-search-plans
POST  /api/daily-search-plans
GET   /api/daily-search-plans/:id

POST  /api/daily-search-plans/:id/versions
POST  /api/daily-search-plans/:id/activate

POST  /api/daily-search-plans/:id/pause
POST  /api/daily-search-plans/:id/resume

POST  /api/daily-search-plans/:id/run-now
POST  /api/daily-search-plans/:id/skip-today
```

---

## 15.2 SourceRun

```http
GET   /api/source-runs
GET   /api/source-runs/:id

POST  /api/source-runs/:id/retry
POST  /api/source-runs/:id/cancel
```

不再要求：

```http
GET /source-runs/:id/snapshots
```

作为独立 Snapshot 体系。

Snapshot 继续通过 Radar 事实关系追踪。

---

## 15.3 Daily Brief

```http
GET   /api/daily-job-briefs
GET   /api/daily-job-briefs/today
GET   /api/daily-job-briefs/:id

POST  /api/daily-job-briefs/:id/complete
```

---

## 15.4 Judgment

```http
POST  /api/daily-job-briefs/:briefId/items/:candidateId/judgment

PATCH /api/job-judgments/:id
DELETE /api/job-judgments/:id

POST  /api/job-judgments/:id/reason
POST  /api/job-judgments/:id/skip-reason
```

实现层可以把 PATCH/DELETE 转化为版本化判断与撤销事件，而不是物理覆盖。

---

## 15.5 Notifications

```http
GET    /api/notification-channels
POST   /api/notification-channels/email
PATCH  /api/notification-channels/:id
DELETE /api/notification-channels/:id

POST   /api/notification-channels/:id/test

GET    /api/notifications
GET    /api/notifications/:id
POST   /api/notifications/:id/retry

POST   /api/daily-job-briefs/:id/send-email
```

---

## 15.6 Local Service / Scheduler

```http
GET /health
GET /api/local-service/status
GET /api/scheduler/status
```

可增加：

```http
POST /api/local-service/autostart/enable
POST /api/local-service/autostart/disable
```

但不定义：

```http
POST /api/local-service/start
```

作为启动已停止后端的机制。

---

# 16. 状态与可靠性

## 16.1 SourceRun

将：

```text
业务状态
```

与：

```text
当前 phase
```

分开。

### Status

```text
PENDING
RUNNING
WAITING_FOR_USER
PARTIALLY_SUCCEEDED
SUCCEEDED
FAILED
CANCELLED
INTERRUPTED
```

### Phase

```text
PREPARING
DISCOVERING
INGESTING
ANALYZING
RECOMMENDING
BUILDING_BRIEF
```

不需要把每个 phase 都变成数据库状态机分支。

---

## 16.2 DailyJobBrief

```text
GENERATING
→ READY
→ IN_REVIEW
→ COMPLETED
```

异常：

```text
FAILED
```

---

## 16.3 Notification

```text
PENDING
→ SCHEDULED
→ SENDING
→ SENT
```

失败：

```text
FAILED_RETRYABLE
FAILED_FINAL
ACTION_REQUIRED
```

---

## 16.4 服务重启

启动时：

1. 检查错过 Schedule；
2. 创建必要的 CATCH_UP；
3. 把中断中的 SourceRun 标为 INTERRUPTED；
4. 必要时创建新的 RETRY Run；
5. 恢复 Outbox；
6. 处理长时间 SENDING 的 lease；
7. 保留已有 DailyBrief；
8. 保留 Judgment；
9. 自动寻找未审批 Candidate；
10. 不重复写 CandidateVersion；
11. 不重复分析同一冻结输入；
12. 不重复创建同一 RecommendationBatch；
13. 不重复邮件。

---

## 16.5 部分成功

来源运行允许：

```text
PARTIALLY_SUCCEEDED
```

例如：

```text
无锡 × AI前端     ✓
无锡 × 高级前端   ✓
苏州 × AI前端     登录失效
苏州 × 高级前端   登录失效
```

可以生成部分 DailyBrief。

但必须告诉用户覆盖缺口。

不得写：

> 今天所有来源均已正常搜索。

---

# 17. AI 使用边界

AI 可以：

- 复用 v0.8 岗位分析；
- 提取 PreferenceSignal；
- 基于 JD 生成一个具体追问；
- 聚合重复理由；
- 生成 PreferenceRule Proposal；
- 给邮件生成摘要；
- 解释正负 Preference；
- 建议 SearchExpand。

AI 不得：

- 自动替用户做四档判断；
- 虚构用户偏好；
- 虚构岗位优势；
- 隐藏岗位风险；
- 将未回答问题视为确认；
- 自动形成高影响硬规则；
- 改 CandidateVersion；
- 改能力基线；
- 改职业战略；
- 把 Preference 变成人格 Memory；
- 把 JD prompt injection 当系统命令；
- 为了邮件更吸引人夸张事实。

---

# 18. 安全与平台边界

- 外部岗位页面全部视为不可信输入；
- 不读取用户密码；
- 不保存 Cookie 明文；
- 不绕验证码；
- 不绕平台频控；
- SearchProvider 必须有限速；
- 安全验证进入 WAITING_FOR_USER；
- 不无限 retry；
- SMTP Secret 不进普通数据库备份；
- 邮件不包含简历全文；
- 邮件不包含 Token；
- 邮件不包含 API key；
- 邮件不包含调试日志；
- 原 HTML 不直接插入邮件；
- 只允许经过校验的 HTTP / HTTPS 原岗位 URL；
- 邮件链接不提供本地高风险写操作；
- 不公网暴露 OfferFlow；
- 用户可以暂停主动找岗；
- 用户可以关闭即时提醒；
- 用户可以删除邮箱 Secret；
- 用户可以撤销 Judgment；
- 用户可以停用 PreferenceRule。

---

# 19. 成功指标

## 19.1 用户效率

目标：

```text
不再每天人工大范围刷平台
```

每日审批：

```text
中位耗时 ≤ 15 分钟
```

无追问判断：

```text
单岗位目标 ≤ 3 秒
```

平均自动追问：

```text
≤ 0.35 次 / 岗位
```

---

## 19.2 Discovery

必须观察：

```text
planned task coverage
actual task coverage
source failure rate
new candidate rate
material change rate
duplicate rate
analysis eligibility
```

“抓取量越大越好”不是 KPI。

---

## 19.3 Recommendation

关注：

```text
VERY_SUITABLE + SOMEWHAT_SUITABLE 占比
VERY_UNSUITABLE 占比
系统建议与用户 Judgment 差异
已判断未变化岗位重复推荐率
空 Brief 正确性
Exploration 意外正反馈率
```

---

## 19.4 Repeated Mistake Rate

```text
Repeated Mistake Rate
=
命中已激活负向 Preference
且没有显著新差异
却仍进入正式推荐的岗位数

/

命中该负向 Preference 的全部候选数
```

目标：

```text
< 5%
```

连续两次被用户明确指出同类错误：

> 第三次必须被抑制，或给出明确的新差异解释。

---

## 19.5 Notification

目标：

```text
CandidateVersion 即时通知重复率 = 0
DailyBrief 重复率 = 0
```

正常 SMTP 条件下：

```text
成功进入 SENT ≥ 99%
```

临时错误：

```text
可恢复率 ≥ 95%
```

授权错误：

```text
一次失败内进入 ACTION_REQUIRED
```

---

## 19.6 Cost

每个 SourceRun 至少可回答：

```text
扫描多少
分析多少
调用哪些模型
多少请求

如已有可靠 usage：
多少 Token
多少人民币/美元
```

没有成本数据就展示：

```text
Cost unavailable
```

禁止按模型宣传价私自估算后保存成“真实成本”。

---

# 20. 数据迁移与兼容

- 使用显式 Migration；
- 真实生产库不因启动服务自动迁移；
- Migration 前一致性备份；
- 新表为空开始；
- 不伪造历史 Judgment；
- 不伪造历史 Preference；
- 不把旧 RadarAction 自动转换为四档；
- 旧 RadarCandidate 可以进入未来 Brief；
- 必须绑定现有 CandidateVersion；
- 不反向改写 v0.8 Snapshot；
- 不反向改写 CandidateVersion；
- 不反向改写 AnalysisRecord；
- 不反向改写 RecommendationBatch；
- Preference 评估只新增；
- 关闭 v0.9 后旧 Radar 仍可工作；
- 删除 QQ 配置不删除 DailyBrief；
- Secret 与普通 DB Backup 分离；
- v0.9 新字段/表必须进入 Host Snapshot / migration / backup / restore 一致性验证范围。

---

# 21. 实施波次

## V9-0：领域与 P0 Source 冻结

目标：

> **不写大功能，先冻结真实边界。**

完成：

- 冻结本文档；
- 冻结 P0 SearchProvider；
- 冻结 SearchProvider Contract；
- 冻结 Shared Radar Ingestion Core 边界；
- 冻结 DailyJobBrief 引用 RecommendationBatch；
- 冻结 0～8；
- 冻结四档；
- 冻结 Preference 三层模型；
- 冻结 SourceRun 非通用 checkpoint；
- 冻结 QQ Email 只通知不远程审批；
- 输出 v0.9 Schema Change Design；
- 输出 Migration Plan。

---

## V9-1：共享 Radar Ingestion Core

目标：

> Browser Capture 和 Active Discovery 使用同一事实入口。

完成：

- 从现有 RadarCaptureService 抽出共享 Ingestion；
- 保持浏览器采集行为不变；
- Snapshot / identity / normalize / fingerprint / change decision 语义不变；
- SearchProvider 可直接调用 Ingestion；
- captureSessionId 可为空；
- existing tests 继续通过；
- 增加主动来源 ingestion tests。

这一波禁止：

- Scheduler；
- 邮箱；
- Preference；
- 新 Recommendation。

---

## V9-2：Plan + Scheduler + Active Discovery

完成：

- DailySearchPlan；
- Version；
- SourceRun；
- SearchProviderAdapter；
- 一个真实 P0 Provider；
- SearchTask 展开；
- Scheduler；
- SCHEDULED；
- CATCH_UP；
- MANUAL；
- RETRY；
- Skip Today；
- Pause；
- Autostart；
- Heartbeat；
- Coverage；
- WAITING_FOR_USER；
- 真实连续运行验证。

---

## V9-3：Discovery → Existing Radar → DailyBrief

完成：

```text
Discovery
→ Ingestion
→ Rule
→ Analysis
→ RecommendationBatch
→ DailyJobBrief
```

要求：

- 不新增第二分析体系；
- 不新增第二推荐体系；
- DailyBrief 引用现有 Batch；
- 0～8；
- 空 Brief；
- Cost Summary；
- Partial Coverage；
- 幂等重放。

---

## V9-4：QQ SMTP + Outbox

完成：

- Channel；
- Secret；
- Test Email；
- Outbox；
- Worker；
- HIGH_PRIORITY_ALERT；
- DAILY_BRIEF；
- RUN_FAILED；
- ACTION_REQUIRED；
- Quiet Hours；
- Retry；
- Final Failure；
- Idempotency；
- Notification Center；
- 苹果手机原岗位链接验收。

---

## V9-5：四档审批

完成：

- Today Brief Page；
- 单岗位卡；
- 四档；
- 自动下一条；
- 返回修改；
- 历史 Judgment；
- Pause / Resume；
- Completion Summary；
- Judgment 与 RadarAction 严格区分。

---

## V9-6：Reason + Preference

完成：

- 智能追问；
- ≤1 自动问题 / Job；
- JudgmentReason；
- PreferenceSignal；
- PreferenceRule Proposal；
- Rule 激活；
- Rule 停用；
- Rule 删除；
- Preference → RadarRuleAssessment；
- Recommendation Ranking；
- Suppression；
- SearchExpand；
- Exploration；
- Repeated Mistake Protection。

---

## V9-7：Production Release

完成：

- Migration 演练；
- Backup / Restore；
- Host Snapshot；
- Scheduler Crash；
- Source Crash；
- Source Login Failure；
- 服务重启；
- CATCH_UP；
- RETRY；
- SMTP Failure；
- Outbox Idempotency；
- Judgment 修改；
- Signal Invalidated；
- Rule Recalculation；
- Recommendation Quality Eval；
- Repeated Mistake Eval；
- Cost Visibility；
- README；
- Changelog；
- Architecture 文档；
- 用户最终验收。

---

# 22. Definition of Done

## 22.1 Discovery

- 至少一个真实 P0 Source；
- 能主动搜索；
- 网页关闭后运行；
- Scheduler 可用；
- Catch-up 可用；
- Source Failure 显式；
- Coverage 完整；
- 多关键词不会制造重复 Candidate。

---

## 22.2 Radar Reuse

- Active Discovery 与 Browser Capture 共用 Ingestion Core；
- 无第二 Candidate；
- 无第二 CandidateVersion；
- 无第二 Analysis；
- 无第二 Recommendation；
- v0.8 既有 Radar 流程继续可用。

---

## 22.3 Recommendation

- 只使用 current Analysis；
- 0～8；
- 不凑数；
- 可以 0；
- ignored/applied 不重复；
- DailyBrief 引用 RecommendationBatch；
- Preference 可以影响下一批；
- Exploration 不突破 Hard Constraint。

---

## 22.4 Email

- QQ SMTP 可用；
- Secret 安全；
- Test Email；
- Outbox；
- Retry；
- Idempotency；
- 即时邮件；
- 日报；
- 空日报；
- Partial 日报；
- ACTION_REQUIRED；
- 苹果手机可打开原岗位。

---

## 22.5 Judgment

- 四档完整；
- 判断快速；
- 刷新不丢；
- 服务重启不丢；
- 可修改；
- 原历史可追溯；
- 原始用户理由不被 AI 覆盖。

---

## 22.6 Preference

- Signal 可追溯；
- Rule 可追溯；
- 单次反馈不过拟合；
- 高影响规则需确认；
- Rule 可 Disable；
- Rule 可 Delete；
- 撤销 Judgment 后派生结果可重算；
- 同类误判明显减少。

---

## 22.7 Reliability

- 服务启动不自动偷偷升级真实 DB；
- Migration 可恢复；
- SourceRun 中断不冒充 checkpoint resume；
- Retry 不制造重复事实；
- Outbox 不重复发送；
- 邮件失败不污染业务成功状态；
- 关闭 v0.9 后 v0.8 雷达仍然工作。

---

## 22.8 Cost

- Run 能看调用量；
- 能看模型；
- 有真实 usage 时能看 Token / 成本；
- 无真实数据不伪造成本。

---

# 23. 发布验收剧本

## A. 网页关闭后的定时找岗

1. 配 Plan；
2. 开启；
3. 关闭网页；
4. 保持 OfferFlow Service；
5. 到时间；
6. Provider 搜索；
7. Radar Ingestion；
8. Analysis；
9. Batch；
10. Brief。

通过：

> 网页不是定时任务运行前提。

---

## B. Catch-up

1. 设 09:00；
2. 09:00 电脑睡眠；
3. 11:20 恢复；
4. 创建 CATCH_UP；
5. 只补一次；
6. 邮件标注实际执行时间。

通过：

> 不静默漏跑，也不重复全量跑。

---

## C. 多关键词命中同一岗位

一个岗位同时命中：

```text
高级前端
AI前端
产品前端
```

通过：

- Snapshot 可记录来源；
- Candidate 仍为一个；
- Analysis 不重复；
- Recommendation 不重复；
- 邮件不重复。

---

## D. 高优先级邮件

首次发现：

```text
CandidateVersion V1
```

发送一次。

重跑同一输入：

> 不再次发送。

岗位 Material Change：

```text
CandidateVersion V2
```

重新达到提醒标准时：

> 可以形成新的通知资格。

---

## E. Daily Brief

完成一天搜索。

RecommendationBatch：

```text
5 条
```

Brief：

```text
5 条
```

邮件：

```text
同 5 条
```

电脑：

```text
同一个 Batch
```

通过：

> 三端没有三套推荐名单。

---

## F. 空 Brief

扫描大量岗位，但全部：

- 重复；
- hard constraint；
- skip；
- Preference suppression。

最终：

```text
0 条
```

通过：

> 发真实空日报，不凑 8 条。

---

## G. Source 部分失败

无锡成功，苏州登录失效。

通过：

- PARTIALLY_SUCCEEDED；
- 邮件说明苏州失败；
- 不写“苏州 0 个合适岗位”。

---

## H. SMTP 临时失败

通过：

```text
PENDING
→ SENDING
→ FAILED_RETRYABLE
→ SENDING
→ SENT
```

业务 Brief 不回滚。

---

## I. SMTP 授权失效

通过：

```text
ACTION_REQUIRED
```

不得无限 retry。

---

## J. 四档审批恢复

处理第 1～4 条后关闭页面。

再次打开：

> 自动从未判断的下一条继续。

不需要 checkpoint。

---

## K. 系统 False Positive

系统：

```text
apply_now
```

用户：

```text
VERY_UNSUITABLE
```

原因：

```text
外包驻场
```

后续再次发现同类。

通过：

- PreferenceSignal 生效；
- 稳定后形成 PreferenceRule；
- 同类岗位抑制或降权；
- 如果重新推荐必须解释差异。

---

## L. 强正向

用户连续认为：

```text
前端主导
Node BFF
AI 产品落地
中小自研团队
```

非常合适。

通过：

- 正向 Signal；
- 稳定 Rule；
- 后续排序提高；
- 可以产生 SearchExpand；
- 不因此屏蔽其他高质量岗位。

---

## M. 不过度追问

连续审批 10 条。

通过：

```text
平均自动追问 ≤ 0.35 / Job
```

不得变成问卷。

---

## N. 服务中途崩溃

SourceRun RUNNING 时杀死进程。

恢复：

- 原 Run = INTERRUPTED；
- 必要时创建 RETRY；
- 不声称“从 checkpoint 无缝续跑”；
- Radar 幂等保护重复事实。

---

# 24. 明确延期

以下明确不进入 v0.9：

## OfferFlow v1.0 / 后续 Runtime

- 通用 AI Task 页面；
- 通用 Step History；
- 跨步骤 checkpoint；
- generic resume；
- TaskRuntimeAdapter 高级能力；
- 长时 Agent session；
- subagent；
- agent heartbeat；
- Prime Agent / LangGraph / Temporal Runtime。

---

## 后续移动能力

- 手机网页直接审批；
- 公网安全写回；
- iOS App；
- 多设备同步。

---

## 后续 Search

- 多平台成熟 Provider；
- 公司官网监控；
- 目标公司招聘页 Watch；
- 云端持续抓取。

---

## 后续 Learning / Evaluation

- Preference 与真实面试结果对照；
- Offer 结果反馈；
- 长期 recommendation evaluation；
- 自动发现稳定失败模式；
- NovaWing Skill 演化；
- 长期跨产品 Memory。

这些能力不能反向扩大 v0.9。

---

# 25. 最终产品链路

```text
用户定义自己想找什么
        ↓
DailySearchPlanVersion
        ↓
现有 OfferFlow 本地服务每天值班
        ↓
SearchProviderAdapter 主动寻找真实岗位
        ↓
Shared Radar Ingestion Core
        ↓
v0.8 Radar 可信事实链
        ↓
v0.8 AnalysisTask / MatchAnalysis
        ↓
Preference-aware Recommendation
        ↓
RadarRecommendationBatch（0～8）
        ↓
DailyJobBrief
        ↓
高优先级即时 QQ 邮箱
+
每日一封完整汇报
        ↓
用户手机先看情报
        ↓
电脑端像老板一样逐条批示
        ↓
非常合适
有点合适
不太合适
非常不合适
        ↓
必要时最多追问一个理由
        ↓
JobJudgment
        ↓
PreferenceSignal
        ↓
PreferenceRule
        ↓
下一轮：
少搜垃圾
少犯旧错
更早发现真正合适的岗位
```

---

# 26. v0.9 最终成功定义

v0.9 成功的标志不是：

```text
抓了十万个岗位
```

也不是：

```text
造了一个复杂 Agent Framework
```

更不是：

```text
代码量比 v0.8 多了一倍
```

真正的成功标准只有一句：

> **OfferFlow 已经从“我把岗位交给它分析”，跨到了“它每天主动替我寻找并汇报岗位”。我只需要处理少量真正值得看的机会；我明确指出过的错误，它下一轮会少犯；我明确喜欢的特征，它下一轮更容易找到。**

---

# 27. Final Candidate → Final 的唯一剩余冻结项

PRD 2.3 已冻结：

```text
产品主题
v0.8 复用边界
Shared Radar Ingestion
DailyBrief 与 RecommendationBatch 关系
0～8 推荐数量
Scheduler 基本语义
SourceRun 非通用 checkpoint
QQ Email / Outbox
四档 JobJudgment
Preference 三层模型
v1.0 延期边界
```

转为正式：

```text
PRD v2.3 Final
```

之前，只剩一个必须在 V9-0 明确的问题：

> **P0 主动岗位来源到底是哪一个，以及该来源的合法能力边界、登录形态、搜索覆盖和连续真实运行方式。**

该问题冻结后，即可正式开始：

```text
V9-0
→ V9-1
→ v0.9 开发
```
---

# 28. v0.9 Final Scope Summary（2026-08-19 Final Freeze）

## 28.1 Included in v0.9

v0.9 最终交付以下完整能力：

### Discovery
- DailySearchPlan 配置与版本化
- Scheduler 自动调度（SCHEDULED / CATCH_UP / MANUAL / RETRY）
- Tavily Search API（P0 Open Web Search Provider）
- query expansion（城市 × 岗位方向 × 关键词）
- query budget 控制
- coverage tracking

### Source Policy
- SEARCH_ONLY（招聘平台）
- SEARCH_AND_FETCH（公司官网 / 公开 ATS / unknown public）
- CONDITIONAL_FETCH（技术社区）

### Evidence Model
- SEARCH_EVIDENCE（只有搜索结果）
- FULL_EVIDENCE（完整岗位事实）
- MANUAL_REVIEW_REQUIRED（值得看但禁止自动 Fetch）

### Content Acquisition & Evidence Upgrade
- 公开 Web 有界 fetch
- SEARCH_EVIDENCE → validation PASS → evidence_upgrade → FULL_EVIDENCE

### Analysis & Recommendation
- 仅 FULL_EVIDENCE 可进入正式 Analysis（复用 v0.8）
- RecommendationBatch（0～8 条）
- SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED 不进入正式推荐

### DailyJobBrief
- 正式推荐（引用 RecommendationBatch）
- supplementary discovery items
- coverage / diagnostics / empty-state

### 前端最小闭环
- DailySearchPlan Page
- DailyJobBrief Page

---

## 28.2 Deferred to v1.0

以下能力明确不属于 v0.9 最终 GA Scope，已迁移至 v1.0：

### Notification / QQ SMTP
- NotificationChannel / NotificationOutbox
- HIGH_PRIORITY_ALERT / DAILY_BRIEF / RUN_FAILED / ACTION_REQUIRED 邮件

### JobJudgment / 四档审批
- VERY_SUITABLE / SOMEWHAT_SUITABLE / NOT_VERY_SUITABLE / VERY_UNSUITABLE
- JudgmentCard / Judgment Repository / 智能追问

### Preference Learning
- PreferenceSignal / PreferenceRule
- Search / Recommendation preference influence
- Repeated Mistake Protection / Exploration

详细迁移记录见 `docs/prd/offerflow-v1.0.md`。

---

## 28.3 Production Evidence

v0.9 核心链路已通过真实生产验证。

**真实 Run ID：** 98ab9fc3-8fd0-4215-832e-b352fc01f223
**验证时间：** 2026-08-18

核心数据：discovered=277, fetchSucceeded=27, validationPassed=19, evidenceUpgraded=19, analysisSucceeded=6, selected=6

完整链路：Discovery → Evidence → Analysis → Recommendation → Brief ✅

---

## 28.4 Known Limitations

v0.9 用户需要接受以下限制（将在 v1.0 解决）：

1. **无邮件推送**：只能在电脑端查看，无法通过邮箱在手机端接收
2. **无四档快速判断**：需通过现有 RadarAction 标记岗位
3. **无偏好学习**：推荐质量依赖初始配置，不从反馈中学习
4. **无同类错误保护**：可能看到重复类型的不合适岗位
5. **成本可见性有限**：只能看到 API 调用次数，无真实成本趋势

---

## 28.5 v0.9 Final Success Definition

v0.9 成功的标志是：

> **OfferFlow 已经从"我把岗位交给它分析"，跨到了"它每天主动替我寻找并汇报岗位"。我只需要在电脑端查看少量真正值得看的机会。**

v1.0 将补充：

> **我明确指出过的错误，它下一轮会少犯；我明确喜欢的特征，它下一轮更容易找到。**

---

**PRD 冻结日期：** 2026-08-19
**冻结批准：** 项目负责人
**状态：** FROZEN / RELEASE CANDIDATE
