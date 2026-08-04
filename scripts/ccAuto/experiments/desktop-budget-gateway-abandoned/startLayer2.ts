/**
 * 第二层零费用测试：启动 mock upstream + Gateway（真实入口 start.ts）。
 *
 * - mock server 与 Gateway 都以分离进程（detached）启动，写入 PID 到状态文件，
 *   独立于本启动器存活，供用户多轮操作（启用测试卡 → 重启 Claude Desktop → 发消息）。
 * - Gateway 监听 127.0.0.1:15722，deepseek route 临时指向本地 mock（不修改 gatewayConfig.ts）。
 * - 启动后只做无认证健康检查与链路检查，不发送任何 /v1/messages 模型请求。
 *
 * 状态文件：%LOCALAPPDATA%/cc-auto-gateway/layer2-state.json
 *   { mockPid, mockPort, gatewayPid, gatewayPort, startedAt }
 *
 * 用法：npx tsx scripts/ccAuto/gateway/startLayer2.ts
 */
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'cc-auto-gateway');
const STATE_FILE = path.join(DATA_DIR, 'layer2-state.json');
const LOG_FILE = path.join(DATA_DIR, 'logs', 'gateway.log');

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

function nodeTsxArgs(script: string): string[] {
  const abs = path.join(THIS_DIR, script);
  return [
    '--require', path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'preflight.cjs'),
    '--import', 'file:///' + path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs').replace(/\\/g, '/'),
    abs,
  ];
}

function spawnDetached(script: string, env: Record<string, string>): ChildProcess {
  const logPath = path.join(DATA_DIR, 'logs', `${path.basename(script, '.ts')}-layer2.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, 'a');
  return spawn(process.execPath, nodeTsxArgs(script), {
    cwd: process.cwd(),
    env: { ...process.env, ...env, CC_AUTO_GATEWAY_TRACE: process.env.CC_AUTO_GATEWAY_TRACE || '' },
    stdio: ['ignore', out, out],
    windowsHide: true,
    detached: true,
  });
}

async function waitForLogLine(logFile: string, needle: string, timeoutMs = 15000, offset = 0): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf8').slice(offset);
      if (content.includes(needle)) return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function httpGetJson(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: p, timeout: 4000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });

  // 前置安全确认：15722 必须空闲
  const occupied = await new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.listen(15722, '127.0.0.1', () => { srv.close(() => resolve(false)); });
  });
  if (occupied) {
    console.error('ABORT: 127.0.0.1:15722 已被占用，拒绝启动。');
    process.exit(1);
  }

  // 1. 选空闲 mock 端口
  const mockPort = await getFreePort();
  const mockInfoFile = path.join(DATA_DIR, 'mock-info.json');

  // 2. 启动 mock upstream（分离进程）
  const mockChild = spawnDetached('mockServer.ts', {
    MOCK_PORT: String(mockPort),
    MOCK_INFO_FILE: mockInfoFile,
  });
  const mockPid = mockChild.pid;

  // 3. 等待 mock 就绪（读取 mock-info.json 拿到实际端口）
  let mockActualPort = mockPort;
  const mockReady = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if (fs.existsSync(mockInfoFile)) {
        try {
          const info = JSON.parse(fs.readFileSync(mockInfoFile, 'utf8'));
          mockActualPort = info.port;
          return true;
        } catch { /* 继续等 */ }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })();

  if (!mockReady) {
    console.error('ABORT: mock upstream 未在 10s 内就绪。');
    process.exit(1);
  }

  // 4. 写 Gateway 临时配置（deepseek route → mock；不修改 gatewayConfig.ts）
  const configPath = path.join(DATA_DIR, 'layer2-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 15722,
    host: '127.0.0.1',
    upstreamHost: '127.0.0.1',
    upstreamPort: 15721,
    upstreamPathPrefix: '/claude-desktop',
    routes: { deepseek: { name: 'DeepSeek', upstreamUrl: `http://127.0.0.1:${mockActualPort}/anthropic` } },
    dataDir: path.join(DATA_DIR, 'data'),
  }, null, 2), 'utf8');

  // 5. 启动 Gateway（真实入口 start.ts，分离进程）
  const logOffset = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').length : 0;
  const gwChild = spawnDetached('start.ts', {
    CC_AUTO_GATEWAY_CONFIG: configPath,
    CC_AUTO_GATEWAY_PORT: '15722',
  });
  const gatewayPid = gwChild.pid;

  // 6. 等待 Gateway 启动 banner
  const started = await waitForLogLine(LOG_FILE, 'Gateway started', 20000, logOffset);

  // 7. 健康检查与链路检查（不发送 /v1/messages）
  let bannerText = '';
  if (started) {
    bannerText = fs.readFileSync(LOG_FILE, 'utf8').slice(logOffset);
  }

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

  check('Gateway 启动 banner 已写入', started);
  if (started) {
    check('banner 含 PID', /PID: \d+/.test(bannerText));
    check('banner 含入口绝对路径', bannerText.includes('file:///') || bannerText.includes('start.ts'));
    check('banner 含 v0.2.0', bannerText.includes('v0.2.0'));
    check('banner 监听 127.0.0.1:15722', bannerText.includes('127.0.0.1:15722'));
    check('deepseek target 为 mock（127.0.0.1 本地端口）', bannerText.includes(`http://127.0.0.1:${mockActualPort}`));
    check('banner 不含凭证/Prompt', !/(authorization|api[_-]?key|sk-[a-zA-Z0-9])/i.test(bannerText));
  }

  // 无认证健康检查：Gateway /upstream/deepseek/v1/models（透明直通，不触发模型调用）
  try {
    const r = await httpGetJson(15722, '/upstream/deepseek/v1/models');
    check('Gateway 本地链路（/v1/models 透传 mock）', r.status === 200, `status=${r.status}`);
  } catch (e) {
    check('Gateway 本地链路（/v1/models 透传 mock）', false, String((e as Error).message));
  }

  // mock 状态接口（确认 mock 活着且消息计数为 0）
  try {
    const r = await httpGetJson(mockActualPort, '/__mock_stats');
    const stat = JSON.parse(r.body);
    check('mock upstream 存活', stat.ok === true && stat.pid === mockPid, `pid=${stat.pid} port=${stat.port}`);
    check('mock 消息计数 = 0（未发生任何模型请求）', stat.messagesCount === 0, `count=${stat.messagesCount}`);
    check('mock 未记录认证头', stat.authHeaderSeen === false);
  } catch (e) {
    check('mock upstream 存活', false, String((e as Error).message));
  }

  // 写入状态文件
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    mockPid,
    mockPort: mockActualPort,
    gatewayPid,
    gatewayPort: 15722,
    startedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  // 输出
  const failures = results.filter((r) => !r.ok);
  console.log('\n=== 第二层环境准备核验 ===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
  }
  console.log('');

  if (failures.length > 0) {
    console.error(`存在 ${failures.length} 项失败，请检查后重试。`);
    console.error('如需清理：npx tsx scripts/ccAuto/gateway/stopLayer2.ts');
    process.exit(1);
  }

  console.log(`mock upstream PID 与监听地址：${mockPid} / 127.0.0.1:${mockActualPort}`);
  console.log(`Gateway PID 与监听地址：${gatewayPid} / 127.0.0.1:15722`);
  console.log(`Gateway 当前 deepseek target：http://127.0.0.1:${mockActualPort}/anthropic（mock）`);
  console.log(`15721 当前状态：由 CC Switch 监听（未被本测试占用）`);
  console.log(`是否确认无公网 Provider 请求：是（deepseek route 全部指向本地 mock；/v1/models 链路检查未触发模型调用）`);
  console.log(`是否需要我启用 DeepSeek（预算测试）：需要，等你确认后启用`);
  console.log('');
  console.log('请在 CC Switch 中启用 DeepSeek（预算测试），完成后回复：已启用。');
}

main().catch((e) => { console.error(e); process.exit(2); });
