# OfferFlow v0.8 Gemini 独立评审仲裁与最终裁决

> **裁决日期：** 2026-07-17  
> **评审对象：** `OfferFlow_v0.8_PRD_最新正式实施稿.md`（PRD v2.0）  
> **裁决状态：** 文档修订裁决完成；代码实施尚未获批  
> **适用版本：** OfferFlow v0.8 PRD v2.1

---

## 1. 执行结论

Gemini 的总体判断成立：**v2.0 方向正确，但不能直接冻结实施。**

它准确命中了四个会让实现迅速变成“状态泥石流”的问题：

1. 缺少真正不可变的 `RadarCandidateVersion`；
2. `radar_application_marks` 实际构成第二套影子 Application；
3. Candidate 状态混合生命周期、分析、动作与晋升；
4. AI Payload 被迫返回系统内部 ID 与版本字段。

它对任务恢复、非目标城市和分析过期的补充也正确。

但 Gemini 的瘦身建议存在三处过度裁剪，不能整包接受：

- **通用可见文本降级采集不应移出 P0。** 它不是第三个平台专用适配器，而是当前页采集桥的安全兜底；实现成本可控，却能避免产品退化成“只支持 BOSS 的半座桥”。
- **本批筛选误区不能直接后移 v0.9。** 这是 v0.8“帮助用户收敛注意力并纠正错误用力”的核心用户结果。应缩成有严格证据门的单一诊断，而不是删除。
- **标准 JSON 输入不应完全删除。** 应删除专门的批次管理页面与持久化批次领域，但保留单对象或有上限数组的标准 JSON 预览导入，复用同一预览与确认链路。

最终裁决：**接受架构纠错，拒绝产品价值被过度削薄；v0.8 P0 保持 12 项，但实现边界显著收紧。**

---

## 2. 与既有红队结论的一致意见

| 议题 | Gemini | 既有红队 | 最终裁决 |
|---|---|---|---|
| 不可变 Candidate Version | 必须新增独立版本表 | 必须新增 | 完全接受 |
| 影子 Application | 删除 `radar_application_marks` | 删除，改用 Action | 完全接受 |
| Candidate 混合状态 | 必须拆分 | Candidate 仅保存生命周期 | 完全接受，但采用更严格版本 |
| AI 返回内部 ID | 必须移除 | 服务端 Envelope 包装 | 完全接受 |
| 输入准备度 | 补齐 | 已提出明确规则 | 完全接受 |
| 非目标城市 | 补齐降级/阻断契约 | 使用全局画像、`cityCode=null` | 完全接受 |
| Stale Invalidation | 必须补齐 | 已提出版本变化集合 | 完全接受，并改为确定性派生 |
| 任务断点续跑 | 当前承诺不成立 | 区分记录恢复与真正续跑 | 完全接受 |
| 猎聘专用适配 | 后移 | P1 | 完全接受 |
| 文档拆分 | 必须拆分 | 七份文档 | 完全接受 |

---

## 3. 冲突意见与逐条裁决

### 3.1 通用招聘页降级采集

**Gemini 建议：** 与猎聘一起后移，只保留 BOSS + 手工粘贴。

**裁决：部分拒绝。**

P0 保留两种浏览器能力：

1. `boss_current_page`：BOSS 定向字段提取；
2. `generic_visible_text`：只读取当前标签页可见文本、URL 与标题，无法可靠识别的字段保持未知并进入预览。

`generic_visible_text` 不是平台 DOM 适配器，不承诺自动识别完整字段，也不需要追着各平台 DOM 改版跑。它是“桥断了还能走过去”的木栈道，成本低、价值高。

**猎聘专用字段适配进入 P1。**

### 3.2 本批最大筛选误区

**Gemini 建议：** 整体后移 v0.9。

**裁决：拒绝删除，接受强约束缩编。**

v0.8 P0 保留 `BatchMisconceptionDiagnosis`，但必须满足：

- 不建立独立 Agent 或多步骤推断链；
- 不建立独立长期画像结论；
- 只基于当前推荐批次的结构化统计、当前正式画像与有效分析；
- 一批只输出一个结果；
- 证据门未通过时必须输出 `insufficient_evidence`；
- 诊断作为 `RadarRecommendationBatch` 的附属 Payload 保存，不单建平行主流程；
- 诊断不得直接修改职业画像、策略或能力基线。

这使它从“全局职业算命器”降维成“本批注意力偏差提示器”，仍保留产品灵魂。

### 3.3 标准 JSON 导入

**Gemini 建议：** 完全删除 JSON 批量导入和 `/radar/imports`。

**裁决：部分接受。**

删除：

- `/radar/imports` 专门批次管理页面；
- `radar_import_batches` 领域表；
- 长期批次统计、部分失败追踪等大而全流程。

保留：

- 标准 JSON 单对象导入；
- 有明确数量上限的小数组导入；
- 与文本导入共用 preview → correction → commit；
- 每一项独立生成 CaptureSnapshot 和 CandidateVersion；
- 预览会话只作为短期技术对象，不成为长期产品领域。

JSON 是低成本互操作入口，不值得为砍两张表顺手把门也焊死。

### 3.4 Candidate 状态拆分

**Gemini 修正版：** Candidate 保存 `user_handling_state = active/ignored/promoted/archived`。

**裁决：仍不够干净，拒绝该字段设计。**

最终模型：

- `RadarCandidate.lifecycle_status`：仅 `active / merged / archived`；
- 当前分析状态：从 `AnalysisTask` 和最新分析记录派生；
- 收藏、忽略、重点、已投递：从 `RadarAction` 派生；
- 正式晋升：从 `RadarPromotion` 派生；
- `merged` 时保存 `merged_into_candidate_id`；
- Candidate 可有查询投影，但投影不是事实源。

`ignored` 与 `promoted` 都是发生过的行为或关系，不是 Candidate 的生命形态。

### 3.5 Stale 机制

**Gemini 建议：** 增加 `is_stale` 并级联更新。

**裁决：接受需求，调整实现。**

分析记录保持不可变，不依赖全表级联 UPDATE 作为唯一真相。

系统通过以下版本信封确定性计算有效性：

- CandidateVersion；
- ResumeVersion；
- JobMatchProfileVersion；
- CapabilityBaselineVersion；
- MarketPositionVersion；
- StrategyVersion；
- RuleVersion；
- PromptVersion；
- Analysis Policy Version。

读取时输出 `current / stale` 与 `staleReasons[]`。可建立缓存或投影，但源事实是版本比较。

模型名称与模型版本进入审计和 input hash；**模型升级本身默认不让所有历史分析集体过期**。只有明确的 Model Policy 宣告旧模型结果不可再用于推荐时，才形成 stale 原因。

### 3.6 DeepSeek SSE

**Gemini 建议：** DeepSeek SSE 结构化输出。

**裁决：不进入产品冻结契约。**

v0.8 复用现有模型 Provider 抽象；默认优先非流式结构化调用，以减少任务恢复和半截 JSON 处理复杂度。具体模型、是否流式属于技术实现选择，不能绑死产品 PRD。

### 3.7 任务“恢复进度”

Gemini 在严重错误章节正确否定真正断点续跑，但在实施波次中又写了“重启后端后恢复进度”。

**最终统一语义：**

- 页面刷新：恢复任务展示和轮询；
- 应用进程重启：恢复任务记录；
- 遗留 `running`：转为 `failed_retryable` 的用户语义（数据库状态仍可统一为 `failed` + error code）；
- 手动重试：复用原不可变输入重新执行；
- 成功结果写入：通过 input hash 与唯一约束幂等；
- 不承诺 LLM HTTP 请求从中间字节继续。

---

## 4. 最终 P0 范围

1. BOSS 当前页主动采集；
2. 通用可见文本当前页降级采集；
3. 文本与标准 JSON 预览导入；
4. 不可变 CaptureSnapshot 与 RadarSourceRecord；
5. RadarCandidate + 不可变 RadarCandidateVersion；
6. 标准化、质量、重复和实质变化识别；
7. 透明规则预检与用户覆盖；
8. 复用 v0.7 正式上下文的可解释单岗位 AI 分析；
9. 0～8 条推荐批次与有证据门的单一误区诊断；
10. RadarAction：收藏、忽略、重点、已投递待反馈及撤销；
11. RadarPromotion：安全晋升现有 Job/Application/FeedbackEvent；
12. AnalysisTask、真实评测、migration、备份和恢复验收。

---

## 5. 最终领域模型

```text
CaptureSession（短期技术预览对象）
        ↓ commit
RadarCaptureSnapshot（不可变原始快照）
        ↓
RadarSourceRecord（来源身份与多次发现）
        ↓ N:M
RadarCandidate（仅生命周期与 active_version_id）
        ↓ 1:N
RadarCandidateVersion（不可变标准化事实）
        ├─ RadarRuleAssessment（绑定明确版本）
        ├─ JobMatchAnalysisRecord（服务端 Envelope + AI Payload）
        ├─ RadarAction（用户行为流水）
        └─ RadarRecommendationBatch（引用明确版本集合）
                 ↓
RadarPromotion（关联现有 Job / Application / FeedbackEvent）
```

关键约束：

- 手动纠错与 JD 实质变化都创建新 CandidateVersion；
- 所有规则、分析、动作、推荐都引用 `candidate_version_id`；
- AI 只返回业务 Payload；
- 所有系统 ID、版本、Hash、模型与审计字段由服务端附加；
- 无回复不产生正式拒绝、负向证据或画像降级。

---

## 6. 最终输入准备度

| 输入 | 要求 | 缺失后的行为 |
|---|---|---|
| ResumeVersion | 必须 | 阻断 AI 分析 |
| JobMatchProfileVersion | 必须 | 阻断 AI 分析 |
| CapabilityBaselineVersion | 可缺失 | 仅探索性分析，置信度最高为 medium |
| MarketPositionVersion | 可缺失 | 不形成市场层级与薪资供给强结论 |
| StrategyVersion / Window | 可缺失 | 不形成阶段策略一致性强结论 |
| 城市专属画像 | 可缺失 | 使用全局画像，`cityCode=null`，展示城市证据不足 |

非苏锡沪杭岗位不默认阻断。只有命中用户明确城市硬约束时才阻断；否则作为风险或证据不足进入分析。

---

## 7. 最终实施波次

### V8-0：文档与契约冻结

- PRD v2.1；
- Release Contract；
- Technical Design；
- Evaluation Plan；
- Security；
- Migration/Recovery Runbook；
- Traceability。

**Gate：** 用户明确批准后方可进入代码。

### V8-1：领域模型与迁移演练

- CandidateVersion；
- Action；
- Promotion；
- Analysis Envelope；
- 新增表、索引、外键与唯一约束；
- 真实数据库副本迁移与恢复演练。

### V8-2：采集、导入、预览和版本生成

- BOSS 定向采集；
- 通用可见文本降级；
- 文本/JSON 预览；
- CaptureSnapshot；
- 用户纠错生成 CandidateVersion。

### V8-3：标准化、重复、变化和透明规则

- 来源身份；
- 指纹；
- 确定/疑似重复；
- 实质变化；
- 规则命中原文；
- 用户覆盖。

### V8-4：可靠单岗位分析

- 输入准备度；
- AnalysisTask；
- Envelope + Payload；
- 一次结构修复；
- stale 判定；
- 页面刷新恢复与重启后可重试失败。

### V8-5：有限推荐、误区诊断与雷达动作

- 手动选择 5～20 条；
- 0～8 条推荐；
- 空推荐；
- 有证据门的误区结果；
- 收藏、忽略、重点、已投递待反馈。

### V8-6：正式晋升、评测与发布验收

- RadarPromotion；
- 30 条真实岗位评测；
- 端到端剧本；
- migration/backup/recovery；
- 截图和产品文案验收。

---

## 8. 最终裁决状态

- Gemini 评审：已完成吸收与仲裁；
- PRD v2.0：废止，不得作为实施输入；
- PRD v2.1：已生成，状态为“待用户批准冻结”；
- 代码实施：未授权；
- main 合并、推送、Tag、Release：均未授权。
