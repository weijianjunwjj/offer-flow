/**
 * v0.9 Phase 4C-2 — Charset / Decoding 边界（纯函数，无网络）。
 *
 * 设计依据：Phase 4C-2 Implementation Scope Lock v3。
 *
 * 最小 decoding contract：
 *   bytes → (1) BOM 检测 → (2) Content-Type charset → (3) <meta> prescan → (4) UTF-8 默认。
 *
 * 使用 Node 内建 TextDecoder（全量 ICU，覆盖 WHATWG 编码表），fatal:true 确保
 * 无效字节序列抛出，禁止 silent mojibake。未知 label → UNSUPPORTED_CHARSET；
 * fatal 解码失败 → DECODE_FAILED。Evidence validator 只能接收本函数成功解码后的 plainText。
 */

import { TextDecoder } from 'node:util';

export type CharsetDecodeResult =
  | { kind: 'ok'; text: string }
  | { kind: 'unsupported_charset'; label: string }
  | { kind: 'decode_failed'; label: string };

/** <meta charset> prescan 上限（字节）。 */
const META_PRESCAN_MAX_BYTES = 1024;

/**
 * 将响应 bytes 解码为 string。
 * @param bytes             已按 Content-Encoding 解压后的原始 bytes。
 * @param contentTypeHeader 原始 Content-Type 响应头（含 charset 参数，可为空）。
 */
export function decodeContentText(
  bytes: Buffer,
  contentTypeHeader: string | null | undefined,
): CharsetDecodeResult {
  // 1. BOM 优先
  const bom = detectBom(bytes);
  if (bom) return decodeWith(bytes, bom.encoding, bom.offset);

  // 2. Content-Type charset
  const headerCharset = extractCharsetFromHeader(contentTypeHeader);
  if (headerCharset) return decodeWith(bytes, headerCharset, 0);

  // 3. <meta> prescan
  const metaCharset = prescanMetaCharset(bytes);
  if (metaCharset) return decodeWith(bytes, metaCharset, 0);

  // 4. UTF-8 默认
  return decodeWith(bytes, 'utf-8', 0);
}

function decodeWith(bytes: Buffer, label: string, offset: number): CharsetDecodeResult {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label, { fatal: true });
  } catch {
    return { kind: 'unsupported_charset', label };
  }
  try {
    const text = decoder.decode(bytes.subarray(offset));
    return { kind: 'ok', text };
  } catch {
    return { kind: 'decode_failed', label };
  }
}

function detectBom(bytes: Buffer): { encoding: string; offset: number } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', offset: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', offset: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', offset: 2 };
  }
  return null;
}

function extractCharsetFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /charset\s*=\s*["']?([a-zA-Z0-9._-]+)/i.exec(header);
  return match ? match[1].toLowerCase() : null;
}

function prescanMetaCharset(bytes: Buffer): string | null {
  const head = bytes.subarray(0, META_PRESCAN_MAX_BYTES);
  // latin1 逐字节映射，保证能读取 ASCII 的 meta 标签
  const asAscii = head.toString('latin1');
  const m1 = /<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9._-]+)/i.exec(asAscii);
  if (m1) return m1[1].toLowerCase();
  const m2 = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9._-]+)/i.exec(asAscii);
  if (m2) return m2[1].toLowerCase();
  return null;
}
