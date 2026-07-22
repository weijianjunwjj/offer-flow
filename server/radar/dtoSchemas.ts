import { z } from 'zod';
import { RADAR_CAPTURE_METHODS } from '../../src/domain/radar';

const nonBlankString = z.string().trim().min(1);
const nullableNonBlankString = nonBlankString.nullable();
const timestamp = z.number().finite().int().nonnegative();

/**
 * 自由形式的抽取元数据（district/详细地址/每字段 source/confidence/qualityIssues 等）。
 * 只作为原始快照旁注写入 raw_snapshot_json，不进入结构化八字段 DTO，也不进入 normalized 契约；
 * 体积做上限保护，避免异常大 payload。
 */
const extractionMetadataField = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 20_000, { message: '抽取元数据过大' })
  .nullable()
  .optional()
  .default(null);

/** 单个采集会话逐条添加时的预览条目上限。 */
export const MAX_PREVIEW_ITEMS_PER_SESSION = 8;
/** V8-2 P0 范围内可识别的最小字段集合；未提供的字段保持 null，不做推断。 */
export const RadarCaptureRecognizedFieldsSchema = z.strictObject({
  company: z.string().trim().min(1).max(200).nullable(),
  role: z.string().trim().min(1).max(200).nullable(),
  city: z.string().trim().min(1).max(100).nullable(),
  salaryMinK: z.number().finite().nonnegative().nullable(),
  salaryMaxK: z.number().finite().nonnegative().nullable(),
  salaryPeriod: z.string().trim().min(1).max(20).nullable(),
  experienceRequirement: z.string().trim().min(1).max(200).nullable(),
  educationRequirement: z.string().trim().min(1).max(100).nullable(),
});

export type RadarCaptureRecognizedFields = z.infer<typeof RadarCaptureRecognizedFieldsSchema>;

export const IdParamsSchema = z.strictObject({ id: nonBlankString });

export const CreateCaptureSessionRequestSchema = z.strictObject({
  sourceType: z.literal('browser'),
});

const AddCaptureItemRequestBaseSchema = z.strictObject({
  captureMethod: z.enum(['boss_current_page', 'generic_visible_text']),
  providerKey: nullableNonBlankString.optional().default(null),
  providerVersion: nullableNonBlankString.optional().default(null),
  sourceUrl: nullableNonBlankString.optional().default(null),
  sourceDomain: nullableNonBlankString.optional().default(null),
  pageTitle: z.string().trim().max(500).nullable().optional().default(null),
  visibleText: z.string().trim().min(1).max(50_000),
  externalRecordId: nullableNonBlankString.optional().default(null),
  recognizedFields: RadarCaptureRecognizedFieldsSchema.nullable().optional().default(null),
  extractionMetadata: extractionMetadataField,
  capturedAt: timestamp.nullable().optional().default(null),
});

/** 当前写入协议只接受浏览器扩展产出的 BOSS 定向或 generic visible-text Capture Item。 */
export const AddCaptureItemRequestSchema = AddCaptureItemRequestBaseSchema;

export type AddCaptureItemRequest = z.infer<typeof AddCaptureItemRequestBaseSchema>;

const CaptureItemCorrectionSchema = z.strictObject({
  index: z.number().finite().int().nonnegative(),
  recognizedFields: RadarCaptureRecognizedFieldsSchema,
  correctionNote: z.string().trim().min(1).max(500).nullable().optional().default(null),
});

/**
 * legacy compatibility：历史预览会话可能包含最多 20 条条目；当前新增会话仍受逐条添加的 8 条上限约束。
 */
export const CommitCaptureSessionRequestSchema = z.strictObject({
  confirmedIndexes: z.array(z.number().finite().int().nonnegative()).min(1).max(20),
  corrections: z.array(CaptureItemCorrectionSchema).max(20).optional().default([]),
});

export type CommitCaptureSessionRequest = z.infer<typeof CommitCaptureSessionRequestSchema>;

export const CancelCaptureSessionRequestSchema = z.strictObject({}).optional().default({});

/** 预览会话内单条条目的内部存储形状（写入 preview_items_json）。 */
export const RadarPreviewItemSchema = z.strictObject({
  index: z.number().finite().int().nonnegative(),
  captureMethod: z.enum(RADAR_CAPTURE_METHODS),
  providerKey: nullableNonBlankString,
  providerVersion: nullableNonBlankString,
  sourceUrl: nullableNonBlankString,
  sourceDomain: nullableNonBlankString,
  normalizedSourceUrl: nullableNonBlankString,
  pageTitle: z.string().nullable(),
  visibleText: nonBlankString,
  externalRecordId: nullableNonBlankString,
  recognizedFields: RadarCaptureRecognizedFieldsSchema.nullable(),
  extractionMetadata: extractionMetadataField,
  correctionNote: z.string().nullable(),
  capturedAt: timestamp,
  rawContentHash: nonBlankString,
});

export type RadarPreviewItem = z.infer<typeof RadarPreviewItemSchema>;
