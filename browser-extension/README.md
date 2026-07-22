# OfferFlow 当前页采集桥（浏览器扩展，V8-2）

范围边界见 `docs/security/browser-capture-security.md` 与 `CLAUDE.md` 第 5 节。

## 能力

- 用户点击扩展图标后，读取**当前活动标签页**的 URL / 标题 / 可见文本；
- BOSS（zhipin.com）职位详情页尝试定向字段提取，失败自动降级为通用可见文本；
- 发送到本机 OfferFlow（`http://127.0.0.1:17365`）创建采集会话预览；
- 打开 OfferFlow 预览页供用户确认/纠错，不自动写入正式候选。

## 明确不做

- 不自动搜索、翻页或批量遍历；
- 不后台扫描或常驻 content script；
- 不读取 Cookie、密码、Token 或浏览历史；
- 不自动投递或发消息；
- 不绕过验证码或风控。

## 本地构建与加载

```bash
npm run extension:typecheck
npm run extension:build
```

然后在 Chrome/Edge 的 `chrome://extensions`（或 `edge://extensions`）中：

1. 打开"开发者模式"；
2. "加载已解压的扩展程序"，选择 `browser-extension/` 目录。

使用前需要先在本机启动 OfferFlow（`npm run server` 或 `npm run dev`），
否则点击采集按钮会提示"OfferFlow 未启动"，不会做端口扫描或重试探测。
