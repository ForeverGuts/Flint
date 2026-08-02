/**
 * 可见宽度工具 —— 按终端可见列宽截断文本。
 * 调用方：components.ts（Text/SelectList 渲染）、selector.ts
 * 服务于：保证每行不超过终端宽度，避免 wrap 导致行数错位
 *
 * 要点：
 *   - ANSI 颜色码（\x1b[36m 等）不计宽度，完整保留
 *   - 中文/全角字符按 2 列宽计算
 *   - 超宽截断丢弃剩余字符
 */
export function fitWidth(text: string, maxWidth: number): string {
  let out = '';
  let width = 0;
  let inAnsi = false;
  let ansiBuf = '';

  for (const ch of text) {
    if (inAnsi) {
      ansiBuf += ch;
      if (ch === 'm') {
        inAnsi = false;
        out += ansiBuf;
        ansiBuf = '';
      }
      continue;
    }
    if (ch === '\x1b') {
      inAnsi = true;
      ansiBuf = '\x1b';
      continue;
    }
    const w = ch.charCodeAt(0) > 0xff ? 2 : 1;
    if (width + w > maxWidth) break;
    out += ch;
    width += w;
  }
  if (inAnsi) out += ansiBuf;
  return out;
}
