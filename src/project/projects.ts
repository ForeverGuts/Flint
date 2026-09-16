/**
 * `/projects` 的**表示层**（ROADMAP 10.11.1）—— 参数解析 / 选项目 / 排序 / 渲染。
 *
 * 为什么单独一个模块：与 `roadmap.ts`、`postcheck.ts`、`gitignore.ts` 同一立场 ——
 * 「列表长什么样、名字怎么匹配」是**能逐字校验的东西**，不该和"读磁盘、切目录、
 * 重播上下文"这些副作用搅在一个文件里（那样验它就得先真起一个进程、真切一次 cwd）。
 * 本模块**零 import**：它不认识 fs、不认识注册表、不认识 Runtime，输入是一张已经探好的
 * 行表，输出是给终端看的文本。
 *
 * ── 一条刻意的取舍：切换只能**点名**，不做交互选择 ──
 * `/sessions` 用的是 `runtime.select`（↑↓ 选），本命令**不用**。原因是那条路在非 TTY 下
 * 会**自动返回第一项**（已登记在案的已知边界，见 verify-ui/permission 那一路）——
 * 而"切换项目"会换掉 cwd 与整份注入上下文，属于**代价最大、最该由人说出口**的一步。
 * 于是 `/projects`（不带参数）= **只列不改**，要切必须 `/projects --switch <名>`。
 *
 * 零运行时依赖（本文件连 node: 都不 import）。
 */

/** 列表里的一行 —— 由命令层探测好后喂进来（谁在磁盘上、谁是当前、最近活动什么时候） */
export interface ProjectRow {
  /** 短名 = 目录 basename（注册表里那个） */
  name: string;
  /** 归一化绝对路径（正斜杠）——本机身份 */
  path: string;
  /** 首次登记时间（ISO 串；路径写法现填的行可能为空串） */
  firstSeen: string;
  /** 最近活动（毫秒时间戳）；探测不到 → null */
  lastActivityMs: number | null;
  /** 就是当前进程所在的项目 */
  current: boolean;
  /** 目录还在磁盘上（注册表是"用过"的记账，目录可能早被删了） */
  exists: boolean;
}

export type ProjectsArgs =
  | { action: 'list' }
  | { action: 'switch'; query: string }
  | { action: 'help' }
  | { action: 'error'; message: string };

export const PROJECTS_USAGE = [
  '用法：',
  '  /projects                      列出已登记的项目（只列不改）',
  '  /projects --switch <名称或路径>  切换过去（换 cwd + 重载上下文 + 换会话）',
].join('\n');

/** 取路径末段当名字（纯字符串操作，不 import path）。取不到返回原串。 */
export function nameFromPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const seg = trimmed.split(/[\\/]/).pop();
  return seg || trimmed || p;
}

/**
 * 解析命令参数。认识的只有三样：空 / `--switch <目标>` / `--help`。
 * 认不出的一律**报用法**而不是"忽略掉多余参数"——切换项目这种事上，
 * 把 `--swtich foo` 当成了"没带参数"于是只列个表，比报错更容易让人以为已经切了。
 */
export function parseProjectsArgs(args: string): ProjectsArgs {
  const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { action: 'list' };

  const head = tokens[0]!;
  if (head === '-h' || head === '--help' || head === 'help') return { action: 'help' };

  if (head === '--switch' || head === 'switch') {
    // 路径可能带空格：把剩下的原样接回去（只归一化空白）
    const query = tokens.slice(1).join(' ').trim();
    if (!query) return { action: 'error', message: '--switch 后面要跟项目名或路径。\n' + PROJECTS_USAGE };
    return { action: 'switch', query };
  }

  const inline = /^--switch=(.*)$/.exec(head);
  if (inline) {
    const query = inline[1]!.trim();
    if (!query) return { action: 'error', message: '--switch= 后面要跟项目名或路径。\n' + PROJECTS_USAGE };
    return { action: 'switch', query };
  }

  return { action: 'error', message: `未知参数 "${head}"。\n${PROJECTS_USAGE}` };
}

/** 排序键：最近活动优先，探测不到就退到首次登记时间；再不行当最旧。 */
function recencyKey(row: ProjectRow): number {
  if (row.lastActivityMs !== null && Number.isFinite(row.lastActivityMs)) return row.lastActivityMs;
  const seen = Date.parse(row.firstSeen);
  return Number.isFinite(seen) ? seen : Number.NEGATIVE_INFINITY;
}

/**
 * 按"最近活动"倒序（当前项目不特殊对待 —— 它自然会被排到前面，因为它的文件**刚刚**被动过；
 * 硬把当前项目提到第一行，反而会让"最近活动"这一列失去意义）。
 * 并列时用 名称 → 路径 兜底，保证**同一份输入永远得到同一个顺序**（列表乱跳比顺序不理想更难用）。
 */
export function sortProjectRows(rows: readonly ProjectRow[]): ProjectRow[] {
  return [...rows].sort((a, b) => {
    const d = recencyKey(b) - recencyKey(a);
    if (d !== 0) return d;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

export type PickResult =
  | { ok: true; row: ProjectRow }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'ambiguous'; matches: ProjectRow[] };

/**
 * 按名字选项目。先精确（区分大小写），再忽略大小写。
 *
 * **重名不猜**：注册表自己的 `resolve` 在重名时取"最先登记的那个"（确定就好），
 * 那是给 `pull_events` 用的——读错一个项目只是多翻一份档案。而这里选错 = **把 cwd
 * 切到另一个项目**，代价完全不同，故重名一律报出来让人自己点名（含路径写法）。
 */
export function pickProject(rows: readonly ProjectRow[], query: string): PickResult {
  const q = query.trim();
  if (!q) return { ok: false, reason: 'missing' };
  for (const exact of [true, false]) {
    const matches = rows.filter((r) => (exact ? r.name === q : r.name.toLowerCase() === q.toLowerCase()));
    if (matches.length === 1) return { ok: true, row: matches[0]! };
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches };
  }
  return { ok: false, reason: 'missing' };
}

/** 时间戳 → `YYYY-MM-DD HH:mm`（**本地时区**，给人看的）；拿不到 → `—` */
export function formatActivity(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 名字列宽（有个下限，免得短名字时整块歪掉；过长截断，防一行被一个长目录名撑爆） */
function nameColumnWidth(rows: readonly ProjectRow[]): number {
  const longest = rows.reduce((m, r) => Math.max(m, r.name.length), 0);
  return Math.min(28, Math.max(8, longest));
}

/** 名字超宽时截断（保留末尾的 `…`，让人知道被截了而不是名字就长这样） */
function fitName(name: string, width: number): string {
  return name.length <= width ? name.padEnd(width) : `${name.slice(0, width - 1)}…`;
}

/**
 * 渲染列表。`●` 标当前项目；目录不在了单独标出来 —— 那行**不许静默省略**：
 * 省略了会让人以为"这个项目不在列表里"，而真相是"它在，只是目录被删/改名了"。
 */
export function renderProjectList(rows: readonly ProjectRow[]): string {
  if (rows.length === 0) {
    return [
      '还没有登记过任何项目。',
      '用过 flint 的项目会自动进电话簿（~/.flint/projects.jsonl）——在某个项目目录里启动一次 flint 即可。',
    ].join('\n');
  }

  const sorted = sortProjectRows(rows);
  const width = nameColumnWidth(sorted);
  const current = sorted.find((r) => r.current);
  const head = current
    ? `已登记项目（${sorted.length} 个 · 当前：${current.name}）：`
    : `已登记项目（${sorted.length} 个）：`;

  const lines = sorted.map((r) => {
    const mark = r.current ? '● ' : '  ';
    const note = r.exists ? '' : '   ⚠ 目录已不存在';
    return `  ${mark}${fitName(r.name, width)}  ${formatActivity(r.lastActivityMs)}  ${r.path}${note}`;
  });

  return [
    head,
    ...lines,
    '',
    '切换：/projects --switch <名称或路径>（会换 cwd、重载上下文、换到那个项目的主会话）',
  ].join('\n');
}

export interface SwitchReceipt {
  /** 切换前的 cwd（人读，未归一化） */
  from: string;
  row: ProjectRow;
  /** 会话那一步的结果（命令层生成的**散文**：成功说清用的是哪个文件，失败说清哪一步） */
  sessionNote: string;
  context: { task: number; memory: number; events: number; calls: number };
}

/**
 * 切换回执。三条边界**必须写在回执里**，不能只活在文档里 ——
 * 用户（和模型）看到的就是这几行，边界不在这儿说，就等于没说：
 *   ① 上一个项目的档案没被动过（否则会怀疑"切走是不是把我的记忆搬走了"）；
 *   ② 授权类配置本次不生效（新项目的自检/项目命令要重启才有）；
 *   ③ 顶栏哪些像素是启动快照。
 */
export function renderSwitchReceipt(r: SwitchReceipt): string {
  const ctx = r.context;
  return [
    `🔀 已切换到项目「${r.row.name}」：${r.row.path}`,
    `   会话：${r.sessionNote}`,
    `   上下文已重载：任务 ${ctx.task} · 记忆 ${ctx.memory} · 事件 ${ctx.events} · 工具流水 ${ctx.calls}`,
    `   上一个项目（${nameFromPath(r.from)}）的档案留在它自己的目录里，未受影响`,
    '   ⚠ 只在启动读一次的授权类配置本次不生效，需重启 flint：本项目的【项目命令】与改完自检',
    '   ⚠ 顶栏只有项目名是实时的；skills / 命令计数与 Session 行仍是启动快照',
  ].join('\n');
}
