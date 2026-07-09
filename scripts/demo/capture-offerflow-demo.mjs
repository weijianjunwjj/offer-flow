#!/usr/bin/env node
/**
 * OfferFlow Demo 素材生成脚本（面试用，非生产级自动化测试）。
 *
 * 依赖要求（本脚本不会自动安装，需要人工确认后手动执行）：
 *   npm i -D @playwright/test
 *   npx playwright install chromium
 *
 * 用法：
 *   node scripts/demo/capture-offerflow-demo.mjs --mode real --allow-demo-write   （默认模式，走真实 DeepSeek SSE）
 *   node scripts/demo/capture-offerflow-demo.mjs --mode mock --allow-demo-write   （兜底，拦截 SSE 返回 mock 内容）
 *
 * 详细说明见 docs/demo-recording.md。
 *
 * 数据写入边界：
 * - 脚本流程需要点击「保存岗位」才能触发真实 UI 分析流程，这会在当前 OfferFlow 数据源里写入
 *   一条脱敏 demo opportunity。
 * - 因此默认不允许静默保存：必须显式传入 --allow-demo-write，脚本才会在「保存岗位」这一步继续；
 *   不传的话，脚本会在保存前停止并给出提示，不会写入任何数据。
 * - demo 公司名 / 岗位名 / JD 文本都带有明显的 DEMO 标识和时间戳，避免和真实机会混淆。
 *
 * 安全边界：
 * - 不读取、不打印任何 .env / API Key / token 的具体值，只判断是否已配置。
 * - 不修改 src/、server/ 下任何业务源码。
 * - 不创建正式 opportunity、不投递、不联系 HR、不改真实数据库数据。
 * - 只使用脱敏假数据（假公司、假岗位、假 JD），且带 DEMO 标识。
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { mode: 'real', allowDemoWrite: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--mode') {
      args.mode = argv[i + 1];
      i += 1;
    } else if (token.startsWith('--mode=')) {
      args.mode = token.slice('--mode='.length);
    } else if (token === '--allow-demo-write') {
      args.allowDemoWrite = true;
    }
  }
  return args;
}

const { mode, allowDemoWrite } = parseArgs(process.argv.slice(2));

if (mode !== 'real' && mode !== 'mock') {
  console.error(`[demo] 未知模式：${mode}。请使用 --mode real 或 --mode mock。`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Playwright 依赖检查（只读检查，不安装）
// ---------------------------------------------------------------------------

function hasDependency(pkgJson, name) {
  return Boolean(
    (pkgJson.dependencies && pkgJson.dependencies[name]) ||
      (pkgJson.devDependencies && pkgJson.devDependencies[name]),
  );
}

const pkgJsonPath = path.join(projectRoot, 'package.json');
const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
const hasPlaywright = hasDependency(pkgJson, '@playwright/test') || hasDependency(pkgJson, 'playwright');
const hasPuppeteer = hasDependency(pkgJson, 'puppeteer');

if (!hasPlaywright) {
  console.error(
    [
      '[demo] 项目里没有检测到 @playwright/test（也没有 puppeteer）。',
      '本脚本依赖 Playwright 来驱动浏览器截图/录屏，但按边界要求不会自动安装依赖。',
      '',
      '请先手动确认并执行：',
      '  npm i -D @playwright/test',
      '  npx playwright install chromium',
      '',
      '安装完成后重新运行本脚本即可。',
    ].join('\n'),
  );
  process.exit(1);
}

const { chromium } = await import('@playwright/test');

// ---------------------------------------------------------------------------
// 基础配置
// ---------------------------------------------------------------------------

// Vite 默认端口是 5173；vite.config.ts 未显式配置 server.port，因此按 Vite 默认值推断。
const WEB_URL = process.env.OFFERFLOW_DEMO_WEB_URL ?? 'http://localhost:5173';
const VIEWPORT = { width: 1440, height: 900 };

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const runTimestamp = timestamp();
const outputDir = path.join(projectRoot, 'artifacts', 'offerflow-demo', `${runTimestamp}-${mode}`);

// ---------------------------------------------------------------------------
// 脱敏 Demo 数据（假公司、假岗位，不涉及任何真实招聘信息）
// 公司名 / 岗位名 / JD 都带明显的 DEMO 标识和时间戳，避免和真实机会混淆。
// ---------------------------------------------------------------------------

const DEMO_DATA = {
  company: `云杉智能科技 DEMO ${runTimestamp}`,
  role: 'AI 应用前端工程师 Demo',
  city: '苏州',
  salaryRange: '18-25K',
  jdText: `【DEMO 脱敏样本，用于 OfferFlow 面试录屏，不代表真实招聘信息】

【AI 应用前端工程师】
岗位职责：
1. 负责公司 AI 应用工作流平台的前端开发，基于 Vue3 + TypeScript 构建复杂 B 端系统界面；
2. 参与 LLM 工作流相关功能设计，包括流式（SSE）分析结果的前端渲染与异常处理；
3. 负责数据看板类页面的开发，支撑内部运营和决策分析场景；
4. 与后端协作设计结构化数据协议，保证 AI 输出结果可被稳定解析和复用；
5. 持续关注前端工程化质量，包括类型安全、自测覆盖和可维护性。

任职要求：
1. 3 年以上前端开发经验，熟练掌握 Vue3、TypeScript；
2. 有 SSE / WebSocket 等实时数据推送场景开发经验；
3. 了解大模型应用（LLM）相关的工程实践，如 Prompt 设计、结构化输出解析等；
4. 有复杂 B 端系统或数据看板类产品开发经验；
5. 具备良好的工程化意识，重视代码质量与可测试性。`,
};

// ---------------------------------------------------------------------------
// Mock SSE 内容（仅 mock 模式使用，格式对齐 server/routes/llm.ts 的
// `data: {"type":"chunk"|"done"|"error", ...}\n\n` 协议）
// ---------------------------------------------------------------------------

const MOCK_MARKDOWN_REPORT = `## 岗位匹配度速览
该岗位与候选人背景匹配度较高，核心技术栈（Vue3 + TypeScript）与候选人经验高度重合，且岗位强调的 SSE 流式处理、LLM 工程化经验是候选人的实际项目积累。

## 公司与机会判断
公司处于成长期，技术栈现代化程度较高，岗位描述聚焦具体工程能力而非泛泛而谈，说明技术团队对候选人的技能匹配有明确诉求。

## 风险提示
薪资区间处于市场中等水平，具体职级和股权需面谈确认；JD 未提及团队规模，建议在沟通中进一步了解。

## 面试关注点建议
建议重点准备 SSE 流式处理的工程细节、LLM 输出结构化解析的容错设计，以及如何平衡 AI 自动化与人工确认的产品边界。`;

const MOCK_OFFER_FLOW_JSON = `---OFFER_FLOW_JSON_START---
{
  "matchScore": 82,
  "companyAssessment": {
    "sizeTier": "mid",
    "stabilityLevel": "medium",
    "growthPotential": "high",
    "confidence": "medium",
    "summary": "成长期技术公司，招聘描述聚焦具体工程能力，技术团队诉求明确。"
  },
  "opportunityAnalysis": {
    "opportunityRadar": {
      "matchScore": 82
    },
    "applyAdvice": "worth_trying",
    "riskLevel": "medium",
    "interviewFocus": [
      "SSE 流式处理的工程细节",
      "LLM 输出结构化解析的容错设计",
      "AI 自动化与人工确认的产品边界如何权衡"
    ],
    "decisionSummary": "匹配度较高，建议投入时间准备面试，重点突出 AI 应用工程化经验。"
  }
}
---OFFER_FLOW_JSON_END---`;

const MOCK_FULL_TEXT = `${MOCK_MARKDOWN_REPORT}\n\n${MOCK_OFFER_FLOW_JSON}`;

/** 把 mock 全文切成若干块，模拟真实流式输出的逐步到达效果。 */
function chunkText(text, size = 24) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

async function installMockSseRoute(page) {
  await page.route('**/api/llm/analyze-job-stream', async (route) => {
    const chunks = chunkText(MOCK_FULL_TEXT);
    const encoder = new TextEncoder();
    const parts = [];

    for (const chunk of chunks) {
      parts.push(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
    }

    parts.push(
      `data: ${JSON.stringify({
        type: 'done',
        rawText: MOCK_FULL_TEXT,
        parsed: null,
        parseStatus: 'success',
        error: '',
        model: 'mock-deepseek-chat',
        createdAt: Date.now(),
      })}\n\n`,
    );

    const body = parts.join('');

    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
      },
      body: encoder.encode(body),
    });
  });
}

// ---------------------------------------------------------------------------
// Helper：稳定选择器封装
// 优先使用文案 / placeholder / label，不修改业务代码加 data-testid。
// 下面这些文案来自当前 src/pages/BattlefieldPage.vue、src/App.vue 的实际文案，
// 如果后续 UI 文案改动，需要相应更新这里的选择器。
// ---------------------------------------------------------------------------

async function clickByText(page, text, options = {}) {
  const locator = page.getByText(text, { exact: options.exact ?? false }).first();
  await locator.waitFor({ state: 'visible', timeout: options.timeout ?? 15000 });
  await locator.click();
}

async function clickButtonByText(page, text, options = {}) {
  const locator = page.getByRole('button', { name: text, exact: options.exact ?? false }).first();
  await locator.waitFor({ state: 'visible', timeout: options.timeout ?? 15000 });
  await locator.click();
}

async function fillByLabelOrPlaceholder(page, labelOrPlaceholder, value, options = {}) {
  const byPlaceholder = page.getByPlaceholder(labelOrPlaceholder, { exact: false });
  if (await byPlaceholder.count() > 0) {
    await byPlaceholder.first().fill(value, { timeout: options.timeout ?? 15000 });
    return;
  }
  const byLabel = page.getByLabel(labelOrPlaceholder, { exact: false });
  await byLabel.first().fill(value, { timeout: options.timeout ?? 15000 });
}

async function waitForText(page, text, options = {}) {
  await page.getByText(text, { exact: options.exact ?? false }).first().waitFor({
    state: 'visible',
    timeout: options.timeout ?? 20000,
  });
}

async function settle(page, ms = 400) {
  await page.waitForTimeout(ms);
}

// ---------------------------------------------------------------------------
// real 模式：环境自检（只判断是否配置，绝不打印具体值）
// ---------------------------------------------------------------------------

function checkRealModePrerequisites() {
  const envPath = path.join(projectRoot, '.env');
  const hasEnvFile = existsSync(envPath);

  const hasOfferflowKey = Boolean(process.env.OFFERFLOW_LLM_API_KEY);
  const hasDeepseekKey = Boolean(process.env.DEEPSEEK_API_KEY);
  const hasKeyInProcessEnv = hasOfferflowKey || hasDeepseekKey;

  return {
    hasEnvFile,
    hasKeyInProcessEnv,
    // 只要存在 .env 文件或进程里能看到 Key 变量，就认为“有可能已配置”，允许继续往下走；
    // 但具体是哪种情况，日志文案要分开说清楚，不能一概说成“已检测到配置”。
    hasKeyConfigured: hasEnvFile || hasKeyInProcessEnv,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function checkDevServerReachable(url) {
  try {
    const response = await fetch(url, { method: 'GET' });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function run() {
  console.log(`[demo] 模式：${mode}`);
  console.log(`[demo] 目标页面：${WEB_URL}`);
  console.log(`[demo] 输出目录：${outputDir}`);
  console.log(`[demo] --allow-demo-write：${allowDemoWrite ? '已传入' : '未传入'}`);
  if (allowDemoWrite) {
    console.log('[demo] 已确认允许写入：流程会保存一条脱敏 demo opportunity（带 DEMO 标识和时间戳）到当前本地数据源。');
  } else {
    console.log('[demo] 未传入 --allow-demo-write：脚本会在「保存岗位」这一步之前停止，不会写入任何数据。');
  }

  const serverReachable = await checkDevServerReachable(WEB_URL);
  if (!serverReachable) {
    console.error(
      [
        `[demo] 无法访问 ${WEB_URL}。`,
        '请先启动本地 dev server（另开一个终端窗口）：',
        '  npm.cmd run dev',
        '确认前端在 5173 端口可访问后再重新运行本脚本。',
      ].join('\n'),
    );
    process.exit(1);
  }

  if (mode === 'real') {
    const check = checkRealModePrerequisites();
    if (!check.hasKeyConfigured) {
      console.error(
        [
          '[demo] real 模式检测到 LLM 未配置（缺少 API Key 相关环境变量）。',
          '不会打印具体密钥值，只提示：请检查项目根目录 .env 文件是否设置了',
          '  OFFERFLOW_LLM_API_KEY（或 DEEPSEEK_API_KEY）',
          '  OFFERFLOW_LLM_BASE_URL（或 DEEPSEEK_BASE_URL，如需自定义）',
          '  OFFERFLOW_LLM_MODEL（或 DEEPSEEK_MODEL）',
          '',
          '如果暂时没有可用的 API Key，可以改用兜底模式：',
          '  node scripts/demo/capture-offerflow-demo.mjs --mode mock',
        ].join('\n'),
      );
      process.exit(1);
    }
    if (check.hasKeyInProcessEnv) {
      console.log('[demo] real 模式：检测到当前进程存在 LLM Key 配置（不打印具体值），将走真实 DeepSeek SSE 链路。');
    } else {
      console.log(
        '[demo] real 模式：检测到 .env 文件存在，但脚本不会读取密钥内容；真实配置是否正确以 dev server 实际调用结果为准。',
      );
    }
  } else {
    console.log('[demo] mock 模式：将拦截 SSE 接口，不调用真实 DeepSeek。');
  }

  const { mkdirSync } = await import('node:fs');
  mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: outputDir, size: VIEWPORT },
  });
  const page = await context.newPage();

  const shots = [];
  async function shot(name) {
    const file = path.join(outputDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    shots.push(file);
    console.log(`[demo] 截图：${name}.png`);
  }

  try {
    if (mode === 'mock') {
      await installMockSseRoute(page);
    }

    // 01 - 首页
    await page.goto(WEB_URL, { waitUntil: 'load' });
    await settle(page, 600);
    await shot('01-home');

    // 进入岗位台账 -> 新建岗位
    await clickButtonByText(page, '岗位台账').catch(() => {});
    await settle(page, 300);
    await clickButtonByText(page, '新建岗位');
    await settle(page, 600);

    // 02 - JD 录入
    await fillByLabelOrPlaceholder(page, '如：某某科技', DEMO_DATA.company);
    await fillByLabelOrPlaceholder(page, '如：高级前端', DEMO_DATA.role);
    await fillByLabelOrPlaceholder(page, '如：苏州', DEMO_DATA.city);
    await fillByLabelOrPlaceholder(page, '如：18-24K', DEMO_DATA.salaryRange);
    await fillByLabelOrPlaceholder(
      page,
      '粘贴 Boss 岗位 JD 原文，或直接粘贴 JD 截图后手动转换文字',
      DEMO_DATA.jdText,
    );
    await settle(page, 300);
    await shot('02-job-input');

    // 保存岗位这一步会在当前 OfferFlow 数据源里写入一条 demo opportunity，
    // 因此必须显式传入 --allow-demo-write 才允许继续，否则在这里停止。
    if (!allowDemoWrite) {
      console.error(
        [
          '',
          '[demo] 已停止：接下来的步骤需要点击「保存岗位」，这会在当前本地数据源中',
          `        写入一条脱敏 demo 岗位（公司：${DEMO_DATA.company} / 岗位：${DEMO_DATA.role}）。`,
          '[demo] 你没有传入 --allow-demo-write，脚本不会静默写入数据，到此为止。',
          '',
          '[demo] 如果可以接受写入这条脱敏 demo 数据（用于触发真实 UI 流程和真实 SSE 分析），请重新运行：',
          '  node scripts/demo/capture-offerflow-demo.mjs --mode real --allow-demo-write',
          '  或：',
          '  node scripts/demo/capture-offerflow-demo.mjs --mode mock --allow-demo-write',
          '',
          '[demo] 如果不想在当前数据源里产生任何数据，可以不运行脚本，改用手动录屏，',
          '        或者等后续做 Public Demo Mode 时再跑自动化脚本。',
          '',
          `[demo] 已生成的截图（01-home、02-job-input）保留在：${outputDir}`,
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }

    console.log(`[demo] 即将保存 demo 岗位：公司「${DEMO_DATA.company}」/ 岗位「${DEMO_DATA.role}」（已确认 --allow-demo-write）。`);
    await clickButtonByText(page, '保存岗位');
    await settle(page, 800);

    // 触发分析
    await clickButtonByText(page, 'AI 分析 JD');

    // 03 - 流式输出中间态：等待「AI 分析中」出现后再等一小段时间截图，
    // 尽量捕捉到内容正在生成中的状态。
    await waitForText(page, 'AI 分析中', { timeout: 15000 }).catch(() => {});
    await settle(page, mode === 'real' ? 1500 : 600);
    await shot(mode === 'real' ? '03-real-sse-streaming' : '03-mock-sse-streaming');

    // 等待分析完成
    await waitForText(page, '请检查结果后点击「确认并保存分析结果」', { timeout: 60000 }).catch((error) => {
      console.error('[demo] 等待分析完成超时，可能原因：网络问题 / DeepSeek 接口超时 / 选择器不匹配。');
      throw error;
    });
    await settle(page, 500);
    await shot(mode === 'real' ? '04-real-analysis-result' : '04-mock-analysis-result');

    // 确认并保存分析结果 -> 进入人工确认面板
    await clickButtonByText(page, '确认并保存分析结果');
    await settle(page, 800);
    await waitForText(page, '人工确认', { timeout: 15000 }).catch(() => {});
    await shot('05-pending-review');

    // 人工确认：点击「确认进入机会」
    await clickButtonByText(page, '确认进入机会').catch(() => {
      console.warn('[demo] 未找到「确认进入机会」按钮，可能审核面板文案已变化，跳过该步骤。');
    });
    await settle(page, 800);

    // 06 - 决策面板
    await waitForText(page, '跟进决策', { timeout: 15000 }).catch(() => {});
    await settle(page, 400);
    await shot('06-decision-panel');

    console.log(`[demo] 完成，共 ${shots.length} 张截图，输出目录：${outputDir}`);
    console.log(
      [
        '',
        `[demo] 提醒：这条 demo 岗位（公司「${DEMO_DATA.company}」/ 岗位「${DEMO_DATA.role}」）已写入当前本地数据源。`,
        '[demo] 如果不需要保留，请到 OfferFlow 页面手动删除，或者忽略这条带 DEMO 标识的数据，脚本不会自动清理。',
        '[demo] 后续可以考虑单独做 demo sandbox / Public Demo Mode 来避免污染真实数据源，但本次不做。',
      ].join('\n'),
    );
  } catch (error) {
    console.error('[demo] 执行过程中出错：', error?.message ?? error);
    console.error(
      [
        '[demo] 常见排查方向：',
        '  1. dev server 是否已启动（npm.cmd run dev）',
        '  2. real 模式下是否缺少 API Key（不会打印具体值，请自行检查 .env）',
        '  3. DeepSeek 接口是否超时或网络异常',
        '  4. 页面文案是否变化导致选择器不匹配（选择器基于当前 UI 文案编写）',
        mode === 'real'
          ? '  5. 如果 real 模式暂时跑不通，可以改用兜底模式：node scripts/demo/capture-offerflow-demo.mjs --mode mock'
          : '  5. mock 模式失败通常是页面结构变化导致，请检查选择器',
      ].join('\n'),
    );
    process.exitCode = 1;
  } finally {
    await context.close();
    // Playwright 会把录制的视频写为随机文件名，这里重命名为约定文件名方便查找。
    try {
      const { readdirSync, renameSync } = await import('node:fs');
      const files = readdirSync(outputDir).filter((f) => f.endsWith('.webm'));
      if (files.length > 0) {
        const targetName = mode === 'real' ? 'offerflow-real-demo.webm' : 'offerflow-mock-demo.webm';
        renameSync(path.join(outputDir, files[0]), path.join(outputDir, targetName));
        console.log(`[demo] 录屏已保存：${targetName}`);
      }
    } catch (error) {
      console.warn('[demo] 重命名录屏文件时出错（不影响截图结果）：', error?.message ?? error);
    }
    await browser.close();
  }
}

await run();
