import { nanoid } from 'nanoid';
import type {
  ResumeContentSnapshot,
  ResumeVersionRecord,
} from '../domain/job-memory';
import type { JobSeekerProfile } from '../storage';

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function buildProfileResumeSnapshot(profile: JobSeekerProfile): ResumeContentSnapshot {
  return {
    resumeText: normalizeLineEndings(profile.resumeText),
    projectExperience: normalizeLineEndings(profile.projectExperience),
  };
}

export function hasResumeContent(snapshot: ResumeContentSnapshot): boolean {
  return snapshot.resumeText.trim() !== '' || snapshot.projectExperience.trim() !== '';
}

export function sortResumeVersions(
  resumeVersions: readonly ResumeVersionRecord[],
  activeResumeVersionId: string | null,
): ResumeVersionRecord[] {
  return [...resumeVersions].sort((left, right) => {
    const activeDifference = Number(right.id === activeResumeVersionId)
      - Number(left.id === activeResumeVersionId);
    if (activeDifference !== 0) return activeDifference;
    const archiveDifference = Number(left.archivedAt !== null) - Number(right.archivedAt !== null);
    if (archiveDifference !== 0) return archiveDifference;
    const createdDifference = right.createdAt - left.createdAt;
    return createdDifference !== 0 ? createdDifference : left.id.localeCompare(right.id);
  });
}

export function shortContentHash(contentHash: string): string {
  return contentHash.slice(0, 10);
}

function canonicalSnapshotJson(snapshot: ResumeContentSnapshot): string {
  return JSON.stringify({
    projectExperience: snapshot.projectExperience,
    resumeText: snapshot.resumeText,
  });
}

export async function hashResumeContentSnapshot(snapshot: ResumeContentSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalSnapshotJson(snapshot));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export function createResumeIdempotencyKey(): string {
  return `resume-version-${Date.now()}-${nanoid()}`;
}

export function defaultResumeVersionName(now = new Date()): string {
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0'))
    .join('-');
  return `简历快照 ${date}`;
}
