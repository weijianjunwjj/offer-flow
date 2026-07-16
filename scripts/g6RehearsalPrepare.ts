import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareReleaseCandidate, G6_DIR } from '../server/release-promotion/rehearsal';

/**
 * G6-A 生产迁移演练准备：只操作真实库副本与晋升来源沙箱（只读），绝不写真实库。
 * 输出脱敏演练报告（不含简历/证据/岗位备注正文）。
 */
function main(): void {
  const report = prepareReleaseCandidate();
  fs.mkdirSync(G6_DIR, { recursive: true });
  const reportPath = path.join(G6_DIR, 'offerflow-v0.7-rehearsal-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\n演练报告已写入：${reportPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
