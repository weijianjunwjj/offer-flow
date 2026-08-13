/**
 * v0.9 Phase 4C-2 — HTML 有界提取（node-html-parser，纯解析，无 JS 执行）。
 *
 * 设计依据：Phase 4C-2 Implementation Scope Lock v3。
 *
 * 只做 bounded extraction：
 *   <title> → title
 *   <link rel="canonical"> → canonicalUrl
 *   可见正文 → plainText（剥离 script / style / noscript / template 后 whitespace 归一）
 *
 * 不做 readability / DOM ranking / article scoring / crawler framework /
 * site-specific selector / JS execution / anti-bot。
 *
 * raw HTML 只允许 transient 存在于内存，不进入 ExtractedContent / FetchResult / DB。
 */

import { parse } from 'node-html-parser';
import type { ExtractedContent } from './types';

const STRIP_TAGS = ['script', 'style', 'noscript', 'template'];

/**
 * 从解码后的 HTML 字符串提取最小字段集。
 * 解析异常会向上抛出（由调用方映射为 PARSE_FAILED）。
 */
export function extractContent(html: string, contentType: string | null): ExtractedContent {
  const trimmed = html.trim();
  if (trimmed === '') {
    return { title: '', plainText: '', canonicalUrl: null, contentType };
  }

  const root = parse(html);
  for (const tag of STRIP_TAGS) {
    for (const el of root.querySelectorAll(tag)) {
      el.remove();
    }
  }

  const titleEl = root.querySelector('title');
  const title = titleEl ? normalizeWhitespace(titleEl.text) : '';

  const canonicalEl = root.querySelector('link[rel="canonical"]');
  const canonicalUrl = canonicalEl ? normalizeCanonical(canonicalEl.getAttribute('href')) : null;

  // 可见正文只取 <body>（排除 <head>/<title> 元数据）；structuredText 保留块级换行，再归一为空格。
  const body = root.querySelector('body') ?? root;
  const plainText = normalizeWhitespace(body.structuredText);

  return { title, plainText, canonicalUrl, contentType };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeCanonical(href: string | undefined): string | null {
  if (href === undefined) return null;
  const value = href.trim();
  return value === '' ? null : value;
}
