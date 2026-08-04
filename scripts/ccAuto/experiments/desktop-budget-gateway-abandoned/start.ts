/**
 * cc-auto Desktop Budget Gateway — production start entry.
 *
 * Launched automatically on Windows login.
 * Uses zero visible terminal: windowsHide:true + no console.log to terminal.
 * All log output goes to %LOCALAPPDATA%/cc-auto-gateway/logs/gateway.log.
 * Single instance: port-in-use is explicit failure; no fallback.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { BudgetGateway } from './server';

// ======== 日志 ========
const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || '.', ''), 'cc-auto-gateway');
const LOG_DIR = path.join(DATA_DIR, 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'gateway.log');

function log(message: string) {
  const now = new Date().toISOString();
  const line = `[${now}] ${message}`;
  appendFileSync(LOG_FILE, line + '\n', 'utf8');
}

// ======== 端口独占 ========
const port = parseInt(process.env.CC_AUTO_GATEWAY_PORT || '15722', 10);
const configPath = process.env.CC_AUTO_GATEWAY_CONFIG;

const gateway = new BudgetGateway(configPath);

gateway.start().then(() => {
  // 只输出非敏感启动标识：PID、入口文件、版本、监听地址、route 公开 Base URL、启动时间。
  // 禁止输出 Key / Authorization / Header 值 / 完整 Prompt。
  log(`Gateway started. Listening: 127.0.0.1:${port}`);
  log(`PID: ${process.pid}`);
  log(`Entry: ${import.meta.url}`);
  log(`Version: v0.2.0`);
  log(`StartedAt: ${new Date().toISOString()}`);
  for (const [routeId, route] of Object.entries(gateway.getConfig().routes)) {
    // 只输出公开 Base URL，不输出任何认证信息
    log(`Route: ${routeId} -> ${new URL(route.upstreamUrl).origin}`);
  }
}).catch((err) => {
  log(`FATAL: Gateway failed to start: ${err.message}`);
});

// ======== 崩溃恢复 ========
process.on('uncaughtException', (err) => {
  log(`CRASH (uncaughtException): ${err.message}\n${err.stack || ''}`);
  // 不退出，让 Windows 服务管理器的自动重启策略生效
});

process.on('unhandledRejection', (reason) => {
  log(`CRASH (unhandledRejection): ${String(reason)}`);
});

process.on('SIGINT', () => {
  log('SIGINT received, shutting down');
  gateway.stop().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down');
  gateway.stop().then(() => process.exit(0));
});
