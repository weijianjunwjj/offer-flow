# OfferFlow v0.5.2 OCR POC

## 目标

验证 Tesseract.js 是否适合作为 OfferFlow 第一版跨端 OCR 引擎。

本 POC 只验证 JD 截图识别链路，不承诺生产级 OCR 质量，不改变 OfferFlow AI Workflow 主线。

## 为什么选择 Tesseract.js

- Tesseract.js 是 JavaScript OCR 方案。
- 官方说明可在 browser 和 Node.js 运行。
- 官方说明通过 WebAssembly port 包装 Tesseract OCR engine。
- 官方说明支持多语言，适合先验证中文 JD 截图识别。
- 当前页面已有 `performJdImageOcr(file)` adapter，Tesseract.js 可以作为该 adapter 的一版实现。

## 为什么不用系统 OCR

本项目不使用：

- macOS Vision OCR。
- Windows.Media.Ocr。
- AppleScript。
- PowerShell。
- 系统截图 OCR。
- 本地 App OCR。
- 任何单一操作系统能力。

原因：OfferFlow 需要至少覆盖 macOS 和 Windows，OCR 能力必须跨端一致，不能把输入体验绑定到某一个 OS。

## 跨端判断

- Browser：Tesseract.js 支持在浏览器中通过 worker / WebAssembly 运行。
- Node.js：Tesseract.js 支持在 Node.js 中运行。
- macOS / Windows：理论上行为一致，因为识别逻辑来自 JS / WebAssembly / worker / traineddata，而不是系统 OCR。
- 本 POC 仍需实际在 macOS 和 Windows 分别跑样本确认。

## 中文识别风险

- Boss JD 截图中文较多，且可能有小字号、压缩、低对比度、滚动截屏拼接等问题。
- 当前语言配置为 `chi_sim+eng`，需要加载简体中文和英文 traineddata。
- `chi_sim` 识别质量必须用真实 Boss JD 截图验证。
- 截图清晰度会显著影响结果。
- 本 POC 不做图片预处理；后续如需提升质量，再评估灰度、放大、二值化等轻量方案。

## 性能风险

- 首次点击 OCR 需要 lazy-load `tesseract.js`。
- Tesseract core / WebAssembly / worker / traineddata 可能带来明显首次加载成本。
- 中文 traineddata 可能带来网络和缓存成本。
- 必须保持 lazy-load，避免 OfferFlow 首屏直接加载 OCR 依赖。
- 多张图片连续识别时，当前 POC 优先低侵入；后续可评估复用 worker 来降低重复初始化成本。

## 当前边界

- OCR 只是 JD 输入增强。
- OCR 只能由用户点击“转换文字”触发。
- OCR 不触发 AI Workflow。
- OCR 不生成 One-Shot Prompt。
- OCR 不调用 AI API。
- OCR 不解析 `OFFER_FLOW_JSON`。
- OCR 不改变 `communicationStatus`。
- OCR 不改变 `reviewStatus`.
- OCR 不持久化图片。
- OCR 结果只追加到岗位 JD 文本框。

## 当前实现

- Adapter：`src/ocr/jdImageOcr.ts`
- 依赖：`tesseract.js`
- Lazy import：`await import('tesseract.js')`
- 语言：`chi_sim+eng`
- OEM：LSTM only
- 成功：返回识别文本，由页面追加到 JD 文本框末尾。
- 失败：抛出明确错误，由页面标记图片“转换失败”，不清空 JD 文本，不删除图片。

## 验收方式

1. macOS 跑一次。
2. Windows 跑一次。
3. 至少用 3 张真实 Boss JD 截图测试。
4. 记录每张截图的识别结果是否可用。
5. 记录首次 OCR 等待时间。
6. 记录是否出现 traineddata 下载、缓存、worker 或 wasm 错误。

如果 Vite / worker / wasm / traineddata 资源加载需要复杂配置，应暂停并复盘，不强行扩大架构。

## macOS 初测记录

当前已在 macOS Chrome / localhost 环境跑通真实 Boss JD 截图识别。

观察结果：

- 中文主体识别基本可用。
- 岗位名、城市、薪资和公司补充等关键字段可通过识别文本继续人工整理。
- 无序号、项目符号和少量特殊符号可能被误识别，例如识别成 `e` 或句号。
- 段落格式无法和截图一比一复刻，需要接受 OCR 结果作为“输入草稿”，由用户人工校对。
- Network 面板可见 worker / wasm / traineddata 相关资源加载，符合 Tesseract.js POC 预期。

结论：Tesseract.js 可以继续作为 OfferFlow 第一版跨端 OCR 候选方案，但还需要 Windows 端和至少 3 张真实 Boss JD 截图复测。

## Windows 验收待办

当前 macOS Chrome / localhost 已验证。Windows 端尚未验证，因此当前不能宣称“已完成跨端实测”。

建议验收环境：

- Windows 10 / 11。
- Node.js 20+。
- Chrome 或 Edge 最新版。
- `npm install` 后运行 `npm run dev`。

验收步骤：

1. 打开 OfferFlow。
2. 新增岗位。
3. 在岗位 JD textarea 粘贴 Boss JD 截图。
4. 确认图片进入待转换列表。
5. 点击“转换文字”。
6. 确认 worker / wasm / traineddata 能正常加载。
7. 确认 OCR 结果追加到 JD 文本框。
8. 确认失败时不清空 JD、不删除图片。

建议至少使用 3 张真实 Boss JD 截图测试：

- 短 JD。
- 长 JD。
- 包含薪资、城市、公司补充、项目符号的 JD。

通过标准：

- 不要求版式还原。
- 不要求特殊符号完全准确。
- 关键字段可读即可：岗位名、城市、薪资、公司名 / 方向、核心技能要求。

若 Windows 失败：

- 先检查 worker / wasm / traineddata 加载路径。
- 不允许退回 Windows-only OCR。
- 不允许改用 PowerShell / 系统 OCR。
- 先记录失败原因，再决定是否调整 Tesseract.js 资源配置。
