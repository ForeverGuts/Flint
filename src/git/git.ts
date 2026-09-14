/**
 * git 只读结构化工具 —— **格式契约与解析**（零 import 纯函数，可脱离终端验证）。
 *
 * 调用方：tools/builtin.ts 的 `git` 工具（跑子进程）+ scripts/verify-git.ts。
 * 服务于：把 `git status/diff/log/branch` 的**文本输出**翻成结构化对象，
 *         再渲染成人读得懂的正文 —— 模型不必对着 porcelain 的两字母码猜。
 *
 * ── 为什么要有这个工具（ROADMAP 10.5.1） ──
 * 在此之前，模型想知道"我改了哪些文件"只有一条路：`bash "git status"`。
 * 三个问题：
 *   ① 拿到的是**一大段文本**，模型得自己数、自己认 porcelain 码；
 *   ② 命令得走权限弹窗（bash 能改东西，必须问），而"看一眼状态"本不该问；
 *   ③ 模型可以顺手写 `git status && git commit -m x`（一条命令混读与写），
 *      而授权边界是整条命令 —— 读操作的便利与写操作的风险被绑在一起。
 * 本工具用 **op 白名单 + argv 数组** 把读操作单独摘出来：它只会跑
 * status / diff / log / branch 四条命令，且**不经 shell**（见下）。
 *
 * ── 本模块的全部"实测事实"（2026-09-14 三个探针脚本取证，不是照文档推的） ──
 * ① `-c core.quotepath=false` 只解决**转义**（`\344\270\255` → `中`），不解决**引号**：
 *    非 `-z` 模式下含空格/中文的路径仍被双引号包住 —— `?? "中文 文件.txt"`。
 *    含引号的路径还得再解一层 C 风格转义（`\"`、`\\`）。**故一律用 `-z`**：NUL 分隔，
 *    路径原样裸出，解析器不必实现半个 C 转义表。
 *  ② `-z` 模式下**重命名占两段**：`R  new.txt` NUL `old.txt`（新在前、旧在后）。
 *    非 `-z` 模式下则是单行的 `R  old.txt -> new.txt` —— 两种形状完全不同，
 *    解析器必须按 `-z` 的那种写。状态码第一位是 R/C 时才多消费一段。
 *  ③ **`git branch --format` 与 `git log --format` 不是同一套占位符**：
 *    log 认 `%x1f`（0x1f 字节），branch **不认**，输出的是**字面量** `%x1f` 五个字符。
 *    实测 branch 认字面 `|`、`%09`(tab)、`%00`(NUL)。故 branch 用字面 `|`
 *    （refname 规则本就禁止 `|`，不会与分支名相撞），log 用 `%x1f`/`%x1e`。
 *  ④ detached HEAD 的头行是 `## HEAD (no branch)`；未诞生分支是
 *    `## No commits yet on main`（旧版 git 用 `## Initial commit on main`）。
 *  ⑤ 空仓库里 `git log` 退出码 128（`does not have any commits yet`），
 *    而 `git rev-parse --abbrev-ref HEAD` 会**边抛错边在 stdout 写 "HEAD"** ——
 *    所以"当前分支"只信 `status --branch` 的头行，**不另跑 rev-parse**。
 *  ⑥ `git diff --numstat` 的重命名是**单字段** `0\t0\told.txt => new.txt`；
 *    二进制文件是 `-\t-\tpath`（不是数字，别拿 Number() 硬转）。
 *  ⑦ 用户若配了 `color.ui=always`，输出会混入 ANSI 转义码 → 解析全废。
 *    故命令前缀统一带 `-c color.ui=false`（比逐命令加 `--no-color` 更彻底）。
 */

/** 四个只读操作。**这是白名单，不是示例** —— 工具层拿它当唯一入口，别的 op 一律拒 */
export type GitOp = 'status' | 'diff' | 'log' | 'branch';

export const GIT_OPS: readonly GitOp[] = ['status', 'diff', 'log', 'branch'];

/** 一次 diff 最多报多少个文件（防一个 vendor 目录刷屏） */
export const DIFF_FILE_MAX = 50;
/** log 条数上限（`limit` 超出即夹到这个值，不报错） */
export const LOG_LIMIT_MAX = 50;

/** 单元分隔符 / 记录分隔符：log 的 %x1f 认、%x1e 认（branch 不认，见头注 ③） */
const US = '\u001f';
const RS = '\u001e';
export const LOG_FORMAT = `%h${US}%ad${US}%an${US}%s${RS}`;
export const BRANCH_FORMAT = '%(HEAD)|%(refname:short)|%(upstream:short)|%(upstream:track)';

/* ═══════════════════════════════════════════════════════════════════════════════
   命令构造：把参数变成 argv
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface GitParams {
  op: GitOp;
  /** 仅 diff：'worktree'（默认，工作区 vs 已暂存）/ 'staged'（已暂存 vs 上次提交）/ 任意版本引用 */
  target: string;
  /** 仅 diff：限定到某个文件或目录，空串 = 全仓库 */
  path: string;
  /** 仅 log：最近几条 */
  limit: number;
}

/** limit 夹进 1..LOG_LIMIT_MAX。超上限是"想看更多"的合理意图，夹住并说明，不该报错 */
export function normalizeLimit(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(Math.trunc(n), 1), LOG_LIMIT_MAX);
}

/**
 * 校验 diff 的 target。
 *
 * **这是一道安全闸，不是格式洁癖。** `git diff <target> --numstat` 里 target 落在 `--`
 * **之前**，也就是 git 的**选项位置** —— `target='--output=C:/Windows/Temp/x'` 会让
 * git 把 numstat 结果**写进文件**（实测 `git diff --output=...` 是合法选项）。
 * argv 数组形式能免疫 shell 注入（`;`、`|`、`$()` 都只是普通字符），但**免疫不了
 * "被当成 git 选项"**这一路。故以 `-` 开头一律拒。
 *
 * 返回值：null = 通过；否则是给模型看的拒绝理由。
 */
export function validateTarget(target: string): string | null {
  const s = target.trim();
  if (s === '' || s === 'worktree' || s === 'staged') return null;
  if (s.startsWith('-')) {
    return `target 不能以 - 开头（那会被 git 当成**选项**而不是版本引用，例如 `
      + `--output=文件 会把结果写进磁盘）：${s}。要看某次提交请写 ref，如 HEAD~1 或 main；`
      + `不看某项改动请留空（默认 worktree）`;
  }
  if (/[\s\u0000\u001f]/.test(s)) {
    return `target 里有空白或不可见字符，不像一个版本引用：${JSON.stringify(s)}`;
  }
  return null;
}

/**
 * 构造 git 的参数数组。调用方必须用 `execFileSync('git', argv)` —— **不经 shell**。
 *
 * 前缀两个 `-c`：
 *   · `core.quotepath=false` —— 让中文路径不被转义成 `\344\270\255`（-z 已解决引号，这个解决转义）
 *   · `color.ui=false` —— 用户的 git 配置里若开了强制着色，ANSI 码会混进输出（头注 ⑦）
 */
export function buildGitArgs(p: GitParams): string[] {
  const base = ['-c', 'core.quotepath=false', '-c', 'color.ui=false'];
  const dirPath = p.path.trim();

  switch (p.op) {
    case 'status':
      // --untracked-files=all：默认的 normal 会把整个未跟踪目录折叠成一行 `?? dir/`，
      // 模型据此以为只有 1 个新文件，而里面可能有 20 个
      return [...base, 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'];

    case 'diff': {
      const t = p.target.trim();
      const args = [...base, 'diff'];
      if (t === 'staged') args.push('--cached');
      else if (t !== '' && t !== 'worktree') args.push(t);
      args.push('--numstat');           // 数值化（增/删行数），不依赖 git 生成的英文摘要行
      if (dirPath !== '') args.push('--', dirPath);
      return args;
    }

    case 'log':
      return [...base, 'log', `--max-count=${normalizeLimit(p.limit)}`, '--date=short',
        `--format=${LOG_FORMAT}`];

    case 'branch':
      return [...base, 'branch', '--list', `--format=${BRANCH_FORMAT}`];
  }
}

/** git 的 stderr 说"这里不是仓库"（退出码 128） */
export function isNotARepo(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

/** git 的 stderr 说"这个分支还没有任何提交"（空仓库跑 log 时的 128） */
export function isNoCommitsYet(stderr: string): boolean {
  return /does not have any commits yet|unknown revision|bad default revision/i.test(stderr);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   解析①：status --porcelain=v1 -z --branch
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface StatusEntry {
  /** porcelain 的两字母码，如 `M ` / ` M` / `??` / `R ` */
  xy: string;
  /** 仓库根相对的路径（-z 模式下是裸路径，无引号无转义） */
  path: string;
  /** 仅重命名/复制：原路径（-z 模式下是紧跟着的那一段） */
  orig: string | null;
}

export interface RepoStatus {
  /** 当前分支名；detached 时为空串 */
  branch: string;
  /** 上游分支，如 origin/main；没有则 null */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** HEAD 游离（不在任何分支上） */
  detached: boolean;
  /** 分支已创建但还没有任何提交 */
  unborn: boolean;
  entries: StatusEntry[];
}

const AHEAD_RE = /ahead (\d+)/;
const BEHIND_RE = /behind (\d+)/;

/**
 * 解析 `status --porcelain=v1 -z --branch` 的输出。
 *
 * `-z` 的契约（头注 ②）：第一段是头行 `## ...`；其后每段是 `XY <path>`；
 * **XY 第一位是 R 或 C 时，紧跟着的那一段是原路径**（不带 XY，纯路径）。
 * 行序按 NUL 分 —— 不能用 split('\n')，因为路径里可以合法地含换行符。
 */
export function parseStatus(zOut: string): RepoStatus {
  const segs = zOut.split('\u0000');
  // 末尾的 NUL 会切出一个空尾巴；空仓库时首段是 `## No commits yet on main`
  const out: RepoStatus = {
    branch: '', upstream: null, ahead: 0, behind: 0,
    detached: false, unborn: false, entries: [],
  };

  let i = 0;
  for (; i < segs.length; i++) {
    const s = segs[i];
    if (s === '') continue;
    if (s.startsWith('## ')) { applyHead(s.slice(3), out); i++; break; }
    // 没有头行（理论上 --branch 一定给）→ 别把疑似文件段当头行吞掉
    break;
  }

  while (i < segs.length) {
    const seg = segs[i];
    i++;
    if (seg === '') continue;
    if (seg.length < 3) continue;             // 不成形状的段：跳过而不是崩
    const xy = seg.slice(0, 2);
    const path = seg.slice(3);                // 第 3 个字符是分隔空格
    // 头注 ②：R/C 的旧路径在**下一段**
    if (xy[0] === 'R' || xy[0] === 'C') {
      const orig = segs[i] ?? '';
      i++;
      out.entries.push({ xy, path, orig: orig === '' ? null : orig });
      continue;
    }
    out.entries.push({ xy, path, orig: null });
  }
  return out;
}

/** 解析头行（`## ` 之后的部分）。四种形状见文件头注 ④ */
function applyHead(head: string, out: RepoStatus): void {
  if (head === 'HEAD (no branch)') { out.detached = true; return; }

  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(head);
  if (unborn) { out.unborn = true; out.branch = unborn[1].trim(); return; }

  // `main...origin/main [ahead 1, behind 2]` / `main...origin/main [gone]` / `main`
  const bracketAt = head.indexOf(' [');
  const main = bracketAt >= 0 ? head.slice(0, bracketAt) : head;
  const track = bracketAt >= 0 ? head.slice(bracketAt + 2, head.endsWith(']') ? -1 : undefined) : '';

  const dots = main.indexOf('...');
  if (dots >= 0) {
    out.branch = main.slice(0, dots).trim();
    const up = main.slice(dots + 3).trim();
    out.upstream = up === '' ? null : up;
  } else {
    out.branch = main.trim();
  }
  out.ahead = Number(AHEAD_RE.exec(track)?.[1] ?? 0);
  out.behind = Number(BEHIND_RE.exec(track)?.[1] ?? 0);
}

/** XY 码 → 人话注解 */
export function statusCodeLabel(xy: string): string {
  if (xy === '??') return '未跟踪';
  if (xy === '!!') return '已忽略';
  const X = xy[0] ?? ' ';
  const Y = xy[1] ?? ' ';
  // 冲突族：任一位是 U，或双方同时增/删（both added / both deleted）
  if (X === 'U' || Y === 'U' || xy === 'AA' || xy === 'DD') return '冲突（未解决）';

  const WORD: Record<string, string> = {
    M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', T: '类型变更',
  };
  const xw = WORD[X] ?? '';
  const yw = WORD[Y] ?? '';
  if (xw !== '' && yw !== '') return `已暂存+未暂存：${xw}`;
  if (xw !== '') return `已暂存：${xw}`;
  if (yw !== '') return `未暂存：${yw}`;
  return '未知状态';
}

export function renderStatus(s: RepoStatus): string {
  const lines: string[] = [];

  if (s.detached) {
    lines.push('[分支] HEAD 处于**游离状态**（detached：不在任何分支上，此刻的提交不属于任何分支）');
  } else if (s.unborn) {
    lines.push(`[分支] ${s.branch}（这个分支还没有任何提交）`);
  } else if (s.upstream !== null) {
    const track: string[] = [];
    if (s.ahead > 0) track.push(`领先 ${s.ahead}`);
    if (s.behind > 0) track.push(`落后 ${s.behind}`);
    lines.push(`[分支] ${s.branch} → ${s.upstream}${track.length > 0 ? `（${track.join('，')}）` : ''}`);
  } else {
    lines.push(`[分支] ${s.branch}（没有上游分支）`);
  }

  if (s.entries.length === 0) {
    lines.push('工作区干净：没有未提交的改动');
    return lines.join('\n');
  }

  const staged = s.entries.filter((e) => e.xy[0] !== ' ' && e.xy[0] !== '?').length;
  const unstaged = s.entries.filter((e) => e.xy[0] === ' ' && e.xy[1] !== ' ').length;
  const untracked = s.entries.filter((e) => e.xy === '??').length;
  const parts = [`共 ${s.entries.length} 处改动`];
  if (staged > 0) parts.push(`已暂存 ${staged}`);
  if (unstaged > 0) parts.push(`未暂存 ${unstaged}`);
  if (untracked > 0) parts.push(`未跟踪 ${untracked}`);
  lines.push(`[改动] ${parts.join('，')}`);

  for (const e of s.entries) {
    const shown = e.orig === null ? e.path : `${e.orig} → ${e.path}`;
    lines.push(`  ${e.xy} ${shown} —— ${statusCodeLabel(e.xy)}`);
  }
  return lines.join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   解析②：diff --numstat
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface DiffFile {
  /** 新增行数；二进制文件为 null */
  added: number | null;
  /** 删除行数；二进制文件为 null */
  deleted: number | null;
  /** 路径原样（重命名是 `旧 => 新`，**刻意不拆**：拆了就得猜 git 的缩写规则） */
  path: string;
  /** 该文件是二进制（numstat 给 `-` 而非数字） */
  binary: boolean;
}

/**
 * 解析 `--numstat` 的输出。每行 `增\t删\t路径`（头注 ⑥）。
 * 不走 `--stat` 的原因：它每行末尾是 git **自己生成的** humana 摘要，
 * 而我们要报的"共 N 个文件、+X −Y"必须由程序算 —— 自己算的才可断言、才不随 locale 变。
 */
export function parseNumstat(text: string): DiffFile[] {
  const out: DiffFile[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    const first = line.indexOf('\t');
    const second = line.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const a = line.slice(0, first);
    const d = line.slice(first + 1, second);
    const path = line.slice(second + 1);
    const binary = a === '-' || d === '-';
    out.push({
      added: binary ? null : Number(a),
      deleted: binary ? null : Number(d),
      path,
      binary,
    });
  }
  return out;
}

/** diff 三个 target 各自的人话说明（渲染用） */
export function describeDiffTarget(target: string): string {
  const t = target.trim();
  if (t === '' || t === 'worktree') return '工作区 vs 已暂存（尚未 add 的改动）';
  if (t === 'staged') return '已暂存 vs 上次提交（已经 add 的改动）';
  return `工作区 vs ${t}`;
}

export function renderDiff(files: DiffFile[], target: string, path: string, truncated: boolean): string {
  const where = describeDiffTarget(target) + (path.trim() !== '' ? `，限定路径 ${path.trim()}` : '');
  // 一个高频误读：`git diff` 只看**已跟踪**的文件，所以"我刚新建的文件"根本不出现。
  // 模型据此以为"我只改了一个文件"，于是归档时漏掉整个新文件 —— 明确写出来。
  const untrackedHint = (target.trim() === '' || target.trim() === 'worktree')
    ? '\n（注意：未跟踪的新文件不会出现在 diff 里 —— 用 op=status 看它们）'
    : '';

  if (files.length === 0) {
    return `[差异] ${where}\n没有差异（这两个状态在这${path.trim() !== '' ? '个路径下' : '个仓库里'}完全一致）${untrackedHint}`;
  }

  let add = 0, del = 0, bin = 0;
  for (const f of files) {
    if (f.binary) { bin++; continue; }
    add += f.added ?? 0;
    del += f.deleted ?? 0;
  }
  const sum = [`${files.length} 个文件`, `+${add}`, `−${del}`];
  if (bin > 0) sum.push(`${bin} 个二进制`);
  const lines = [`[差异] ${where}`, `共 ${sum.join('，')}`];
  for (const f of files) {
    lines.push(f.binary ? `  二进制  ${f.path}` : `  +${f.added} −${f.deleted}  ${f.path}`);
  }
  if (truncated) lines.push(`  ...（文件数超过 ${DIFF_FILE_MAX}，只列了前 ${DIFF_FILE_MAX} 个）`);
  return lines.join('\n') + untrackedHint;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   解析③：log --format=<US/RS 格式>
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface LogEntry {
  hash: string;
  date: string;
  author: string;
  subject: string;
}

/**
 * 解析 log。格式见 LOG_FORMAT：`hash US date US author US subject RS`，
 * 记录之间夹一个 `\n`（实测），故按 RS 切完要 trim。
 * 用 US/RS 控制字符而不是 `|`/tab：subject 里出现 `|` 是家常便饭，出现 0x1f 不可能。
 */
export function parseLog(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const rec of text.split(RS)) {
    const r = rec.trim();
    if (r === '') continue;
    const parts = r.split(US);
    if (parts.length < 4) continue;
    out.push({ hash: parts[0], date: parts[1], author: parts[2], subject: parts.slice(3).join(US) });
  }
  return out;
}

export function renderLog(entries: LogEntry[], limit: number): string {
  if (entries.length === 0) {
    return '[提交] 这个仓库还没有任何提交（HEAD 尚未诞生 —— 通常意味着刚 init、还没 commit 过）';
  }
  const lines = [`[提交] 最近 ${entries.length} 条（最多取 ${normalizeLimit(limit)}）`];
  for (const e of entries) {
    lines.push(`  ${e.hash}  ${e.date}  ${e.author}  ${e.subject}`);
  }
  return lines.join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   解析④：branch --list --format=<字面 | 分隔>
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface BranchEntry {
  current: boolean;
  name: string;
  upstream: string | null;
  /** `[ahead 1, behind 2]` / `[gone]` / 空串；原样保留，不二次解析 */
  track: string;
}

export function parseBranch(text: string): BranchEntry[] {
  const out: BranchEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    const f = line.split('|');
    if (f.length < 2) continue;
    out.push({
      current: f[0].trim() === '*',
      name: f[1],
      upstream: (f[2] ?? '').trim() === '' ? null : f[2].trim(),
      track: (f[3] ?? '').trim(),
    });
  }
  return out;
}

export function renderBranch(entries: BranchEntry[]): string {
  if (entries.length === 0) {
    return '[分支] 一个分支都还没有（空仓库：分支要等第一次 commit 才诞生）';
  }
  const lines = [`[分支] 共 ${entries.length} 个（* 表示当前所在）`];
  for (const b of entries) {
    const up = b.upstream === null ? '' : ` → ${b.upstream}`;
    const tr = b.track === '' ? '' : ` ${b.track}`;
    lines.push(`  ${b.current ? '*' : ' '} ${b.name}${up}${tr}`);
  }
  return lines.join('\n');
}
