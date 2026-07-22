import {
  identityFromJobId, parseSalary, readCardInfo, uniqueJobIdWithin,
  type KnownJobExpected,
} from './bossExtractor';

/**
 * V8-2 批量选卡：语义卡片根识别 + 逻辑去重（纯函数）。
 *
 * - 只处理「用户亲自勾选」的卡片，不扫描/不猜测未选卡片；
 * - 从点击命中节点（或 composedPath）向上定位**最小 semanticCardRoot**：须同时含岗位标题、
 *   `/job_detail/<id>.html` 链接、且有薪资/公司/经验/学历之一；
 * - 同一 externalRecordId 的外层 div、内层 a、隐藏 clone、虚拟副本合并为一张逻辑卡（§三 去重）。
 *
 * 注意：`SelectedCard.root` 是**临时**的活 DOM 引用，仅用于选择阶段读取字段与去重；
 * 进入采集队列前必须转换为 `KnownJobExpected`（`toQueueExpected`），队列不得长期持有 DOM。
 */

export const MAX_BATCH = 8;

export interface SelectedCard {
  /** 临时活 DOM 引用（仅选择阶段用；不得进入队列快照）。 */
  root: Element;
  providerKey: string;
  externalRecordId: string;
  canonicalSourceUrl: string;
  roleFromCard: string | null;
  companyDisplayName: string | null;
  salaryFromCardNorm: string | null;
  salaryFromCard: { minK: number | null; maxK: number | null; period: string | null } | null;
  /** 薪资是否由受限的 kanzhun PUA 数字映射得到；进入预览后必须人工确认。 */
  salaryDecodedFromPua: boolean;
  experienceFromCard: string | null;
  educationFromCard: string | null;
}

function isElementNode(value: unknown): value is Element {
  return value !== null && typeof value === 'object'
    && (value as { nodeType?: number }).nodeType === 1
    && typeof (value as { querySelector?: unknown }).querySelector === 'function';
}

/** 一个节点是否构成语义卡片根：含唯一 job_detail id + 岗位标题 + 至少一项薪资/公司/经验/学历。 */
function hasSemanticCard(el: Element): boolean {
  if (uniqueJobIdWithin(el) === null) return false;
  const info = readCardInfo(el);
  if (info.role === null) return false;
  return info.salaryNorm !== null || info.company !== null || info.experience !== null || info.education !== null;
}

const MAX_CLIMB = 12;

/** 从命中节点向上定位最小语义卡片根。 */
export function resolveSemanticCardRoot(start: Element | null): Element | null {
  let node: Element | null = start;
  for (let i = 0; i < MAX_CLIMB && node !== null; i += 1) {
    if (hasSemanticCard(node)) return node;
    node = node.parentElement;
  }
  return null;
}

/** 从 event.composedPath() 定位语义卡片根：内层→外层第一个语义卡片即为最小根。 */
export function resolveSemanticCardRootFromPath(path: readonly EventTarget[]): Element | null {
  for (const target of path) {
    if (isElementNode(target) && hasSemanticCard(target)) return target;
  }
  const firstEl = path.find(isElementNode) as Element | undefined;
  return firstEl !== undefined ? resolveSemanticCardRoot(firstEl) : null;
}

/** 从语义卡片根读取稳定字段；无稳定 job_detail id 时返回 null（不入选）。 */
export function readSelectedCard(root: Element): SelectedCard | null {
  const info = readCardInfo(root);
  if (info.jobId === null) return null;
  const identity = identityFromJobId(info.jobId);
  if (identity.providerKey === null || identity.canonicalSourceUrl === null) return null;
  return {
    root,
    providerKey: identity.providerKey,
    externalRecordId: info.jobId,
    canonicalSourceUrl: identity.canonicalSourceUrl,
    roleFromCard: info.role,
    companyDisplayName: info.company,
    salaryFromCardNorm: info.salaryNorm,
    salaryFromCard: info.salaryNorm !== null ? parseSalary(info.salaryNorm) : null,
    salaryDecodedFromPua: info.salaryDecodedFromPua,
    experienceFromCard: info.experience,
    educationFromCard: info.education,
  };
}

function sameLogicalCard(a: SelectedCard, b: SelectedCard): boolean {
  if (a.externalRecordId === b.externalRecordId) return true;
  if (a.canonicalSourceUrl === b.canonicalSourceUrl) return true;
  if (a.root !== b.root && (a.root.contains(b.root) || b.root.contains(a.root))) return true;
  return false;
}

/** 逻辑去重：同 externalRecordId / canonical URL / 父子包含 视为同一岗位，保留首个选择顺序。 */
export function dedupeSelectedCards(cards: SelectedCard[]): SelectedCard[] {
  const out: SelectedCard[] = [];
  for (const card of cards) {
    if (out.some((kept) => sameLogicalCard(kept, card))) continue;
    out.push(card);
  }
  return out;
}

export interface SelectionChange {
  next: SelectedCard[];
  added: boolean;
  reason?: 'duplicate' | 'max_reached';
}

/** 勾选：去重 + 上限 8。 */
export function addToSelection(current: SelectedCard[], card: SelectedCard): SelectionChange {
  if (current.some((kept) => sameLogicalCard(kept, card))) return { next: current, added: false, reason: 'duplicate' };
  if (current.length >= MAX_BATCH) return { next: current, added: false, reason: 'max_reached' };
  return { next: [...current, card], added: true };
}

/** 取消勾选（按 externalRecordId）。 */
export function removeFromSelection(current: SelectedCard[], externalRecordId: string): SelectedCard[] {
  return current.filter((card) => card.externalRecordId !== externalRecordId);
}

/** 转换为队列期望值（剥离活 DOM 引用；队列只持有稳定数据）。 */
export function toQueueExpected(card: SelectedCard): KnownJobExpected {
  return {
    externalRecordId: card.externalRecordId,
    providerKey: card.providerKey,
    canonicalSourceUrl: card.canonicalSourceUrl,
    roleFromCard: card.roleFromCard,
    salaryFromCardNorm: card.salaryFromCardNorm,
    salaryFromCard: card.salaryFromCard,
    salaryDecodedFromPua: card.salaryDecodedFromPua,
    companyDisplayName: card.companyDisplayName,
    experienceFromCard: card.experienceFromCard,
    educationFromCard: card.educationFromCard,
  };
}
