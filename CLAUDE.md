# OfferFlow / Offer来了 · Claude 协作入口

本文件是 Claude / Claude Code 使用 OfferFlow 项目时的入口说明。

完整规则只维护在：

```text
AGENTS.md
```

本文件不复制完整产品和工程规则。

---

## 1. 执行前必读

Claude 执行任何任务前，必须按顺序读取：

1. 用户当前任务中的最新明确指令；
2. `AGENTS.md`；
3. 与任务对应的权威文档；
4. 相关源码和测试。

所有 v0.8 任务至少读取：

* `docs/product/offerflow-v0.8-release-contract.md`
* `docs/product/offerflow-v0.8-traceability.md`
* `docs/prd/offerflow-v0.8.md` 中的相关章节

按任务追加读取：

| 任务                        | 必读文档                                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| 数据模型、API、Repository、任务状态机 | `docs/technical/offerflow-v0.8-technical-design.md`                     |
| migration、备份、恢复           | Technical Design + `docs/runbooks/offerflow-v0.8-migration-recovery.md` |
| 浏览器扩展、BOSS 当前页采集          | Technical Design + `docs/security/browser-capture-security.md`          |
| 标准化、规则、AI、推荐与评测           | Technical Design + `docs/evaluation/offerflow-v0.8-evaluation-plan.md`  |
| 发布验收                      | Release Contract + Evaluation Plan + Runbook + Traceability             |

`docs/decisions/offerflow-v0.8-gemini-review-arbitration.md` 只在需要理解或挑战既有架构裁决时读取，不是日常必读。

如果本文件与 `AGENTS.md` 冲突，以用户最新指令和 `AGENTS.md` 为准。

---

## 2. 当前状态

* OfferFlow v0.7.0 已正式发布；
* v0.8 定位为“可解释岗位雷达与 JD 采集桥”；
* v0.8 PRD 当前版本为 v2.1；
* v0.8 代码实施尚未开始；
* 当前处于 V8-0 文档审阅和冻结阶段；
* 在用户明确批准开始实施前，不得修改 v0.8 业务代码、数据库结构或浏览器扩展；
* 文档已放入仓库不等于获得代码实施授权。

用户批准后，按以下顺序实施：

```text
V8-1 领域模型与 migration
V8-2 当前页采集桥与导入
V8-3 标准化、重复、变化与规则
V8-4 任务与单岗位 AI 分析
V8-5 推荐批次、误区诊断与 RadarAction
V8-6 正式晋升、评测与发布验收
```

不得跳波次或静默移动 P0 范围。

---

## 3. Claude 的角色

Claude 适合作为：

* 受控实施助手；
* 数据模型、API 和类型实现助手；
* 局部 UI 实现助手；
* migration 和测试辅助者；
* selftest / eval 检查者；
* 文档和 Traceability 同步助手；
* 安全和边界复核者。

Claude 不得擅自：

* 重新定义产品；
* 删除、延期或拆分 P0；
* 扩大项目范围；
* 引入新依赖；
* 修改数据库结构；
* 接入新 AI Provider；
* 做 BYOK；
* 做自动翻页、后台扫描或自动投递；
* 绕过 Human-in-the-loop；
* 大范围重构无关代码；
* 创建第二套 Application 或 Feedback 流程；
* 承诺真正的 LLM 请求断点续跑；
* 合并 main、推送 main、Tag 或 Release。

用户明确批准后，数据库结构只能按照 Technical Design 和 Migration Runbook 修改。

---

## 4. v0.8 必须守住的架构边界

Claude 实施 v0.8 时必须确保：

* `RadarCandidate` 只保存 `active / merged / archived` 生命周期；
* 所有标准化事实版本进入不可变 `RadarCandidateVersion`；
* 规则、分析、推荐和动作引用明确的 `candidate_version_id`；
* 收藏、忽略、重点和已投递待反馈从 `RadarAction` 派生；
* 正式晋升从 `RadarPromotion` 派生；
* 不创建 `radar_application_marks`；
* 不创建 Candidate `user_handling_state`；
* AI 只返回业务 Payload；
* ID、版本、Hash、模型和审计字段由服务端 Envelope 附加；
* stale 通过版本比较和 `staleReasons` 派生；
* 无回复不创建正式拒绝或能力反证；
* 非目标城市使用全局画像和 `cityCode = null`；
* 推荐批次只能输出 0～8 条；
* 误区证据不足时输出 `insufficient_evidence`；
* 进程重启后的遗留任务从固定输入重新执行，不冒充断点续跑。

详细规则以 `AGENTS.md` 和 Technical Design 为准。

---

## 5. BOSS 与浏览器采集边界

允许：

* 用户主动点击；
* 读取当前标签页；
* BOSS 当前详情页定向字段提取；
* 通用 URL、标题和可见文本降级；
* 发送到本地 OfferFlow；
* 预览、纠错和人工确认。

禁止：

* 自动搜索；
* 自动翻页；
* 批量遍历；
* 后台扫描；
* 读取 Cookie、密码、Token 或浏览历史；
* 绕过验证码或风控；
* 自动打招呼、投递或发消息；
* 未经确认写入正式求职记忆。

---

## 6. AI 和旧链路边界

* 当前真实 AI Provider 仍为 DeepSeek；
* 未经批准不接 OpenAI、Claude、Gemini 等新 API；
* 不做 BYOK；
* v0.8 不绑定 SSE；
* 已有 SSE 可以保留，但不得为了 SSE 扭曲任务模型；
* 旧 `OFFER_FLOW_JSON` 和 v0.8 `JobMatchAiPayload` 是不同契约，不得静默混用；
* AI 不得返回 Candidate ID、版本 ID、规则版本或输入 Hash；
* AI 不得自动修改状态、画像或正式求职事实。

---

## 7. 工作方式

开始修改前：

1. 确认用户是否已授权当前波次；
2. 检查当前分支和工作区；
3. 读取 Traceability；
4. 明确本次对应的 PRD 和 Release Contract 条目；
5. 定位相关源码和测试；
6. 说明是否涉及 migration、依赖、AI 契约或正式记忆。

修改期间：

* 控制修改范围；
* 不顺手重构无关模块；
* 同步补充测试；
* 保留 Human-in-the-loop；
* 不修改未授权波次；
* 不静默改变产品文案和用户结果。

修改完成后：

* 运行对应测试、类型检查、构建、评测或演练；
* 更新 Traceability；
* 不得把技术测试通过等同于版本完成；
* 核心页面需要真实截图和产品文案验收；
* 未运行的验证必须明确说明。

个人项目默认不创建 Pull Request。

以下动作分别需要用户明确授权：

* merge main；
* push main；
* Tag；
* Release。

---

## 8. 每次交付必须报告

1. 对应版本、波次和需求；
2. 读取的权威文档；
3. 修改、新增和删除的文件；
4. 是否修改业务代码；
5. 是否修改数据库结构或 migration；
6. 是否新增依赖；
7. 是否修改 AI Prompt、Schema、Provider、SSE 或任务机制；
8. 是否保留 Human-in-the-loop；
9. 实际运行的命令和关键结果；
10. 是否更新 Traceability；
11. 是否触碰 BOSS 自动化、BYOK、新 Provider 或正式记忆边界；
12. 是否 commit、merge、push、Tag 或 Release；
13. 遗留风险和未完成项。

未运行测试不得声称已验证。

不确定产品边界时，停止相关修改并说明冲突，不得自行拍板。
