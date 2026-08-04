/**
 * 第二层零费用测试清理：停止 mock upstream 与 Gateway（按状态文件 PID），释放端口。
 *
 * 用法：npx tsx scripts/ccAuto/gateway/stopLayer2.ts
 * 不修改 CC Switch 卡片/Profile；不访问公网。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const STATE_FILE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'cc-auto-gateway', 'layer2-state.json');

function killPid(pid: number | undefined): void {
  if (!pid || isNaN(pid)) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  console.log(`已发送终止：PID ${pid}`);
}

function main() {
  if (!fs.existsSync(STATE_FILE)) {
    console.log('未找到状态文件，无进程需要清理。');
    return;
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  killPid(state.mockPid);
  killPid(state.gatewayPid);
  fs.rmSync(STATE_FILE, { force: true });
  console.log('状态文件已清理。');
}

main();
