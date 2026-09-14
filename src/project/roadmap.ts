/**
 * 项目路线图（`.flint/ROADMAP.md`）坐标表的**格式契约** —— ROADMAP P10.12 的格式侧。
 *
 * 调用方：`scripts/verify-roadmap.ts`（格式门禁）、`tools/builtin.ts` 的 archive 工具
 *   （归档时推进坐标状态，见本文件末节「文件级操作」）。
 * 服务于：把"路线图长什么样"从**自然语言约定**变成**可解析的格式**——模型写歪了
 *   （列名不对 / 状态不在枚举 / 编号重复 / 依赖指向不存在的编号），门禁当场点出来，
 *   而不是等人一页页去读。
 *
 * ── 为什么这一步只做"格式"，不做"状态机" ──
 * 格式是状态机的**输入契约**。契约没定死，状态机就是在解析一坨自由文本——那正是现在
 * "不稳定"的来源（四份文档都是模型随手 write/edit 的文本，写歪了没有任何东西会喊）。
 * 先把形状钉死（本文件），再谈谁能改、什么时候改（10.12.11：把真相源搬进内存，
 * 照抄 TaskStore 的 C 方案）。两件事分开做，是为了不让"定格式"被"设计状态机"拖住。
 *
 * ── 为什么枚举定义在代码里，而不是只写在提示词里 ──
 * 提示词与解析器若各存一份枚举，迟早分家（提示词说"进行中"、解析器只认 "doing"）——
 * 那时门禁会**永远红**，或者更糟的**永远绿**，等于没有门禁。故此处是唯一真相源，
 * 提示词里那几句由 `verify-roadmap.ts` 交叉比对（钉"两边说的是同一套字"）。
 *
 * ── 层次：编号即层次，不加嵌套语法（2026-09-14 拍板）──
 * 需求是"一个大任务里装着若干小任务"。做法**不是**给坐标表加父子列或缩进（Markdown
 * 表格本来就嵌不了表），而是让编号自带分段：`10.12` 是 `10` 的子，`10.12.5` 是 `10.12` 的子。
 * 于是表**永远是平表**（一行一个坐标），层次由编号的段数与前缀关系表达，程序能算出来。
 *
 * 三条随之而来的硬规矩：
 *   ① **父编号必须存在**（有 `1.2` 就必须有 `1`）——否则"谁是它的父"无处可解，
 *      层次只剩字面相似，那是幻觉不是结构（与"依赖必须指向存在的编号"同一条纪律）。
 *   ② **父级状态由程序派生，不手写**（`deriveStatuses` / `resolveStatuses`）。
 *      父的状态是子树的**函数**：手写它就等于同一件事存两份，两份迟早分家——这正是
 *      本项目"状态真相源只能有一处"那条纪律在路线图上的落地。
 *      父行在表里仍写一个状态，但它是**显示占位**；权威值是派生值（渲染前先 `resolveStatuses`）。
 *   ③ **坐标内部的多步不进路线图**——那是 `todo` 清单（TaskStore）的职责。
 *      路线图是项目级（跨会话）的坐标，todo 是单会话内的步骤；两层各有各的真相源。
 *
 * ── 三条已知边界 ──
 * ① 只认"第一个表头恰是五列、且紧随一条分隔行"的表格；文件里另有别的表格不影响。
 * ② 单元格里的 `|` 按 GitHub 表格语法写成 `\|`，解析时还原；换行会被压成空格。
 * ③ **环不拦格式，但要点名**——依赖成环属于"排序语义"（菱形能不能有、循环算不算合法），
 *    故 `parseRoadmap` **不因成环报错**（成环的表在格式上完全合法）；但环是**死锁**：
 *    环上的坐标永远等不到依赖完成，`nextCoord` 会静默返回 null，而 `remainingLeaves > 0`，
 *    读的人会误以为"活干完了"。故提供 `findCycles` 供归档回执**显式点名**
 *    （2026-09-14 拍板：**环检测做、优先级留给人**——环是正确性问题，能不能插队才是策略）。
 *    格式层仍只保证"依赖指向的编号真实存在、且不自引用"。
 *
 * 零运行时依赖：纯函数 + 字面量（连 node 内置都不需要）。
 */

/** 坐标状态 —— **封闭枚举**（提示词里那几个字必须与这里逐字一致） */
export const COORD_STATUSES = ['未开始', '进行中', '已完成', '搁置'] as const;
export type CoordStatus = (typeof COORD_STATUSES)[number];

/** 坐标类别 —— **封闭枚举**（`轻量` = 一个会话内能收尾；`系统` = 要立项走四阶段） */
export const COORD_CLASSES = ['轻量', '系统'] as const;
export type CoordClass = (typeof COORD_CLASSES)[number];

/** 坐标表的列 —— **顺序即契约**，多一列、少一列、换个名字都算写歪 */
export const COLUMNS = ['编号', '坐标', '状态', '类别', '依赖'] as const;

/** "无依赖"的占位。选破折号是为了人读；解析时与空单元格等价 */
export const NO_DEP = '—';

/** 编号的分段分隔符。用点而不是 `-`：分段与"编号 3"这类单段编号字面上不会混。 */
export const ID_SEP = '.';

export interface Coord {
  /**
   * 分段编号，如 `1` / `10.12` / `10.12.5`。**字符串而非数字** —— 分段路径没法用数字表示
   * （`10.12` 不是一个数）。每段都是正整数，表内唯一；前缀关系即父子关系。
   */
  id: string;
  /** 一句话说清"要做什么"；可含 `|`（渲染时转义） */
  title: string;
  /**
   * 叶子行：这就是本行的状态。
   * 父行：这是**显示占位**，权威值由 `deriveStatuses` 从子树派生（见文件头 ②）。
   */
  status: CoordStatus;
  klass: CoordClass;
  /** 依赖的编号（按分段数值升序、去重）；空数组 = 无依赖 */
  deps: string[];
}

export interface ParseResult {
  /** 成功解析出的坐标（**有 errors 时不要用**——那是不完整的），按表内出现顺序 */
  coords: Coord[];
  /** 人类可读、带行号（1 基，按整份 markdown 的行号算） */
  errors: string[];
}

/* ═══════════════════════════════════════════════════════════════════════════════
   编号：解析、比较、父子关系
   ═══════════════════════════════════════════════════════════════════════════════ */

/** 分段编号的合法形状：一段或多段正整数，点分隔。`1.` / `.1` / `1..2` / `a.b` 全不认 */
const ID_RE = /^\d+(?:\.\d+)*$/;

/**
 * 规范化一个编号：逐段转成十进制去前导零（`01.002` → `1.2`）。
 * 规范化是"往返恒等"的前提——写进去什么样、读出来必须一模一样，否则 `01.2` 与 `1.2`
 * 会被当成两个不同编号，重复检测形同虚设。非法形状返回 null（由调用方报错）。
 */
export function normalizeId(raw: string): string | null {
  const s = raw.trim();
  if (!ID_RE.test(s)) return null;
  const segs = s.split(ID_SEP).map((t) => Number(t));
  if (segs.some((n) => !Number.isSafeInteger(n) || n <= 0)) return null;
  return segs.map((n) => String(n)).join(ID_SEP);
}

/** 编号的段数组（`10.12.5` → `[10,12,5]`）。调用方保证 id 合法 */
export function idSegments(id: string): number[] {
  return id.split(ID_SEP).map((t) => Number(t));
}

/**
 * 编号排序：**逐段按数值比**，不是字典序。
 * 字典序会把 `1.10` 排在 `1.2` 前面（'1'<'2' 先比到了第 3 个字符），
 * 于是依赖列表的"升序"看着对、实际错。段数不同时短的在前（`1` 在 `1.2` 前）。
 */
export function compareId(a: string, b: string): number {
  const x = idSegments(a);
  const y = idSegments(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

/** 父编号；顶层（单段）返回 null */
export function parentOf(id: string): string | null {
  const i = id.lastIndexOf(ID_SEP);
  return i < 0 ? null : id.slice(0, i);
}

/** `a` 是 `b` 的**严格祖先**（`1` 是 `1.2` 的祖先，也是 `1.2.3` 的祖先；`1` 不是 `1` 的祖先） */
export function isAncestor(a: string, b: string): boolean {
  return a !== b && b.startsWith(`${a}${ID_SEP}`);
}

/** `id` 的直系子编号（存在性由调用方按表内容判断） */
export function childrenOf(id: string, coords: Coord[]): Coord[] {
  return coords.filter((c) => parentOf(c.id) === id);
}

/** `id` 在表内是否有子（有子 = 父行，状态走派生） */
export function isParent(id: string, coords: Coord[]): boolean {
  return coords.some((c) => parentOf(c.id) === id);
}

/** `id` 的所有后代（含孙辈及更深），按编号顺序 */
export function descendantsOf(id: string, coords: Coord[]): Coord[] {
  return coords
    .filter((c) => isAncestor(id, c.id))
    .sort((a, b) => compareId(a.id, b.id));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   状态派生：父级状态是子树的函数（唯一口径，不手写）
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 派生全表状态，返回 `id → 状态`。规则：
 *   ① 本行自身写了 `搁置` → 搁置（**显式冻结压过派生**：人主动叫停的事，不该被子孙的进度覆盖）
 *   ② 叶子行 → 就用它自己写的
 *   ③ 父行 → 看它的**后代叶子**：
 *        · 全搁置            → 搁置
 *        · 全 ∈ {已完成,搁置} → 已完成
 *        · 全 ∈ {未开始,搁置} → 未开始
 *        · 其余              → 进行中
 *   （父行自己没有后代叶子——比如只声明了父没声明任何子——退回它自己写的值）
 */
export function deriveStatuses(coords: Coord[]): Map<string, CoordStatus> {
  const out = new Map<string, CoordStatus>();
  for (const c of coords) {
    if (c.status === '搁置') {
      out.set(c.id, '搁置');
      continue;
    }
    const leaves = descendantsOf(c.id, coords).filter((d) => !isParentOfIn(d.id, coords));
    if (leaves.length === 0) {
      out.set(c.id, c.status);
      continue;
    }
    const all = (set: readonly CoordStatus[]): boolean => leaves.every((l) => set.includes(l.status));
    if (all(['搁置'])) out.set(c.id, '搁置');
    else if (all(['已完成', '搁置'])) out.set(c.id, '已完成');
    else if (all(['未开始', '搁置'])) out.set(c.id, '未开始');
    else out.set(c.id, '进行中');
  }
  return out;
}

/** 内部用：判断某编号在表内是否为父行（`isParent` 的纯查表版，避免到处传 coords 两次） */
function isParentOfIn(id: string, coords: Coord[]): boolean {
  return coords.some((c) => parentOf(c.id) === id);
}

/**
 * 把父行的状态换成**派生值**，返回新数组（不改入参）。
 * 渲染前先过这一道：`renderRoadmap(resolveStatuses(x))` 写出来的才是权威状态。
 * 对它幂等：`resolve(resolve(x))` 恒等于 `resolve(x)`。
 */
export function resolveStatuses(coords: Coord[]): Coord[] {
  const derived = deriveStatuses(coords);
  return coords.map((c) => {
    const s = derived.get(c.id);
    return s === undefined || s === c.status ? c : { ...c, status: s };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   解析 / 渲染
   ═══════════════════════════════════════════════════════════════════════════════ */

/** 依赖列表归一：去重 + 按分段数值升序。往返稳定性的前提（写 `3,1` 回来必须是 `[1,3]`） */
function normalizeDeps(ids: string[]): string[] {
  return [...new Set(ids)].sort(compareId);
}

/** 按 GitHub 表格规则切一行：`|` 分隔，`\|` 是字面竖线；首尾的 `|` 先剥掉 */
function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** 渲染时的反向转义：换行压成空格、字面竖线写成 `\|`（否则会把这一行切成多列） */
function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/** 表头判定：五列、逐字相等、顺序一致 */
function isHeaderRow(cells: string[]): boolean {
  return cells.length === COLUMNS.length && COLUMNS.every((c, i) => cells[i] === c);
}

/** 分隔行：只由 `-` 与可选的 `:` 组成（`---+` / `:--:` 都认） */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * 解析坐标表。**先看 errors**：非空即视为失败，`coords` 只是尽力而为的半成品。
 */
export function parseRoadmap(md: string): ParseResult {
  const errors: string[] = [];
  const coords: Coord[] = [];
  /** 编号 → 行号（1 基）。父子检查与依赖检查都要"指到那一行"，故单独留一份 */
  const lineOf = new Map<string, number>();
  /** 每个坐标的来源行号，位置与 coords 一一对应（用于事后报错定位） */
  const coordLine: number[] = [];
  const lines = md.split(/\r?\n/);

  // 找坐标表：表头行 + 紧随其后的分隔行
  let start = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes('|')) continue;
    if (!isHeaderRow(splitRow(lines[i]))) continue;
    if (!isSeparatorRow(splitRow(lines[i + 1]))) continue;
    start = i;
    break;
  }
  if (start < 0) {
    errors.push(`找不到坐标表：需要一张表头恰为 | ${COLUMNS.join(' | ')} | 的表格（列名与顺序都不能变）`);
    return { coords, errors };
  }

  for (let i = start + 2; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim().startsWith('|')) break; // 表格到此结束
    const cells = splitRow(raw);
    if (isSeparatorRow(cells)) continue; // 表中间多插一条分隔行：不算错
    const where = `第 ${i + 1} 行`;
    if (cells.length !== COLUMNS.length) {
      errors.push(`${where}：应是 ${COLUMNS.length} 列，实际 ${cells.length} 列`);
      continue;
    }

    const [idRaw, title, status, klass, depRaw] = cells;
    let bad = false;

    const id = normalizeId(idRaw);
    if (id === null) {
      errors.push(`${where}：编号「${idRaw}」不是分段编号（每段都是正整数，用 ${ID_SEP} 分隔，如 3 / 10.12 / 10.12.5）`);
      bad = true;
    }
    if (title === '') {
      errors.push(`${where}：坐标为空白`);
      bad = true;
    }
    if (!(COORD_STATUSES as readonly string[]).includes(status)) {
      errors.push(`${where}：状态「${status}」不在枚举内（只能取 ${COORD_STATUSES.join(' / ')}）`);
      bad = true;
    }
    if (!(COORD_CLASSES as readonly string[]).includes(klass)) {
      errors.push(`${where}：类别「${klass}」不在枚举内（只能取 ${COORD_CLASSES.join(' / ')}）`);
      bad = true;
    }

    const depIds: string[] = [];
    const depText = depRaw === NO_DEP ? '' : depRaw;
    if (depText !== '') {
      for (const token of depText.split(/[,，]/).map((t) => t.trim()).filter(Boolean)) {
        const depId = normalizeId(token);
        if (depId === null) {
          errors.push(`${where}：依赖「${token}」不是分段编号（无依赖写 ${NO_DEP}，多个用逗号分隔）`);
          bad = true;
          continue;
        }
        depIds.push(depId);
      }
    }

    if (bad || id === null) continue;
    coords.push({ id, title, status: status as CoordStatus, klass: klass as CoordClass, deps: normalizeDeps(depIds) });
    coordLine.push(i + 1);
    if (!lineOf.has(id)) lineOf.set(id, i + 1);
  }

  // 表内引用完整性：编号唯一（否则"依赖 3"指谁不确定）、依赖必须存在、不自引用
  const seen = new Set<string>();
  for (let k = 0; k < coords.length; k++) {
    const c = coords[k];
    const where = `第 ${coordLine[k]} 行`;
    if (seen.has(c.id)) errors.push(`${where}：编号 ${c.id} 重复（编号是坐标的唯一身份，重复则依赖与父子关系都无从解析）`);
    seen.add(c.id);
  }
  for (let k = 0; k < coords.length; k++) {
    const c = coords[k];
    const where = `第 ${coordLine[k]} 行`;
    if (c.deps.includes(c.id)) errors.push(`${where}：编号 ${c.id} 依赖了自己`);
    for (const d of c.deps) {
      if (!seen.has(d)) errors.push(`${where}：编号 ${c.id} 依赖 ${d}，但表里没有编号 ${d}`);
    }
    // 父编号必须存在：有 1.2 就必须有 1（否则层次只是字面相似，无从解析）
    const parent = parentOf(c.id);
    if (parent !== null && !seen.has(parent)) {
      errors.push(`${where}：编号 ${c.id} 声称属于 ${parent}，但表里没有编号 ${parent}（层次靠编号分段表达，父行必须先存在）`);
    }
  }

  return { coords, errors };
}

/**
 * 渲染成规范形态（表头 + 分隔行 + 数据行）。
 * 与 `parseRoadmap` 构成往返：`parse(render(x)).coords` 恒等于 x 的规范化形式。
 * 想写"权威状态"就先过 `resolveStatuses`（父行的占位状态会被换成派生值）。
 */
export function renderRoadmap(coords: Coord[]): string {
  const head = `| ${COLUMNS.join(' | ')} |`;
  const sep = `|${COLUMNS.map(() => '---').join('|')}|`;
  const rows = coords.map((c) => {
    const deps = normalizeDeps(c.deps);
    const depText = deps.length === 0 ? NO_DEP : deps.join(',');
    return `| ${c.id} | ${escapeCell(c.title.trim())} | ${c.status} | ${c.klass} | ${depText} |`;
  });
  return [head, sep, ...rows].join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   文件级操作：找到表、只换表、推进状态、提议下一坐标（10.12.11 复用）
   ═══════════════════════════════════════════════════════════════════════════════ */

/** 路线图落点 —— 与 CHARTER / PROJECT / DEVLOG 同住 cwd/.flint/ */
export const ROADMAP_FILE = '.flint/ROADMAP.md';

/** 坐标表在整份 markdown 里的行区间（**0 基、闭区间**：表头行 .. 最后一条数据行） */
export interface TableRange {
  start: number;
  end: number;
}

/**
 * 找坐标表所在的行区间。判定口径与 `parseRoadmap` **刻意完全一致**——都是"第一个表头恰为
 * 五列、且紧随一条分隔行的表格"；两边若分家，就会出现"按这个区间替换"与"解析出来的是那张表"
 * 对不上（改了一张表、动的是另一张）。找不到返回 null。
 */
export function findCoordTable(md: string): TableRange | null {
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes('|')) continue;
    if (!isHeaderRow(splitRow(lines[i]))) continue;
    if (!isSeparatorRow(splitRow(lines[i + 1]))) continue;
    start = i;
    break;
  }
  if (start < 0) return null;
  // 表尾 = 最后一条仍以 `|` 开头的行（与 parseRoadmap 的"遇到不以 | 开头就收工"同一口径）
  let end = start + 1;
  for (let i = start + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) break;
    end = i;
  }
  return { start, end };
}

/**
 * 把坐标表**原地换掉**：只动表那几行，表外的标题与散文一行不碰。
 * 找不到表 → **原样返回**（调用方据此判断"这个项目还没有路线图"，而不是凭空造一张出来）。
 * 想让文件里写的是**权威状态**，传入前先过 `resolveStatuses`。
 */
export function spliceCoordTable(md: string, coords: Coord[]): string {
  const range = findCoordTable(md);
  if (range === null) return md;
  const lines = md.split(/\r?\n/);
  const block = renderRoadmap(coords).split('\n');
  return [...lines.slice(0, range.start), ...block, ...lines.slice(range.end + 1)].join('\n');
}

/**
 * 改一个坐标的状态，返回**新数组**（不改入参）。
 * 编号不存在时内容不变 —— 调用方要区分"改成了"与"压根没这个编号"，自己先
 * `coords.some((c) => c.id === id)` 判一下（工具层就是这么用的：编号不存在要报 [INVALID]、
 * 一字不落盘，而不是静默写一份没推进任何东西的日志）。
 */
export function setStatus(coords: Coord[], id: string, status: CoordStatus): Coord[] {
  return coords.map((c) => (c.id === id ? { ...c, status } : c));
}

/** 某坐标的依赖里**尚未完成**的那些（派生口径）——用于解释"为什么这一步还开不了工" */
export function unmetDeps(coords: Coord[], id: string): string[] {
  const derived = deriveStatuses(coords);
  const me = coords.find((c) => c.id === id);
  if (me === undefined) return [];
  return me.deps.filter((d) => derived.get(d) !== '已完成');
}

/**
 * 提议"下一坐标"：按编号序，第一个**未开始、且依赖全部已完成**的**叶子**坐标；提不出来返回 null。
 *
 * 三条口径都是刻意的：
 *   · 只要**未开始** —— 进行中的那个就是"当前坐标"（不必再提），已完成 / 搁置的更不必；
 *   · 只要**叶子** —— 父行是**容器**（编号分段装子坐标），它自己不是一件可做的工作；
 *   · 依赖看**派生状态** —— 父坐标的"已完成"是子树的函数，读写上去的占位值会看错
 *     （比如某个依赖是父坐标、子全完成了但父行占位还写着"进行中"）。
 *
 * 提议是**建议**不是决定：真正的取舍（优先级、要不要插队）留给用户与模型，这里只回答
 * "纯粹按依赖与编号，下一步能开工的是哪一条"。
 */
export function nextCoord(coords: Coord[]): Coord | null {
  const derived = deriveStatuses(coords);
  const ok = coords
    .filter((c) => derived.get(c.id) === '未开始' && !isParentOfIn(c.id, coords))
    .filter((c) => c.deps.every((d) => derived.get(d) === '已完成'))
    .sort((a, b) => compareId(a.id, b.id));
  return ok.length > 0 ? ok[0] : null;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   依赖环检测：环 = 死锁，必须点名（格式层不拦，回执层报）
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 把一条环路径归一：旋转到**编号最小者打头**，并闭合首尾（`a → b → c → a`）。
 * 同一个环从不同节点出发会得到不同数组（`[a,b,a]` 与 `[b,a,b]`），归一后才是同一个环、
 * 才能去重。用 `compareId` 而非字典序——与全文件的编号排序口径一致。
 */
function canonicalCycle(path: string[]): string[] {
  let min = 0;
  for (let i = 1; i < path.length; i++) if (compareId(path[i], path[min]) < 0) min = i;
  const rot = [...path.slice(min), ...path.slice(0, min)];
  return [...rot, rot[0]];
}

/**
 * 找依赖环。返回每个环的一条**代表路径**（闭合，形如 `['1.1','1.2','1.1']`），按首编号排序；
 * 无环返回空数组。
 *
 * 为什么该由程序报、而不是"留给人看"：环是**死锁**——环上的坐标彼此等待，谁也不会先满足
 * `nextCoord` 的"依赖全部已完成"，于是"提不出下一坐标"与"还剩 N 个未开始坐标"可以**同时成立**。
 * 不点名的话，读的人只看到 `nextCoord === null`，很容易理解成"活干完了"。这是**静默错误**，
 * 与"能不能插队 / 菱形依赖合不合法"那种策略问题不是一个量级——后者才留给人
 * （2026-09-14 拍板：**环检测做、优先级留给人**）。
 *
 * 口径两条：
 *   · **只看表内依赖**——指向表外编号不算环（那是 `parseRoadmap` 的错，不归这里重复报）；
 *   · **自环也是一元环**（`1.1` 依赖自己 → `['1.1','1.1']`）。parse 已拦自引用，但本函数对
 *     任何输入都自洽（调用方可能喂半成品，如某行的错还没修完）。
 */
export function findCycles(coords: Coord[]): string[][] {
  const known = new Set(coords.map((c) => c.id));
  const depsOf = new Map<string, string[]>(
    coords.map((c) => [c.id, c.deps.filter((d) => known.has(d))]),
  );

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(coords.map((c) => [c.id, WHITE]));
  const stack: string[] = [];
  const raw: string[][] = [];

  // DFS 三色：踏到**灰色**节点 = 回边 = 找到环。递归深度 = 依赖链长，坐标表不会深到爆栈。
  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const d of depsOf.get(id) ?? []) {
      const cd = color.get(d) ?? BLACK;
      if (cd === GRAY) raw.push(stack.slice(stack.indexOf(d)));
      else if (cd === WHITE) visit(d);
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const c of coords) if (color.get(c.id) === WHITE) visit(c.id);

  // 归一 + 去重 + 排序：同一个环可能被多次踏到，代表路径必须收敛成一条（否则回执会重复念）
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const cyc of raw.map(canonicalCycle).sort((a, b) => compareId(a[0], b[0]))) {
    const key = cyc.join('>');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cyc);
  }
  return out;
}
