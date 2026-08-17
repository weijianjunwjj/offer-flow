import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { redactForDisk } from './redact';
import { _atomicRenameWithRetry } from './store';
import {
  sha256Canonical,
  validateWriterQualificationIdentitySnapshot,
  type WriterQualificationIdentitySnapshot,
} from './writerBenchmarkIdentity';
import {
  loadWriterQualificationBatch,
  loadWriterQualificationResultArtifact,
  type WriterQualificationResultArtifact,
} from './writerQualificationArtifact';

export const WRITER_QUALIFICATION_CERTIFICATE_SCHEMA_VERSION =
  'writer-qualification-certificate-v1' as const;
export const WRITER_QUALIFICATION_CERTIFICATE_SELECTION_SCHEMA_VERSION =
  'writer-qualification-certificate-selection-v1' as const;

const SAFE_ID = /^[A-Za-z0-9._-]{1,256}$/;

export type WriterQualificationCertificateStatus = 'ACTIVE' | 'REVOKED';
export type WriterQualificationCertificateApplicability =
  | 'ACTIVE_VALID'
  | 'REVOKED'
  | 'IDENTITY_MISMATCH'
  | 'POLICY_VERSION_MISMATCH'
  | 'BENCHMARK_VERSION_MISMATCH'
  | 'RESULT_NOT_FOUND'
  | 'RESULT_NOT_QUALIFIED'
  | 'RESULT_BINDING_MISMATCH';
export type WriterQualificationCertificateRevocationReason =
  | 'MANUAL_REVOKE'
  | 'PROFILE_DEPRECATED'
  | 'SECURITY_REVIEW';

export interface WriterQualificationCertificate {
  schemaVersion: typeof WRITER_QUALIFICATION_CERTIFICATE_SCHEMA_VERSION;
  certificateId: string;
  executionRole: 'WRITER';
  profileId: string;
  qualificationIdentityFingerprint: string;
  qualificationPolicyVersion: string;
  benchmarkContractVersion: string;
  batchId: string;
  resultId: string;
  issuedAt: string;
  status: WriterQualificationCertificateStatus;
}

export interface IssueWriterQualificationCertificateInput {
  profileId: string;
  batchId: string;
  resultId: string;
  currentQualificationIdentity: WriterQualificationIdentitySnapshot;
  requiredQualificationPolicyVersion: string;
  requiredBenchmarkContractVersion: string;
  issuedAt?: string;
}

export interface ReplaceWriterQualificationCertificateInput
  extends IssueWriterQualificationCertificateInput {
  expectedCurrentCertificateId: string;
}

export interface EvaluateWriterQualificationCertificateInput {
  certificate: WriterQualificationCertificate;
  frozenResult: WriterQualificationResultArtifact | null;
  currentQualificationIdentity: WriterQualificationIdentitySnapshot;
  requiredQualificationPolicyVersion: string;
  requiredBenchmarkContractVersion: string;
}

export interface EvaluatePersistedWriterQualificationCertificateInput {
  certificateId: string;
  profileId: string;
  currentQualificationIdentity: WriterQualificationIdentitySnapshot;
  requiredQualificationPolicyVersion: string;
  requiredBenchmarkContractVersion: string;
}

type WriterQualificationCertificateSelectionAction = 'ISSUE' | 'REPLACE' | 'REVOKE';

interface WriterQualificationCertificateSelectionEvent {
  eventId: string;
  action: WriterQualificationCertificateSelectionAction;
  certificateId: string;
  previousCertificateId: string | null;
  occurredAt: string;
  reason: WriterQualificationCertificateRevocationReason | null;
}

interface WriterQualificationCertificateSelection {
  schemaVersion: typeof WRITER_QUALIFICATION_CERTIFICATE_SELECTION_SCHEMA_VERSION;
  executionRole: 'WRITER';
  profileId: string;
  activeCertificateId: string | null;
  revision: number;
  updatedAt: string;
  events: WriterQualificationCertificateSelectionEvent[];
}

export class WriterQualificationCertificateError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WriterQualificationCertificateError';
  }
}

/** Explicitly approves one persisted QUALIFIED result. No result discovery occurs. */
export function issueWriterQualificationCertificate(
  cwd: string,
  input: IssueWriterQualificationCertificateInput,
): WriterQualificationCertificate {
  const selection = loadOrCreateSelection(cwd, input.profileId);
  if (selection.activeCertificateId !== null) throw certificateError('ACTIVE_CERTIFICATE_EXISTS');

  const certificate = prepareCertificate(cwd, input);
  assertCertificateNotPreviouslyGoverned(selection, certificate.certificateId);
  saveImmutableCertificate(cwd, certificate);
  appendSelectionEvent(cwd, selection, {
    action: 'ISSUE',
    certificateId: certificate.certificateId,
    previousCertificateId: null,
    occurredAt: certificate.issuedAt,
    reason: null,
  });
  return structuredClone(certificate);
}

/** Atomically changes the explicit selection while preserving the old certificate and history. */
export function replaceWriterQualificationCertificate(
  cwd: string,
  input: ReplaceWriterQualificationCertificateInput,
): { activeCertificate: WriterQualificationCertificate; revokedCertificate: WriterQualificationCertificate } {
  const selection = loadOrCreateSelection(cwd, input.profileId);
  if (selection.activeCertificateId !== input.expectedCurrentCertificateId) {
    throw certificateError('CURRENT_CERTIFICATE_MISMATCH');
  }
  const oldCertificate = loadWriterQualificationCertificate(
    cwd,
    input.profileId,
    input.expectedCurrentCertificateId,
  );
  if (oldCertificate.status !== 'ACTIVE') throw certificateError('CURRENT_CERTIFICATE_NOT_ACTIVE');

  const newCertificate = prepareCertificate(cwd, input);
  if (newCertificate.certificateId === oldCertificate.certificateId) {
    throw certificateError('REPLACEMENT_CERTIFICATE_UNCHANGED');
  }
  assertCertificateNotPreviouslyGoverned(selection, newCertificate.certificateId);
  saveImmutableCertificate(cwd, newCertificate);
  appendSelectionEvent(cwd, selection, {
    action: 'REPLACE',
    certificateId: newCertificate.certificateId,
    previousCertificateId: oldCertificate.certificateId,
    occurredAt: newCertificate.issuedAt,
    reason: null,
  });
  return {
    activeCertificate: structuredClone(newCertificate),
    revokedCertificate: { ...oldCertificate, status: 'REVOKED' },
  };
}

/** Revocation is append-only in the selection history; certificate.json is never edited. */
export function revokeWriterQualificationCertificate(
  cwd: string,
  profileId: string,
  certificateId: string,
  reason: WriterQualificationCertificateRevocationReason,
  revokedAt: string = new Date().toISOString(),
): WriterQualificationCertificate {
  assertRevocationReason(reason);
  assertIsoTimestamp(revokedAt, 'REVOKED_AT_INVALID');
  const selection = loadOrCreateSelection(cwd, profileId);
  if (selection.activeCertificateId !== certificateId) {
    throw certificateError('CERTIFICATE_NOT_CURRENT');
  }
  const certificate = loadWriterQualificationCertificate(cwd, profileId, certificateId);
  if (certificate.status !== 'ACTIVE') throw certificateError('CERTIFICATE_ALREADY_REVOKED');
  appendSelectionEvent(cwd, selection, {
    action: 'REVOKE',
    certificateId,
    previousCertificateId: certificateId,
    occurredAt: revokedAt,
    reason,
  });
  return { ...certificate, status: 'REVOKED' };
}

/** Reads only the explicit selection artifact; it never scans results or chooses the latest. */
export function getCurrentWriterQualificationCertificate(
  cwd: string,
  profileId: string,
): WriterQualificationCertificate | null {
  const selection = loadSelection(cwd, profileId);
  if (!selection || selection.activeCertificateId === null) return null;
  const certificate = loadWriterQualificationCertificate(
    cwd,
    profileId,
    selection.activeCertificateId,
  );
  if (certificate.status !== 'ACTIVE') throw certificateError('CURRENT_CERTIFICATE_NOT_ACTIVE');
  return certificate;
}

/** Loads an immutable issuance artifact and derives revocation from governance history. */
export function loadWriterQualificationCertificate(
  cwd: string,
  profileId: string,
  certificateId: string,
): WriterQualificationCertificate {
  assertSafeId(profileId, 'PROFILE_ID_INVALID');
  assertSafeId(certificateId, 'CERTIFICATE_ID_INVALID');
  const parsed = JSON.parse(readFileSync(
    certificatePath(cwd, profileId, certificateId),
    'utf8',
  )) as WriterQualificationCertificate;
  assertCertificate(parsed);
  if (parsed.profileId !== profileId || parsed.certificateId !== certificateId) {
    throw certificateError('CERTIFICATE_PATH_BINDING_MISMATCH');
  }
  const selection = loadSelection(cwd, profileId);
  const revoked = selection?.events.some(event => (
    (event.action === 'REVOKE' && event.certificateId === certificateId)
    || (event.action === 'REPLACE' && event.previousCertificateId === certificateId)
  )) ?? false;
  return { ...parsed, status: revoked ? 'REVOKED' : parsed.status };
}

export function evaluateWriterQualificationCertificate(
  input: EvaluateWriterQualificationCertificateInput,
): WriterQualificationCertificateApplicability {
  try {
    assertCertificate(input.certificate);
  } catch {
    return 'RESULT_BINDING_MISMATCH';
  }
  if (input.certificate.status === 'REVOKED') return 'REVOKED';
  if (input.frozenResult === null) return 'RESULT_NOT_FOUND';
  if (!resultMatchesCertificate(input.frozenResult, input.certificate)) {
    return 'RESULT_BINDING_MISMATCH';
  }
  if (input.frozenResult.status !== 'QUALIFIED') return 'RESULT_NOT_QUALIFIED';
  if (input.certificate.qualificationPolicyVersion
    !== input.requiredQualificationPolicyVersion) {
    return 'POLICY_VERSION_MISMATCH';
  }
  if (input.certificate.benchmarkContractVersion
    !== input.requiredBenchmarkContractVersion) {
    return 'BENCHMARK_VERSION_MISMATCH';
  }
  if (!validateWriterQualificationIdentitySnapshot(input.currentQualificationIdentity)
    || input.currentQualificationIdentity.profileId !== input.certificate.profileId
    || input.currentQualificationIdentity.qualificationIdentityFingerprint
      !== input.certificate.qualificationIdentityFingerprint) {
    return 'IDENTITY_MISMATCH';
  }
  return 'ACTIVE_VALID';
}

/** Re-loads the frozen result and batch before evaluating an issued certificate. */
export function evaluatePersistedWriterQualificationCertificate(
  cwd: string,
  input: EvaluatePersistedWriterQualificationCertificateInput,
): WriterQualificationCertificateApplicability {
  let certificate: WriterQualificationCertificate;
  try {
    certificate = loadWriterQualificationCertificate(cwd, input.profileId, input.certificateId);
  } catch {
    return 'RESULT_BINDING_MISMATCH';
  }
  if (certificate.status === 'REVOKED') return 'REVOKED';
  let result: WriterQualificationResultArtifact;
  try {
    result = loadWriterQualificationResultArtifact(
      cwd,
      certificate.profileId,
      certificate.batchId,
    );
  } catch (error) {
    return isFileNotFound(error) ? 'RESULT_NOT_FOUND' : 'RESULT_BINDING_MISMATCH';
  }
  try {
    assertPersistedResultBinding(cwd, result);
  } catch {
    return 'RESULT_BINDING_MISMATCH';
  }
  return evaluateWriterQualificationCertificate({
    certificate,
    frozenResult: result,
    currentQualificationIdentity: input.currentQualificationIdentity,
    requiredQualificationPolicyVersion: input.requiredQualificationPolicyVersion,
    requiredBenchmarkContractVersion: input.requiredBenchmarkContractVersion,
  });
}

export interface CurrentWriterQualificationCertificateEvaluation {
  certificate: WriterQualificationCertificate | null;
  applicability: WriterQualificationCertificateApplicability | 'CERTIFICATE_NOT_FOUND';
}

/**
 * Evaluates the *current* certificate for a profile without a caller-supplied
 * certificateId. Read-only: it never scans results to choose a certificate and
 * never edits governance artifacts.
 *
 * The revoked-but-no-longer-active case is reported distinctly from "never
 * issued", so runtime eligibility can emit a precise reason code.
 */
export function evaluateCurrentWriterQualificationCertificate(
  cwd: string,
  profileId: string,
  currentQualificationIdentity: WriterQualificationIdentitySnapshot,
  requiredQualificationPolicyVersion: string,
  requiredBenchmarkContractVersion: string,
): CurrentWriterQualificationCertificateEvaluation {
  const selection = loadSelection(cwd, profileId);
  if (!selection || selection.activeCertificateId === null) {
    const lastRevoke = [...(selection?.events ?? [])]
      .reverse()
      .find((event) => event.action === 'REVOKE');
    if (lastRevoke) {
      const revoked = loadWriterQualificationCertificate(
        cwd,
        profileId,
        lastRevoke.certificateId,
      );
      return { certificate: revoked, applicability: 'REVOKED' };
    }
    return { certificate: null, applicability: 'CERTIFICATE_NOT_FOUND' };
  }

  const certificate = loadWriterQualificationCertificate(
    cwd,
    profileId,
    selection.activeCertificateId,
  );
  const applicability = evaluatePersistedWriterQualificationCertificate(cwd, {
    certificateId: selection.activeCertificateId,
    profileId,
    currentQualificationIdentity,
    requiredQualificationPolicyVersion,
    requiredBenchmarkContractVersion,
  });
  return { certificate, applicability };
}

function prepareCertificate(
  cwd: string,
  input: IssueWriterQualificationCertificateInput,
): WriterQualificationCertificate {
  assertSafeId(input.profileId, 'PROFILE_ID_INVALID');
  assertSafeId(input.batchId, 'BATCH_ID_INVALID');
  assertSafeId(input.resultId, 'RESULT_ID_INVALID');
  const result = loadWriterQualificationResultArtifact(cwd, input.profileId, input.batchId);
  assertPersistedResultBinding(cwd, result);
  if (result.resultId !== input.resultId) throw certificateError('RESULT_BINDING_MISMATCH');
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  assertIsoTimestamp(issuedAt, 'ISSUED_AT_INVALID');
  const certificate: WriterQualificationCertificate = {
    schemaVersion: WRITER_QUALIFICATION_CERTIFICATE_SCHEMA_VERSION,
    certificateId: deterministicCertificateId(result),
    executionRole: 'WRITER',
    profileId: result.profileId,
    qualificationIdentityFingerprint: result.qualificationIdentityFingerprint,
    qualificationPolicyVersion: result.qualificationPolicyVersion,
    benchmarkContractVersion: result.benchmarkContractVersion,
    batchId: result.batchId,
    resultId: result.resultId,
    issuedAt,
    status: 'ACTIVE',
  };
  const applicability = evaluateWriterQualificationCertificate({
    certificate,
    frozenResult: result,
    currentQualificationIdentity: input.currentQualificationIdentity,
    requiredQualificationPolicyVersion: input.requiredQualificationPolicyVersion,
    requiredBenchmarkContractVersion: input.requiredBenchmarkContractVersion,
  });
  if (applicability !== 'ACTIVE_VALID') throw certificateError(applicability);
  return certificate;
}

function assertPersistedResultBinding(
  cwd: string,
  result: WriterQualificationResultArtifact,
): void {
  const batch = loadWriterQualificationBatch(cwd, result.profileId, result.batchId);
  const expectedResultId = `writer-qualification-result-${sha256Canonical({
    batchId: batch.batchId,
    qualificationIdentityFingerprint: batch.qualificationIdentityFingerprint,
    qualificationPolicyVersion: batch.qualificationPolicyVersion,
  }).slice(0, 24)}`;
  if (batch.status !== 'COMPLETE'
    || result.resultId !== expectedResultId
    || result.batchId !== batch.batchId
    || result.profileId !== batch.profileId
    || result.qualificationIdentityFingerprint !== batch.qualificationIdentityFingerprint
    || result.qualificationPolicyVersion !== batch.qualificationPolicyVersion
    || result.benchmarkContractVersion !== batch.benchmarkContractVersion) {
    throw certificateError('RESULT_BINDING_MISMATCH');
  }
}

function resultMatchesCertificate(
  result: WriterQualificationResultArtifact,
  certificate: WriterQualificationCertificate,
): boolean {
  return result.resultId === certificate.resultId
    && result.batchId === certificate.batchId
    && result.profileId === certificate.profileId
    && result.qualificationIdentityFingerprint === certificate.qualificationIdentityFingerprint
    && result.qualificationPolicyVersion === certificate.qualificationPolicyVersion
    && result.benchmarkContractVersion === certificate.benchmarkContractVersion;
}

function deterministicCertificateId(result: WriterQualificationResultArtifact): string {
  return deterministicCertificateIdFromBinding(
    result.profileId,
    result.resultId,
    result.qualificationIdentityFingerprint,
  );
}

function deterministicCertificateIdFromBinding(
  profileId: string,
  resultId: string,
  qualificationIdentityFingerprint: string,
): string {
  const suffix = sha256Canonical({
    executionRole: 'WRITER',
    profileId,
    resultId,
    qualificationIdentityFingerprint,
  }).slice(0, 24);
  return `writer-qualification-certificate-${suffix}`;
}

function saveImmutableCertificate(cwd: string, certificate: WriterQualificationCertificate): void {
  assertCertificate(certificate);
  const directory = certificateDirectory(cwd, certificate.profileId);
  mkdirSync(directory, { recursive: true });
  const target = certificatePath(cwd, certificate.profileId, certificate.certificateId);
  if (existsSync(target)) throw certificateError('IMMUTABLE_CERTIFICATE_ALREADY_EXISTS');
  writeNewJson(target, certificate);
}

function appendSelectionEvent(
  cwd: string,
  selection: WriterQualificationCertificateSelection,
  input: Omit<WriterQualificationCertificateSelectionEvent, 'eventId'>,
): void {
  const event: WriterQualificationCertificateSelectionEvent = {
    eventId: `writer-qualification-certificate-event-${sha256Canonical({
      ...input,
      profileId: selection.profileId,
      revision: selection.revision + 1,
    }).slice(0, 24)}`,
    ...input,
  };
  const next: WriterQualificationCertificateSelection = {
    ...selection,
    activeCertificateId: event.action === 'REVOKE' ? null : event.certificateId,
    revision: selection.revision + 1,
    updatedAt: event.occurredAt,
    events: [...selection.events, event],
  };
  assertSelection(next);
  saveSelection(cwd, next);
}

function loadOrCreateSelection(
  cwd: string,
  profileId: string,
): WriterQualificationCertificateSelection {
  const current = loadSelection(cwd, profileId);
  if (current) return current;
  return {
    schemaVersion: WRITER_QUALIFICATION_CERTIFICATE_SELECTION_SCHEMA_VERSION,
    executionRole: 'WRITER',
    profileId,
    activeCertificateId: null,
    revision: 0,
    updatedAt: '1970-01-01T00:00:00.000Z',
    events: [],
  };
}

function loadSelection(
  cwd: string,
  profileId: string,
): WriterQualificationCertificateSelection | null {
  assertSafeId(profileId, 'PROFILE_ID_INVALID');
  const target = selectionPath(cwd, profileId);
  if (!existsSync(target)) return null;
  const parsed = JSON.parse(readFileSync(target, 'utf8')) as WriterQualificationCertificateSelection;
  assertSelection(parsed);
  if (parsed.profileId !== profileId) throw certificateError('SELECTION_PATH_BINDING_MISMATCH');
  return parsed;
}

function saveSelection(cwd: string, selection: WriterQualificationCertificateSelection): void {
  const directory = qualificationProfileDirectory(cwd, selection.profileId);
  mkdirSync(directory, { recursive: true });
  const target = selectionPath(cwd, selection.profileId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, redactForDisk(JSON.stringify(selection, null, 2)), {
      encoding: 'utf8',
      flag: 'wx',
    });
    _atomicRenameWithRetry(temporary, target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function writeNewJson(target: string, value: unknown): void {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, redactForDisk(JSON.stringify(value, null, 2)), {
      encoding: 'utf8',
      flag: 'wx',
    });
    _atomicRenameWithRetry(temporary, target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function assertSelection(selection: WriterQualificationCertificateSelection): void {
  if (selection.schemaVersion !== WRITER_QUALIFICATION_CERTIFICATE_SELECTION_SCHEMA_VERSION
    || selection.executionRole !== 'WRITER') throw certificateError('SELECTION_SCHEMA_INVALID');
  assertSafeId(selection.profileId, 'PROFILE_ID_INVALID');
  if (!Number.isInteger(selection.revision) || selection.revision < 0
    || !Array.isArray(selection.events)
    || selection.revision !== selection.events.length) {
    throw certificateError('SELECTION_HISTORY_INVALID');
  }
  assertIsoTimestamp(selection.updatedAt, 'SELECTION_UPDATED_AT_INVALID');
  let active: string | null = null;
  const eventIds = new Set<string>();
  for (const event of selection.events) {
    assertSelectionEvent(event);
    if (eventIds.has(event.eventId)) throw certificateError('SELECTION_EVENT_DUPLICATE');
    eventIds.add(event.eventId);
    if (event.action === 'ISSUE') {
      if (active !== null || event.previousCertificateId !== null || event.reason !== null) {
        throw certificateError('SELECTION_HISTORY_INVALID');
      }
      active = event.certificateId;
    } else if (event.action === 'REPLACE') {
      if (active === null || event.previousCertificateId !== active || event.reason !== null) {
        throw certificateError('SELECTION_HISTORY_INVALID');
      }
      active = event.certificateId;
    } else {
      if (active === null || event.certificateId !== active
        || event.previousCertificateId !== active || event.reason === null) {
        throw certificateError('SELECTION_HISTORY_INVALID');
      }
      active = null;
    }
  }
  if (active !== selection.activeCertificateId) throw certificateError('SELECTION_ACTIVE_MISMATCH');
  if (selection.events.length > 0
    && selection.updatedAt !== selection.events[selection.events.length - 1].occurredAt) {
    throw certificateError('SELECTION_UPDATED_AT_MISMATCH');
  }
}

function assertSelectionEvent(event: WriterQualificationCertificateSelectionEvent): void {
  assertSafeId(event.eventId, 'SELECTION_EVENT_ID_INVALID');
  assertSafeId(event.certificateId, 'CERTIFICATE_ID_INVALID');
  if (event.previousCertificateId !== null) {
    assertSafeId(event.previousCertificateId, 'CERTIFICATE_ID_INVALID');
  }
  if (!['ISSUE', 'REPLACE', 'REVOKE'].includes(event.action)) {
    throw certificateError('SELECTION_ACTION_INVALID');
  }
  assertIsoTimestamp(event.occurredAt, 'SELECTION_EVENT_TIME_INVALID');
  if (event.reason !== null) assertRevocationReason(event.reason);
}

function assertCertificate(certificate: WriterQualificationCertificate): void {
  if (certificate.schemaVersion !== WRITER_QUALIFICATION_CERTIFICATE_SCHEMA_VERSION
    || certificate.executionRole !== 'WRITER') throw certificateError('CERTIFICATE_SCHEMA_INVALID');
  assertSafeId(certificate.certificateId, 'CERTIFICATE_ID_INVALID');
  assertSafeId(certificate.profileId, 'PROFILE_ID_INVALID');
  assertSafeId(certificate.batchId, 'BATCH_ID_INVALID');
  assertSafeId(certificate.resultId, 'RESULT_ID_INVALID');
  if (!/^[a-f0-9]{64}$/.test(certificate.qualificationIdentityFingerprint)) {
    throw certificateError('IDENTITY_FINGERPRINT_INVALID');
  }
  if (typeof certificate.qualificationPolicyVersion !== 'string'
    || certificate.qualificationPolicyVersion.length === 0
    || typeof certificate.benchmarkContractVersion !== 'string'
    || certificate.benchmarkContractVersion.length === 0) {
    throw certificateError('CERTIFICATE_VERSION_INVALID');
  }
  assertIsoTimestamp(certificate.issuedAt, 'ISSUED_AT_INVALID');
  if (certificate.status !== 'ACTIVE' && certificate.status !== 'REVOKED') {
    throw certificateError('CERTIFICATE_STATUS_INVALID');
  }
  if (certificate.certificateId !== deterministicCertificateIdFromBinding(
    certificate.profileId,
    certificate.resultId,
    certificate.qualificationIdentityFingerprint,
  )) throw certificateError('CERTIFICATE_ID_BINDING_MISMATCH');
}

function assertCertificateNotPreviouslyGoverned(
  selection: WriterQualificationCertificateSelection,
  certificateId: string,
): void {
  if (selection.events.some(event => (
    event.certificateId === certificateId || event.previousCertificateId === certificateId
  ))) throw certificateError('CERTIFICATE_ALREADY_GOVERNED');
}

function assertRevocationReason(reason: string): asserts reason is WriterQualificationCertificateRevocationReason {
  if (!['MANUAL_REVOKE', 'PROFILE_DEPRECATED', 'SECURITY_REVIEW'].includes(reason)) {
    throw certificateError('REVOCATION_REASON_INVALID');
  }
}

function qualificationProfileDirectory(cwd: string, profileId: string): string {
  return path.join(cwd, '.cc-auto', 'qualification', 'writer', profileId);
}

function certificateDirectory(cwd: string, profileId: string): string {
  return path.join(qualificationProfileDirectory(cwd, profileId), 'certificates');
}

function certificatePath(cwd: string, profileId: string, certificateId: string): string {
  return path.join(certificateDirectory(cwd, profileId), `${certificateId}.json`);
}

function selectionPath(cwd: string, profileId: string): string {
  return path.join(qualificationProfileDirectory(cwd, profileId), 'certificate-selection.json');
}

function assertSafeId(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw certificateError(code);
}

function assertIsoTimestamp(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw certificateError(code);
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: string }).code === 'ENOENT';
}

function certificateError(code: string): WriterQualificationCertificateError {
  return new WriterQualificationCertificateError(code);
}
