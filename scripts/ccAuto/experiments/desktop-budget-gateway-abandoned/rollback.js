/**
 * cc-auto Desktop Budget Gateway — 回滚脚本。
 *
 * 回滚步骤：
 * 1. 停止 cc-auto gateway 进程
 * 2. 在 Claude Desktop 中切回 CC Switch profile（设置 → 第三方配置 → "CC Switch"）
 * 3. 删除 gateway 数据目录（可选）
 *
 * 不修改 CC Switch 数据库。不读取、不保存、不输出任何 API Key。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'cc-auto-gateway');

console.log('=== cc-auto Desktop Budget Gateway 回滚 ===');
console.log('');
console.log('回滚步骤：');
console.log('');
console.log('1. 在 Claude Desktop 中：');
console.log('   设置 → 第三方配置 → 选择 "CC Switch" profile → 应用');
console.log('   这会恢复 inferenceGatewayBaseUrl 为 http://127.0.0.1:15721/claude-desktop');
console.log('');
console.log('2. 停止 cc-auto gateway 进程（任务管理器 → 结束 node.exe 进程）');
console.log('');
console.log('3. (可选) 清理网关历史数据：');
if (fs.existsSync(DATA_DIR)) {
  console.log('   数据目录：' + DATA_DIR);
  console.log('   如需清理：手动删除该目录');
  console.log('   （仅含脱敏 session 摘要，不含 Key 或完整对话）');
} else {
  console.log('   数据目录不存在（无需清理）');
}

console.log('');
console.log('=== 回滚说明完毕 ===');
console.log('不需要重启 CC Switch。不需要修改任何数据库。');
console.log('恢复后 Claude Desktop 直连 CC Switch，所有功能照旧。');
