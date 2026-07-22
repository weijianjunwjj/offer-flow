import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const shared = {
  bundle: true,
  format: 'iife',
  target: 'es2020',
  logLevel: 'info',
};

// popup 逻辑（在扩展 popup 页面内运行）。
await build({
  ...shared,
  entryPoints: [path.join(here, 'src/popup/popup.ts')],
  outfile: path.join(here, 'src/popup/popup.bundle.js'),
});

// 页面采集脚本：由 popup 在用户点击后通过 executeScript({ files }) 注入当前标签页。
// 必须完全自包含（把 extractors 等依赖全部打包进来），不依赖注入后不存在的模块闭包。
await build({
  ...shared,
  entryPoints: [path.join(here, 'src/content/injectedCapture.ts')],
  outfile: path.join(here, 'src/content/injectedCapture.js'),
});

// 列表页批量选卡注入脚本：由 popup 在 /web/geek/jobs 点击后注入，渲染 Shadow DOM 选择 UI 并串行采集。
// 自包含 IIFE；运行在隔离世界，用 chrome.runtime.sendMessage 把整批结果交给 background 提交。
await build({
  ...shared,
  entryPoints: [path.join(here, 'src/content/batchCapture.ts')],
  outfile: path.join(here, 'src/content/batchCapture.js'),
});

// MV3 background service worker：只做最终 API 提交（createSession + 逐项 addItem + 打开预览），
// 不承载长时间队列运行。
await build({
  ...shared,
  entryPoints: [path.join(here, 'src/background/background.ts')],
  outfile: path.join(here, 'src/background/background.js'),
});
