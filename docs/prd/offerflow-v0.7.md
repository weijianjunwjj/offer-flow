# OfferFlow v0.7 PRD

- **文档版本**：Draft 0.4
- **产品版本**：v0.7.x
- **前置版本**：v0.6.2
- **状态**：Draft 0.4；v0.7.0-A 已完成，下一阶段为 v0.7.0-B 技术设计
- **主题**：可信求职记忆、动态可达岗位画像与主动策略引导

---

## 0. 本次修订摘要

Draft 0.4 吸收 Gemini 反方评审中成立的问题，并拒绝将未经验证的固定分值直接写成“统计真理”。

本次关键修订：

1. 将“长期能力基线”“城市市场画像”“短期投递策略”拆成三层，避免短期求职挫折直接改写长期职业定位。
2. 对外展示将“保底画像”更名为“稳妥区间”；内部代码可使用 `defensive`。
3. 删除“12 次机会 / 3 次信号”作为固定产品真理，改为多维样本充分度与决策分级门禁。
4. 能力证据允许跨城市复用；市场供需、薪资定价和转化数据按城市隔离。
5. `ResumeVersion`、投递渠道、公司独立性和岗位性质进入求职反馈上下文。
6. 历史补录改为“两层补录”：所有历史机会做最小基线，高价值机会再补详细事件。
7. AI Proposal 增加指纹、冷却期、失效时间和“重大新证据”重启规则。
8. `vue-page-runtime` 先经过有退出条件的 Integration Gate，再扩大到 SSE 等高风险任务。
9. v0.7.0 保持一个产品版本，但内部拆成 A/B/C 三个可验收阶段，避免同时引爆所有风险。
10. 学历、薪资、公司偏好等负向信号形成风险标签和排序降权，不自动变成绝对封禁。

---

## 1. 产品定位

OfferFlow 不再只记录“我看过、投过哪些岗位”，而是基于候选人的能力证据与真实市场反馈，持续判断：

1. 当前稳定具备哪些能力。
2. 在特定城市和岗位市场中，当前大概率能够到达什么区间。
3. 未来 7–14 天最应该怎样分配投递组合。
4. 当前阻力来自岗位供给、渠道、简历表达、学历门槛、能力缺口，还是样本不足。
5. 每次判断为什么成立，以及还有哪些相反证据。

> **一句话定位**
>
> 基于求职反馈事件与候选人能力证据，持续估算当前可达岗位区间，并提供有证据、可审核、可拒绝的阶段性求职策略。

OfferFlow 的目标不是“预测命运”，而是把模糊焦虑转化为：

- 可追溯事实
- 可比较样本
- 有限结论
- 可审核提案
- 可执行策略

---

## 2. 背景

OfferFlow v0.6.2 已具备：

- Job / JD 记录
- 单岗位 LLM 分析
- SSE 流式响应
- SQLite 持久化
- Snapshot 同步
- 人工确认保存
- JD 导入草稿 Review
- 当前沟通状态
- 基础规则决策
- OFFER_FLOW_JSON Eval
- 正式 migration 基础
- SQLite 与 snapshot 一致性校验

但当前系统仍以 Job 的“当前快照”为中心，不能可靠表达：

- 一次真实投递机会
- 同一岗位不同渠道或不同简历版本的多次尝试
- HR 回复、面试、拒绝、Offer 的完整时间线
- 用户主动放弃与招聘方拒绝的区别
- 同一公司重复反馈是否属于独立样本
- 新旧简历版本是否改变市场反馈
- 城市能力验证与本地定价之间的差异
- 当前结论是市场事实、用户偏好还是 AI 推断

v0.7 必须从“岗位当前状态”转向：

> Job + Application + FeedbackEvent + CandidateEvidence 的可信求职历史。

---

## 3. 产品目标

### 3.1 核心目标

系统基于：

- 简历与工作经历
- ResumeVersion
- 项目与工程成果
- 开源项目
- 技术文章
- 当前与历史 JD
- 实际投递行为
- 投递渠道
- HR 主动联系与回复
- 面试过程与反馈
- 明确拒绝原因
- Offer
- 城市与岗位供给
- 用户对 AI 提案的处理结果

持续形成：

1. 候选人长期能力基线
2. 分城市、分岗位族的三层市场画像
3. 未来 7–14 天投递策略
4. 证据、样本充分度与不确定性
5. AI 画像或策略修改提案
6. 正式版本与用户决议历史

### 3.2 用户价值

用户能够回答：

- 我稳定拥有的能力是什么？
- 在苏州、无锡、上海、杭州分别能争取什么？
- 当前没有反馈，是能力不够、渠道无效，还是样本太少？
- 这周应该冲刺、主攻和稳妥各投多少？
- 为什么系统提出调整？
- 我拒绝某条建议后，系统会不会继续骚扰？

### 3.3 工程目标

v0.7 同时验证：

- `vue-page-scope`：复杂路由页的页面状态与生命周期边界
- `vue-page-runtime`：页面读取任务、取消、loading 与竞态编排

两个库必须服务真实复杂度，而不是为了展示技术而强行覆盖所有页面。

---

## 4. 非目标

v0.7 不负责：

- 自动投递
- 自动联系 HR
- 模拟招聘平台操作
- AI 自动修改正式画像或业务状态
- 精确 Offer 概率
- 模型训练与微调
- 多租户招聘 SaaS
- 多 Agent
- LangGraph
- 为技术展示强行引入 RAG
- 向量数据库
- 恢复 Tauri / Rust
- 用前端状态替代后端规则
- 用 Page Runtime 替代后端工作流
- 一次性补齐所有历史细节
- 将任意固定分值包装为统计学真理

---

## 5. 三层判断模型

v0.7 不再用一套画像同时回答“我是谁”和“我这周投什么”。

### 5.1 长期能力基线 `CapabilityBaseline`

表达候选人较稳定的能力事实，例如：

- 复杂 B 端页面治理
- Vue / TypeScript
- 数据平台与可视化
- 前端工程化
- AI 应用接入
- Node.js 轻后端闭环
- 产品设计与交付能力

主要证据：

- 工作与项目产出
- 开源项目
- 技术文章
- 面试中明确能力认可
- 多城市重复验证的能力反馈

它不会因为几周无回复直接下降。

### 5.2 城市市场画像 `MarketPositionProfile`

表达在特定市场中的当前可达区间。

至少按以下上下文生成：

- 城市
- 岗位族
- 薪资带
- 公司规模
- 学历门槛
- 岗位性质
- 行业
- ResumeVersion
- 时间窗口

每个市场画像包含三层：

| 内部代码 | 对外名称 | 含义 |
|---|---|---|
| `stretch` | 冲刺区间 | 有机会，但需要较高匹配度或附加条件 |
| `core` | 主攻区间 | 当前证据和市场反馈支持度最高 |
| `defensive` | 稳妥区间 | 为控制空窗和扩大机会池的战术范围，不代表长期价值下降 |

“保底”不再作为主要对外文案。

### 5.3 短期策略窗口 `StrategyWindow`

表达未来 7–14 天的投递组合，例如：

- 50% 主攻
- 30% 冲刺
- 20% 稳妥
- 优先苏州复杂 B 端
- 上海 AI 应用岗保持少量验证
- 暂停重 Python AI 全栈
- 增加学历宽松团队覆盖

短期策略可以频繁调整，但不得自动改写长期能力基线。

---

## 6. 已冻结的产品原则

### 6.1 AI 不得静默修改正式结论

AI 只能生成 Proposal。

用户可以：

- 接受
- 修改后接受
- 拒绝
- 暂缓

只有用户确认后，新的市场画像或策略版本才能生效。

### 6.2 样本不足时禁止高影响下调

不得仅因：

- 空窗变长
- 用户焦虑
- 少量无回复
- HR 不活跃
- 岗位过期
- 单次面试失败
- 单次拒绝
- 某城市岗位供应不足

就建议降低正式薪资区间或长期岗位定位。

### 6.3 未投递不构成市场拒绝

以下数据不计入市场反馈分母：

- 看过但未投递
- 收藏未投递
- 因通勤、外包、加班、城市或价值观主动放弃
- JD 已过期
- 招聘者长期不活跃且未产生真实互动

### 6.4 城市能力可复用，市场定价不混算

允许跨城市复用：

- 已验证的工程能力
- 项目能力
- 面试中对能力的明确评价
- 岗位族层面的技术匹配信息

不得直接跨城市复用：

- 薪资上限
- 回复率
- 面试转化率
- 学历筛选强度
- 当地岗位供给
- 公司规模分布

### 6.5 历史数据采用两层补录

不是只补“大喜大悲”，也不是完整考古。

#### 第一层：最小历史基线

对尽可能多的历史实际机会记录：

- Job
- 是否投递
- 大致时间
- 渠道
- ResumeVersion（未知可空）
- 结果桶
- 是否用户主动退出

用于建立分母和沉默基线。

#### 第二层：高价值详细补录

优先补：

- 明确 HR 反馈
- 面试
- 明确拒绝原因
- 正向评价
- 终面
- Offer

---

## 7. 核心领域模型

### 7.1 Job

代表岗位与 JD 事实。

建议属性包括：

- 公司与岗位
- 城市
- 薪资
- 学历要求
- 公司规模
- 行业
- 技术栈
- 岗位来源
- 招聘者活跃度
- 岗位时效
- `employmentModel`：自研 / 外包 / 驻场 / 未知
- `employerGroupKey`：用于识别同一招聘主体或集团

Job 不再同时承担求职过程。

### 7.2 ResumeVersion

代表一次可区分的简历版本。

至少保存：

- versionId
- 名称
- 生效时间
- 核心变化摘要
- 文件或文本指纹
- 是否当前主用版本

反馈分析默认不无条件混算不同 ResumeVersion。

### 7.3 Application

代表针对 Job 的一次真实求职机会。

```ts
type Application = {
  id: string
  jobId: string
  channel: string
  resumeVersionId?: string
  recruiterId?: string
  appliedAt?: string
  currentStage: ApplicationStage
  outcome?: ApplicationOutcome
  createdAt: string
  updatedAt: string
}
```

同一 Job 可以存在：

- 不同渠道的多次机会
- 不同 ResumeVersion 的再次投递
- 不同 HR 的独立联系
- 招聘暂停后重新开放

### 7.4 FeedbackEvent

```ts
type FeedbackEvent = {
  id: string
  applicationId: string
  eventType: FeedbackEventType
  occurredAt: string
  source: 'user' | 'hr' | 'interviewer' | 'system_import'
  sourceConfidence: 'exact' | 'approximate' | 'recalled' | 'inferred'
  content?: string
  reasonCode?: string
  evidenceLevel: 'strong' | 'medium' | 'weak'
  resumeVersionId?: string
  channel?: string
  employerGroupKey?: string
  eventFingerprint?: string
  createdAt: string
}
```

初期事件类型：

- `applied`
- `viewed`
- `replied`
- `resume_requested`
- `phone_screen`
- `interview_scheduled`
- `interview_completed`
- `interview_advanced`
- `rejected`
- `offer_received`
- `user_withdrew`
- `stale`
- `no_response`
- `recruitment_frozen`
- `position_closed`

### 7.5 CandidateEvidence

代表稳定能力证据：

- 工作经历
- 项目经历
- 开源项目
- 技术文章
- 量化成果
- 面试正向反馈
- 产品闭环能力

### 7.6 MarketPositionProfileVersion

每个版本至少包含：

- 城市
- 岗位族
- 三层区间
- 适用 ResumeVersion 范围
- 样本充分度
- 证据
- 相反证据
- 生效时间
- 与上一版差异
- 用户确认结果

### 7.7 StrategyProposal

新增字段要求：

- `proposalFingerprint`
- `proposalType`
- `reasons[]`
- `evidenceRefs[]`
- `createdAt`
- `expiresAt`
- `coolingOffUntil`
- `supersedesProposalId`
- `status`
- `userDecisionReason?`

`reasons[]` 必须绑定真实的：

- FeedbackEvent ID
- CandidateEvidence ID
- 聚合统计 ID

没有证据引用的高影响提案不得进入 Review。

### 7.8 AIRun

记录：

- 触发原因
- Prompt 版本
- 模型
- 输入摘要
- 时间窗口
- 使用证据
- 输出 Proposal
- 解析状态
- 错误状态

---

## 8. 市场信号与上下文

信号不能脱离上下文使用。

至少考虑：

- 城市
- 岗位族
- 薪资带
- 公司规模
- 岗位性质
- 投递渠道
- ResumeVersion
- 招聘主体独立性
- 时间新鲜度
- 反馈明确程度

### 8.1 能力相关强信号

- 多轮面试持续推进
- 面试官明确认可具体工程能力
- 多个独立主体重复验证同一能力
- Offer 与岗位要求高度可比
- 同类岗位反复进入后续轮次

### 8.2 市场条件信号

以下不直接评价能力：

- HC 冻结
- 公司预算低
- 岗位取消
- 招聘暂停
- 招聘者不活跃
- 城市供给不足

### 8.3 同源去重

同一公司、同一集团、同一招聘团队或重复岗位产生的信号不得简单累加。

系统必须能识别：

- 同一岗位多平台重复发布
- 同一公司不同 HR 重复联系
- 集团内相同门槛重复拒绝
- 同一面试流程拆成多个事件

### 8.4 渠道影响

内推、猎头、Boss 海投、官网投递等应分别统计。

渠道可以影响：

- 进入流程的概率
- 反馈时效
- 样本代表性

但渠道带来的通过不能自动等同为普遍市场认可。

---

## 9. 样本充分度与决策门禁

### 9.1 不采用单一固定次数

删除“12 次机会 / 3 次信号”作为固定产品规则。

也不直接采用未经校准的 `+10 / -3` 评分作为市场真理。

### 9.2 样本充分度维度

```ts
type EvidenceSufficiency = {
  opportunityCount: number
  explicitSignalCount: number
  independentEmployerCount: number
  comparableSampleRatio: number
  recentSampleRatio: number
  dataCompleteness: number
  contradictorySignalCount: number
  resumeVersionCoverage: number
  grade: 'insufficient' | 'exploratory' | 'actionable'
  reasons: string[]
}
```

核心维度：

1. 数量
2. 来源独立性
3. 时间新鲜度
4. 明确程度
5. 可比性
6. 数据完整度
7. 相反证据
8. ResumeVersion 一致性
9. 渠道代表性

### 9.3 决策分级门禁

#### 数据收集建议

在样本不足时即可输出。

例如：

> 当前无法判断薪资是否偏高，建议再积累 4–6 个可比机会。

#### 扩大岗位池建议

允许在 `exploratory` 级别输出，但必须说明：

- 是短期实验
- 不改变正式画像
- 目标是收集更多信息或降低空窗风险

#### 调整短期投递组合

需要至少存在：

- 可比较样本
- 明确的供给或渠道问题
- 与用户偏好不冲突

#### 修改正式主攻画像

只允许在 `actionable` 级别提出。

#### 降低正式薪资或长期定位

必须同时满足：

- 多个独立招聘主体
- 明确且方向一致的因果反馈
- 近期样本占主导
- 排除渠道、HR 不活跃、岗位冻结和 ResumeVersion 问题
- 展示相反证据
- 用户二次确认

### 9.4 时间衰减

旧反馈需要降权，但半衰期不在 PRD 中固定为 45 天。

时间衰减需按信号类型配置：

- 招聘供给与回复率：衰减快
- 面试能力反馈：中等衰减
- 作品与工程产出：衰减慢
- 学历等结构性约束：长期有效，但不等同于所有公司都拒绝

---

## 10. 城市数据模型

### 10.1 两套结论

系统应分别输出：

1. **能力结论**：可跨城市参考
2. **市场结论**：按城市与岗位上下文计算

### 10.2 跨城借用矩阵

| 信息 | 是否跨城借用 | 规则 |
|---|---|---|
| 复杂 B 端工程能力 | 可以 | 作为 CandidateEvidence，不直接计算本地回复率 |
| AI 应用交付能力 | 可以 | 需要岗位要求可比 |
| 面试中明确能力认可 | 可以降权借用 | 记录来源城市和公司上下文 |
| 薪资上限 | 不直接借用 | 必须本地化 |
| 回复率 / 面试率 | 不直接借用 | 只作为辅助观察 |
| 学历门槛强度 | 不直接借用 | 按城市、行业和公司类型统计 |
| 岗位供给 | 不借用 | 完全本地化 |
| 公司规模偏好 | 有限借用 | 必须说明市场结构差异 |

### 10.3 相邻城市

苏州与无锡等相邻市场可以有“辅助参考”，但不得默认 1:1。

跨城参考必须显示：

- 来源市场
- 参考原因
- 降权方式
- 不适用维度

---

## 11. 历史补录与数据可信度

### 11.1 最小历史基线

允许快速补录：

- Job
- 实际投递与否
- 渠道
- 大致时间
- ResumeVersion（未知可空）
- 是否回复
- 是否面试
- 最终结果桶
- 是否用户主动退出

### 11.2 详细事件补录

只对高价值机会补：

- HR 原话
- 面试反馈
- 明确拒绝原因
- 终面与 Offer
- 关键正向评价

### 11.3 回忆数据限制

`recalled` 或 `inferred` 数据：

- 可以用于趋势提示
- 不用于精确转化率
- 缺少 JD 原文时，不参与技能词频负向分析
- 不得单独触发降薪或正式画像下调

---

## 12. AI Proposal Review

### 12.1 状态

```text
proposed
→ accepted
→ modified_and_accepted
→ rejected
→ deferred
→ expired
```

### 12.2 冷却与退避

每个 Proposal 生成 `proposalFingerprint`。

用户拒绝后：

- 同类 Proposal 默认进入冷却期
- 高影响提案默认建议 14 天冷却
- 低影响策略提案可用 3 / 7 / 14 / 30 天
- 用户可自行调整

冷却期内只有出现“重大新证据”才允许重新提出。

重大新证据例如：

- 新 Offer
- 新增两个独立主体的明确反馈
- ResumeVersion 发生重大变化并产生新反馈
- 用户主动解除冷却

不得因为新增一条弱信号就绕过冷却。

### 12.3 提案失效

Proposal 必须有 `expiresAt`。

过期未处理：

- 状态转为 `expired`
- 不自动当作用户接受或拒绝
- 下次生成时必须重新计算证据

### 12.4 用户修改后的学习边界

用户修改 Proposal 后，系统学习的是：

- 用户风险偏好
- 城市偏好
- 薪资容忍边界
- 对短期策略的接受程度

不得把用户偏好直接改写为市场事实。

---

## 13. 主动策略引导

v0.7.2 的“主动”定义为：

> 事件触发式辅助判断，而不是后台不断弹窗。

触发条件：

- 新增明确反馈
- 完成面试
- 获得 Offer
- 累积到新样本充分度等级
- 到达用户设定的复盘时间
- 用户主动请求复盘

默认不采用：

- 每次打开应用就弹策略
- 每条无回复都生成 AI 建议
- 后台高频扫描
- 重复提出被拒绝建议

---

## 14. 页面与路由

建议路由：

```text
/profile
/jobs
/jobs/new
/jobs/:jobId
/applications
/history-backfill
/strategy
/profile-versions
```

### 14.1 岗位详情拆分

```text
JobDetailPage.vue
├─ JobBasicInfoSection.vue
├─ JdInputSection.vue
├─ AiAnalysisSection.vue
├─ ImportReviewSection.vue
├─ ApplicationSection.vue
├─ FeedbackTimelineSection.vue
└─ JobDecisionSection.vue
```

`JobDetailPage` 是页面编排壳，不承载全部业务细节。

> **实施状态（2026-07-12）**：v0.7.0-A 已引入 Hash Router，并从 `BattlefieldPage.vue` 最小迁移出 `JobDetailPage.vue` 编排壳和五个稳定 Section。详情 Page Scope 由 `JobDetailPage` 唯一持有；更大的业务拆分不属于 A。

### 14.2 KeepAlive 策略

v0.7.0 初期复杂页面默认不启用 KeepAlive。

只有当：

- Scope 生命周期测试通过
- Runtime enter / leave 行为验证通过
- 无重复订阅与任务泄漏

才允许对指定页面启用。

---

## 15. vue-page-scope 架构约束

### 15.1 合理使用范围

强制：

- `/jobs/:jobId`
- `/history-backfill`

推荐：

- `/applications`
- `/strategy`
- `/profile-versions`

简单列表页若只有分页和基础筛选，不强制使用。

### 15.2 Owner 模型

1. 路由页是唯一 owner。
2. owner 调用 `useXxxScope()`。
3. 子组件使用 `injectPageScope()`。
4. 子组件不得重复创建 Scope。
5. Scope 不保存跨页面永久事实。
6. 服务端和 SQLite 是事实源。

### 15.3 Scope 大小控制

一个 Scope 不得重新变成巨型 Page Store。

当出现以下情况时必须拆领域模块或服务层：

- action 数量持续膨胀
- 不同子模块互相写状态
- `$source` 同一对象存在多份缓存
- 页面规则开始侵入后端领域判断
- 测试必须依赖完整页面才能运行

### 15.4 销毁验收

离开详情路由后必须证明：

- Scope registry 不残留实例
- watcher 已释放
- event bus 订阅已释放
- timer 已清理
- 未完成任务被取消
- 无全局对象持有 Scope 引用

---

## 16. vue-page-runtime 架构约束

### 16.1 定位

- Page Scope：页面作用域
- Page Runtime：读取型异步任务编排
- 普通 Action：用户明确触发的写命令
- 后端：规则、门禁、持久化
- SQLite：事实源

### 16.2 任务与命令边界

#### Task

适合：

- 页面读取
- 查询刷新
- 可取消请求
- 路由切换时应取消的异步工作
- SSE 分析读取链
- `trigger / canRun / reset` 明确的数据任务

#### Action

必须负责：

- 保存 Job
- 创建 Application
- 新增 FeedbackEvent
- 确认 AI 分析
- 接受 / 拒绝 Proposal
- 触发数据库写入

写 Action 完成后可以调用读取 Task 刷新。

### 16.3 Runtime 分阶段接入

#### Gate 1：低风险读任务

先验证：

- `loadJobBundle`
- 快速路由切换
- loading
- abort
- skip
- reset

#### Gate 2：SSE

只有 Gate 1 全部通过后，才将 `streamJobAnalysis` 纳入 Runtime。

#### Gate 3：扩大应用

只有真实业务验证稳定后，才扩展至其他页面。

### 16.4 降级原则

不复制 Runtime 源码，不创建影子 Runtime。

在 SSE Gate 尚未通过前：

- 保留 OfferFlow 当前稳定 SSE 路径
- 通过 feature flag 切换新旧编排
- Gate 通过后再删除临时兼容路径

若发现 Runtime 缺陷：

- 回到 `vue-page-runtime` 仓库修复
- 发布新 alpha 或 stable
- OfferFlow 升级精确版本

---

## 17. AbortSignal 与竞态安全

这是 P0。

### 17.1 强制要求

所有可取消链路必须支持 AbortSignal：

- 前端 API client
- fetch / HTTP client
- SSE reader
- 后端请求连接
- 流式模型请求
- reader cleanup

### 17.2 Task Run 身份

每次 Task 运行必须有唯一 `runId` 或等价身份。

写入 `$source` 前必须确认：

- 当前 Scope 未销毁
- 当前路由上下文仍匹配
- 当前 run 仍是最新有效 run
- signal 未 abort

abort 只取消 run 外壳（返回值与 loading），无法回滚 run 函数体内已经写入 `$source` 的赋值；因此写入前的上述校验，以及将 `signal` 透传至真实请求，是防止旧结果污染的唯一手段。

### 17.3 路由竞态测试

必须覆盖：

- 500ms 内 A → B → C 三次切换
- A、B 请求延迟返回
- 只有 C 可写入
- A、B loading 正确结束
- SSE 不继续追加
- 无未处理 Promise
- 无控制台异常
- 无数据库写入污染

### 17.4 后端中断

客户端取消后，后端必须：

- 监听连接关闭
- 停止继续向客户端写流
- 尽可能取消上游模型请求
- 释放 reader 和资源

---

## 18. 双库 Integration Gate

至少验证：

1. 当前 Vue 版本兼容。
2. 两个包的 peer dependency 一致。
3. TypeScript 类型可用。
4. Router 参数桥接正确。
5. owner 唯一。
6. inject 正常。
7. enter / leave / destroy 不重复。
8. task 的 init / enter / manual 正确。
9. canRun=false 正确 skip。
10. reset 同步、幂等、自清理。
11. loading 在成功、失败、abort、skip 后恢复。
12. 路由切换取消旧任务。
13. AbortSignal 穿透 API client。
14. SSE 取消后不回写。
15. Scope 销毁后无泄漏。
16. 无 KeepAlive 时行为稳定。
17. 开启 KeepAlive 前有独立验证。

Gate 不通过时不得继续扩大 Runtime 覆盖面。

### 18.1 Peer Dependency Gate（v0.7.0-A 已解除）

这是 v0.7.0-A Gate 1 开始前必须解决的阻塞项，不是普通版本差异。以下为 A 技术设计前的公开事实与解决规则。

A 技术设计前的公开事实：

- `vue-page-scope` 当前公开版本：`0.2.0`。
- `vue-page-runtime` 当前公开版本：`0.2.0-alpha.3`。
- `vue-page-runtime` 当前声明的 peer 范围为 `vue-page-scope ^0.1.0`。
- 按 npm semver 的 0.x 规则，`^0.1.0` 只匹配 `>=0.1.0 <0.2.0`，**不包含 `0.2.0`**。
- 因此当前两个发布版本组合不能被视为依赖声明兼容，PRD 不得声称它们已经兼容。

解决顺序：

1. 在 `vue-page-runtime` 仓库建立与 `vue-page-scope 0.2.0` 的集成测试。
2. 验证 `registerPlugin`、`tasks`、生命周期、`$loading`、`abort` 与 TypeScript 类型。
3. 根据真实兼容结果更新 `vue-page-runtime` 的 peer dependency 范围，并补充回归测试。
4. 发布新的 alpha 或 stable 版本。
5. OfferFlow 精确锁定该新发布版本。
6. 再进入 Runtime Gate 1。

最终 peer 范围（如 `^0.1.0 || ^0.2.0`、`>=0.1.0 <0.3.0` 或其他形式）必须由 `vue-page-runtime` 的真实兼容测试决定，本 PRD 不预先裁定。

明确禁止用于绕过该阻塞：

- `npm install --force`
- `npm install --legacy-peer-deps`
- 忽略 peer warning
- 直接依赖 GitHub `main`
- 将 `vue-page-runtime` 源码复制进 OfferFlow
- 在 OfferFlow 内临时篡改 `node_modules`

实施结果（2026-07-12）：兼容性前置验证完成，OfferFlow 精确安装 `vue-page-runtime@0.2.0-alpha.5`，依赖树、类型、生命周期、abort、loading、竞态与销毁验收通过，Runtime Gate 1 已完成。该结论不自动放行 Runtime SSE Gate 2。

---

## 19. v0.7.0 内部实施阶段

v0.7.0 仍然是一个产品版本，但内部按三个 Gate 实施。

### 19.1 v0.7.0-A：页面与双库基建

状态：**已完成、已合并 main、已推送**（2026-07-12）。main 合并提交：`9f935dbec65f860bb8d62bb1c1f231128dc900f6`。App 版本仍为 `0.6.2`，未创建 PR、Tag 或 Release。

包含：

- Vue Router
- JobDetailPage 最小拆分
- `vue-page-scope` 接入
- `vue-page-runtime` Gate 1
- 路由竞态与销毁测试
- 不改领域模型

验收价值：

- URL 可定位岗位
- 页面职责开始清晰
- 双库获得真实业务验证

### 19.2 v0.7.0-B：求职记忆核心

状态：**待技术设计**，不得直接开始代码实施。

包含：

- ResumeVersion
- Job / Application 分离
- FeedbackEvent
- 重复投递与多渠道归属
- 事件时间线
- migration 与旧数据兼容

验收价值：

- 系统第一次能准确表达“发生过什么”

### 19.3 v0.7.0-C：补录与基础漏斗

包含：

- 最小历史基线补录
- 高价值详细补录
- 城市 / 岗位 / 渠道 / ResumeVersion 基础漏斗
- Runtime Gate 2：SSE

验收价值：

- 为 v0.7.1 动态画像积累可用数据

---

## 20. v0.7.1 范围

包含：

- CandidateEvidence
- CapabilityBaseline
- MarketPositionProfile
- 冲刺 / 主攻 / 稳妥三层区间
- EvidenceSufficiency
- 城市能力复用与市场隔离
- 画像版本
- AI Proposal
- 证据引用
- 冷却与失效机制

前提：

- v0.7.0 已产生真实 Application / Event 数据
- 样本不足时允许明确拒答

---

## 21. v0.7.2 范围

包含：

- StrategyWindow
- 事件触发式策略建议
- Proposal Review 历史
- 用户风险偏好记录
- 投递组合建议
- 画像变化解释
- 业务 Eval

不包含后台持续骚扰式扫描。

---

## 22. Eval 要求

### 22.1 业务 Eval

至少覆盖：

1. 样本不足禁止降薪。
2. 未投递不构成拒绝。
3. 用户主动放弃不计入反馈率分母。
4. HR 不活跃的无回复不评价能力。
5. HC 冻结不评价能力。
6. 新旧 ResumeVersion 不直接混算。
7. 同一招聘主体重复反馈去重。
8. 内推和海投分渠道统计。
9. 城市能力可复用，市场转化不混算。
10. 单一高薪 Offer 只有限提升冲刺区间。
11. 多次学历拒绝形成风险标签，但不自动永久封禁。
12. 用户拒绝 Proposal 后进入冷却。
13. 弱信号不能绕过冷却。
14. 扩大稳妥区间不等于长期降级。
15. 历史回忆数据不能生成精确转化率。
16. 外包与自研岗位不无条件混算。

### 22.2 工程测试

至少覆盖：

1. Page Scope owner
2. 子组件 inject
3. Scope destroy
4. Router A → B → C 竞态
5. task trigger
6. canRun skip
7. reset
8. loading
9. abort
10. runId 防旧写
11. SSE reader cleanup
12. 后端 client-abort
13. KeepAlive 禁用路径
14. Application / Event migration
15. ResumeVersion 归属
16. Snapshot 一致性

---

## 23. 数据归属验收场景

技术设计前必须能清晰推演：

### 场景 1：重复投递

同一 Job，间隔两个月再次投递：

- 新建 Application
- 共享 Job
- 分别记录事件
- 不覆盖旧机会

### 场景 2：换平台复联

Boss 未回复，猎头后续联系同一岗位：

- 可建立第二 Application
- 渠道分别记录
- 识别同一招聘主体
- 统计时避免当成完全独立市场样本

### 场景 3：简历迭代

旧简历无回复，新简历获得面试：

- 两次 Application 分别关联 ResumeVersion
- 新旧反馈分组
- 旧版本负向信号加速衰减
- 不得继续用旧简历结果压制当前画像

---

## 24. 学历与硬约束处理

明确学历拒绝应形成：

- `hardConstraintRisk`
- 推荐排序降权
- 明确提示

但不自动永久封禁所有同类岗位。

只有在以下条件下允许自动排除：

- JD 明确写为不可替代硬门槛
- 用户主动开启严格过滤
- 多个独立招聘主体反复确认
- 没有“经验可替代”的相反证据

---

## 25. 核心指标

### 产品指标

- Application 记录完整率
- FeedbackEvent 来源完整率
- ResumeVersion 关联率
- 历史基线补录覆盖率
- 高价值事件补录率
- Proposal 接受 / 修改 / 拒绝 / 暂缓率
- 被拒 Proposal 的重复提出率
- 证据展开率

### 质量护栏

- 无证据高影响建议率：0
- 样本不足时降薪建议率：0
- 未投递误判为拒绝率：0
- 城市市场错误混算率：0
- ResumeVersion 错误混算率：0
- 路由旧响应污染率：0
- SSE abort 后继续回写率：0
- Scope 泄漏率：0
- 冷却期内重复 Proposal 率：0

---

## 26. 主要风险

| 风险 | 护栏 |
|---|---|
| 固定阈值导致系统瘫痪 | 多维样本充分度与决策分级 |
| 短期挫折改写长期定位 | 能力基线、市场画像、策略窗口分离 |
| “保底”制造价值否定 | 对外使用“稳妥区间” |
| 跨城市完全隔离 | 能力复用、市场本地化 |
| 历史补录选择偏差 | 最小基线 + 高价值详细补录 |
| 新旧简历混算 | ResumeVersion 强关联 |
| Proposal 重复骚扰 | 指纹、冷却、TTL、重大新证据 |
| Runtime alpha 影响核心链路 | 分阶段 Gate 与 feature flag |
| SSE 旧结果污染 | runId、AbortSignal、reader cleanup |
| Scope 变成巨型 Store | Owner、分层、大小控制 |
| v0.7.0 风险集中 | A/B/C 内部验收阶段 |
| 学历信号被绝对化 | 风险标签、排序降权、用户严格过滤 |

---

## 27. v0.7.0 最终验收标准

### 页面与双库

- Vue Router 支持刷新、前进、后退。
- JobDetailPage 完成最小拆分。
- Page Scope owner 唯一。
- 子组件 inject 正常。
- Scope 销毁后无 watcher、timer、event、task 泄漏。
- Runtime Gate 1 通过。
- A → B → C 路由竞态测试通过。
- Runtime Gate 2 通过后才接管 SSE。

### 求职记忆

- Job、Application、FeedbackEvent 边界清晰。
- 支持重复投递、换渠道、换简历版本。
- 用户主动退出与招聘方拒绝分离。
- 事件历史不可被当前状态覆盖。
- 旧 Job 迁移无丢失。

### 历史与统计

- 支持最小历史基线补录。
- 支持高价值详细补录。
- 按城市、岗位、渠道、ResumeVersion 展示基础漏斗。
- 回忆数据不输出精确转化率。

### 安全与可信度

- 不输出未经数据支持的成功概率。
- 不因少量无回复建议降薪。
- 不将用户偏好伪装成市场事实。
- 不将单一 Offer 全面抬升正式主攻画像。

---

## 28. 技术设计前放行条件

1. Job、Application、FeedbackEvent、ResumeVersion 在重复投递、换平台、换简历三类场景中归属清晰。
2. EvidenceSufficiency 不依赖单一固定次数。
3. 能力跨城复用与市场本地化矩阵冻结。
4. Proposal 指纹、冷却、TTL 与重大新证据规则明确。
5. Runtime Gate 1 的测试方案明确。
6. Scope 销毁审计方案明确。
7. 对外文案使用“稳妥区间”。
8. v0.7.0 按 A/B/C 内部阶段实施。

---

## 29. 最终定义

OfferFlow v0.7 是一个：

- 拥有可信求职记忆
- 区分稳定能力与城市市场
- 区分长期定位与短期策略
- 能够承认样本不足
- 所有高影响结论都可追溯
- 所有 AI 提案都需用户确认
- 页面异步任务可取消、可验证、不会串数据

的本地优先求职决策系统。

> **系统先证明自己理解了发生过什么，才有资格建议用户下一步怎么走。**
