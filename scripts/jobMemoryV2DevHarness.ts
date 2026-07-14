import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  createServer as createViteServer,
  type InlineConfig,
  type ViteDevServer,
} from 'vite';
import {
  JobDetailBundleV2Schema,
  JobMemoryBundleSchema,
  JobSummariesResponseSchema,
  ResumeVersionListResponseSchema,
} from '../src/domain/job-memory';
import type { JobSeekerProfile } from '../src/storage';
import type { JobRecord } from '../src/storage';
import { deriveDecision, deriveLegacyDecision, resolveDecisionOpportunityFacts } from '../src/decision';
import { openDb, type SqliteDatabase } from '../server/db';
import { buildServer } from '../server/index';
import { getDatabaseSchemaVersion } from '../server/migrations';
import { ProfileRepository } from '../server/repositories/profileRepository';
import { JobRepository } from '../server/repositories/jobRepository';
import { initSchema } from '../server/schema';
import { JobMemoryService } from '../server/job-memory/jobMemoryService';

const DEV_HOST = '127.0.0.1';
const DEV_API_PORT = 17365;
const DEV_WEB_PORT = 5173;
const TEMP_PREFIX = 'offerflow-job-memory-v2-';

export const SYNTHETIC_DEV_PROFILE: JobSeekerProfile = Object.freeze({
  resumeText: '【B4 临时联调测试数据】6 年前端经验，熟悉 Vue 3 与 TypeScript。',
  projectExperience: '【B4 临时联调测试数据】OfferFlow：本地优先的 AI 求职机会决策台。',
  targetCity: '苏州（临时测试）',
  targetRole: '高级前端工程师（临时测试）',
  expectedSalary: '仅测试，不代表真实期望',
  acceptOutsourcing: false,
  acceptOvertime: false,
  jobSearchFocus: 'growth',
  weaknessNote: 'B4 临时联调合成 Profile；退出后随临时数据库删除。',
});

export const SYNTHETIC_DEV_JOB_IDS = ['b4-dev-job-frontend', 'b4-dev-job-platform'] as const;

function seedSyntheticJobMemoryData(db: SqliteDatabase): void {
  const jobs = new JobRepository(db);
  jobs.create({
    id: SYNTHETIC_DEV_JOB_IDS[0], company: 'B4 临时甲公司', role: '高级前端工程师',
    city: '苏州', salaryRange: '20-30K', jdText: 'Vue 3 TypeScript（临时数据）',
  });
  jobs.create({
    id: SYNTHETIC_DEV_JOB_IDS[1], company: 'B4 临时乙公司', role: '前端平台工程师',
    city: '上海', salaryRange: '25-35K', jdText: '工程化与平台建设（临时数据）',
  });
  let id = 0;
  let now = 1_000;
  const service = new JobMemoryService(db, {
    now: () => ++now,
    createId: () => `b4-dev-resume-${++id}`,
  });
  const first = service.createResumeVersion({
    idempotencyKey: 'b4-dev-resume-key-1',
    name: 'B4 临时主简历',
    source: 'profile_snapshot',
    summary: '前端主简历，仅用于临时联调',
    contentSnapshot: {
      resumeText: SYNTHETIC_DEV_PROFILE.resumeText,
      projectExperience: SYNTHETIC_DEV_PROFILE.projectExperience,
    },
  });
  service.createResumeVersion({
    idempotencyKey: 'b4-dev-resume-key-2',
    name: 'B4 临时平台方向简历',
    source: 'pasted_text',
    summary: '平台方向，仅用于临时联调',
    contentSnapshot: {
      resumeText: `${SYNTHETIC_DEV_PROFILE.resumeText}\n平台工程方向`,
      projectExperience: SYNTHETIC_DEV_PROFILE.projectExperience,
    },
  });
  service.activateResumeVersion(first.id, { expectedVersion: first.rowVersion });
}

function isInsidePath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function assertSafeTemporaryDbPath(dbPath: string, tempDir: string): void {
  const resolvedDbPath = path.resolve(dbPath);
  const resolvedTempDir = path.resolve(tempDir);
  const defaultRealDbPath = path.resolve(process.cwd(), 'data', 'offerflow.sqlite3');
  const repositoryDataDir = path.resolve(process.cwd(), 'data');
  if (resolvedDbPath === defaultRealDbPath) {
    throw new Error('临时联调拒绝使用默认真实数据库路径');
  }
  if (resolvedDbPath === repositoryDataDir || isInsidePath(resolvedDbPath, repositoryDataDir)) {
    throw new Error('临时联调数据库不得位于仓库 data 目录');
  }
  if (!isInsidePath(resolvedDbPath, resolvedTempDir)) {
    throw new Error('临时联调数据库必须位于本次新建的系统临时目录');
  }
  if (fs.existsSync(resolvedDbPath)) {
    throw new Error('临时联调数据库文件必须是本次新建，拒绝复用已有文件');
  }
}

export interface TemporaryJobMemoryWorkspace {
  readonly tempDir: string;
  readonly dbPath: string;
  readonly db: SqliteDatabase;
  close(): void;
}

export function createTemporaryJobMemoryWorkspace(): TemporaryJobMemoryWorkspace {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const dbPath = path.join(tempDir, 'offerflow-job-memory-v2.sqlite3');
  let db: SqliteDatabase | null = null;
  let closed = false;
  try {
    assertSafeTemporaryDbPath(dbPath, tempDir);
    db = openDb(dbPath);
    initSchema(db, { targetVersion: 2 });
    if (getDatabaseSchemaVersion(db) !== 2) {
      throw new Error('临时联调数据库未初始化到 schema v2');
    }
    new ProfileRepository(db).save({ ...SYNTHETIC_DEV_PROFILE });
    seedSyntheticJobMemoryData(db);
    const openedDb = db;
    return {
      tempDir,
      dbPath,
      db: openedDb,
      close() {
        if (closed) return;
        closed = true;
        openedDb.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    db?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function jobMemoryV2ViteConfig(): InlineConfig {
  return {
    configFile: path.resolve('vite.config.ts'),
    envFile: false,
    define: {
      'import.meta.env.VITE_OFFERFLOW_JOB_MEMORY_V2': JSON.stringify('true'),
    },
    server: {
      host: DEV_HOST,
      port: DEV_WEB_PORT,
      strictPort: true,
    },
  };
}

export function hasExplicitFrontendJobMemoryV2Flag(config: InlineConfig): boolean {
  return config.define?.['import.meta.env.VITE_OFFERFLOW_JOB_MEMORY_V2']
    === JSON.stringify('true');
}

export interface JobMemoryV2DevSession {
  readonly tempDir: string;
  readonly dbPath: string;
  readonly apiUrl: string;
  readonly webUrl: string | null;
  close(): Promise<void>;
}

export interface StartSessionOptions {
  withVite: boolean;
  apiPort?: number;
  viteFactory?: (config: InlineConfig) => Promise<ViteDevServer>;
}

export async function startJobMemoryV2DevSession(
  options: StartSessionOptions,
): Promise<JobMemoryV2DevSession> {
  const workspace = createTemporaryJobMemoryWorkspace();
  let app: FastifyInstance | null = null;
  let vite: ViteDevServer | null = null;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const closeErrors: unknown[] = [];
    if (vite !== null) {
      try {
        await vite.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (app !== null) {
      try {
        await app.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    try {
      workspace.close();
    } catch (error) {
      closeErrors.push(error);
    }
    if (closeErrors.length > 0) {
      throw new Error(`临时联调资源清理失败（${closeErrors.length} 项）`);
    }
  };

  try {
    const builtApp = buildServer({
      db: workspace.db,
      jobMemoryV2: { enabled: true },
    });
    app = builtApp;
    const apiUrl = await builtApp.listen({
      host: DEV_HOST,
      port: options.apiPort ?? DEV_API_PORT,
    });
    let webUrl: string | null = null;
    if (options.withVite) {
      const viteFactory = options.viteFactory ?? createViteServer;
      vite = await viteFactory(jobMemoryV2ViteConfig());
      await vite.listen();
      webUrl = `http://${DEV_HOST}:${DEV_WEB_PORT}`;
    }
    return {
      tempDir: workspace.tempDir,
      dbPath: workspace.dbPath,
      apiUrl,
      webUrl,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`临时联调 smoke HTTP ${response.status}`);
  }
  return body;
}

async function fetchJsonResponse(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function runLegacyV1WriteSmoke(): Promise<true> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-job-memory-v1-'));
  const dbPath = path.join(tempDir, 'offerflow-v1.sqlite3');
  const app = buildServer({ dbPath, jobMemoryV2: { enabled: false } });
  try {
    const base = await app.listen({ host: DEV_HOST, port: 0 });
    const created = await fetchJson(`${base}/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'b6-v1-job', company: 'B6 v1 临时公司', role: '前端' }),
    }) as JobRecord;
    const updated = await fetchJson(`${base}/jobs/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ communicationStatus: 'replied' }),
    }) as JobRecord;
    if (
      updated.communicationStatus !== 'replied'
      || deriveLegacyDecision(updated).nextAction !== 'continue_conversation'
    ) throw new Error('B6 smoke capability=false 未保持 legacy 写入或决策行为');
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (fs.existsSync(tempDir)) throw new Error('B6 v1 smoke 临时目录未清理');
  return true;
}

export interface JobMemoryV2SmokeReport {
  schemaVersion: 2;
  routeEnabled: true;
  frontendFlagEnabled: true;
  injectedDbOnly: true;
  syntheticProfileOnly: true;
  createdResumeVersionId: string;
  createdApplicationCount: 2;
  jobSummaryCount: 2;
  correctedApplicationRowVersion: 5;
  voidReplacementVerified: true;
  decisionProjectionVerified: true;
  legacyWriteGuardVerified: true;
  legacyV1WriteVerified: true;
  tempDirRemoved: true;
}

export async function runJobMemoryV2Smoke(): Promise<JobMemoryV2SmokeReport> {
  const session = await startJobMemoryV2DevSession({ withVite: false, apiPort: 0 });
  const tempDir = session.tempDir;
  let createdResumeVersionId = '';
  let createdApplicationCount: 2 = 2;
  let jobSummaryCount: 2 = 2;
  let correctedApplicationRowVersion: 5 = 5;
  let voidReplacementVerified: true = true;
  let decisionProjectionVerified: true = true;
  let legacyWriteGuardVerified: true = true;
  try {
    const metadata = await fetchJson(`${session.apiUrl}/meta/db-path`);
    if (
      metadata === null
      || typeof metadata !== 'object'
      || !('path' in metadata)
      || metadata.path !== ':injected:'
    ) {
      throw new Error('临时联调 Server 未使用注入数据库');
    }
    const listBefore = ResumeVersionListResponseSchema.parse(
      await fetchJson(`${session.apiUrl}/resume-versions`),
    );
    if (listBefore.resumeVersions.length !== 2 || listBefore.activeResumeVersionId === null) {
      throw new Error('临时联调数据库应预置两个简历版本和 active pointer');
    }
    const [activeResume, alternateResume] = [
      listBefore.resumeVersions.find(({ id }) => id === listBefore.activeResumeVersionId),
      listBefore.resumeVersions.find(({ id }) => id !== listBefore.activeResumeVersionId),
    ];
    if (!activeResume || !alternateResume) throw new Error('临时联调简历种子不完整');
    createdResumeVersionId = activeResume.id;
    const applicationPayload = (key: string, resumeVersionId: string, channel: 'boss' | 'referral') => ({
      idempotencyKey: key,
      resumeVersionId,
      origin: 'outbound',
      channel,
      channelOtherLabel: null,
      recruitingEntity: {
        kind: 'direct_employer', name: 'B4 临时甲公司', employerGroupKey: null, endClientName: null,
      },
      primaryContact: null,
      cityContext: { jobCity: '苏州', marketCity: '苏州', workMode: 'hybrid' },
      draftMessageText: null,
      initialEvent: {
        eventType: 'applied', eventAt: null, timePrecision: 'unknown', actor: 'user',
        sourceConfidence: 'exact', evidenceLevel: 'medium', channel, note: null, reasonCode: null, payload: {},
      },
    });
    JobMemoryBundleSchema.parse(await fetchJson(
      `${session.apiUrl}/jobs/${SYNTHETIC_DEV_JOB_IDS[0]}/applications`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(applicationPayload('b4-smoke-application-1', activeResume.id, 'boss')),
      },
    ));
    const memoryAfterRepeat = JobMemoryBundleSchema.parse(await fetchJson(
      `${session.apiUrl}/jobs/${SYNTHETIC_DEV_JOB_IDS[0]}/applications`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(applicationPayload('b4-smoke-application-2', alternateResume.id, 'referral')),
      },
    ));
    if (memoryAfterRepeat.applications.length !== 2) {
      throw new Error('临时联调未能为同一岗位保存两次独立 Application');
    }
    const eventApplication = memoryAfterRepeat.applications.find(({ record }) => record.channel === 'boss');
    if (!eventApplication || eventApplication.record.rowVersion !== 1) {
      throw new Error('B5 smoke 缺少可追加事件的初始 Application');
    }
    const smokeEventBaseAt = Date.now() + 1_000;
    const eventInput = (eventType: 'greeting_sent' | 'follow_up_sent' | 'rejected' | 'hr_replied') => ({
      eventType,
      eventAt: {
        greeting_sent: smokeEventBaseAt,
        follow_up_sent: smokeEventBaseAt + 1_000,
        rejected: smokeEventBaseAt + 2_000,
        hr_replied: smokeEventBaseAt + 3_000,
      }[eventType],
      timePrecision: 'exact',
      actor: eventType === 'greeting_sent' || eventType === 'follow_up_sent' ? 'user' : 'hr',
      sourceConfidence: 'exact',
      evidenceLevel: 'medium',
      channel: 'boss',
      note: `【B5 临时联调测试数据】${eventType}`,
      reasonCode: eventType === 'rejected' ? 'skills' : null,
      payload: {},
    });
    const afterGreeting = JobMemoryBundleSchema.parse(await fetchJson(
      `${session.apiUrl}/applications/${eventApplication.record.id}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'b5-smoke-greeting',
          expectedApplicationVersion: 1,
          ...eventInput('greeting_sent'),
        }),
      },
    ));
    if (
      afterGreeting.applications.find(({ record }) => record.id === eventApplication.record.id)
        ?.record.rowVersion !== 2
    ) {
      throw new Error('B5 smoke 追加事件后 rowVersion 未递增一次');
    }
    const afterFollowUp = JobMemoryBundleSchema.parse(await fetchJson(
      `${session.apiUrl}/applications/${eventApplication.record.id}/events`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'b6-smoke-follow-up', expectedApplicationVersion: 2,
          ...eventInput('follow_up_sent'),
        }),
      },
    ));
    const followUpMemory = afterFollowUp.applications.find(
      ({ record }) => record.id === eventApplication.record.id,
    );
    if (
      !followUpMemory
      || followUpMemory.record.rowVersion !== 3
      || followUpMemory.projection.followUpCount !== 1
      || followUpMemory.projection.nextAllowedFollowUpAt === null
    ) throw new Error('B6 smoke follow-up 投影未提供计数或 cooldown');
    const decisionBundle = JobDetailBundleV2Schema.parse(
      await fetchJson(`${session.apiUrl}/jobs/${SYNTHETIC_DEV_JOB_IDS[0]}/bundle`),
    );
    const decisionFacts = resolveDecisionOpportunityFacts({
      job: decisionBundle.job,
      selectedApplication: followUpMemory,
      defaultApplication: followUpMemory,
      availableApplications: decisionBundle.memory.applications,
      jobMemoryV2Enabled: true,
    });
    const projectedDecision = deriveDecision(decisionFacts, {
      now: followUpMemory.projection.nextAllowedFollowUpAt,
    });
    if (
      decisionFacts.source !== 'application_projection'
      || projectedDecision.nextAction !== 'follow_up_with_new_angle'
    ) throw new Error(
      `B6 smoke 决策未读取 ApplicationProjection 的 follow-up/cooldown：${decisionFacts.source}/${projectedDecision.nextAction}/${followUpMemory.projection.communicationStatus}/${followUpMemory.projection.followUpCount}/${followUpMemory.projection.nextAllowedFollowUpAt}`,
    );
    decisionProjectionVerified = true;

    const legacyBefore = await fetchJson(`${session.apiUrl}/jobs/${SYNTHETIC_DEV_JOB_IDS[0]}`) as JobRecord;
    const blockedLegacy = await fetchJsonResponse(`${session.apiUrl}/jobs/${SYNTHETIC_DEV_JOB_IDS[0]}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ communicationStatus: 'replied' }),
    });
    const blockedBody = blockedLegacy.body as { code?: unknown };
    const legacyAfter = await fetchJson(`${session.apiUrl}/jobs/${SYNTHETIC_DEV_JOB_IDS[0]}`) as JobRecord;
    if (
      blockedLegacy.status !== 422
      || blockedBody.code !== 'LEGACY_COMMUNICATION_WRITE_DISABLED'
      || legacyAfter.communicationStatus !== legacyBefore.communicationStatus
    ) throw new Error('B6 smoke v2 legacy 写入门禁或原值保护失败');
    legacyWriteGuardVerified = true;
    const afterRejected = JobMemoryBundleSchema.parse(await fetchJson(
      `${session.apiUrl}/applications/${eventApplication.record.id}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'b5-smoke-rejected',
          expectedApplicationVersion: 3,
          ...eventInput('rejected'),
        }),
      },
    ));
    const rejectedMemory = afterRejected.applications.find(
      ({ record }) => record.id === eventApplication.record.id,
    );
    const rejectedEvent = rejectedMemory?.events.find(({ eventType }) => eventType === 'rejected');
    if (
      !rejectedMemory
      || rejectedMemory.record.rowVersion !== 4
      || rejectedMemory.projection.outcome !== 'rejected'
      || !rejectedEvent
    ) {
      throw new Error('B5 smoke 第二条事件未关闭投影或版本不正确');
    }
    const rejectedFacts = resolveDecisionOpportunityFacts({
      job: decisionBundle.job, selectedApplication: rejectedMemory,
      defaultApplication: rejectedMemory, availableApplications: [rejectedMemory],
      jobMemoryV2Enabled: true,
    });
    if (deriveDecision(rejectedFacts).flowNotice?.includes('拒绝') !== true) {
      throw new Error('B6 smoke rejected Projection 未切换为停止跟进');
    }
    const bundleBeforeVoid = JobDetailBundleV2Schema.parse(
      await fetchJson(`${session.apiUrl}/jobs/${SYNTHETIC_DEV_JOB_IDS[0]}/bundle`),
    );
    if (
      bundleBeforeVoid.memory.applications.find(({ record }) => record.id === eventApplication.record.id)
        ?.projection.outcome !== 'rejected'
    ) {
      throw new Error('B5 smoke Bundle 未读回事件投影');
    }
    const afterCorrection = JobMemoryBundleSchema.parse(await fetchJson(
      `${session.apiUrl}/feedback-events/${rejectedEvent.id}/void`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'b5-smoke-correct-rejected',
          expectedApplicationVersion: 4,
          reason: '【B5 临时联调测试数据】误录为拒绝',
          replacementEvent: eventInput('hr_replied'),
        }),
      },
    ));
    const correctedMemory = afterCorrection.applications.find(
      ({ record }) => record.id === eventApplication.record.id,
    );
    const voidAudit = correctedMemory?.events.find((event) => (
      event.eventType === 'event_voided' && event.targetEventId === rejectedEvent.id
    ));
    const replacement = correctedMemory?.events.find(
      ({ idempotencyKey }) => idempotencyKey === 'b5-smoke-correct-rejected:replacement',
    );
    if (
      !correctedMemory
      || correctedMemory.record.rowVersion !== 5
      || correctedMemory.projection.stage !== 'contacted'
      || correctedMemory.projection.outcome !== null
      || !correctedMemory.events.some(({ id }) => id === rejectedEvent.id)
      || !voidAudit
      || replacement?.eventType !== 'hr_replied'
    ) {
      throw new Error('B5 smoke void + replacement 未原子保留历史或重算投影');
    }
    const correctedFacts = resolveDecisionOpportunityFacts({
      job: decisionBundle.job, selectedApplication: correctedMemory,
      defaultApplication: correctedMemory, availableApplications: [correctedMemory],
      jobMemoryV2Enabled: true,
    });
    if (deriveDecision(correctedFacts).nextAction !== 'continue_conversation') {
      throw new Error('B6 smoke void + replacement 后决策未按新 Projection 重算');
    }
    if (
      'stage' in correctedMemory.record
      || 'outcome' in correctedMemory.record
      || 'communicationStatus' in correctedMemory.record
    ) throw new Error('B6 smoke 禁止将 Projection 字段持久化到 Application');
    correctedApplicationRowVersion = correctedMemory.record.rowVersion as 5;
    voidReplacementVerified = true;
    const summaries = JobSummariesResponseSchema.parse(
      await fetchJson(`${session.apiUrl}/jobs/summaries`),
    );
    const targetSummary = summaries.find(({ job }) => job.id === SYNTHETIC_DEV_JOB_IDS[0]);
    if (
      summaries.length !== 2
      || targetSummary?.applicationCount !== 2
      || targetSummary.activeApplicationCount !== 2
      || targetSummary.defaultApplication === null
      || targetSummary.defaultApplication.projection.stage !== 'contacted'
    ) {
      throw new Error('临时联调岗位摘要未反映重复投递');
    }
    const bundle = JobDetailBundleV2Schema.parse(
      await fetchJson(`${session.apiUrl}/jobs/${SYNTHETIC_DEV_JOB_IDS[0]}/bundle`),
    );
    if (
      bundle.memory.applications.length !== 2
      || bundle.applicationSummariesByJob[SYNTHETIC_DEV_JOB_IDS[0]]?.length !== 2
    ) {
      throw new Error('临时联调 JobDetail Bundle 未读回完整流程 memory');
    }
    if (!hasExplicitFrontendJobMemoryV2Flag(jobMemoryV2ViteConfig())) {
      throw new Error('临时联调入口未显式开启前端 Job Memory v2 flag');
    }
  } finally {
    await session.close();
  }
  if (fs.existsSync(tempDir)) {
    throw new Error('临时联调退出后仍残留 SQLite 临时目录');
  }
  const legacyV1WriteVerified = await runLegacyV1WriteSmoke();
  return {
    schemaVersion: 2,
    routeEnabled: true,
    frontendFlagEnabled: true,
    injectedDbOnly: true,
    syntheticProfileOnly: true,
    createdResumeVersionId,
    createdApplicationCount,
    jobSummaryCount,
    correctedApplicationRowVersion,
    voidReplacementVerified,
    decisionProjectionVerified,
    legacyWriteGuardVerified,
    legacyV1WriteVerified,
    tempDirRemoved: true,
  };
}

type ShutdownTarget = Pick<NodeJS.Process, 'once' | 'removeListener'>;

export interface ShutdownController {
  wait(): Promise<number>;
  requestShutdown(exitCode: number, error?: unknown): Promise<void>;
  dispose(): void;
}

export function createShutdownController(
  target: ShutdownTarget,
  cleanup: () => Promise<void>,
  reportError: (error: unknown) => void = console.error,
): ShutdownController {
  let resolveExit!: (exitCode: number) => void;
  const exitPromise = new Promise<number>((resolve) => { resolveExit = resolve; });
  let shutdownPromise: Promise<void> | null = null;

  const requestShutdown = (exitCode: number, error?: unknown): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise;
    if (error !== undefined) reportError(error);
    shutdownPromise = cleanup()
      .then(() => resolveExit(exitCode))
      .catch((cleanupError: unknown) => {
        reportError(cleanupError);
        resolveExit(1);
      });
    return shutdownPromise;
  };
  const onSigint = (): void => { void requestShutdown(130); };
  const onSigterm = (): void => { void requestShutdown(143); };
  const onUncaughtException = (error: Error): void => { void requestShutdown(1, error); };
  const onUnhandledRejection = (reason: unknown): void => { void requestShutdown(1, reason); };
  target.once('SIGINT', onSigint);
  target.once('SIGTERM', onSigterm);
  target.once('uncaughtException', onUncaughtException);
  target.once('unhandledRejection', onUnhandledRejection);

  return {
    wait: () => exitPromise,
    requestShutdown,
    dispose() {
      target.removeListener('SIGINT', onSigint);
      target.removeListener('SIGTERM', onSigterm);
      target.removeListener('uncaughtException', onUncaughtException);
      target.removeListener('unhandledRejection', onUnhandledRejection);
    },
  };
}
