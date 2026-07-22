import { test as base, expect, chromium, type BrowserContext, type CDPSession, type Page, type Worker } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(here, '..');
const fixturePath = path.join(here, 'fixtures/boss-list.html');
const genericFixturePath = path.join(here, 'fixtures/generic-job.html');

interface Fixtures {
  extensionContext: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  bossPage: Page;
  fixtureOrigin: string;
  offerFlowRequests: string[];
  offerFlowBaseUrl: string;
  offerFlowMode: 'default' | 'isolated-mock' | 'isolated-unavailable';
  offerFlowMockBodies: Array<{ pathname: string; body: unknown }>;
}

async function reserveUnlistenedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('failed to reserve an isolated loopback port');
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

const test = base.extend<Fixtures>({
  fixtureOrigin: async ({}, use) => {
    await use('https://www.zhipin.com');
  },

  offerFlowRequests: async ({}, use) => { await use([]); },

  offerFlowMode: ['default', { option: true }],

  offerFlowBaseUrl: async ({ offerFlowMode }, use) => {
    const baseUrl = offerFlowMode === 'default'
      ? 'http://127.0.0.1:17365'
      : `http://127.0.0.1:${await reserveUnlistenedLoopbackPort()}`;
    await use(baseUrl);
  },

  offerFlowMockBodies: async ({ offerFlowMode, offerFlowBaseUrl }, use) => {
    const bodies: Array<{ pathname: string; body: unknown }> = [];
    if (offerFlowMode !== 'isolated-mock') {
      await use(bodies);
      return;
    }
    const sessionId = 'generic-e2e-session';
    const server = createHttpServer(async (request, response) => {
      const pathname = new URL(request.url ?? '/', offerFlowBaseUrl).pathname;
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      response.setHeader('access-control-allow-headers', 'content-type,x-offerflow-capture-client');
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
      }
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw.length > 0 ? JSON.parse(raw) as unknown : null;
        bodies.push({ pathname, body });
        const json = pathname.endsWith('/items')
          ? { session: { id: sessionId, sourceType: 'browser', status: 'preview' }, items: [{ index: 0, ...(body as object) }] }
          : { session: { id: sessionId, sourceType: 'browser', status: 'preview' } };
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(json));
        return;
      }
      const item = bodies.find((entry) => entry.pathname.endsWith('/items'))?.body ?? {};
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><html><body><main data-testid="controlled-preview"><h1>当前页采集预览</h1><pre id="capture-result">${JSON.stringify(item)}</pre></main></body></html>`,
      );
    });
    const parsed = new URL(offerFlowBaseUrl);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(parsed.port), parsed.hostname, () => resolve());
    });
    await use(bodies);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  },

  extensionContext: async ({ fixtureOrigin, offerFlowRequests, offerFlowBaseUrl }, use, testInfo) => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), 'offerflow-extension-e2e-'));
    const testExtensionDir = await mkdtemp(path.join(os.tmpdir(), 'offerflow-extension-build-'));
    await cp(extensionPath, testExtensionDir, {
      recursive: true,
      filter: (source) => !source.startsWith(path.join(extensionPath, 'e2e')),
    });
    const manifestPath = path.join(testExtensionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { host_permissions: string[] };
    manifest.host_permissions.push('https://www.zhipin.com/*');
    manifest.host_permissions.push('https://fixture.example/*');
    manifest.host_permissions = manifest.host_permissions.map((permission) => (
      permission.replace('http://127.0.0.1:17365', offerFlowBaseUrl)
    ));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    for (const relativePath of ['src/popup/popup.bundle.js', 'src/background/background.js']) {
      const bundlePath = path.join(testExtensionDir, relativePath);
      const bundle = await readFile(bundlePath, 'utf8');
      await writeFile(bundlePath, bundle.replaceAll('http://127.0.0.1:17365', offerFlowBaseUrl), 'utf8');
    }
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      headless: false,
      viewport: { width: 1280, height: 900 },
      recordVideo: { dir: testInfo.outputPath('video'), size: { width: 1280, height: 900 } },
      args: [
        `--disable-extensions-except=${testExtensionDir}`,
        `--load-extension=${testExtensionDir}`,
        '--no-first-run',
      ],
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixtureOrigin });
    context.on('request', (request) => {
      if (request.url().startsWith(`${offerFlowBaseUrl}/`)) offerFlowRequests.push(request.url());
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await use(context);
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const [index, page] of context.pages().entries()) {
        if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath(`failure-page-${index}.png`), fullPage: true });
      }
    }
    await context.tracing.stop({ path: testInfo.outputPath('trace.zip') });
    await context.close();
    await rm(profileDir, { recursive: true, force: true });
    await rm(testExtensionDir, { recursive: true, force: true });
    void fixtureOrigin;
  },

  serviceWorker: async ({ extensionContext }, use) => {
    const worker = extensionContext.serviceWorkers()[0] ?? await extensionContext.waitForEvent('serviceworker');
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    const id = new URL(serviceWorker.url()).host;
    expect(id).toMatch(/^[a-p]{32}$/);
    await use(id);
  },

  bossPage: async ({ extensionContext, fixtureOrigin, extensionId }, use) => {
    void extensionId;
    const page = await extensionContext.newPage();
    const html = await readFile(fixturePath);
    await page.route(`${fixtureOrigin}/web/geek/jobs**`, (route) => route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8', body: html,
    }));
    await page.goto(`${fixtureOrigin}/web/geek/jobs`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await use(page);
  },
});

interface ToolbarPopup {
  targetId: string;
  sessionId: string;
  cdp: CDPSession;
}

let cdpMessageId = 0;

async function sendToPopup(popup: ToolbarPopup, expression: string): Promise<unknown> {
  cdpMessageId += 1;
  const id = cdpMessageId;
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('popup CDP response timeout')), 5000);
    const listener = (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== popup.sessionId) return;
      const parsed = JSON.parse(event.message) as { id?: number; result?: { result?: { value?: unknown } }; error?: unknown };
      if (parsed.id !== id) return;
      clearTimeout(timer);
      popup.cdp.off('Target.receivedMessageFromTarget', listener);
      if (parsed.error !== undefined) reject(new Error(JSON.stringify(parsed.error)));
      else resolve((parsed.result?.result?.value ?? null) as unknown as Record<string, unknown>);
    };
    popup.cdp.on('Target.receivedMessageFromTarget', listener);
  });
  await popup.cdp.send('Target.sendMessageToTarget', {
    sessionId: popup.sessionId,
    message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }),
  });
  return response;
}

async function capturePopupScreenshot(popup: ToolbarPopup, outputPath: string): Promise<void> {
  cdpMessageId += 1;
  const id = cdpMessageId;
  const response = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('popup screenshot timeout')), 5000);
    const listener = (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== popup.sessionId) return;
      const parsed = JSON.parse(event.message) as { id?: number; result?: { data?: string }; error?: unknown };
      if (parsed.id !== id) return;
      clearTimeout(timer);
      popup.cdp.off('Target.receivedMessageFromTarget', listener);
      if (parsed.error !== undefined || parsed.result?.data === undefined) {
        reject(new Error(JSON.stringify(parsed.error ?? 'missing screenshot data')));
      } else {
        resolve(parsed.result.data);
      }
    };
    popup.cdp.on('Target.receivedMessageFromTarget', listener);
  });
  await popup.cdp.send('Target.sendMessageToTarget', {
    sessionId: popup.sessionId,
    message: JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png', captureBeyondViewport: false } }),
  });
  await writeFile(outputPath, Buffer.from(await response, 'base64'));
}

function collectPopupExceptions(popup: ToolbarPopup): string[] {
  const exceptions: string[] = [];
  popup.cdp.on('Target.receivedMessageFromTarget', (event: { sessionId: string; message: string }) => {
    if (event.sessionId !== popup.sessionId) return;
    const parsed = JSON.parse(event.message) as { method?: string; params?: { exceptionDetails?: { text?: string } } };
    if (parsed.method === 'Runtime.exceptionThrown') {
      exceptions.push(parsed.params?.exceptionDetails?.text ?? 'unknown popup exception');
    }
  });
  return exceptions;
}

async function openToolbarPopup(context: BrowserContext, worker: Worker, bossPage: Page): Promise<ToolbarPopup> {
  await bossPage.bringToFront();
  const cdp = await context.newCDPSession(bossPage);
  await worker.evaluate(async () => { await chrome.action.openPopup(); });
  let targetId = '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const targets = await cdp.send('Target.getTargets') as { targetInfos: Array<{ targetId: string; url: string }> };
    targetId = targets.targetInfos.find((target) => target.url.endsWith('/src/popup/popup.html'))?.targetId ?? '';
    if (targetId !== '') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (targetId === '') throw new Error('toolbar popup target was not discoverable');
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: false }) as { sessionId: string };
  const popup = { targetId, sessionId: attached.sessionId, cdp };
  await sendToPopup(popup, 'new Promise(resolve => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", resolve, {once:true}) : resolve())');
  return popup;
}

async function enterBatchMode(context: BrowserContext, worker: Worker, page: Page): Promise<void> {
  const popup = await openToolbarPopup(context, worker, page);
  await sendToPopup(popup, 'document.querySelector("#capture-button")?.click()');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const initialTargets = await popup.cdp.send('Target.getTargets') as { targetInfos: Array<{ targetId: string }> };
  if (initialTargets.targetInfos.some((target) => target.targetId === popup.targetId)) {
    const status = await sendToPopup(popup, 'document.querySelector("#status")?.textContent');
    if (typeof status === 'string' && status.includes('无法在当前页面')) {
      throw new Error(`popup injection failed in E2E browser: ${status}`);
    }
  }
  await expect.poll(async () => {
    const targets = await popup.cdp.send('Target.getTargets') as { targetInfos: Array<{ targetId: string }> };
    return targets.targetInfos.some((target) => target.targetId === popup.targetId);
  }).toBe(false);
  await expect(page.locator('[data-offerflow-batch-root]')).toHaveCount(1);
}

function checkboxFor(page: Page, id: string) {
  return page.locator(`input[data-offerflow-pick="${id}"]`);
}

test.describe('generic visible-text 隔离证据', () => {
  test.use({ offerFlowMode: 'isolated-mock' });

  test('普通网页通过真实 MV3 popup 走 generic visible-text fallback 并进入受控 Preview', async ({
    extensionContext, serviceWorker, offerFlowMockBodies: capturedBodies,
  }, testInfo) => {
  const pageErrors: string[] = [];
  const sessionId = 'generic-e2e-session';

  const page = await extensionContext.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const html = await readFile(genericFixturePath);
  await page.route('https://fixture.example/jobs/frontend?source=e2e', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: html,
  }));
  await page.goto('https://fixture.example/jobs/frontend?source=e2e', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  const popup = await openToolbarPopup(extensionContext, serviceWorker, page);
  const popupExceptions = collectPopupExceptions(popup);
  await sendToPopup(popup, 'document.querySelector("#capture-button")?.click()');

  await expect.poll(() => capturedBodies.length).toBe(2);
  const preview = await expect.poll(() => (
    extensionContext.pages().find((candidate) => candidate.url().includes('/#/radar/import?sessionId=generic-e2e-session')) ?? null
  )).not.toBeNull();
  const previewPage = extensionContext.pages().find((candidate) => candidate.url().includes('/#/radar/import?sessionId=generic-e2e-session'))!;
  await expect(previewPage.locator('[data-testid="controlled-preview"]')).toBeVisible();

  const addBody = capturedBodies.find((entry) => entry.pathname.endsWith('/items'))?.body as Record<string, unknown>;
  expect(addBody).toMatchObject({
    captureMethod: 'generic_visible_text',
    sourceUrl: 'https://fixture.example/jobs/frontend?source=e2e',
    pageTitle: '普通招聘页面 · 前端工程师',
    recognizedFields: null,
    providerKey: null,
    externalRecordId: null,
  });
  const visibleText = String(addBody.visibleText);
  expect(visibleText).toContain('高级前端工程师');
  expect(visibleText).toContain('负责 Vue 3 与 TypeScript 项目交付');
  expect(visibleText).not.toMatch(/hidden 属性噪声|内联隐藏噪声|样式隐藏噪声|脚本噪声|fixture-hidden-by-style/);
  expect(capturedBodies.map((entry) => entry.pathname)).toEqual([
    '/radar/capture-sessions', `/radar/capture-sessions/${sessionId}/items`,
  ]);
  expect(await page.locator('[data-offerflow-batch-root], [data-offerflow-checkbox-host]').count()).toBe(0);
  expect(await page.evaluate(() => '__OFFERFLOW_CAPTURE_RESULT__' in window)).toBe(false);
  expect(pageErrors).toEqual([]);
  expect(popupExceptions).toEqual([]);

  await previewPage.screenshot({ path: testInfo.outputPath('generic-fallback-preview.png'), fullPage: true });
  await writeFile(testInfo.outputPath('generic-fallback-result.json'), `${JSON.stringify({
    automaticBoundary: '真实 MV3 action popup + 真实注入抽取；OfferFlow HTTP 与 Preview 使用受控 mock，服务端零正式写入由 server/radar/routes.spec.ts 独立验证',
    capture: addBody,
    previewUrl: previewPage.url(),
    formalRadarWritesBeforePreview: 0,
    pageErrors,
    popupExceptions,
  }, null, 2)}\n`, 'utf8');
  void preview;
  });
});

test.describe('OfferFlow 不可连接隔离证据', () => {
  test.use({ offerFlowMode: 'isolated-unavailable' });

  test('未监听 loopback 端口时 popup 保持打开并提示启动后重试', async ({
    extensionContext, serviceWorker,
  }, testInfo) => {
    const pageErrors: string[] = [];
    const page = await extensionContext.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const html = await readFile(genericFixturePath);
    await page.route('https://fixture.example/jobs/offline', (route) => route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8', body: html,
    }));
    await page.goto('https://fixture.example/jobs/offline', { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    const initialPageCount = extensionContext.pages().length;
    const popup = await openToolbarPopup(extensionContext, serviceWorker, page);
    const popupExceptions = collectPopupExceptions(popup);
    await sendToPopup(popup, 'document.querySelector("#capture-button")?.click()');
    await expect.poll(async () => sendToPopup(popup, 'document.querySelector("#status")?.textContent')).toMatch(
      /OfferFlow 未启动.*请先在本机启动 OfferFlow.*再重试/,
    );
    const targets = await popup.cdp.send('Target.getTargets') as { targetInfos: Array<{ targetId: string }> };
    expect(targets.targetInfos.some((target) => target.targetId === popup.targetId)).toBe(true);
    expect(extensionContext.pages()).toHaveLength(initialPageCount);
    expect(await page.locator('[data-offerflow-batch-root], [data-offerflow-checkbox-host]').count()).toBe(0);
    expect(await page.evaluate(() => '__OFFERFLOW_CAPTURE_RESULT__' in window)).toBe(false);
    expect(pageErrors).toEqual([]);
    expect(popupExceptions).toEqual([]);

    const status = await sendToPopup(popup, 'document.querySelector("#status")?.textContent');
    await capturePopupScreenshot(popup, testInfo.outputPath('offerflow-unavailable-popup.png'));
    await writeFile(testInfo.outputPath('offerflow-unavailable-result.json'), `${JSON.stringify({
      automaticBoundary: '临时扩展副本改写为动态分配后立即释放的 loopback 端口；未停止、未访问用户真实 OfferFlow',
      popupStayedOpen: true,
      status,
      sessionCreated: false,
      addItemAttempted: false,
      residualInjectedUi: false,
      pageErrors,
      popupExceptions,
    }, null, 2)}\n`, 'utf8');
    await sendToPopup(popup, 'window.close()');
  });
});

test('popup 成功注入后关闭，浮层位于安全区且选择阶段零 API 请求', async ({
  extensionContext, serviceWorker, bossPage, offerFlowRequests,
}, testInfo) => {
  await enterBatchMode(extensionContext, serviceWorker, bossPage);
  const geometry = await bossPage.locator('[data-offerflow-batch-root]').evaluate((host) => {
    const bar = host.shadowRoot?.querySelector('.bar');
    if (!(bar instanceof HTMLElement)) throw new Error('missing overlay bar');
    const rect = bar.getBoundingClientRect();
    return { top: rect.top, right: innerWidth - rect.right, zIndex: getComputedStyle(bar).zIndex };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(96);
  expect(geometry.right).toBeGreaterThanOrEqual(8);
  expect(Number(geometry.zIndex)).toBeGreaterThan(9000);
  expect(offerFlowRequests).toEqual([]);
  await bossPage.screenshot({ path: testInfo.outputPath('batch-selection-safe-position.png'), fullPage: true });
});

test('popup 注入失败时保持打开并显示错误', async ({ extensionContext, serviceWorker, bossPage }) => {
  await bossPage.goto('about:blank');
  const popup = await openToolbarPopup(extensionContext, serviceWorker, bossPage);
  await sendToPopup(popup, 'document.querySelector("#capture-button")?.click()');
  await expect.poll(async () => {
    const targets = await popup.cdp.send('Target.getTargets') as { targetInfos: Array<{ targetId: string }> };
    return targets.targetInfos.some((target) => target.targetId === popup.targetId);
  }).toBe(true);
  await expect.poll(async () => sendToPopup(popup, 'document.querySelector("#status")?.textContent')).toMatch(/失败|无法/);
  await sendToPopup(popup, 'window.close()');
});

test('reconciliation 覆盖首屏、延迟新增、hidden clone 与虚拟列表重建', async ({
  extensionContext, serviceWorker, bossPage,
}, testInfo) => {
  await enterBatchMode(extensionContext, serviceWorker, bossPage);
  await expect(checkboxFor(bossPage, 'A1000001')).toHaveCount(1);
  await expect(checkboxFor(bossPage, 'B2000002')).toHaveCount(1);
  await expect(checkboxFor(bossPage, 'C-300_0003')).toHaveCount(1);
  await expect(checkboxFor(bossPage, 'F6000006')).toHaveCount(1);
  await expect(checkboxFor(bossPage, 'D4000004')).toHaveCount(1);
  await expect(bossPage.locator('[data-test-job="B"][data-virtual-replacement="true"] [data-offerflow-checkbox-host]')).toHaveCount(1);
  await expect(bossPage.locator('[data-test-job="A-hidden"] [data-offerflow-checkbox-host]')).toHaveCount(0);

  const audit = await bossPage.locator('[data-offerflow-batch-root]').evaluate((host) => {
    const diagnostics = JSON.parse(host.getAttribute('data-offerflow-diagnostics') ?? '{}');
    const hosts = Array.from(document.querySelectorAll<HTMLElement>('[data-offerflow-checkbox-host]')).map((item) => {
      const input = item.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return {
        id: input?.dataset.offerflowPick, connected: item.isConnected,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        display: style.display, visibility: style.visibility, opacity: style.opacity,
        pointerEvents: style.pointerEvents, zIndex: style.zIndex,
        overflowClipping: item.parentElement ? getComputedStyle(item.parentElement).overflow : null,
        disabled: input?.disabled, checked: input?.checked,
      };
    });
    return { diagnostics, hosts };
  });
  expect(audit.diagnostics.mountedHostCount).toBe(5);
  expect(audit.diagnostics.skipped.map((item: { reason: string }) => item.reason)).toEqual(expect.arrayContaining([
    'hidden_clone', 'missing_job_detail_href', 'invalid_external_record_id', 'missing_role', 'missing_company',
  ]));
  expect(audit.hosts.every((host) => host.connected && host.rect.width > 0 && host.rect.height > 0
    && host.display !== 'none' && host.visibility !== 'hidden' && host.opacity !== '0'
    && host.pointerEvents !== 'none' && host.disabled === false)).toBe(true);
  await writeFile(testInfo.outputPath('dom-audit.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
});

test('原生 checkbox 由 change 更新队列，点击不切换右侧岗位，清空同步 checked 与计数', async ({
  extensionContext, serviceWorker, bossPage, offerFlowRequests,
}) => {
  await enterBatchMode(extensionContext, serviceWorker, bossPage);
  const before = await bossPage.locator('.job-detail-box').getAttribute('data-fingerprint');
  await checkboxFor(bossPage, 'A1000001').click();
  await expect(checkboxFor(bossPage, 'A1000001')).toBeChecked();
  await expect(bossPage.locator('[data-offerflow-batch-root]')).toHaveAttribute('data-offerflow-selection-count', '1');
  await checkboxFor(bossPage, 'B2000002').click();
  await expect(checkboxFor(bossPage, 'B2000002')).toBeChecked();
  await expect(bossPage.locator('[data-offerflow-batch-root]')).toHaveAttribute('data-offerflow-selection-count', '2');
  expect(await bossPage.locator('.job-detail-box').getAttribute('data-fingerprint')).toBe(before);
  expect(await bossPage.evaluate(() => (window as unknown as { __bossFixture: { cardClickCount: number } }).__bossFixture.cardClickCount)).toBe(0);
  await bossPage.locator('[data-offerflow-batch-root]').evaluate((host) => {
    (host.shadowRoot?.querySelector('.clear') as HTMLButtonElement | null)?.click();
  });
  await expect(bossPage.locator('input[data-offerflow-pick]:checked')).toHaveCount(0);
  await expect(bossPage.locator('[data-offerflow-batch-root]')).toHaveAttribute('data-offerflow-selection-count', '0');
  expect(offerFlowRequests).toEqual([]);
});

test('浮层可拖动、折叠，并在拖动及 resize 后约束于 viewport', async ({
  extensionContext, serviceWorker, bossPage,
}) => {
  await enterBatchMode(extensionContext, serviceWorker, bossPage);
  const host = bossPage.locator('[data-offerflow-batch-root]');
  const headerBox = await host.evaluate((el) => {
    const rect = (el.shadowRoot?.querySelector('.drag-handle') as HTMLElement).getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await bossPage.mouse.move(headerBox.x + 40, headerBox.y + 15);
  await bossPage.mouse.down();
  await bossPage.mouse.move(3000, 3000, { steps: 5 });
  await bossPage.mouse.up();
  const assertInViewport = async () => {
    const rect = await host.evaluate((el) => {
      const box = (el.shadowRoot?.querySelector('.bar') as HTMLElement).getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight };
    });
    expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(rect.width); expect(rect.bottom).toBeLessThanOrEqual(rect.height);
  };
  await assertInViewport();
  await host.evaluate((el) => (el.shadowRoot?.querySelector('.collapse') as HTMLButtonElement).click());
  await expect(host).toHaveAttribute('data-offerflow-collapsed', 'true');
  await bossPage.setViewportSize({ width: 800, height: 500 });
  await expect.poll(async () => {
    const rect = await host.evaluate((el) => {
      const box = (el.shadowRoot?.querySelector('.bar') as HTMLElement).getBoundingClientRect();
      return box.right <= innerWidth && box.bottom <= innerHeight;
    });
    return rect;
  }).toBe(true);
});

test('取消与 Esc 完整清理 host、observer 和浮层，可再次注入', async ({
  extensionContext, serviceWorker, bossPage,
}) => {
  await enterBatchMode(extensionContext, serviceWorker, bossPage);
  await bossPage.locator('[data-offerflow-batch-root]').evaluate((host) => {
    (host.shadowRoot?.querySelector('.cancel') as HTMLButtonElement | null)?.click();
  });
  await expect(bossPage.locator('[data-offerflow-batch-root], [data-offerflow-checkbox-host]')).toHaveCount(0);
  await enterBatchMode(extensionContext, serviceWorker, bossPage);
  await bossPage.keyboard.press('Escape');
  await expect(bossPage.locator('[data-offerflow-batch-root], [data-offerflow-checkbox-host]')).toHaveCount(0);
});

const diagnosticReasons = [
  'missing_job_detail_href', 'invalid_external_record_id', 'missing_role', 'missing_company',
  'missing_salary_or_tags', 'hidden_clone', 'duplicate_logical_card', 'unsupported_card_structure',
  'detached_root', 'host_mount_failed', 'host_removed_after_mount', 'other',
] as const;

test('诊断面板展示完整计数，复制 JSON 脱敏且重新扫描增加轮次', async ({
  extensionContext, serviceWorker, bossPage,
}, testInfo) => {
  await bossPage.goto('https://www.zhipin.com/web/geek/jobs?diagnosticStatic=1&securityId=never-copy&token=never-copy');
  await enterBatchMode(extensionContext, serviceWorker, bossPage);
  const host = bossPage.locator('[data-offerflow-batch-root]');
  await host.evaluate((el) => (el.shadowRoot?.querySelector('.diagnostics-toggle') as HTMLButtonElement).click());
  await expect.poll(() => host.evaluate((el) => !(el.shadowRoot?.querySelector('.diagnostics') as HTMLElement).hidden)).toBe(true);
  const first = await host.evaluate((el) => JSON.parse(el.getAttribute('data-offerflow-diagnostics') ?? '{}'));
  expect(first.acceptedLogicalCardCount).toBe(first.mountedHostCount);
  expect(first.connectedHostCount).toBe(first.mountedHostCount);
  expect(first.candidateSamples.length).toBeLessThanOrEqual(12);
  expect(first.candidateSamples.some((sample: { hrefPath?: string; detectedSalary?: string }) => (
    sample.hrefPath === '/job_detail/A1000001.html' && sample.detectedSalary === '12-18K'
  ))).toBe(true);
  for (const reason of diagnosticReasons) {
    await expect.poll(() => host.evaluate((el, text) => el.shadowRoot?.querySelector('.diagnostics-reasons')?.textContent?.includes(text), reason)).toBe(true);
    expect(first.reasonCounts).toHaveProperty(reason);
  }
  const rejected = Object.values(first.reasonCounts as Record<string, number>).reduce((sum, count) => sum + count, 0);
  expect(rejected).toBeGreaterThan(0);
  expect(first.acceptedLogicalCardCount + rejected).toBe(first.uniqueCandidateNodeCount);
  await host.evaluate((el) => (el.shadowRoot?.querySelector('.diagnostics-copy') as HTMLButtonElement).click());
  await expect(host).toHaveAttribute('data-offerflow-diagnostics-copy-status', 'success');
  const copied = await bossPage.evaluate(() => navigator.clipboard.readText());
  expect(new TextEncoder().encode(copied).byteLength).toBeLessThanOrEqual(30 * 1024);
  expect(copied).not.toMatch(/securityId|never-copy|[?][^"\s]*/i);
  expect(copied).toContain('高策华途 · 猎头顾问');
  expect(copied).not.toContain('测试招聘者姓名');
  const copiedDiagnostics = JSON.parse(copied);
  expect(copiedDiagnostics.pageUrlPath).toBe('/web/geek/jobs');
  expect(copiedDiagnostics.acceptedLogicalCardCount).toBe(first.acceptedLogicalCardCount);
  await writeFile(testInfo.outputPath('diagnostics.json'), `${copied}\n`, 'utf8');
  await bossPage.screenshot({ path: testInfo.outputPath('diagnostics-panel.png'), fullPage: true });
  await host.evaluate((el) => (el.shadowRoot?.querySelector('.diagnostics-rescan') as HTMLButtonElement).click());
  await expect.poll(async () => {
    const next = await host.evaluate((el) => JSON.parse(el.getAttribute('data-offerflow-diagnostics') ?? '{}'));
    return next.reconciliationRunCount;
  }).toBe(first.reconciliationRunCount + 1);
});

test('hostCount 为 0 仍输出完整原因，退出后诊断 UI 与 observer 清理', async ({
  extensionContext, serviceWorker, bossPage,
}) => {
  await bossPage.goto('https://www.zhipin.com/web/geek/jobs?diagnosticStatic=1&zeroHosts=1');
  await enterBatchMode(extensionContext, serviceWorker, bossPage);
  const host = bossPage.locator('[data-offerflow-batch-root]');
  const diagnostics = await host.evaluate((el) => JSON.parse(el.getAttribute('data-offerflow-diagnostics') ?? '{}'));
  expect(diagnostics.mountedHostCount).toBe(0);
  expect(diagnostics.connectedHostCount).toBe(0);
  expect(diagnostics.uniqueCandidateNodeCount).toBeGreaterThan(0);
  expect(Object.values(diagnostics.reasonCounts as Record<string, number>).some((count) => count > 0)).toBe(true);
  for (const reason of diagnosticReasons) expect(diagnostics.reasonCounts).toHaveProperty(reason);
  await host.evaluate((el) => (el.shadowRoot?.querySelector('.cancel') as HTMLButtonElement).click());
  await expect(bossPage.locator('[data-offerflow-batch-root], [data-offerflow-checkbox-host]')).toHaveCount(0);
  await bossPage.evaluate(() => {
    const item = document.createElement('li');
    item.className = 'job-card-wrapper';
    item.innerHTML = '<a href="/job_detail/Z9000009.html"><span class="job-name">清理验证</span><span class="salary">10K</span><span class="company-name">测试公司</span></a>';
    document.querySelector('#job-list-items')?.appendChild(item);
  });
  await bossPage.waitForTimeout(300);
  await expect(bossPage.locator('[data-offerflow-checkbox-host]')).toHaveCount(0);
});
