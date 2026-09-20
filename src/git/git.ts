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
 *  ③ **`log --format` 与 `branch`/`tag --format` 不是同一套占位符**：
 *    log 认 `%x1f`（0x1f 字节）；而 branch/tag 走的是 **ref-filter 语言**、
 *    认的是 `%1f` —— `%x1f` 在那两处会被**原样输出**成五个字符。
 *    **勘误**：初版（2026-09-14，只跑了 log/branch 两个探针）据此写成"branch 用字面 `|`"，
 *    **那是错的**——`|` 在 refname 里**合法**（`check-ref-format refs/heads/feat|a` 通过），
 *    Windows 上只是因为它不能做文件名而建不出来；Linux 仓库里完全可能有带 `|` 的分支，
 *    那时按 `|` 切字段会**整行错位**（后三个字段全串位）。2026-09-15 的探针 7 复测确认
 *    branch/tag 都认 `%1f`，故两个格式统一改成 `%1f`。
 *  ④ detached HEAD 的头行是 `## HEAD (no branch)`；未诞生分支是
 *    `## No commits yet on main`（旧版 git 用 `## Initial commit on main`）。
 *  ⑤ 空仓库里 `git log` 退出码 128（`does not have any commits yet`），
 *    而 `git rev-parse --abbrev-ref HEAD` 会**边抛错边在 stdout 写 "HEAD"** ——
 *    所以"当前分支"只信 `status --branch` 的头行，**不另跑 rev-parse**。
 *  ⑥ `git diff --numstat` 的重命名是**单字段** `0\t0\told.txt => new.txt`；
 *    二进制文件是 `-\t-\tpath`（不是数字，别拿 Number() 硬转）。
 *  ⑦ 用户若配了 `color.ui=always`，输出会混入 ANSI 转义码 → 解析全废。
 *    故命令前缀统一带 `-c color.ui=false`（比逐命令加 `--no-color` 更彻底）。
 *
 * ── 第二批（show / blame / remote / tag，2026-09-15 探针 4–7 取证） ──
 *  ⑧ `show --format=… --numstat <ref>` 的输出形状是「**格式块 + 一个空行 + numstat**」，
 *    故解析是按 RS 切出**第一段**当提交头、其余原样交给 `parseNumstat`。
 *    `--numstat` 对合并提交给的是**合并差异**（可能几乎为空），也可能直接给两个父的差异 ——
 *    这是 git 的口径，我们原样呈现、不替它"选一个父"（要那个得用 `-m`，属另一个 op 的事）。
 *  ⑨ `blame --line-porcelain` 每个**行块**开头是一行表头 `<hash> <原行号> <现在行号> <行数>`，
 *    其后是 `author` / `author-time`(epoch 秒) / `author-tz` / `summary` / `filename` 等键值行，
 *    最后是 `\t<行内容>`。**块与块之间没有空行**；`--date=short` 在这条路径上不起作用
 *    （那只管非 porcelain 的 `author <名字> <日期>` 一行）——日期得自己拿
 *    `author-time + author-tz` 算。未提交的行 hash 是全 0、author 是 `Not Committed Yet`、
 *    summary 是 `Version of <路径> from <路径>`，且**带 `previous`、不带 `boundary`**。
 *  ⑩ `remote -v` 每行是 `<名字>\t<URL> (fetch|push)`（tab 分隔）；空仓库输出为空串。
 *    **URL 里可能带凭据**（`https://user:token@host/…`），本工具一律打码后再外发 ——
 *    这是唯一一处"看着是只读、却可能把秘密读进模型上下文"的口子。
 *  ⑪ `tag --list --format=…` 空仓库输出为空串；`%(objecttype)` 是 `commit`（轻量标签，
 *    直接指向提交）或 `tag`（附注标签，有自己的对象与说明），`%(subject)` 取标签说明的
 *    第一行（轻量标签则取它指向那次提交的主题）。
 *  ⑫ `blame` 一个不存在的路径 → 128 + `fatal: no such path 'x' in HEAD`（专门的判据）。
 */

/**
 * 八个只读操作。**这是白名单，不是示例** —— 工具层拿它当唯一入口，别的 op 一律拒。
 *
 * 分两批：`status` / `diff` / `log` / `branch` 是第一版（2026-09-14，回答"我改了什么、
 * 我身在何处"）；`show` / `blame` / `remote` / `tag` 是 2026-09-15 补厚的覆盖面
 * （回答"这次提交改了什么、这行是谁写的、远端在哪、有哪些版本"）。
 * 加它们的判据是**只读 + 高频**：这四件事此前都只能走 `bash`，而"看一眼"本不该弹权限窗。
 */
export type GitOp = 'status' | 'diff' | 'log' | 'branch' | 'show' | 'blame' | 'remote' | 'tag';

export const GIT_OPS: readonly GitOp[] = ['status', 'diff', 'log', 'branch', 'show', 'blame', 'remote', 'tag'];

/** 一次 diff（或 show）最多报多少个文件（防一个 vendor 目录刷屏） */
export const DIFF_FILE_MAX = 50;
/** log 条数上限（`limit` 超出即夹到这个值，不报错） */
export const LOG_LIMIT_MAX = 50;
/** blame 最多显示多少行 —— 逐行责任是"看形状"的活，长文件靠 `lines` 缩范围，不是靠刷屏 */
export const BLAME_LINE_MAX = 80;

/** 单元分隔符 / 记录分隔符。log 认 `%x1f`/`%x1e`；branch/tag 是 ref-filter 语言、认 `%1f`（头注 ③） */
const US = '\u001f';
const RS = '\u001e';
export const LOG_FORMAT = `%h${US}%ad${US}%an${US}%s${RS}`;
/** show 与 log 取同一组字段（短 hash 就够指认；40 位全文进上下文只是噪音，git 自己也只显示短的） */
export const SHOW_FORMAT = LOG_FORMAT;
/** branch/tag 走 ref-filter 语言：字段分隔写 `%1f`，**不是** log 那套的 `%x1f`（头注 ③） */
export const BRANCH_FORMAT = `%(HEAD)${US}%(refname:short)${US}%(upstream:short)${US}%(upstream:track)`;
export const TAG_FORMAT = `%(refname:short)${US}%(objecttype)${US}%(creatordate:short)${US}%(subject)`;

/* ═══════════════════════════════════════════════════════════════════════════════
   命令构造：把参数变成 argv
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface GitParams {
  op: GitOp;
  /**
   * 版本引用 / 差异基准，语义**随 op 变**：
   *   · `diff`  —— `'worktree'`（默认：工作区 vs 已暂存）/ `'staged'`（已暂存 vs 上次提交）/ 任意 ref
   *   · `show`  —— 要看哪一次提交（默认 `HEAD`；`worktree`/空串都当 HEAD，见 buildGitArgs）
   *   · `blame` —— 从哪个版本开始逐行追责（默认当前工作区）
   *   · 其余 op 忽略它
   * 关键点是它落在 `--` **之前**、属 git 的**选项位置**，所以一律过 `validateTarget`。
   */
  target: string;
  /** `diff` / `show`：限定到某个文件或目录，空串 = 全仓库；`blame`：**必填**，要追责的文件 */
  path: string;
  /**
   * 仅 `blame`：只追某几行。`'10,20'` 或 `'10'`，空串 = 整份文件。
   * 白名单式校验（`validateLineRange`）—— 这个值会紧跟在 `-L` 之后，形状不对就不该进 argv。
   */
  lines: string;
  /** 仅 `log`：最近几条 */
  limit: number;
}

/** limit 夹进 1..LOG_LIMIT_MAX。超上限是"想看更多"的合理意图，夹住并说明，不该报错 */
export function normalizeLimit(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(Math.trunc(n), 1), LOG_LIMIT_MAX);
}

/**
 * 校验 diff / show / blame 的 target。
 *
 * **这是一道安全闸，不是格式洁癖。** `git diff <target> --numstat` 里 target 落在 `--`
 * **之前**，也就是 git 的**选项位置** —— `target='--output=C:/Windows/Temp/x'` 会让
 * git 把 numstat 结果**写进文件**（实测 `git diff --output=...` 是合法选项）。
 * argv 数组形式能免疫 shell 注入（`;`、`|`、`$()` 都只是普通字符），但**免疫不了
 * "被当成 git 选项"**这一路。故以 `-` 开头一律拒。`show` / `blame` 的 ref 同理
 * （它们也在 `--` 之前）。
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
 * 校验 blame 的 `lines`（行范围）。
 *
 * 白名单而不是黑名单：只接受「`起点`」或「`起点,终点`」两种纯数字写法。
 * git 的 `-L` 语法本身还很宽（`-L :函数名`、`-L '/正则/'`、`+N` 计数），但那些**属于
 * "让模型写一段 git 语法"**——本工具的前提是"参数形状可枚举"，一旦把 `-L` 的完整语法
 * 交出去，这个 op 就开始退化成"半条命名的 git 命令"。要那种用法请用 `bash`（它有权限弹窗）。
 *
 * 返回值：null = 通过；否则是给模型看的拒绝理由。
 */
export function validateLineRange(lines: string): string | null {
  const v = lines.trim();
  if (v === '') return null;
  if (!/^\d+(,\d+)?$/.test(v)) {
    return `lines 只接受两种写法：单个行号（如 10，**只追这一行**）或「起,止」（如 10,20），收到的是 ${JSON.stringify(v)}。`
      + `（git 更宽的 -L 语法如"/正则/"不在这里开口子，那种用法请走 bash。）`;
  }
  return null;
}

/**
 * 把 `lines` 归一成 git `-L` 认的那个字符串（空串 = 不传 `-L`）。
 *
 * **单个数字要展开成 `N,N`**，这一步是必须的、不是美化：
 * git 的 `-L 10` 意思是「**从第 10 行到文件末尾**」，而本参数对模型的承诺是"只追某几行"。
 * 留着这个语义陷阱（模型写 `10`、拿回 10 到末尾的一大段）比少一种"到末尾"的写法糟得多 ——
 * 何况"到末尾"用 `10,999999` 也能表达，而"只要那一行"没有别的写法。
 * 这是实测踩出来的：第一版直接把 `10` 透给 git，`verify-git` 的 H23 当场红
 * （用 `lines:"1"` 去卡"只出现 L1"，结果回来了 L1+L2）。
 */
export function normalizeLineRange(lines: string): string {
  const v = lines.trim();
  if (v === '') return '';
  const single = /^(\d+)$/.exec(v);
  return single === null ? v : `${single[1]},${single[1]}`;
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

    case 'show': {
      // target 的默认值来自 spec 的 optStr 默认（空串），而 show 的自然默认是 HEAD —— 在这里换。
      // `worktree` 也当 HEAD：那个词只对 diff 有意义，模型顺手带过来不该炸。
      const t = p.target.trim();
      const ref = (t === '' || t === 'worktree') ? 'HEAD' : t;
      const args = [...base, 'show', `--format=${SHOW_FORMAT}`, '--date=short', '--numstat'];
      if (dirPath !== '') args.push(ref, '--', dirPath);
      else args.push(ref);
      return args;
    }

    case 'blame': {
      // `-L` 紧跟在后面取值（形状已由 validateLineRange 限死），`--` 之后才是路径。
      // 归一化那一步不可省：git 的 `-L 10` 是"10 到末尾"，见 normalizeLineRange
      const args = [...base, 'blame', '--line-porcelain'];
      const range = normalizeLineRange(p.lines);
      if (range !== '') args.push('-L', range);
      args.push('--', dirPath);
      return args;
    }

    case 'remote':
      // 只跑 `-v` 那一份：它是"名字 + URL"的超集，不必再单独跑一次裸 `remote`
      return [...base, 'remote', '-v'];

    case 'tag':
      return [...base, 'tag', '--list', `--format=${TAG_FORMAT}`];
  }
}

/** git 的 stderr 说"这里不是仓库"（退出码 128） */
export function isNotARepo(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

/** git 的 stderr 说"这个分支还没有任何提交"（空仓库跑 log / show 时的 128） */
export function isNoCommitsYet(stderr: string): boolean {
  return /does not have any commits yet|unknown revision|bad default revision/i.test(stderr);
}

/**
 * git 的 stderr 说"这个路径在指定版本里不存在"（blame 一个没跟踪过的文件时的 128）。
 * 单独一条判据的理由：它**不是**环境故障，而是一个**该被讲清楚的事实**——
 * 模型最常犯的错是拿一个还没 `git add` 的新文件去 blame，那时候正确的回答是
 * "它还没有历史可追，先 add/commit"，而不是一句光秃秃的 `fatal: ...`。
 */
export function isNoSuchPath(stderr: string): boolean {
  return /no such path/i.test(stderr);
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

/**
 * `[分支] …` 那一行的**唯一实现**。
 *
 * 两份调用方：只读的 `status`（下面 `renderStatus` 的头行）与写侧的 `push` 复核
 * （`git_write` 推完拿这一行告诉模型"现在与上游是什么关系"）。
 * 抽出来的理由与 `depthsOf` / `statusCodeLabel` 同一类：**同一件事的说法只有一处** ——
 * 否则"推完之后到底同没同步"会在两处用两套话讲，而它们迟早不一致，
 * 且不一致的形态恰好是"两边单独看都对"。
 */
export function renderBranchLine(s: RepoStatus): string {
  if (s.detached) {
    return '[分支] HEAD 处于**游离状态**（detached：不在任何分支上，此刻的提交不属于任何分支）';
  }
  if (s.unborn) return `[分支] ${s.branch}（这个分支还没有任何提交）`;
  if (s.upstream === null) return `[分支] ${s.branch}（没有上游分支）`;
  const track: string[] = [];
  if (s.ahead > 0) track.push(`领先 ${s.ahead}`);
  if (s.behind > 0) track.push(`落后 ${s.behind}`);
  return `[分支] ${s.branch} → ${s.upstream}${track.length > 0 ? `（${track.join('，')}）` : ''}`;
}

export function renderStatus(s: RepoStatus): string {
  const lines: string[] = [];

  lines.push(renderBranchLine(s));

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

export interface FileSummary {
  files: number;
  added: number;
  deleted: number;
  binary: number;
}

/**
 * 一组 numstat 文件的人话汇总 —— **`diff` 与 `show` 共用**。
 *
 * 抽成一处而不是各写一遍：这套口径（二进制不算行数、汇总由程序算）是当年否决
 * "抄 git 的英文摘要行"之后立下的规矩，两处各写一份迟早会分家（一边把二进制当 0 行、
 * 另一边跳过），而"共 N 个文件、+X −Y"恰恰是最容易被模型直接引用进归档的数字。
 */
export function summarizeFiles(files: DiffFile[]): FileSummary {
  let added = 0, deleted = 0, binary = 0;
  for (const f of files) {
    if (f.binary) { binary++; continue; }
    added += f.added ?? 0;
    deleted += f.deleted ?? 0;
  }
  return { files: files.length, added, deleted, binary };
}

/** 汇总 → `5 个文件，+4，−3，1 个二进制`（`show` 与 `diff` 都用它当抬头） */
export function renderFileSummary(s: FileSummary): string {
  const parts = [`${s.files} 个文件`, `+${s.added}`, `−${s.deleted}`];
  if (s.binary > 0) parts.push(`${s.binary} 个二进制`);
  return parts.join('，');
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

  const lines = [`[差异] ${where}`, `共 ${renderFileSummary(summarizeFiles(files))}`];
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
   解析④：branch --list --format=<US 分隔>
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface BranchEntry {
  current: boolean;
  name: string;
  upstream: string | null;
  /** `[ahead 1, behind 2]` / `[gone]` / 空串；原样保留，不二次解析 */
  track: string;
}

/**
 * 解析 branch。
 *
 * 字段分隔是 `\u001f`，**不是**字面 `|`（2026-09-14 初版用了 `|`，头注 ③ 勘误里写了为什么错）：
 * `|` 在 refname 里是**合法字符**，Linux 仓库里真会有 `feat|a` 这种分支名，
 * 那时按 `|` 切字段会让后面三个字段整体串位 —— 而串位不会报错，只会**悄悄给出错的分支列表**。
 */
export function parseBranch(text: string): BranchEntry[] {
  const out: BranchEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    const f = line.split(US);
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

/* ═══════════════════════════════════════════════════════════════════════════════
   解析⑤：show --format=<US/RS> --numstat
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface ShowResult {
  /** 短 hash（够指认；40 位全文不进上下文 —— git 自己默认也只显示短的） */
  short: string;
  date: string;
  author: string;
  subject: string;
  /** 这次提交改了哪些文件（numstat 口径，与 diff 同一套解析） */
  files: DiffFile[];
}

/**
 * 解析 `show --format=… --numstat` 的输出（头注 ⑧）。
 *
 * 形状是「**格式块**（以 RS 收尾）+ 空行 + numstat 行」。所以按 **第一个 RS** 切开：
 * 左边是提交头、右边整块扔给 `parseNumstat`。不按 `\n\n` 切 —— RS 是格式自己打的、
 * 位置确定；而 numstat 里没有 RS，切点唯一。
 */
export function parseShow(text: string): ShowResult | null {
  const cut = text.indexOf(RS);
  const head = cut < 0 ? text : text.slice(0, cut);
  const body = cut < 0 ? '' : text.slice(cut + 1);

  const parts = head.split(US);
  if (parts.length < 4) return null;   // 不成形状（空输出 / 被 ANSI 染色 / 格式变了）：交给调用方兜
  return {
    short: parts[0].trim(),
    date: parts[1].trim(),
    author: parts[2].trim(),
    subject: parts.slice(3).join(US).trim(),
    files: parseNumstat(body),
  };
}

export function renderShow(s: ShowResult, path: string, truncated: boolean): string {
  const lines = [
    `[提交] ${s.short}  ${s.date}  ${s.author}`,
    `  ${s.subject}`,
  ];
  const scope = path.trim() !== '' ? `（只统计 ${path.trim()}）` : '';
  if (s.files.length === 0) {
    lines.push(`[改动] 这一次提交没有文件改动${scope}（可能是空提交，或全是合并带来的差异 —— `
      + `合并提交的 numstat 给的是**合并差异**，要看两侧各自的改动可以在 ref 后面写 ^2 之类）`);
    return lines.join('\n');
  }
  lines.push(`[改动] ${renderFileSummary(summarizeFiles(s.files))}${scope}`);
  for (const f of s.files) {
    lines.push(f.binary ? `  二进制  ${f.path}` : `  +${f.added} −${f.deleted}  ${f.path}`);
  }
  if (truncated) lines.push(`  ...（文件数超过 ${DIFF_FILE_MAX}，只列了前 ${DIFF_FILE_MAX} 个）`);
  return lines.join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   解析⑥：blame --line-porcelain
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface BlameLine {
  /** 提交 hash；未提交的行是全 0 */
  hash: string;
  author: string;
  /** 从 author-time + author-tz 算出的 `YYYY-MM-DD`（porcelain 不给现成日期，见头注 ⑨） */
  date: string;
  /** 提交主题（未提交的行是 git 自己写的 `Version of … from …`） */
  summary: string;
  /** 文件里的第几行（**最终**行号，即文件当前的样子） */
  line: number;
  content: string;
  /** 工作区里还没提交的行（hash 全 0 / `Not Committed Yet`） */
  uncommitted: boolean;
}

/** 全 0 的 hash = 尚未提交 */
const ZERO_HASH = '0000000000000000000000000000000000000000';

/**
 * `author-time`(epoch 秒) + `author-tz`(`+0800`) → `YYYY-MM-DD`。
 *
 * 为什么要自己算而不是加 `--date=short`：那面旗子只管**非 porcelain** 的
 * `author <名字> <日期>` 那一行，porcelain 给的是原始 epoch（头注 ⑨）。
 * 而且必须带上提交时的时区偏移 —— 直接 `new Date(epoch*1000)` 会按 UTC 出日期，
 * 晚上 8 点之后的提交在东八区会被算成"昨天"。
 */
export function formatEpochDate(epoch: string, tz: string): string {
  if (epoch.trim() === '') return '';
  const secs = Number(epoch);
  if (!Number.isFinite(secs)) return '';
  const m = /^([+-])(\d{2})(\d{2})$/.exec(tz.trim());
  const offsetSec = m === null ? 0 : (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60);
  const d = new Date((secs + offsetSec) * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * 解析 `blame --line-porcelain`（头注 ⑨）。
 *
 * 逐行扫：命中表头（40 位 hash 打头）就开一个新块；键值行填当前块；
 * 以 `\t` 打头的行是**行内容**，同时意味着这个块结束。块之间没有空行，
 * 所以状态机只需要"当前块"这一个变量。
 * 表头那行的第 2 个字段是**原行号**、第 3 个才是**当前行号** —— 我们要后者
 * （用户问的是"现在这一行是谁写的"）。
 */
export function parseBlame(text: string): BlameLine[] {
  const out: BlameLine[] = [];
  const headerRe = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;
  let cur: (Omit<BlameLine, 'line' | 'content'> & { line: number }) | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') continue;

    if (line.startsWith('\t')) {
      if (cur !== null) {
        out.push({ ...cur, content: line.slice(1) });
        cur = null;
      }
      continue;
    }

    const h = headerRe.exec(line);
    if (h !== null) {
      cur = {
        hash: h[1],
        author: '',
        date: '',
        summary: '',
        line: Number(h[3]),
        uncommitted: h[1] === ZERO_HASH,
      };
      continue;
    }

    if (cur === null) continue;
    if (line.startsWith('author ')) { cur.author = line.slice(7); continue; }
    if (line.startsWith('summary ')) {
      cur.summary = line.slice(8);
      continue;
    }
    if (line.startsWith('author-time ') && cur.date === '') {
      // author-tz 在 author-time 之后才出现 —— 先记 epoch，等 tz 到手再算（见下）
      cur.date = line.slice(12).trim();
      continue;
    }
    if (line.startsWith('author-tz ')) {
      // tz 一定在 time 之后（porcelain 的固定顺序）；万一没有 time 就留空，不编一个 1970
      if (cur.date !== '') cur.date = formatEpochDate(cur.date, line.slice(10));
      continue;
    }
    // boundary / previous / filename / committer* / author-mail 等：本工具不展示，跳过
  }
  return out;
}

/** blame 的一"段"：连续若干行来自同一次提交（渲染时合并，免得同一个作者刷 20 行） */
export interface BlameGroup {
  hash: string;
  author: string;
  date: string;
  summary: string;
  uncommitted: boolean;
  /** 起始行号与结束行号（同一个提交连续占用时 `end > start`） */
  start: number;
  end: number;
  /** 这些行的内容（按行序） */
  lines: string[];
}

/** 把逐行结果按**连续同 hash** 合并成段 —— 只为了少刷屏，不改语义 */
export function groupBlame(lines: BlameLine[]): BlameGroup[] {
  const out: BlameGroup[] = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last !== undefined && last.hash === l.hash && last.end + 1 === l.line) {
      last.end = l.line;
      last.lines.push(l.content);
      continue;
    }
    out.push({
      hash: l.hash, author: l.author, date: l.date, summary: l.summary,
      uncommitted: l.uncommitted, start: l.line, end: l.line, lines: [l.content],
    });
  }
  return out;
}

/**
 * `path` = 追责的文件；`lines` = 实际要显示的那些行（调用方已按 BLAME_LINE_MAX 截过）；
 * `total` = 本次 blame **命中**的行数（**不是**文件总行数 —— 用了 `-L` 之后两者不同，
 * 所以文案只说"这次嫌疑范围共 N 行"，不去声称文件有多长）。
 */
export function renderBlame(path: string, lines: BlameLine[], total: number, shown: number): string {
  if (lines.length === 0) {
    return `[责任] ${path}\n没有可追责的行（空文件，或这个范围里什么都没有）`;
  }
  const groups = groupBlame(lines);
  const head = total > shown
    ? `[责任] ${path} —— 只显示了前 ${shown} 行（这次命中 ${total} 行；要窄一点用 lines 缩范围，如 "10,20"）`
    : `[责任] ${path} —— 逐行归属（${lines.length} 行）`;
  const out = [head];
  for (const g of groups) {
    const where = g.start === g.end ? `L${g.start}` : `L${g.start}-${g.end}`;
    if (g.uncommitted) {
      out.push(`  ${where}  **未提交** —— 工作区里还没进任何提交的改动`);
    } else {
      const subj = g.summary === '' ? '' : ` —— ${g.summary}`;
      out.push(`  ${where}  ${g.hash.slice(0, 7)}  ${g.date}  ${g.author}${subj}`);
    }
    for (const content of g.lines) out.push(`      │ ${content}`);
  }
  return out.join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   解析⑦：remote -v
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface RemoteEntry {
  name: string;
  /** fetch 地址；没有则 null */
  fetch: string | null;
  /** push 地址；没有则 null */
  push: string | null;
}

/**
 * URL 里的凭据一律打码。
 *
 * 这是本工具唯一一处**看着只读、却可能把秘密读进模型上下文**的口子：
 * `https://user:token@host/repo.git` 是 remote 的常见形态，而这段字一旦进了对话，
 * 它就会被写进会话记录、事件库、以及下一次请求的上下文里 —— 那是一个**不可撤回的外泄**。
 * 打码不影响模型干活（它要知道的是"远端叫什么、在哪个主机上"），所以这里不给"要不要打码"留选项。
 */
export function redactUrl(url: string): string {
  return url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, '$1***@');
}

/**
 * 同一口径的另一半：在**自由文本**里找凭据并打码。
 *
 * 为什么不是一个函数：两者的**锚定**不同，而锚定正是判据本身。
 *   · `redactUrl` 的调用方已经知道"整串就是一个 URL"（`remote -v` 的字段），
 *     所以它锚在 `^`、且允许凭据段里出现空白；
 *   · 这里要在一段 git 输出里找（`To https://user:token@host/repo.git` 混在别的行之间），
 *     所以**不锚定**、但**不许跨空白**（否则会把后面的正文一起吃掉）。
 * 形状（`scheme://…@` → `scheme://***@`）是同一个 —— 两处都只抹凭据段，保留主机与路径，
 * 因为模型要知道的是"远端在哪台主机上"，而凭据一旦进对话就是**不可撤回的外泄**（见上）。
 *
 * 用在写侧：`push` 的失败信息里必定带远端 URL（实测 `To <url>` + `failed to push some refs
 * to '<url>'`），而那是唯一说得清 non-fast-forward 的证据，不能因为怕带凭据就不给。
 */
export function redactCredentialsIn(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]*@/g, '$1***@');
}

/**
 * 解析 `remote -v`（头注 ⑩）。每行 `<名字>\t<URL> (fetch|push)`。
 * 按名字归并（同一远端的 fetch / push 常常是同一个地址，合成一条更省上下文）。
 * 顺序按**首次出现**排，不重排 —— 让输出与 `git remote -v` 读起来一一对应。
 */
export function parseRemote(text: string): RemoteEntry[] {
  const out: RemoteEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const name = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1).trim();
    const m = /^(.*) \((fetch|push)\)$/.exec(rest);
    if (name === '' || m === null) continue;
    const url = redactUrl(m[1]);
    let e = out.find((x) => x.name === name);
    if (e === undefined) { e = { name, fetch: null, push: null }; out.push(e); }
    if (m[2] === 'fetch') e.fetch = url;
    else e.push = url;
  }
  return out;
}

export function renderRemote(entries: RemoteEntry[]): string {
  if (entries.length === 0) {
    return '[远端] 一个远端都没配（`git remote -v` 是空的；要加远端请用 bash，`git remote add …`）';
  }
  const lines = [`[远端] 共 ${entries.length} 个`];
  for (const e of entries) {
    const f = e.fetch ?? '（无 fetch 地址）';
    if (e.push !== null && e.push === e.fetch) {
      lines.push(`  ${e.name}  ${f}（fetch 与 push 同址）`);
    } else {
      lines.push(`  ${e.name}  fetch: ${f}`);
      lines.push(`  ${' '.repeat(e.name.length)}  push:  ${e.push ?? '（无 push 地址）'}`);
    }
  }
  return lines.join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   解析⑧：tag --list --format=<US 分隔>
   ═══════════════════════════════════════════════════════════════════════════════ */

export interface TagEntry {
  name: string;
  /** `commit`（轻量标签）或 `tag`（附注标签）；其它对象类型原样保留 */
  type: string;
  /** 标签创建日期 `YYYY-MM-DD` */
  date: string;
  /** 标签说明第一行；轻量标签取它指向那次提交的主题 */
  subject: string;
}

export function parseTag(text: string): TagEntry[] {
  const out: TagEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    const f = line.split(US);
    if (f.length < 2) continue;
    out.push({
      name: f[0],
      type: (f[1] ?? '').trim(),
      date: (f[2] ?? '').trim(),
      subject: f.slice(3).join(US).trim(),
    });
  }
  return out;
}

/** `commit` → 轻量标签 / `tag` → 附注标签。其余对象类型（如指向 tree）原样报出来，不编 */
export function tagTypeLabel(type: string): string {
  if (type === 'commit') return '轻量';
  if (type === 'tag') return '附注';
  return type === '' ? '未知' : type;
}

export function renderTag(entries: TagEntry[]): string {
  if (entries.length === 0) {
    return '[标签] 一个标签都没有（打标签是写操作，请用 bash：`git tag v1.0.0`）';
  }
  const lines = [`[标签] 共 ${entries.length} 个`];
  for (const t of entries) {
    const subj = t.subject === '' ? '' : `  ${t.subject}`;
    lines.push(`  ${t.name}  ${t.date}  [${tagTypeLabel(t.type)}]${subj}`);
  }
  return lines.join('\n');
}
