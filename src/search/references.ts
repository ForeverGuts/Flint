/**
 * 引用查找 —— 纯函数模块，**零 import**（判据能脱离磁盘逐条打靶）。
 * 调用方：tools/builtin.ts 的 `refs` 工具（遍历在 search/walk.ts，本模块只管"这一行算不算引用"）
 *         + scripts/verify-references.ts。
 *
 * ── 它回答的是哪个问题（ROADMAP 10.7.2）──
 * `symbols` 回答"这个名字**在哪儿被定义**"，本模块回答"**谁在用它**"。两件事必须分开问，
 * 因为改代码前真正要知道的是后者：删一个函数之前得先知道还有谁在调，改一个签名之前得先知道
 * 要跟着改几处。此前唯一的办法是 `grep`，而 grep 在这件事上有三个改不掉的毛病：
 *   ① **子串噪音** —— 搜 `run` 会把 `runVerify` / `rerun` / `"running..."` 全带出来；
 *   ② **定义行混在里面** —— 想找"谁在调"，结果第一条是定义本身；
 *   ③ **注释与字符串不分** —— 一段废弃注释里的调用与真调用长得一样。
 * 三者都不是 grep 的错（它答的是"这段文本在哪"，答案确定），但它们让"谁在用它"这个问题
 * 每次都要人再筛一遍。本模块把那一遍筛进判据里。
 *
 * ── 与 symbols 的关系：**共用形状表，不共用工具名** ──
 * 判定"这一行是不是定义"这件事**只有一份实现**（`symbols.ts` 的 `SYMBOL_SHAPES`），本模块
 * import 它来把定义行**归成另一类**而不是丢掉（见承重②）。但两者是两个工具名，判据同 10.7.1：
 * 输出形状与用途不同（那边给"定义在哪"，这边给"谁在用 + 各是什么用法"），合成一个开关
 * 会让回执必须同时兼容两种读法。
 *
 * ── 承重①：名字比对是**全词**，靠边界字符判定、不把名字拼进正则 ──
 * 与 symbols 的"捕获组全等"同一条精神：名字里有 `.` `$` `(` 都不需要转义。
 * 这里做法是**先 indexOf 找出现位置，再看两侧字符是不是标识符字符**：
 * 左右都不是 `[A-Za-z0-9_$]` 才算一次引用。于是 `runVerify` 里的 `run` 不算、
 * `rerun` 里的 `run` 不算，而 `run(` / `.run` / `run,` / `[run]` 都算。
 * 这是本模块存在的首要理由 —— 少掉的正是 grep 最大的那堆噪音。
 *
 * ── 承重②：定义行**归类，不丢弃** ──
 * 直觉是"找引用当然要排除定义"，但直接丢掉会制造一个静默错误：模型问"还有谁在用 foo"，
 * 得到"0 处"，于是以为可以删 —— 而它可能压根就只有定义、也可能定义那一行同时是引用
 * （`export const handler = makeHandler(handler)` 这种）。所以定义行**照样报**，只是
 * 标 `kind: 'definition'` 并**单独计数**，正文里分开印。判据与 symbols 承重④（注释里的定义
 * 照样报但标出来）是同一条：**"归类"比"丢弃"诚实，因为丢弃的失败方式是静默的。**
 *
 * ── 承重③：注释与字符串**降级不排除** ──
 * 注释里的引用是"可能已废弃的线索"，字符串里的是"可能是动态调用 / 文档 / 日志"。两类都不该
 * 与真代码引用并列（会淹掉真答案），但也不该丢（`app.get("run")` 这种字符串里的名字在动态
 * 派发的代码里就是真引用）。所以它们进结果、标记 `（注释）`/`（字符串）`、排在代码引用之后。
 * ⚠ 字符串判定是**行内启发式**：数这一行里名字之前有几个未配对的引号。跨行模板字符串
 * （`` ` `` 开头、下一行才闭合）判不出来 —— 已知边界，写在这儿不装看不见。
 *
 * ── 承重④：`import` / `require` 行单列一类 ──
 * "谁 import 了它"与"谁调用了它"是两个问题：前者答"改这个文件会波及哪几个文件"（这正是
 * 10.7.5 变更影响面要的输入），后者答"要改几处调用点"。混在一起时，一个被 20 个文件 import
 * 的模块会让真正的调用点沉到第 20 条之后。
 *
 * ── 刻意不做（判不出来，不是忘了做）──
 * · **区分"调用"与"传引用"**（`f()` vs `onClick={f}`）：要类型信息。只按"后面紧跟 `(`"给一个
 *   `call` 的弱标记，不声称准确。
 * · **跟踪别名与重导出**（`import { a as b }` 之后搜 `a` 找不到 `b` 的使用点）—— 要跨文件符号表。
 * · **区分同名不同物**（两个类里各有一个 `reset`）—— 要作用域分析。这是本工具最大的一条不准，
 *   回执里对模型明说：同名越常见，结果越需要自己再看一眼。
 * · 不做索引、不 import 任何解析器 —— 同 10.7.1"先做无索引版"。
 */
import {
  SYMBOL_SHAPES,
  clipLine,
  commentStyleOf,
  viewLine,
  type CommentState,
} from './symbols.js';

/* ═══════════════════════════════════════════════════════════════════════════════
   一、封闭枚举：引用的类别
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 一处引用的类别 —— **封闭枚举，只此一处**（渲染与套件都从这里取）。
 * 顺序就是**可信度降序**，也是回执里的分组顺序：真代码里的调用最值钱，
 * 注释与字符串垫底（它们是线索不是事实）。
 */
export const REFERENCE_KINDS = ['call', 'usage', 'import', 'definition', 'comment', 'string'] as const;

export type ReferenceKind = typeof REFERENCE_KINDS[number];

/** 给模型看的中文标签（`call` / `usage` 不加标记 —— 它们是默认情形，标了反而占地方） */
export const REFERENCE_LABELS: Readonly<Record<ReferenceKind, string>> = {
  call: '调用',
  usage: '使用',
  import: '导入',
  definition: '定义',
  comment: '注释',
  string: '字符串',
};

/* ═══════════════════════════════════════════════════════════════════════════════
   二、全词匹配（承重①）
   ═══════════════════════════════════════════════════════════════════════════════ */

/** 标识符字符：名字两侧出现这些字符时，那次出现只是更长名字的一部分 */
function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * 在一行里找出 `name` 的**全词**出现位置（0 起的列号，可能多处）。
 *
 * 不把名字拼进正则（那要转义，且 `foo.bar` 会变成"任意字符"通配）：
 * 用 `indexOf` 逐个找，再看两侧字符。左右任一侧是标识符字符 → 这次出现是
 * `runVerify` / `rerun` 那种更长名字的一部分，不算。
 */
export function findWordPositions(line: string, name: string): number[] {
  if (name === '') return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = line.indexOf(name, from);
    if (at === -1) break;
    const before = at === 0 ? '' : line[at - 1];
    const after = line[at + name.length] ?? '';
    if (!isIdentChar(before) && !isIdentChar(after)) out.push(at);
    from = at + name.length;   // 名字本身不重叠搜（`aa` 在 `aaa` 里只算一次）
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   三、类别判定
   ═══════════════════════════════════════════════════════════════════════════════ */

/** import / require / include 这一族（承重④）。只看行首，避免把 `// 见 import 那段` 算进来 */
export function isImportLine(code: string): boolean {
  const s = code.trim();
  return /^(?:import\b|export\b[^=]*\bfrom\b|from\s+\S+\s+import\b|const\s+.*\brequire\s*\(|let\s+.*\brequire\s*\(|var\s+.*\brequire\s*\(|require\s*\(|#include\b|use\s+[A-Za-z_:{])/.test(s)
    || /^(?:import|from)\s/.test(s);
}

/**
 * 这一行是不是 `name` 的**定义**（承重②：归类用，不是排除用）。
 * 判据直接复用 `symbols.ts` 的形状表 —— 判定"什么是定义"这件事全仓只有一份实现。
 */
export function isDefinitionLine(code: string, name: string): boolean {
  for (const shape of SYMBOL_SHAPES) {
    const m = shape.re.exec(shape.topLevel ? code : code.trim());
    if (m !== null && m[1] === name) return true;
  }
  return false;
}

/**
 * 名字**这一次出现**是不是落在字符串字面量里（承重③）。
 *
 * 行内启发式：数名字之前有几个引号。奇数 = 在引号里面。三种引号各自单独数，
 * 于是 `"it's fine", run` 里的 `'` 不会把后面的判歪（单引号在双引号内被
 * 数成 1 个 → 若只看单引号会误判，所以三种**分别**数、任一为奇即算在串内）。
 * 转义引号 `\"` 不计入。
 *
 * ⚠ 跨行模板字符串判不出来（本函数只看一行）—— 已知边界，见文件头承重③。
 */
export function isInsideString(code: string, at: number): boolean {
  const head = code.slice(0, at);
  for (const q of ['"', "'", '`']) {
    let n = 0;
    for (let i = 0; i < head.length; i++) {
      if (head[i] !== q) continue;
      if (i > 0 && head[i - 1] === '\\') continue;   // 转义的引号不算开合
      n++;
    }
    if (n % 2 === 1) return true;
  }
  return false;
}

/** 后面紧跟 `(` → 弱标记为调用（空格也算：`run (x)`）。见文件头"刻意不做"第一条 */
export function looksLikeCall(code: string, at: number, name: string): boolean {
  return /^\s*\(/.test(code.slice(at + name.length));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   四、扫描一个文件
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface ReferenceHit {
  /** 1 起的行号（与 grep / symbols 同口径） */
  line: number;
  kind: ReferenceKind;
  /** 该行原文的裁剪版 */
  text: string;
}

/** 一次调用最多回多少条（与 grep / symbols 的 50 同量级） */
export const REFERENCE_MAX_HITS = 50;

/** 命中正文的字符上限（与 grep / symbols 的 4000 同一口径） */
export const REFERENCE_BODY_MAX = 4000;

/**
 * 在一份文件文本里找 `name` 的引用。`fileName` 只用来定注释风格。
 *
 * **一行只报一条**：同一行里出现两次（`run(run())`）是同一处代码，报两遍只是噪音。
 * 类别取这一行里**可信度最高**的那一次出现（`REFERENCE_KINDS` 的顺序即优先级），
 * 于是 `const x = run("run")` 报 `call` 而不是 `string`。
 */
export function scanReferences(
  text: string,
  fileName: string,
  name: string,
  maxHits: number = REFERENCE_MAX_HITS,
): ReferenceHit[] {
  const style = commentStyleOf(fileName) ?? 'slash';
  const st: CommentState = { block: false };
  const hits: ReferenceHit[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= maxHits) break;
    const raw = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    // viewLine 必须每行都调（块注释状态跨行传递），不能因为这行不含名字就跳过
    const view = viewLine(raw, style, st);

    const kind = classifyLine(view.text, view.inComment, name);
    if (kind === null) continue;
    hits.push({ line: i + 1, kind, text: clipLine(raw) });
  }
  return hits;
}

/**
 * 判一行的类别；这一行没有全词出现时返回 null。
 * 单独导出是为了让套件能脱离文件逐行打靶（本模块最密的判据都在这里）。
 */
export function classifyLine(code: string, inComment: boolean, name: string): ReferenceKind | null {
  const positions = findWordPositions(code, name);
  if (positions.length === 0) return null;

  // 整行在注释里 → 一律 comment（注释里的 import / 定义都只是线索，不该冒充事实）
  if (inComment) return 'comment';

  if (isImportLine(code)) return 'import';
  if (isDefinitionLine(code, name)) return 'definition';

  // 取这一行里可信度最高的那次出现：全在串里才算 string
  let best: ReferenceKind = 'string';
  for (const at of positions) {
    if (isInsideString(code, at)) continue;
    const k: ReferenceKind = looksLikeCall(code, at, name) ? 'call' : 'usage';
    if (k === 'call') return 'call';   // call 已是最高，不必再看
    best = k;
  }
  return best;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   五、渲染
   ═══════════════════════════════════════════════════════════════════════════════ */

/** 回执里那句"我不是编译器" —— 每个分支都要带，同 symbols 的诚实底线 */
export const REFERENCE_DISCLAIMER = '按文本全词匹配，不做作用域分析 —— 同名不同物会一并列出';

/** 一条带文件位置的命中 */
export interface ReferenceEntry {
  file: string;
  hit: ReferenceHit;
}

export interface ReferenceReportInput {
  name: string;
  /** 回执里印的路径（模型写的原文归一，与 grep / symbols 同口径） */
  pathLabel: string;
  hits: readonly ReferenceEntry[];
  scanned: number;
  filtered: number;
  skippedBinary: number;
  skippedBig: number;
  /** 命中撞了上限，后面还有 */
  truncated: boolean;
  /** 这次点名的是一个**文件**（那时不说"跳过 N 个非代码文件"，因为过滤器没生效） */
  singleFile: boolean;
}

/** 统计尾巴：模型靠它区分"扫了 300 个文件确实没有"与"过滤器把文件都排除了" */
function renderStats(r: ReferenceReportInput): string {
  return [
    `已扫 ${r.scanned} 个文件`,
    r.singleFile ? '' : (r.filtered ? `跳过 ${r.filtered} 个非代码文件` : ''),
    r.skippedBinary ? `跳过 ${r.skippedBinary} 个二进制` : '',
    r.skippedBig ? `跳过 ${r.skippedBig} 个超大文件` : '',
    r.truncated ? `命中达上限 ${REFERENCE_MAX_HITS} 已停止` : '',
  ].filter(Boolean).join('，');
}

/** 各类别各有几条：`调用 3 · 使用 5 · 导入 2` —— 模型一眼看出"要改几处"与"波及几个文件" */
export function renderBreakdown(hits: readonly ReferenceEntry[]): string {
  const parts: string[] = [];
  for (const kind of REFERENCE_KINDS) {
    const n = hits.filter((e) => e.hit.kind === kind).length;
    if (n > 0) parts.push(`${REFERENCE_LABELS[kind]} ${n}`);
  }
  return parts.join(' · ');
}

/**
 * 一条命中的展示行：`路径:行号: 类别 — 原文`（`call` / `usage` 不印类别）。
 * 与 grep 的 `路径:行号:内容`、symbols 的 `路径:行号: 种类 — 原文` 同形。
 */
export function renderEntry(e: ReferenceEntry): string {
  // `call` 是最常见的类别，不印标签保持紧凑；其余一律印出来 ——
  // 否则 `usage` 与 `call` 在输出里无从区分，而"这是调用还是只是提到"正是模型要判的
  const label = e.hit.kind === 'call' ? '' : `${REFERENCE_LABELS[e.hit.kind]} — `;
  return `${e.file}:${e.hit.line}: ${label}${e.hit.text}`;
}

/**
 * 渲染回执正文（不含 `[OK]` 前缀 —— 那是 spec.ts 构造器的事）。
 *
 * **0 命中这一支与 symbols 同一个理由**：本工具是启发式的，0 命中**不是**有效否定
 * （别名、重导出、动态派发、跨行模板串都会漏），所以走 `toolOk` 而不是 `NO_MATCH`，
 * 并在正文里给出替代手段。模型若把它读成"没人用了，可以删"，那是最贵的错误。
 *
 * 排序：按 `REFERENCE_KINDS` 分组（可信度降序），组内保持扫描顺序（文件名已排序，
 * 所以同组内是路径 → 行号递增，断言可复现）。
 */
export function renderReferenceReport(r: ReferenceReportInput): string {
  const stats = renderStats(r);

  if (r.hits.length === 0) {
    return [
      `没有匹配到引用: ${r.name}（${stats}）`,
      `**这不等于"没人在用它"** —— 本工具${REFERENCE_DISCLAIMER}。`,
      '常见原因：',
      '  ① 调用方用的是别名或重导出的名字（`import { a as b }` 之后搜 a 找不到 b 的使用点）；',
      '  ② 动态调用（`obj[key]()`、反射、字符串拼出来的名字）；',
      '  ③ 引用在依赖包、生成代码或非代码文件里；',
      '  ④ 大小写或拼写与定义处不一致（本工具按**原样精确**比对）。',
      `要确认它到底出现过没有，用 grep 搜 "${r.name}"（文本匹配的答案是确定的）；`,
      `要找它定义在哪，用 symbols 搜 "${r.name}"。`,
    ].join('\n');
  }

  // 按类别分组（组内保持扫描顺序）
  const ordered: ReferenceEntry[] = [];
  for (const kind of REFERENCE_KINDS) {
    for (const e of r.hits) if (e.hit.kind === kind) ordered.push(e);
  }

  const body = ordered.map(renderEntry).join('\n');
  const shown = body.length > REFERENCE_BODY_MAX
    ? `${body.slice(0, REFERENCE_BODY_MAX)}\n...（结果截断：共 ${body.length} 字符）`
    : body;

  return [
    `找到 ${r.hits.length} 处引用: ${r.name}（${stats}）`,
    `${renderBreakdown(r.hits)}｜${REFERENCE_DISCLAIMER}`,
    shown,
  ].join('\n');
}
