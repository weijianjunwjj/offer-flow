/**
 * 可见文本提取工具（§七 反爬文本清洗）。纯读取，不修改页面 DOM。
 *
 * 背景：BOSS 列表页对正文注入了反爬干扰——
 *  - 随机类名的隐藏节点（display:none / visibility:hidden / font-size:0），文本里塞入 `kanzhun`、`BOSS直聘`；
 *  - 页内 <style> 规则文本（如 `.FrYhQzfSwwjF{font-size:0...}`）。
 * 旧实现用 element.textContent 取文本，会把 <style> 文本和隐藏干扰节点一起读进来。
 *
 * 本模块改为「按可见性递归收集文本节点」：跳过 style/script 等非内容标签与隐藏节点，
 * 顺序拼接可见文本节点（不插分隔符，从而把被隐藏节点拆断的词还原为完整词），
 * 再做有界的残留噪声清除。
 */

const NOISE_TAGS = new Set(['style', 'script', 'noscript', 'template', 'svg', 'canvas', 'iframe']);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function hasHiddenInlineStyle(style: string): boolean {
  const s = style.replace(/\s+/g, '').toLowerCase();
  if (/display:none/.test(s)) return true;
  if (/visibility:hidden/.test(s)) return true;
  if (/opacity:0(?![.\d])/.test(s)) return true;
  if (/font-size:0(?:px)?(?:!important)?(?:;|$)/.test(s)) return true;
  return false;
}

/** 计算样式探测所需的最小 window 结构（解耦具体 DOM/ happy-dom 的 Window 类型差异）。 */
interface StyleProbeStyle {
  display?: string | null;
  visibility?: string | null;
  opacity?: string | null;
  fontSize?: string | null;
}
export interface StyleProbeWindow {
  getComputedStyle(element: Element): StyleProbeStyle | null | undefined;
}

/**
 * 判断元素是否为隐藏干扰节点。先看内联 style（happy-dom 与浏览器都可靠），
 * 再尝试 getComputedStyle（真实 Chrome 中命中 BOSS 的类名隐藏规则；在活节点上有效，故不克隆）。
 */
export function isHiddenElement(el: Element, win: StyleProbeWindow | null | undefined): boolean {
  const inline = typeof el.getAttribute === 'function' ? el.getAttribute('style') ?? '' : '';
  if (inline.length > 0 && hasHiddenInlineStyle(inline)) return true;
  try {
    if (win !== null && win !== undefined && typeof win.getComputedStyle === 'function') {
      const cs = win.getComputedStyle(el);
      if (cs !== null && cs !== undefined) {
        if (cs.display === 'none') return true;
        if (cs.visibility === 'hidden') return true;
        if (cs.opacity === '0') return true;
        const fontSize = Number.parseFloat(cs.fontSize ?? '');
        if (!Number.isNaN(fontSize) && fontSize === 0) return true;
      }
    }
  } catch {
    // getComputedStyle 在部分环境不可用：忽略，回退到内联 style 判定。
  }
  return false;
}

/**
 * 有界残留噪声清除（仅用于已限定的目标容器文本，不对整页做无边界替换）：
 * - 去掉独立的 `kanzhun` 干扰标记；
 * - 去掉被插入到中文词语「中间」的 `BOSS直聘`（保留两侧带空白的正常 BOSS直聘 提及）。
 */
export function stripInlineNoise(text: string): string {
  return text
    .replace(/kanzhun/gi, '')
    .replace(/([一-龥])BOSS\s*直聘([一-龥])/g, '$1$2');
}

function collect(node: Node, win: StyleProbeWindow | null | undefined, out: string[]): void {
  if (node.nodeType === TEXT_NODE) {
    out.push(node.textContent ?? '');
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.tagName?.toLowerCase() ?? '';
  if (NOISE_TAGS.has(tag)) return;
  if (isHiddenElement(el, win)) return;
  for (const child of Array.from(el.childNodes)) collect(child, win, out);
}

const MAX_TEXT_LENGTH = 50_000;

/**
 * 从一个目标容器提取「可见文本」：跳过 style/script/隐藏干扰节点，顺序拼接可见文本节点，
 * 清除残留反爬噪声，折叠空白并做长度上限保护。绝不读取隐藏节点或样式规则文本。
 */
export function extractCleanText(root: Element | null | undefined): string {
  if (root === null || root === undefined) return '';
  const win = (root.ownerDocument?.defaultView ?? null) as unknown as StyleProbeWindow | null;
  const parts: string[] = [];
  collect(root, win, parts);
  const joined = stripInlineNoise(parts.join(''));
  return joined.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
}
