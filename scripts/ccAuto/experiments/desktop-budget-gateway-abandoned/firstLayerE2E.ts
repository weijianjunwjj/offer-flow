/**
 * 第一层零费用本地测试（一次性脚本，不入库）。
 *
 * 启动真实正式入口 start.ts（tsx 运行当前 TS 源码），route 指向本地 mock upstream，
 * 验证：① 启动 banner 只含非敏感标识；② /upstream/<routeId>/v1/messages 走完整管线
 * （预测行 + 正文 + 最终费用 + message_stop）；③ 缺 usage fail closed；④ 停止后端口释放。
 *
 * 用法：npx tsx scripts/ccAuto/gateway/firstLayerE2E.ts
 */
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { startMockUpstream, buildSse } from './mockUpstream';

/** 直接调用 node.exe + tsx loader，避免 .cmd shim（kill 不干净 + 弃用告警）。 */
function nodeTsxArgs(): string[] {
  return [
    '--require', path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'preflight.cjs'),
    '--import', 'file:///' + path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs').replace(/\\/g, '/'),
    'scripts/ccAuto/gateway/start.ts',
  ];
}

function spawnGateway(configPath: string, port: number, dataDir: string): ChildProcess {
  return spawn(process.execPath, nodeTsxArgs(), {
    cwd: process.cwd(),
    env: { ...process.env, CC_AUTO_GATEWAY_CONFIG: configPath, CC_AUTO_GATEWAY_PORT: String(port), CC_AUTO_GATEWAY_DATA_DIR: dataDir },
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** Windows 下递归杀掉进程树（child.kill() 杀不掉 .cmd/子进程）。 */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { child.kill('SIGKILL'); }
}

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

function postMessages(port: number, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: '/upstream/deepseek/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function textBlocks(body: string): string[] {
  const texts: string[] = [];
  const re = /data: (.*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    try {
      const o = JSON.parse(m[1]);
      if (o.type === 'content_block_delta' && o.delta?.type === 'text_delta') texts.push(o.delta.text);
    } catch {}
  }
  return texts;
}

function hasMessageStop(body: string): boolean {
  return body.includes('"type":"message_stop"');
}

async function waitForLogLine(logFile: string, needle: string, timeoutMs = 10000, offset = 0): Promise<boolean> {
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

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

async function main() {
  console.log('=== 第一层零费用测试（正式入口 + mock upstream）===');

  const mock = await startMockUpstream();
  const gwPort = await getFreePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-auto-first-layer-'));
  const configPath = path.join(tmp, 'config.json');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    port: gwPort,
    upstreamHost: '127.0.0.1',
    upstreamPort: gwPort + 1,
    upstreamPathPrefix: '/claude-desktop',
    routes: { deepseek: { name: 'DeepSeek', upstreamUrl: `http://127.0.0.1:${mock.port}/anthropic` } },
    dataDir,
  }, null, 2), 'utf8');

  const logFile = path.join(process.env.LOCALAPPDATA || os.homedir(), 'cc-auto-gateway', 'logs', 'gateway.log');
  // 记录基线偏移，只检查本次新增的日志行（避免读到历史/真实 gateway 的旧内容）
  const baseline = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').length : 0;

  const child = spawnGateway(configPath, gwPort, dataDir);

  try {
    // ① 启动 banner：等待 gateway.log 出现 Gateway started（本次新增部分）
    const bannerOk = await waitForLogLine(logFile, 'Gateway started', 10000, baseline);
    check('启动 banner 已写入 gateway.log', bannerOk);
    const banner = fs.readFileSync(logFile, 'utf8').slice(baseline);

    check('banner 含 PID', /PID: \d+/.test(banner));
    check('banner 含入口文件绝对路径', banner.includes('file:///') || banner.includes('start.ts'));
    check('banner 含版本 v0.2.0', banner.includes('v0.2.0'));
    check('banner 含监听地址', banner.includes(`127.0.0.1:${gwPort}`));
    check('banner 含 route 公开 origin（不含认证）', banner.includes(`http://127.0.0.1:${mock.port}`));
    check('banner 不含 Authorization / Key / 完整 Prompt', !/(authorization|api[_-]?key|sk-[a-zA-Z0-9])/i.test(banner));

    // ② 完整管线：流式 /v1/messages
    const body = await postMessages(gwPort, {
      stream: true, model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '你好，请测试' }],
    });
    const texts = textBlocks(body);
    check('首行是预计费用', texts.length > 0 && texts[0].includes('预计花费'), texts[0]);
    check('末行是按 Token 估算', texts.length > 0 && texts[texts.length - 1].includes('按 Token 估算'), texts[texts.length - 1]);
    check('存在 message_stop', hasMessageStop(body));
    check('预测行只出现一次', texts.filter((t) => t.includes('预计花费')).length === 1);
    check('结算行只出现一次', texts.filter((t) => t.includes('按 Token 估算')).length === 1);
    check('正文 OK 位于中间', texts.findIndex((t) => t.trim() === 'OK') > 0 && texts.findIndex((t) => t.trim() === 'OK') < texts.length - 1);

    // ③ fail closed：缺 usage → 费用无法估算（非 0 元）
    const h2 = await startMockUpstream({ handler: () => ({ body: buildSse({ model: 'deepseek-v4-flash', stopReason: 'end_turn', text: 'OK' }) }) });
    const gwPort2 = await getFreePort();
    const config2 = path.join(tmp, 'config2.json');
    const dataDir2 = path.join(tmp, 'data2');
    fs.mkdirSync(dataDir2, { recursive: true });
    fs.writeFileSync(config2, JSON.stringify({
      port: gwPort2, upstreamHost: '127.0.0.1', upstreamPort: gwPort2 + 1, upstreamPathPrefix: '/claude-desktop',
      routes: { deepseek: { name: 'DeepSeek', upstreamUrl: `http://127.0.0.1:${h2.port}/anthropic` } }, dataDir: dataDir2,
    }, null, 2), 'utf8');
    const child2 = spawnGateway(config2, gwPort2, dataDir2);
    const log2 = path.join(process.env.LOCALAPPDATA || os.homedir(), 'cc-auto-gateway', 'logs', 'gateway.log');
    const baseline2 = fs.existsSync(log2) ? fs.readFileSync(log2, 'utf8').length : 0;
    await waitForLogLine(log2, 'Gateway started', 10000, baseline2);
    const body2 = await postMessages(gwPort2, {
      stream: true, model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '你好' }],
    });
    const texts2 = textBlocks(body2).join(' ');
    check('缺 usage → 费用无法估算', texts2.includes('费用无法估算'), texts2.slice(0, 80));
    check('缺 usage → 不显示 ¥0.00', !texts2.includes('¥0.00'));
    await h2.stop();
    killTree(child2);
  } finally {
    killTree(child);
    await new Promise((r) => setTimeout(r, 500));
    await mock.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
