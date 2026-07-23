import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReviewFixtureResult } from '../server/radar/reviewFixture';

/** 轻量运行时契约：测试 worker 只读此文件，避免加载 Vite/Fastify（类型导入会被擦除）。 */
export const RUNTIME_DIR = path.join(os.tmpdir(), 'offerflow-review-e2e');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'runtime.json');

export interface ReviewE2ERuntime {
  webOnUrl: string;
  webOffUrl: string;
  apiV7Url: string;
  dbPath: string;
  fixture: ReviewFixtureResult;
  baseline: { jobs: number; applications: number; feedbackEvents: number; candidates: number };
}

export function readRuntime(): ReviewE2ERuntime {
  return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as ReviewE2ERuntime;
}
