# OfferFlow / Offer来了 v0.1 开发进度记录

## 1. 文档用途

本文档用于记录 OfferFlow v0.1 的真实开发进度。

任何 AI 或开发者进入本项目时，必须先阅读本文档，确认：

1. 当前做到哪一步
2. 哪些任务已经完成
3. 哪些任务正在进行
4. 哪些任务尚未开始
5. 哪些任务被阻塞
6. 当前是否允许进入下一步

本文档是项目进度的唯一事实来源。

如果聊天上下文、AI 记忆、口头描述与本文档冲突，以本文档为准。

---

## 2. 当前项目状态

项目名称：

> OfferFlow / Offer来了

仓库名称：

> offer-flow

当前版本：

> v0.2.0 开发中（One-Shot Opportunity Radar / 一次分析 · 机会雷达版）；v0.1 P0 已封版

当前模式：

> Manual Mode（v0.2.0 仍不接 API，仅升级为固定 JSON 结构化解析）

当前阶段：

> v0.1 P0（Step 0 - Step 8）已全部完成并封版；v0.2.0 已启动。Task 0（收口 v0.1.1 / 同步 origin）已完成，Task 1（DEC-016 / DEC-017 + v0.2.0 需求文档）已完成。

当前是否允许进入下一步：

> 待用户确认 Task 1。确认后方可进入 Task 2（引入 Naive UI 基础壳）。

---

## 3. 版本边界

v0.1 只做 P0。

v0.1 不做：

1. 不接 API
2. 不做 BYOK
3. 不做后端
4. 不做登录
5. 不做爬虫
6. 不做 PDF / Word 解析
7. 不做自动投递
8. 不做云同步
9. 不做复杂统计
10. 不做泛求职平台

---

## 4. 总任务进度表

| Step | 任务 | 状态 | 执行者 | 审查者 | 用户确认 | 备注 |
|---|---|---|---|---|---|---|
| Step 0 | 数据与本地存储底座 | 已完成 | CC | Codex | 已确认 | 已于 commit 47ed246 提交；DEC-012 已由用户确认并归档为已拍板 |
| Step 1 | 简历 / 偏好配置页 | 已完成 | CC | Codex | 已确认 | 已于 commit 55bb18d 提交 |
| Step 2 | 岗位台账列表空壳 | 已完成 | CC | Codex | 已确认 | 已于 commit 90d3f48 提交 |
| Step 3 | 岗位主战场基础信息 + 保存 | 已完成 | CC | Codex | 已确认 | 已于 commit c5e8b1c 提交；用户已确认 |
| Step 4 | Prompt 生成 + 复制 | 已完成 | CC | Codex | 已确认 | 已于 commit 2034966 合并到 main 并推送 |
| Step 5 | AI 结果兜底承接 | 已完成 | CC / Codex | Codex | 已确认 | 已于 commit 0da6ee0 提交；原文保存、刷新回显、时间、解析状态和反馈均已验证 |
| Step 6 | 报告展示 + Boss 话术编辑 | 已完成 | CC | Codex | 已确认 | 已于 commit 04890cc 提交；报告原文展示与复制、话术编辑/保存/复制均已验证 |
| Step 7 | 沟通状态流转 | 已完成 | CC | Codex | 已确认 | 已于 commit 08e9aee 提交；6 态任意切换、即时持久化、列表同步和刷新回显均已验证 |
| Step 8 | 回看闭环 + 文案收口 | 已完成 | CC / Codex | Codex | 已确认 | Manual Mode、不接 API 与整理工具文案已收口；端到端回看全字段回显已验证；待提交 |

状态枚举：

- 未开始
- 进行中
- 待审查
- 待用户确认
- 已完成
- 阻塞
- 废弃

---

## 5. 最近完成任务详情

### 最近完成任务：Task 0 初始化仓库 + 导入 Step 0

任务来源：

> docs/v0.1/task-cards.md

执行者：

> CC

审查者：

> Codex

产品确认者：

> 用户 + GPT

### Task 0 目标

1. 初始化 Vue 3 + Vite + TypeScript 项目
2. 保留 README.md、CLAUDE.md、AGENTS.md 和 docs 目录
3. 导入 Claude.ai 已产出的 Step 0 存储层代码
4. 放入 src/storage/
5. 放置 selftest
6. 跑通 typecheck
7. 跑通 selftest

### Task 0 严禁

1. 不做页面
2. 不做 Prompt
3. 不做 AI 结果承接
4. 不做报告
5. 不做 Boss 话术
6. 不接 API
7. 不做 BYOK
8. 不做后端
9. 不做爬虫
10. 不做 PDF / Word 解析

### Task 0 验收标准

1. 仓库能启动基本 Vue 3 + Vite + TypeScript 项目
2. docs 文件存在
3. CLAUDE.md 存在
4. AGENTS.md 存在
5. docs/v0.1/roles-and-workflow.md 存在
6. docs/v0.1/progress.md 存在
7. docs/v0.1/decision-log.md 存在
8. src/storage 文件存在
9. selftest 能跑
10. typecheck 通过
11. Step 0 存储层能保存 / 读取 / 更新 / 删除配置与岗位记录
12. 未混入 P0 之外功能

---

## 6. 进度更新规则

每完成一个任务，必须更新本文档。

更新内容包括：

1. 当前 Step 状态
2. 执行者
3. 审查者
4. 用户是否确认
5. 自测结果
6. 类型检查结果
7. 遗留风险
8. 是否允许进入下一步

任何 AI 完成任务后，如果没有更新本文档，视为交付不完整。

---

## 7. 任务完成记录

### 记录模板

#### YYYY-MM-DD · Step X · 任务名称

- 状态：
- 执行者：
- 审查者：
- 用户确认：
- 改动文件：
- 自测命令：
- 自测结果：
- 类型检查：
- 遗留风险：
- 是否允许进入下一步：
- 建议 commit message：

---

## 8. 当前阻塞项

暂无。

如出现阻塞，必须记录：

1. 阻塞内容
2. 发现者
3. 影响范围
4. 解决建议
5. 谁来拍板
6. 当前状态

---

## 9. 最近一次进度更新

### 2026-06-11 · 初始化进度文档

- 状态：进行中
- 执行者：用户 / GPT
- 审查者：待定
- 用户确认：已确认需要该文档
- 内容：新增开发进度记录文档，作为后续 AI 协作的进度事实来源
- 下一步：由 CC 执行 Task 0，完成后更新本文档

---

### 2026-06-11 · Step 0 · 初始化仓库 + 导入 Step 0

- 状态：已完成（CC 已完成执行，Codex 已审查通过，用户已确认）
- 执行者：CC
- 审查者：Codex（已审查通过）
- 用户确认：已确认 DEC-012 与 Task 0
- 改动文件：
  - 新增 package.json、package-lock.json、tsconfig.json、vite.config.ts、index.html、.gitignore
  - 新增 src/main.ts、src/App.vue、src/vite-env.d.ts（Task 0 占位骨架，不含任何 v0.1 业务页面）
  - 导入 src/storage/：types.ts、driver.ts、keys.ts、id.ts、configStore.ts、jobStore.ts、index.ts
  - 导入 scripts/storage.selftest.ts（由 Claude.ai 候选 selftest.ts 改放，仅调整相对导入路径）
- 自测命令：
  - npm run typecheck
  - npm run selftest
  - npm run build（附加验证 Vue 3 + Vite + TypeScript 骨架可构建）
- 自测结果：
  - typecheck：vue-tsc --noEmit，0 error
  - selftest：30 passed, 0 failed
  - build：成功，10 modules transformed
- 类型检查：通过（strict 模式，0 error）
- 候选代码合规审查：
  - 全局配置一份（JobSeekerProfile，覆盖式保存）✓
  - 岗位分条存（JobRecord，一条一个 storage key）✓
  - AI 原文独立字段 aiRawResult ✓；report 默认 null ✓；parseStatus 默认 none ✓
  - ContactStatus 6 态与 DEC-003 一致 ✓
  - 未引入 PromptRecord / AIAnalysisResult / JobStatusLog 独立实体（符合 DEC-004）✓
  - 读坏数据行为明确：profile/getJob 抛清晰错误，listJobs 跳过坏行并 warn ✓
- 对候选代码的调整：仅将 selftest 的导入路径由 `./src/storage` 改为 `../src/storage`（因从仓库根移动到 scripts/），无任何逻辑改动
- 遗留风险：
  1. localStorage 容量上限（约 5MB），岗位数量极大时可能受限，v0.1 不处理
  2. BrowserStorageDriver 未捕获 setItem 配额溢出异常，后续承接长文本时需关注
  3. 坏数据在 getProfile / getJob 路径采用抛错策略，页面层接入时需做兜底
- 是否涉及 decision-log 更新：是。已根据 Codex 审查意见补充 docs/v0.1/decision-log.md DEC-012，记录 Task 0 工具链与依赖选择；用户已确认 DEC-012 与 Task 0。候选 storage 代码本身与既有决策（DEC-003 / DEC-004 / DEC-005）一致，未改产品边界、数据核心字段或状态枚举
- 决策日志：DEC-012 已记录 Vue 3 + Vite + TypeScript、vue-tsc、tsx、@vitejs/plugin-vue、@types/node 等工具链与依赖选择；用户已确认该决策
- 是否允许进入下一步：Task 0 已提交完成；Task 1 尚未启动，需用户另行明确开始
- 建议 commit message：chore: 初始化 OfferFlow v0.1 项目骨架并导入 Step 0 storage 与 selftest

---

### 2026-06-11 · 项目治理 · Codex 审查与低风险小修规则

- 状态：已完成
- 提出者：用户
- 执行者：Codex
- 用户确认：已确认
- 改动文件：
  - AGENTS.md
  - docs/v0.1/roles-and-workflow.md
  - docs/v0.1/decision-log.md
  - docs/v0.1/progress.md
- 内容：
  - 新增 Codex 默认“审查 + 低风险小修”模式
  - 明确低风险文档同步问题可由 Codex 直接修复，无需转回 CC
  - 明确产品边界、数据模型、状态枚举、新依赖、大重构、删除文件和低置信度事项必须由用户拍板
  - 将用户已确认的 DEC-012 归档为已拍板
  - 新增已拍板决策 DEC-013
- 产品边界：未修改
- 代码与依赖：未修改
- typecheck / selftest：仅修改治理文档，无需重跑
- 是否进入 Task 1：否
- 建议 commit message：docs: 补充 Codex 审查与低风险小修规则

---

### 2026-06-12 · Step 1 · 简历 / 偏好配置页

- 状态：已完成（CC 已完成实现，Codex 已审查通过，用户已确认）
- 执行者：CC
- 审查者：Codex（已审查通过）
- 用户确认：已确认
- 改动文件：
  - 新增 src/pages/ProfileConfigPage.vue（简历 / 偏好配置页，9 字段表单 + 保存 + 反馈 + 刷新回显）
  - 新增 src/app/stores.ts（浏览器端 stores 单例，延迟创建，复用 Step 0 ConfigStore）
  - 修改 src/App.vue（由占位骨架改为承载配置页）
  - 新增 .claude/launch.json（本地预览 dev server 配置，仅自测用）
  - 修改 .gitignore（忽略 .claude/settings.local.json 本机权限配置）
  - 修改 src/main.ts（修正 Task 0 过时注释，不改业务逻辑）
- 实现内容：
  - 复用 Step 0 的 JobSeekerProfile 与 ConfigStore，未新增数据实体、未改字段、未改状态枚举
  - 9 个字段全部可输入：简历正文、项目经历、目标城市、目标岗位方向、期望薪资、当前求职重点（求稳/涨薪/履历/技术成长）、是否接受外包、是否接受加班、个人短板说明
  - 保存采用覆盖式（全局配置只存一份）；保存后展示「已保存 ✓ + 时间」反馈
  - onMounted 读取已存配置并回显；用默认值兜底缺失字段
  - 读到坏数据时展示错误横幅且不崩溃（getProfile 抛错被捕获）
- 自测命令：
  - npm run typecheck
  - npm run build
  - npm run selftest（回归，确认未影响 Step 0）
  - 浏览器自测（Vite dev + 真实交互）：填入全部 9 字段 → 保存 → 刷新 → 校验回显
- 自测结果：
  - typecheck：vue-tsc --noEmit，0 error
  - build：成功，22 modules transformed
  - selftest：30 passed, 0 failed（无回归）
  - 浏览器自测：保存后 localStorage 仅 1 个 key `offerflow:profile`，9 字段与类型（含 boolean、growth 枚举）全部正确；刷新后 9 字段完整回显，保存反馈正确不持久化；坏数据时显示错误横幅、表单仍正常渲染
  - Codex 复核：typecheck、build、selftest 均通过；浏览器安全策略阻止独立访问本地地址，未重复执行交互自测
- 验收对照（task-cards Task 1）：
  - 所有字段可输入 ✓
  - 点击保存后数据持久化 ✓
  - 刷新页面后字段完整回显 ✓
  - 不丢字段 ✓
- 范围合规：未做岗位主战场、未做 Prompt、未做 AI 结果、未做报告，符合 Task 1 禁止项
- 是否涉及 decision-log 更新：否。未改产品边界、数据核心字段、状态枚举，未引入新依赖（仅使用 DEC-012 已批准的 Vue/Vite/TS 栈）
- 遗留风险：
  1. 当前仅单页直接挂载，未引入路由；进入 Task 2 多页面时需补路由方案
  2. 保存未捕获 localStorage 配额溢出异常（与 Step 0 同源风险），长文本极端情况下需关注
  3. .claude/launch.json 为本地自测预览配置，不影响 Task 1 业务验收
- 用户确认记录：2026-06-12，用户确认 Task 1 通过，无重大问题
- 是否允许进入下一步：否。需完成 Task 1 提交后，方可进入 Task 2
- 建议 commit message：feat: 实现简历 / 偏好配置页并接入 Step 0 storage

---

### 2026-06-12 · Step 2 · 岗位台账列表空壳

- 状态：已完成（CC 已完成实现，Codex 已审查通过，用户已确认）
- 执行者：CC
- 审查者：Codex（已审查通过）
- 用户确认：已确认
- 改动文件：
  - 新增 src/pages/JobListPage.vue（岗位台账列表：空状态、列表展示、新建入口、点击进入主战场）
  - 新增 src/pages/BattlefieldPage.vue（岗位主战场占位空壳，仅作导航目标，Task 3 再实现录入与保存）
  - 修改 src/App.vue（新增最小导航壳：简历配置 / 岗位台账两个区，岗位区内 list ↔ battlefield 视图切换）
- 实现内容：
  - 复用 Step 0 的 JobStore.listJobs，未新增数据实体、未改字段、未改状态枚举
  - 空状态：无岗位时展示提示文案 + 新建岗位按钮
  - 列表展示：公司 / 岗位 / 城市 / 薪资 / 匹配度 / 沟通状态 / 更新时间，按 updatedAt 倒序（沿用 Step 0 排序）
  - 沟通状态按 DEC-003 六态映射为中文标签（未沟通 / 已打招呼 / 已回复 / 已约面 / 已拒绝 / 已结束）
  - 新建岗位：进入主战场「新建」模式（按 product.md §7.2，创建与保存在 Task 3，不在本步落库）
  - 点击列表项：进入主战场并携带对应岗位 ID（「查看 / 编辑」模式）
  - 主战场提供「返回台账」按钮
- 设计说明：
  - 本步未引入 vue-router，改用 App 级视图状态切换承载多视图，未新增任何依赖；如后续需要深链接或刷新保持视图，再按 DEC-012 的复审条件评估
- 自测命令：
  - npm run typecheck
  - npm run build
  - npm run selftest（回归，确认未影响 Step 0）
  - 浏览器自测（Vite dev + 真实交互 + 通过 Step 0 数据结构 seed 岗位）
- 自测结果：
  - typecheck：vue-tsc --noEmit，0 error
  - build：成功，29 modules transformed
  - selftest：30 passed, 0 failed（无回归）
  - 浏览器自测：空状态正确显示；新建 → 主战场（新建模式）；seed 两条岗位后列表按 updatedAt 倒序展示、空匹配度回退为「—」、状态标签正确；点击行 → 主战场并携带正确岗位 ID；返回 → 列表；顶部导航在简历配置 / 岗位台账间切换正常
  - Codex 复核：typecheck 0 error、selftest 30/30、build 成功（29 modules transformed）；受当前本地地址访问策略限制，未独立重复浏览器交互自测
- 验收对照（task-cards Task 2）：
  - 无数据时显示空状态 ✓
  - 有数据时显示列表 ✓
  - 新建按钮可进入主战场 ✓
  - 点击列表项可进入对应岗位 ✓
- 范围合规：未做筛选、未做统计、未做看板；主战场仅为占位空壳，未做 Task 3 的录入与保存
- 是否涉及 decision-log 更新：否。未改产品边界、数据核心字段、状态枚举，未引入新依赖；无路由视图切换与 DEC-012 一致
- 遗留风险：
  1. 当前导航壳为无路由的视图状态切换，后续若需深链接 / 刷新保持视图，需复审是否引入 vue-router（DEC-012 后续复审项）
  2. 主战场为占位空壳，Task 3 落地前无法通过 UI 真正创建并保存岗位
- 用户确认记录：2026-06-12，用户确认 Task 2 通过
- 是否允许进入下一步：否。Task 2 随本次提交完成；Task 3 仍需用户另行明确启动
- 建议 commit message：feat: 实现岗位台账列表空壳与主战场导航壳

---

### 2026-06-12 · Step 3 · 岗位主战场基础信息 + 保存

- 状态：已完成（CC 已完成实现，Codex 已审查通过，用户已确认）
- 执行者：CC
- 审查者：Codex（已审查通过）
- 用户确认：已确认
- 改动文件：
  - 修改 src/pages/BattlefieldPage.vue（由占位空壳改为 5 字段表单 + 保存，打通创建/更新闭环）
  - 修改 src/App.vue（为 BattlefieldPage 增加 @saved 事件，保存后返回台账列表）
- 实现内容：
  - 复用 Step 0 的 JobStore.createJob / getJob / updateJob，未新增数据实体、未改字段、未改状态枚举
  - 5 个基础字段可录入：公司名、岗位名、城市、薪资范围、岗位 JD
  - 新建模式（jobId 为 null）：保存调用 createJob 落库；编辑模式（带 jobId）：onMounted 用 getJob 回显，保存调用 updateJob 原地更新
  - 保存后通过 @saved 返回台账列表，列表重新挂载并读取最新数据（保存后即可见）
  - 至少填写一个字段才允许保存（canSave 守卫），避免创建完全空白记录；另提供取消按钮返回
  - 编辑模式下岗位不存在时显示错误提示且不崩溃
  - 保存失败时在页面展示错误提示，不抛出未处理异常、不错误返回列表
- 自测命令：
  - npm run typecheck
  - npm run build
  - npm run selftest（回归，确认未影响 Step 0）
  - 浏览器自测（Vite dev + 真实交互）
- 自测结果：
  - typecheck：vue-tsc --noEmit，0 error
  - build：成功，构建产物正常
  - selftest：30 passed, 0 failed（无回归）
  - 浏览器自测：
    - 新建模式空表单时保存按钮禁用；填入 5 字段后保存 → 返回列表新增 1 行，localStorage 仅 1 个 job key（无重复），字段与 Step 0 默认值（report=null、parseStatus=none、contactStatus=not_contacted）正确
    - 刷新后记录仍在
    - 点击列表行进入编辑模式，5 字段正确回显（带真实 UUID）；改薪资后保存 → 仍为 1 个 job key（未重复创建），salaryRange 更新、updatedAt 大于 createdAt，列表对应行同步更新
  - Codex 复核（2026-06-14）：typecheck 0 error、selftest 30/30、build 成功；独立浏览器验证新建、列表回显、刷新持久化、编辑回显与原记录更新均通过
- 验收对照（task-cards Task 3）：
  - 能录入岗位信息 ✓
  - 保存后列表新增一条 ✓
  - 列表字段正确 ✓
  - 刷新后记录仍在 ✓
- 范围合规：未做 Prompt、未做 AI 结果、未做报告、未做 Boss 话术，符合 Task 3 禁止项
- 是否涉及 decision-log 更新：否。未改产品边界、数据核心字段、状态枚举，未引入新依赖
- 遗留风险：
  1. 编辑模式下若多个标签页并发编辑同一岗位，后保存者覆盖前者（v0.1 单人本地场景可接受）
  2. localStorage 配额溢出时无法完成保存，但页面会保留表单并展示错误提示
- 用户确认记录：2026-06-14，用户确认 Task 3 通过
- 是否允许进入下一步：Task 3 已提交并确认；Task 4 已执行
- 建议 commit message：feat: 实现岗位主战场基础信息录入与保存闭环

---

### 2026-06-12 · Step 4 · Prompt 生成 + 复制

- 状态：已完成（CC 已完成实现，Codex 已审查通过，用户已确认）
- 执行者：CC
- 审查者：Codex（已审查通过）
- 用户确认：已确认
- 改动文件：
  - 新增 src/app/prompt.ts（纯函数 buildAnalysisPrompt：由全局配置 + 岗位信息拼接结构化 Prompt，无副作用、不接 API）
  - 新增 src/app/clipboard.ts（copyText：优先 Clipboard API，失败回退 execCommand）
  - 修改 src/pages/BattlefieldPage.vue（加载全局配置、生成并展示 Prompt、一键复制、外部 AI 操作提示）
- 实现内容：
  - Prompt 由「求职者全局信息（9 字段）」+「目标岗位信息（5 字段）」+「10 项分析结构要求」拼接而成
  - 分析结构对齐 product.md §8：岗位类型 / 关键词 / 技术栈匹配 / 项目匹配 / 优势 / 风险 / 简历建议 / 面试清单 / 投递建议（四档）/ Boss 打招呼话术
  - 空字段以「（未填写）」兜底，布尔以「是 / 否」、求职重点以中文标签输出；按真实值拼接，无 {{}} 模板占位符
  - Prompt 随表单内容实时重算（computed）；提供只读文本框 + 一键复制按钮 + 复制反馈
  - 外部 AI 操作提示明确：本工具不接入任何 AI API（呼应 DEC-001），需手动粘贴到外部 AI 再贴回
  - 复制失败时提示「请手动选择文本复制」，只读文本框可手动选取兜底
- 自测命令：
  - npm run typecheck
  - npm run build
  - npm run selftest（回归，确认未影响 Step 0）
  - 浏览器自测（Vite dev + 真实交互）
- 自测结果：
  - typecheck：vue-tsc --noEmit，0 error
  - build：成功，构建产物正常
  - selftest：30 passed, 0 failed（无回归）
  - 浏览器自测：seed 全局配置 + 录入岗位后，生成的 Prompt 完整包含全部配置与岗位字段值、含 10 项分析结构、布尔映射正确（接受加班=是 / 接受外包=否）、无 {{ 或 }} 残留；一键复制按钮已接线、复制反馈路径正确
  - Codex 复核（2026-06-14）：typecheck 0 error、selftest 30/30、build 成功；Prompt 包含全局配置与岗位信息、无模板残留、表单修改后实时更新；剪贴板内容与 Prompt 完全一致
- 验收对照（task-cards Task 4）：
  - Prompt 包含全局配置和岗位信息 ✓
  - Prompt 无 `{{}}` 残留 ✓
  - 一键复制成功 ✓
  - 复制内容可直接粘贴到外部 AI ✓（复制源即只读文本框内容，已校验完整正确）
- 范围合规：未接 API、未做 AI 自动分析、未做 BYOK，符合 Task 4 禁止项
- 是否涉及 decision-log 更新：否。未改产品边界、数据核心字段、状态枚举，未引入新依赖
- 遗留风险：
  1. Prompt 由当前表单值实时生成，未持久化到 JobRecord.promptText（v0.1 可按需重生成，符合 DEC-004）
  2. 远程临时分支 `origin/feat/task-4-prompt-generation` 尚未删除，不影响 main 功能
- 用户确认记录：2026-06-14，用户确认 Task 3 和 Task 4 通过
- 是否允许进入下一步：否。Task 4 已提交并合并；Task 5 仍需用户另行明确启动
- 建议 commit message：feat: 实现岗位分析 Prompt 生成与一键复制

---

### 2026-06-14 · Step 5 · AI 结果兜底承接

- 状态：已完成（CC 已审查候选实现，Codex 已复核通过，用户已确认并提交）
- 执行者：CC / Codex（审查、低风险小修与验证工作区候选实现）
- 审查者：Codex（已审查通过）
- 用户确认：已确认（2026-06-15）
- 来源说明：进入 Task 5 时，src/pages/BattlefieldPage.vue 工作区（未提交）已包含一份 AI 结果承接候选实现（HEAD 不含）。按 Step 0 候选代码同样的纪律，CC 未盲用、未重写，而是审查 + 本地验证后采纳。
- 改动文件：
  - 修改 src/pages/BattlefieldPage.vue（新增「外部 AI 结果原文」承接区：粘贴框、原文保存、粘贴时间、parseStatus 标记、保存反馈）
- 实现内容（已逐条核对）：
  - 复用 Step 0 JobRecord 字段 aiRawResult / aiPastedAt / parseStatus，未新增实体、未改字段、未改状态枚举（符合 DEC-004）
  - 粘贴框：textarea 绑定 aiRawResult；仅编辑模式可录入，新建模式禁用并提示「请先保存岗位，再录入 AI 结果」
  - 保存：updateJob 写入 aiRawResult，aiPastedAt=Date.now()，parseStatus='unparsed'（原文已存、未结构化）
  - 保存反馈：「已保存 ✓（时间）」；再次进入显示「上次保存：时间」；解析状态显示「未解析（原文已保存）」
  - AI 区位于岗位基础信息 <form> 之外，保存按钮 type=button，不会触发岗位表单提交
  - 守卫 canSaveAiResult：jobId 非空且原文非空才可保存
- 合规审查（task-cards Task 5 禁止项）：
  - 不做复杂结构化解析 ✓（仅标记 unparsed，不拆字段）
  - 不因解析失败阻断 ✓（无解析步骤，任意文本直接保存）
  - 不丢原文 ✓（完整保存 aiRawResult）
  - 未做报告展示 / Boss 话术（属 Task 6）✓
- 自测命令：
  - npm run typecheck
  - npm run build
  - npm run selftest（回归，确认未影响 Step 0）
  - 浏览器自测（Vite dev + 真实交互）
- 自测结果：
  - typecheck：vue-tsc --noEmit，0 error
  - build：成功，31 modules transformed
  - selftest：30 passed, 0 failed（无回归）
  - Codex 浏览器复核：Markdown、JSON 代码块和中文混合原文保存成功；刷新并重新进入岗位后 94 个字符逐字一致；保存反馈、粘贴时间与“未解析（原文已保存）”状态正确
- 验收对照（task-cards Task 5）：
  - 任意格式文本都能保存 ✓
  - 刷新后原文仍在 ✓
  - 解析失败不报错 ✓
  - 有已保存反馈 ✓
- 是否涉及 decision-log 更新：否。未改产品边界、数据核心字段、状态枚举，未引入新依赖
- 遗留风险：
  1. canSaveAiResult 要求原文非空，故无法保存「空原文」以清除已承接结果；v0.1 场景可接受
  2. localStorage 配额耗尽时保存会失败；页面会保留输入并显示错误，v0.1 不扩展存储策略
- 用户确认记录：2026-06-15，用户确认 Task 5 通过
- 提交记录：已于 commit 0da6ee0 提交
- 是否允许进入下一步：Task 5 已确认并提交；Task 6 已执行
- 建议 commit message：feat: 实现外部 AI 结果原文兜底承接

---

### 2026-06-14 · Step 6 · 报告展示 + Boss 话术编辑

- 状态：已完成（CC 已完成实现，Codex 已审查通过，用户已确认）
- 执行者：CC
- 审查者：Codex（已审查通过）
- 用户确认：已确认（2026-06-15）
- 改动文件：
  - 修改 src/pages/BattlefieldPage.vue（新增「分析报告」区：报告原文兜底展示 + 复制报告；「Boss 打招呼话术」区：可编辑 + 保存 + 复制）
- 实现内容：
  - 复用 Step 0 JobRecord.report（JobReport）与 aiRawResult，未新增实体、未改字段、未改状态枚举（符合 DEC-004）
  - 报告展示：v0.1 不自动结构化解析，直接以只读文本框展示 AI 原文（aiRawResult）；无原文时显示空状态提示，区域不空白
  - 复制报告：复制 AI 原文；无原文时按钮禁用
  - Boss 话术编辑：textarea 绑定 greeting，初值取 report.greetingMessage；保存写入 report（缺失字段以 emptyReport 兜底，仅更新 greetingMessage，不动其他报告字段与 parseStatus）
  - 复制话术：复制当前话术文本
  - 报告 / 话术区仅编辑模式（已保存岗位）显示
- 合规审查（task-cards Task 6 禁止项）：
  - 不做完整评分系统 ✓（不渲染 / 不编辑 applyAdvice、techStackMatch 等结构化评分字段）
  - 不做多版本话术 UI ✓（单一话术 textarea）
  - 不做风险标签系统 ✓
- 自测命令：
  - npm run typecheck
  - npm run build
  - npm run selftest（回归，确认未影响 Step 0）
  - 浏览器自测（Vite dev + 真实交互）
- 自测结果：
  - typecheck：vue-tsc --noEmit，0 error
  - build：成功，31 modules transformed
  - selftest：30 passed, 0 failed（无回归）
  - 浏览器自测：有原文岗位 → 报告区只读展示原文、可读；编辑话术（含 emoji）保存 → report.greetingMessage 持久化、其余报告字段保持空、parseStatus 不变；刷新后话术回显；无原文岗位 → 报告区显示空状态提示（不空白）、复制报告按钮禁用
- 验收对照（task-cards Task 6）：
  - 报告区域不空白 ✓
  - 原文可读 ✓
  - 话术可编辑 ✓
  - 话术可复制 ✓
  - 报告可复制 ✓
  - 编辑后话术可保存 ✓
  - 话术保存后刷新仍在 ✓
- 是否涉及 decision-log 更新：否。未改产品边界、数据核心字段、状态枚举，未引入新依赖
- Codex 复核：2026-06-15，报告与话术剪贴板内容均已在浏览器验证；话术保存后刷新完整回显，AI 原文与 parseStatus 未受影响
- 遗留风险：
  1. v0.1 不自动结构化解析，报告其余字段（jobType / keywords / applyAdvice 等）暂不在 UI 编辑，仅保留话术编辑，符合「结构化尽力、话术可手改」
- 用户确认记录：2026-06-15，用户确认 Task 6 通过
- 提交记录：已于 commit 04890cc 提交
- 是否允许进入下一步：Task 6 已确认并提交；Task 7 已执行
- 建议 commit message：feat: 实现分析报告原文展示与 Boss 话术编辑复制

---

### 2026-06-15 · Step 7 · 沟通状态流转

- 状态：已完成（CC 已完成实现，Codex 已审查通过，用户已确认）
- 执行者：CC
- 审查者：Codex（已审查通过）
- 用户确认：已确认（2026-06-15）
- 改动文件：
  - 新增 src/app/labels.ts（沟通状态标签 / 选项的单一信源，顺序对应 DEC-003）
  - 修改 src/pages/JobListPage.vue（改用共享 CONTACT_STATUS_LABELS，移除本地重复标签表）
  - 修改 src/pages/BattlefieldPage.vue（新增「沟通状态」区：6 态 chip 切换、即时持久化、当前状态 + 更新时间显示）
- 实现内容：
  - 复用 Step 0 JobRecord.contactStatus / contactStatusUpdatedAt，未新增实体、未改字段、未改状态枚举（DEC-003 / DEC-004）
  - 6 态来自共享 CONTACT_STATUS_OPTIONS：未沟通 / 已打招呼 / 已回复 / 已约面 / 已拒绝 / 已结束
  - 点击任一状态 chip 即调用 updateJob 写入 contactStatus + contactStatusUpdatedAt=Date.now()，立即持久化；失败则回滚选择并提示
  - 显示「当前：状态（更新于 时间）」；状态区仅编辑模式显示
  - 列表页沟通状态标签改用同一信源，保证列表与主战场显示一致
- 合规审查（task-cards Task 7 禁止项）：
  - 不做自动状态推进 ✓（仅手动点击切换）
  - 不做提醒 ✓
  - 不做强制流程校验 ✓（任意状态间可自由切换，无顺序约束）
- 自测命令：
  - npm run typecheck
  - npm run build
  - npm run selftest（回归，确认未影响 Step 0）
  - 浏览器自测（Vite dev + 真实交互）
- 自测结果：
  - typecheck：vue-tsc --noEmit，0 error
  - build：成功，32 modules transformed
  - selftest：30 passed, 0 failed（无回归）
  - 浏览器自测：列表沟通状态标签正常（共享信源重构无回归）；主战场 6 chip 渲染、当前态高亮；切换 未沟通→已约面→已拒绝 均即时写入 contactStatus 与 contactStatusUpdatedAt；返回列表即同步显示新状态；刷新后列表与主战场均正确回显「已拒绝」(rejected)
- 验收对照（task-cards Task 7）：
  - 可任意切换状态 ✓
  - 状态持久化 ✓
  - 刷新后仍正确 ✓
- 是否涉及 decision-log 更新：否。未改产品边界、数据核心字段、状态枚举，未引入新依赖；新增 labels.ts 仅为既有 6 态标签的单一信源收敛
- Codex 复核：2026-06-15，六态完整渲染；可从「未沟通」直接切到「已结束」，再逆向切到「已打招呼」；列表即时同步，刷新后列表与详情均正确回显；状态切换同时更新 contactStatusUpdatedAt 与 updatedAt
- 遗留风险：
  1. 状态切换即时写入、无撤销；v0.1 单人本地场景可接受
- 用户确认记录：2026-06-15，用户确认 Task 7 通过
- 提交记录：已于 commit 08e9aee 提交
- 是否允许进入下一步：Task 7 已确认并提交；Task 8 已执行
- 建议 commit message：feat: 实现岗位沟通状态切换与持久化

---

### 2026-06-15 · Step 8 · 回看闭环 + 文案收口

- 状态：已完成（CC 已完成实现，Codex 已审查通过并补齐低风险文案，用户已确认）
- 执行者：CC / Codex
- 审查者：Codex（已审查通过）
- 用户确认：已确认（2026-06-15）
- 改动文件：
  - 修改 src/App.vue（顶部新增产品定位 tagline：Manual Mode（手动模式）· 本地求职手账 · 不接入 AI API，分析交给你选的外部 AI）
  - 修改 src/pages/JobListPage.vue（空状态文案收口：说明不接入 AI / 不自动分析 + 5 步手动流程）
- 实现内容：
  - 回看闭环：列表点击进入主战场 → 全字段回显（公司/岗位/城市/薪资/JD、沟通状态、AI 原文、报告原文、Boss 话术）；该闭环在 Task 2 - Task 7 已逐步打通，本步做端到端验证与文案收口，未改动数据与既有交互逻辑
  - 文案收口：全局 tagline 明确提示「Manual Mode（手动模式）」与「不接入 AI API」；空状态用「整理工具 + 5 步手动流程」帮助普通用户建立正确认知，避免「自动 AI 分析」误解
  - 外部 AI 操作提示已在主战场 Prompt 区与 AI 原文区（Task 4 / Task 5）就位，本步与之呼应
  - 未新增实体、未改字段、未改状态枚举、未引入依赖
- 合规审查：
  - 回看与文案收口，无新功能、不接 API、不做自动分析 ✓
- 自测命令：
  - npm run typecheck
  - npm run build
  - npm run selftest（回归，确认未影响 Step 0）
  - 浏览器自测（Vite dev + 真实交互）
- 自测结果：
  - typecheck：vue-tsc --noEmit，0 error
  - build：成功，32 modules transformed
  - selftest：30 passed, 0 failed（无回归）
  - 浏览器自测：顶部 tagline 含「不接入 AI API」；空状态含「不接入 AI、不自动分析」+ 5 步流程；seed 完整岗位（基础信息 + AI 原文 + 报告话术 + 已约面状态）后从列表点击回看，主战场完整回显全部字段、报告原文只读可读、话术回显、状态高亮「已约面」
- 验收对照（task-cards Task 8）：
  - 能从列表回看完整岗位 ✓
  - 能找到报告和话术 ✓
  - 文案明确说明不接 API ✓
  - 普通用户能理解这是整理工具 ✓
- acceptance.md Step 8 对照：
  - 列表项可进入详情 ✓
  - 详情能回显基础信息、AI 原文、报告、Boss 话术和沟通状态 ✓
  - 文案明确说明这是 Manual Mode ✓
  - 文案不误导用户以为工具会自动 AI 分析 ✓
- 是否涉及 decision-log 更新：否。未改产品边界、数据核心字段、状态枚举，未引入新依赖
- 遗留风险：
  1. 截图工具在预览沙箱多次超时，本步与既往任务均以 DOM 断言完成验证（证据充分），不影响功能结论
  2. matchScore 字段在列表展示但主战场未提供编辑入口（v0.1 不自动结构化解析，留待后续版本）
- Codex 复核：2026-06-15，从列表进入岗位后，基础信息、AI 原文、报告、Boss 话术和沟通状态均完整回显；页面明确显示 Manual Mode、不接入 AI API 和不自动分析
- 用户确认记录：2026-06-15，用户确认 Task 8 通过
- 是否允许进入下一步：v0.1 P0（Step 0 - Step 8）已全部完成；不自动进入 P1，需用户另行决定
- 建议 commit message：feat: 补齐回看闭环验证与产品认知文案收口

---

### 2026-06-16 · 封版 · v0.1.0

- 状态：已完成（v0.1.0 封版收尾，未进入 P1）
- 执行者：CC
- 用户确认：用户已确认 Task 8；本次为封版收尾，按用户指令执行
- 改动文件：
  - 修改 README.md（项目定位 / Manual Mode 不接 API / 核心闭环 / 本地运行 / v0.1.0 功能清单 / 能力边界 / Release Notes 指引）
  - 新增 docs/release/v0.1.0.md（核心能力、质量基线、已知限制、P1 方向）
- 封版动作：
  - 提交 README + release note（commit b7e23d9）
  - 创建并推送附注 tag v0.1.0（信息：P0 manual-mode closed loop completed），指向 b7e23d9
  - 推送 main 到 origin（a56092a..b7e23d9）
  - 清理远程临时分支：origin/feat/task-4-prompt-generation 已不存在（远端早前已删），本地以 git remote prune 清理陈旧跟踪引用；当前远端仅 main
- 质量基线（封版复核）：
  - typecheck：vue-tsc --noEmit，0 error
  - build：成功
  - selftest：30 passed, 0 failed
  - working tree clean
- 剪贴板复核：真实代码路径正确（secure context + Clipboard API + execCommand 回退）；预览沙箱 clipboard-write 权限为 denied、且无已连接的真实 Chrome，故实际写入未能在自动化环境验证，建议用户在真实 localhost 浏览器点一次「复制 Prompt / 复制话术」确认
- 是否涉及 decision-log 更新：否。封版收尾，未改产品边界、数据核心字段、状态枚举，未引入新依赖
- 是否允许进入下一步：否。是否进入 P1（数据导入导出 / Prompt 模板配置 / 简单统计）由用户另行决定
- 建议 commit message：docs: 记录 v0.1.0 封版收尾

---

### 2026-06-16 · v0.1.1 · 匹配度自动提取 + 手填兜底（修复列表匹配度永远为空）

- 状态：待审查（CC 已完成实现并本地验证，待 Codex 审查与用户确认）
- 执行者：CC
- 审查者：Codex（待审查）
- 用户确认：未确认（用户要求：匹配度必须显示、单值不可为区间、且应从 AI 原文自动提取而非手填）
- 背景 / 问题：
  - 用户反馈岗位台账「匹配度」列恒为「—」。排查确认：matchScore 字段存在且列表渲染正确，但 v0.1 全程无任何 UI 往 matchScore 写值，导致该列恒空。属能力缺口 + UX 不一致，非渲染 bug。
  - 用户进一步明确：匹配度应直接从外部 AI 结果原文自动提取（不愿手填），并对此拍板 → 见 DEC-014。
- 改动文件：
  - 新增 src/app/matchScore.ts（normalizeMatchScore 区间取中位归一化；extractMatchScore 从 AI 原文尽力提取综合匹配度）
  - 修改 src/app/prompt.ts（Prompt 增加「综合匹配度：XX%」单行输出要求，提升提取可靠性）
  - 修改 src/pages/BattlefieldPage.vue（保存 AI 原文时自动提取匹配度并写入；保留「匹配度」手填输入作覆盖/兜底 + 实时归一化预览）
- 实现内容：
  - 复用既有 JobRecord.matchScore 字段，未新增实体 / 字段 / 状态枚举，未引入新依赖
  - 自动提取（主路径）：保存 AI 原文时优先取「综合匹配度」行、其次含「匹配度」且带数字的行，归一化为单值后写入 matchScore；提取不到则不动用户已填值（no-clobber），并在 AI 区显示「已自动提取综合匹配度：X」
  - 手填（兜底/覆盖）：主战场「匹配度」输入框 + 实时预览「当前将保存为：X」+ 保存
  - 强制单值：区间（70%-80%、70~80、80%-70%）取前两数字中位四舍五入为整数；单值「85%/85」→「85%」；无数字原样保留；空→空
  - 仅编辑模式（已保存岗位）可录入
- 缺陷修复：
  - 手填初版保存后「已保存 ✓」反馈不显示：saveMatchScore 归一化改写 matchScore 触发 watch 把 done 重置为 idle。改用 @input 重置反馈（程序化改写不触发 input 事件）
- 自测命令：
  - npm run typecheck / npm run build / npm run selftest / 浏览器自测（Vite dev + 真实交互）
- 自测结果：
  - typecheck：0 error；build：成功；selftest：30 passed, 0 failed（无回归）
  - 浏览器自测（自动提取）：粘贴用户真实 AI 报告（含「综合匹配度：78% - 85%」）保存 → 自动提取 → 归一化 82%（正确优先于「项目匹配度 80%」），填入匹配度并列表显示 82%，刷新后持久；提示语「已自动提取综合匹配度：82%」正确
  - 浏览器自测（no-clobber）：再保存一段无匹配度文本 → matchScore 保持 82% 不被清空，无误报提取提示
  - 浏览器自测（手填归一化）：85%→85%、85→85%、70-85→78%、70%~80%→75%、80%-70%→75%、中等偏上→原样、空→空；保存反馈「已保存 ✓」正常
  - Prompt 已含「综合匹配度：XX%」输出要求
- 是否涉及 decision-log 更新：是。新增 DEC-014（v0.1.1 允许从 AI 原文尽力自动提取单个综合匹配度字段，单字段/可失败/手填兜底；同步改进 Prompt）。该口径软化了 Task 5「不做复杂结构化解析」，但仍属 product §9「结构化尽力」范围，由用户拍板
- 遗留风险：
  1. 提取/归一化取前两个数字，遇到「70-80-90」等异常多段只取前两段中位（极端边界，可接受）
  2. 自动提取依赖原文中出现「综合匹配度/匹配度 + 数字」；若 AI 完全不给匹配度，则需手填（已保留入口）
  3. v0.1.0 release note 仍记「matchScore 无编辑入口」为已知限制；该限制已在 v0.1.1 解决，若打 v0.1.1 tag 需同步 release note
- 是否允许进入下一步：否。待用户确认；是否打 v0.1.1 tag 由用户决定
- 建议 commit message：feat: AI 原文自动提取综合匹配度并支持手填兜底，修复列表匹配度恒空

---

### 2026-06-17 · 品牌重命名 · OfferFlow / Offer来了

- 状态：已完成（Codex 按用户明确指令执行，已本地验证）
- 执行者：Codex
- 用户确认：待确认
- 背景 / 目标：
  - 用户明确要求将项目品牌统一改为 OfferFlow / Offer来了。
  - 同步检查 package、README、docs、页面文案、构建配置、scripts 与 storage namespace。
  - localStorage namespace 改名时必须兼容历史本地数据，不得让旧数据直接不可见。
- 改动文件：
  - 修改 package.json、package-lock.json、index.html、vite.config.ts、.claude/launch.json
  - 修改 README.md、CLAUDE.md、AGENTS.md、docs/**
  - 修改 src/App.vue、src/pages/JobListPage.vue、src/app/stores.ts
  - 修改 src/storage/configStore.ts、driver.ts、index.ts、jobStore.ts、keys.ts、types.ts
  - 新增 src/storage/migration.ts
  - 修改 scripts/storage.selftest.ts
- 实现内容：
  - 英文品牌统一为 OfferFlow，中文品牌统一为 Offer来了。
  - package name 统一为 offerflow；仓库建议名记录为 offer-flow。
  - storage 当前 namespace 改为 `offerflow:`，并新增初始化迁移逻辑。
  - 迁移逻辑：初始化 stores 时扫描旧 namespace key；若对应新 key 不存在则复制；旧 key 保留不删除。
  - selftest 新增 legacy namespace 迁移覆盖：profile / job 复制到新 key，且旧 key 保留。
- 自测命令：
  - npm.cmd run typecheck
  - npm.cmd run selftest
  - npm.cmd run build
  - 旧品牌名正则搜索
- 自测结果：
  - typecheck：通过，vue-tsc --noEmit 0 error
  - selftest：34 passed, 0 failed
  - build：通过，34 modules transformed
  - 旧名称搜索：仅 `src/storage/keys.ts` 的 legacy namespace 常量保留，用于兼容迁移
- 是否涉及 decision-log 更新：是。新增 DEC-015，记录品牌重命名与 storage namespace 兼容迁移策略。
- 是否越界：
  - 未接 API / BYOK / 后端
  - 未引入 router / Pinia / UI 库 / 测试框架
  - 未改数据模型字段
  - 未改业务流程
  - 未改沟通状态枚举
- 遗留风险：
  1. 旧 key 仅复制不删除，浏览器 localStorage 会短期同时存在新旧 key；这是为避免破坏性操作而刻意保留。
  2. 真实远端仓库名、tag、GitHub 页面若需要同步为 offer-flow，需在仓库托管平台另行执行。
- 是否允许进入下一步：否。品牌重命名完成后停下，等待用户确认。
- 建议 commit message：chore: 统一品牌命名为 OfferFlow 并兼容迁移 storage namespace

---

### 2026-06-18 · v0.2.0 · Task 0 收口 v0.1.1 / 同步 origin

- 状态：已完成
- 执行者：CC
- 用户确认：已确认（用户授权硬同步到 origin/main 并亲自执行 reset）
- 背景 / 问题：
  - 进入 v0.2.0 时，本地 HEAD 停在 da68e4f（v0.1.1 匹配度自动提取），落后 origin/main 一个提交 c00a6c4（品牌重命名）。
  - 工作区有大量未提交改动，经严格核验（git diff origin/main + git hash-object 比对）确认其内容与 origin/main（c00a6c4）逐字节一致，无任何本地独占信息；migration.ts blob 哈希两边均为 50c62e3。
  - 成因推断：c00a6c4 已提交并推送，本地随后 reset 使 HEAD 退回，改名内容以未提交形态留在工作区。
- 处理：
  - 用户确认采用「硬同步到 origin/main」；环境拦截了 git reset --hard，由用户在本地终端亲自执行 `git reset --hard origin/main`。
  - 同步后 HEAD = c00a6c4，与 origin/main 对齐，工作区干净。
- 质量门槛（同步前在等价工作区验证）：
  - typecheck：vue-tsc --noEmit，0 error
  - selftest：34 passed, 0 failed
  - build：成功，34 modules transformed
- v0.1.1 状态确认：da68e4f「AI 原文自动提取综合匹配度」已提交且已在 origin/main，v0.1.1 实现已落库，无需再次提交。
- 是否涉及 decision-log 更新：否（本任务仅同步 git 状态，未改决策）。
- 是否允许进入下一步：是，Task 1 已随后执行。
- 建议 commit message：无（仅 git 状态同步，无文件改动）

---

### 2026-06-18 · v0.2.0 · Task 1 新增 DEC-016 / DEC-017 + v0.2.0 需求文档

- 状态：待用户确认（CC 已完成文档，未写任何业务代码）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 进入 v0.2.0 One-Shot Opportunity Radar；需先办「施工许可证」：补齐决策与需求文档，再开工写代码。
  - v0.2.0 会突破两个旧边界：单字段提取 → 固定 JSON 结构化解析；原生 UI → 引入 Naive UI。
- 改动文件：
  - 修改 docs/v0.1/decision-log.md（新增 DEC-016 固定 JSON 解析、DEC-017 引入 Naive UI）
  - 新增 docs/v0.2/requirements.md（v0.2.0 需求与边界唯一信源）
  - 修改 docs/v0.1/progress.md（更新当前项目状态 + 本条记录）
- 关键决策与编号修正：
  - 原始开工指令把两项新决策标注为 DEC-015 / DEC-016，但 DEC-015 已被「品牌重命名」占用（c00a6c4），故顺延为 DEC-016（JSON 解析）/ DEC-017（Naive UI）。该编号修正已在 requirements.md §11 与本条记录中标注。
- 文档验收对照（task 设定）：
  - 文档明确 v0.2.0 不接 API ✓（requirements §2.2、DEC-016）
  - 文档明确允许固定 JSON 解析 ✓（DEC-016、requirements §5）
  - 文档明确允许 Naive UI ✓（DEC-017、requirements §7.1）
  - 文档明确不引入后端 / router / 状态管理 / 图表库 ✓（requirements §2.2、DEC-017 约束）
- 范围合规：本任务仅写文档，未写业务代码、未改 storage / prompt / parser、未引入依赖。
- 是否涉及 decision-log 更新：是。新增 DEC-016、DEC-017，均标记已拍板（用户在本轮明确拍板 v0.2.0 两项边界放开）。
- 遗留风险：
  1. DEC-016 / DEC-017 内的「相关文档」「影响范围」引用的代码文件（offerFlowJson.ts、opportunityScore.ts、companyLabels.ts、OpportunityRadarChart.vue 等）尚未创建，将在 Task 2 - Task 10 落地。
  2. 决策日志仍位于 docs/v0.1/ 路径（作为跨版本连续日志），v0.2.0 文档新建于 docs/v0.2/；如需统一可后续评估，本版不动。
- 是否允许进入下一步：否。等待用户确认 Task 1 后，方可进入 Task 2（引入 Naive UI 基础壳）。
- 建议 commit message：docs: 新增 v0.2.0 机会雷达需求与 DEC-016 / DEC-017 决策
