# OfferFlow v0.8 · V8-2 岗位雷达真实浏览器验收 Runbook

> **适用范围：** RC-01 / RC-02 / RC-03 的 Playwright 扩展 E2E、普通 Chrome 人工 BOSS Preview 与只读 session/数据库核验。
> **前置边界：** 本流程只使用系统临时目录中的独立 v7 SQLite 库，绝不指向真实生产库
> （`data/offerflow.sqlite3`），不启用真实入口 Radar，不升级真实数据库。
>
> **工具边界：** ChatGPT Chrome Extension 不可用且不是 OfferFlow 产品依赖，不得作为自动验收、
> 人工验收、checkpoint commit、V8-2 收口或 schema v7 激活评估的阻塞条件。普通页面通用降级与
> OfferFlow 未启动错误由 Playwright 确定性验证；真实 BOSS 登录态点击仅由用户在普通 Chrome 完成。

---

## 0. 已由自动化覆盖的部分（无需人工重复）

【自动化已验证】以下由 HTTP + 临时 v7 库、路由测试和 MV3 Playwright E2E 覆盖：

- 扩展 `browser` session：加 Capture Item → 预览 → 纠错 → 确认写入 → 幂等重复提交；
- 确认写入后临时库出现 `radar_capture_snapshots/source_records/candidates/candidate_versions/candidate_sources`，且 `jobs/applications/feedback_events` 均为 0；
- 普通 fixture 页面由真实 MV3 action popup 触发 generic visible-text fallback 并进入受控 Preview；
- 隔离的未监听 loopback 端口返回明确的 OfferFlow 不可连接提示，不产生 session 或残留注入 UI；
- 预览页（`RadarImportPage`）只渲染扩展创建的会话、预览条目与确认卡片，不含手工 JD 输入。

人工验收只聚焦于**普通 Chrome 中真实 BOSS 批量 Preview**；不再人工重复通用页或服务离线测试。

---

## 1. 启动隔离沙箱

扩展正式构建的本机地址为 `http://127.0.0.1:17365`。Playwright 会复制临时扩展并使用隔离端口/受控拦截，绝不停止或访问用户正在运行的真实 OfferFlow。

1. 构建扩展（生成自包含 popup、background、single capture 与 batch capture 产物，均在 `.gitignore` 内）：

   ```bash
   npm run build:extension
   ```

   > **采集注入方式（2026-07-20 修复）**：popup 不再用 `func: runPageExtraction`（该函数依赖注入后不存在的模块闭包，会 `ReferenceError` → `result:null` → popup 读 `captureMethod` 崩溃）。现改为 `executeScript({ files: ['src/content/injectedCapture.js'] })` 注入预构建的自包含脚本，再用一段只引用页面全局的 `func` 读取结果。任何空结果/异常都会转成可读错误，不再出现 `Cannot read properties of null`。加载已解压扩展时选 `browser-extension/` 目录即可（注入文件在其中）。

   > **抽取精度（2026-07-20 修复）**：修复了 company/role 串位、city 抓成整段地址、JD 混入导航噪声。现支持两种布局（`job_detail` 详情页、列表页左列表+右详情面板），role 来自岗位标题区、company 来自公司卡（交叉校验防串位），`苏州吴中区苏州国际科技园` 拆为 city=苏州 / district=吴中区 / address=完整地址，JD 只取职位描述卡片。低置信字段发送为 null 显示「未识别」交由人工确认，不编造。复验期望值：role=`web前端（苏州、银行项目）`、company=`赞同科技`、city=`苏州`、salary=11-16、city 不含区县/地址、JD 无导航噪声。**若真实页面某些字段仍未识别或选择器未命中**：定向 DOM 选择器基于 BOSS 公开结构重建，可能与你的真实 DOM 不完全一致；标题/地址受控解析会兜底 role/company/city，但如需精确 selector，请提供两种布局的**脱敏最小 HTML**（仅保留 §一 所列字段结构，不含招聘者姓名/联系方式/Cookie/Token）以便进一步校准。
2. 仅在需要隔离写入验收时启动 Radar 沙箱（默认 Web=17365，API=17366，Vite 把 `/radar`、`/health`、`/meta` 反代到后端）：

   ```bash
   npm run dev:radar-sandbox
   ```

   启动日志会打印临时库文件绝对路径与 `schema 版本: 7`。该库每次启动都是全新空库，只影响临时文件。

---

## 2. 加载扩展并采集（人工）

1. Chrome/Edge 打开扩展管理页，开启「开发者模式」，「加载已解压的扩展程序」，选择仓库 `browser-extension/` 目录；
2. 打开一个真实 BOSS 岗位**详情页**（保持登录态，手动打开，不要用任何自动跳转）；
3. 点击扩展图标 →「采集当前页」按钮；
4. 确认扩展只读取**当前活动标签页**（不请求 Cookie、历史、其他标签页）；
5. 扩展会新开一个标签页跳到 `http://127.0.0.1:17365/#/radar/import?sessionId=...` 预览页；
6. 核对预览页字段：公司、职位、城市、薪资、以及折叠的原始可见文本 / JD；
7. 对**至少一个字段**做人工纠错（例如修正城市或职位）；
8. 勾选该条目，点击「确认写入」；
9. 用只读方式检查临时库（路径见启动日志）中新增了：
   `radar_capture_sessions / radar_capture_snapshots / radar_source_records / radar_candidates / radar_candidate_versions / radar_candidate_sources`；
10. 确认**没有**新增 `jobs / applications / feedback_events`（正式求职记忆不受影响）；
11. 用扩展**再次采集同一个岗位**，确认基础幂等：不产生重复正式候选（相同来源 → `unchanged` 或新版本，而非新候选）；
12. 通用页面与服务离线错误已由 Playwright 隔离验证，人工不需要停止当前 OfferFlow 或重复操作。

> 查询临时库示例（只读，替换为启动日志里的真实路径）：
> `node -e "const{openDb}=require('./server/db');const db=openDb(process.argv[1]);for(const t of ['radar_candidates','radar_candidate_versions','jobs','applications','feedback_events'])console.log(t,db.prepare('SELECT COUNT(*) n FROM '+t).get());" "<临时库路径>"`
> （TS 直接跑需用 `npx tsx`；生产不依赖此脚本。）

---

## 3. 截图与隐私（人工）

保存以下验收证据到临时目录（是否纳入 Git 由用户后续决定）：

- 扩展 popup 成功状态；
- OfferFlow 预览页；
- 纠错后的字段；
- 确认写入结果；
- 临时库行或详情页证据；
- Playwright 通用降级 screenshot/trace/结构化结果；
- Playwright 服务未启动错误 screenshot/trace/结构化结果。

截图前必须脱敏：招聘者姓名 / 头像 / 电话 / 微信、Cookie / Token / 会话 capability、本地绝对路径、不必要的完整 JD、其他个人隐私。

---

## 4. 记录真实 DOM 提取结果（人工）

针对真实 BOSS 页记录：

- 哪些字段由定向选择器成功提取；
- 哪些退回可见文本或 `unknown`；
- 是否存在平台改版导致选择器失效；
- 是否误采集了推荐岗位 / 导航 / 聊天 / 其他噪声。

不得为追求字段齐全而补造事实——识别不到的字段保持 `null` / `unknown`。

---

## 5. 验收后

- 沙箱为临时库，验收结束直接关闭进程即可，无需清理真实数据；
- 真实数据库升级与真实入口启用仍需用户另行明确授权，不在本 Runbook 范围内；
- 人工 BOSS Preview 与自动证据归档后，再据实更新 Traceability 的 RC-01～RC-04；RC-04 在真实生产库升级并写入前保持 Partial。

---

## 6. BOSS 列表页「批量选卡 + 串行右侧详情采集」真实验收（V8-2 批量 Runner）

> 【自动化已覆盖】语义卡片根定位、逻辑去重、队列串行状态机、已知身份校验、批量提交项构建、
> 全阻塞/默认勾选闸门均由单测覆盖。**真实浏览器需人工验证**：Shadow DOM 选择 UI、复选框不触发
> 岗位切换、程序化点击切换右侧详情、MutationObserver 稳定判定、单项失败续跑、批量预览生成。

前置：同 §1 沙箱（扩展硬编码 127.0.0.1:17365），并在 `chrome://extensions` 重新加载扩展（含新
`batchCapture.js` 与 `background.js`）。

最终收口的最短人工步骤（普通 Chrome，不使用任何浏览器控制插件）：

1. 在 `chrome://extensions` 重新加载本地 OfferFlow 扩展。
2. 打开已登录的 BOSS `/web/geek/jobs`。
3. 选择 2 个岗位名和公司明显不同的岗位。
4. 点击「开始采集」，等待打开一个批量 Preview。
5. 停在 Preview，**不要确认写入**。
6. 截取包含批量汇总和两个条目的完整截图。
7. 提供最新 session 前缀。

收到截图与 session 前缀后只读核验：最新 session、item 数、`selectionOrder`、role/company/city/salary/
experience/education、`externalRecordId`、`canonicalSourceUrl`、`identityMatch`、`commitBlocked`、JD 是否串位，
以及 Preview 阶段 Snapshot/Source/Candidate/Version 和正式 `Job/Application/FeedbackEvent` 计数。核验前后都不确认写入。

失败项 metadata 带 `batchItemStatus` 与阻塞原因；如串行定位异常，把该项 `extractionMetadata` 发回定位。

---

## 7. V8-2 收口人工证据台账（2026-07-22）

| 证据 | 步骤 | 期望 | 当前实际 | 证据路径 | 状态 | 数据库行数变化 |
|---|---|---|---|---|---|---|
| 普通网页通用可见文本降级 | 普通 fixture 经真实 MV3 popup 进入受控 Preview | `generic_visible_text`；URL/标题/可见文本存在，未知字段不编造 | 正文保留；hidden/style/script 噪声排除；`recognizedFields=null` | `test-results/extension-e2e/*generic*/`（Git 忽略） | PASS | mock 不写 DB；API 集成测试证明 Preview 前正式 Radar 表为 0 |
| OfferFlow 未启动明确报错 | 临时扩展指向动态未监听 loopback 端口 | 明确提示服务未启动；不扫描端口、不访问第三方 | popup 保持打开；提示启动后重试；无 session/add/Preview/残留 UI/异常 | `test-results/extension-e2e/*OfferFlo*/`（Git 忽略） | PASS | 0 |
| 最终 BOSS 批量 Preview 汇总截图 | 普通 Chrome 真实 BOSS 选择 2 条，完成串行采集并打开一个 Preview | 汇总展示 captured/needs_correction/blocked；公司/薪资/学历/活跃度可核对 | session `686a0ef7…`；共 2、已采集 0、待确认 2、阻塞 0；两项身份一致、JD 不串位 | `artifacts/v0.8-v8-2/2026-07-22-boss-batch-preview.{png,audit.json}`（Git 忽略） | PASS | 目标 Snapshot=0；自 Preview 创建时起 Source/Candidate/Version/Link/Job/Application/FeedbackEvent 新增均为 0 |

三项证据闭环由 Playwright 确定性自动验收、用户普通 Chrome 真实 BOSS Preview 和只读 session/数据库核验共同组成；不依赖任何浏览器控制插件。证据通过不等于已经激活真实生产 schema v7，生产激活仍须独立裁决。
