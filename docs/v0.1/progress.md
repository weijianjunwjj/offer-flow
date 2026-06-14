# OfferPilot / 求职作战台 v0.1 开发进度记录

## 1. 文档用途

本文档用于记录 OfferPilot v0.1 的真实开发进度。

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

> OfferPilot / 求职作战台

仓库名称：

> offerpilot

当前版本：

> v0.1

当前模式：

> Manual Mode

当前阶段：

> Task 3：岗位主战场基础信息 + 保存。CC 已完成实现，Codex 已审查通过，待用户确认。

当前是否允许进入下一步：

> 否。需用户确认 Task 3 通过后，才能进入 Task 4。

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
| Step 3 | 岗位主战场基础信息 + 保存 | 待用户确认 | CC | Codex | 未确认 | Codex 已审查通过；5 字段录入、新建、编辑、刷新持久化符合 Task 3 验收 |
| Step 4 | Prompt 生成 + 复制 | 未开始 | 待定 | 待定 | 未确认 | 不接 API，只生成 Prompt |
| Step 5 | AI 结果兜底承接 | 未开始 | 待定 | 待定 | 未确认 | 原文必存，结构化尽力 |
| Step 6 | 报告展示 + Boss 话术编辑 | 未开始 | 待定 | 待定 | 未确认 | 话术可编辑、可复制 |
| Step 7 | 沟通状态流转 | 未开始 | 待定 | 待定 | 未确认 | 手动状态，不做日志系统 |
| Step 8 | 回看闭环 + 文案收口 | 未开始 | 待定 | 待定 | 未确认 | 避免“自动 AI”误解 |

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
- 建议 commit message：chore: 初始化 OfferPilot v0.1 项目骨架并导入 Step 0 storage 与 selftest

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
  - 浏览器自测：保存后 localStorage 仅 1 个 key `offerpilot:profile`，9 字段与类型（含 boolean、growth 枚举）全部正确；刷新后 9 字段完整回显，保存反馈正确不持久化；坏数据时显示错误横幅、表单仍正常渲染
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

- 状态：待用户确认（CC 已完成实现，Codex 已审查通过）
- 执行者：CC
- 审查者：Codex（已审查通过）
- 用户确认：未确认
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
- 是否允许进入下一步：否。需用户确认后，方可进入 Task 4
- 建议 commit message：feat: 实现岗位主战场基础信息录入与保存闭环
