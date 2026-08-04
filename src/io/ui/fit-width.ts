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
/**
 * 计算文本可见宽度（剔除 ANSI 颜色码，CJK/全角计 2 列）。
 * 调用方：Screen（行宽告警）、TreeUI（输入行光标定位）
 * 服务于：把"显示宽度"与"光标列"对齐，避免中文/ANSI 导致光标错位
 */
export function visibleWidth(text: string): number {
  let w = 0;
  let inAnsi = false;
  for (const ch of text) {
    if (inAnsi) {
      if (ch === 'm') inAnsi = false;
      continue;
    }
    if (ch === '\x1b') {
      inAnsi = true;
      continue;
    }
    w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  }
  return w;
}

/**
 * 可见单元 —— 单个可见字符 + 其前紧邻的 ANSI 序列。
 * 折行按单元粒度操作，保证 ANSI 颜色码不被切碎、不计宽度。
 */
interface WrapUnit {
  /** 该字符前紧邻的完整 ANSI 序列（\x1b[...m） */
  ansi: string;
  /** 单个可见字符；ch 为空串表示残留的 ANSI 序列（行尾兜底） */
  ch: string;
  /** 可见宽度（CJK 计 2，ANSI 计 0） */
  w: number;
  /** 是否换行符（\n） */
  nl?: boolean;
}

/**
 * 行首禁排标点 —— 中文排版规范（GB/T 15834）：标点不置行首。
 * 折行时若断点后的字符在此集合内，会把上一行末尾字符移到下一行，
 * 让标点落在上一行行尾。
 */
const HEAD_FORBIDDEN = new Set([
  '，', '。', '、', '；', '：', '？', '！', '…', '—', '～',
  ')', '）', ']', '］', '}', '｝', '》', '〉', '」', '』', '”', '’',
]);

/** 把文本解析为可见单元序列（含 ANSI 前缀、换行标记） */
function tokenize(text: string): WrapUnit[] {
  const units: WrapUnit[] = [];
  let pendingAnsi = '';
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === '\x1b') {
      // 收集完整 ANSI 序列（到 'm' 为止），不计宽度
      let j = i + 1;
      while (j < text.length && text[j] !== 'm') j++;
      pendingAnsi += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '\n') {
      units.push({ ansi: pendingAnsi, ch: '\n', w: 0, nl: true });
      pendingAnsi = '';
      i++;
    } else {
      units.push({ ansi: pendingAnsi, ch, w: ch.charCodeAt(0) > 0xff ? 2 : 1 });
      pendingAnsi = '';
      i++;
    }
  }
  // 残留 ANSI（文本以颜色码结尾）：作为零宽单元并入
  if (pendingAnsi) units.push({ ansi: pendingAnsi, ch: '', w: 0 });
  return units;
}

/** 把一行单元拼回字符串（字符前接它的 ANSI 前缀） */
function joinUnits(units: WrapUnit[]): string {
  let out = '';
  for (const u of units) out += u.ansi + u.ch;
  return out;
}

/**
 * 按可见宽度折行文本（超宽不截断，换到下一行）。
 * 调用方：TreeUI（回复框/用户框内容折行）
 * 服务于：长回复按边框内宽折行，避免单行超宽 wrap 串行导致差分渲染错位
 *
 * 要点：
 *   - 按 \n 分段，每段再按可见宽度折行（CJK/全角计 2 列）
 *   - ANSI 颜色码不计宽度、完整保留
 *   - 中文标点禁排：断点后的字符若为行首禁排标点，
 *     把上一行末尾字符移到下一行，标点落回上一行行尾
 */
export function wrapText(text: string, maxWidth: number): string[] {
  const units = tokenize(text);
  const lines: string[] = [];
  let i = 0;

  while (i < units.length) {
    // ── 攒当前行：从 i 起尽可能装满（含残留 ANSI、遇 \n 断行） ──
    const cur: WrapUnit[] = [];
    let curW = 0;
    while (i < units.length) {
      const u = units[i];
      if (u.nl) { i++; break; }                          // 换行符 → 断行
      if (u.w === 0) { cur.push(u); i++; continue; }     // 残留 ANSI，零宽直接并入
      if (curW + u.w <= maxWidth) { cur.push(u); curW += u.w; i++; continue; }
      break;                                             // 放不下 u → 折行点
    }

    // 段尾（含以 \n 结束）→ 输出当前行
    if (i >= units.length || units[i].nl) {
      lines.push(joinUnits(cur));
      continue;
    }

    // ── 折行点：units[i] 是放不下的可见字符 u ──
    const u = units[i];
    if (HEAD_FORBIDDEN.has(u.ch)) {
      // 标点不能置行首：从上一行末尾 pop 可见字符，给标点腾位，
      // pop 出的字符移到下一行（位于标点之后，接续后文）
      const moved: WrapUnit[] = [];
      while (cur.length > 0 && curW + u.w > maxWidth) {
        const last = cur.pop()!;
        if (last.w > 0) curW -= last.w;
        moved.unshift(last);
      }
      cur.push(u); curW += u.w; i++;
      units.splice(i, 0, ...moved);
    }
    lines.push(joinUnits(cur));
  }

  // 文本以换行结尾时不留下空行（中间空行保留，作为段落分隔）
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

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
