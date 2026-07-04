import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type {
  ApplyAdvice,
  CompanySizeTier,
  ImportedJdDraft,
  JobRecord,
} from '../src/storage';
import { emptyCompanyInput } from '../src/storage';
import { withJobRecordDefaults } from '../src/storage/defaults';
import { openDb } from '../server/db';
import { initSchema } from '../server/schema';
import { JobRepository } from '../server/repositories/jobRepository';

interface JdImportInboxDraft {
  sourceType?: string;
  sourceImagePath?: string;
  companyName?: string;
  companyIndustry?: string;
  companySize?: string;
  positionTitle?: string;
  city?: string;
  district?: string;
  salaryRange?: string;
  experienceRequired?: string;
  educationRequired?: string;
  techStack?: string[];
  responsibilities?: string[];
  requirements?: string[];
  riskFlags?: string[];
  recommendedCategory?: string;
  reason?: string;
  confidence?: number;
  rawText?: string;
  importStatus?: string;
  needHumanReview?: boolean;
  missingFields?: string[];
  warnings?: string[];
  createdAt?: string;
}

interface ImportResult {
  read: number;
  imported: number;
  skippedDuplicates: number;
  failed: number;
  failures: Array<{ line: number; reason: string }>;
}

const DEFAULT_INPUT = path.join(process.cwd(), 'import', 'inbox', 'jd-import-drafts.jsonl');

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter(Boolean) : [];
}

function labelValue(rawText: string, labels: string[]): string {
  for (const label of labels) {
    const match = rawText.match(new RegExp(`${label}\\s*[:：]\\s*([^\\r\\n]+)`, 'i'));
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return '';
}

function sizeTierFromStaffRange(value: string): CompanySizeTier {
  const match = value.match(/(\d+)\s*-\s*(\d+)/);
  if (!match) {
    return 'unknown';
  }

  const upper = Number(match[2]);
  if (!Number.isFinite(upper)) {
    return 'unknown';
  }
  if (upper >= 10000) return 'giant';
  if (upper >= 1000) return 'large';
  if (upper >= 100) return 'medium';
  if (upper >= 20) return 'small';
  return 'micro';
}

function dedupeKeyOf(draft: JdImportInboxDraft): string {
  const sourceImagePath = asString(draft.sourceImagePath);
  if (sourceImagePath !== '') {
    return `source:${sourceImagePath}`;
  }

  const createdDate = asString(draft.createdAt).slice(0, 10);
  return [
    'fields',
    asString(draft.companyName),
    asString(draft.positionTitle),
    asString(draft.city),
    asString(draft.salaryRange),
    createdDate,
  ].join('|');
}

function idFromDedupeKey(dedupeKey: string): string {
  return `jd_import_${crypto.createHash('sha256').update(dedupeKey).digest('hex').slice(0, 16)}`;
}

function recommendedToAdvice(value: string): ApplyAdvice | '' {
  switch (value) {
    case 'main_attack':
      return 'ok';
    case 'give_up':
      return 'skip';
    case 'low_cost_probe':
    case 'wait_review':
    default:
      return '';
  }
}

function buildJdText(draft: JdImportInboxDraft): string {
  const rawText = asString(draft.rawText);
  if (rawText !== '') {
    return rawText;
  }

  const responsibilities = asStringArray(draft.responsibilities);
  const requirements = asStringArray(draft.requirements);
  return [
    responsibilities.length > 0 ? `职责：\n${responsibilities.join('\n')}` : '',
    requirements.length > 0 ? `要求：\n${requirements.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildImportedDraft(draft: JdImportInboxDraft): ImportedJdDraft {
  return {
    recommendedCategory: asString(draft.recommendedCategory) || 'wait_review',
    reason: asString(draft.reason),
    confidence: typeof draft.confidence === 'number' && Number.isFinite(draft.confidence)
      ? draft.confidence
      : null,
    riskFlags: asStringArray(draft.riskFlags),
    warnings: asStringArray(draft.warnings),
    missingFields: asStringArray(draft.missingFields),
    rawText: asString(draft.rawText),
    sourceCreatedAt: asString(draft.createdAt) || undefined,
  };
}

function toJobRecord(draft: JdImportInboxDraft): JobRecord {
  const dedupeKey = dedupeKeyOf(draft);
  const now = Date.now();
  const rawText = asString(draft.rawText);
  const companySize = asString(draft.companySize);
  const financingStage = labelValue(rawText, ['融资']);
  const industry = asString(draft.companyIndustry);
  const techStack = asStringArray(draft.techStack);
  const warnings = asStringArray(draft.warnings);
  const riskFlags = asStringArray(draft.riskFlags);
  const recommendedCategory = asString(draft.recommendedCategory) || 'wait_review';
  const reason = asString(draft.reason);
  const confidence = typeof draft.confidence === 'number' && Number.isFinite(draft.confidence)
    ? draft.confidence
    : null;

  const reportRisks = [...riskFlags, ...warnings].join('\n');
  const reportSummary = [
    reason,
    confidence === null ? '' : `置信度：${confidence}`,
    recommendedCategory === '' ? '' : `推荐分类：${recommendedCategory}`,
  ].filter(Boolean).join('\n');

  return withJobRecordDefaults({
    id: idFromDedupeKey(dedupeKey),
    createdAt: now,
    updatedAt: now,
    company: asString(draft.companyName),
    role: asString(draft.positionTitle),
    city: asString(draft.city),
    salaryRange: asString(draft.salaryRange),
    jdText: buildJdText(draft),
    promptText: '',
    aiRawResult: [
      'JD import draft',
      reportSummary,
      reportRisks === '' ? '' : `风险/提醒：\n${reportRisks}`,
    ].filter(Boolean).join('\n\n'),
    aiPastedAt: null,
    parseStatus: 'unparsed',
    report: {
      jobType: 'imported_jd_draft',
      keywords: techStack.join('、'),
      techStackMatch: techStack.join('、'),
      projectMatch: '',
      strengths: reportSummary,
      risks: reportRisks,
      resumeAdvice: '',
      interviewChecklist: asStringArray(draft.requirements).join('\n'),
      applyAdvice: recommendedToAdvice(recommendedCategory),
      greetingMessage: '',
    },
    matchScore: '',
    companyInput: {
      ...emptyCompanyInput(),
      sizeTier: sizeTierFromStaffRange(companySize),
      staffRange: companySize,
      companyType: industry,
      financingStage,
      opportunityNote: [
        asString(draft.experienceRequired) === '' ? '' : `经验：${asString(draft.experienceRequired)}`,
        asString(draft.educationRequired) === '' ? '' : `学历：${asString(draft.educationRequired)}`,
        recommendedCategory === '' ? '' : `JD 导入推荐：${recommendedCategory}`,
      ].filter(Boolean).join('\n'),
    },
    companyAssessment: null,
    opportunityAnalysis: null,
    communicationStatus: 'paused',
    followupCount: 0,
    highValueSignal: false,
    strategyOverride: 'cautious_watch',
    importStatus: 'imported_draft',
    reviewStatus: 'pending_review',
    importSource: {
      sourceType: asString(draft.sourceType) || 'jd_import',
      sourceImagePath: asString(draft.sourceImagePath) || undefined,
      dedupeKey,
      importedAt: now,
    },
    importedDraft: buildImportedDraft(draft),
  });
}

function readJsonLines(inputPath: string): Array<{ line: number; draft?: JdImportInboxDraft; error?: string }> {
  const text = fs.readFileSync(inputPath, 'utf8');
  const rows: Array<{ line: number; draft?: JdImportInboxDraft; error?: string }> = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === '') {
      return;
    }

    try {
      rows.push({ line: lineNumber, draft: JSON.parse(trimmed) as JdImportInboxDraft });
    } catch (error) {
      rows.push({ line: lineNumber, error: (error as Error).message });
    }
  });
  return rows;
}

export function importJdDrafts(inputPath = DEFAULT_INPUT): ImportResult {
  const absoluteInputPath = path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(absoluteInputPath)) {
    throw new Error(`JD draft inbox not found: ${absoluteInputPath}`);
  }

  const db = openDb();
  initSchema(db);
  const repo = new JobRepository(db);
  const existingKeys = new Set(
    repo.list().map((job) => job.importSource?.dedupeKey).filter((value): value is string => !!value),
  );
  const rows = readJsonLines(absoluteInputPath);
  const result: ImportResult = {
    read: rows.filter((row) => row.draft !== undefined).length,
    imported: 0,
    skippedDuplicates: 0,
    failed: rows.filter((row) => row.error !== undefined).length,
    failures: rows
      .filter((row): row is { line: number; error: string } => row.error !== undefined)
      .map((row) => ({ line: row.line, reason: row.error })),
  };

  try {
    for (const row of rows) {
      if (!row.draft) {
        continue;
      }

      try {
        const dedupeKey = dedupeKeyOf(row.draft);
        if (existingKeys.has(dedupeKey)) {
          result.skippedDuplicates += 1;
          continue;
        }

        const job = toJobRecord(row.draft);
        repo.create(job);
        existingKeys.add(dedupeKey);
        result.imported += 1;
      } catch (error) {
        result.failed += 1;
        result.failures.push({ line: row.line, reason: (error as Error).message });
      }
    }
  } finally {
    db.close();
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = importJdDrafts(process.argv[2] ?? DEFAULT_INPUT);
    console.log([
      `JD drafts read: ${result.read}`,
      `Imported: ${result.imported}`,
      `Skipped duplicates: ${result.skippedDuplicates}`,
      `Failed: ${result.failed}`,
      ...result.failures.map((failure) => `Line ${failure.line}: ${failure.reason}`),
    ].join('\n'));
    if (result.failed > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
