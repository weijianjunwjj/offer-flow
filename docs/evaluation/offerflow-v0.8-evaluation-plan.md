# OfferFlow v0.8 Evaluation Plan

> **评测计划版本：** 1.0  
> **对应 PRD：** v2.1  
> **目标：** 用真实岗位、版本变化、失败与晋升剧本证明系统可用，而不是只证明单元测试绿了

---

## 1. 评测层级

1. Provider 与输入 fixture；
2. 标准化、质量、重复与变化；
3. 透明规则；
4. 单岗位 AI 结构与事实性；
5. stale 与推荐收敛；
6. 误区证据门；
7. RadarAction 与 Promotion；
8. 任务故障恢复；
9. migration、备份与恢复；
10. 真实用户端到端验收。

---

## 2. 最小数据集

### 2.1 真实岗位集：至少 30 条

覆盖：

- 高匹配高级前端；
- AI 应用方向前端；
- 产品型前端；
- 复杂中后台；
- 数据平台；
- 工业软件；
- 企业服务 SaaS；
- 表面前端、实际重 Java/Python；
- 外包、派遣、驻场；
- 纯维护、低薪、短期救火；
- 学历硬门槛；
- 经验硬门槛；
- 城市与薪资错位；
- 非苏锡沪杭岗位；
- 信息不足但值得核验；
- 同公司相似岗位；
- 跨来源重复；
- 未变化重复采集；
- 薪资、地点或 JD 实质变化。

### 2.2 采集 fixture

至少：

- 6 个 BOSS 页面 fixture；
- 6 个通用可见文本页面 fixture；
- 2 个非岗位页面；
- 2 个页面结构变化 fixture；
- 2 个提示注入或恶意文本 fixture；
- 2 个超长或异常控制字符 fixture。

### 2.3 输入 fixture

- 原始文本；
- 空文本；
- 超长文本；
- 缺字段；
- 类型错误；
- 非岗位广告。

---

## 3. 人工标注字段

```text
sample_id
expected_action_band
must_detect_constraints
must_detect_risks
must_reference_evidence
must_not_claim
expected_duplicate_group
expected_change_type
expected_recommendation_eligibility
expected_city_fallback
expected_input_readiness
expected_stale_reasons
expected_diagnosis_type_or_insufficient
notes
```

标注需保存：

- 标注人；
- 标注日期；
- 使用的正式画像版本；
- 争议项与裁决理由。

---

## 4. 发布指标

| 指标 | 发布要求 |
|---|---|
| BOSS 采集 | fixture 与真实页关键字段进入预览 |
| 通用降级 | URL、标题、可见文本可用；未知字段不补造 |
| 关键风险召回 | 所有 must_detect 项通过 |
| 严重幻觉 | 0 |
| 重要结论证据覆盖 | 100%，或明确进入 uncertainty |
| Structured Output | 合法 Payload 或明确失败 |
| 确定重复 | 不得漏判 |
| 疑似重复 | 不得静默合并 |
| 未变化 | 不创建新版本、不重复分析 |
| 实质变化 | 创建新 CandidateVersion 并显示 Diff |
| stale | 所有预期 stale reason 命中 |
| 推荐收敛 | 每批 0～8 条，不凑数 |
| 状态抑制 | 忽略、已投递、已晋升未变化时不重复推荐 |
| 无回复污染 | 0 个错误 Application/拒绝/负证据 |
| 误区诊断 | 有证据或正确 insufficient_evidence |
| 任务恢复 | 刷新、取消、重启、重试全部符合契约 |
| 晋升幂等 | 重复执行不产生重复正式对象 |
| migration/recovery | v0.7 正式数据无损，恢复可验证 |

---

## 5. 重点测试矩阵

### 5.1 CandidateVersion

| 场景 | 预期 |
|---|---|
| 同一来源、内容完全相同 | 不创建新版本 |
| 仅空白与排版变化 | 不创建新版本 |
| 薪资变化 | 新版本，change=salary_changed |
| 城市变化 | 新版本，change=location_changed |
| 职责或要求实质变化 | 新版本，change=content_changed |
| 用户修正学历字段 | 新版本，origin=manual_correction |
| 用户撤销修正 | 再创建新版本，不改旧行 |

### 5.2 输入准备度

| 场景 | 预期 |
|---|---|
| 无 ResumeVersion | 阻断分析 |
| 无 JobMatchProfileVersion | 阻断分析 |
| 无 CapabilityBaseline | 可分析，confidence ≤ medium |
| 无 MarketPosition | 不形成强市场结论 |
| 无 Strategy | 不形成强阶段策略结论 |
| 南京/北京岗位 | 全局画像，cityCode=null，城市证据不足 |
| 命中明确城市硬约束 | 规则阻断，可人工覆盖 |

### 5.3 Stale

分别切换：

- CandidateVersion；
- ResumeVersion；
- JobMatchProfileVersion；
- CapabilityBaselineVersion；
- MarketPositionVersion；
- StrategyVersion；
- RuleVersion；
- PromptVersion；
- AnalysisPolicyVersion。

每次必须得到对应 stale reason，且旧分析不得进入新推荐。

模型名称变化默认不触发全量 stale；显式 Model Policy invalidation 时触发。

### 5.4 误区证据门

| 场景 | 预期 |
|---|---|
| 5 条候选，3 条有效分析，模式明显 | 可形成诊断 |
| 5 条候选，仅 1 条有效分析 | insufficient_evidence |
| 岗位方向分布均匀，无主导模式 | insufficient_evidence |
| 支持证据存在但反证更强 | 低置信或 insufficient |
| AI 输出绝对人格判决 | 评测失败 |

### 5.5 无回复污染

1. 标记已投递待反馈；
2. 超过 follow-up 日期；
3. 不添加 HR 回复；
4. 检查：
   - 无 Application；
   - 无拒绝 FeedbackEvent；
   - 无负向 CandidateEvidence；
   - 无画像降级；
   - 推荐中被抑制。

---

## 6. 任务故障演练

### F-01 页面刷新

running 时刷新，重新进入后可读取 task 状态。

### F-02 Provider 超时

任务 failed，error code 明确；规则与旧结果仍可见。

### F-03 结构错误

自动修复最多一次；仍失败则 `STRUCTURE_REPAIR_FAILED`。

### F-04 进程重启

running 任务变为 `PROCESS_RESTART_INTERRUPTED`；用户可手动重试；不声称续传旧请求。

### F-05 取消

取消后即使 Provider 晚到响应，也不得写入 AnalysisRecord。

### F-06 重复提交

相同 input hash 返回已有 task/result，不重复计入正式结果。

### F-07 结果写入失败

任务不可错误标记 succeeded；重试不产生两份成功记录。

---

## 7. 推荐批次验收

### 正常批次

- 选择 5～20 条；
- current 分析齐备；
- 输出 0～8 条；
- 同公司相似岗位压缩；
- 每条含行动理由与核验问题。

### 空推荐

全部命中硬约束或明显低价值，输出 0 条与原因，不拿垃圾岗位填坑。

### 处理状态

忽略、已投递、已晋升未变化项不进入重点推荐；恢复或实质变化后可重新进入。

---

## 8. 正式晋升验收

场景：HR 回复后从雷达晋升。

检查：

- 晋升预览；
- 关联现有 Job 优先；
- Application 只创建一次；
- FeedbackEvent 字段正确；
- RadarPromotion 可反向追踪；
- 重复请求幂等；
- 撤销雷达动作不删除正式事实。

---

## 9. 真实发布验收剧本

1. 在 BOSS 采集至少 5 条真实岗位；
2. 用通用降级采集至少 3 条非 BOSS 岗位；
3. 验证页面不存在手工 JD 文本、链接组合或 JSON 对象/数组入口；
4. 重复采集同一岗位；
5. 模拟薪资变化并创建新版本；
6. 选择至少 10 条组成推荐批次；
7. 核对 0～8 条推荐与误区结果；
8. 收藏、忽略、重点和已投递各执行一次；
9. 验证无回复不污染；
10. 模拟 HR 回复并晋升；
11. 制造模型超时、刷新和重启；
12. 在生产库副本执行 migration 与恢复。

所有步骤需保留截图或日志证据。

---

## 10. 回归触发

修改以下任一项必须运行对应评测：

- Provider 解析；
- 标准化与 hash；
- 重复与变化；
- 规则；
- Prompt / Schema / Analysis Policy；
- 模型 Provider；
- stale 判定；
- 推荐规则；
- 误区证据门；
- Action 投影；
- Promotion；
- migration。

出现严重幻觉、关键风险漏判、重复抑制退化、stale 混入推荐或无回复污染时禁止发布。
