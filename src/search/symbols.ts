/**
 * 符号定义识别 —— 纯函数模块，**零 import**（判据能脱离磁盘逐条打靶）。
 * 调用方：tools/builtin.ts 的 `symbols` 工具（遍历在 search/walk.ts，本模块只管"哪一行是定义"）
 *         + scripts/verify-symbols.ts。
 *
 * ── 它回答的是哪个问题（ROADMAP 10.7.1）──
 * `grep` 回答"这个词在哪儿出现过"（文本匹配，答案确定）；本模块回答"这个名字在哪儿**被定义**"
 * （形状匹配，答案是启发式的）。两者不是同一件事，所以它们是**两个工具**而不是一个开关 ——
 * 判据同 10.5.2（写侧拆成独立工具名）：当两件事的**失败语义相反**时，混在一个名字里就必然
 * 有一半的人被误导。grep 的"没找到"是**有效否定**（确实没出现过）；本模块的"没找到"
 * **不是**（写法没覆盖、名字在依赖里、大小写不同都长得一样）。这条差异贯穿全文件，
 * 最直接的体现是 `renderSymbolReport` 的 0 命中分支。
 *
 * ── 承重①：形状表是**跨语言的并集**，语言表只决定"哪些扩展名算代码" ──
 * 一开始的直觉是"每种语言一张表"（ts 一张、py 一张……），但那样要维护 8 组正则、
 * 8 份测试，而实际收益只有"少认几个写错的形状" —— 方向还正好反了（少认 = 更容易漏）。
 * 换成**一张并集表**之后：`def` 与 `fn` 与 `func` 与 `function` 各占一行，互不干扰；
 * 未识别的扩展名（点名一个 `.vue` / `.md`）也能用同一张表，因为表本来就不分语言。
 * `CODE_EXTS` 的职责因此收窄成一句话：**目录扫描时哪些文件值得读**。
 * （点名一个文件时连它也不看 —— 用户已经把路径说出来了，别替他藏，界线同 `gitignore.ts` ④。）
 *
 * ── 承重②：名字比对用**捕获组逐一相等**，不把名字拼进正则 ──
 * 于是名字里有 `.` `*` `(` 之类都不需要转义（`foo.bar` 就是**永远匹配不到**，回执里会明说），
 * 也不会出现"搜 foo 命中 foobar"这种子串噪音 —— 那是 grep 最典型的噪声来源，也是模型
 * 输一次 grep 之后往往还得再筛一遍的原因。区分大小写同理：符号名本来就区分大小写。
 *
 * ── 承重③：常量 / 变量只在**行首无缩进**时收 ──
 * `x = 1` 这种形状在函数体里遍地都是（`count = 0`、`err = null`）。收进来会把结果淹掉，
 * 而"被淹掉"的失败方式是**静默**的：模型看到 50 条命中里 49 条是局部变量，只会以为
 * 这个工具没用，不会知道真正的定义在第 50 条之后。所以缩进的那些**一律不收**，
 * 代价写在明处（Go 的 `const ( ... )` 块、Python 类里的属性赋值都搜不到）。
 *
 * ── 承重④：注释里的定义照样报，但**必须标出来** ──
 * 丢掉它是"少给"（模型据此以为没有定义，然后新建一个同名的）；当成真的报是"谎报"
 * （模型会去改一段早已废掉的代码）。两者都坏，所以第三条路：报，但带 `（注释）` 标记。
 * 代价是要真认注释 —— 行注释看行首标记，块注释（`/* … *&#47;`）要跨行跟踪状态，
 * 于是 `viewLine` 是一个**极小的注释扫描器**：它不解析字符串字面量（`"http://x"` 里的
 * `//` 会被当成注释起点），这会让那一行之后的内容被截掉，是本模块**已知的**一条边界。
 *
 * ── 刻意不做（判不出来，不是忘了做）──
 * · **带返回类型的方法 / 函数定义**（Java / C# / C / C++ 的 `int f(int a) {`）：形状与
 *   "调用语句"在纯文本层面区分不开（`int x = f(a);` 与 `int f(int a) {` 只差几个字符），
 *   要判它得有类型信息。回执里对模型明说，并给出替代（grep 搜 `NAME(`）。
 * · 解构赋值 / 装饰器生成的名字 / 宏展开产生的名字 / 匿名默认导出。
 * · 多行声明（`typedef struct\n{\n} Foo;` 这种跨行写法）。
 * · 不做索引、不做语言服务、不 import 任何解析器 —— "先做无索引版，不够用再上索引"。
 */

/* ═══════════════════════════════════════════════════════════════════════════════
   一、封闭枚举：种类
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 结果的种类标签 —— **封闭枚举，只此一处**（渲染、套件都从这里取，别处不再抄字面量）。
 * 值取"归一小集"而不是各语言的关键词：`fn` / `func` / `def` / `function` 都归 `function`，
 * 于是模型看到的是同一套词，不会因为搜的是 Rust 就换一套说法。
 */
export const SYMBOL_KINDS = [
  'function', 'class', 'interface', 'trait', 'struct', 'enum',
  'type', 'const', 'var', 'module', 'macro',
] as const;

export type SymbolKind = typeof SYMBOL_KINDS[number];

/* ═══════════════════════════════════════════════════════════════════════════════
   二、形状表
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface SymbolShape {
  kind: SymbolKind;
  /** 捕获组 1 必须是名字。匹配目标见 `topLevel` */
  re: RegExp;
  /**
   * true = 只在**行首无缩进**时算（匹配目标是一整行原文，`^` 直接管住列 0）。
   * false（缺省）= 去掉首尾空白后匹配（类方法的 `  foo() {` 也算定义）。
   */
  topLevel?: boolean;
}

/** 构造一条形状（写成一行，表才读得下去） */
const S = (kind: SymbolKind, re: RegExp, topLevel = false): SymbolShape => ({ kind, re, topLevel });

/**
 * 定义形状表 —— **有序**，先匹配先生效（`const enum Foo` 该报 enum 不该报 const，
 * 所以类族排在常量之前）。改这张表之前先读文件头的承重①③：加一条**宽**形状
 * （比如"任意缩进的赋值"）会把结果淹掉，那不是"更全"，是"更没用"。
 */
export const SYMBOL_SHAPES: readonly SymbolShape[] = [
  /* ── 类族 ── */
  S('class', /^(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|final\s+|abstract\s+|open\s+|sealed\s+|data\s+|static\s+)*class\s+([A-Za-z_$][\w$]*)/),
  S('interface', /^(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|abstract\s+|sealed\s+)*interface\s+([A-Za-z_$][\w$]*)/),
  S('trait', /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:sealed\s+)?trait\s+([A-Za-z_$][\w$]*)/),
  S('struct', /^(?:pub(?:\([^)]*\))?\s+)?(?:typedef\s+)?(?:struct|union)\s+([A-Za-z_$][\w$]*)/),
  S('enum', /^(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:public\s+|internal\s+)?enum\s+([A-Za-z_$][\w$]*)/),
  S('class', /^(?:export\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|data\s+|sealed\s+|abstract\s+)*record\s+([A-Za-z_$][\w$]*)/),
  S('class', /^(?:export\s+)?(?:public\s+|internal\s+|open\s+|data\s+|sealed\s+|abstract\s+)*object\s+([A-Za-z_$][\w$]*)/),
  S('module', /^(?:pub(?:\([^)]*\))?\s+)?(?:mod|module|namespace)\s+([A-Za-z_$][\w$]*)/),

  /* ── 函数族（`fn` / `func` / `def` / `fun` 都在这一条里）──
     可选接收者 `(s *S)` 是为 Go 的方法：`func (s *S) Start() error {` → 捕获 Start。 */
  S('function', /^(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|abstract\s+|open\s+|override\s+|unsafe\s+|inline\s+|extern\s+"[^"]*"\s+|extern\s+)*(?:function|func|fn|def|fun|sub)\s*\*?\s*(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/),

  /* 大括号写法：shell 的 `foo() {`、TS/JS 类方法与对象方法的 `foo() {` / `foo(): void {`。
     前缀那几个词先吃掉，否则 `async foo() {` 会把 `async` 当成名字。 */
  S('function', /^(?:async\s+|static\s+|get\s+|set\s+|public\s+|private\s+|protected\s+)*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*(?::[^{]*)?\{/),

  /* ── 类型别名 ──
     Go 的 `type Foo struct {` / `type Foo int` 与 TS 的 `type Foo = …` 都要认，
     所以尾部允许"`=` / `<`"或"一个类型词"两种形态。 */
  S('type', /^(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:declare\s+)?(?:typealias|type)\s+([A-Za-z_$][\w$]*)\s*(?:[=<]|\s+[A-Za-z_*[])/),
  S('type', /^typedef\s+[^;]*?\b([A-Za-z_$][\w$]*)\s*;/),

  /* ── 常量与变量：只在行首无缩进时收（见文件头承重③）── */
  S('const', /^(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)/, true),
  S('var', /^(?:export\s+)?(?:declare\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)/, true),
  S('const', /^(?:(?:private|public|internal|protected|const|lateinit)\s+)*val\s+([A-Za-z_$][\w$]*)/, true),
  S('const', /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_$][\w$]*)/, true),
  S('macro', /^#define\s+([A-Za-z_]\w*)/, true),
  S('const', /^\$\{?([A-Za-z_]\w*)\}?\s*=/, true),
  /* 裸赋值：Python 的模块级常量、脚本里的全局变量。
     `\s*[^=]` 那一段是承重的：`x == y` 的第二个 `=` 会被 `[^=]` 挡住，
     于是比较运算不会被误报成"定义"（否则每个 `if a == b` 都是一条命中）。 */
  S('const', /^([A-Za-z_]\w*)\s*(?::[^=]*)?=\s*[^=]/, true),
];

/* ═══════════════════════════════════════════════════════════════════════════════
   三、哪些文件算代码 + 注释风格
   ═══════════════════════════════════════════════════════════════════════════════ */

/** 注释风格：`slash` = `//` 与 `/* … *&#47;`；`hash` = `#` */
export type CommentStyle = 'slash' | 'hash';

/** 扩展名 → 注释风格。表里**没有**的扩展名 = 目录扫描时不算代码（点名的文件仍会读，见文件头承重①） */
export const CODE_EXTS: ReadonlyMap<string, CommentStyle> = new Map<string, CommentStyle>([
  ['.ts', 'slash'], ['.tsx', 'slash'], ['.js', 'slash'], ['.jsx', 'slash'],
  ['.mjs', 'slash'], ['.cjs', 'slash'], ['.go', 'slash'], ['.rs', 'slash'],
  ['.java', 'slash'], ['.kt', 'slash'], ['.kts', 'slash'], ['.scala', 'slash'],
  ['.c', 'slash'], ['.h', 'slash'], ['.cc', 'slash'], ['.cpp', 'slash'],
  ['.cxx', 'slash'], ['.hpp', 'slash'], ['.hh', 'slash'], ['.cs', 'slash'],
  ['.php', 'slash'], ['.swift', 'slash'], ['.m', 'slash'], ['.mm', 'slash'],
  ['.vue', 'slash'], ['.svelte', 'slash'],
  ['.py', 'hash'], ['.pyi', 'hash'], ['.rb', 'hash'],
  ['.sh', 'hash'], ['.bash', 'hash'], ['.zsh', 'hash'], ['.pl', 'hash'], ['.pm', 'hash'],
]);

/** 取扩展名（小写，含点）。没有扩展名的文件返回 '' */
export function extOf(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** 目录扫描时的代码文件判据（只看文件名） */
export function isCodeFile(fileName: string): boolean {
  return CODE_EXTS.has(extOf(fileName));
}

/** 注释风格；不认识的扩展名返回 null（调用方决定退回哪种风格） */
export function commentStyleOf(fileName: string): CommentStyle | null {
  return CODE_EXTS.get(extOf(fileName)) ?? null;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   四、注释扫描（只为了给注释里的定义打标记）
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface CommentState {
  /** 上一行留在未闭合的块注释里 */
  block: boolean;
}

export interface LineView {
  /** 参与形状匹配的文本（行首缩进**保留** —— 承重③ 的列 0 判据靠它） */
  text: string;
  /** 整行都在注释里 */
  inComment: boolean;
}

/** 一行完全落在注释里时，把注释标记剥掉（`//` / `#` / JSDoc 的 `*`），留下内容 */
function stripCommentMarkers(s: string): string {
  return s.replace(/^\s*(?:\/\/+|\*+|#+)\s?/, '');
}

/**
 * 把一行原文拆成"可匹配的文本 + 是否整行在注释里"。
 *
 * 块注释状态由调用方逐行传递（`st.block`），因为它跨行 —— 这是本模块**唯一**有状态的地方，
 * 也是它必须按行喂、不能整个文件一次正则的根本原因。
 *
 * ⚠ 不解析字符串字面量：`const u = "http://x"` 里的 `//` 会被认成注释起点，
 * 于是 `u` 之后的内容被截掉。这条边界写在文件头承重④，不打算修（修它要写词法分析器，
 * 而收益只是"极少数行里的定义可能漏"）。
 */
export function viewLine(raw: string, style: CommentStyle, st: CommentState): LineView {
  const indent = /^\s*/.exec(raw)?.[0] ?? '';

  if (style === 'hash') {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('#')) return { text: raw, inComment: false };
    return { text: indent + stripCommentMarkers(trimmed), inComment: true };
  }

  let code = '';
  let comment = '';
  let i = 0;
  for (;;) {
    if (st.block) {
      const end = raw.indexOf('*/', i);
      if (end === -1) { comment += raw.slice(i); break; }
      comment += raw.slice(i, end);
      i = end + 2;
      st.block = false;
      continue;
    }
    const lineC = raw.indexOf('//', i);
    const blockC = raw.indexOf('/*', i);
    if (lineC !== -1 && (blockC === -1 || lineC < blockC)) {
      code += raw.slice(i, lineC);
      comment += raw.slice(lineC);
      break;
    }
    if (blockC !== -1) {
      code += raw.slice(i, blockC);
      st.block = true;
      i = blockC + 2;
      continue;
    }
    code += raw.slice(i);
    break;
  }

  if (code.trim() !== '') return { text: code, inComment: false };
  return { text: indent + stripCommentMarkers(comment), inComment: true };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   五、扫描一个文件
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface SymbolHit {
  /** 1 起的行号（与 grep 同口径） */
  line: number;
  kind: SymbolKind;
  name: string;
  /** 这一行整个在注释里（可能是废弃代码或示例） */
  inComment: boolean;
  /** 该行的原文裁剪版，给模型看清上下文 */
  text: string;
}

/** 单行展示长度上限（超出只留前缀，尾部加省略号） */
export const SYMBOL_LINE_MAX = 120;

/** 一次调用最多回多少条命中（与 grep 的 50 同量级：防输出膨胀） */
export const SYMBOL_MAX_HITS = 50;

/** 命中正文的字符上限（与 grep 的 4000 同一口径） */
export const SYMBOL_BODY_MAX = 4000;

/** 按形状找名字的定义行。`fileName` 只用来定注释风格；`name` 按**原样精确**比对 */
export function scanSymbols(
  text: string,
  fileName: string,
  name: string,
  maxHits: number = SYMBOL_MAX_HITS,
): SymbolHit[] {
  const style = commentStyleOf(fileName) ?? 'slash';
  const st: CommentState = { block: false };
  const hits: SymbolHit[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= maxHits) break;
    const raw = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    const view = viewLine(raw, style, st);
    for (const shape of SYMBOL_SHAPES) {
      const m = shape.re.exec(shape.topLevel ? view.text : view.text.trim());
      if (m === null || m[1] !== name) continue;
      hits.push({
        line: i + 1,
        kind: shape.kind,
        name,
        inComment: view.inComment,
        text: clipLine(raw),
      });
      break;   // 一行只报一次（先匹配先生效，见形状表的顺序约定）
    }
  }
  return hits;
}

/** 单行裁剪：先去掉首尾空白（缩进对模型没有信息量），再按上限截断 */
export function clipLine(raw: string, max: number = SYMBOL_LINE_MAX): string {
  const trimmed = raw.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   六、渲染
   ═══════════════════════════════════════════════════════════════════════════════ */

/** 回执里那句"我不是编译器" —— 每个分支都要带上，它是这个工具的诚实底线 */
export const SYMBOL_DISCLAIMER = '按语法形状匹配，不是编译器 / 语言服务器 —— 结果可能不完整';

/** 一条带文件位置的命中（遍历器给的是绝对路径，与 grep 的回执同口径） */
export interface SymbolEntry {
  file: string;
  hit: SymbolHit;
}

export interface SymbolReportInput {
  name: string;
  /** 回执里印的路径（模型写的原文归一，与 grep 同口径） */
  pathLabel: string;
  hits: readonly SymbolEntry[];
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
function renderStats(r: SymbolReportInput): string {
  return [
    `已扫 ${r.scanned} 个文件`,
    r.singleFile ? '' : (r.filtered ? `跳过 ${r.filtered} 个非代码文件` : ''),
    r.skippedBinary ? `跳过 ${r.skippedBinary} 个二进制` : '',
    r.skippedBig ? `跳过 ${r.skippedBig} 个超大文件` : '',
    r.truncated ? `命中达上限 ${SYMBOL_MAX_HITS} 已停止` : '',
  ].filter(Boolean).join('，');
}

/**
 * 渲染回执正文（不含 `[OK]` 前缀 —— 那是 spec.ts 的构造器的事）。
 *
 * **0 命中这一支是本模块最要紧的几行**：它必须说清"我是启发式的"，
 * 因为 `grep` 的 0 命中是有效否定（`[NO_MATCH]`，agent-loop 归类为"答案就是没有"），
 * 而本模块的 0 命中**不能**给那个语义 —— 模型一旦读成"这个符号不存在"，
 * 它的下一步就是**新建一个同名的**，而这正是最贵的错误。所以它返回的是普通成功文本
 * （由 handler 包成 `[OK]`），并在正文里给出替代手段。
 */
export function renderSymbolReport(r: SymbolReportInput): string {
  const stats = renderStats(r);

  if (r.hits.length === 0) {
    return [
      `没有匹配到定义: ${r.name}（${stats}）`,
      `**这不等于"这个符号不存在"** —— 本工具${SYMBOL_DISCLAIMER}。`,
      '常见原因：',
      '  ① 写法不在识别范围内（带返回类型的方法 / C 函数定义 / 解构赋值 / 被缩进的局部变量）；',
      '  ② 定义在依赖包、生成代码或非代码文件里；',
      '  ③ 大小写或拼写与定义处不一致（本工具按**原样精确**比对，不做模糊匹配）。',
      `想确认它到底出现过没有，用 grep 搜 "${r.name}"（文本匹配的答案是确定的）。`,
    ].join('\n');
  }

  const lines = r.hits.map(renderEntry);
  const body = lines.join('\n');
  const shown = body.length > SYMBOL_BODY_MAX
    ? `${body.slice(0, SYMBOL_BODY_MAX)}\n...（结果截断：共 ${body.length} 字符）`
    : body;

  return [
    `找到 ${r.hits.length} 处定义: ${r.name}（${stats}）`,
    SYMBOL_DISCLAIMER,
    shown,
  ].join('\n');
}

/**
 * 一条命中的展示行：`路径:行号: 种类（注释）— 原文`。
 * 与 grep 的 `路径:行号:内容` 同形（同一个位置说法，两个工具不该有两种写法），
 * 行号与"已扫 N 个文件"的量纲也一致。渲染只有这一处，套件直接调它。
 */
export function renderEntry(e: SymbolEntry): string {
  const mark = e.hit.inComment ? '（注释）' : '';
  return `${e.file}:${e.hit.line}: ${e.hit.kind}${mark} — ${e.hit.text}`;
}
