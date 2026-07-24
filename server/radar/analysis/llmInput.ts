/**
 * V8-4 单岗位分析 · 从服务端输入快照派生**模型可见层** LLM 输入 + 证据目录。
 *
 * 严格边界：产物绝无任何内部数据库 ID（快照层允许 ID，模型层禁止），
 * 由 parseJobMatchAnalysisLlmInput 的 strict + 内部 ID 泄漏扫描 + 敏感内容扫描三重把关。
 * evidenceCatalog 的 evidenceKey 为稳定语义键（非 DB ID）：相同固定输入产出相同键。
 *
 * 本波次不调用模型；此处仅做确定性映射，供后续执行波次消费。
 */
import type { JobMatchAnalysisInputSnapshotV1 } from './contracts';
import {
  parseJobMatchAnalysisLlmInput,
  type JobMatchAnalysisLlmInputV1,
  ANALYSIS_LLM_INPUT_CONTRACT_VERSION,
} from './llmContracts';
import {
  buildOrderedKeys,
  buildSetKeys,
  collectEvidenceKeys,
  parseEvidenceCatalog,
  type AnalysisEvidenceItem,
  type EvidenceCatalogV1,
} from './evidenceCatalog';

const SHORT = 200;
const MEDIUM = 500;
const clamp = (value: string, max: number): string => value.slice(0, max);

export interface BuildLlmInputResult {
  llmInput: JobMatchAnalysisLlmInputV1;
  evidenceCatalog: EvidenceCatalogV1;
  allowedEvidenceKeys: Set<string>;
}

type Item = AnalysisEvidenceItem;
const item = (
  evidenceKey: string, kind: Item['kind'], label: string, statement: string,
  polarity: Item['polarity'], strength: Item['strength'], sourcePath: string,
): Item => ({ evidenceKey, kind, label: clamp(label, SHORT), statement: clamp(statement, MEDIUM), polarity, strength, sourcePath: clamp(sourcePath, SHORT) });

/**
 * 从快照派生稳定证据目录。业务顺序字段用 buildOrderedKeys（内容指纹，重排不漂移未重复项），
 * 集合字段用 buildSetKeys（排序后序号）。绝不放入内部 ID、JD 全文块或凭证。
 */
function buildCatalog(snapshot: JobMatchAnalysisInputSnapshotV1): EvidenceCatalogV1 {
  const items: Item[] = [];
  const facts = snapshot.candidate.normalizedFacts;

  const respKeys = buildOrderedKeys('candidate', 'responsibility', facts.responsibilities);
  facts.responsibilities.forEach((text, i) => items.push(item(respKeys[i]!, 'candidate_fact', '岗位职责', text, 'neutral', 'medium', `candidate.responsibilities[${i}]`)));
  const reqKeys = buildOrderedKeys('candidate', 'requirement', facts.requirements);
  facts.requirements.forEach((text, i) => items.push(item(reqKeys[i]!, 'candidate_fact', '岗位要求', text, 'neutral', 'medium', `candidate.requirements[${i}]`)));
  const stackKeys = buildSetKeys('candidate', 'tech-stack', facts.technicalStack);
  const sortedStack = [...new Set(facts.technicalStack.map((s) => s.trim()))].sort((a, b) => a.localeCompare(b));
  sortedStack.forEach((text, i) => items.push(item(stackKeys[i]!, 'candidate_fact', '技术栈', text, 'neutral', 'medium', `candidate.technicalStack`)));

  const profile = snapshot.jobMatchProfile.safeSnapshot;
  const capKeys = buildSetKeys('profile', 'core-capability', profile.coreCapabilities);
  const sortedCaps = [...new Set(profile.coreCapabilities.map((s) => s.trim()))].sort((a, b) => a.localeCompare(b));
  sortedCaps.forEach((text, i) => items.push(item(capKeys[i]!, 'profile_preference', '核心能力', text, 'support', 'medium', `profile.coreCapabilities`)));
  const consKeys = buildSetKeys('profile', 'constraint', profile.constraints);
  const sortedCons = [...new Set(profile.constraints.map((s) => s.trim()))].sort((a, b) => a.localeCompare(b));
  sortedCons.forEach((text, i) => items.push(item(consKeys[i]!, 'profile_preference', '约束', text, 'neutral', 'medium', `profile.constraints`)));

  if (snapshot.capabilityBaseline !== null) {
    const cap = snapshot.capabilityBaseline.safeSnapshot;
    buildSetKeys('capability', 'strength', cap.strengths).forEach((k, i) => items.push(item(k, 'capability_evidence', '能力优势', [...new Set(cap.strengths.map((s) => s.trim()))].sort((a, b) => a.localeCompare(b))[i]!, 'support', 'strong', 'capabilityBaseline.strengths')));
    buildSetKeys('capability', 'gap', cap.gaps).forEach((k, i) => items.push(item(k, 'capability_evidence', '能力缺口', [...new Set(cap.gaps.map((s) => s.trim()))].sort((a, b) => a.localeCompare(b))[i]!, 'counter', 'medium', 'capabilityBaseline.gaps')));
  }

  const rules = snapshot.ruleProjection.assessments;
  const ruleKeys = buildOrderedKeys('rule', 'result', rules.map((r) => `${r.ruleKey}:${r.result}`));
  rules.forEach((r, i) => items.push(item(ruleKeys[i]!, 'rule_result', `规则 ${r.ruleKey}`, `${r.result}（${r.explanation}）`, r.result === 'hit' ? 'counter' : 'support', r.evidenceState === 'structured' ? 'strong' : 'weak', `ruleProjection.assessments[${i}]`)));

  return parseEvidenceCatalog(items);
}

/** 薪资区间投影为脱敏文本（不带内部字段名）：如 20-35K/月。 */
function salaryText(facts: JobMatchAnalysisInputSnapshotV1['candidate']['normalizedFacts']): string | null {
  const { salaryMinK, salaryMaxK, salaryPeriod } = facts;
  if (salaryMinK === null && salaryMaxK === null) return null;
  const range = salaryMinK !== null && salaryMaxK !== null ? `${salaryMinK}-${salaryMaxK}K`
    : `${salaryMinK ?? salaryMaxK}K`;
  return salaryPeriod === null ? range : `${range}/${salaryPeriod}`;
}

/**
 * 从服务端快照派生模型可见 LLM 输入 + 证据目录。
 * 产物经 parseJobMatchAnalysisLlmInput 三重把关（strict / 内部 ID 泄漏 / 敏感内容），
 * 任一命中即抛契约错误，绝不把带内部 ID 或敏感内容的输入交给模型。
 */
export function buildJobMatchAnalysisLlmInput(
  snapshot: JobMatchAnalysisInputSnapshotV1,
): BuildLlmInputResult {
  const facts = snapshot.candidate.normalizedFacts;
  const profile = snapshot.jobMatchProfile.safeSnapshot;
  const catalog = buildCatalog(snapshot);

  const capabilities = snapshot.capabilityBaseline?.safeSnapshot.strengths ?? [];
  const person = {
    capabilities: capabilities.map((s) => clamp(s, MEDIUM)).slice(0, 100),
    experienceHighlights: [snapshot.resume.safeSnapshot.summary]
      .filter((s): s is string => s !== null && s.trim() !== '').map((s) => clamp(s, MEDIUM)).slice(0, 100),
    targetRoles: profile.targetRoles.map((s) => clamp(s, SHORT)).slice(0, 100),
    coreCapabilities: profile.coreCapabilities.map((s) => clamp(s, MEDIUM)).slice(0, 100),
    constraints: profile.constraints.map((s) => clamp(s, MEDIUM)).slice(0, 100),
    preferences: profile.preferences.map((s) => clamp(s, MEDIUM)).slice(0, 100),
  };

  const candidate: JobMatchAnalysisLlmInputV1 = {
    contractVersion: ANALYSIS_LLM_INPUT_CONTRACT_VERSION,
    promptVersion: snapshot.promptVersion,
    jobFacts: {
      company: facts.company, role: facts.role, city: facts.city, salaryText: salaryText(facts),
      experienceRequirement: facts.experienceRequirement, educationRequirement: facts.educationRequirement,
      jobNature: facts.jobNature, workMode: facts.workMode,
      technicalStack: facts.technicalStack.map((s) => clamp(s, SHORT)).slice(0, 100),
      responsibilities: facts.responsibilities.map((s) => clamp(s, MEDIUM)).slice(0, 100),
      requirements: facts.requirements.map((s) => clamp(s, MEDIUM)).slice(0, 100),
      description: clamp(facts.rawDescription, 8_000),
    },
    person,
    cityContext: snapshot.cityContext,
    ruleProjection: snapshot.ruleProjection.assessments.slice(0, 100).map((r) => ({
      ruleKey: r.ruleKey, category: r.category, result: r.result, severity: r.severity, explanation: r.explanation,
    })),
    evidenceCatalog: catalog,
  };

  const llmInput = parseJobMatchAnalysisLlmInput(candidate);
  return { llmInput, evidenceCatalog: catalog, allowedEvidenceKeys: collectEvidenceKeys(catalog) };
}
