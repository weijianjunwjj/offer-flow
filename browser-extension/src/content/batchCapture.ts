import {
  CARD_SELECTOR, captureKnownJobFromRightPanel, jobIdFromHref, readCardInfo, uniqueJobIdWithin,
} from '../extractors/bossExtractor';
import {
  addToSelection, dedupeSelectedCards, MAX_BATCH, readSelectedCard, removeFromSelection,
  resolveSemanticCardRoot, toQueueExpected, type SelectedCard,
} from '../extractors/semanticCard';
import { BatchQueue } from './batchQueue';
import { runBatch, type RunnerEffects } from './batchRunner';
import { buildBatchSubmitItems, type BatchSubmitContext } from './batchPayload';
import { BATCH_SUBMIT_MESSAGE, type BatchSubmitMessage, type BatchSubmitResponse } from './batchMessages';

/**
 * V8-2 BOSS 列表页「手动批量选卡 + 串行右侧详情采集」注入入口（自包含，仅用户点击后注入一次）。
 *
 * 边界（§二）：仅 zhipin.com /web/geek/jobs；仅采集用户亲自勾选的岗位；单批 ≤8；串行；支持
 * 暂停/继续/取消；程序化点击只用于切换右侧详情。不扫描未选卡片、不自动滚动、不改搜索条件、
 * 不投递/打招呼。页面刷新/导航/关闭会终止并丢弃未完成批次（无持久化）。
 */

const MOUNT_FLAG = '__OFFERFLOW_BATCH_MOUNTED__';
const RIGHT_PANEL_SELECTOR = '.job-detail-box, .job-detail-container, .job-detail-body';
const STABLE_MS = 450;
const MAX_WAIT_MS = 6000;
const INTER_ITEM_MS = 1000;

type MountableWindow = Window & { [MOUNT_FLAG]?: boolean };

function isListPage(): boolean {
  try {
    const url = new URL(window.location.href);
    return (url.hostname === 'www.zhipin.com' || url.hostname.endsWith('.zhipin.com'))
      && /\/web\/geek\/jobs?/.test(url.pathname);
  } catch {
    return false;
  }
}

function rightPanelContainer(): Element | null {
  return document.querySelector(RIGHT_PANEL_SELECTOR);
}

function rightPanelJobId(): string | null {
  const container = rightPanelContainer();
  return container !== null ? uniqueJobIdWithin(container) : null;
}

function rightPanelFingerprint(): string {
  const container = rightPanelContainer();
  const id = rightPanelJobId() ?? '';
  const len = container?.textContent?.length ?? 0;
  return `${id}|${len}`;
}

/** 在当前 DOM 按 externalRecordId 重新定位卡片（队列不持久 DOM）。 */
function relocateCard(externalRecordId: string): Element | null {
  const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
  for (const card of cards) {
    if (uniqueJobIdWithin(card) === externalRecordId) return card;
  }
  return null;
}

function nativeClick(card: Element): void {
  const clickable = card.querySelector('a[href*="/job_detail/"]') ?? card;
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click'] as const) {
    clickable.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
}

/** 等右侧详情 fingerprint 改变并稳定；超时返回 timedOut=true。 */
function waitForRightPanelStable(): Promise<{ timedOut: boolean }> {
  return new Promise((resolve) => {
    let lastFingerprint = rightPanelFingerprint();
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      const fp = rightPanelFingerprint();
      if (fp !== lastFingerprint) {
        lastFingerprint = fp;
        if (stableTimer !== null) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => { cleanup(); resolve({ timedOut: false }); }, STABLE_MS);
      }
    });
    const maxTimer = setTimeout(() => { cleanup(); resolve({ timedOut: true }); }, MAX_WAIT_MS);
    function cleanup(): void {
      observer.disconnect();
      if (stableTimer !== null) clearTimeout(stableTimer);
      clearTimeout(maxTimer);
    }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

const CARD_SKIP_REASONS = [
  'missing_job_detail_href',
  'invalid_external_record_id',
  'missing_role',
  'missing_company',
  'missing_salary_or_tags',
  'hidden_clone',
  'duplicate_logical_card',
  'unsupported_card_structure',
  'detached_root',
  'host_mount_failed',
  'host_removed_after_mount',
  'other',
] as const;

type CardSkipReason = typeof CARD_SKIP_REASONS[number];

interface DiagnosticRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DiagnosticCandidateSample {
  candidateIndex: number;
  accepted: boolean;
  rejectionReason: CardSkipReason | null;
  tagName: string;
  id: string;
  className: string;
  rect: DiagnosticRect;
  display: string;
  visibility: string;
  opacity: string;
  ariaHidden: string | null;
  connected: boolean;
  detectedRole: string | null;
  detectedCompany: string | null;
  detectedSalary: string | null;
  hrefPath: string | null;
  externalRecordIdParsed: boolean;
  semanticRoot: { tagName: string; className: string } | null;
  semanticRootRect: DiagnosticRect | null;
  semanticRootSelectorReason: 'resolveSemanticCardRoot' | 'candidateShell_card_root' | 'not_found';
  hostMountAttempted: boolean;
  hostMountSucceeded: boolean;
  hostConnectedAfterReconcile: boolean;
}

interface DiagnosticCandidateRecord {
  node: Element;
  root: Element | null;
  jobId: string | null;
  sample: DiagnosticCandidateSample;
}

interface ScannedCard {
  root: Element;
  selected: SelectedCard;
  diagnostics: DiagnosticCandidateRecord[];
}

type ReasonCounts = Record<CardSkipReason, number>;

interface CardScanResult {
  listContainerFound: boolean;
  listContainerSelector: string | null;
  rawCandidateNodeCount: number;
  uniqueCandidateNodeCount: number;
  semanticRootCandidateCount: number;
  acceptedLogicalCardCount: number;
  duplicateExternalRecordIdCount: number;
  hiddenCloneCount: number;
  reasonCounts: ReasonCounts;
  records: DiagnosticCandidateRecord[];
  cards: ScannedCard[];
}

interface ReconciliationDiagnostics {
  pageUrlPath: string;
  reconciliationRunCount: number;
  listContainerFound: boolean;
  listContainerSelector: string | null;
  rawCandidateNodeCount: number;
  uniqueCandidateNodeCount: number;
  semanticRootCandidateCount: number;
  acceptedLogicalCardCount: number;
  mountedHostCount: number;
  connectedHostCount: number;
  removedOrphanHostCount: number;
  duplicateExternalRecordIdCount: number;
  hiddenCloneCount: number;
  currentSelectionCount: number;
  visibleHostCount: number;
  hostVisualStates: Array<{
    hostIndex: number;
    connected: boolean;
    rect: DiagnosticRect;
    display: string;
    visibility: string;
    opacity: string;
    pointerEvents: string;
    zIndex: string;
    overflowClipping: string;
    disabled: boolean;
    checked: boolean;
  }>;
  fieldProbe: {
    selectedCard: DiagnosticFieldProbe | null;
    rightPanel: DiagnosticFieldProbe | null;
  };
  reasonCounts: ReasonCounts;
  skipped: Array<{ reason: CardSkipReason; count: number }>;
  candidateSamples: DiagnosticCandidateSample[];
  semanticRootRequirements: {
    jobDetailHref: true;
    role: true;
    company: false;
    salaryOrCompanyOrTags: true;
    acceptanceRequiresCompany: false;
    note: string;
  };
}

interface DiagnosticFieldNode {
  tagName: string;
  className: string;
  text: string;
  hrefPath: string | null;
  ariaLabel: string | null;
  title: string | null;
  dataSalary: string | null;
  dataVSalary: string | null;
  ka: string | null;
  codePoints: string[];
  fontFamily: string;
}

interface DiagnosticFieldProbe {
  rootTagName: string;
  rootClassName: string;
  descendantClassNames: string[];
  companyCandidates: DiagnosticFieldNode[];
  salaryCandidates: DiagnosticFieldNode[];
}

interface CheckboxMount {
  root: HTMLElement;
  host: HTMLSpanElement;
  input: HTMLInputElement;
  restoredPosition: string;
}

function candidateShell(start: Element): Element | null {
  let node: Element | null = start.parentElement;
  for (let depth = 0; depth < 10 && node !== null; depth += 1) {
    if (node.matches('.job-card-box, li.job-card-wrapper, [class*="job-card-item"], .job-list-container > li')) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function isRenderedCard(root: Element): boolean {
  if (!root.isConnected || root.getAttribute('aria-hidden') === 'true') return false;
  let node: Element | null = root;
  while (node !== null && node !== document.documentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    node = node.parentElement;
  }
  const rect = root.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function emptyReasonCounts(): ReasonCounts {
  return Object.fromEntries(CARD_SKIP_REASONS.map((reason) => [reason, 0])) as ReasonCounts;
}

function redactedText(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const redacted = value.replace(/securityid|token|cookie/gi, '[redacted]').trim();
  return redacted.length > 0 ? redacted.slice(0, maxLength) : null;
}

function diagnosticRect(element: Element | null): DiagnosticRect | null {
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function hrefPath(href: string | null): string | null {
  if (href === null) return null;
  try {
    return new URL(href, window.location.href).pathname;
  } catch {
    return null;
  }
}

function candidateSample(index: number, node: Element): DiagnosticCandidateSample {
  const style = getComputedStyle(node);
  return {
    candidateIndex: index,
    accepted: false,
    rejectionReason: null,
    tagName: node.tagName.toLowerCase(),
    id: redactedText(node.id, 120) ?? '',
    className: redactedText(node.getAttribute('class'), 160) ?? '',
    rect: diagnosticRect(node) ?? { left: 0, top: 0, width: 0, height: 0 },
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    ariaHidden: redactedText(node.getAttribute('aria-hidden'), 20),
    connected: node.isConnected,
    detectedRole: null,
    detectedCompany: null,
    detectedSalary: null,
    hrefPath: null,
    externalRecordIdParsed: false,
    semanticRoot: null,
    semanticRootRect: null,
    semanticRootSelectorReason: 'not_found',
    hostMountAttempted: false,
    hostMountSucceeded: false,
    hostConnectedAfterReconcile: false,
  };
}

function diagnosticFieldText(value: string | null | undefined, maxLength = 40): string {
  if (value === null || value === undefined) return '';
  let output = '';
  for (const ch of value.trim()) {
    const cp = ch.codePointAt(0) ?? 0;
    const abnormal = (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;
    output += abnormal ? `[U+${cp.toString(16).toUpperCase()}]` : ch;
    if (output.length >= maxLength) break;
  }
  return redactedText(output, maxLength) ?? '';
}

function fieldNodeProbe(element: Element): DiagnosticFieldNode {
  const rawText = element.textContent?.trim() ?? '';
  let fontFamily = '';
  try { fontFamily = redactedText(getComputedStyle(element).fontFamily, 120) ?? ''; } catch { /* detached */ }
  return {
    tagName: element.tagName.toLowerCase(),
    className: redactedText(element.getAttribute('class'), 160) ?? '',
    text: diagnosticFieldText(rawText),
    hrefPath: element instanceof HTMLAnchorElement ? hrefPath(element.getAttribute('href')) : null,
    ariaLabel: redactedText(element.getAttribute('aria-label'), 60),
    title: redactedText(element.getAttribute('title'), 60),
    dataSalary: redactedText(element.getAttribute('data-salary'), 60),
    dataVSalary: redactedText(element.getAttribute('data-v-salary'), 60),
    ka: redactedText(element.getAttribute('ka'), 80),
    codePoints: [...rawText].slice(0, 30).map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}`),
    fontFamily,
  };
}

function fieldProbe(root: Element | null): DiagnosticFieldProbe | null {
  if (root === null) return null;
  const nodes = Array.from(root.querySelectorAll<Element>('*'));
  const safe = (element: Element): boolean => !element.matches('script, style, noscript') && element.closest(
    '.boss-name, .job-boss-info .name, [class*="recruiter"], [class*="chat"], [class*="im-"], [class*="avatar"], [ka*="boss"]',
  ) === null;
  const companyCandidates = nodes.filter((element) => safe(element) && (
    /company|brand/i.test(element.getAttribute('class') ?? '')
    || /company/i.test(element.getAttribute('ka') ?? '')
    || element.matches('.job-boss-info .boss-info-attr')
    || (element instanceof HTMLAnchorElement && hrefPath(element.getAttribute('href'))?.startsWith('/gongsi/') === true)
  )).slice(0, 8).map(fieldNodeProbe);
  const salaryCandidates = nodes.filter((element) => {
    if (!safe(element)) return false;
    const attrs = [element.getAttribute('class'), element.getAttribute('id'), element.getAttribute('aria-label'),
      element.getAttribute('title'), element.getAttribute('data-salary'), element.getAttribute('data-v-salary')]
      .filter((value): value is string => value !== null).join(' ');
    const text = element.textContent?.trim() ?? '';
    const shortSalaryText = text.length <= 60 && (/[Kk千万元]|面议/.test(text)
      || [...text].some((char) => { const cp = char.codePointAt(0) ?? 0; return (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000; }));
    return /salary|money|pay/i.test(attrs) || shortSalaryText;
  }).slice(0, 8).map(fieldNodeProbe);
  const descendantClassNames = [...new Set(nodes.map((element) => redactedText(element.getAttribute('class'), 160) ?? '')
    .filter((className) => className.length > 0 && !/boss-name|recruiter|chat|im-|avatar/i.test(className)))].slice(0, 36);
  return {
    rootTagName: root.tagName.toLowerCase(),
    rootClassName: redactedText(root.getAttribute('class'), 160) ?? '',
    descendantClassNames,
    companyCandidates,
    salaryCandidates,
  };
}

function rejectCandidate(record: DiagnosticCandidateRecord, reason: CardSkipReason, counts: ReasonCounts): void {
  record.sample.accepted = false;
  record.sample.rejectionReason = reason;
  counts[reason] += 1;
}

/**
 * 扫描真实已渲染卡片并归并 semantic root。扫描证据写入 overlay host 的 data 属性，供真实页审计与
 * Playwright 读取；不包含 JD、Cookie、Token 或招聘者信息。
 */
function scanCards(): CardScanResult {
  const reasonCounts = emptyReasonCounts();
  const semanticRoots = new Set<Element>();
  const byId = new Map<string, ScannedCard>();
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/job_detail/"]'));
  const selectorNodes = Array.from(document.querySelectorAll<Element>(CARD_SELECTOR));
  const uniqueNodes = [...new Set<Element>([...anchors, ...selectorNodes])];
  const records = uniqueNodes.map<DiagnosticCandidateRecord>((node, index) => ({
    node,
    root: null,
    jobId: null,
    sample: candidateSample(index, node),
  }));
  const recordByNode = new Map(records.map((record) => [record.node, record]));
  const processed = new Set<Element>();
  let duplicateExternalRecordIdCount = 0;
  let hiddenCloneCount = 0;

  const classify = (record: DiagnosticCandidateRecord, anchor: HTMLAnchorElement): void => {
    processed.add(record.node);
    const rawHref = anchor.getAttribute('href');
    const jobId = jobIdFromHref(rawHref);
    const strictRoot = resolveSemanticCardRoot(anchor.parentElement);
    // 真实列表的岗位信息与公司信息是兄弟节点；挂载和字段读取应使用卡片 shell，
    // 而不是提前停在只含岗位信息的 `.job-info`。无已知 shell 时才保留原 semantic root。
    const shellRoot = candidateShell(anchor);
    const root = shellRoot ?? strictRoot;
    record.jobId = jobId;
    record.root = root;
    record.sample.hrefPath = hrefPath(rawHref);
    record.sample.externalRecordIdParsed = jobId !== null;
    record.sample.semanticRootSelectorReason = shellRoot !== null
      ? 'candidateShell_card_root'
      : (strictRoot !== null ? 'resolveSemanticCardRoot' : 'not_found');
    if (root !== null) {
      semanticRoots.add(root);
      record.sample.semanticRoot = {
        tagName: root.tagName.toLowerCase(),
        className: redactedText(root.getAttribute('class'), 160) ?? '',
      };
      record.sample.semanticRootRect = diagnosticRect(root);
      const info = readCardInfo(root);
      record.sample.detectedRole = redactedText(info.role, 40);
      record.sample.detectedCompany = redactedText(info.company, 40);
      record.sample.detectedSalary = redactedText(info.salaryNorm, 30);
    }
    if (!record.node.isConnected || (root !== null && !root.isConnected)) {
      rejectCandidate(record, 'detached_root', reasonCounts);
      return;
    }
    if (jobId === null) {
      rejectCandidate(record, 'invalid_external_record_id', reasonCounts);
      return;
    }
    if (root === null) {
      rejectCandidate(record, 'unsupported_card_structure', reasonCounts);
      return;
    }
    const info = readCardInfo(root);
    if (info.role === null) {
      rejectCandidate(record, 'missing_role', reasonCounts);
      return;
    }
    // companyDisplayName 在选择快照中本来就是 nullable；稳定 job id + role 足以建立选择身份。
    // 公司缺失留给后续预览人工确认，不能阻止 checkbox host 挂载。
    if (!isRenderedCard(root)) {
      hiddenCloneCount += 1;
      rejectCandidate(record, 'hidden_clone', reasonCounts);
      return;
    }
    const selected = readSelectedCard(root);
    if (selected === null) {
      rejectCandidate(record, 'unsupported_card_structure', reasonCounts);
      return;
    }
    if (byId.has(jobId)) {
      duplicateExternalRecordIdCount += 1;
      rejectCandidate(record, 'duplicate_logical_card', reasonCounts);
      return;
    }
    record.sample.accepted = true;
    record.sample.rejectionReason = null;
    byId.set(jobId, { root, selected, diagnostics: [record] });
  };

  // 保持现有识别顺序：job_detail anchor 先进入原判定链；其余 CARD_SELECTOR 节点只做诊断归类。
  for (const anchor of anchors) {
    const record = recordByNode.get(anchor);
    if (record !== undefined) classify(record, anchor);
  }
  for (const record of records) {
    if (processed.has(record.node)) continue;
    const anchor = record.node.querySelector<HTMLAnchorElement>('a[href*="/job_detail/"]');
    if (anchor === null) {
      rejectCandidate(record, 'missing_job_detail_href', reasonCounts);
      continue;
    }
    classify(record, anchor);
  }

  const listContainerSelectors = ['.job-list-container', '.job-list-wrapper'];
  const listContainerSelector = listContainerSelectors.find((selector) => document.querySelector(selector) !== null) ?? null;

  return {
    listContainerFound: listContainerSelector !== null,
    listContainerSelector,
    rawCandidateNodeCount: anchors.length + selectorNodes.length,
    uniqueCandidateNodeCount: uniqueNodes.length,
    semanticRootCandidateCount: semanticRoots.size,
    acceptedLogicalCardCount: byId.size,
    duplicateExternalRecordIdCount,
    hiddenCloneCount,
    reasonCounts,
    records,
    cards: [...byId.values()],
  };
}

class BatchOverlay {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private selection: SelectedCard[] = [];
  private mounts = new Map<string, CheckboxMount>();
  private observer: MutationObserver | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileCount = 0;
  private queue: BatchQueue | null = null;
  private cancelled = false;
  private collapsed = false;
  private diagnosticsOpen = false;
  private latestDiagnostics: ReconciliationDiagnostics | null = null;
  private diagnosticHistory: Array<Pick<ReconciliationDiagnostics,
    'reconciliationRunCount' | 'rawCandidateNodeCount' | 'acceptedLogicalCardCount'
    | 'mountedHostCount' | 'connectedHostCount' | 'removedOrphanHostCount'>> = [];
  private bar!: HTMLDivElement;
  private bodyEl!: HTMLDivElement;
  private statusEl!: HTMLElement;
  private countEl!: HTMLElement;
  private startBtn!: HTMLButtonElement;
  private pauseBtn!: HTMLButtonElement;
  private diagnosticsPanel!: HTMLDivElement;
  private diagnosticsSummary!: HTMLDivElement;
  private diagnosticsReasons!: HTMLDivElement;
  private diagnosticsPreview!: HTMLPreElement;
  private diagnosticsCopyStatus!: HTMLElement;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.teardown();
  };
  private readonly onResize = (): void => this.clampToViewport();

  constructor() {
    this.host = document.createElement('div');
    this.host.setAttribute('data-offerflow-batch-root', 'true');
    this.host.setAttribute('data-offerflow-selection-count', '0');
    this.host.setAttribute('data-offerflow-collapsed', 'false');
    this.host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    document.body.appendChild(this.host);
    this.renderBar();
    this.reconcile();
    this.startObserver();
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('resize', this.onResize);
    requestAnimationFrame(() => this.clampToViewport());
  }

  private renderBar(): void {
    const style = document.createElement('style');
    style.textContent = `
      .bar{position:fixed;top:max(104px,calc(env(safe-area-inset-top,0px) + 16px));right:16px;z-index:2147483647;
        width:300px;box-sizing:border-box;background:#0f172a;color:#fff;border-radius:12px;padding:12px 14px 14px;
        font:13px/1.5 system-ui,sans-serif;box-shadow:0 12px 30px -12px rgba(0,0,0,.6);touch-action:none;}
      .drag-handle{display:flex;align-items:center;gap:8px;cursor:move;user-select:none;touch-action:none;}
      .bar h4{margin:0;min-width:0;flex:1;font-size:14px;}
      .diagnostics-toggle{margin:0 4px 0 0;padding:2px 7px;background:#334155;color:#fff;}
      .collapse{margin:0;padding:2px 7px;background:#334155;color:#fff;}
      .body[hidden]{display:none;}
      .body{padding-top:6px;}
      .count{color:#93c5fd;font-weight:700;}
      .status{margin:8px 0;min-height:18px;color:#cbd5e1;}
      button{margin:4px 4px 0 0;padding:6px 10px;border:0;border-radius:8px;cursor:pointer;font-size:12px;}
      .primary{background:#2563eb;color:#fff;} .ghost{background:#334155;color:#fff;}
      .diagnostics[hidden]{display:none}.diagnostics{margin-top:10px;padding-top:10px;border-top:1px solid #334155;}
      .diagnostics-summary{display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;color:#dbeafe;}
      .diagnostics-reasons{margin-top:8px;display:grid;grid-template-columns:1fr auto;gap:1px 8px;color:#cbd5e1;}
      .diagnostics-actions{margin-top:8px}.diagnostics-copy-status{color:#86efac;margin-left:4px;}
      .diagnostics-preview{margin:8px 0 0;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-all;
        background:#020617;color:#cbd5e1;border-radius:7px;padding:7px;font:10px/1.35 ui-monospace,monospace;}
      button:disabled{opacity:.5;cursor:not-allowed;}`;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = `
      <div class="drag-handle">
        <h4>OfferFlow 批量选卡采集</h4>
        <button class="diagnostics-toggle" type="button" aria-expanded="false">诊断</button>
        <button class="collapse" type="button" aria-label="折叠批量浮层" aria-expanded="true">−</button>
      </div>
      <div class="body">
        <div>已选 <span class="count">0</span> / ${MAX_BATCH}（刷新或离开页面会丢弃未完成批次）</div>
        <div class="status"></div>
        <div>
          <button class="primary start" type="button">开始采集</button>
          <button class="ghost pause" type="button" disabled>暂停</button>
          <button class="ghost clear" type="button">清空</button>
          <button class="ghost cancel" type="button">取消</button>
        </div>
        <div class="diagnostics" hidden>
          <div class="diagnostics-summary"></div>
          <div class="diagnostics-reasons"></div>
          <div class="diagnostics-actions">
            <button class="ghost diagnostics-rescan" type="button">重新扫描</button>
            <button class="ghost diagnostics-copy" type="button">复制诊断 JSON</button>
            <span class="diagnostics-copy-status" role="status"></span>
          </div>
          <pre class="diagnostics-preview"></pre>
        </div>
      </div>`;
    this.shadow.append(style, bar);
    this.bar = bar;
    this.bodyEl = bar.querySelector('.body')!;
    this.countEl = bar.querySelector('.count')!;
    this.statusEl = bar.querySelector('.status')!;
    this.startBtn = bar.querySelector('.start')!;
    this.pauseBtn = bar.querySelector('.pause')!;
    this.diagnosticsPanel = bar.querySelector('.diagnostics')!;
    this.diagnosticsSummary = bar.querySelector('.diagnostics-summary')!;
    this.diagnosticsReasons = bar.querySelector('.diagnostics-reasons')!;
    this.diagnosticsPreview = bar.querySelector('.diagnostics-preview')!;
    this.diagnosticsCopyStatus = bar.querySelector('.diagnostics-copy-status')!;
    this.startBtn.addEventListener('click', () => void this.start());
    this.pauseBtn.addEventListener('click', () => this.togglePause());
    bar.querySelector('.clear')!.addEventListener('click', () => this.clear());
    bar.querySelector('.cancel')!.addEventListener('click', () => this.teardown());
    bar.querySelector('.collapse')!.addEventListener('click', () => this.toggleCollapsed());
    bar.querySelector('.diagnostics-toggle')!.addEventListener('click', () => this.toggleDiagnostics());
    bar.querySelector('.diagnostics-rescan')!.addEventListener('click', () => this.reconcile());
    bar.querySelector('.diagnostics-copy')!.addEventListener('click', () => void this.copyDiagnostics());
    this.enableDragging(bar.querySelector('.drag-handle')!);
  }

  private toggleDiagnostics(): void {
    this.diagnosticsOpen = !this.diagnosticsOpen;
    this.diagnosticsPanel.hidden = !this.diagnosticsOpen;
    const button = this.bar.querySelector<HTMLButtonElement>('.diagnostics-toggle')!;
    button.setAttribute('aria-expanded', String(this.diagnosticsOpen));
    this.renderDiagnostics();
    requestAnimationFrame(() => this.clampToViewport());
  }

  private diagnosticsJson(): string {
    if (this.latestDiagnostics === null) return '{}';
    const payload = {
      diagnosticsVersion: 1,
      ...this.latestDiagnostics,
      reconciliationHistory: this.diagnosticHistory,
    };
    let samples = [...payload.candidateSamples];
    let history = [...payload.reconciliationHistory];
    let json = '';
    do {
      json = JSON.stringify({ ...payload, candidateSamples: samples, reconciliationHistory: history }, null, 2);
      if (new TextEncoder().encode(json).byteLength <= 30 * 1024) return json;
      if (history.length > 1) history = history.slice(1);
      else if (samples.length > 0) samples = samples.slice(0, -1);
      else break;
    } while (true);
    return JSON.stringify({ diagnosticsVersion: 1, error: 'diagnostics_size_limit' });
  }

  private renderDiagnostics(): void {
    if (this.latestDiagnostics === null) return;
    const d = this.latestDiagnostics;
    const fields: Array<[string, string | number | boolean | null]> = [
      ['pageUrlPath', d.pageUrlPath], ['reconciliationRunCount', d.reconciliationRunCount],
      ['listContainerFound', d.listContainerFound], ['listContainerSelector', d.listContainerSelector],
      ['rawCandidateNodeCount', d.rawCandidateNodeCount], ['uniqueCandidateNodeCount', d.uniqueCandidateNodeCount],
      ['semanticRootCandidateCount', d.semanticRootCandidateCount], ['acceptedLogicalCardCount', d.acceptedLogicalCardCount],
      ['mountedHostCount', d.mountedHostCount], ['connectedHostCount', d.connectedHostCount],
      ['removedOrphanHostCount', d.removedOrphanHostCount], ['duplicateExternalRecordIdCount', d.duplicateExternalRecordIdCount],
      ['hiddenCloneCount', d.hiddenCloneCount], ['currentSelectionCount', d.currentSelectionCount],
    ];
    this.diagnosticsSummary.replaceChildren(...fields.flatMap(([name, value]) => {
      const label = document.createElement('span'); label.textContent = name;
      const output = document.createElement('strong'); output.textContent = String(value);
      return [label, output];
    }));
    this.diagnosticsReasons.replaceChildren(...CARD_SKIP_REASONS.flatMap((reason) => {
      const label = document.createElement('span'); label.textContent = reason;
      const output = document.createElement('strong'); output.textContent = String(d.reasonCounts[reason]);
      return [label, output];
    }));
    this.diagnosticsPreview.textContent = this.diagnosticsJson();
  }

  private async copyDiagnostics(): Promise<void> {
    const json = this.diagnosticsJson();
    try {
      await navigator.clipboard.writeText(json);
      this.diagnosticsCopyStatus.textContent = '已复制';
      this.host.setAttribute('data-offerflow-diagnostics-copy-status', 'success');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = json;
      textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      this.diagnosticsCopyStatus.textContent = copied ? '已复制' : '复制失败';
      this.host.setAttribute('data-offerflow-diagnostics-copy-status', copied ? 'success' : 'failed');
    }
  }

  private enableDragging(handle: HTMLElement): void {
    let dragging = false;
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    handle.addEventListener('pointerdown', (event) => {
      if ((event.target as Element | null)?.closest('button') !== null) return;
      const rect = this.bar.getBoundingClientRect();
      dragging = true;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      handle.setPointerCapture(pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      this.placeWithinViewport(startLeft + event.clientX - startX, startTop + event.clientY - startY);
    });
    const stopDragging = (event: PointerEvent): void => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      this.clampToViewport();
    };
    handle.addEventListener('pointerup', stopDragging);
    handle.addEventListener('pointercancel', stopDragging);
  }

  private placeWithinViewport(left: number, top: number): void {
    const rect = this.bar.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    this.bar.style.right = 'auto';
    this.bar.style.left = `${Math.min(Math.max(margin, left), maxLeft)}px`;
    this.bar.style.top = `${Math.min(Math.max(margin, top), maxTop)}px`;
  }

  private clampToViewport(): void {
    if (!this.bar.isConnected) return;
    const rect = this.bar.getBoundingClientRect();
    this.placeWithinViewport(rect.left, rect.top);
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.bodyEl.hidden = this.collapsed;
    this.host.setAttribute('data-offerflow-collapsed', String(this.collapsed));
    const button = this.bar.querySelector<HTMLButtonElement>('.collapse')!;
    button.textContent = this.collapsed ? '+' : '−';
    button.setAttribute('aria-expanded', String(!this.collapsed));
    button.setAttribute('aria-label', this.collapsed ? '展开批量浮层' : '折叠批量浮层');
    requestAnimationFrame(() => this.clampToViewport());
  }

  private startObserver(): void {
    this.observer = new MutationObserver(() => {
      if (this.queue !== null || this.cancelled) return;
      if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
      this.reconcileTimer = setTimeout(() => {
        this.reconcileTimer = null;
        this.reconcile();
      }, 120);
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  private stopObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  private removeMount(jobId: string): void {
    const mount = this.mounts.get(jobId);
    if (mount === undefined) return;
    mount.host.remove();
    if (mount.root.style.position === 'relative' && mount.restoredPosition === '') {
      mount.root.style.position = '';
    } else {
      mount.root.style.position = mount.restoredPosition;
    }
    this.mounts.delete(jobId);
  }

  private createMount(card: ScannedCard): void {
    const jobId = card.selected.externalRecordId;
    const root = card.root as HTMLElement;
    const host = document.createElement('span');
    host.setAttribute('data-offerflow-checkbox-host', jobId);
    host.style.cssText = 'position:absolute;display:block;left:8px;top:8px;z-index:2147483646;width:22px;height:22px;overflow:visible;pointer-events:auto;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('data-offerflow-pick', jobId);
    input.setAttribute('aria-label', `选择岗位 ${card.selected.roleFromCard ?? jobId}`);
    input.style.cssText = 'display:block;margin:0;width:20px;height:20px;accent-color:#2563eb;cursor:pointer;pointer-events:auto;';
    const stopPropagation = (event: Event): void => event.stopPropagation();
    input.addEventListener('pointerdown', stopPropagation, true);
    input.addEventListener('mousedown', stopPropagation, true);
    input.addEventListener('click', stopPropagation);
    input.addEventListener('change', () => this.toggle(root, input.checked, input));
    host.appendChild(input);
    const restoredPosition = root.style.position;
    if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
    root.insertBefore(host, root.firstChild);
    this.mounts.set(jobId, { root, host, input, restoredPosition });
  }

  private reconcile(): void {
    let removedOrphanHostCount = 0;
    for (const host of Array.from(document.querySelectorAll<HTMLElement>('[data-offerflow-checkbox-host]'))) {
      const jobId = host.getAttribute('data-offerflow-checkbox-host');
      if (jobId === null || this.mounts.get(jobId)?.host !== host) {
        host.remove();
        removedOrphanHostCount += 1;
      }
    }
    const scan = scanCards();
    this.reconcileCount += 1;
    const nextIds = new Set(scan.cards.map((card) => card.selected.externalRecordId));
    for (const jobId of [...this.mounts.keys()]) {
      if (!nextIds.has(jobId)) {
        this.removeMount(jobId);
        scan.reasonCounts.host_removed_after_mount += 1;
      }
    }
    for (const card of scan.cards) {
      const jobId = card.selected.externalRecordId;
      const current = this.mounts.get(jobId);
      if (current !== undefined && current.root !== card.root) {
        this.removeMount(jobId);
        scan.reasonCounts.host_removed_after_mount += 1;
      }
      const record = card.diagnostics[0];
      if (!this.mounts.has(jobId)) {
        record.sample.hostMountAttempted = true;
        try {
          this.createMount(card);
        } catch {
          scan.reasonCounts.host_mount_failed += 1;
          record.sample.accepted = false;
          record.sample.rejectionReason = 'host_mount_failed';
        }
      }
      const mount = this.mounts.get(jobId);
      record.sample.hostMountSucceeded = mount !== undefined;
      record.sample.hostConnectedAfterReconcile = mount?.host.isConnected ?? false;
      const selectedIndex = this.selection.findIndex((item) => item.externalRecordId === jobId);
      if (selectedIndex >= 0) this.selection[selectedIndex] = card.selected;
    }
    this.syncSelectionUi();
    const hostVisualStates = [...this.mounts.values()].slice(0, 12).map((mount, hostIndex) => {
      const style = getComputedStyle(mount.host);
      return {
        hostIndex,
        connected: mount.host.isConnected,
        rect: diagnosticRect(mount.host) ?? { left: 0, top: 0, width: 0, height: 0 },
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex,
        overflowClipping: getComputedStyle(mount.root).overflow,
        disabled: mount.input.disabled,
        checked: mount.input.checked,
      };
    });
    const diagnostics: ReconciliationDiagnostics = {
      pageUrlPath: window.location.pathname,
      reconciliationRunCount: this.reconcileCount,
      listContainerFound: scan.listContainerFound,
      listContainerSelector: scan.listContainerSelector,
      rawCandidateNodeCount: scan.rawCandidateNodeCount,
      uniqueCandidateNodeCount: scan.uniqueCandidateNodeCount,
      semanticRootCandidateCount: scan.semanticRootCandidateCount,
      acceptedLogicalCardCount: scan.acceptedLogicalCardCount,
      mountedHostCount: this.mounts.size,
      connectedHostCount: [...this.mounts.values()].filter((mount) => mount.host.isConnected).length,
      removedOrphanHostCount,
      duplicateExternalRecordIdCount: scan.duplicateExternalRecordIdCount,
      hiddenCloneCount: scan.hiddenCloneCount,
      currentSelectionCount: this.selection.length,
      visibleHostCount: hostVisualStates.filter((host) => host.connected && host.rect.width > 0 && host.rect.height > 0
        && host.display !== 'none' && host.visibility !== 'hidden' && host.opacity !== '0').length,
      hostVisualStates,
      fieldProbe: {
        selectedCard: fieldProbe(
          scan.cards.find((card) => this.selection.some((selected) => selected.externalRecordId === card.selected.externalRecordId))?.root
            ?? scan.cards.find((card) => {
              const rect = card.root.getBoundingClientRect();
              return rect.bottom > 0 && rect.top < window.innerHeight;
            })?.root
            ?? null,
        ),
        rightPanel: fieldProbe(rightPanelContainer()),
      },
      reasonCounts: scan.reasonCounts,
      skipped: CARD_SKIP_REASONS.map((reason) => ({ reason, count: scan.reasonCounts[reason] })),
      candidateSamples: scan.records.slice(0, 12).map((record) => record.sample),
      semanticRootRequirements: {
        jobDetailHref: true,
        role: true,
        company: false,
        salaryOrCompanyOrTags: true,
        acceptanceRequiresCompany: false,
        note: '真实 DOM 证据确认 company 位于 job-info 外层或当前不可读；选择身份只要求稳定 job_detail id + role。salary/company/experience/education 仅用于 semantic root 信号，salary 与 company 均不是 host 挂载硬条件。',
      },
    };
    this.latestDiagnostics = diagnostics;
    this.diagnosticHistory.push({
      reconciliationRunCount: diagnostics.reconciliationRunCount,
      rawCandidateNodeCount: diagnostics.rawCandidateNodeCount,
      acceptedLogicalCardCount: diagnostics.acceptedLogicalCardCount,
      mountedHostCount: diagnostics.mountedHostCount,
      connectedHostCount: diagnostics.connectedHostCount,
      removedOrphanHostCount: diagnostics.removedOrphanHostCount,
    });
    if (this.diagnosticHistory.length > 12) this.diagnosticHistory.shift();
    const json = this.diagnosticsJson();
    this.host.setAttribute('data-offerflow-diagnostics', json);
    this.renderDiagnostics();
    if (this.mounts.size === 0) this.setStatus('未在当前页面发现可选岗位卡片。');
  }

  private syncSelectionUi(): void {
    const selectedIds = new Set(this.selection.map((item) => item.externalRecordId));
    for (const [jobId, mount] of this.mounts) mount.input.checked = selectedIds.has(jobId);
    this.countEl.textContent = String(this.selection.length);
    this.host.setAttribute('data-offerflow-selection-count', String(this.selection.length));
  }

  private toggle(card: Element, checked: boolean, box: HTMLInputElement): void {
    if (checked) {
      const selected = readSelectedCard(card);
      if (selected === null) { box.checked = false; this.setStatus('该卡片无稳定岗位链接，无法选择。'); return; }
      const change = addToSelection(this.selection, selected);
      if (!change.added) {
        box.checked = false;
        this.setStatus(change.reason === 'max_reached' ? `单批最多 ${MAX_BATCH} 条。` : '该岗位已选择。');
        return;
      }
      this.selection = change.next;
    } else {
      const jobId = box.getAttribute('data-offerflow-pick');
      if (jobId !== null) this.selection = removeFromSelection(this.selection, jobId);
    }
    this.syncSelectionUi();
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  private clear(): void {
    this.selection = [];
    this.syncSelectionUi();
    this.setStatus('已清空选择。');
  }

  private togglePause(): void {
    if (this.queue === null) return;
    if (this.queue.status === 'running') { this.queue.pause(); this.pauseBtn.textContent = '继续'; }
    else if (this.queue.status === 'paused') { this.queue.resume(); this.pauseBtn.textContent = '暂停'; }
  }

  private effects(): RunnerEffects {
    return {
      relocateCard,
      rightPanelMatchesExpected: (id) => rightPanelJobId() === id,
      clickCard: nativeClick,
      waitForRightPanelStable,
      captureItem: (expected) => captureKnownJobFromRightPanel(document, expected),
      onProgress: (_snapshot, summary) => {
        this.setStatus(`采集中 ${summary.capturedCount + summary.needsCorrectionCount + summary.failedCount} / ${summary.selectedCount}`);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  }

  private async start(): Promise<void> {
    const deduped = dedupeSelectedCards(this.selection);
    if (deduped.length === 0) { this.setStatus('请先勾选至少一个岗位。'); return; }
    this.stopObserver();
    this.startBtn.disabled = true;
    this.pauseBtn.disabled = false;
    // 剥离活 DOM 引用，队列只持稳定数据。
    const expectedList = deduped.map(toQueueExpected);
    const contextByOrder = new Map<number, BatchSubmitContext>();
    deduped.forEach((card, order) => contextByOrder.set(order, {
      providerKey: card.providerKey, canonicalSourceUrl: card.canonicalSourceUrl, pageTitle: document.title,
    }));

    this.queue = new BatchQueue(expectedList);
    const results = await runBatch(this.queue, this.effects(), { interItemMs: INTER_ITEM_MS });
    if (this.cancelled || this.queue.status === 'cancelled') { this.setStatus('已取消，未提交。'); return; }

    const items = buildBatchSubmitItems(results, (result) => contextByOrder.get(result.selectionOrder)!);
    this.setStatus('正在提交批量预览…');
    try {
      const message: BatchSubmitMessage = { type: BATCH_SUBMIT_MESSAGE, items };
      const response = await chrome.runtime.sendMessage<BatchSubmitResponse>(message);
      if (response.ok) {
        this.setStatus(`已提交 ${response.submittedCount ?? 0} 项，失败 ${response.failedToSubmitCount ?? 0} 项，请在打开的预览页确认。`);
      } else if (response.code === 'OFFERFLOW_NOT_RUNNING') {
        this.setStatus('OfferFlow 未启动：请先在本机启动 OfferFlow 后重试。');
      } else {
        this.setStatus(`提交失败：${response.error ?? '未知错误'}`);
      }
    } catch (error) {
      this.setStatus(`提交失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  teardown(): void {
    this.cancelled = true;
    this.queue?.cancel();
    this.stopObserver();
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    for (const jobId of [...this.mounts.keys()]) this.removeMount(jobId);
    this.host.remove();
    const holder = window as MountableWindow;
    holder[MOUNT_FLAG] = false;
  }
}

function mount(): void {
  const holder = window as MountableWindow;
  if (holder[MOUNT_FLAG] === true) return;
  if (!isListPage()) return;
  holder[MOUNT_FLAG] = true;
  // eslint-disable-next-line no-new
  new BatchOverlay();
}

mount();

export {};
