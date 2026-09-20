/**
 * verify-git.ts —— git 只读结构化工具（ROADMAP 10.5.1）
 *
 * 为什么需要它：这个工具的价值全在"**把 git 的文本翻成结构**"这一步，而它翻得对不对，
 * 只有拿**真实字节**喂进去才知道。所以本套件的夹具不是编的 —— 全部来自 2026-09-14 三个
 * 探针脚本对真仓库的实测输出（`WorkBuddy_Test/probe-git*.mjs`），连 `\u001f` 分隔符、
 * `-z` 的两段式重命名、`## HEAD (no branch)` 这些细节都是照抄，不是照文档推的。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 命令构造 —— argv 形状（`-z` / `--numstat` / 不加 shell 拼接 / 两个 `-c` 前缀）
 *   ② 安全闸 —— `target` 以 `-` 开头必须被拒（那是 git 的**选项位置**，能变成 --output=文件）
 *   ③ status 解析与渲染 —— 实测字节；含两段式重命名、裸中文路径、detached / unborn
 *   ④ status 状态码译码 —— XY 两字母 → 人话
 *   ⑤ diff 解析与渲染 —— numstat 的三种行（数字 / 二进制 / 重命名）+ 汇总自算
 *   ⑥ log 解析与渲染 —— US/RS 分隔、subject 含 `|` 也不破
 *   ⑦ branch 解析与渲染 —— **US 分隔**（不是字面 `|`：`|` 在 refname 里合法，会整行串位）
 *   ⑧ show 解析与渲染 —— `格式块 + 空行 + numstat` 的形状、`full=false` 的空提交
 *   ⑨ blame 解析与渲染 —— 行块状态机、`author-time + author-tz` 自己算日期（**时区不能丢**）、
 *      未提交的行、连续同提交合并成段
 *   ⑩ remote 解析与渲染 —— tab 分隔、同址合并、**URL 里的凭据必须打码**
 *   ⑪ tag 解析与渲染 —— 轻量（objecttype=commit）/ 附注（objecttype=tag）两种
 *   ⑫ 行范围白名单 —— 只收纯数字，`-L` 的宽语法刻意不在这里开口子
 *   ⑬ 行为 —— 真 git 仓库端到端跑**八个 op**（含未跟踪不进 diff、非仓库报错、空仓库 log）
 *   ⑭ 拒绝路径 —— 未知 op / 危险 target / blame 缺 path / 非法行范围 → [INVALID]，
 *      且**一个 git 进程都没起**
 *   ⑮ 源码守护 + 提示词交叉 —— 纯模块零 import、不弹窗、走 execFileSync、格式常量不许混用占位符
 *   ⑯ 路由 —— bash 里的**裸** git 只读命令 → git 工具（ROADMAP 10.5.6）：纯函数逐形状、
 *      钩子适配器 fail-open 四态、真 PromptEventEmitter 总线行为、源码守护（契约闸排在路由之前）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-git.ts
 * 退出码：failed > 0 → 1
 *
 * 环境依赖：⑧⑨ 两段要真的 git。**没装 git 时这一段走"占位断言"**（数量不变、恒真），
 * 以免项数随环境浮动而打乱 TESTING 里的固定项数 —— 但会在输出里醒目说明。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { TaskStore } from '../src/todo/store.js';
import { MemoryStore } from '../src/memory/store.js';
import { EventStore } from '../src/eventlog/store.js';
import {
  BLAME_LINE_MAX, BRANCH_FORMAT, GIT_OPS, LOG_FORMAT, LOG_LIMIT_MAX, SHOW_FORMAT, TAG_FORMAT,
  buildGitArgs, formatEpochDate, groupBlame, normalizeLimit, normalizeLineRange, parseBlame,
  parseBranch, parseLog, parseNumstat, parseRemote, parseShow, parseStatus, parseTag, redactUrl,
  renderBlame, renderBranch, renderDiff, renderFileSummary, renderLog, renderRemote, renderShow,
  renderStatus, renderTag, statusCodeLabel, summarizeFiles, tagTypeLabel, validateLineRange,
  validateTarget, type GitOp,
} from '../src/git/git.js';
import { routeBashGitRead, routeGitRead } from '../src/git/route.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { decodeDeny } from '../src/loop/tool-hooks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   夹具：全部来自探针实测（见文件头）
   ═══════════════════════════════════════════════════════════════════════════════ */

// 实测自 probe-git3：有上游、领先且落后、含两段式重命名与裸中文路径
const S_STATUS_FULL = '## main...origin/main [ahead 2, behind 1]\u0000'
  + 'M  staged.txt\u0000'          // 已暂存：修改
  + ' M dirty.txt\u0000'          // 未暂存：修改
  + 'R  new.txt\u0000old.txt\u0000'   // 重命名：**旧路径在下一段**（实测）
  + '?? 中文 文件.txt\u0000';       // 未跟踪：-z 下是裸路径，**没有引号**（实测）
// 实测自 probe-git2：有提交、工作区干净
const S_STATUS_CLEAN = '## main\u0000';
// 实测自 probe-git2：空仓库（还没有任何提交）
const S_STATUS_UNBORN = '## No commits yet on main\u0000';
// 旧版 git 的空仓库措辞（文档口径，一并容错）
const S_STATUS_UNBORN_OLD = '## Initial commit on main\u0000';
// 实测自 probe-git3：detached HEAD
const S_STATUS_DETACHED = '## HEAD (no branch)\u0000R  new.txt\u0000old.txt\u0000';

// 实测自 probe-git：`1\t0\ta.txt`；重命名是单字段 `a => b`；二进制是 `-`
const S_NUMSTAT = '1\t0\ta.txt\n'
  + '0\t1\tb.txt\n'
  + '0\t0\told.txt => new.txt\n'
  + '-\t-\timg.png\n'
  + '3\t2\tsub/dir/c.ts\r\n';

// 实测自 probe-git：`hash US date US author US subject RS` + 换行
const S_LOG = '9de747b\u001f2026-09-14\u001fTester\u001fsecond commit\u001e\n'
  + 'cb9f369\u001f2026-09-14\u001fTester\u001ffirst commit\u001e\n';
// subject 里出现 `|` 与 tab 是家常便饭 —— 正是用 US/RS 而不是 `|` 的原因
const S_LOG_PIPES = 'abc1234\u001f2026-09-14\u001fT\u001ffix: a|b\tc\u001e\n';

// 实测自 probe-git7：branch 的字段分隔是 **US**（`%1f`）。**不是**字面 `|` ——
// 2026-09-14 初版用了 `|`，理由是"refname 规则禁止 `|`"，而探针 6 证明那是**错的**
// （`check-ref-format refs/heads/feat|a` 通过，只是 Windows 上不能做文件名）。
const S_BRANCH = '*\u001fmain\u001forigin/main\u001f[ahead 1]\n \u001fdev\u001f\u001f\n';
// 实测自 probe-git3：detached 时 %(HEAD) 那行是伪分支
const S_BRANCH_DETACHED = '*\u001f(HEAD detached at 3b70939)\u001f\u001f\n \u001fmain\u001forigin/main\u001f[ahead 1]\n';
// 这就是"用 `|` 当分隔符时会整行串位"的那个分支名前缀（Linux 仓库里真存在）
const S_BRANCH_PIPE = '*\u001ffeat|a\u001forigin/feat|a\u001f[ahead 1]\n';

// 实测自 probe-git4：`show --format=<US/RS> --numstat` = 格式块 + **空行** + numstat
const S_SHOW = '0cf62bd\u001f2026-09-15\u001fProbe'
  + '\u001f第二提交：改 a 并加 b | 竖线也要有\u001e\n'
  + '\n'
  + '2\t1\ta.txt\n'
  + '1\t0\tb.txt\n';
// --numstat 没有任何改动时，只剩格式块 + 那个空行（实测自 probe-git4 的 --no-patch 形状）
const S_SHOW_EMPTY = '0cf62bd\u001f2026-09-15\u001fProbe\u001f空提交\u001e\n\n';

// 实测自 probe-git4 的 `blame --line-porcelain`（截取 3 行：两次提交 + 一行未提交）
// 注意形状：**块之间没有空行**、表头第 3 个字段才是"当前行号"、内容行以 \t 打头、
// 未提交那块的 hash 是全 0、author 是 `Not Committed Yet`、summary 是 git 自己编的
// `Version of … from …`，且带 `previous` 而**不带** `boundary`
const S_BLAME = 'bd16c08e8cda5c0515fbf0dbc9493c4f7151248f 1 1 1\n'
  + 'author Probe\n'
  + 'author-mail <probe@example.com>\n'
  + 'author-time 1789438416\n'
  + 'author-tz +0800\n'
  + 'committer Probe\n'
  + 'committer-mail <probe@example.com>\n'
  + 'committer-time 1789438416\n'
  + 'committer-tz +0800\n'
  + 'summary 初始化提交：建 a.txt\n'
  + 'boundary\n'
  + 'filename a.txt\n'
  + '\tline1\n'
  + '0cf62bd2ab1e0f164249db59661e06bb979c2737 2 2 1\n'
  + 'author Probe\n'
  + 'author-time 1789438418\n'
  + 'author-tz +0800\n'
  + 'summary 第二提交：改 a 并加 b\n'
  + 'previous bd16c08e8cda5c0515fbf0dbc9493c4f7151248f a.txt\n'
  + 'filename a.txt\n'
  + '\tline2 改了\n'
  + '0000000000000000000000000000000000000000 3 3 1\n'
  + 'author Not Committed Yet\n'
  + 'author-time 1789438422\n'
  + 'author-tz +0800\n'
  + 'summary Version of a.txt from a.txt\n'
  + 'previous 0cf62bd2ab1e0f164249db59661e06bb979c2737 a.txt\n'
  + 'filename a.txt\n'
  + '\t未提交的一行\n';

/**
 * 上面那份 S_BLAME 是**探针原件**（逐字节照抄，三行来自三个不同的 hash）。
 * 这一份是**合成**的：只为验"连续同提交要合并成段"这条——探针没恰好碰上两行同提交，
 * 而 `--line-porcelain` 的契约是**每一行都重复完整的提交信息块**，所以按契约拼出来即可。
 */
const blameBlock = (hash: string, lineNo: number, content: string): string =>
  `${hash} ${lineNo} ${lineNo} 1\n`
  + 'author Probe\n'
  + 'author-mail <probe@example.com>\n'
  + 'author-time 1789438416\n'
  + 'author-tz +0800\n'
  + 'committer Probe\n'
  + 'committer-mail <probe@example.com>\n'
  + 'committer-time 1789438416\n'
  + 'committer-tz +0800\n'
  + 'summary 初始化提交：建 a.txt\n'
  + 'filename a.txt\n'
  + `\t${content}\n`;
const S_BLAME_RUN = blameBlock('a'.repeat(40), 1, 'one')
  + blameBlock('a'.repeat(40), 2, 'two')
  + blameBlock('b'.repeat(40), 3, 'three');

// 实测自 probe-git4：`remote -v` 是 tab 分隔的 `名字 \t URL (fetch|push)`
const S_REMOTE = 'origin\thttps://example.com/repo.git (fetch)\norigin\thttps://example.com/repo.git (push)\n';
// 同一远端 fetch/push 不同址（常见：https 读、ssh 写）+ 第二个远端
const S_REMOTE_TWO = 'origin\thttps://example.com/repo.git (fetch)\n'
  + 'origin\tgit@example.com:repo.git (push)\n'
  + 'upstream\thttps://example.com/up.git (fetch)\n'
  + 'upstream\thttps://example.com/up.git (push)\n';
// **凭据打码**的用例：URL 里带 user:token，绝不能原样进模型上下文
const S_REMOTE_CRED = 'origin\thttps://alice:ghp_SUPERSECRET@example.com/repo.git (fetch)\n'
  + 'origin\thttps://alice:ghp_SUPERSECRET@example.com/repo.git (push)\n';

// 实测自 probe-git7：tag 的 objecttype 是 commit（轻量标签）或 tag（附注标签）
const S_TAG = 'v1.0.0\u001fcommit\u001f2026-09-15\u001f第一次提交\n'
  + 'v1.1.0\u001ftag\u001f2026-09-15\u001f带说明的标签\n';
// 标签说明里带 `|` 也不能破 —— 这正是"不能拿 `|` 当字段分隔"的同一个理由
const S_TAG_PIPE = 'v1.0.0\u001fcommit\u001f2026-09-15\u001f第二提交：改 a 并加 b | 竖线也要有\n';

const P = { op: 'status' as const, target: 'worktree', path: '', lines: '', limit: 10 };

/* ── ① 命令构造 ── */
console.log('── ① 命令构造（argv 形状） ──');

{
  const status = buildGitArgs({ ...P, op: 'status' });
  check('A1 status 用 -z（NUL 分隔，中文/空格路径才不被引号包住）',
    status.includes('-z') && status.includes('--porcelain=v1'));
  check('A2 status 带 --branch（当前分支 + 领先落后都从这一处来，不另跑 rev-parse）',
    status.includes('--branch'));
  check('A3 status 用 --untracked-files=all（默认会把整个未跟踪目录折叠成一行）',
    status.includes('--untracked-files=all'));

  const diff0 = buildGitArgs({ ...P, op: 'diff' });
  check('A4 diff 默认（worktree）不带 ref，也不带 --cached',
    diff0.includes('diff') && !diff0.includes('--cached') && !diff0.includes('HEAD'));
  check('A5 diff 用 --numstat（要数字，不要 git 生成的英文摘要行）', diff0.includes('--numstat'));

  const diffS = buildGitArgs({ ...P, op: 'diff', target: 'staged' });
  check('A6 target=staged → --cached', diffS.includes('--cached'));

  const diffR = buildGitArgs({ ...P, op: 'diff', target: 'HEAD~2' });
  check('A7 target=某 ref → 原样进 argv', diffR.includes('HEAD~2'));

  const diffP = buildGitArgs({ ...P, op: 'diff', path: 'src/tools' });
  check('A8 path 落在 `--` 之后（git 才把它当路径而非选项）',
    diffP.indexOf('--') > 0 && diffP[diffP.indexOf('--') + 1] === 'src/tools');

  const log = buildGitArgs({ ...P, op: 'log' });
  check('A9 log 用 --max-count 而不是 --all/--since 之类（只读且定量）',
    log.includes(`--max-count=${normalizeLimit(P.limit)}`) && log.includes(`--format=${LOG_FORMAT}`));

  const br = buildGitArgs({ ...P, op: 'branch' });
  check('A10 branch 的 --format 用 **US 分隔**（ref-filter 语言认 `%1f`；`|` 会被分支名撞上而整行串位）',
    br.includes(`--format=${BRANCH_FORMAT}`) && BRANCH_FORMAT.includes('\u001f') && !br.some((a) => a.includes('%x1f')));

  const show = buildGitArgs({ ...P, op: 'show' });
  const showP = buildGitArgs({ ...P, op: 'show', target: 'HEAD~1', path: 'src/x' });
  const blame = buildGitArgs({ ...P, op: 'blame', path: 'a.txt' });
  const blameL = buildGitArgs({ ...P, op: 'blame', path: 'a.txt', lines: '10,20' });
  const remote = buildGitArgs({ ...P, op: 'remote' });
  const tag = buildGitArgs({ ...P, op: 'tag' });
  const ALL = [status, diff0, diffS, diffR, diffP, log, br, show, blame, remote, tag];

  check('A11 每条命令都带 core.quotepath=false（否则中文路径被转义成 \\344\\270\\255）',
    ALL.every((a) => a.includes('core.quotepath=false')));
  check('A12 每条命令都带 color.ui=false（用户若开了强制着色，ANSI 码会毁掉解析）',
    ALL.every((a) => a.includes('color.ui=false')));
  // 断言的是"命令是一串**独立 token**、不是一条拼好的字符串"——argv 形式本身就让 shell 无从介入。
  // 刻意**不**查 `|`：它不过 shell、不是管道，只可能在 git 的 --format 里当字段分隔（现已改用 US）。
  const SHELL_META = ['&&', ';', '$(', '`'];
  check('A13 argv 里没有任何 shell 拼接（&& / ; / $( ) / 反引号）—— 命令是 token 数组，不是一条字符串',
    ALL.every((a) => a.every((s) => !SHELL_META.some((m) => s.includes(m)))));

  check('A14 show 用 --format=<SHOW_FORMAT> + --numstat，且**不带** -p（只给文件级增删，不把 diff 正文塞给模型）',
    show.includes(`--format=${SHOW_FORMAT}`) && show.includes('--numstat') && !show.includes('-p'));
  check('A15 show 的 target 留空 / worktree 都当 HEAD（spec 默认是空串，git 自己的默认在这里补上）',
    show[show.length - 1] === 'HEAD'
    && buildGitArgs({ ...P, op: 'show', target: 'worktree' }).at(-1) === 'HEAD');
  check('A16 show 带 path 时 ref 落在 `--` **之前**（git 的语义是 `show <ref> -- <path>`）',
    (() => { const d = showP.indexOf('--'); return d > 0 && showP[d - 1] === 'HEAD~1' && showP[d + 1] === 'src/x'; })(),
    JSON.stringify(showP));
  check('A17 blame 用 --line-porcelain（要结构化字段；默认的逐行格式是给人看的）',
    blame.includes('--line-porcelain'));
  check('A18 blame 的路径一定落在 `--` 之后（否则会被当成版本引用）',
    (() => { const d = blame.indexOf('--'); return d > 0 && blame[d + 1] === 'a.txt'; })(), JSON.stringify(blame));
  check('A19 blame 不给 lines 就不带 `-L`；给了就紧跟其后，且**单个数字展开成 `N,N`**'
    + '（git 的 `-L 10` 意思是"10 到末尾"，不展开就会悄悄多给一大段）',
    !blame.includes('-L') && (() => { const i = blameL.indexOf('-L'); return i > 0 && blameL[i + 1] === '10,20'; })()
    && (() => {
      const a = buildGitArgs({ ...P, op: 'blame', path: 'a.txt', lines: '5' });
      const i = a.indexOf('-L');
      return i > 0 && a[i + 1] === '5,5';
    })());
  check('A20 remote 只跑 `-v` 那一份（它是"名字 + URL"的超集，不必再跑一次裸 remote）',
    remote.includes('remote') && remote.includes('-v'));
  check('A21 tag 用 --list --format=<TAG_FORMAT>（ref-filter 语言，同样用 US 分隔）',
    tag.includes('tag') && tag.includes('--list') && tag.includes(`--format=${TAG_FORMAT}`)
    && TAG_FORMAT.includes('\u001f'));

  check('A22 八个 op 都能构造出命令（白名单被完整覆盖，且恰好八个）',
    GIT_OPS.every((op) => buildGitArgs({ ...P, op }).length > 0) && GIT_OPS.length === 8);
}

/* ── ② 安全闸 ── */
console.log('── ② 安全闸：target 不能被当成 git 选项 ──');

check('B1 target 留空放行', validateTarget('') === null);
check('B2 target=worktree 放行', validateTarget('worktree') === null);
check('B3 target=staged 放行', validateTarget('staged') === null);
check('B4 target=HEAD~1 放行', validateTarget('HEAD~1') === null);
check('B5 target=main 放行', validateTarget('main') === null);
check('B6 **target 以 - 开头必须拒**（--output=文件 能把结果写进磁盘）',
  validateTarget('--output=C:/Windows/Temp/x') !== null, String(validateTarget('--output=C:/Windows/Temp/x')));
check('B7 拒绝文案要点出"选项 vs 版本引用"这个区别，并给正确写法',
  (validateTarget('-x') ?? '').includes('选项') && (validateTarget('-x') ?? '').includes('HEAD~1'));
check('B8 target 含空白拒（不像一个 ref）', validateTarget('main extra') !== null);
check('B9 target 含不可见字符拒', validateTarget('main\u001f') !== null);

check('B10 limit 夹进 1..50：0 → 1', normalizeLimit(0) === 1);
check('B11 limit 负数 → 1', normalizeLimit(-5) === 1);
check('B12 limit 超上限 → 50', normalizeLimit(999) === LOG_LIMIT_MAX);
check('B13 limit 合法值原样', normalizeLimit(20) === 20);
check('B14 limit 非数字 → 退回默认 10', normalizeLimit(Number.NaN) === 10);

/* ── ③ status 解析 ── */
console.log('── ③ status 解析（喂探针实测字节） ──');

const st = parseStatus(S_STATUS_FULL);
check('C1 分支名与上游解析出来', st.branch === 'main' && st.upstream === 'origin/main', `${st.branch}/${st.upstream}`);
check('C2 领先/落后从 `[ahead 2, behind 1]` 读出数字', st.ahead === 2 && st.behind === 1, `${st.ahead}/${st.behind}`);
check('C3 条目数正确（重命名占两段，但仍算**一条**）', st.entries.length === 4, String(st.entries.length));
check('C4 重命名：新路径在前、旧路径从**下一段**取',
  st.entries[2]?.path === 'new.txt' && st.entries[2]?.orig === 'old.txt',
  JSON.stringify(st.entries[2]));
check('C5 中文+空格的路径**原样裸出**（-z 下没有引号，这是选 -z 的理由）',
  st.entries[3]?.path === '中文 文件.txt', JSON.stringify(st.entries[3]?.path));
check('C6 已暂存修改的码是 `M `（首字母在暂存区列）', st.entries[0]?.xy === 'M ', JSON.stringify(st.entries[0]?.xy));
check('C7 未暂存修改的码是 ` M`（首字母是空格）', st.entries[1]?.xy === ' M', JSON.stringify(st.entries[1]?.xy));

const clean = parseStatus(S_STATUS_CLEAN);
check('C8 干净仓库：只有头行，零条目', clean.branch === 'main' && clean.entries.length === 0);

const unborn = parseStatus(S_STATUS_UNBORN);
check('C9 空仓库头行 `No commits yet on X` → unborn 且认出分支名',
  unborn.unborn && unborn.branch === 'main', `${unborn.unborn}/${unborn.branch}`);
check('C10 旧版 git 的 `Initial commit on X` 也认（容错，不是猜）',
  parseStatus(S_STATUS_UNBORN_OLD).unborn);

const detached = parseStatus(S_STATUS_DETACHED);
check('C11 `HEAD (no branch)` → detached', detached.detached);
check('C12 detached 时头行之后**还有条目**（不因无分支名就把文件吞掉）',
  detached.entries.length === 1 && detached.entries[0]?.path === 'new.txt');
check('C13 没有头行时不会把文件段误当头行吞掉（防御性）',
  parseStatus('?? a.txt\u0000').entries.length === 1);

/* ── ④ 状态码译码 ── */
console.log('── ④ 状态码译码（XY 两字母 → 人话） ──');

check('D1 `M ` → 已暂存：修改', statusCodeLabel('M ') === '已暂存：修改', statusCodeLabel('M '));
check('D2 ` M` → 未暂存：修改', statusCodeLabel(' M') === '未暂存：修改');
check('D3 `MM` → 两处都有', statusCodeLabel('MM') === '已暂存+未暂存：修改');
check('D4 `A ` → 已暂存：新增', statusCodeLabel('A ') === '已暂存：新增');
check('D5 `??` → 未跟踪', statusCodeLabel('??') === '未跟踪');
check('D6 `R ` → 已暂存：重命名', statusCodeLabel('R ') === '已暂存：重命名');
check('D7 `UU` → 冲突', statusCodeLabel('UU').includes('冲突'));
check('D8 `AA`/`DD` 也算冲突（both added / both deleted，别读成"新增"）',
  statusCodeLabel('AA').includes('冲突') && statusCodeLabel('DD').includes('冲突'));

/* ── ⑤ diff 解析与渲染 ── */
console.log('── ⑤ diff 解析与渲染 ──');

const nf = parseNumstat(S_NUMSTAT);
check('E1 普通行：增/删/路径', nf[0]?.added === 1 && nf[0]?.deleted === 0 && nf[0]?.path === 'a.txt');
check('E2 删多于增的行', nf[1]?.added === 0 && nf[1]?.deleted === 1);
check('E3 重命名行**不拆**成结构（拆了就得猜 git 的缩写规则），路径原样保留',
  nf[2]?.path === 'old.txt => new.txt', JSON.stringify(nf[2]?.path));
check('E4 二进制行：`-` 不是数字 → added/deleted 为 null + binary 标记',
  nf[3]?.binary === true && nf[3]?.added === null && nf[3]?.deleted === null);
check('E5 子目录路径与 CRLF 行尾都能处理',
  nf[4]?.path === 'sub/dir/c.ts' && !nf[4]?.path.includes('\r'), JSON.stringify(nf[4]?.path));
check('E6 空输出 → 空数组（不抛错）', parseNumstat('').length === 0);

const rd = renderDiff(nf, 'worktree', '', false);
check('E7 渲染自算汇总（不抄 git 的英文摘要行）：5 个文件、+4 −3、1 个二进制',
  rd.includes('5 个文件') && rd.includes('+4') && rd.includes('−3') && rd.includes('1 个二进制'), rd.split('\n')[1]);
check('E8 二进制文件单独一行，不假装是 +0 −0', rd.includes('二进制  img.png'));
check('E9 worktree diff 末尾提示"未跟踪的新文件不在 diff 里"（高频误读）',
  rd.includes('未跟踪的新文件不会出现在 diff 里'), rd.slice(-60));
check('E10 staged diff 不加那条提示（那条只对 worktree 成立）',
  !renderDiff(nf, 'staged', '', false).includes('未跟踪的新文件'));
check('E11 无差异时说清是哪两个状态在比',
  renderDiff([], 'worktree', '', false).includes('工作区 vs 已暂存'));
check('E12 限定路径时把路径写进说明（否则模型以为看的是全仓库）',
  renderDiff([], 'worktree', 'src/tools', false).includes('src/tools'));
check('E13 超过上限时说明被截断', renderDiff(nf, 'worktree', '', true).includes('只列了前'));

/* ── ⑥ log 解析与渲染 ── */
console.log('── ⑥ log 解析与渲染 ──');

const le = parseLog(S_LOG);
check('F1 两条提交都解析出来', le.length === 2, String(le.length));
check('F2 四段齐全（hash/日期/作者/主题）',
  le[0]?.hash === '9de747b' && le[0]?.date === '2026-09-14' && le[0]?.author === 'Tester'
  && le[0]?.subject === 'second commit', JSON.stringify(le[0]));
check('F3 顺序与 git 输出一致（新在前）', le[0]?.subject === 'second commit' && le[1]?.subject === 'first commit');
check('F4 subject 里含 `|` 和 tab 也不破（这正是用 US/RS 而不是 `|` 的原因）',
  parseLog(S_LOG_PIPES)[0]?.subject === 'fix: a|b\tc', JSON.stringify(parseLog(S_LOG_PIPES)[0]?.subject));
check('F5 空输出 → 空数组', parseLog('').length === 0);
check('F6 字段不足的残段被跳过而不是造出一条半截记录', parseLog('abc\u001f2026-01-01\u001e').length === 0);

check('F7 无提交时的文案说"还没有任何提交"（不是"无匹配"也不是静默空串）',
  renderLog([], 10).includes('还没有任何提交'));
check('F8 有条目时把取几条写出来', renderLog(le, 10).includes('最近 2 条'));
check('F9 条目渲染含 hash/日期/作者/主题',
  renderLog(le, 10).includes('9de747b') && renderLog(le, 10).includes('second commit'));

/* ── ⑦ branch 解析与渲染 ── */
console.log('── ⑦ branch 解析与渲染（US 分隔） ──');

const be = parseBranch(S_BRANCH);
check('G1 两个分支都解析出来', be.length === 2, String(be.length));
check('G2 `*` 标记当前分支', be[0]?.current === true && be[1]?.current === false);
check('G3 上游与跟踪串原样保留（`[ahead 1]` 不二次解析）',
  be[0]?.upstream === 'origin/main' && be[0]?.track === '[ahead 1]', JSON.stringify(be[0]));
check('G4 没上游的分支不编造 upstream', be[1]?.upstream === null && be[1]?.track === '');
check('G5 detached 时的伪分支名照原样呈现（不假装它是个真分支）',
  parseBranch(S_BRANCH_DETACHED)[0]?.name === '(HEAD detached at 3b70939)');
check('G6 空输出 → 空数组，渲染时明说"一个分支都还没有"',
  parseBranch('').length === 0 && renderBranch([]).includes('一个分支都还没有'));
check('G7 渲染带 `*` 标记提示', renderBranch(be).includes('*') && renderBranch(be).includes('* 表示当前所在'));
check('G8 分支名里带 `|` 也不串位（`|` 在 refname 里是合法字符 —— 这就是分隔符从 `|` 换成 US 的理由）',
  (() => {
    const a = parseBranch(S_BRANCH_PIPE)[0];
    return a?.name === 'feat|a' && a.upstream === 'origin/feat|a' && a.track === '[ahead 1]';
  })(),
  JSON.stringify(parseBranch(S_BRANCH_PIPE)[0]));

/* ── ⑧ show 解析与渲染 ── */
console.log('── ⑧ show 解析与渲染 ──');

const sh0 = parseShow(S_SHOW);
// 用"空壳兜底"而不是 `!`：解析真坏了也让后面的断言**可见地红**，而不是抛异常把整段掐掉
const sh = sh0 ?? { short: '', date: '', author: '', subject: '', files: [] as ReturnType<typeof parseNumstat> };

check('M1 提交头四段解析出来（短 hash / 日期 / 作者 / 主题）',
  sh0 !== null && sh.short === '0cf62bd' && sh.date === '2026-09-15' && sh.author === 'Probe'
  && sh.subject === '第二提交：改 a 并加 b | 竖线也要有', JSON.stringify(sh0));
check('M2 主题里的 `|` 不破（用 US/RS 而不是 `|` 分隔的理由与 log 完全相同）',
  sh.subject.includes('|'), sh.subject);
check('M3 RS 之后整块交给 numstat：两个文件、增删行数都对',
  sh.files.length === 2 && sh.files[0]?.path === 'a.txt' && sh.files[0]?.added === 2
  && sh.files[1]?.added === 1 && sh.files[1]?.deleted === 0, JSON.stringify(sh.files));
check('M4 没有改动的提交（只剩格式块 + 那个空行）→ files 为空数组，不抛错',
  parseShow(S_SHOW_EMPTY)?.files.length === 0);
check('M5 形态不对（空输出 / 别的东西）→ 返回 null，让工具层去报，而不是编一条半截记录',
  parseShow('') === null && parseShow('有些别的东西\n') === null);
check('M6 渲染含 `[提交]` 与 `[改动]` 两行抬头 + 短 hash + 文件汇总（与 diff 同一套口径）',
  renderShow(sh, '', false).includes('[提交]') && renderShow(sh, '', false).includes('0cf62bd')
  && renderShow(sh, '', false).includes('[改动]') && renderShow(sh, '', false).includes('2 个文件'),
  renderShow(sh, '', false).slice(0, 90));
check('M7 限定了路径时说清"只统计那个文件"（否则模型以为看的是整个提交）',
  renderShow(sh, 'a.txt', false).includes('只统计 a.txt'), renderShow(sh, 'a.txt', false).slice(0, 90));
check('M8 空改动的提交不假装"没有差异"就完事，把"合并提交的 numstat 是合并差异"这条口径讲出来',
  renderShow({ short: 'x', date: 'd', author: 'a', subject: 's', files: [] }, '', false).includes('合并差异'),
  renderShow({ short: 'x', date: 'd', author: 'a', subject: 's', files: [] }, '', false).slice(0, 120));

/* ── ⑨ blame 解析与渲染 ── */
console.log('── ⑨ blame 解析与渲染 ──');

const bl = parseBlame(S_BLAME);
check('N1 三行都解出来，行号取的是**当前行号**（表头第 3 个字段，不是第 2 个）',
  bl.length === 3 && bl.map((l) => l.line).join(',') === '1,2,3', JSON.stringify(bl.map((l) => l.line)));
check('N2 内容行去掉打头的 tab 后原样保留（含中文）',
  bl[1]?.content === 'line2 改了' && bl[2]?.content === '未提交的一行', JSON.stringify(bl[2]?.content));
check('N3 作者与提交主题挂到行上（模型据此知道"这行是哪次改动留下的"）',
  bl[1]?.author === 'Probe' && bl[1]?.summary === '第二提交：改 a 并加 b', JSON.stringify(bl[1]));
check('N4 日期是拿 author-time + author-tz **自己算**的（porcelain 不给现成日期）',
  bl[0]?.date === '2026-09-15', bl[0]?.date);
// 时区不能丢：同一个 epoch，+0800 已跨到次日、-0500 仍在当日；按 UTC 算两者都会给 2026-09-15
check('N5 **时区参与计算**：epoch 1789502400 在 +0800 是 2026-09-16、在 -0500 是 2026-09-15',
  formatEpochDate('1789502400', '+0800') === '2026-09-16'
  && formatEpochDate('1789502400', '-0500') === '2026-09-15',
  `${formatEpochDate('1789502400', '+0800')} / ${formatEpochDate('1789502400', '-0500')}`);
check('N6 时间戳缺失 / 不是数字时不编日期（宁可空着，也不造一个 1970-01-01）',
  formatEpochDate('', '+0800') === '' && formatEpochDate('abc', '+0800') === '');
check('N7 未提交的行认出来（hash 全 0，且 author 是 git 自己写的 Not Committed Yet）',
  bl[2]?.uncommitted === true && bl[0]?.uncommitted === false);
check('N8 boundary / previous / filename / committer* 这些键不污染结果',
  bl.every((l) => l.author === 'Not Committed Yet' || l.author === 'Probe')
  && bl.every((l) => !l.summary.includes('committer')));
check('N9 空输出 → 空数组（不抛错）', parseBlame('').length === 0);
const grpRun = groupBlame(parseBlame(S_BLAME_RUN));
check('N10 连续同提交合并成一段（两行同 hash 相邻 → L1-2，且两行内容都在）',
  grpRun.length === 2 && grpRun[0]?.start === 1 && grpRun[0]?.end === 2
  && grpRun[0]?.lines.length === 2 && grpRun[1]?.start === 3,
  JSON.stringify(grpRun.map((g) => [g.start, g.end])));
check('N11 **不连续**的同 hash 不合并（合并了行号区间就在撒谎）',
  groupBlame(bl).length === 3, String(groupBlame(bl).length));
const rbl = renderBlame('a.txt', bl, bl.length, bl.length);
check('N12 渲染抬头带文件，每段一行归属、内容缩进在下面',
  rbl.includes('[责任] a.txt') && rbl.includes('L1') && rbl.includes('bd16c08') && rbl.includes('│ line1'),
  rbl.slice(0, 120));
check('N13 未提交那段不报 hash，明说"工作区里还没进任何提交的改动"',
  rbl.includes('未提交') && rbl.includes('还没进任何提交'), rbl.slice(-120));
check('N14 被截断时说明"只显示了前 N 行"，并给出 `lines` 这个出路',
  renderBlame('a.txt', bl, 99, 3).includes('只显示了前 3 行') && renderBlame('a.txt', bl, 99, 3).includes('lines'));
check('N15 一行都追不到时明说，不返回空串（空的输出会让模型以为文件是空的）',
  renderBlame('a.txt', [], 0, 0).includes('没有可追责的行'));

/* ── ⑩ remote 解析与渲染 ── */
console.log('── ⑩ remote 解析与渲染 ──');

const rmo = parseRemote(S_REMOTE);
check('O1 tab 分隔的两行合成一个远端（fetch 与 push 同址）',
  rmo.length === 1 && rmo[0]?.name === 'origin' && rmo[0]?.fetch === 'https://example.com/repo.git'
  && rmo[0]?.push === rmo[0]?.fetch, JSON.stringify(rmo));
const rmo2 = parseRemote(S_REMOTE_TWO);
check('O2 两个远端各成一条；fetch / push 不同址时两边都留着（https 读 + ssh 写是常见配法）',
  rmo2.length === 2 && rmo2[0]?.push === 'git@example.com:repo.git' && rmo2[1]?.name === 'upstream',
  JSON.stringify(rmo2));
check('O3 **URL 里的凭据被打码**（`user:token@` → `***@`），主机与路径原样不动',
  parseRemote(S_REMOTE_CRED)[0]?.fetch === 'https://***@example.com/repo.git',
  JSON.stringify(parseRemote(S_REMOTE_CRED)[0]));
check('O4 没有凭据的 URL 原样返回（不做无谓改写：`git@host:path` 那种不是 URL 形式也别动它）',
  redactUrl('https://example.com/x.git') === 'https://example.com/x.git'
  && redactUrl('git@github.com:a/b.git') === 'git@github.com:a/b.git');
check('O5 空输出 → 空数组，渲染时明说"一个远端都没配"并给出路（bash 加远端）',
  parseRemote('').length === 0 && renderRemote([]).includes('一个远端都没配')
  && renderRemote([]).includes('bash'));
check('O6 同址渲染合成一条；不同址时 fetch / push 分两行写清',
  renderRemote(rmo).includes('同址') && renderRemote(rmo2).includes('fetch:')
  && renderRemote(rmo2).includes('push:'));

/* ── ⑪ tag 解析与渲染 ── */
console.log('── ⑪ tag 解析与渲染 ──');

const tge = parseTag(S_TAG);
check('P1 两个标签都解出来（名字 / 对象类型 / 日期 / 说明）',
  tge.length === 2 && tge[0]?.name === 'v1.0.0' && tge[0]?.type === 'commit'
  && tge[1]?.type === 'tag' && tge[1]?.subject === '带说明的标签', JSON.stringify(tge));
check('P2 标签说明里的 `|` 不破（同一个理由：字段分隔用 US）',
  parseTag(S_TAG_PIPE)[0]?.subject === '第二提交：改 a 并加 b | 竖线也要有',
  JSON.stringify(parseTag(S_TAG_PIPE)[0]?.subject));
check('P3 objecttype 译成人话：commit=轻量 / tag=附注；别的类型原样报出来，不编',
  tagTypeLabel('commit') === '轻量' && tagTypeLabel('tag') === '附注'
  && tagTypeLabel('tree') === 'tree' && tagTypeLabel('') === '未知');
check('P4 空输出 → 空数组，渲染时明说"一个标签都没有"并指路 bash（打标签是写操作）',
  parseTag('').length === 0 && renderTag([]).includes('一个标签都没有') && renderTag([]).includes('bash'));
check('P5 渲染把类型与说明都带出来',
  renderTag(tge).includes('轻量') && renderTag(tge).includes('附注') && renderTag(tge).includes('带说明的标签'));

/* ── ⑫ 行范围白名单 ── */
console.log('── ⑫ 行范围白名单（blame 的 lines） ──');

check('Q1 留空放行（= 整份文件）', validateLineRange('') === null);
check('Q2 单个行号放行', validateLineRange('10') === null);
check('Q3 「起,止」放行', validateLineRange('10,20') === null);
check('Q4 夹带别的一律拒——这是**白名单**，不是"把危险部分过滤掉"',
  validateLineRange('10; rm -rf /') !== null && validateLineRange('10,20|x') !== null
  && validateLineRange('a') !== null && validateLineRange('-1') !== null
  && validateLineRange('10,') !== null, String(validateLineRange('10,20|x')));
check('Q5 拒绝文案给出两种合法写法并指路 bash（git 那套宽 `-L` 语法刻意不在这里开口子）',
  (validateLineRange('/x/') ?? '').includes('bash') && (validateLineRange('/x/') ?? '').includes('10,20'));
check('Q6 归一化：单个数字展开成 `N,N`（git 的 `-L 10` 是"10 到末尾"，不展开就多给一段）、区间原样、空串回空串',
  normalizeLineRange('5') === '5,5' && normalizeLineRange('10,20') === '10,20' && normalizeLineRange('') === ''
  && normalizeLineRange(' 7 ') === '7,7', normalizeLineRange('5'));

/* ── ⑬ 行为：真仓库端到端 ── */
console.log('── ⑬ 行为：真 git 仓库端到端 ──');

let hasGit = true;
try {
  execFileSync('git', ['--version'], { encoding: 'utf-8', windowsHide: true, stdio: 'pipe' });
} catch {
  hasGit = false;
}

if (!hasGit) {
  console.log('  ⚠️  本机没有可用的 git —— ⑧ 段走占位断言（项数不变，但不构成真实验证）');
  for (let i = 1; i <= 31; i++) check(`H${i} （占位：本机无 git，未能验证）`, true);
} else {
  const cwd0 = process.cwd();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-vgit-'));
  const g = (...a: string[]): string =>
    execFileSync('git', a, { cwd: repo, encoding: 'utf-8', windowsHide: true });
  try {
    g('init', '-q');
    g('symbolic-ref', 'HEAD', 'refs/heads/main');   // 不依赖用户 init.defaultBranch 配置
    g('config', 'user.email', 'v@t.t');
    g('config', 'user.name', 'Verifier');
    g('config', 'commit.gpgsign', 'false');          // 用户若开了强制签名，提交会失败
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(repo, '中文.txt'), 'cn\n');
    g('add', '-A');
    g('commit', '-qm', 'first commit');

    // 未跟踪的新文件 + 已跟踪文件的未暂存改动
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'brand-new.txt'), 'n\n');

    process.chdir(repo);
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), new EventStore());

    {
      const r = await reg.execute('git', { op: 'status' });
      check('H1 status 跑通且 [OK]', r.status === 'ok', r.content.slice(0, 90));
      check('H2 报出当前分支', r.content.includes('main'));
      check('H3 报出未暂存的改动', r.content.includes('a.txt') && r.content.includes('未暂存：修改'), r.content);
      check('H4 报出未跟踪的新文件（含中文名路径）',
        r.content.includes('brand-new.txt') && r.content.includes('未跟踪'));
      check('H5 没有上游分支时明说（不编造 origin/xxx）', r.content.includes('没有上游分支'));
    }

    {
      const r = await reg.execute('git', { op: 'diff' });
      check('H6 diff 跑通且报出改动行数', r.status === 'ok' && r.content.includes('a.txt') && r.content.includes('+1'));
      check('H7 **未跟踪的新文件不在 diff 里**，且工具主动提示这一点（高频误读）',
        !r.content.includes('brand-new.txt') && r.content.includes('未跟踪的新文件不会出现在 diff 里'), r.content);
    }

    {
      const r = await reg.execute('git', { op: 'diff', target: 'staged' });
      check('H8 staged diff 与 worktree diff 口径不同（此刻暂存区是空的）',
        r.status === 'ok' && r.content.includes('没有差异'), r.content.slice(0, 90));
    }

    {
      const r = await reg.execute('git', { op: 'diff', path: 'a.txt' });
      check('H9 path 限定生效（只看得到 a.txt）',
        r.status === 'ok' && r.content.includes('a.txt') && r.content.includes('限定路径'), r.content.slice(0, 110));
    }

    {
      const r = await reg.execute('git', { op: 'log' });
      check('H10 log 跑通、含提交信息与 hash 形状',
        r.status === 'ok' && r.content.includes('first commit') && /[0-9a-f]{7}/.test(r.content), r.content.slice(0, 110));
    }

    {
      const r = await reg.execute('git', { op: 'branch' });
      check('H11 branch 跑通并标出当前分支',
        r.status === 'ok' && r.content.includes('main') && r.content.includes('*'), r.content.slice(0, 110));
    }

    {
      // 从子目录跑：路径仍是**仓库根相对**（这一步钉住路径语义，免得模型拼错路径猜半天）
      fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
      process.chdir(path.join(repo, 'sub'));
      const r = await reg.execute('git', { op: 'status' });
      check('H12 子目录里跑 status 仍然正常（路径是仓库根相对）',
        r.status === 'ok' && r.content.includes('a.txt'), r.content.slice(0, 110));
      process.chdir(repo);
    }

    /* ── 第二批四个 op：真仓库里各跑一遍 ── */

    {
      const r = await reg.execute('git', { op: 'tag' });
      check('H13 还没打过标签时 tag → [OK] 且明说"一个标签都没有"并给出去路（不是一片空白）',
        r.status === 'ok' && r.content.includes('一个标签都没有') && r.content.includes('bash'),
        r.content.slice(0, 110));
    }

    {
      // 轻量与附注各来一个：objecttype 分别是 commit / tag，渲染要把这个区别讲出来
      execFileSync('git', ['tag', 'v1.0.0'], { cwd: repo, encoding: 'utf-8', windowsHide: true });
      execFileSync('git', ['tag', '-a', 'v1.1.0', '-m', '带说明的标签'],
        { cwd: repo, encoding: 'utf-8', windowsHide: true });
      const r = await reg.execute('git', { op: 'tag' });
      check('H14 轻量标签与附注标签都列出来并标出类型（objecttype 的 commit / tag 都认）',
        r.status === 'ok' && r.content.includes('v1.0.0') && r.content.includes('v1.1.0')
        && r.content.includes('轻量') && r.content.includes('附注'), r.content.slice(0, 160));
      check('H15 附注标签的说明第一行被带出来（模型据此知道这是个什么版本）',
        r.content.includes('带说明的标签'), r.content.slice(0, 160));
    }

    {
      const r = await reg.execute('git', { op: 'remote' });
      check('H16 没配远端时 remote → [OK] 且明说"一个远端都没配"（空输出不该渲染成空壳）',
        r.status === 'ok' && r.content.includes('一个远端都没配'), r.content.slice(0, 110));
    }

    {
      execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/repo.git'],
        { cwd: repo, encoding: 'utf-8', windowsHide: true });
      const r = await reg.execute('git', { op: 'remote' });
      check('H17 配了远端就列出来，且 fetch/push 同址时**合成一条**（省上下文）',
        r.status === 'ok' && r.content.includes('origin') && r.content.includes('example.com/repo.git')
        && r.content.includes('同址'), r.content.slice(0, 160));
    }

    {
      // 凭据必须打码 —— 这是唯一一处"看着只读、却可能把秘密读进模型上下文"的口子
      execFileSync('git', ['remote', 'set-url', 'origin', 'https://alice:ghp_SUPERSECRET@example.com/repo.git'],
        { cwd: repo, encoding: 'utf-8', windowsHide: true });
      const r = await reg.execute('git', { op: 'remote' });
      check('H18 **远端 URL 里的凭据被打码**（原样进上下文就是一次不可撤回的外泄）',
        r.status === 'ok' && !r.content.includes('ghp_SUPERSECRET') && r.content.includes('***@'),
        r.content.slice(0, 160));
    }

    {
      const r = await reg.execute('git', { op: 'show' });
      check('H19 show 报出提交元信息（短 hash / 日期 / 作者 / 主题，且**不**把 40 位全文塞进来）',
        r.status === 'ok' && r.content.includes('first commit') && r.content.includes('[提交]')
        && !/[0-9a-f]{40}/.test(r.content), r.content.slice(0, 160));
      check('H20 show 也给出文件级改动（与 diff 同一套 numstat 口径，不抄 git 的英文摘要）',
        r.content.includes('a.txt') && r.content.includes('[改动]'), r.content.slice(0, 160));
    }

    {
      const r = await reg.execute('git', { op: 'show', path: 'a.txt' });
      check('H21 show 带 path 时只统计那个文件（限定路径的说明要写出来）',
        r.status === 'ok' && r.content.includes('只统计'), r.content.slice(0, 160));
    }

    {
      const r = await reg.execute('git', { op: 'blame', path: 'a.txt' });
      check('H22 blame 报出逐行归属（含短 hash 与作者，行号以 L 打头）',
        r.status === 'ok' && r.content.includes('L1') && r.content.includes('Verifier')
        && /[0-9a-f]{7}/.test(r.content), r.content.slice(0, 200));
    }

    {
      const r = await reg.execute('git', { op: 'blame', path: 'a.txt', lines: '1' });
      check('H23 blame + lines 真的缩了范围（只出现 L1，没有 L2）',
        r.status === 'ok' && r.content.includes('L1') && !r.content.includes('L2'),
        r.content.slice(0, 200));
    }

    {
      const r = await reg.execute('git', { op: 'blame', path: 'no-such-file.txt' });
      check('H24 blame 一个不存在的路径 → [ERROR]，且文案点出"可能还没被 git 跟踪"（不是干巴巴一句 fatal）',
        r.status === 'error' && r.content.includes('跟踪'), `${r.status} ${r.content.slice(0, 160)}`);
    }

    {
      const r = await reg.execute('git', { op: 'show', target: 'no-such-ref' });
      check('H25 show 一个不存在的 ref → [ERROR]（不静默返 [OK] 空壳）',
        r.status === 'error', `${r.status} ${r.content.slice(0, 160)}`);
    }

    {
      // 空仓库：show 也该说清"还没有提交 / 这个 ref 不存在"，而不是抛个原始 fatal
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-vgit-e2-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: empty, encoding: 'utf-8', windowsHide: true });
        process.chdir(empty);
        const reg2 = new ToolRegistry();
        registerBuiltinTools(reg2, new TaskStore(), new MemoryStore(), new EventStore());
        const r = await reg2.execute('git', { op: 'show' });
        check('H26 空仓库 show → [ERROR] 且说明"还没有任何提交或这个引用不存在"',
          r.status === 'error' && (r.content.includes('还没有任何提交') || r.content.includes('不存在')),
          `${r.status} ${r.content.slice(0, 140)}`);
        const r2 = await reg2.execute('git', { op: 'remote' });
        const r3 = await reg2.execute('git', { op: 'tag' });
        check('H27 空仓库 remote / tag → [OK] 且都是"一个都没有"（空输出不是故障）',
          r2.status === 'ok' && r2.content.includes('一个远端都没配')
          && r3.status === 'ok' && r3.content.includes('一个标签都没有'), r2.content.slice(0, 80));
      } finally {
        process.chdir(repo);
        fs.rmSync(empty, { recursive: true, force: true });
      }
    }

    {
      // 空仓库：log 以 128 退出，但这不是故障
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-vgit-e-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: empty, encoding: 'utf-8', windowsHide: true });
        process.chdir(empty);
        const reg2 = new ToolRegistry();
        registerBuiltinTools(reg2, new TaskStore(), new MemoryStore(), new EventStore());
        const r = await reg2.execute('git', { op: 'log' });
        check('H28 空仓库 log → [OK] 且说明"还没有任何提交"（128 退出不是故障）',
          r.status === 'ok' && r.content.includes('还没有任何提交'), `${r.status} ${r.content.slice(0, 80)}`);
        const r2 = await reg2.execute('git', { op: 'branch' });
        check('H29 空仓库 branch → 说明一个分支都还没有', r2.status === 'ok' && r2.content.includes('一个分支都还没有'));
      } finally {
        process.chdir(repo);
        fs.rmSync(empty, { recursive: true, force: true });
      }
    }

    {
      // 非仓库目录：报错要能看懂，且**明确说不会替你 init**
      const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-vgit-n-'));
      try {
        process.chdir(notRepo);
        const reg3 = new ToolRegistry();
        registerBuiltinTools(reg3, new TaskStore(), new MemoryStore(), new EventStore());
        const r = await reg3.execute('git', { op: 'status' });
        check('H30 非仓库目录 → [ERROR] 且说明"不是 git 仓库"（计失败，不会静默放过）',
          r.status === 'error' && r.content.includes('不是 git 仓库'), `${r.status} ${r.content.slice(0, 90)}`);
        check('H31 报错文案明说不会替用户 git init（边界清晰）', r.content.includes('git init'));
      } finally {
        process.chdir(repo);
        fs.rmSync(notRepo, { recursive: true, force: true });
      }
    }
  } finally {
    process.chdir(cwd0);
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

/* ── ⑭ 拒绝路径 ── */
console.log('── ⑭ 拒绝路径 ──');

{
  const reg = new ToolRegistry();
  registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), new EventStore());

  const r1 = await reg.execute('git', { op: 'commit' });
  check('I1 未知 op（如 commit）→ [INVALID]，并列出可用 op',
    r1.status === 'invalid' && r1.content.includes('status') && r1.content.includes('branch'), r1.content.slice(0, 90));

  const r2 = await reg.execute('git', { op: 'diff', target: '--output=x.txt' });
  check('I2 危险 target → [INVALID]（**在起 git 进程之前**就拦下）',
    r2.status === 'invalid' && r2.content.includes('选项'), r2.content.slice(0, 110));

  const r3 = await reg.execute('git', { op: 'status', extra: 'x' });
  check('I3 未知参数被 spec 拦下 → [INVALID]，并列出可用参数名',
    r3.status === 'invalid' && r3.content.includes('未知参数') && r3.content.includes('op'), r3.content.slice(0, 110));

  const r4 = await reg.execute('git', { op: 'log', limit: 0 });
  check('I4 limit=0 被 spec 判为非正整数 → [INVALID]（不是静默变成 1 条）',
    r4.status === 'invalid', r4.content.slice(0, 90));

  const r5 = await reg.execute('git', {});
  check('I5 缺必填 op → [INVALID]', r5.status === 'invalid' && r5.content.includes('必填'));

  // ── 第二批的拒绝路径：show 的 ref 与 blame 的 path / lines 都落在 `--` 之前或必须成型 ──

  const r6 = await reg.execute('git', { op: 'show', target: '--output=x.txt' });
  check('I6 show 的 target 过同一道安全闸（`show <ref>` 里 ref 也在选项位置）',
    r6.status === 'invalid' && r6.content.includes('选项'), r6.content.slice(0, 110));

  const r7 = await reg.execute('git', { op: 'blame', target: '--output=x.txt', path: 'a.txt' });
  check('I7 blame 的 target 同理（换了 op 不等于换了危险面）',
    r7.status === 'invalid' && r7.content.includes('选项'), r7.content.slice(0, 110));

  const r8 = await reg.execute('git', { op: 'blame' });
  check('I8 blame 不给 path → [INVALID]，且说明"逐行追责得先有个文件"（spec 表达不了条件必填，落在 handler）',
    r8.status === 'invalid' && r8.content.includes('path'), r8.content.slice(0, 110));

  const r9 = await reg.execute('git', { op: 'blame', path: 'a.txt', lines: '10,20; rm -rf /' });
  check('I9 非法的 lines（夹带别的东西）→ [INVALID]（白名单只收纯数字范围）',
    r9.status === 'invalid' && r9.content.includes('lines'), r9.content.slice(0, 130));

  const r10 = await reg.execute('git', { op: 'blame', path: 'a.txt', lines: '/x/' });
  check('I10 git 那套宽 `-L` 语法（如 "/正则/"）刻意不在这里开口子 → [INVALID] 并指路 bash',
    r10.status === 'invalid' && r10.content.includes('bash'), r10.content.slice(0, 130));
}

/* ── ⑮ 源码守护 + 提示词交叉 ── */
console.log('── ⑮ 源码守护 + 提示词交叉 ──');

const gitSrc = fs.readFileSync(path.join(ROOT, 'src/git/git.ts'), 'utf8');
const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf8');
const coreSrc = fs.readFileSync(path.join(ROOT, 'src/context/sections/core-section.ts'), 'utf8');

/**
 * 抹掉注释再查。
 * 这是踩过的坑：git.ts 的注释里**举了** `execFileSync('git', argv)` 当用法示例，
 * 于是"文件里不该出现 execFileSync"这条断言会被自己的说明文字判红 —— 断言问的是
 * "**代码**调没调"，不是"文本里有没有这几个字母"。
 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * **先切出 git 工具那一段**，再在段内断言。
 *
 * 为什么不直接对整个 builtin.ts 用 `[\s\S]{0,N}?` 的窗口：那个窗口是个魔法数字，
 * 工具的实现一长就得跟着调（本批就因为 git 工具变长把 J5 判红了 —— 断言的意图是
 * "在这段代码里"，却写成了"在接下来 3000 个字符里"，**意图与手段分了家**）。
 * 切到下一个 `tools.register(` 为止，才是"这一段"。
 */
const gitToolSrc = (() => {
  const at = builtinSrc.indexOf("name: 'git',");
  if (at < 0) return '';
  const end = builtinSrc.indexOf('tools.register(', at);
  return builtinSrc.slice(at, end < 0 ? at + 8000 : end);
})();

check('J1 src/git/git.ts 零 import（纯函数模块，解析逻辑能脱离终端验）', !/^import /m.test(gitSrc));
check('J2 git.ts 不碰 fs / 不起子进程（跑命令的职责在工具层；先抹注释，免得被示例文字误伤）',
  !/node:(fs|child_process)/.test(stripComments(gitSrc))
  && !/\bexecFileSync\b/.test(stripComments(gitSrc)));
// ⚠ J3 的判据必须**先抹注释**：本段切片是"从 `name: 'git',` 到下一个 `tools.register(`"，
// 而 10.5.2 在两者之间插了一整段说明（里面就写着 `requirePermission: true`）——
// 不抹注释的话，判红的是**说明文字**而不是代码。这正是本仓记过六次的那个坑。
check('J3 只读的 git 工具**不**带 requirePermission（"看一眼"不该弹窗；要弹的是写侧那个工具）',
  /spec: \{/.test(gitToolSrc) && !stripComments(gitToolSrc).includes('requirePermission'));
check('J4 git 工具走 execFileSync（argv 数组，不经 shell）而非 execSync（命令字符串）',
  /execFileSync\('git'/.test(gitToolSrc) && !/execSync\(/.test(gitToolSrc));
check('J5 工具层复用既有 decodeChildOutput 做编码判别（不另起一套）',
  /decodeChildOutput\(raw\)/.test(gitToolSrc));
check('J6 提示词写明归档的"前后区别"要基于 git diff 或验证结果（事实来源纪律仍在）',
  coreSrc.includes('git diff 或验证结果'));
check('J7 提示词里"下一件事"的措辞指向了 git 工具（给了模型可执行的抓手，而不只是一条禁令）',
  /git 工具/.test(coreSrc), coreSrc.match(/.{0,40}git 工具.{0,40}/u)?.[0] ?? '（提示词里没提 git 工具）');
// 这条钉的是 2026-09-14 那个**错误假设**：把 log 的 `%x1f` 写进 branch/tag 的 ref-filter 格式里，
// branch 会**原样输出那五个字符**（不是报错，是静默给出一列垃圾字段）。现在两个格式都用 `${US}` 插值，
// 所以"代码里出现 `%x1f` 字面量"这件事本身就是回归信号。先用 stripComments 抹注释——
// 头注 ③ 里**举了** `%x1f` 当反例，不抹会把自己的说明文字判红（这是本仓第六次踩同一个坑）。
check('J8 格式常量只用 `${US}` 插值，代码里**不出现** `%x1f` 字面量（log 与 ref-filter 两套占位符不许混用）',
  !/%x1f/.test(stripComments(gitSrc)));
check('J9 远端 URL 一定经过 redactUrl —— 打码发生在**解析层**、在 URL 进入任何字符串之前',
  /\bredactUrl\(/.test(stripComments(gitSrc)));
check('J10 blame 的"必填 path"校验落在工具 handler（spec 表达不了条件必填，别指望 spec 兜住）',
  builtinSrc.includes('blame 必须指定 path') && builtinSrc.includes('validateLineRange('));

/* ── ⑯ 路由：bash 里的裸 git 只读命令 → git 工具（ROADMAP 10.5.6）── */
console.log('── ⑯ 路由：bash 里的 git 只读命令 → git 工具 ──');

/** 把路由结果压成可读串，断言里比字符串最直观 */
const fmtRoute = (r: unknown): string => (r === null ? 'null' : JSON.stringify(r));

/**
 * 七个"裸 op"——判据的正面清单。
 * 从 GIT_OPS 里排除 blame 是**刻意的**：裸 blame 不是合法 git 命令（它必须带文件），
 * 所以 blame 单独走 R3/R4 两条，不混在"裸形式全命中"这条里。
 */
const BARE_OPS: GitOp[] = ['status', 'diff', 'log', 'branch', 'show', 'remote', 'tag'];

check('R1 七个裸 op 全部命中，且 op 与子命令一致',
  BARE_OPS.every((op) => fmtRoute(routeGitRead(`git ${op}`)) === fmtRoute({ op })),
  BARE_OPS.map((op) => `${op}:${fmtRoute(routeGitRead(`git ${op}`))}`).join(' '));

check('R2 多余空白归一（"  git   status  " 仍路由到 status）',
  fmtRoute(routeGitRead('  git   status  ')) === fmtRoute({ op: 'status' }));

check('R3 blame 带单个路径 → 路由到 blame + path',
  fmtRoute(routeGitRead('git blame src/a.ts')) === fmtRoute({ op: 'blame', path: 'src/a.ts' }));

check('R4 裸 blame / blame 带选项 → 不路由（裸 blame 本就不是合法 git 命令）',
  routeGitRead('git blame') === null && routeGitRead('git blame -L 10 f.ts') === null);

check('R5 **逃生口**：带参数就不路由（要原始文本必须显式加参数，而不是默认行为）',
  routeGitRead('git status --short') === null && routeGitRead('git log -n 5') === null);

check('R6 shell 元字符一律不路由（复合 / 管道 / 重定向 / 顺序 / 反斜杠路径）',
  routeGitRead('cd src && git status') === null
  && routeGitRead('git status | head') === null
  && routeGitRead('git status > out.txt') === null
  && routeGitRead('git status;rm -rf /') === null
  && routeGitRead('git blame src\\a.ts') === null);

check('R7 写操作的裸形式不路由（commit / push / checkout / stash 都不在 op 枚举里）',
  routeGitRead('git commit') === null && routeGitRead('git push') === null
  && routeGitRead('git checkout') === null && routeGitRead('git stash') === null);

check('R8 三 token 的写形式也不路由（git tag v1 / git branch -d x）——窄判据的附带保护',
  routeGitRead('git tag v1') === null && routeGitRead('git branch -d x') === null);

check('R9 未知子命令 / 非 git / 非裸 git → 不路由',
  routeGitRead('git foo') === null && routeGitRead('node -v') === null
  && routeGitRead('/usr/bin/git status') === null);

check('R10 空串 / 全空白 / 只有 git / 大小写 / 多余 token → 不路由',
  routeGitRead('') === null && routeGitRead('   ') === null && routeGitRead('git') === null
  && routeGitRead('GIT status') === null && routeGitRead('git status extra') === null);

const bStatus = routeBashGitRead('bash', { command: 'git status' });
const rStatus = bStatus?.reason ?? '';
check('R11 bash + 裸 git status → deny，且指路到 git(op="status")',
  bStatus?.action === 'deny' && rStatus.includes('git(op="status")'));
check('R12 bash + git blame <path> → 指路里带上 path',
  (routeBashGitRead('bash', { command: 'git blame src/a.ts' })?.reason ?? '').includes('path="src/a.ts"'));
check('R13 拒绝文案说清"命令没有被执行"（模型据此知道要重发，而不是以为已经跑过）',
  rStatus.includes('没有被执行'));
check('R14 拒绝文案给出"要原始文本"的显式出口（否则模型被堵死，只能干看着）',
  rStatus.includes('--short'));
check('R15 bash + 写操作 → 不拦（git commit 走 bash 是正当路径，与 10.5.2 的写闸各管一摊）',
  routeBashGitRead('bash', { command: 'git commit -m x' }) === undefined
  && routeBashGitRead('bash', { command: 'git push' }) === undefined);
check('R16 只拦 bash（git 工具自身、write 等一律不碰）',
  routeBashGitRead('git', { op: 'status' }) === undefined
  && routeBashGitRead('write', { path: 'src/a.ts' }) === undefined);
check('R17 参数形状不对一律 fail-open（null / 字符串 / command 非字符串 / 缺 command）',
  routeBashGitRead('bash', null) === undefined && routeBashGitRead('bash', 'x') === undefined
  && routeBashGitRead('bash', { command: 42 }) === undefined
  && routeBashGitRead('bash', {}) === undefined);

// 复刻 main.ts 那段接线的**路由那一半**（同形不同实例）。契约闸的行为由 verify-charter.ts ④ 段
// 单独证明——本段只问"路由在真总线上真的拦得住"，避免把两套断言耦在一起。
const routeBus = new PromptEventEmitter();
routeBus.on('before_tool_call', (event) => {
  const e = event as { name?: unknown; args?: unknown };
  return routeBashGitRead(typeof e.name === 'string' ? e.name : '', e.args);
});
const busStatus = decodeDeny(await routeBus.emitHook('before_tool_call', { name: 'bash', args: { command: 'git log' } }));
check('R18 真 PromptEventEmitter 总线上，路由的 deny 真被 decodeDeny 解出来',
  busStatus.deny && busStatus.reason.includes('git(op="log")'), JSON.stringify(busStatus));
check('R19 同一总线上写操作照旧放行（路由不误伤 bash 的正当用途）',
  decodeDeny(await routeBus.emitHook('before_tool_call', { name: 'bash', args: { command: 'git commit -m x' } })).deny === false);
check('R20 同一总线上 git 工具自身不被拦（路由只认 bash）',
  (await routeBus.emitHook('before_tool_call', { name: 'git', args: { op: 'status' } })) === undefined);

const routeSrc = fs.readFileSync(path.join(ROOT, 'src/git/route.ts'), 'utf8');
// 先抹注释再查：本仓已第六次踩"源码文本断言被自己的说明文字判红"（route.ts 头注里举了 shell 元字符）
const routeCode = stripComments(routeSrc);
const mainCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf8'));
check('R21 route.ts 零 I/O（不碰 fs / 不起子进程 —— 判定能脱离终端验）',
  !/node:(fs|child_process)/.test(routeCode) && !/\bexecFileSync\b/.test(routeCode));
check('R22 route.ts 复用 GIT_OPS 作唯一枚举源（不另抄一份 op 表，否则两处迟早分家）',
  /GIT_OPS/.test(routeCode)
  && !/'status'\s*,\s*'diff'\s*,\s*'log'/.test(routeCode));
check('R23 main.ts 真接了路由（不是只写了个纯函数没人调）', mainCode.includes('routeBashGitRead('));
// 顺序断言：两处都只以"函数名+"出现（import 行不带括号，不会误命中）
check('R24 契约闸排在路由**之前**（安全闸优先于引导闸）',
  mainCode.indexOf('guardContractWrite(') >= 0
  && mainCode.indexOf('guardContractWrite(') < mainCode.indexOf('routeBashGitRead('));
check('R25 git 工具描述与硬路由指向同一件事（软提示说"不要用 bash 跑 git 只读"）',
  /不要用 bash 去跑 git status/.test(gitToolSrc), gitToolSrc.slice(0, 60));

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
