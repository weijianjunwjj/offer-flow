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

> v0.4 开工中（本地服务化与 SQLite 数据文件化）；v0.3 已作为当前功能基线，v0.4 只改本地存储底座，不扩展 AI API / BYOK / 云同步 / 自动操作 Boss 等产品边界。

当前模式：

> Local-first Desktop-capable Mode（v0.4 允许引入本地运行时 / 本地服务 / SQLite 数据库文件；仍不接 AI API、不做 BYOK、不做云同步、不做账号登录、不自动操作 Boss、不做 SaaS）。

当前阶段：

> 用户于 2026-06-26 拍板 v0.4 进入“本地服务化与 SQLite 数据文件化”方向。当前分支为 `feature/v0.4-local-sqlite-storage`。T1 Tauri + SQLite 技术 Spike 已由用户验收并提交。T2 storage adapter 设计已由用户验收并提交。T3 SQLite schema 与基础 repository 实现已由用户验收并提交。T4 localStorage JSON 备份导出已由用户验收并提交。T5 localStorage -> SQLite 迁移已由用户验收并提交。T6 迁移校验强化与失败回滚测试已由用户验收并提交。T7 SQLite adapter 接入 ConfigStore / JobStore 已由用户验收并提交，commit 为 `dedfc29`。T8 受控切换 SQLite backend / 启动迁移入口设计已完成：新增 backend selection 状态机、runtime 检测、`offerflow:storage:backend` 明确标记、受控迁移入口、migration status Tauri command、selftest 和 T8 文档；本轮未自动迁移真实用户数据、未默认强制切 SQLite、未删除旧 localStorage、未改 Vue 页面、未 push。

当前是否允许进入下一步：

> 否。T8 实现完成后等待用户验收；建议验收通过后进入 T9：桌面模式最小 UI / 数据迁移确认入口。Codex 不自动提交 T8 改动、不 push。

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
- 提交记录：已于 commit 5d66866 提交

---

### 2026-06-18 · v0.2.0 · Task 2 引入 Naive UI 基础壳（视觉方向：浅色高级科技感）

- 状态：待用户确认（CC 已完成实现并浏览器验证；本次改动尚未提交，按用户指令暂不提交）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 进入 v0.2.0，先引入 Naive UI 作为唯一 UI 组件库（DEC-017），搭好 provider 与基础外壳，不动业务逻辑。
- 视觉方向调整（重要）：
  - 初版基础壳采用「深色科技感驾驶舱」方向；用户审阅后明确否决，确认 v0.2 UI 改为**浅色高级科技感**（干净、高级，类 Linear / Vercel / 飞书多维表格的清爽感），**放弃深色主题 / 暗黑驾驶舱**。
  - 据此修正：App.vue 不再使用 darkTheme，改用 Naive UI 默认浅色主题 + 少量 themeOverrides；全局底色 #f6f8fc、顶栏半透明白、内容区浅灰蓝、主色蓝/青蓝、文字深灰黑；保留克制的渐变品牌字（不荧光）。
  - 同步修正 docs/v0.2/requirements.md 中「深色科技感 / 决策驾驶舱」表述为「浅色高级科技感 / 机会决策工作台」。
- 改动文件：
  - 修改 src/App.vue（接入 n-config-provider 默认浅色主题 + themeOverrides、n-message-provider；n-layout / n-layout-header / n-layout-content 浅色外壳；导航按钮改 n-button）
  - 修改 package.json / package-lock.json（新增 naive-ui ^2.44.1）
  - 修改 docs/v0.2/requirements.md（视觉方向表述修正为浅色高级科技感）
- 合规审查（Task 2 约束）：
  - 仅安装 naive-ui，未引入图标库 / vue-router / 状态管理 / 图表库（符合 DEC-017）✓
  - 未改 storage / prompt / parser / 页面业务逻辑 ✓（仅 App 外壳与 provider）
- 自测命令：npm run typecheck / npm run selftest / npm run build / 浏览器自测（Vite dev + DOM 断言）
- 自测结果：
  - typecheck：vue-tsc --noEmit，0 error
  - selftest：34 passed, 0 failed（storage 无回归）
  - build：成功，2805 modules transformed（含 naive-ui）
  - 浏览器自测：body 背景为浅色（rgb(246,248,252) / #f6f8fc），文字深灰黑；顶栏半透明白；列表页与简历配置页可正常切换；console 无 error / warning
- 视觉 / 布局风险：
  1. 页面内部（ProfileConfigPage / JobListPage / BattlefieldPage）仍为 v0.1 各自 scoped 浅色样式，尚未统一到 Naive UI 浅色科技感；当前为浅色外壳 + 浅色旧页面，整体已无深浅冲突，但风格尚未完全统一，留待 Task 4 / 8 / 9 收敛。
  2. naive-ui 使 JS 产物从 ~90KB 增至 ~286KB（gzip ~91KB），属引入组件库的正常代价。
- 是否涉及 decision-log 更新：DEC-017 已涵盖「引入 Naive UI」；其背景描述仍含「深色科技感驾驶舱」字样，本次按用户指令仅修正 requirements.md 与 progress，未改 DEC-017 正文，待用户决定是否同步订正。
- 是否允许进入下一步：是。用户确认 Task 2 浅色方向；Task 2 正式成果已提交入库。
- 提交记录：commit message「feat: 引入 Naive UI 浅色基础壳」（仅含 Naive UI 依赖、浅色基础壳、requirements/decision-log/progress 视觉方向修正；不含 Task 2.5 spike 临时代码）
- 建议 commit message：feat: 引入 Naive UI 浅色基础壳

---

### 2026-06-18 · v0.2.0 · Task 2.5 v0.2 视觉样板 Spike（A/B 两套浅色高级科技感）

- 状态：待用户查看效果并拍板（CC 已完成实现并浏览器验证；按用户指令本次不提交）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 用户对 Task 2 浅色外壳「变浅了但还不够好看」不满意，暂停数据模型开发，插入视觉样板 Spike：先做出一张高质量「浅色高级科技感 / 机会决策工作台」样板，再决定是否继续使用 Naive UI。
- 实现内容（纯视觉 mock，不接业务）：
  - 新增 src/pages/spike/SpikeDashboard.vue（临时样板，mock 数据）。在 App 外壳新增临时入口「v0.2 样板」，并临时把默认 section 设为 spike，便于直接查看。
  - 样板含 6 个区：①顶部品牌区（OfferFlow · Offer来了 / One-Shot Opportunity Radar / 版本感 chips）②总览指标（机会分 82 环形 + 综合匹配度 78% + 公司规模 中厂 + 风险 中）③6 维机会雷达（自研 SVG 静态 mock）④公司画像（中厂 / 自研业务 / 苏州 / 通勤 45min + 稳定性/成长性/置信度标签 + 摘要）⑤岗位机会工作台（3 条 mock，卡片式行非普通 table，机会分主视觉 + 状态标签 + hover 上浮）⑥AI 承接卡（One-Shot Prompt 只读预览 + 复制；粘贴 AI 结果入口 + 保存并解析 + 已解析标签）。
  - 同页提供 A/B 切换：方案 A 保守版（规整克制、平面卡片、细边框）；方案 B 强视觉版（bento 布局 + 弱渐变 + 轻阴影 + 大数字主视觉，类 Linear / Vercel / 飞书多维表格 SaaS Dashboard）。默认展示 B。
- 合规：未改 storage / prompt / parser / 数据模型；未引入新依赖（继续用 naive-ui，仅多用 n-input / n-tag）；未引入 router / 状态管理 / 图表库 / 后端。
- 改动文件：
  - 新增 src/pages/spike/SpikeDashboard.vue（临时）
  - 修改 src/App.vue（临时入口 + 默认 section=spike，均带 TEMP 注释，定稿后移除）
  - 修改 docs/v0.1/progress.md（本条）
- 自测命令：npm run typecheck / npm run selftest / npm run build / 浏览器自测（DOM + 计算样式断言）
- 自测结果：
  - typecheck：0 error；selftest：34 passed, 0 failed；build：成功，2808 modules（CSS 17.6KB / JS 287KB，无新依赖）
  - 浏览器自测：样板 6 区全部渲染（机会分 82、匹配度 78%、雷达 SVG、公司画像、3 条岗位、AI 双卡）；A/B 切换生效（B 卡片含 18px 柔和阴影、A 为 flat 无阴影）；body 浅色 #f6f8fc；console 当前渲染无 error / warning（darkTheme 警告为历史 HMR 残留，最新 reload 后不再出现）
  - 注：preview_screenshot 在本沙箱失败 / 超时（与既往任务一致），以 DOM snapshot + getComputedStyle 断言完成验证
- 结论建议（详见汇报）：当前 Naive UI 可继续使用，不建议换框架；样板主体走自写 CSS + 少量 naive 组件即可达到浅色高级科技感。
- 是否允许进入下一步：是（视觉方向已拍板为方案 B）。
- 最终处置：按用户指令，spike 临时代码不提交进 main。src/App.vue 的 spike 临时接线（import / 默认 section / 临时入口 / 渲染分支）已回退为纯 Task 2；src/pages/spike/SpikeDashboard.vue 已移出工作区（git stash 保留）作为方案 B 视觉参照，待 Task 4 / 8 / 9 折入真实页面时取回。
- 建议 commit message：（不提交进 main）chore: 新增 v0.2 视觉样板 Spike（临时，A/B 浅色高级科技感）

---

### 2026-06-18 · v0.2.0 · Task 3 扩展数据类型与默认值

- 状态：待用户确认（CC 已完成实现并通过质量门槛；本次改动尚未提交）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 按 DEC-016 落地 v0.2 机会雷达数据模型：新增类型、扩展 JobRecord、补旧数据兼容默认值。仅动数据层，不动页面 UI / prompt / parser，不引入新依赖。
- 改动文件：
  - 修改 src/storage/types.ts（新增枚举 CompanySizeTier / StabilityLevel / GrowthPotential / RiskLevel；新增接口 CompanyInput / CompanyAssessment / OpportunityRadar / OpportunityAnalysis；JobRecord 新增 companyInput / companyAssessment / opportunityAnalysis 三字段。仅类型，无逻辑）
  - 新增 src/storage/defaults.ts（StoredJobRecord 旧形状类型；emptyCompanyInput() 工厂；withJobRecordDefaults() 读取时补齐 v0.2 字段，只补缺失、不覆盖、不抛错）
  - 修改 src/storage/jobStore.ts（createJob 写入 v0.2 默认值；getJob / listJobs 读取后经 withJobRecordDefaults 补齐）
  - 修改 src/storage/index.ts（导出 emptyCompanyInput / withJobRecordDefaults / StoredJobRecord）
  - 修改 scripts/storage.selftest.ts（新增「v0.2 defaults & backward compatibility」段，覆盖新建默认值、旧岗位读取补默认值不报错、部分 companyInput 合并）
- 合规审查（Task 3 约束）：
  - 不新增独立 CompanyRecord / OpportunityRecord / AnalysisHistory 实体（符合 DEC-004 / DEC-016，全部挂 JobRecord）✓
  - 未改页面 UI、未改 prompt / parser、未引入新依赖 ✓
  - 旧数据兼容：缺字段补默认值、不报错、不丢 v0.1 字段 ✓
- 自测命令：npm run typecheck / npm run selftest / npm run build
- 自测结果：
  - typecheck：vue-tsc --noEmit，0 error
  - selftest：46 passed, 0 failed（较上轮 34 增加 12 项 v0.2 用例：新建默认值 4、旧数据兼容 6、部分合并 2）
  - build：成功，2806 modules transformed
- 是否涉及 decision-log 更新：否。本任务实现 DEC-016 已批准的数据模型，未新增 / 推翻决策。
- 遗留风险：
  1. withJobRecordDefaults 仅做浅层字段补齐（companyInput 浅合并、assessment/analysis 整体兜底）；若未来 companyAssessment / opportunityAnalysis 内部结构再演进，需要更深的迁移策略，当前 v0.2 不需要。
  2. 数据层已就绪但暂无 UI 写入 companyInput（Task 4）与解析回填 assessment/analysis（Task 6/7）；在那之前新字段对用户不可见，属预期。
- 是否允许进入下一步：否。待用户确认 Task 3 后方可进入 Task 4。
- 建议 commit message：feat: 扩展 v0.2 机会雷达数据类型与旧数据默认值兼容
- 提交记录：已于 commit e6bd407 提交

---

### 2026-06-18 · v0.2.0 · Task 4 公司与机会补充表单

- 状态：待用户确认（CC 已完成实现，通过质量门槛 + 浏览器验证；本次改动尚未提交）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 在 BattlefieldPage 新增「公司与机会补充」区域，落地 Task 3 的 companyInput 字段录入；支持新建保存、编辑回显、旧岗位补默认值后保存。仅动该表单区，不改 prompt / parser，不做机会雷达展示，不引入新依赖，不折入 spike。
- 改动文件：
  - 新增 src/app/companyLabels.ts（公司规模档位中文标签 COMPANY_SIZE_LABELS + 下拉选项 COMPANY_SIZE_OPTIONS；稳定性/成长性/风险标签待 Task 8 按需补充）
  - 修改 src/pages/BattlefieldPage.vue（新增「公司与机会补充」表单区：sizeTier 用 n-select，其余 7 字段用 n-input/textarea；companyForm 状态、onMounted 回显、handleSave 持久化；canSave 纳入公司补充文本字段）
- 实现要点：
  - 8 字段：公司规模 sizeTier / 人员规模原文 staffRange / 公司类型 companyType / 融资阶段 financingStage / 通勤时间 commuteTime / 通勤方式 commuteWay / 公司备注 companyNote / 机会备注 opportunityNote
  - 新建保存：createJob 只收基础信息，公司补充随后 updateJob 写入（不改数据层接口，避免再动 storage）
  - 编辑 / 旧岗位：onMounted 用 Object.assign(companyForm, job.companyInput) 回显；旧岗位经 storage 读取已补默认值，sizeTier 兜底 unknown，打开不报错
  - 轻量 Naive UI 化：仅新增表单区使用 n-select / n-input，未重写 BattlefieldPage 其余部分；未折入 Task 2.5 spike（方案 B 仍仅作参考，留 stash）
- 合规审查（Task 4 约束）：
  - 未改 prompt / 未做 JSON parser / 未做机会雷达展示 ✓
  - 未折入 spike / 未引入新依赖 / 未做大规模页面视觉重构 ✓
- 自测命令：npm run typecheck / npm run selftest / npm run build / 浏览器验证（Vite dev）
- 自测结果：
  - typecheck：0 error；selftest：46 passed, 0 failed（数据层未动，无回归）；build：成功，2807 modules
  - 浏览器验证（dev 实跑，因 5173/5174 被占用改用 strictPort 5180 验证，验证后已还原 launch.json）：
    1. 新建岗位填公司 + 公司规模(中厂) + 人员规模 + 通勤时间 + 公司/机会备注 → 保存 → 返回列表出现新行 ✓
    2. 重新打开岗位，6 项字段全部正确回显（含 sizeTier=中厂（100-999））✓
    3. 刷新页面后再打开，字段仍完整存在 ✓
    4. 打开 seed 的旧岗位（无 v0.2 字段）不报错，公司补充区正常渲染、sizeTier 显示「未知 / 未填」✓
    5. 全流程 console 无 error / warning ✓
- 是否涉及 decision-log 更新：否。实现 DEC-016 已批准的字段录入，未新增 / 推翻决策。
- 遗留风险：
  1. 新建保存为 create + update 两次写入（为不改数据层接口刻意为之），单人本地场景可接受。
  2. companyInput 已可录入，但尚未进入 One-Shot Prompt（Task 5）与机会雷达展示（Task 8）。
- 是否允许进入下一步：否。待用户确认 Task 4 后方可进入 Task 5。
- 建议 commit message：feat: 主战场新增公司与机会补充表单
- 提交记录：已于 commit fc539d9 提交

---

### 2026-06-18 · v0.2.0 · Task 5 One-Shot Prompt 升级

- 状态：待用户确认（CC 已完成实现，通过质量门槛 + 浏览器验证；本次改动尚未提交）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 升级 buildAnalysisPrompt 为 One-Shot Prompt：输入纳入公司与机会补充 companyInput，要求外部 AI 一次性输出「Markdown 报告 + OFFER_FLOW_JSON 数据块」（DEC-016）。仅生成 Prompt 文本，不做 parser、不写结构化字段、不做雷达展示、不改 storage、不引入新依赖、不折入 spike。
- 改动文件：
  - 修改 src/app/prompt.ts（buildAnalysisPrompt 新增第三参 company: CompanyInput；新增【公司与机会补充】输入段；新增第二部分 OFFER_FLOW_JSON 输出要求 + 固定标记 + schema 示例 + 枚举允许值 + 7 条硬性要求；保留「综合匹配度：XX%」行以兼容 v0.1.1 文本提取）
  - 修改 src/pages/BattlefieldPage.vue（generatedPrompt 计算改为 buildAnalysisPrompt(profile, form, companyForm)）
- 实现要点：
  - JSON 固定标记 ---OFFER_FLOW_JSON_START--- / ---OFFER_FLOW_JSON_END---；schema 按 docs/v0.2/requirements.md（version/matchScore/companyAssessment/opportunityAnalysis）
  - 明确要求：未知信息标低置信度不乱猜；分数 0-100 整数；JSON 不含注释；枚举只用英文代码（sizeTier/stabilityLevel/growthPotential/confidence/applyAdvice/riskLevel）；字段结构稳定不增删键；version 固定 0.2.0
  - 示例 JSON 本身无注释；枚举允许值在 JSON 外用文字说明，避免在 JSON 里写注释
- 合规审查（Task 5 约束）：
  - 不做 parser / 不写结构化字段 / 不做雷达展示 / 不改 storage / 不折入 spike / 不引入新依赖 ✓
- 自测命令：npm run typecheck / npm run selftest / npm run build / 浏览器验证（Vite dev）
- 自测结果：
  - typecheck：0 error；selftest：46 passed, 0 failed（数据层未动）；build：成功，2807 modules
  - 浏览器验证（dev 实跑，端口 5180）：打开带 companyInput 的岗位（公司规模=中厂、通勤 45min、公司/机会备注）→ 生成 Prompt：
    1. Prompt 含「公司规模：中厂」「人员规模 100-499 人」「通勤时间：45min」「通勤方式」「公司备注」「机会备注」✓
    2. Prompt 含 ---OFFER_FLOW_JSON_START--- 与 ---OFFER_FLOW_JSON_END--- ✓
    3. 复制 Prompt：handler 正常执行（沙箱 clipboard 被拒显示「复制失败」，与 v0.1.0 封版记录一致，属环境限制非回归）
    4. 整页刷新 + 重新打开岗位：捕获 console.error / onerror / unhandledrejection 共 0 条，Prompt 正常渲染 ✓
  - 说明：编辑期 HMR 曾出现「Unhandled error during setup function」告警，经整页刷新复现确认为热更新瞬态（prompt.ts 与 BattlefieldPage 热更新错位导致 setup 瞬时重跑），全新加载下为 0 错误。
- 是否涉及 decision-log 更新：否。实现 DEC-016 已批准的 One-Shot Prompt 方向。
- 遗留风险：
  1. Prompt 已要求 JSON，但工具尚未解析（Task 6 写 parser，Task 7 接保存回填）；当前保存 AI 原文仍走 v0.1.1 文本提取「综合匹配度」。
  2. 复制功能需用户在真实 localhost 浏览器点一次确认（沙箱 clipboard 受限，非代码问题）。
- 是否允许进入下一步：否。待用户确认 Task 5 后方可进入 Task 6。
- 建议 commit message：feat: One-Shot Prompt 纳入公司补充并要求输出 OFFER_FLOW_JSON
- 提交记录：已于 commit 1a7c8d2 提交

---

### 2026-06-18 · v0.2.0 · Task 6 OFFER_FLOW_JSON 解析器

- 状态：待用户确认（CC 已完成实现并通过质量门槛 + 新增 parser selftest；本次改动尚未提交）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 实现纯解析工具：从 AI 原文「尽力」提取并解析固定 OFFER_FLOW_JSON 数据块（DEC-016）。只做工具，不接 BattlefieldPage、不写 JobRecord、不展示雷达、不改 AI 原文保存逻辑、不引入新依赖。
- 改动文件：
  - 新增 src/app/opportunityScore.ts（normalizeScore 归一 0-100 整数；calculateOpportunityScore 6 维加权；getOpportunityScoreLevel 等级文案）
  - 新增 src/app/offerFlowJson.ts（extractOfferFlowJson + parseOfferFlowJson + ParsedOfferFlowResult / OfferFlowJsonParseStatus）
  - 新增 scripts/offerFlowJson.selftest.ts（轻量自测，无测试框架）
  - 修改 package.json（selftest 串联运行 storage 与 parser 两个自测，质量门槛可覆盖；未引入新依赖）
- 实现要点：
  - extract：优先取 ---OFFER_FLOW_JSON_START--- / ---END--- 之间内容；找不到兜底取「最后一个」```json 代码块；都没有返回 null
  - parse：空/空白 → not_found；JSON.parse 失败 / 顶层非对象 → invalid_json；缺字段/非法枚举/缺分数 → partial；完整合法 → success；全程 try/catch，永不抛未捕获异常
  - 归一：所有分数经 normalizeScore 钳制到 0-100 整数；越界记软提示
  - 枚举非法/缺失 → sizeTier/stability/growth/risk 归 unknown，confidence 归 low，applyAdvice 置空，并记 warning（降级 partial）
  - opportunityScore：AI 未给/非法 → 按 6 维加权 calculateOpportunityScore 计算（软提示，不降级）
  - matchScore：顶层优先，缺失回退 opportunityRadar.matchScore，格式化为 "XX%"
  - bossGreeting 为空不伪造（保持空串，供 Task 7 no-clobber）
  - warnings：逐条说明缺字段 / 非法字段 / 归一化 / 回退 / 自动计算
- 合规审查（Task 6 约束）：
  - 纯工具，未接 BattlefieldPage、未写 JobRecord、未展示雷达、未改 AI 原文保存逻辑 ✓
  - 未引入新依赖；build 产物体积未变（401KB），印证 parser 尚未进入 app bundle ✓
- 自测命令：npm run typecheck / npm run selftest / npm run build
- 自测结果：
  - typecheck：0 error
  - selftest（storage）：46 passed, 0 failed
  - selftest（parser，新增 scripts/offerFlowJson.selftest.ts）：43 passed, 0 failed，覆盖标准解析成功 / json 代码块兜底 / not_found / invalid_json / partial / 分数越界归一 / 枚举非法归 unknown / 未给 opportunityScore 自动计算 / bossGreeting 空不伪造 / 顶层 matchScore 缺失回退
  - build：成功，2807 modules
- 是否涉及 decision-log 更新：否。实现 DEC-016 已批准的解析能力。
- 遗留风险：
  1. 解析器已就绪但尚未接入保存流程（Task 7 接 BattlefieldPage：保存 AI 原文时自动解析并回填 companyAssessment / opportunityAnalysis / matchScore / greeting，失败不清空）。
- 是否允许进入下一步：否。待用户确认 Task 6 后方可进入 Task 7。
- 建议 commit message：feat: 新增 OFFER_FLOW_JSON 解析器与机会分计算工具及自测
- 提交记录：已于 commit 14eba56 提交

---

### 2026-06-18 · v0.2.0 · Task 7 AI 原文保存时自动解析

- 状态：待用户确认（CC 已完成实现并通过质量门槛 + 浏览器 7 项验证；本次改动尚未提交）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 在 BattlefieldPage 保存 AI 原文时接入 extractOfferFlowJson / parseOfferFlowJson，解析成功回填 companyAssessment / opportunityAnalysis / matchScore / report.greetingMessage；原文必存、解析失败不阻断、各结构化字段 no-clobber、bossGreeting 空不覆盖。仅接入保存流程，不做雷达图 / 列表机会分展示，不折入 spike，不引入新依赖。
- 改动文件：
  - 修改 src/pages/BattlefieldPage.vue（导入 parser；新增 companyAssessment / opportunityAnalysis / jsonStatus / jsonWarnings 状态与 jsonStatusLabel；onMounted 回显结构化字段；重写 saveAiResult 接入解析与回填；模板新增 4 态解析反馈 + warnings 简短列表 + 文案更新；新增反馈样式）
- 实现要点：
  - 解析：parseOfferFlowJson(extractOfferFlowJson(raw) ?? '')；patch 始终含 aiRawResult + aiPastedAt（原文必存）
  - matchScore：优先 JSON.matchScore，其次 v0.1.1 extractMatchScore 文本兜底，都没有则不写（no-clobber）
  - 结构化：parsed.companyAssessment / opportunityAnalysis 非 null 才写入 patch，否则省略 → updateJob 合并保留旧值（no-clobber）
  - greeting：仅 bossGreeting 非空时写 report.greetingMessage，空则不覆盖已有话术
  - parseStatus：写入结构化 → 'parsed'，否则 'unparsed'
  - 反馈：success=已解析机会雷达 / not_found=JSON 未找到，已保存原文 / invalid_json=JSON 解析失败，已保存原文 / partial=字段不完整，已部分解析；warnings 取前 5 条简短展示
- 合规审查（Task 7 约束）：
  - 原文优先成功、解析失败不阻断 ✓；CA/OA/matchScore/greeting 均 no-clobber ✓；bossGreeting 空不覆盖 ✓
  - 不做雷达图 / 列表机会分展示 / 不折入 spike / 不引入新依赖 ✓
- 自测命令：npm run typecheck / npm run selftest / npm run build / 浏览器 7 项验证
- 自测结果：
  - typecheck：0 error（修一处 patch.report 可能为 null 的守卫）
  - selftest：storage 46 + parser 43，全 0 failed
  - build：成功，2807 modules（JS 407KB，parser 已进入 app bundle）
  - 浏览器验证（dev strictPort 5180，验证后已还原 launch.json）：
    1. 标准 OFFER_FLOW_JSON 保存 → matchScore 82% / companyAssessment medium / opportunityAnalysis 78 / 话术写入 / 状态「已解析机会雷达」✓
    2. 刷新后重开 → 结构化字段仍在，匹配度与话术回显 ✓
    3. 普通无 JSON 原文 → 状态「JSON 未找到，已保存原文」，原文已存，CA/OA/match/话术均未清空 ✓
    4. 非法 JSON（标记内坏 JSON）→ 状态「JSON 解析失败，已保存原文」，原文已存、不阻断，结构化字段保留 ✓
    5. bossGreeting 为空的 JSON → CA/OA 写入，已有话术「原有话术保留」未被覆盖 ✓
    6. partial（缺 companyAssessment）→ 状态「字段不完整，已部分解析」，opportunityAnalysis 更新、companyAssessment 保留、warnings 显示 ✓
    7. 全流程 console 无 error / warning ✓
- 是否涉及 decision-log 更新：否。实现 DEC-016 已批准的解析回填闭环。
- 遗留风险：
  1. 结构化字段已写入 storage，但主战场尚未展示机会雷达 / 公司画像（Task 8），列表也未展示机会分（Task 9）；当前仅通过解析状态文案与 localStorage 可见。
- 是否允许进入下一步：否。待用户确认 Task 7 后方可进入 Task 8。
- 建议 commit message：feat: 保存 AI 原文时自动解析 OFFER_FLOW_JSON 并回填（失败不清空）
- 提交记录：已于 commit e708749 提交

---

### 2026-06-18 · v0.2.0 · Task 8 机会雷达卡 + SVG 组件

- 状态：待用户确认（CC 已完成实现并通过质量门槛 + 浏览器 6 项验证；本次改动尚未提交）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 新增自研 SVG 雷达组件，在 BattlefieldPage 展示结构化结果（机会分 / 综合匹配度 / 公司画像 / 风险 / 投递建议 / 决策摘要 / 面试关注点 / 6 维雷达）。无结构化数据显示空状态。参考 stash 方案 B 视觉片段重建，不恢复整份 spike；不改 parser / prompt / storage，不做列表机会分展示，不引入新依赖。
- 改动文件：
  - 新增 src/components/OpportunityRadarChart.vue（原生 SVG，6 维 0-100，值域钳制，空/异常不报错）
  - 修改 src/app/companyLabels.ts（新增 LEVEL_LABELS 稳定性/成长性、RISK_LABELS、CONFIDENCE_LABELS、APPLY_ADVICE_LABELS）
  - 修改 src/pages/BattlefieldPage.vue（新增「机会雷达」section：机会分大数字 + 等级、综合匹配度、公司画像标签、风险/投递建议标签、决策摘要、面试关注点、SVG 雷达图；空状态文案；hasOpportunity / scoreLevel 计算；轻量卡片视觉）
- 实现要点：
  - 雷达图自研 SVG，6 轴（薪资/成长/匹配/风险可控/通勤/稳定），不引入 ECharts / Chart.js
  - 空状态：opportunityAnalysis 与 companyAssessment 均为 null 时显示「还没有机会雷达。粘贴 AI 分析结果后，这里会亮起来。」
  - 机会分等级用 getOpportunityScoreLevel；公司规模/稳定/成长/风险/置信度/投递建议用 companyLabels 标签
  - Boss 话术沿用既有「Boss 打招呼话术」可编辑/复制区（解析已回填），雷达卡内加文字指引，不重复编辑器
  - 视觉参考方案 B 片段（白卡 + 柔和阴影 + 渐变大数字 + 标签），未恢复 spike
- 合规审查（Task 8 约束）：
  - 雷达原生 SVG / 空状态 / 不改 parser·prompt·storage / 不做列表机会分 / 不折入 spike / 不引入新依赖 ✓
- 自测命令：npm run typecheck / npm run selftest / npm run build / 浏览器 6 项验证
- 自测结果：
  - typecheck：0 error；selftest：storage 46 + parser 43 全 0 failed；build：成功，2808 modules（JS 412KB）
  - 浏览器验证（dev strictPort 5180，验证后已还原 launch.json）：
    1. 打开有 opportunityAnalysis 的岗位 → 机会雷达卡正常展示（机会分 60 + 等级、公司画像标签、风险/投递建议）✓
    2. 6 维 SVG 雷达图正常（6 顶点 + 6 轴标签，分数 0-100）✓
    3. 决策摘要、面试关注点正常展示；Boss 话术在下方既有可编辑区展示 ✓
    4. 无 opportunityAnalysis 的旧岗位 → 空状态文案正常、不报错 ✓
    5. 刷新后重开 → 雷达卡仍正常 ✓
    6. console 无 error / warning ✓
- 是否涉及 decision-log 更新：否。雷达图自研 SVG，符合 DEC-016 / DEC-017 约束（不引图表库）。
- 遗留风险：
  1. 列表页尚未展示机会分 / 公司规模（Task 9）。
  2. 机会雷达卡为浅色基础卡片，整体页面其余部分仍为 v0.1 样式，视觉统一收口可在后续按需进行。
- 是否允许进入下一步：否。待用户确认 Task 8 后方可进入 Task 9。
- 建议 commit message：feat: 新增机会雷达 SVG 组件与主战场结构化结果展示
- 提交记录：已于 commit 515cc6b 提交

---

### 2026-06-18 · v0.2.0 · Task 9 列表页升级与筛选排序

- 状态：待用户确认（CC 已完成实现并通过质量门槛 + 浏览器 10 项验证；本次改动尚未提交）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 升级 JobListPage：新增公司规模 / 机会分列；新增城市 / 公司规模 / 沟通状态 / 机会分下限筛选；新增更新时间 / 机会分 / 匹配度排序。筛选排序仅影响前端展示，不改持久化数据。不改 parser / prompt / storage，不折入 spike，不引入新依赖。
- 改动文件：
  - 修改 src/pages/JobListPage.vue（filteredJobs 计算 + 5 个 n-select 筛选/排序 + 重置 + 结果计数 + 公司规模/机会分列 + 空筛选结果提示）
- 实现要点：
  - 机会分：opportunityAnalysis?.opportunityScore ?? null，null 显示 '-'
  - 公司规模：优先 companyAssessment.sizeTier，其次 companyInput.sizeTier，标签经 COMPANY_SIZE_LABELS（仍为 unknown 时显示「未知 / 未填」）
  - 筛选：城市（由现有岗位去重生成选项）、公司规模、沟通状态、机会分下限（不限/50/65/70/75/85+，无机会分的岗位在有下限时被排除）
  - 排序：更新时间 desc（默认）/ 机会分 desc / 匹配度 desc（无值排末尾，按 -1 处理）
  - 全部 filteredJobs 为 computed，基于已加载 jobs ref，未触碰 localStorage（不改持久化）
  - 轻量 Naive UI 化：仅筛选区用 n-select；表格沿用原生 table，未大重写
- 合规审查（Task 9 约束）：
  - 不改 parser / prompt / storage / 不折入 spike / 不引入新依赖 ✓；筛选排序不改持久化 ✓
- 自测命令：npm run typecheck / npm run selftest / npm run build / 浏览器 10 项验证
- 自测结果：
  - typecheck：0 error；selftest：storage 46 + parser 43 全 0 failed；build：成功，2808 modules（JS 415KB）
  - 浏览器验证（dev strictPort 5180，验证后已还原 launch.json；seed A/B/C/D 四岗：苏州中厂82 / 上海大中厂66 / 苏州小厂无分析 / 杭州大厂90）：
    1. 有 opportunityAnalysis 的岗位显示机会分（82/66/90）✓
    2. 无 opportunityAnalysis 的 C 岗机会分显示 '-' ✓
    3. 公司规模正常显示（中厂/大中厂/小厂/大厂；C 用 companyInput 兜底）✓
    4. 城市筛选 苏州 → A、C ✓
    5. 公司规模筛选 大中厂 → B ✓
    6. 沟通状态筛选 已约面 → D ✓
    7. 机会分 70+ → A、D（排除 66 与 无分析）✓
    8. 排序 机会分 / 匹配度 → D,A,B,C ✓；默认更新时间 → A,B,C,D ✓
    9. 点击岗位仍进入主战场 ✓
    10. console 无 error / warning ✓
- 是否涉及 decision-log 更新：否。
- 遗留风险：
  1. 列表与主战场视觉已部分浅色科技感化（n-select + 雷达卡），但整页视觉统一收口尚未做（非 v0.2 阻塞）。
- 是否允许进入下一步：否。待用户确认 Task 9 后方可进入 Task 10（文档与 release note）。
- 建议 commit message：feat: 列表页新增机会分与公司规模列及筛选排序
- 提交记录：已于 commit 1ff4654 提交

---

### 2026-06-18 · v0.2.0 · Task 10 文档与 release note

- 状态：待用户确认（CC 已完成文档，通过质量门槛；本次改动尚未提交。不写业务代码、不引入依赖）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 收口 v0.2.0 文档：更新 README、新增 v0.2.0 release note、更新 progress、核对 requirements 与 decision-log 口径，明确仍不接 API、Manual One-Shot Mode。
- 改动文件：
  - 修改 README.md（改写为 v0.2.0：One-Shot Opportunity Radar 定位、Manual One-Shot Mode 说明、新增能力、核心闭环、功能清单、能力边界、版本路线、Release Notes 链接；更新 selftest 说明为存储层 + 解析器）
  - 新增 docs/release/v0.2.0.md（概述、核心能力、数据模型增量、DEC-016/017、技术栈、质量基线、已知限制、升级兼容、下一步）
  - 修改 docs/v0.1/progress.md（当前状态 + 本条）
- 口径核对结果：
  - docs/v0.2/requirements.md：与最终实现一致（机会分等级、浅色 UI 风格、主战场卡片、列表字段/筛选/排序、文件清单 companyLabels/opportunityScore/offerFlowJson/OpportunityRadarChart 均匹配）。
  - decision-log DEC-016 / DEC-017：表述一致（DEC-016 固定 JSON 解析、仍不接 API；DEC-017 Naive UI 唯一组件库、浅色高级科技感、不引图标库/路由/状态管理/图表库）。
  - 历史文档（docs/release/v0.1.0.md、progress 早期条目）中的「30/30」「不自动结构化解析」「深色科技感」属 v0.1 / 决策演进的历史记录，刻意保留，不回改。
  - 两处 requirements 描述 vs 实现的轻微文案差异（非功能冲突，均为前序已确认）：
    1. requirements §7.2.4 写「保存并解析 AI 结果」按钮，实现沿用既有「保存 AI 原文」按钮（功能已含自动解析）。
    2. requirements §7.2.5 把 Boss 话术列在机会雷达卡内，实现保留在下方既有可编辑/复制区并在卡内加指引（Task 8 已与用户确认）。
- v0.2.0 不接 API 等边界已在 README「能力边界」「Manual One-Shot Mode」与 release note 概述中明确标注。
- 自测命令：npm run typecheck / npm run selftest / npm run build
- 自测结果：
  - typecheck：0 error；selftest：storage 46 + parser 43 全 0 failed；build：成功
- 是否涉及 decision-log 更新：否。文档收口，未改决策。
- 遗留风险：
  1. 整页视觉统一收口未做（已在 release note 已知限制标注）。
  2. 两处 requirements 文案差异如需完全对齐，可在后续小修中处理（功能无影响）。
- 是否允许进入下一步：用户在封版前插入 Task 9.5（视觉收口），故 Task 10 文档暂不单独提交，待 9.5 完成后统一提交。CC 不自行打 tag、不 push。
- 建议 commit message：docs: 更新 README 与新增 v0.2.0 release note
- 提交记录：暂未提交（按用户指令与 Task 9.5 一起收口后再提交）

---

### 2026-06-18 · v0.2.0 · Task 9.5 按方案 B 折入真实页面视觉

- 状态：待用户确认（CC 已完成实现，通过质量门槛 + 浏览器验证；本次改动尚未提交）
- 执行者：CC
- 用户确认：待确认
- 背景 / 目标：
  - 用户在 v0.2.0 封版前指出：Task 2.5 方案 B 仍停留在 spike，真实 UI 未按方案 B 收敛，不能封版。插入 Task 9.5：把 stash 中方案 B 的视觉语言折入真实页面（不恢复整份 spike、不提交 mock）。
- 改动文件：
  - 修改 src/App.vue（全局设计令牌 :root --of-* + 字体；品牌区精致化：渐变 logo 方块 + 版本 chip）
  - 修改 src/pages/JobListPage.vue（列表由原生 table 改为「机会资产池」卡片行：左机会分徽标 + 公司/岗位 + meta chips + 状态色标签 + hover 上浮；筛选区保留）
  - 修改 src/pages/BattlefieldPage.vue（各分区统一为白卡 + 轻阴影 + 圆角；区块标题加渐变小竖条；机会雷达卡加 hero 渐变背景；公司补充改为表单卡内子区；原生输入聚焦态/圆角清爽化）
  - 修改 src/pages/ProfileConfigPage.vue（表单卡片化 + 输入聚焦态统一）
  - 修改 README.md / docs/release/v0.2.0.md（同步把「视觉基础壳」收口表述更新为「真实页面浅色高级科技感收口」，移除「视觉收口未做」已知限制）
- 实现要点：
  - 只提取方案 B 的视觉语言（白卡 / 轻阴影 / 弱渐变 / 渐变大数字 / 标签 / hover 上浮 / 渐变竖条标题），未恢复 spike 文件、未提交 mock；spike 仍留在 stash@{0}
  - 以 CSS / 局部模板为主；列表表格→卡片为唯一结构性改动；BattlefieldPage 仅 CSS 改动，未动任何脚本逻辑
  - 复用现有 Naive UI 组件，未引入新 UI 框架 / 图标库 / 图表库 / router / 状态管理
  - 未改 storage / parser / prompt 核心逻辑，未改变 v0.2 已完成功能行为
- 合规审查（Task 9.5 约束）：全部满足（不恢复 spike、不提交 mock、不引入新依赖、不改核心逻辑、不大重构）✓
- 自测命令：npm run typecheck / npm run selftest / npm run build / 浏览器验证
- 自测结果：
  - typecheck：0 error；selftest：storage 46 + parser 43 全 0 failed；build：成功（仅 CSS 体积变化，JS 持平 ~416KB）
  - 浏览器验证（dev strictPort 5180，验证后已还原 launch.json；复用 A/B/C/D seed 数据）：
    1. 列表页为卡片式「机会资产池」（4 张 asset-card，原生 table 已移除，卡片圆角 14 + 阴影 + hover）✓
    2. 顶部品牌区精致化（渐变 logo + v0.2.0 chip）✓
    3. 主战场分区卡片化（form 卡片圆角 16 + 阴影），机会雷达卡有 hero 渐变背景 + 渐变大数字（score 82/88）+ SVG 主视觉 ✓
    4. 点击列表卡片仍进入主战场 ✓
    5. 机会分 70+ 筛选在卡片布局下仍正确（A、D）✓
    6. 保存 AI 原文 + 解析机会雷达不回归（粘贴标准 JSON → 状态「已解析机会雷达」、雷达卡 score 更新为 88、localStorage 持久化）✓
    7. console 无 error / warning ✓
- 是否涉及 decision-log 更新：否。DEC-017 已涵盖 Naive UI 与浅色高级科技感方向，本任务为其落地。
- 随 Task 9.5 修复（用户验收时两轮发现）：列表「公司规模」取值优先级错误。
  - 初版 Task 9：companyAssessment 优先 → AI 的 unknown 盖掉用户手填，显示「未知/未填」。
  - 第一次修复（错误）：改成「AI 确切值优先」→ 反向场景下 AI 旧值（如 small）盖掉用户新选（如 medium），仍不符预期。该次仅验了单向场景，是疏漏。
  - 最终修复（正确）：effectiveSizeTier 改为「用户手填 companyInput.sizeTier 最优先；仅当用户未填(unknown)时回退 AI 画像 companyAssessment.sizeTier；都没有才 unknown」。语义即「列表公司规模 = 表单里用户选的那个字段」。同一 helper 亦用于公司规模筛选。
  - 已浏览器验证 4 组场景全部正确：S1(手填小厂/AI未知→小厂)、S2(手填中厂/AI小厂→中厂)、S3(未填/AI大中厂→大中厂回退)、S4(未填/无AI→未知)。
- 遗留风险：
  1. 视觉为方案 B 的工程化落地，细节打磨（动效 / 暗色模式等）可后续按需进行，不在 v0.2.0 范围。
- 是否允许进入下一步：否。待用户确认 Task 9.5 后，统一提交 Task 9.5 + Task 10 文档；是否打 tag v0.2.0 由用户决定。
- 建议 commit message：feat: 将方案 B 浅色高级科技感视觉折入真实页面

---

### 2026-06-18 · v0.2.0 · 视觉基线拍板：方案 B

- 状态：已拍板（用户确认）
- 用户确认：2026-06-18，用户明确「我要方案 B」
- 决定：v0.2 视觉基线采用 Task 2.5 的**方案 B**（强视觉 / bento 布局 + 弱渐变 + 轻阴影 + 大数字主视觉，浅色高级科技感，类 Linear / Vercel / 飞书多维表格）；继续使用 Naive UI（自写 CSS 主导视觉 + Naive UI 提供交互组件），不换 UI 框架。
- 后续待办（待用户排序后执行）：
  1. 是否将 Task 2 + Task 2.5 改动提交；
  2. 是否把方案 B 的视觉语言（卡片 / 阴影 / 渐变 / 雷达 / 列表行）折入真实页面（与 Task 4 / 8 / 9 合流），并移除临时 spike 入口与默认跳转；
  3. 是否先回到 Task 3（扩展数据类型与默认值）再做视觉折入；
  4. 是否同步把 decision-log DEC-017 背景中「深色科技感驾驶舱」措辞订正为「浅色高级科技感 / 机会决策工作台」。

---

### 2026-06-19 · v0.2.x · 新增第三项指标「画像匹配度」（目标公司画像匹配度）

- 状态：已实现，待用户确认（DEC-018）
- 来源：用户 2026-06-19 明确需求 —— 保留「综合匹配度」「机会分」两项不动，新增第三项「目标公司画像匹配度」，判断当前 JD 是否符合「我的下一家公司目标画像」；不做时间预测、不扩大需求边界。
- 实现要点：
  - 新增 src/app/targetProfileScore.ts：纯函数 calculateTargetProfileScore（地理 25 / 规模 15 / 行业 20 / 岗位 20 / 薪资 10，风险最多扣 20，钳制 0-100）+ getTargetProfileLevel（命中靶心 / 高度匹配 / 可以重点聊 / 谨慎观察 / 偏离画像）。
  - **本地现算、不持久化**：输入全部为 JobRecord 已有字段，不新增持久化字段、不改数据模型、无迁移；旧数据天然兼容（有内容即算分，完全空白显示「待评估」）。
  - 主战场 BattlefieldPage：在既有「机会分 / 综合匹配度」score-row 旁新增第三项评分卡（主标题「画像匹配度」+ 等级，副标题「基于目标公司画像」），并新增「画像匹配度说明」原因区。既有两项的字段 / 计算 / 展示位置 / 样式 / 文案 / 解析逻辑均未改动。
  - 列表 JobListPage：卡片新增「画像 XX」chip（空白岗位显示「待评估」）；排序新增「按画像匹配」选项（与既有「按机会分 / 按匹配度」同构），未改既有列与其他筛选。
  - 未改动 prompt.ts / offerFlowJson.ts / storage/types.ts（不接 AI、不改 JSON 契约、不动数据模型）。
- 随同增强（用户选 A，2026-06-19）：机会雷达图 OpportunityRadarChart.vue 在自研 SVG 基础上增强四项 —— 入场动画（多边形从中心生长，含 prefers-reduced-motion 降级）、Hover 高亮 + tooltip（悬停维度高亮轴/顶点并显示「维度 数值」）、低分维度预警（<60 的顶点/标签标红）、刻度 25/50/75/100 + 80 分达标虚线参考环。
  - 明确未引入 ECharts / 任何图表库，**仍遵守 DEC-017「雷达图继续用自研 SVG」**；曾评估改用 ECharts，用户决定不引入（见对话），故无需新开 DEC-019。
  - 体积仅 SVG/CSS 增量（JS 423→424.8KB，CSS 17.56→18.67KB），无新依赖。
- 自测命令：npm run typecheck / npm run selftest / npm run build / 浏览器验证（dev 5173）
- 自测结果：
  - typecheck：0 error；selftest：storage 46 + parser 43 + 画像 23，全 0 failed；build：成功（CSS 17.56KB / JS 423.15KB）。
  - 浏览器验证（seed 两条 + 1 条历史旧岗位）：
    1. 列表三岗位画像 chip 分别为 90（苏州独墅湖/数据平台/800-1500人/17k）、17（外包驻场/切页面/小作坊/低薪）、52（仅城市+岗位+薪资的旧数据）——旧数据无 v0.2 字段不白屏 ✓
    2. 主战场三项指标并列：机会分 84·优质机会 / 综合匹配度 88% / 画像匹配度 90·命中靶心（副标题「基于目标公司画像」）✓
    3. 「画像匹配度说明」原因区文案命中点与区间正确 ✓
    4. console 无 error ✓
- 是否涉及 decision-log 更新：是，新增 DEC-018（本指标本地现算 / 不接 API / 不持久化 / 不做时间预测）。
- 遗留风险：
  1. 画像参数（区域 / 规模 / 行业 / 岗位 / 薪资关键词与阈值）当前为硬编码常量，若需用户自定义画像，另起任务，不在本次范围。
- 是否允许进入下一步：否，待用户确认。
- 建议 commit message：feat: 新增第三项指标「画像匹配度」（目标公司画像本地评分，不接 API / 不持久化）

### 2026-06-22 · v0.2.x · 三项指标信息分层（DEC-019：机会分主 / 人岗匹配入详情 / 目标画像作徽章）

- 状态：已实现，待用户确认（DEC-019）
- 来源：用户反馈「又是机会分又是匹配度又是画像度，不知道以谁为主，很乱」，经与 GPT 二次评审后拍板（详见 DEC-019）。诊断根因：① 综合匹配度本是机会分 6 维之一，却与机会分并排平铺；② 通用「机会分」与个人「画像匹配度」被当成同级。
- 范围分两批：先做命名 + 撤指标（第一批），用户反馈「视觉上感觉只少了个 chip、没达到预期」，遂在 GPT 二评后追加「视觉分层」（第二批：让层级看得见，仍零算法 / 零数据模型 / 零迁移 / 不动 AI 契约）。
- 第一批 · 命名与撤指标：
  - 列表 JobListPage：移除「匹配 XX」chip（人岗匹配撤出列表）；「画像」→「目标画像」+ tooltip；机会分加 tooltip；排序去「按匹配度」、「按画像匹配」→「按目标画像」；清理 matchNumberOf 死代码与 sortKey 的 'match' 分支。
  - 主战场 BattlefieldPage：「综合匹配度」→「人岗匹配」、「画像匹配度」→「目标画像」、说明区标题同步；匹配度录入区标题 / 按钮 / 提示 / 错误文案统一「人岗匹配」（提示保留「即 AI 给出的综合匹配度」说明来源）。
  - src/app/targetProfileScore.ts：reason 文案「故画像匹配度X」→「故目标画像X」。
- 第二批 · 视觉分层（让层级看得见）：
  - 新增 src/app/scoreVisuals.ts：纯函数 opportunityTone / profileTone / applyAdviceTone → 六档色调（strong/good/watch/caution/weak/none），阈值镜像各等级函数，列表与详情共用一套配色语义。
  - 新增 src/components/OpportunityMiniBars.vue：机会分迷你 6 维条（原生 SVG，不引库，延续 DEC-017），暗示「为什么是这个机会分」。
  - 列表 JobListPage 卡片重排：机会分块按等级上色 + 结论词（优质机会 / 可观察…）+ 迷你 6 维条；目标画像变「等级 · 目标画像 XX」彩色判读徽章；新增「投递建议」彩色行动指令徽章（用已有 applyAdvice）；城市 / 薪资 / 规模压成一行灰色 context（不再与判决抢注意力）。
  - 主战场 BattlefieldPage 重排：原三项扁平并列 → 机会分「英雄区」（大数字 + 等级 + 投递建议色丸）+ 人岗匹配 / 目标画像两张「判读卡」（目标画像按等级上色）+ 雷达图为视觉核心。
  - 顺带修 bug：机会雷达「规模」标签原先直接读 AI 的 companyAssessment.sizeTier，会出现「用户手填中厂、却显示 AI 小厂」的矛盾；改为 effectiveSizeTier（用户手填优先、AI 兜底），与 JobListPage / targetProfileScore 同口径。其余 AI 派生标签（类型/稳定性/成长性/置信度）仍取自 companyAssessment。
  - 未改：matchScore 字段名 / OFFER_FLOW_JSON 协议 / prompt.ts「综合匹配度」术语 / 机会分加权 / targetProfileScore 评分模型与不持久化策略 / storage 数据模型。
- 自测命令：npm run typecheck / npm run selftest / npm run build / 浏览器验证（dev 5174）
- 自测结果：
  - typecheck：0 error；selftest：storage 46 + parser 43 + 画像 23，全 0 failed；build：成功（CSS 22.49KB / JS 427.65KB，仅样式 + 两个小 SVG 增量，无新依赖）。
  - 浏览器验证（seed 三条：苏州中厂全分析 / 杭州小厂 / 旧岗位无分析）：
    1. 列表：机会分块 82 优质机会(蓝) / 72 可观察(青) / -(灰·未分析)，前两条带迷你 6 维条；目标画像徽章「命中靶心·88」(绿) / 「可以重点聊·61」(青) / 「谨慎观察·52」(琥珀)；行动指令「可以沟通」(蓝)，旧岗位无 applyAdvice 则不显示；context 灰行正确；旧数据不白屏 ✓
    2. 主战场：英雄区 82·优质机会·可以沟通(蓝)；判读卡 人岗匹配 88% / 目标画像·命中靶心 88(绿)；雷达图正常 ✓
    3. console 无 error ✓
- 是否涉及 decision-log 更新：是，新增 DEC-019（含视觉分层影响范围）。
- 遗留风险：
  1. docs/v0.2/requirements.md §1 / §7.2 仍保留「综合匹配度」措辞（v0.2.0 冻结信源）；以 DEC-019 为准，未回改正文，后续如出 v0.2.1 需求文档可一并对齐。
  2. src/app/scoreVisuals.ts 暂无独立 selftest（逻辑为阈值映射，已镜像既有等级函数并经浏览器验证）；如需补，另加 scripts/scoreVisuals.selftest.ts 并接入 selftest 串联。
- 是否允许进入下一步：否，待用户确认。
- 建议 commit message：feat: 指标视觉分层（机会分判决英雄区 + 目标画像彩色判读 + 投递建议行动指令 + 迷你 6 维条，DEC-019）

---

### 2026-06-22 · v0.3 · T1 数据模型与状态迁移

- 状态：已实现，待用户确认（DEC-020）
- 来源：用户明确「开始吧」，并提供《OfferFlow v0.3 PRD / Codex 执行版》。按 PRD 要求，每次只执行一张任务卡，本次仅执行 T1。
- 执行者：Codex
- 当前任务目标：
  - `contactStatus` → `communicationStatus`
  - 新增 v0.3 8 态沟通状态枚举
  - 读取旧数据时做状态迁移映射
  - 更新状态 labels 单一信源
  - 新记录不再写入旧字段 `contactStatus`
- 改动文件：
  - `src/storage/types.ts`
  - `src/storage/defaults.ts`
  - `src/storage/jobStore.ts`
  - `src/app/labels.ts`
  - `src/pages/JobListPage.vue`
  - `src/pages/BattlefieldPage.vue`
  - `scripts/storage.selftest.ts`
  - `docs/v0.1/progress.md`
  - `docs/v0.1/decision-log.md`
- 实现要点：
  - `JobRecord` 改为持久化 `communicationStatus: CommunicationStatus`。
  - 新增 `CommunicationStatus` 8 态：`not_contacted` / `greeted_unread` / `greeted_read_no_reply` / `replied` / `interviewing` / `paused` / `closed` / `rejected`。
  - 保留 `LegacyContactStatus` 仅用于读取旧记录迁移；新建与更新岗位不再写旧 `contactStatus`。
  - `withJobRecordDefaults` 读取旧记录时把旧六态映射到新八态：`greeted -> greeted_unread`、`interview_scheduled -> interviewing`，未知 / 缺失回退 `not_contacted`。
  - 列表页与详情页改为读写 `communicationStatus`，状态选项和中文标签改为 `COMMUNICATION_STATUS_OPTIONS` / `COMMUNICATION_STATUS_LABELS`。
  - 未执行 T2：未新增 `lastGreetedAt`、`followupCount`、`highValueSignal` 等跟进事实字段。
  - 未执行 T3：未新增 `deriveDecision`、策略枚举、下一步动作、止损判断。
- 自测命令：
  - `npm run typecheck`：PowerShell 拒绝加载 `npm.ps1`，改用 `npm.cmd run typecheck`
  - `npm run selftest`：PowerShell 拒绝加载 `npm.ps1`，改用 `npm.cmd run selftest`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：54 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
- T1 验收对照：
  - 旧记录能正确迁移：已覆盖 `not_contacted` / `greeted` / `replied` / `interview_scheduled` / `rejected` / `closed` / 缺失状态断言
  - 新记录不再写 `contactStatus`：已用 JSON 断言验证
  - typecheck 0 error：通过
  - selftest 增加迁移断言：已增加并通过
- 红线自检：
  - 未接 API / BYOK / 后端
  - 未爬 Boss / 未自动检测已读未读 / 未自动发送消息
  - 未新增 Company / Contact / Message / JobStatusLog / FollowupLog / Reminder 实体
  - 未新增前端框架 / 状态库 / 网络库 / 运行时依赖
  - 未持久化 `currentStrategy` / `nextAction` / `stopLoss` / `messageScenario` / `companyWarning`
- 是否涉及 decision-log 更新：是，新增 DEC-020，记录 `communicationStatus` 替换 `contactStatus` 与旧数据迁移口径。
- 遗留风险：
  1. 旧数据里的 `contactStatusUpdatedAt` 不再作为 v0.3 新模型字段暴露；T1 只保留当前沟通事实状态，符合 PRD「只存事实，不存决策」和 T1 范围。
  2. 列表 / 详情 UI 只是状态字段适配，尚未进入 v0.3 的跟进决策面板、话术模板和决策台筛选。
- 是否允许进入下一步：否。等待用户确认 T1 后，才能进入 T2。
- 建议 commit message：feat: v0.3 T1 将沟通状态迁移为 communicationStatus

---

### 2026-06-22 · v0.3 · T2 新增跟进事实字段

- 状态：已实现，待用户确认（DEC-021）
- 来源：用户确认 T2 对 `contactStatusUpdatedAt` 的最终裁定，并明确可以进入 T2；按 PRD 要求，每次只执行一张任务卡，本次仅执行 T2。
- 执行者：Codex
- 当前任务目标：
  - 新增 `lastGreetedAt`
  - 新增 `followupCount`
  - 新增 `lastFollowupAt`
  - 新增 `lastCommunicationNote`
  - 新增 `highValueSignal`
  - 新增 `strategyOverride`
  - 新增 `draftMessageText`
- 改动文件：
  - `src/storage/types.ts`
  - `src/storage/defaults.ts`
  - `src/storage/jobStore.ts`
  - `scripts/storage.selftest.ts`
  - `docs/v0.1/progress.md`
  - `docs/v0.1/decision-log.md`
- 实现要点：
  - `JobRecord` 新增 v0.3 允许持久化的跟进事实字段。
  - `followupCount` 为必填数字字段，新建岗位默认 `0`，旧记录读取时补 `0`。
  - `highValueSignal` 为用户手动输入的事实信号，新建岗位默认 `false`，旧记录缺省按 `false` 处理。
  - `lastGreetedAt` / `lastFollowupAt` / `lastCommunicationNote` / `strategyOverride` / `draftMessageText` 保持 optional，缺失时不补伪值。
  - `strategyOverride` 仅定义 PRD 给出的 4 个字面量类型，用于保存用户手动覆盖事实；未实现任何策略推导。
  - 未新增 `currentStrategy` / `nextAction` / `nextActionHint` / `stopLoss` / `messageScenario` / `companyWarning` 等派生决策字段。
  - 未执行 T3：未新增 `deriveDecision`、下一步动作、止损判断、话术场景推导。
- `contactStatusUpdatedAt` 裁定：
  - T2 不重新引入 `contactStatusUpdatedAt` 作为 v0.3 新模型字段。
  - **T2 不做 contactStatusUpdatedAt → lastGreetedAt 时间迁移，只迁移状态，避免制造错误事实。**
  - 原因：`contactStatusUpdatedAt` 是旧模型里的“任意沟通状态更新时间”，不能可靠表达“最近一次打招呼时间”。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run selftest`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：67 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
- T2 验收对照：
  - 新字段可保存 / 读取 / 更新：已覆盖 `lastGreetedAt`、`followupCount`、`lastFollowupAt`、`lastCommunicationNote`、`highValueSignal`、`strategyOverride`、`draftMessageText`
  - 旧记录缺字段不崩：已覆盖旧记录读取
  - 旧记录含 `contactStatusUpdatedAt` 时读取不崩，且不会迁移成 `lastGreetedAt`：已覆盖断言
  - 未新增派生决策字段：已自检
- 红线自检：
  - 未接 API / BYOK / 后端
  - 未爬 Boss / 未自动检测已读未读 / 未自动发送消息
  - 未新增 Company / Contact / Message / JobStatusLog / FollowupLog / Reminder 实体
  - 未新增前端框架 / 状态库 / 网络库 / 运行时依赖
  - 未持久化 `currentStrategy` / `nextAction` / `nextActionHint` / `stopLoss` / `messageScenario` / `companyWarning`
- 是否涉及 decision-log 更新：是，新增 DEC-021，记录 T2 只存用户手动维护事实、不存派生决策，以及 `contactStatusUpdatedAt` 不迁移为 `lastGreetedAt` 的裁定。
- 遗留风险：
  1. T2 仅落地存储事实字段，尚未提供 UI 编辑入口；后续 T4 才在详情页接入编辑面板。
  2. `strategyOverride` 当前只是用户事实字段，未参与任何派生逻辑；T3 决策纯函数落地后再消费。
- 是否允许进入下一步：否。等待用户确认 T2 后，才能进入 T3。
- 建议 commit message：feat: v0.3 T2 新增跟进事实字段

---

### 2026-06-22 · v0.3 · T3 决策纯函数

- 状态：已实现，待用户确认（DEC-022）
- 来源：用户确认 T2 通过后，明确要求进入 T3：实现 `deriveDecision(record, allJobs?)` 纯函数，且 T3 只做纯函数和自测，不进入 T4。
- 执行者：Codex
- 当前任务目标：
  - 新增 `deriveDecision(record, allJobs?)` 纯函数。
  - 落地 `NextActionType` / `MessageScenario` / `FOLLOWUP_COOLDOWN_DAYS = 3` / `MAX_FOLLOWUPS = 2`。
  - 按 T3 规则从 `JobRecord` 事实字段实时派生 `strategy` / `nextAction` / `stopLoss` / `scenario` / `companyWarning`。
  - 保持 `strategy` / `nextAction` / `stopLoss` / `scenario` / `companyWarning` 不写入 `JobRecord`。
- 改动文件：
  - `src/storage/types.ts`
  - `src/decision/deriveDecision.ts`
  - `src/decision/index.ts`
  - `scripts/decision.selftest.ts`
  - `package.json`
  - `docs/v0.1/progress.md`
  - `docs/v0.1/decision-log.md`
- 实现要点：
  - `deriveDecision` 只接收 `JobRecord` 与可选 `allJobs`，不读取 store，不访问浏览器运行时，不发网络请求，不写 storage。
  - 返回类型固定为 `{ strategy, nextAction, stopLoss, scenario, companyWarning? }`。
  - 匹配度判定只按 `record.report?.applyAdvice`：`strongly` / `ok` 为高匹配，`cautious` / `skip` 为低匹配或一般；`report === null` 或 `applyAdvice === ''` 走空报告兜底。
  - `not_contacted + 高匹配` 派生 `main_attack + send_greeting + first_greeting`。
  - `not_contacted + 低匹配 + highValueSignal=true` 派生 `low_cost_probe + send_greeting + high_salary_low_match_probe`。
  - `greeted_unread` / `greeted_read_no_reply` 按 `followupCount`、`lastGreetedAt`、`lastFollowupAt`、冷却期和 `MAX_FOLLOWUPS` 派生等待、一次跟进、换角度跟进、最终跟进或止损关闭。
  - `replied` 派生 `continue_conversation`，`interviewing` 派生 `prepare_interview`，`paused` 派生 `pause_watch`。
  - `closed` / `rejected` 返回 `nextAction: null` 且 `stopLoss: false`。
  - 缺少跟进时间戳的已打招呼记录保守判为未过冷却期，避免旧数据缺事实时制造跟进事实。
  - T3 保持 `StrategyType` 仅有 `main_attack` / `low_cost_probe` / `cautious_watch` / `cut_loss` 四类；`follow_up_once` / `follow_up_with_new_angle` 只作为 `nextAction` 返回，不属于策略。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run selftest`
  - `rg -n "localStorage|window\.storage|fetch\(|axios|XMLHttpRequest" src/decision`
  - `rg -n "interface +(Company|Contact|Message|JobStatusLog|FollowupLog|Reminder)\b" src`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：67 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
    - decision selftest：40 passed, 0 failed
  - `src/decision` 纯度 grep：无命中
  - 禁止实体 grep：无命中
- T3 验收对照：
  - 覆盖 `followupCount` 0 / 1 / >=2 三档：已覆盖
  - 覆盖 `highValueSignal` 触发 `low_cost_probe`：已覆盖
  - 覆盖 `followupCount=1` 触发 `final_unread_followup`：已覆盖
  - 覆盖 `closed` / `rejected` 返回 `nextAction=null`：已覆盖
  - 覆盖 `replied` 返回 `continue_conversation`：已覆盖
  - 覆盖 `report=null` 兜底：已覆盖
  - 覆盖 `deriveDecision` 不读写存储、不发网络：已覆盖动态桩测试与源码 token 检查
- 红线自检：
  - 未读写 localStorage / store
  - 未访问 `window`
  - 未发网络请求
  - 未依赖 UI
  - 未把 `strategy` / `nextAction` / `stopLoss` / `scenario` / `companyWarning` 写入 `JobRecord`
  - 未新增 Company / Contact / Message / JobStatusLog / FollowupLog / Reminder 实体
  - 未新增依赖
  - 未修改 UI 页面
- 是否涉及 decision-log 更新：是，新增 DEC-022，记录 T3 纯函数派生决策、不落库存储派生结果、不接 UI / store / 网络的口径。
- 遗留风险：
  1. `companyWarning` 暂未派生，返回类型预留；按当前 T3 要求未实现跨公司预警逻辑，避免提前进入后续任务。
  2. `strategyOverride` 在 T3 暂未消费；T3 只落地规则派生函数，后续是否在 UI 或决策面板中接入覆盖逻辑，应由 T4/T5 任务确认。
  3. 缺失 `lastGreetedAt` / `lastFollowupAt` 时保守等待，可能少提示一次跟进，但不会制造错误跟进事实。
- 是否允许进入下一步：否。等待用户确认 T3 后，才能进入 T4。
- 建议 commit message：feat: v0.3 T3 新增跟进决策纯函数

---

### 2026-06-22 · v0.3 · T4 详情页跟进决策面板

- 状态：已实现，待用户确认（DEC-023）
- 来源：用户确认 T3 通过后，明确要求进入 T4：在详情页新增“跟进决策面板”，展示 `deriveDecision(record, allJobs?)` 的派生结果，并允许编辑 v0.3 事实字段；完成后停止，不进入 T5。
- 执行者：Codex
- 当前任务目标：
  - 在详情页展示 `strategy` / `nextAction` / `stopLoss` / `scenario` / `companyWarning`。
  - 允许编辑并保存 `communicationStatus` / `followupCount` / `lastCommunicationNote` / `highValueSignal` / `draftMessageText`。
  - 修改 `communicationStatus` / `followupCount` / `highValueSignal` 后，面板实时重新计算派生结果。
- 改动文件：
  - `src/pages/BattlefieldPage.vue`
  - `docs/v0.1/progress.md`
  - `docs/v0.1/decision-log.md`
- 实现要点：
  - 详情页新增“跟进决策”面板，打开岗位详情时基于当前岗位记录调用 `deriveDecision`。
  - 旧的“沟通状态”区域升级为面板内的事实编辑区，继续支持手动切换 `communicationStatus` 并立即持久化。
  - 面板新增 `followupCount`、`lastCommunicationNote`、`highValueSignal`、`draftMessageText` 编辑与保存。
  - `draftMessageText` 作为用户话术草稿保存；不替代原有 Boss 打招呼话术字段。
  - `closed` / `rejected` 终态下，`nextAction=null` 时 UI 显示“已结束，无下一步”。
  - `stopLoss=true` 时展示“建议止损：本轮不再继续消耗精力”。
  - `companyWarning` 只展示 `deriveDecision` 当前返回值；T4 不实现公司级预警。
  - 页面只保存用户编辑事实字段；`strategy` / `nextAction` / `stopLoss` / `scenario` / `companyWarning` 均只在 computed 中派生展示，不传给 `updateJob`。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run selftest`
  - `rg -n "strategy|nextAction|stopLoss|scenario|companyWarning|currentStrategy|nextActionHint" src/storage`
  - `rg -n "fetch\(|axios|XMLHttpRequest" src/pages src/components`
  - `rg -n "interface +(Company|Contact|Message|JobStatusLog|FollowupLog|Reminder)\b" src`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：67 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
    - decision selftest：43 passed, 0 failed
  - storage 派生字段 grep：仅命中 `StrategyType` / `strategyOverride`，未命中 `nextAction` / `stopLoss` / `scenario` / `companyWarning` / `currentStrategy` / `nextActionHint` 等派生落库字段；`strategyOverride` 是 T2 已允许的用户事实字段。
  - 页面/组件网络 grep：无命中
  - 禁止实体 grep：无命中
- T4 验收对照：
  - 详情页出现跟进决策面板：已实现
  - 能看到 `strategy` / `nextAction` / `stopLoss` / `scenario`：已实现
  - 修改事实字段后派生结果实时变化：已实现，基于 computed 重新调用 `deriveDecision`
  - 刷新后事实字段保留：已通过存储字段读写路径实现
  - 刷新后策略 / 动作由 `deriveDecision` 重新计算：已实现，未从存储读取派生字段
  - 终态显示“已结束，无下一步”：已实现
  - `highValueSignal` 勾选后，低匹配机会可派生 `low_cost_probe`：已由 T3 规则 + T4 实时 computed 支持
- 红线自检：
  - 未把 `strategy` / `nextAction` / `stopLoss` / `scenario` / `messageScenario` / `companyWarning` / `currentStrategy` / `nextActionHint` 写入 `JobRecord` 或 localStorage。
  - 未新增 Company / Contact / Message / JobStatusLog / FollowupLog / Reminder 实体。
  - 未接 API / BYOK / 后端。
  - 未做 Boss 自动化、自动检测已读、自动发送、自动投递、提醒系统、完整沟通日志、批量操作。
  - 未新增依赖。
  - 未进入 T5。
- 是否涉及 decision-log 更新：是，新增 DEC-023，记录 T4 页面只展示派生决策、只保存事实字段的口径。
- 遗留风险：
  1. T4 未做公司级预警，`companyWarning` 在 T7 前通常为空。
  2. T4 初版未强制编辑 `lastGreetedAt` / `lastFollowupAt` / `strategyOverride`，避免扩大 UI 范围。
  3. 本次未新增浏览器端自动化测试；通过 typecheck、selftest 和红线 grep 验证代码路径。
- 是否允许进入下一步：否。等待用户确认 T4 后，才能进入 T5。
- 建议 commit message：feat: v0.3 T4 新增详情页跟进决策面板

---

### 2026-06-23 · v0.3 · T4.1 跟进决策面板实时派生修复与布局优化

- 状态：已实现，待用户确认
- 来源：用户实测反馈 T4 面板中修改 `followupCount` / `highValueSignal` 后顶部派生决策没有实时变化，并要求小幅优化事实字段布局；本次仅做 T4.1 bugfix + UI 对齐，不进入 T5。
- 执行者：Codex
- 改动文件：
  - `src/pages/BattlefieldPage.vue`
  - `docs/v0.1/progress.md`
  - `docs/v0.1/decision-log.md`
- 修复内容：
  - 详情页构造专门用于派生决策的实时对象，明确纳入当前页面状态：`communicationStatus` / `followupCount` / `highValueSignal` / `lastCommunicationNote` / `draftMessageText`。
  - `followupCount` 通过 `Number(...)` 归一为非负整数后再传入 `deriveDecision`，避免字符串进入规则判断。
  - 派生输入兼容 v0.2 已解析岗位：当 `report.applyAdvice` 为空但 `opportunityAnalysis.applyAdvice` 存在时，用该已有事实作为当前页面派生输入，不写回存储。
  - 勾选高价值信号时，若当前岗位已是 `strongly` / `ok` 高匹配，面板显示说明“当前岗位已是高匹配，高价值信号不会覆盖主攻策略”。
  - 跟进次数与高价值信号改为两列事实卡片布局：同高、垂直居中；窄屏自然换行。
- 手动验证结果：
  - `communicationStatus` 变化会触发 `deriveDecision` computed 重新计算。
  - `followupCount` 变化会以 number 进入派生对象并触发重新计算。
  - `highValueSignal` 勾选 / 取消会进入派生对象并触发重新计算；低匹配且未沟通时可派生 `low_cost_probe`。
  - `followupCount >= 2` 可派生 `cut_loss + close_opportunity + stopLoss=true`。
  - T3 冷却期规则未改：`greeted_unread` 的 0 / 1 次跟进仍受 `lastGreetedAt` / `lastFollowupAt` 是否已过冷却期影响；缺失时间戳时继续按 T3 规则保守等待。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run selftest`
  - `rg -n "strategy|nextAction|stopLoss|scenario|companyWarning|currentStrategy|nextActionHint" src/storage`
  - `rg -n "fetch\(|axios|XMLHttpRequest" src/pages src/components`
  - `rg -n "interface +(Company|Contact|Message|JobStatusLog|FollowupLog|Reminder)\b" src`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：67 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
    - decision selftest：43 passed, 0 failed
  - storage 派生字段 grep：仅命中 `strategyOverride?: StrategyType`，这是 T2 已允许的用户事实字段；未发现派生决策字段落库。
  - 页面/组件网络 grep：无命中
  - 禁止实体 grep：无命中
- 红线自检：
  - 未进入 T5。
  - 未新增字段、未修改存储结构。
  - 未新增依赖。
  - 未保存派生结果。
  - 未接 API / BYOK / 后端 / Boss 自动化。
  - 未新增实体、未做完整沟通日志、未做提醒系统。
- 是否允许进入下一步：否。等待用户确认 T4 / T4.1 后，才能进入 T5。
- 建议 commit message：feat: v0.3 T4 新增详情页跟进决策面板

---

### 2026-06-23 · v0.3 · T4.2 补齐冷却期时间事实维护

- 状态：已实现，待用户确认
- 来源：用户指出 T3 冷却期规则依赖 `lastGreetedAt` / `lastFollowupAt`，但 T4/T4.1 面板未提供这两个已有事实字段的轻量维护入口，导致旧记录或新记录缺少时间戳时可能持续命中 `wait`；本次仅补齐 T4.2，不进入 T5。
- 执行者：Codex
- 改动文件：
  - `src/pages/BattlefieldPage.vue`
  - `docs/v0.1/progress.md`
  - `docs/v0.1/decision-log.md`
- 实现内容：
  - 跟进决策面板新增“最近打招呼时间”和“最近跟进时间”两张轻量事实卡片。
  - 两个时间事实卡片在未记录时显示“未记录”，支持 `datetime-local` 手动维护、“设为现在”和“清空”。
  - 页面实时派生输入新增 `lastGreetedAt` / `lastFollowupAt`，点击“设为现在”或“清空”后会立即触发 `deriveDecision` computed 重新计算。
  - “保存跟进事实”会保存当前表单中的 `lastGreetedAt` / `lastFollowupAt`；仍只保存事实字段，不保存 `strategy` / `nextAction` / `stopLoss` / `scenario` / `companyWarning`。
  - 旧记录缺少 `lastGreetedAt` / `lastFollowupAt` 时读取为空，不崩溃，不从 `contactStatusUpdatedAt` 迁移，也不自动推断历史时间。
- 规则说明：
  - 缺时间戳时仍可能返回 `wait`，因为 T3 冷却期判断需要可信的最近打招呼 / 最近跟进时间；没有事实时间时保守等待，避免制造错误事实。
  - 设置为 4 天前或足够早后，`greeted_unread` / `greeted_read_no_reply` 下的 `followupCount=0` 可派生 `follow_up_once + second_followup`。
  - 设置为 4 天前或足够早后，`greeted_unread` / `greeted_read_no_reply` 下的 `followupCount=1` 可派生 `follow_up_with_new_angle + final_unread_followup`。
  - `followupCount>=2` 继续派生 `cut_loss + close_opportunity + stopLoss=true`。
  - 未沟通、低匹配且 `highValueSignal=true` 继续派生 `low_cost_probe + send_greeting + high_salary_low_match_probe`。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run selftest`
  - `rg -n "strategy|nextAction|stopLoss|scenario|companyWarning|currentStrategy|nextActionHint" src/storage`
  - `rg -n "fetch\(|axios|XMLHttpRequest" src/pages src/components`
  - `rg -n "interface +(Company|Contact|Message|JobStatusLog|FollowupLog|Reminder)\b" src`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：67 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
    - decision selftest：43 passed, 0 failed
  - storage 派生字段 grep：仅命中 `strategyOverride?: StrategyType`，这是 T2 已允许的用户事实字段；未发现派生决策字段落库。
  - 页面/组件网络 grep：无命中
  - 禁止实体 grep：无命中
- 红线自检：
  - 未进入 T5。
  - 未新增字段、未修改存储结构。
  - 未修改 `deriveDecision` 规则。
  - 未新增依赖。
  - 未保存派生结果。
  - 未从 `contactStatusUpdatedAt` 迁移时间。
  - 未接 API / BYOK / 后端 / Boss 自动化。
  - 未做提醒系统、日历系统、自动定时、完整沟通日志或新增实体。
- 是否允许进入下一步：否。等待用户确认 T4 / T4.1 / T4.2 后，才能进入 T5。
- 建议 commit message：feat: v0.3 T4 新增详情页跟进决策面板

---

### 2026-06-23 · v0.3 · T4.3 未沟通态禁用无语义跟进事实 + 时间控件与排版优化

- 状态：已实现，待用户确认
- 来源：用户基于截图反馈：`not_contacted` 未沟通状态下，跟进次数和最近沟通时间模块应为禁用状态；原生时间控件视觉割裂，时间模块排版未对齐。本次仅做 T4.3 小修，不进入 T5。
- 执行者：Codex
- 改动文件：
  - `src/pages/BattlefieldPage.vue`
  - `docs/v0.1/progress.md`
  - `docs/v0.1/decision-log.md`
- 实现内容：
  - 新增 `followupTimingDisabled` 页面状态：当 `communicationStatus=not_contacted` 时，禁用 `followupCount`、`lastGreetedAt`、`lastFollowupAt` 及其“设为现在 / 清空”动作。
  - 未沟通时保留 `highValueSignal` 可编辑，因为它仍参与 T3 的 `low_cost_probe` 判断。
  - 时间事实控件从浏览器原生 `datetime-local` 切换为项目既有 Naive UI `NDatePicker`，不新增依赖。
  - 时间卡片改为统一三列布局：左侧事实摘要，中间时间选择器，右侧动作按钮；两张卡片同高、同列宽、按钮横向对齐。
  - 禁用态使用弱化边框和文字，不隐藏既有事实值，不自动清空历史事实。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run selftest`
  - `rg -n "strategy|nextAction|stopLoss|scenario|companyWarning|currentStrategy|nextActionHint" src/storage`
  - `rg -n "fetch\(|axios|XMLHttpRequest" src/pages src/components`
  - `rg -n "interface +(Company|Contact|Message|JobStatusLog|FollowupLog|Reminder)\b" src`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：67 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
    - decision selftest：43 passed, 0 failed
  - storage 派生字段 grep：仅命中 `strategyOverride?: StrategyType`，这是 T2 已允许的用户事实字段；未发现派生决策字段落库。
  - 页面/组件网络 grep：无命中
  - 禁止实体 grep：无命中
- 红线自检：
  - 未进入 T5。
  - 未新增字段、未修改存储结构。
  - 未修改 `deriveDecision` 规则。
  - 未新增依赖。
  - 未保存派生结果。
  - 未从 `contactStatusUpdatedAt` 迁移时间。
  - 未接 API / BYOK / 后端 / Boss 自动化。
  - 未做提醒系统、日历系统、自动定时、完整沟通日志或新增实体。
- 是否允许进入下一步：否。等待用户确认 T4 / T4.1 / T4.2 / T4.3 后，才能进入 T5。
- 建议 commit message：feat: v0.3 T4 新增详情页跟进决策面板

---

### 2026-06-23 · v0.3 · T4.4 详情页内容最大宽度单一信源调整

- 状态：已实现，待用户确认
- 来源：用户反馈 `.battlefield` 的 `max-width` 与 `n-layout-content` 的 `max-width` 重复，调整页面宽度时需要改两遍；本次仅做布局样式收敛，不进入 T5。
- 执行者：Codex
- 改动文件：
  - `src/App.vue`
  - `src/pages/BattlefieldPage.vue`
  - `docs/v0.1/progress.md`
- 实现内容：
  - 在全局设计令牌中新增 `--of-content-max-width: 1212px`，作为 App 内容区最大宽度唯一信源。
  - `n-layout-content` 的 `contentStyle` 改为引用 `var(--of-content-max-width)`，并增加 `box-sizing: border-box; width: 100%`，让最大宽度包含内容区 padding。
  - 移除 `.battlefield` 自己的 `max-width` 和居中 `margin`，改为 `width: 100%; box-sizing: border-box;`。
  - `.battlefield` 仍保留页面内部 padding 和文字样式，不扩大 T4 功能范围。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run selftest`
  - `rg -n "strategy|nextAction|stopLoss|scenario|companyWarning|currentStrategy|nextActionHint" src/storage`
  - `rg -n "fetch\(|axios|XMLHttpRequest" src/pages src/components`
  - `rg -n "interface +(Company|Contact|Message|JobStatusLog|FollowupLog|Reminder)\b" src`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：67 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
    - decision selftest：43 passed, 0 failed
  - storage 派生字段 grep：仅命中 `strategyOverride?: StrategyType`，这是 T2 已允许的用户事实字段；未发现派生决策字段落库。
  - 页面/组件网络 grep：无命中
  - 禁止实体 grep：无命中
- 红线自检：
  - 未进入 T5。
  - 未新增字段、未修改存储结构。
  - 未修改 `deriveDecision` 规则。
  - 未新增依赖。
  - 未保存派生结果。
  - 未接 API / BYOK / 后端 / Boss 自动化。
  - 未做提醒系统、日历系统、自动定时、完整沟通日志或新增实体。
- 是否允许进入下一步：否。等待用户确认 T4 / T4.1 / T4.2 / T4.3 / T4.4 后，才能进入 T5。
- 建议 commit message：feat: v0.3 T4 新增详情页跟进决策面板

---

### 2026-06-23 · v0.3 · T5 话术模板与复制

- 状态：已实现，待用户确认
- 来源：用户确认 T4 / T4.1 / T4.2 通过并要求进入 T5：按 `MessageScenario` 提供 6 类话术模板，支持变量填充、复制、填入草稿、用户编辑并保存 `draftMessageText`；完成后停止，不进入 T6。
- 执行者：Codex
- 改动文件：
  - `src/app/messageTemplates.ts`
  - `src/pages/BattlefieldPage.vue`
  - `scripts/decision.selftest.ts`
  - `docs/v0.1/progress.md`
- 实现内容：
  - 新增 `buildMessageTemplate(scenario, record)` 纯函数，覆盖 `first_greeting` / `second_followup` / `final_unread_followup` / `high_salary_low_match_probe` / `premium_but_cold_closing` / `hr_reply_bridge` 六类 `MessageScenario`。
  - 模板变量来自当前岗位事实与已有报告 / 机会分析字段，并通过安全清洗和兜底，缺字段时不输出 `undefined` / `null` / `NaN`。
  - 详情页跟进决策面板新增推荐话术区，根据当前 `deriveDecision(...).scenario` 实时展示推荐话术。
  - 支持“一键复制推荐话术”和“填入草稿”；填入草稿只更新页面表单态，不自动保存，不自动覆盖已有草稿。
  - 用户仍可编辑 `draftMessageText`，点击“保存跟进事实”后才保存草稿。
  - `scenario` 仍是派生结果，不落库；没有新增 `messageScenario` 字段。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run selftest`
  - `rg -n "fetch\(|axios|XMLHttpRequest|https?://|/api/" src/app src/decision src/pages`
  - `rg -n "messageScenario|currentStrategy|nextActionHint|companyWarning|stopLoss" src/storage`
  - `rg -n "interface +(Company|Contact|Message|JobStatusLog|FollowupLog|Reminder)\b" src`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：67 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
    - decision selftest：48 passed, 0 failed（新增 Message templates 覆盖）
  - 网络 / URL / API 红线 grep：无命中
  - storage 派生字段 grep：无命中
  - 禁止实体 grep：无命中
- 红线自检：
  - 未进入 T6。
  - 未新增字段、未修改存储结构。
  - 未保存 `messageScenario` / `scenario` / `nextAction` / `stopLoss` / `companyWarning` 等派生结果。
  - 未修改 `deriveDecision` 规则。
  - 未新增依赖。
  - 未接 API / BYOK / 后端 / Boss 自动化。
  - 未自动发送、未自动投递、未自动检测已读、未读取聊天上下文。
  - 未做完整 AI Chat、批量操作、提醒系统或新增实体。
- 是否允许进入下一步：否。等待用户确认 T5 后，才能进入 T6。
- 建议 commit message：feat: v0.3 T5 新增话术模板与复制

---

### 2026-06-23 · v0.3 · T6 列表页决策台模式

- 状态：已实现，待用户确认
- 来源：用户确认 T5 通过后，明确要求进入 T6：在列表页增加“决策台模式”，展示每条记录的行动建议，新增决策台排序和 4 个筛选 chips；完成后停止，不进入 T7。
- 执行者：Codex
- 改动文件：
  - `src/pages/JobListPage.vue`
  - `src/app/decisionLabels.ts`
  - `docs/v0.1/progress.md`
- 实现内容：
  - 列表页继续通过 `JobStore.listJobs()` 读取现有岗位列表，不新增 store。
  - 对每条 `JobRecord` 调用 `deriveDecision(job, jobs)` 实时派生决策结果，仅用于前端展示 / 筛选 / 排序。
  - 列表行新增策略徽章、下一步动作徽章；`stopLoss=true` 时显示“建议止损”徽章。
  - `nextAction=null` 时下一步动作显示“已结束”。
  - 新增筛选 chips：全部行动 / 待打招呼 / 可跟进 / 待止损 / 等回复。
  - 新增排序模式“按决策优先级”，优先级为：待止损 → 可跟进 → 待打招呼 → 准备面试 → 等回复 → 终态；同优先级按更新时间倒序。
  - 新增 `src/app/decisionLabels.ts` 作为纯展示标签映射，不含存储或副作用。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run selftest`
  - `rg -n "createStore|new .*Store|useDashboardStore" src/pages src/app src/storage`
  - `rg -n "fetch\(|axios|XMLHttpRequest" src/pages src/components src/app`
  - `rg -n "strategy|nextAction|stopLoss|scenario|companyWarning|currentStrategy|nextActionHint" src/storage`
  - `rg -n "interface +(Company|Contact|Message|JobStatusLog|FollowupLog|Reminder)\b" src`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：67 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
    - decision selftest：48 passed, 0 failed
  - store / dashboard grep：仅命中既有 `src/storage/index.ts` 的 `createStores(...)` 和原有 `new ConfigStore` / `new JobStore`；未新增 dashboard store。
  - 页面 / 组件 / app 网络 grep：无命中
  - storage 派生字段 grep：仅命中 `strategyOverride?: StrategyType`，这是 T2 已允许的用户事实字段；未发现 T6 派生决策字段落库。
  - 禁止实体 grep：无命中
- 红线自检：
  - 未进入 T7。
  - 未新增字段、未修改存储结构。
  - 未保存 `strategy` / `nextAction` / `stopLoss` / `scenario` / `companyWarning` 等派生结果。
  - 未新增 dashboard store、独立 CRM 页面或批量操作按钮。
  - 未新增依赖。
  - 未接 API / BYOK / 后端 / Boss 自动化。
  - 未自动发送、未自动投递、未自动检测已读。
  - 未做提醒系统、完整沟通日志或新增实体。
- 是否允许进入下一步：否。等待用户确认 T6 后，才能进入 T7。
- 建议 commit message：feat: v0.3 T6 新增列表页决策台模式

---

### 2026-06-23 · v0.3 · T7 公司级只读预警

- 状态：已确认并提交（DEC-024）
- 来源：用户确认 T6 通过后，明确要求进入 T7：通过现有 `JobRecord[]` 派生同公司岗位预警，并在详情页 / 列表页只读展示；完成后停止，不进入 T8。
- 执行者：Codex
- 改动文件：
  - `src/decision/deriveDecision.ts`
  - `scripts/decision.selftest.ts`
  - `src/pages/BattlefieldPage.vue`
  - `src/pages/JobListPage.vue`
  - `docs/v0.1/progress.md`
  - `docs/v0.1/decision-log.md`
- 实现内容：
  - 新增纯函数 `normalizeCompanyName(company?)`：去首尾空格、合并连续空格、统一小写，空公司名返回空字符串。
  - 新增纯函数 `deriveCompanyWarning(currentJob, allJobs)`：只基于现有 `JobRecord[]` 和同公司其他岗位派生预警，排除当前岗位自身。
  - `deriveDecision(record, allJobs?)` 集成 `companyWarning`，仅返回派生结果，不写入 `JobRecord`。
  - 预警优先级：已有回复 / 面试推进 > 已有主攻机会 > 多个冷淡机会。
  - 详情页复用 T4 预留的 `companyWarning` 只读提示位，现由 T7 真正返回预警文案。
  - 列表页在存在预警时展示轻量“同公司预警”徽章，完整文案放在 `title`。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run selftest`
  - `rg -n "interface +(Company|Contact|Message|JobStatusLog|FollowupLog|Reminder)\b" src`
  - `rg -n "companyWarning|companyKey|strategy|nextAction|stopLoss|scenario|messageScenario|currentStrategy|nextActionHint" src/storage`
  - `rg -n "fetch\(|axios|XMLHttpRequest" src/decision src/pages src/components src/app`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：67 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
    - decision selftest：58 passed, 0 failed（新增 Company warnings 覆盖）
  - 禁止实体 grep：无命中
  - storage 派生字段 grep：仅命中 `strategyOverride?: StrategyType`，这是 T2 已允许的用户事实字段；未发现 `companyWarning` / `companyKey` / 派生决策字段落库。
  - 网络 grep：无命中
- 红线自检：
  - 未进入 T8。
  - 未新增 Company / Contact / Message / JobStatusLog / FollowupLog / Reminder 实体。
  - 未新增公司级状态、公司沟通历史、公司详情页、CRM dashboard 或 store。
  - 未写入 `companyWarning` / `companyKey` / `strategy` / `nextAction` / `stopLoss` / `scenario` 等派生结果。
  - 未新增依赖。
  - 未接 API / BYOK / 后端 / Boss 自动化。
  - 未自动发送、未自动投递、未做提醒系统、完整沟通日志或批量操作。
- 是否允许进入下一步：是。用户已确认 T7 基本通过；Codex 已核对 `deriveCompanyWarning` 内部不递归调用 `deriveDecision(otherJob, allJobs)`，T7 已提交到 v0.3 分支，随后进入 T8。
- 建议 commit message：feat: v0.3 T7 新增公司级只读预警

---

### 2026-06-23 · v0.3 · T8 文档与 release note 收口

- 状态：已完成，待最终验收
- 来源：用户确认 T7 通过后，明确要求进入 T8：只做文档与 release note 收口，不修改源码 / 测试 / 配置；完成后停止，不合并 main，不打 tag。
- 执行者：Codex
- 改动文件：
  - `README.md`
  - `docs/release/v0.1.0.md`
  - `docs/release/v0.2.0.md`
  - `docs/release/v0.3.0.md`
  - `docs/v0.1/progress.md`
- 实现内容：
  - README 升级为 v0.3.0 视角，明确 v0.3 是“半自动求职跟进决策台”。
  - README 写清 v0.3 主线：策略建议 + 下一步动作 + 推荐话术 + 止损判断。
  - README 与 release note 记录 `communicationStatus` 替换 `contactStatus`，以及 8 态沟通状态。
  - README 与 release note 记录新增跟进事实字段：`lastGreetedAt`、`followupCount`、`lastFollowupAt`、`lastCommunicationNote`、`highValueSignal`、`strategyOverride`、`draftMessageText`。
  - README 与 release note 记录“只存事实，不存决策”：不持久化 `strategy` / `nextAction` / `stopLoss` / `scenario` / `companyWarning`。
  - release note 记录 `deriveDecision(record, allJobs?)` 纯函数派生 `strategy` / `nextAction` / `stopLoss` / `scenario` / `companyWarning`。
  - release note 记录详情页跟进决策面板、话术模板与复制、列表页决策台模式、公司级只读预警。
  - release note 明确公司级预警为只读派生，不新增 Company 实体。
  - README 与 release note 写清完整 v0.3 不做清单，避免把 API / BYOK / Boss 自动化 / CRM 当作待办项。
  - 修正 v0.1 release note 中旧的 BYOK 后续表述，改为“后续如需讨论必须另行拍板”，避免被误读为当前待办。
  - 修正 v0.2 release note 中旧的 BYOK / AI Adapter 后续表述，改为“未纳入 v0.2.0，后续如需讨论必须另行拍板”。
  - decision-log 已核对存在 DEC-020、DEC-021、DEC-022、DEC-024；T8 未新增产品决策，未修改 decision-log。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run selftest`
  - `npm.cmd run build`
  - `rg -n "自动投递|自动发送|接 ?API|BYOK|后端|CRM|Company|Contact|Message" docs README.md`
- 自测结果：
  - `npm.cmd run typecheck`：通过，0 error
  - `npm.cmd run selftest`：通过
    - storage selftest：67 passed, 0 failed
    - offerFlowJson selftest：43 passed, 0 failed
    - targetProfileScore selftest：23 passed, 0 failed
    - decision selftest：58 passed, 0 failed
  - `npm.cmd run build`：通过，构建成功
  - 文档红线 grep：命中均位于“明确不做 / 边界说明 / 被否决方案 / 决策说明”语境；未发现 API / BYOK / 自动投递 / CRM 被写成 v0.3 待办项。
- 红线自检：
  - 未修改 `src/`、`scripts/`、`package.json` 或任何源码 / 测试 / 配置文件。
  - 未新增依赖。
  - 未新增 Company / Contact / Message / JobStatusLog / FollowupLog / Reminder 实体。
  - 未把 `strategy` / `nextAction` / `stopLoss` / `scenario` / `companyWarning` 写成持久化字段。
  - 未接 API / BYOK / 后端 / Boss 自动化。
  - 未合并 main，未打 tag。
- 是否允许进入下一步：否。等待用户最终验收；是否合并 main、是否打 tag 需用户另行确认。
- 建议 commit message：docs: v0.3 文档与 release note 收口

---

### 2026-06-26 · v0.4 · 本地服务化与 SQLite 数据文件化开工治理

- 状态：已完成，待用户验收
- 来源：用户明确拍板 v0.4 要一步到位，引入本地后端服务 / 本地运行时 + SQLite 本地数据库文件，并要求先从 main 切出 `feature/v0.4-local-sqlite-storage`，本轮只做决策日志和技术方案。
- 执行者：Codex
- 当前分支：
  - `feature/v0.4-local-sqlite-storage`
- 分支操作：
  - `git status --short --branch`：工作区干净，当前 `main...origin/main`
  - `git checkout main`：已在 main，且与 `origin/main` 同步
  - `git pull origin main`：Already up to date
  - `git checkout -b feature/v0.4-local-sqlite-storage`：已切出新分支
- 改动文件：
  - `docs/v0.1/decision-log.md`
  - `docs/v0.1/progress.md`
  - `docs/v0.4/local-sqlite-storage-plan.md`
- 实现内容：
  - 新增 DEC-025：记录 v0.4 引入本地服务与 SQLite 数据库文件，推翻此前“纯浏览器、无后端、localStorage 存储”的技术边界，但不推翻“不接 AI API、不云同步、不自动操作 Boss”等产品边界。
  - 新增 v0.4 技术方案文档：明确目标 / 非目标、推荐架构、Tauri + SQLite 选择理由、备选方案取舍、数据库文件位置、备份策略、SQLite 表草案、localStorage 到 SQLite 迁移流程、失败回滚策略、验收标准、风险清单和后续任务拆分。
  - 更新当前进度：记录已从 main 切出 `feature/v0.4-local-sqlite-storage`，用户已拍板 v0.4 方向，本轮只完成决策日志和技术方案，不做实现。
- 自测命令：
  - `git diff -- docs`
  - `git status`
- 自测结果：
  - `git diff -- docs`：已执行，确认本轮只修改 docs 下内容；diff 显示 `docs/v0.1/decision-log.md` 新增 DEC-025、`docs/v0.1/progress.md` 更新 v0.4 进度记录。新建 `docs/v0.4/` 因尚未 staged，未出现在 `git diff` 正文中，由 `git status` 显示为 untracked。
  - `git status`：已执行，当前分支为 `feature/v0.4-local-sqlite-storage`；未 staged；修改 `docs/v0.1/decision-log.md`、`docs/v0.1/progress.md`，新增未跟踪目录 `docs/v0.4/`。
  - 文档检查脚本：未运行。`package.json` 仅有 `dev` / `build` / `preview` / `typecheck` / `selftest`，无 markdown lint 或 docs check 脚本。
- 类型检查：
  - 未运行。理由：本轮只修改文档，不修改 `src/`、`scripts/`、`package.json` 或任何源码 / 测试 / 配置。
- 红线自检：
  - 未安装 Tauri。
  - 未安装 SQLite 相关依赖。
  - 未修改 `package.json`。
  - 未修改核心业务代码。
  - 未修改 `src/storage` 实现。
  - 未写迁移代码。
  - 未写 Tauri command。
  - 未删除 localStorage 逻辑。
  - 未改 UI。
  - 未提交 commit。
  - 未 push 远程。
- 是否涉及 decision-log 更新：是，新增 DEC-025。
- 遗留风险：
  1. Tauri + SQLite 仍需后续 spike 验证开发环境、打包、插件稳定性和跨平台路径。
  2. SQLite schema 目前是草案，需在实现任务中通过迁移 selftest 校验。
  3. localStorage 坏数据迁移策略需在实现任务中明确阻断 / 跳过 / 记录错误的具体行为。
- 是否允许进入下一步：否。等待用户验收；下一步需先拆 v0.4 实现任务卡，再决定是否引入 Tauri / SQLite 依赖。
- 建议 commit message：docs: v0.4 本地 SQLite 存储方案开工

---

### 2026-06-26 · v0.4 · T1 Tauri + SQLite 技术 Spike

- 状态：阻塞，待补齐本机前置环境后重跑
- 来源：用户确认 v0.4 治理与技术方案通过后，要求先提交文档 commit，再进入 T1：验证 Tauri + SQLite 技术可行性，不接业务数据、不迁移 localStorage、不改现有页面业务逻辑。
- 执行者：Codex
- 文档 commit：
  - `794c2db docs: 确认 v0.4 本地 SQLite 存储方案`
- 改动文件：
  - `docs/v0.4/tauri-sqlite-spike.md`
  - `docs/v0.4/local-sqlite-storage-plan.md`
  - `docs/v0.1/progress.md`
- 实现内容：
  - 先提交已验收的 v0.4 决策日志与技术方案文档。
  - 执行 Tauri / SQLite 前置环境检查。
  - 新增 T1 Spike 记录文档，记录 Tauri 初始化未完成、SQLite 最小读写未执行、阻塞原因和后续重试条件。
  - 更新 v0.4 方案文档中的 T1 Spike 结果。
- 前置检查结果：
  - 当前分支：`feature/v0.4-local-sqlite-storage`
  - `node --version`：`v24.14.1`
  - `npm.cmd --version`：`11.11.0`
  - `npm --version`：PowerShell 执行策略阻止 `npm.ps1`，后续应使用 `npm.cmd`
  - `rustc --version`：未找到 `rustc`
  - `cargo --version`：未找到 `cargo`
  - `where.exe rustc`：未找到
  - `where.exe cargo`：未找到
  - `where.exe cl`：未找到 Microsoft C++ Build Tools 编译器
  - Visual Studio Installer / `vswhere`：未找到
  - `winget --version`：当前会话无法运行，报错“指定的登录会话不存在。可能已被终止。”
- Tauri 结果：
  - 未初始化成功。原因：缺少 Rust toolchain 和 Microsoft C++ Build Tools，Tauri Windows 开发环境无法启动或编译。
- SQLite 最小读写结果：
  - 未执行。原因：Tauri 运行时和 SQL 插件无法在当前前置环境下完成初始化与编译。
- 数据库文件实际路径：
  - 未创建实际数据库文件。
  - 计划路径仍为 `%APPDATA%/OfferFlow/offerflow.sqlite3`，待 T1 重跑时由 Tauri app data 目录实际确认。
- 方案选择：
  - 仍推荐 `Tauri v2 + tauri-plugin-sql + SQLite`。
  - 本轮未安装 Tauri / SQLite 依赖，未创建 `src-tauri/`，未修改 `package.json`；避免在缺少 Rust / C++ 编译工具时产生半工作脚手架。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run build`
  - `git status`
  - `git diff --stat`
- 自测结果：
  - `npm.cmd run typecheck`：通过，`vue-tsc --noEmit` 无错误。
  - `npm.cmd run build`：通过，Vite 成功构建；保留既有 chunk size warning（`assets/index-*.js` 超过 500 kB），不影响本轮验收。
  - Tauri 独立检查命令：未运行。原因：本轮未安装 Tauri CLI，且当前环境缺 Rust / Cargo / C++ Build Tools，Tauri 无法初始化或编译。
  - `git status --short --branch`：当前分支 `feature/v0.4-local-sqlite-storage`；修改 `docs/v0.1/progress.md`、`docs/v0.4/local-sqlite-storage-plan.md`，新增未跟踪文件 `docs/v0.4/tauri-sqlite-spike.md`。
  - `git diff --stat`：显示 `docs/v0.1/progress.md` 与 `docs/v0.4/local-sqlite-storage-plan.md` 共 94 行新增；未跟踪的 `docs/v0.4/tauri-sqlite-spike.md` 不在 diff stat 正文中。
- 红线自检：
  - 未修改 `src/storage/` 业务实现。
  - 未替换 localStorage。
  - 未写 localStorage -> SQLite 正式迁移逻辑。
  - 未改岗位页面、列表页、详情页 UI。
  - 未改数据模型业务字段。
  - 未做备份恢复 UI。
  - 未做 AI API / 云同步 / 账号 / 自动操作 Boss。
  - 未做大规模重构。
- 遗留风险：
  1. 本机缺 Rust / Cargo / C++ Build Tools，Tauri 无法实跑。
  2. 当前会话无法使用 winget 自动安装前置环境。
  3. 未验证 Tauri app data 实际路径和 `tauri-plugin-sql` SQLite 最小读写。
- 是否允许进入下一步：否。不建议进入 T2 storage adapter 设计；需要先补齐 Rust stable toolchain 与 Microsoft C++ Build Tools，然后重跑 T1。
- 建议 commit message：无。本轮 T1 Spike 改动不提交，等待用户验收。

---

### 2026-06-27 · v0.4 · T1 Tauri + SQLite 技术 Spike 重跑

- 状态：已完成，待用户验收
- 来源：用户确认 Rust / Cargo 已安装成功，MSVC Build Tools 已通过 `vswhere` 检测到，并要求在环境补齐后继续 T1：Tauri 初始化 + SQLite 最小读写验证。
- 执行者：Codex
- 当前分支：
  - `feature/v0.4-local-sqlite-storage`
- 关联文档 commit：
  - `7f787d0 docs: 记录 v0.4 T1 Tauri SQLite Spike 阻塞`
- 改动文件：
  - `package.json`
  - `package-lock.json`
  - `src-tauri/`
  - `docs/v0.1/decision-log.md`
  - `docs/v0.1/progress.md`
  - `docs/v0.4/local-sqlite-storage-plan.md`
  - `docs/v0.4/tauri-sqlite-spike.md`
- 实现内容：
  - 安装 Tauri v2 必要依赖：`@tauri-apps/api`、`@tauri-apps/plugin-sql`、`@tauri-apps/cli`。
  - 初始化 `src-tauri/`，应用标识设置为 `com.offerflow.local`。
  - 注册 `tauri-plugin-sql`，并在 Rust 侧启用 `sqlite` feature。
  - 引入 `rusqlite` + `bundled` feature，用于 T1 启动期最小 SQLite 文件读写验证。
  - 新增 Tauri command `sqlite_spike_check`，但本轮未接入现有页面。
  - 在 Tauri `setup` 阶段创建 / 打开 Spike 数据库文件，创建 `app_meta` 表，写入并读回 `schema_version=1`。
  - 将 Tauri dev 固定到 `http://127.0.0.1:5175` 并启用 `--strictPort`，避免 Vite 自动换端口。
  - 新增 DEC-026，记录 T1 依赖组合与 Spike 技术选择。
- 环境检查结果：
  - `node --version`：`v24.14.1`
  - `npm.cmd --version`：`11.11.0`
  - `rustc --version`：`rustc 1.96.0 (ac68faa20 2026-05-25)`
  - `cargo --version`：`cargo 1.96.0 (30a34c682 2026-05-25)`
  - `where.exe rustc`：`C:\Users\Administrator\.cargo\bin\rustc.exe`
  - `where.exe cargo`：`C:\Users\Administrator\.cargo\bin\cargo.exe`
  - `where.exe cl`：普通 PowerShell 中仍未找到
  - `vswhere`：`C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools`
  - `npm.cmd exec tauri -- info`：通过，确认 WebView2、MSVC、Rust toolchain、Tauri 包可用
- Tauri 结果：
  - 初始化成功。
  - `npm.cmd exec tauri -- dev` 启动成功。
  - Tauri app 成功运行到 `setup` 阶段并输出 SQLite Spike 日志。
- SQLite 最小读写结果：
  - 通过，稳定读回 `schema_version=1`。
  - 启动日志：

```txt
[OfferFlow T1 SQLite Spike] db_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-spike.sqlite3 schema_version=1
```

- 数据库文件实际路径：

```txt
C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-spike.sqlite3
```

- 文件检查结果：
  - `Test-Path`：`True`
  - `Length`：`12288 bytes`
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run build`
  - `cargo check`（在 `src-tauri/` 下）
  - `npm.cmd exec tauri -- info`
  - `npm.cmd exec tauri -- dev`
  - `git status --short --branch`
  - `git diff --stat`
- 自测结果：
  - `npm.cmd run typecheck`：通过，`vue-tsc --noEmit` 无错误。
  - `npm.cmd run build`：通过，Vite 构建成功；保留既有 chunk size warning。
  - `cargo check`：通过，Rust app 编译检查成功。
  - `npm.cmd exec tauri -- info`：通过，确认 Tauri 环境可用。
  - `npm.cmd exec tauri -- dev`：通过，Tauri app 启动并完成 SQLite Spike 读写。
- 红线自检：
  - 未修改 `src/storage/` 业务实现。
  - 未替换 localStorage。
  - 未写 localStorage -> SQLite 正式迁移逻辑。
  - 未改岗位页面、列表页、详情页 UI。
  - 未改业务数据模型字段。
  - 未做备份恢复 UI。
  - 未做 AI API / 云同步 / 账号 / 自动操作 Boss。
  - 未做大规模业务重构。
  - 未提交 T1 实装改动。
  - 未 push 远程。
- 遇到的问题：
  1. PowerShell 直接运行 `npm` 会触发 `npm.ps1` 执行策略限制，后续继续使用 `npm.cmd`。
  2. Rust / Cargo 安装后当前 shell PATH 未自动刷新，命令中临时加入 `%USERPROFILE%\.cargo\bin`。
  3. 普通 PowerShell 中 `where.exe cl` 仍找不到 `cl`，但 `vswhere`、`cargo check` 和 `tauri info` 已确认 MSVC 编译链可用。
  4. 首次或依赖变化后的 Tauri dev 编译耗时较长；后续无依赖变化时会更快。
  5. 首次运行时 Vite 自动从 5173 退到 5174，已改为 Tauri 专用 `127.0.0.1:5175 --strictPort`。
  6. `npm install` 报告 1 个 low severity vulnerability；本轮未执行 `npm audit fix`，避免引入额外依赖变更。
- 是否涉及 decision-log 更新：是，新增 DEC-026。
- 是否允许进入下一步：否。T1 已完成但等待用户验收；建议验收后进入 T2：storage adapter 设计。
- 建议 commit message：feat: 完成 v0.4 T1 Tauri SQLite 技术 Spike

---

### 2026-06-28 · v0.4 · T2 storage adapter 设计

- 状态：已完成，待用户验收
- 来源：用户确认 T1 结果验收通过，允许提交 T1，并要求进入 T2：storage adapter 设计；T2 只做设计，不做 localStorage 迁移，不替换现有业务存储，不改页面 UI。
- 执行者：Codex
- T1 commit：
  - `b2220ce chore: 完成 v0.4 T1 Tauri SQLite Spike`
- 改动文件：
  - `docs/v0.4/storage-adapter-design.md`
  - `docs/v0.1/progress.md`
- 实现内容：
  - 新增 v0.4 storage adapter 设计文档。
  - 梳理当前 `src/storage/` 现状：`StorageDriver`、`ConfigStore`、`JobStore`、keys、defaults、legacy namespace migration 和 `useStores()` 当前调用路径。
  - 设计未来分层：`Vue Pages -> App Stores / Composables -> Storage Port -> LocalStorage Adapter / SQLite Adapter -> Browser localStorage / Tauri SQLite Commands`。
  - 给出文档级接口草案：`StoragePort`、`ProfileRepository`、`JobRepository`、`StorageMetaRepository`、`JobListQuery`。
  - 明确 profile 读写、job CRUD、`listJobs` 排序 / 筛选字段来源、错误处理策略。
  - 明确 SQLite 写入时“完整对象 `data_json` + 独立索引列”必须由同一个 normalized record 派生，并在同一事务内写入。
  - 明确页面不能直接调用 Tauri command，Tauri command 只能被 SQLite adapter 或更底层 client 使用。
  - 明确 LocalStorage Adapter 和 SQLite Adapter 分工，以及 T3 / T4 / T5 / T6 后续拆分建议。
- 是否新增 TypeScript 接口文件：
  - 否。T2 仅在文档中提供接口草案；没有新增 TS 文件，避免提前改运行调用链。
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run build`
  - `cargo check`（在 `src-tauri/` 下）
  - `git status`
  - `git diff --stat`
- 自测结果：
  - `npm.cmd run typecheck`：通过，`vue-tsc --noEmit` 无错误。
  - `npm.cmd run build`：通过，Vite 构建成功；保留既有 chunk size warning。
  - `cargo check`：通过，Rust / Tauri 侧编译检查成功。
- 红线自检：
  - 未修改现有页面。
  - 未修改现有 `src/storage/` 运行逻辑。
  - 未替换 localStorage。
  - 未写正式 SQLite Store。
  - 未写 localStorage -> SQLite 迁移。
  - 未写备份恢复逻辑。
  - 未删除旧数据。
  - 未改 `JobRecord` 字段含义。
  - 未做云同步、AI API、账号、多端或 Boss 自动化。
  - 未 push 远程。
- 是否涉及 decision-log 更新：否。T2 未新增依赖、未改 schema、未改存储运行策略；DEC-025 / DEC-026 已覆盖 v0.4 本地 SQLite 路线和 T1 依赖选择。
- 是否允许进入下一步：否。等待用户验收 T2；建议验收后进入 T3：SQLite schema 与基础 repository 实现。
- 建议 commit message：docs: 完成 v0.4 T2 storage adapter 设计

---

### 2026-06-28 · v0.4 · T3 SQLite schema 与基础 repository 实现

- 状态：已完成，待用户验收
- 来源：用户确认 T2 storage adapter 设计验收通过，允许提交 T2，并要求进入 T3：SQLite schema 与基础 repository 实现；T3 只做 SQLite 侧地基层，不接入现有业务页面，不迁移 localStorage。
- 执行者：Codex
- T2 commit：
  - `0997b2b docs: 完成 v0.4 T2 存储适配层设计`
- 改动文件：
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/sqlite/mod.rs`
  - `src-tauri/src/sqlite/database.rs`
  - `src-tauri/src/sqlite/error.rs`
  - `src-tauri/src/sqlite/models.rs`
  - `src-tauri/src/sqlite/repository.rs`
  - `src-tauri/src/sqlite/schema.rs`
  - `docs/v0.4/sqlite-schema-repository.md`
  - `docs/v0.1/progress.md`
- 实现内容：
  - 新增 SQLite schema 初始化模块，创建 `app_meta`、`profiles`、`jobs`、`migration_logs`、`backup_logs`。
  - 写入 SQLite `PRAGMA user_version = 1`，并通过 `app_meta.schema_version=1` 提供应用层可读 schema version。
  - 新增数据库路径与打开初始化逻辑，T3 smoke 数据库文件为 `offerflow-t3.sqlite3`。
  - 新增基础 repository：`set_app_meta` / `get_app_meta`、`upsert_profile` / `get_profile`、`upsert_job` / `get_job` / `list_jobs_by_updated_desc` / `delete_job`。
  - repository 写入遵守“完整对象 -> derive indexed columns -> 写入独立列和 `data_json`”策略，调用方不传第二套可能冲突的列数据。
  - 新增 Rust 侧 `StorageError`，区分数据库打开、schema 初始化、JSON 序列化 / 反序列化、写入、查询和记录不存在。
  - 新增 Tauri command `sqlite_t3_check` 和启动期 T3 repository smoke；未接入页面。
  - 新增 T3 技术文档，记录 schema、repository、一致性策略、错误处理、验证结果和后续 T4 建议。
- 数据库文件实际路径：
  - `C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t3.sqlite3`
- 自测命令：
  - `npm.cmd run typecheck`
  - `npm.cmd run build`
  - `cargo check`（在 `src-tauri/` 下）
  - `cargo test`（在 `src-tauri/` 下）
  - `npm.cmd exec tauri -- dev`
  - `git status`
  - `git diff --stat`
- 自测结果：
  - `npm.cmd run typecheck`：通过，`vue-tsc --noEmit` 无错误。
  - `npm.cmd run build`：通过，Vite 构建成功；保留既有 chunk size warning。
  - `cargo check`：通过，Rust / Tauri 侧编译检查成功。
  - `cargo test`：通过，3 个 Rust 单元测试通过。
  - `npm.cmd exec tauri -- dev`：通过，Tauri app 启动并输出 T3 repository smoke 日志，`schema_version=1`、profile upsert/get、job upsert/get/list/delete 均通过。
- Tauri dev smoke 日志：

```txt
[OfferFlow T3 SQLite Repository] db_path=C:\Users\Administrator\AppData\Roaming\com.offerflow.local\offerflow-t3.sqlite3 schema_version=1 profile_id=default job_id=t3-smoke-job-new listed_jobs=t3-smoke-job-new,t3-smoke-job-old remaining_jobs=0
```

- 红线自检：
  - 未修改现有 Vue 页面。
  - 未修改现有 `src/storage/` 运行逻辑。
  - 未替换 localStorage。
  - 未读取真实 localStorage 数据。
  - 未写 localStorage -> SQLite 迁移。
  - 未写备份恢复 UI。
  - 未删除旧数据。
  - 未改 `JobRecord` / `Profile` 字段含义。
  - 未做 AI API / BYOK / 云同步 / 账号 / Boss 自动化。
  - 未 push 远程。
- 是否涉及 decision-log 更新：否。T3 按 DEC-025 / DEC-026 和 T2 设计落地既定 SQLite 地基层；未新增依赖、未推翻既有产品边界、未改业务模型含义。
- 是否允许进入下一步：否。等待用户验收 T3；建议验收后进入 T4：localStorage JSON 备份导出。
- 建议 commit message：chore: 完成 v0.4 T3 SQLite schema 与基础 repository

---

### 2026-06-28 · v0.4 · T4 localStorage JSON 备份导出

- 状态：已完成，待用户验收
- 来源：用户确认 T3 SQLite schema 与基础 repository 验收通过，允许提交 T3，并要求进入 T4：localStorage JSON 备份导出；T4 只做迁移前 JSON 备份安全绳，不执行正式迁移、不替换现有业务存储、不改业务页面。
- 执行者：Codex
- T3 commit：
  - `ff52669 feat: 完成 v0.4 T3 SQLite schema 与基础 repository`
- 改动文件：
  - `src/app/legacyLocalStorageBackup.ts`
  - `scripts/localStorageBackup.selftest.ts`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/sqlite/mod.rs`
  - `src-tauri/src/sqlite/error.rs`
  - `src-tauri/src/sqlite/backup.rs`
  - `docs/v0.4/localstorage-backup.md`
  - `docs/v0.1/progress.md`
- 实现内容：
  - 新增前端纯函数 `createLegacyLocalStorageBackupPayload(driver, options?)`，扫描 `offerflow:profile`、`offerflow:job:*`、`offerpilot:profile`、`offerpilot:job:*`。
  - 生成 backup payload，包含 `backupVersion`、`createdAt`、`source`、`namespace`、`namespaces`、`profile`、`profiles`、`jobs`、`rawEntries`、`counts`、`warnings`、`checksum`。
  - JSON parse 成功的 profile/job 进入结构化字段；坏 JSON 不进入结构化字段，但原始 value 保留在 `rawEntries`，并写入 warning。
  - 新增 Rust/Tauri backup 模块，接收 `payload_json`，写入 app data 下 `backups/` 目录。
  - Rust 写入侧生成 checksum，使用轻量 Rust 依赖 `sha2` 生成 SHA-256，格式为 `sha256:<64位hex>`；checksum 计算来源为 checksum 置 null 后的 payload JSON。
  - 写入成功后记录 `backup_logs.backup_type=localstorage_json`、`status=succeeded`、path、profile/job/raw entry 数量、size、checksum 和 data_json。
  - 新增 Tauri command `write_localstorage_backup`，但未接入页面。
  - Tauri dev smoke 只写测试 payload，不读取真实 localStorage、不执行迁移。
- backup 文件实际路径：
  - `C:\Users\Administrator\AppData\Roaming\com.offerflow.local\backups\offerflow-localstorage-backup-20260629-050113.json`
- backup_logs 记录摘要：
  - `backup_log_id=localstorage-json-1782709273-3d2e119d1232a6eb6423c8533661591af336849b0db7ad51418b6dbe039b3fca`
  - `backup_type=localstorage_json`
  - `status=succeeded`
  - `profile_count=1`
  - `job_count=1`
  - `raw_entries=2`
  - `size_bytes=1306`
  - `checksum=sha256:3d2e119d1232a6eb6423c8533661591af336849b0db7ad51418b6dbe039b3fca`
- 备份文件读回检查：
  - `Exists=True`
  - `BackupVersion=1`
  - `Source=localStorage`
  - `Profiles=1`
  - `Jobs=1`
  - `RawEntries=2`
  - `Checksum=sha256:3d2e119d1232a6eb6423c8533661591af336849b0db7ad51418b6dbe039b3fca`
  - `Warnings=0`
- 自测命令：
  - `npm.cmd exec tsx -- scripts/localStorageBackup.selftest.ts`
  - `npm.cmd run typecheck`
  - `npm.cmd run build`
  - `cargo check`（在 `src-tauri/` 下）
  - `cargo test`（在 `src-tauri/` 下）
  - `npm.cmd exec tauri -- dev`
  - `git status`
  - `git diff --stat`
- 自测结果：
  - `localStorageBackup.selftest`：通过，11 passed, 0 failed。
  - `npm.cmd run typecheck`：通过，`vue-tsc --noEmit` 无错误。
  - `npm.cmd run build`：通过，Vite 构建成功；保留既有 chunk size warning。
  - `cargo check`：通过，Rust / Tauri 侧编译检查成功。
  - `cargo test`：通过，5 个 Rust 单元测试通过。
  - `npm.cmd exec tauri -- dev`：通过，T3 repository smoke 与 T4 backup smoke 均输出成功日志。
- 红线自检：
  - 未执行 localStorage -> SQLite 正式迁移。
  - 未写 `migration_logs` 正式迁移记录。
  - 未写 `migration_status=migrated`。
  - 未删除或修改 localStorage 旧数据。
  - 未替换现有 `ConfigStore` / `JobStore`。
  - 未改 Vue 页面。
  - 未做备份恢复 UI。
  - 未做 AI API / BYOK / 云同步 / 账号 / Boss 自动化。
  - 未 push 远程。
- 是否涉及 decision-log 更新：否。T4 按 DEC-025 的迁移前备份要求落地，不新增依赖、不推翻既有存储策略、不执行正式迁移；checksum 使用无新增依赖的实现，已在 T4 文档说明。
- 是否允许进入下一步：否。等待用户验收 T4；建议验收后进入 T5：localStorage -> SQLite 迁移。
- 建议 commit message：feat: 完成 v0.4 T4 localStorage JSON 备份导出

---

### 2026-06-29 · v0.4 · T5 localStorage -> SQLite 迁移

- 状态：已完成，待用户验收
- 来源：用户确认 T4 备份 payload / rawEntries / warnings / backup_logs / 边界均验收通过；提交前要求 checksum 升级为 `sha256`，随后提交 T4，并进入 T5：localStorage -> SQLite 正式迁移流程。
- 执行者：Codex
- T4 commit：
  - `624fbce feat: 完成 v0.4 T4 localStorage JSON 备份导出`
- 改动文件：
  - `src/app/localStorageSqliteMigration.ts`
  - `scripts/localStorageMigration.selftest.ts`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/sqlite/mod.rs`
  - `src-tauri/src/sqlite/migration.rs`
  - `docs/v0.4/localstorage-to-sqlite-migration.md`
  - `docs/v0.1/progress.md`
- 实现内容：
  - 新增前端纯函数 `createLocalStorageSqliteMigrationPayload(backup, options?)`，基于 T4 backup payload 派生迁移输入。
  - 新增前端纯函数 `markSqliteMigrationDone(driver)`，只写 `offerflow:migration:sqlite:v0.4=done`，不删除旧 key。
  - namespace 冲突策略：profile / job 同时存在 `offerflow:*` 和 `offerpilot:*` 时优先 `offerflow:*`，并写入 warnings。
  - T4 parse warnings 会带入 T5 migration warnings，坏数据不静默丢弃。
  - 新增 Tauri command `migrate_localstorage_to_sqlite`。
  - Rust 侧事务写入 `profiles` / `jobs`，独立列由完整对象派生，完整对象写入 `data_json`。
  - 写入 `migration_logs.status=succeeded`、`app_meta.migration_status=migrated` 和 `app_meta.last_successful_migration_id`。
  - 校验失败时回滚 profile/job 写入，尽量写入 `migration_logs.status=failed`，不写 migrated 状态。
  - 写入 `jobs.data_json` 前移除派生决策字段：`strategy`、`nextAction`、`stopLoss`、`scenario`、`companyWarning`。
  - T3 repository smoke 在持久数据库中只校验本次 T3 fixture 的两个 job 相对顺序，避免被 T5 smoke 写入的迁移测试数据影响。
- backup 文件路径：
  - T5 smoke 使用 T4 smoke 备份文件：`C:\Users\Administrator\AppData\Roaming\com.offerflow.local\backups\offerflow-localstorage-backup-20260629-051752.json`
- migration_logs 摘要：
  - `migration_id=localstorage-to-sqlite-1782710272000-1111111111111111111111111111111111111111111111111111111111111111`
  - `migration_type=localstorage_to_sqlite`
  - `status=succeeded`
  - `profile_count_before=1`
  - `job_count_before=2`
  - `profile_count_after=1`
  - `job_count_after=2`
  - `checksum_before=sha256:1111111111111111111111111111111111111111111111111111111111111111`
- app_meta 迁移状态：
  - `migration_status=migrated`
  - `last_successful_migration_id=<migration_id>`
- localStorage done 标记：
  - `offerflow:migration:sqlite:v0.4=done`
  - 由 `scripts/localStorageMigration.selftest.ts` 验证；旧 profile/job key 未删除。
- 自测命令：
  - `npm.cmd exec tsx -- scripts/localStorageBackup.selftest.ts`
  - `npm.cmd exec tsx -- scripts/localStorageMigration.selftest.ts`
  - `npm.cmd run typecheck`
  - `npm.cmd run build`
  - `cargo check`（在 `src-tauri/` 下）
  - `cargo test`（在 `src-tauri/` 下）
  - `npm.cmd exec tauri -- dev`
  - `git status`
  - `git diff --stat`
- 自测结果：
  - `localStorageBackup.selftest`：通过，11 passed, 0 failed。
  - `localStorageMigration.selftest`：通过，12 passed, 0 failed。
  - `npm.cmd run typecheck`：通过，`vue-tsc --noEmit` 无错误。
  - `npm.cmd run build`：通过，Vite 构建成功；保留既有 chunk size warning。
  - `cargo check`：通过，无 warning。
  - `cargo test`：通过，7 个 Rust 单元测试通过。
  - `npm.cmd exec tauri -- dev`：通过，T3/T4/T5 smoke 均输出成功日志。
- 红线自检：
  - 未删除任何旧 localStorage 数据。
  - 未替换现有 `ConfigStore` / `JobStore`。
  - 未修改 `src/storage/` 现有运行逻辑。
  - 未改 Vue 页面。
  - 未做自动启动迁移 UI。
  - 未做恢复 UI。
  - 未做云同步 / AI API / 账号 / Boss 自动化。
  - 未 push 远程。
- 是否涉及 decision-log 更新：否。T5 按 DEC-025 迁移红线和 T4 备份安全绳落地，未新增产品边界、未替换运行存储、未删除旧数据；checksum 升级为 SHA-256 是用户本轮明确裁定。
- 是否允许进入下一步：否。等待用户验收 T5；建议验收后进入 T6：迁移校验强化与失败回滚测试。
- 建议 commit message：feat: 完成 v0.4 T5 localStorage 到 SQLite 迁移

---

### 2026-06-29 · v0.4 · T6 迁移校验强化与失败回滚测试

- 状态：已完成，待用户验收
- 来源：用户确认 T5 通过并要求先提交 T5，再进入 T6：强化迁移失败路径、校验边界、幂等行为和回滚测试，确保 T5 迁移链路不是只在 happy path 成功。
- 执行者：Codex
- T5 commit：
  - `f2268d2 feat: 完成 v0.4 T5 localStorage 到 SQLite 迁移`
- 改动文件：
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/sqlite/error.rs`
  - `src-tauri/src/sqlite/migration.rs`
  - `scripts/localStorageMigration.selftest.ts`
  - `docs/v0.4/migration-validation-rollback.md`
  - `docs/v0.1/progress.md`
- 实现内容：
  - 新增 Rust 错误码 `already_migrated`，当 `app_meta.migration_status=migrated` 已存在时默认拒绝重复迁移。
  - Tauri migration command 返回结构化 `StorageErrorPayload`，保留错误码给后续 adapter 识别。
  - T5 dev smoke 改用独立 T5 smoke SQLite 文件，避免重复启动时被正式幂等策略挡住。
  - `migration_logs.data_json` 在失败记录中写入 `errorCode`，便于失败摘要排查。
  - Rust 侧新增重复 job id 校验，防止迁移数量与实际落库数量不一致。
  - Rust 单元测试覆盖 missing checksum、profile 写失败、job 中途失败、校验失败、重复迁移 already_migrated 和既有 happy path。
  - 前端 selftest 覆盖 backup failure gate、T4 parse warning 传递、坏 JSON raw value 保留、namespace 冲突、done 标记重复写与 done 写失败。
  - 新增 T6 文档 `docs/v0.4/migration-validation-rollback.md`，记录 A-H 失败场景、策略和覆盖测试。
- repeated migration / already_migrated 策略：
  - 默认拒绝重复迁移，返回 `already_migrated`。
  - 不覆盖既有 SQLite 数据。
  - 不写第二条 failed migration log。
  - 不新增第二个 done 标记。
  - force remigrate 不在 T6 默认实现范围内。
- rollback 策略：
  - profile/job 写入和 succeeded log / migrated meta 位于同一 SQLite transaction。
  - 任一步失败时 transaction 回滚，profile/job 不部分保留。
  - transaction 外尽量写入 `migration_logs.status=failed`。
  - 不写 `app_meta.migration_status=migrated`。
  - 前端不写 done 标记，旧 localStorage 保持不动。
- 自测命令：
  - `npm.cmd exec tsx -- scripts/localStorageBackup.selftest.ts`
  - `npm.cmd exec tsx -- scripts/localStorageMigration.selftest.ts`
  - `npm.cmd run typecheck`
  - `npm.cmd run build`
  - `cargo check`（在 `src-tauri/` 下）
  - `cargo test`（在 `src-tauri/` 下）
  - `npm.cmd exec tauri -- dev`
  - `git status`
  - `git diff --stat`
- 自测结果：
  - `localStorageBackup.selftest`：通过，11 passed, 0 failed。
  - `localStorageMigration.selftest`：通过，21 passed, 0 failed。
  - `npm.cmd run typecheck`：通过，`vue-tsc --noEmit` 无错误。
  - `npm.cmd run build`：通过，Vite 构建成功；保留既有 chunk size warning。
  - `cargo check`：通过。
  - `cargo test`：通过，12 个 Rust 单元测试通过。
  - `npm.cmd exec tauri -- dev`：通过，T3/T4/T5 smoke 均输出成功日志；T5 smoke 使用独立 T5 smoke SQLite 文件，避免重复启动时触发正式 already_migrated 策略。
- 红线自检：
  - 未替换现有 `ConfigStore` / `JobStore`。
  - 未修改 `src/storage/` 现有运行逻辑。
  - 未改 Vue 页面。
  - 未做自动启动迁移 UI。
  - 未删除 localStorage。
  - 未做恢复 UI。
  - 未做云同步 / AI API / 账号 / Boss 自动化。
  - 未 push 远程。
- 是否涉及 decision-log 更新：否。T6 落地用户已明确的迁移可靠性要求和重复迁移默认拒绝策略，未新增产品边界、未替换运行存储、未删除旧数据。
- 是否允许进入下一步：否。等待用户验收 T6；建议验收后进入 T7：SQLite adapter 接入 ConfigStore / JobStore。
- 建议 commit message：test: 强化 v0.4 localStorage 到 SQLite 迁移回滚测试

---

### 2026-06-29 · v0.4 · T7 SQLite adapter 接入 ConfigStore / JobStore

- 状态：已完成，待用户验收
- 来源：用户确认 T6 通过并要求先提交 T6，再进入 T7：让 OfferFlow 具备 SQLite 版 ConfigStore / JobStore 适配能力，但不自动切换生产默认存储、不自动迁移、不改页面业务流程。
- 执行者：Codex
- T6 commit：
  - `e7eb3f7 test: 强化 v0.4 T6 迁移校验与回滚`
- 改动文件：
  - `src/storage/ports.ts`
  - `src/storage/localStorageRepositories.ts`
  - `src/storage/sqliteClient.ts`
  - `src/storage/sqliteRepositories.ts`
  - `src/storage/index.ts`
  - `src/app/stores.ts`
  - `scripts/storageAdapter.selftest.ts`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/sqlite/mod.rs`
  - `src-tauri/src/sqlite/adapter.rs`
  - `docs/v0.4/sqlite-adapter-integration.md`
  - `docs/v0.1/progress.md`
- 实现内容：
  - 新增 async storage port：`ProfileRepository`、`JobRepository`、`AsyncOfferFlowStores`、`StorageBackend`。
  - 新增 localStorage async adapter，包装现有 `ConfigStore` / `JobStore`，不修改旧同步 store 行为。
  - 新增 `TauriSQLiteClient`，封装 Tauri `sqlite_*` commands，避免页面直接调用 Tauri command。
  - 新增 SQLite profile/job repositories；`createJob()` 生成完整默认字段，`updateJob()` 采用先读后合并 patch 的语义，避免丢失已有 `data_json` 字段。
  - `src/app/stores.ts` 保留现有 `useStores()` 默认 localStorage 行为，新增 `createAsyncStores({ backend })` 作为未来受控切换入口。
  - 新增 Tauri commands：`sqlite_get_profile`、`sqlite_save_profile`、`sqlite_clear_profile`、`sqlite_create_job`、`sqlite_get_job`、`sqlite_list_jobs`、`sqlite_update_job`、`sqlite_delete_job`。
  - 新增 Rust adapter 写入逻辑，仍从完整 JSON 派生 SQLite 独立索引列，调用方不传第二套列数据。
  - 新增 T7 adapter smoke，使用独立 `offerflow-t7-adapter-smoke-*.sqlite3` 文件，不污染正式数据。
  - 新增 T7 文档 `docs/v0.4/sqlite-adapter-integration.md`。
- 默认 backend 策略：
  - 浏览器 Web 模式继续默认 localStorage。
  - Tauri 桌面模式允许 SQLite adapter smoke / 手动指定 SQLite backend。
  - 正式默认切换留到 T8 或单独验收。
  - T7 不自动触发迁移，也不因运行在 Tauri 中就自动切换用户数据 backend。
- Tauri commands 摘要：
  - profile：get / save / clear。
  - jobs：create / get / list / update / delete。
  - commands 只做数据访问边界，不做页面业务判断；错误返回沿用 T6 的 `StorageErrorPayload`。
- 自测命令：
  - `npm.cmd exec tsx -- scripts/localStorageBackup.selftest.ts`
  - `npm.cmd exec tsx -- scripts/localStorageMigration.selftest.ts`
  - `npm.cmd exec tsx -- scripts/storageAdapter.selftest.ts`
  - `npm.cmd run typecheck`
  - `npm.cmd run build`
  - `cargo check`（在 `src-tauri/` 下）
  - `cargo test`（在 `src-tauri/` 下）
  - `npm.cmd exec tauri -- dev`
  - `git status`
  - `git diff --stat`
- 自测结果：
  - `localStorageBackup.selftest`：通过，11 passed, 0 failed。
  - `localStorageMigration.selftest`：通过，21 passed, 0 failed。
  - `storageAdapter.selftest`：通过，14 passed, 0 failed。
  - `npm.cmd run typecheck`：通过，`vue-tsc --noEmit` 无错误。
  - `npm.cmd run build`：通过，Vite 构建成功；保留既有 chunk size warning。
  - `cargo check`：通过。
  - `cargo test`：通过，13 个 Rust 单元测试通过。
  - `npm.cmd exec tauri -- dev`：通过，T3/T4/T5/T7 smoke 均输出成功日志。
  - T7 smoke 摘要：`profile_target_city=Suzhou`、`listed_jobs=t7-smoke-job-new,t7-smoke-job-old`、`updated_match_score=91`、`patch_preserved_ai_raw=true`、`deleted_job_missing=true`。
- 红线自检：
  - 未自动执行 localStorage -> SQLite 迁移。
  - 未删除任何 localStorage 数据。
  - 未默认强制切换到 SQLite。
  - 未改 Vue 页面业务流程。
  - 未做迁移 UI。
  - 未做备份恢复 UI。
  - 未做云同步 / AI API / 账号 / Boss 自动化。
  - 未 push 远程。
- 是否涉及 decision-log 更新：否。T7 是 DEC-025 / DEC-026 已批准的本地 SQLite 存储底座落地，不新增产品边界；默认 backend 仍保持 localStorage，不推翻既有运行策略。
- 是否允许进入下一步：否。等待用户验收 T7；建议验收后进入 T8：受控切换 SQLite backend / 启动迁移入口设计。
- 建议 commit message：feat: 接入 v0.4 SQLite storage adapter

---

### 2026-06-29 · v0.4 · T8 受控切换 SQLite backend / 启动迁移入口设计

- 状态：已完成，待用户验收
- 来源：用户确认 T7 通过并要求先提交 T7，再进入 T8：让 OfferFlow 具备“明确、可控、可回退”的 SQLite backend 启用机制。
- 执行者：Codex
- T7 commit：
  - `dedfc29 feat: 完成 v0.4 T7 SQLite 存储适配器接入`
- 改动文件：
  - `src/storage/runtimeEnv.ts`
  - `src/storage/backendSelection.ts`
  - `src/storage/sqliteClient.ts`
  - `src/storage/index.ts`
  - `src/app/stores.ts`
  - `src/app/controlledSqliteMigration.ts`
  - `scripts/backendSwitch.selftest.ts`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/sqlite/adapter.rs`
  - `docs/v0.4/sqlite-backend-switch.md`
  - `docs/v0.1/progress.md`
- 实现内容：
  - 新增 runtime 检测：区分 `web` / `tauri`。
  - 新增 backend key：`offerflow:storage:backend = localStorage | sqlite`。
  - 新增 backend selection 状态机：`localStorage_only`、`sqlite_available`、`sqlite_ready`、`migration_required`、`migration_running`、`migration_succeeded`、`migration_failed`、`already_migrated`、`sqlite_active`、`fallback_localStorage`。
  - 新增 `resolveStorageBackend()`：Web 始终 active localStorage；Tauri 只有显式 `backend=sqlite` 且 `app_meta.migration_status=migrated` 才 active SQLite。
  - 新增 `initializeStorageBackend()`：返回 resolution + async stores；现有 `useStores()` 旧同步入口不变。
  - 新增 Tauri command `sqlite_get_storage_migration_status`，读取 `app_meta.migration_status` 与最新 `migration_logs.status`。
  - 新增受控迁移入口 `runControlledLocalStorageToSqliteMigration()`：先 T4 backup，再 T5 migration，成功后写 done marker 和 `backend=sqlite`。
  - 受控迁移失败时不写 `backend=sqlite`、不写 done marker、不删除旧 localStorage。
  - `already_migrated` 时不重复 backup / migration；done marker 成功后可写 `backend=sqlite`。
  - done marker 失败返回 `done_marker_failed`，不写 `backend=sqlite`，旧 localStorage 保持不动。
  - 新增 T8 文档 `docs/v0.4/sqlite-backend-switch.md`。
- sqlite_active 判定条件：
  - runtime 必须是 Tauri。
  - localStorage 明确存在 `offerflow:storage:backend=sqlite`。
  - SQLite `app_meta.migration_status=migrated`。
  - 三者缺一则不判定为 `sqlite_active`。
- 失败回退策略：
  - Web 模式或 SQLite 不可用：`fallback_localStorage`。
  - 显式 sqlite 但未 migrated：`migration_required`，active backend 仍 localStorage。
  - 最近 migration failed：`migration_failed`，active backend 仍 localStorage。
  - backup / migration / done marker 任一步失败：不写 `backend=sqlite`，不删除旧 localStorage。
- 自测命令：
  - `npm.cmd exec tsx -- scripts/localStorageBackup.selftest.ts`
  - `npm.cmd exec tsx -- scripts/localStorageMigration.selftest.ts`
  - `npm.cmd exec tsx -- scripts/storageAdapter.selftest.ts`
  - `npm.cmd exec tsx -- scripts/backendSwitch.selftest.ts`
  - `npm.cmd run typecheck`
  - `npm.cmd run build`
  - `cargo check`（在 `src-tauri/` 下）
  - `cargo test`（在 `src-tauri/` 下）
  - `npm.cmd exec tauri -- dev`
  - `git status`
  - `git diff --stat`
- 自测结果：
  - `localStorageBackup.selftest`：通过，11 passed, 0 failed。
  - `localStorageMigration.selftest`：通过，21 passed, 0 failed。
  - `storageAdapter.selftest`：通过，14 passed, 0 failed。
  - `backendSwitch.selftest`：通过，22 passed, 0 failed。
  - `npm.cmd run typecheck`：通过，`vue-tsc --noEmit` 无错误。
  - `npm.cmd run build`：通过，Vite 构建成功；保留既有 chunk size warning。
  - `cargo check`：通过。
  - `cargo test`：通过，13 个 Rust 单元测试通过。
  - `npm.cmd exec tauri -- dev`：本轮补跑已发起，命令在 120 秒内未自然结束，随后清理了由本次命令残留的 npm / tauri / vite / esbuild 进程；未取得完整 Tauri dev smoke 通过结论。已有 `cargo check` / `cargo test` 验证 Rust/Tauri 命令可编译，仍需在环境允许时补跑 Tauri dev smoke。
- 红线自检：
  - 未默认自动迁移真实用户数据。
  - 未启动应用时无提示直接迁移。
  - 未删除任何 localStorage 数据。
  - 未默认强制切 SQLite。
  - 未改 Vue 页面业务 UI。
  - 未做完整迁移设置页。
  - 未做备份恢复 UI。
  - 未做云同步 / AI API / 账号 / Boss 自动化。
  - 未 push 远程。
- 是否涉及 decision-log 更新：否。T8 落地用户明确要求的受控 backend 启用机制，未新增产品边界，未默认切 SQLite，未删除旧数据。
- 是否允许进入下一步：否。等待用户验收 T8；建议验收后进入 T9：桌面模式最小 UI / 数据迁移确认入口。
- 建议 commit message：feat: 新增 v0.4 SQLite backend 受控切换机制
