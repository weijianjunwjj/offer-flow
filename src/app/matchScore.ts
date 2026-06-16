// 匹配度归一化（纯函数）。
// 需求：匹配度必须是单值，不允许区间。
// 例：AI 返回 "70%-80%" → 取中位 → "75%"；单值 "85%" / "85" → "85%"。
// 解析不出数字时，原样保留用户输入（不丢内容）。

function formatNumber(value: number): string {
  // 中位/单值统一四舍五入为整数，避免出现 75.5% 这类不直观的数。
  return String(Math.round(value));
}

export function normalizeMatchScore(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return '';
  }
  const matches = trimmed.match(/\d+(?:\.\d+)?/g);
  if (matches === null || matches.length === 0) {
    // 没有数字（如用户写了文字描述）——原样保留，不强行改写。
    return trimmed;
  }
  const numbers = matches.map(Number);
  if (numbers.length === 1) {
    return `${formatNumber(numbers[0])}%`;
  }
  // 取前两个数字作为区间端点，输出中位值（顺序无关）。
  const mid = (numbers[0] + numbers[1]) / 2;
  return `${formatNumber(mid)}%`;
}

// 从外部 AI 结果原文中“尽力”提取综合匹配度（单字段、可失败、不阻断保存）。
// 优先匹配「综合匹配度」所在行，其次任意含「匹配度」且带数字的行；提取到的值同样归一化为单值。
// 提取不到返回 null（交给用户手填兜底）。
export function extractMatchScore(raw: string): string | null {
  if (raw.trim() === '') {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  const keywords = ['综合匹配度', '匹配度'];
  for (const keyword of keywords) {
    for (const line of lines) {
      const index = line.indexOf(keyword);
      if (index === -1) {
        continue;
      }
      const after = line.slice(index + keyword.length);
      if (!/\d/.test(after)) {
        // 关键词所在行没有数字（多为小标题，如「## 技术栈匹配度」），跳过。
        continue;
      }
      const normalized = normalizeMatchScore(after);
      if (/\d/.test(normalized)) {
        return normalized;
      }
    }
  }
  return null;
}
