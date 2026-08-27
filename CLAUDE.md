# OfferFlow / Offer来了 · Claude 协作入口

## Local development environment

The primary local development environment on this machine is native Windows with Git Bash.

* Follow the global Git Bash-only shell policy.
* Do not use PowerShell or CMD as fallbacks.
* If a shell command fails, diagnose and fix it using Bash-compatible syntax.
* Do not switch shells to work around a failed command.
* Do not introduce WSL/Linux-specific assumptions into OfferFlow tooling.
* Windows-native development executables such as `node`, `pnpm`, `git`, `python`, and project CLI tools may be invoked normally from Git Bash.

本文件是 Claude / Claude Code 使用 OfferFlow 项目时的入口说明。

完整产品、工程和安全规则只维护在：

```text
AGENTS.md
```

本文件不复制完整产品和工程规则。

## Cross-project permanent memory

跨项目永久记忆的完整规则只维护在 `AGENTS.md`，本文件不复制第二份。

任务开始前先读取：

`D:/VSCode/obsidian-ai-memory/00-System/AGENT_MEMORY.md`

然后读取并遵守本项目 `AGENTS.md` 中的完整规则。


---

## 1. 执行前必读

Claude 执行任何任务前，必须按顺序读取：

1. 用户当前任务中的最新明确指令；
2. `AGENTS.md`；
3. 与任务对应的权威文档；
4. 相关源码和测试。

涉及 v0.8 既有 Radar / Analysis / Recommendation 基础能力时，按需读取：

* `docs/product/offerflow-v0.8-release-contract.md`
* `docs/product/offerflow-v0.8-traceability.md`
* `docs/prd/offerflow-v0.8.md` 中的相关章节
* `docs/technical/offerflow-v0.8-technical-design.md`

`docs/decisions/offerflow-v0.8-gemini-review-arbitration.md` 只在需要理解或挑战既有架构裁决时读取，不是日常必读。

如果本文件与 `AGENTS.md` 冲突，以用户最新明确指令和 `AGENTS.md` 为准。

---

## 2. 代码探索策略

本仓库同时提供 CodeGraph 和 Graphify。

二者职责不同，不得对普通代码问题同时无差别调用，也不得让两套工具互相重复验证。

### 2.1 默认代码探索：CodeGraph

本仓库已接入 CodeGraph（本地代码索引，`.codegraph/` 不入库）。

当 `.codegraph/` 存在时，以下任务默认优先使用 CodeGraph：

* 定位具体源码；
* 查找 symbol、class、function、API、Repository；
* 理解具体调用链；
* 分析跨文件依赖；
* 判断某次修改的直接影响范围；
* 定位业务逻辑入口；
* 修改代码前确认实际入口、调用方和被调用方。

优先直接调用：

```text
codegraph_explore
```

Shell 回退方式：

```bash
codegraph explore "<symbol names or question>"
```

使用规则：

* CodeGraph 返回的相关源码视为已经读取的上下文；
* CodeGraph 已提供足够源码时，不再使用 Grep、Glob、Read 重复验证相同内容；
* 不要为了初始代码探索启动 Explore 子代理；
* 修改代码前，优先通过 CodeGraph 确认入口、调用链和影响范围；
* 只有 CodeGraph 索引过期、缺少具体编辑上下文、结果不足，或目标文件类型不受支持时，才直接读取源码；
* 如果没有 `.codegraph/`，跳过 CodeGraph，不主动创建或刷新索引，除非用户明确要求。

### 2.2 宏观架构探索：Graphify

Graphify 用于知识图谱和宏观架构理解，不作为普通源码定位工具。

当 `graphify-out/graph.json` 存在时，以下任务优先考虑 Graphify：

* 理解高层模块关系；
* 分析 community 结构；
* 分析 god node；
* 识别跨模块耦合；
* 理解系统级知识图谱；
* 研究两个概念、模块或领域之间的结构关系；
* 做较宏观的架构审查；
* CodeGraph 无法充分回答的跨领域关系问题。

常用命令：

```bash
graphify query "<question>"
```

关系路径：

```bash
graphify path "<A>" "<B>"
```

聚焦概念：

```bash
graphify explain "<concept>"
```

如果存在：

```text
graphify-out/wiki/index.md
```

则宏观导航优先使用该文件，不要直接浏览大量原始源码。

只有在以下情况下读取：

```text
graphify-out/GRAPH_REPORT.md
```

* 进行广泛架构审查；
* `query` / `path` / `explain` 无法提供足够上下文。

### 2.3 CodeGraph 与 Graphify 的优先级

默认规则：

```text
具体源码 / symbol / 调用链 / 修改影响
→ CodeGraph

宏观架构 / community / god node / 跨模块知识关系
→ Graphify
```

不要因为 Graphify 可用，就对所有代码问题先运行 Graphify。

不要因为 CodeGraph 可用，就用它替代 Graphify 的宏观知识图谱分析。

对同一个普通代码定位任务，不要同时调用 CodeGraph 和 Graphify 做重复探索。

只有当第一种工具无法充分回答问题，且另一种工具能补充不同层级的信息时，才允许组合使用，并说明为什么需要第二种工具。

### 2.4 工具可用性与静默降级

CodeGraph / Graphify 属于代码探索增强工具，不是任务执行的硬依赖。

工具可用性与降级规则：

* `graphify-out/graph.json` 存在，只代表已有 Graphify 图谱数据存在，不代表 `graphify` CLI 当前可调用；
* `.codegraph/` 存在，只代表 CodeGraph 索引存在；具体调用方式以当前环境实际可用能力为准；
* 如果 `graphify` CLI 未安装、不在 PATH、无法调用或当前环境未暴露对应命令，但存在其他可用方式（例如 CodeGraph、已有图谱文件、直接源码读取），必须静默降级并继续任务；
* 如果 CodeGraph 不可用，但可以通过 `rg`、`grep`、`find`、`sed`、直接读取源码等方式完成任务，同样静默降级；
* 非阻塞性的工具缺失、CLI 缺失、索引工具不可调用，不属于必须向用户报告的事项；
* 不得仅因为某个增强工具不可用而暂停任务、请求用户确认或反复提醒；
* 同一已知工具缺失状态不得在同一任务或后续任务中重复汇报；
* 只有当工具缺失导致当前任务确实无法继续、会明显降低结论可靠性，或需要用户执行额外安装/授权操作时，才允许说明一次具体阻塞原因；
* 禁止为了满足工具优先级规则而擅自安装 CLI、修改 PATH、创建全局配置或扩大当前任务范围。

默认降级顺序：

```text
具体源码 / symbol / 调用链
→ CodeGraph
→ 直接源码读取 / rg / grep / find / sed

宏观架构 / knowledge graph
→ Graphify CLI（若可用）
→ 已有 graphify-out/wiki / graph.json / GRAPH_REPORT
→ CodeGraph + 直接源码读取
```

### 2.5 修改后的索引维护

代码修改完成后：

* 如果任务修改了 Graphify 已覆盖的源码，并且 `graphify-out/graph.json` 存在，运行：

```bash
graphify update .
```

保持 Graphify 图谱同步。

* 不得为了保持图谱同步而扩大当前任务范围；
* CodeGraph 索引是否更新，遵循其自身工作流和用户现有配置，不擅自执行高成本或破坏性重建。

---

## 3. 当前状态

* 公开 Web 主动发现、无人值守调度及其 Windows 集成已于 2026-08-27 完整退役；
* 真实运行库通过 forward migration 升级至 **schema v16**；
* v0.8.0 已于 2026-07-30 GA，其 Radar / Analysis / Recommendation 能力继续保留；
* Job Memory、Radar 当前页采集、Candidate/Version、Analysis、Recommendation、Promotion 与 NovaWing 上下文仍是存活能力；
* 未经用户批准不得擅自修改真实生产数据库、push、merge、Tag 或 Release。

---

## 4. Claude 的角色

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
* 做招聘平台自动翻页、批量抓取或自动投递；
* 绕过 Human-in-the-loop；
* 大范围重构无关代码；
* 创建第二套 Application 或 Feedback 流程；
* 承诺真正的 LLM 请求断点续跑；
* 合并 main、推送 main、Tag 或 Release。

用户明确批准后，数据库结构只能按照当前版本文档和 migration 约束修改。

---

## 5. v0.8 基础架构边界

Claude 实施涉及 Radar / Analysis / Recommendation 的能力时必须确保：

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

详细规则以 `AGENTS.md` 和相关历史 Technical Design 为准。

---

## 6. BOSS 与浏览器采集边界

允许：

* 用户主动点击；
* 读取当前标签页；
* BOSS 当前详情页定向字段提取；
* 通用 URL、标题和可见文本降级；
* 发送到本地 OfferFlow；
* 预览、纠错和人工确认。

禁止：

* 自动搜索招聘平台；
* 自动翻页；
* 批量遍历招聘平台；
* 读取 Cookie、密码、Token 或浏览历史；
* 绕过验证码或风控；
* 自动打招呼、投递或发消息；
* 未经确认写入正式求职记忆。

---

## 7. AI 和旧链路边界

* 当前真实 AI Provider 仍为 DeepSeek；
* 未经批准不接 OpenAI、Claude、Gemini 等新 API；
* 不做 BYOK；
* v0.8 产品契约不绑定 SSE；
* 已有 SSE 可以保留，但不得为了 SSE 扭曲任务模型；
* 旧 `OFFER_FLOW_JSON` 和 v0.8 `JobMatchAiPayload` 是不同契约，不得静默混用；
* AI 不得返回 Candidate ID、版本 ID、规则版本或输入 Hash；
* AI 不得自动修改状态、画像或正式求职事实。

---

## 8. 工作方式

开始修改前：

1. 确认用户是否已授权当前任务；
2. 检查当前分支和工作区；
3. 读取当前版本权威文档；
4. 明确本次对应的 PRD / Spec 条目；
5. 定位相关源码和测试；
6. 说明是否涉及 migration、依赖、AI 契约或正式记忆。

修改期间：

* 控制修改范围；
* 不顺手重构无关模块；
* 同步补充测试；
* 保留 Human-in-the-loop；
* 不静默改变产品文案和用户结果。

修改完成后：

* 运行对应测试、类型检查、构建、评测或演练；
* 更新对应 Spec / Traceability；
* 不得把技术测试通过等同于版本完成；
* 核心页面需要真实截图和产品文案验收；
* 未运行的验证必须明确说明；
* 如果 `graphify-out/graph.json` 存在且相关源码发生变化，运行 `graphify update .`。

个人项目默认不创建 Pull Request。

以下动作分别需要用户明确授权：

* merge main；
* push main；
* Tag；
* Release。

---

## 9. 每次交付必须报告

1. 对应版本、波次和需求；
2. 读取的权威文档；
3. 修改、新增和删除的文件；
4. 是否修改业务代码；
5. 是否修改数据库结构或 migration；
6. 是否新增依赖；
7. 是否修改 AI Prompt、Schema、Provider、SSE 或任务机制；
8. 是否保留 Human-in-the-loop；
9. 实际运行的命令和关键结果；
10. 是否更新 Traceability / Spec；
11. 是否触碰 BOSS 自动化、BYOK、新 Provider 或正式记忆边界；
12. 是否 commit、merge、push、Tag 或 Release；
13. 是否更新 Graphify 图谱；
14. 遗留风险和未完成项。

未运行测试不得声称已验证。

不确定产品边界时，停止相关修改并说明冲突，不得自行拍板。
