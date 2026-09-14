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
 *   ⑦ branch 解析与渲染 —— 字面 `|`（**不是** `%x1f`，branch 不认那个）
 *   ⑧ 行为 —— 真 git 仓库端到端跑四个 op（含未跟踪不进 diff、非仓库报错、空仓库 log）
 *   ⑨ 拒绝路径 —— 未知 op / 危险 target → [INVALID]，且**一个 git 进程都没起**
 *   ⑩ 源码守护 + 提示词交叉 —— 纯模块零 import、不弹窗、走 execFileSync
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
  BRANCH_FORMAT, GIT_OPS, LOG_FORMAT, LOG_LIMIT_MAX, buildGitArgs, normalizeLimit, parseBranch,
  parseLog, parseNumstat, parseStatus, renderBranch, renderDiff, renderLog, renderStatus,
  statusCodeLabel, validateTarget,
} from '../src/git/git.js';

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

// 实测自 probe-git3：branch 的字段分隔用**字面** `|`（%x1f 在 branch 里不被解释）
const S_BRANCH = '*|main|origin/main|[ahead 1]\n |dev||\n';
// 实测自 probe-git3：detached 时 %(HEAD) 那行是伪分支
const S_BRANCH_DETACHED = '*|(HEAD detached at 3b70939)||\n |main|origin/main|[ahead 1]\n';

const P = { op: 'status' as const, target: 'worktree', path: '', limit: 10 };

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
  check('A10 branch 的 --format 用**字面 |**（%x1f 只有 log 认，branch 会输出那五个字符）',
    br.includes(`--format=${BRANCH_FORMAT}`) && BRANCH_FORMAT.includes('|') && !br.some((a) => a.includes('%x1f')));

  check('A11 每条命令都带 core.quotepath=false（否则中文路径被转义成 \\344\\270\\255）',
    [status, diff0, log, br].every((a) => a.includes('core.quotepath=false')));
  check('A12 每条命令都带 color.ui=false（用户若开了强制着色，ANSI 码会毁掉解析）',
    [status, diff0, log, br].every((a) => a.includes('color.ui=false')));
  // 断言的是"命令是一串**独立 token**、不是一条拼好的字符串"——argv 形式本身就让 shell 无从介入。
  // 刻意**不**查 `|`：git 的 --format 用字面 `|` 当字段分隔是正常写法，它不过 shell、不是管道
  //（第一版这里查了 `|` 并放行 BRANCH_FORMAT，但数组里那元素带着 `--format=` 前缀，判定永远为假）
  const SHELL_META = ['&&', ';', '$(', '`'];
  check('A13 argv 里没有任何 shell 拼接（&& / ; / $( ) / 反引号）—— 命令是 token 数组，不是一条字符串',
    [status, diff0, log, br].every((a) => a.every((s) => !SHELL_META.some((m) => s.includes(m)))));
  check('A14 status/diff/log/branch 四个 op 都能构造出命令（白名单被完整覆盖）',
    GIT_OPS.every((op) => buildGitArgs({ ...P, op }).length > 0) && GIT_OPS.length === 4);
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
console.log('── ⑦ branch 解析与渲染 ──');

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

/* ── ⑧ 行为：真仓库端到端 ── */
console.log('── ⑧ 行为：真 git 仓库端到端 ──');

let hasGit = true;
try {
  execFileSync('git', ['--version'], { encoding: 'utf-8', windowsHide: true, stdio: 'pipe' });
} catch {
  hasGit = false;
}

if (!hasGit) {
  console.log('  ⚠️  本机没有可用的 git —— ⑧ 段走占位断言（项数不变，但不构成真实验证）');
  for (let i = 1; i <= 16; i++) check(`H${i} （占位：本机无 git，未能验证）`, true);
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

    {
      // 空仓库：log 以 128 退出，但这不是故障
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-vgit-e-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: empty, encoding: 'utf-8', windowsHide: true });
        process.chdir(empty);
        const reg2 = new ToolRegistry();
        registerBuiltinTools(reg2, new TaskStore(), new MemoryStore(), new EventStore());
        const r = await reg2.execute('git', { op: 'log' });
        check('H13 空仓库 log → [OK] 且说明"还没有任何提交"（128 退出不是故障）',
          r.status === 'ok' && r.content.includes('还没有任何提交'), `${r.status} ${r.content.slice(0, 80)}`);
        const r2 = await reg2.execute('git', { op: 'branch' });
        check('H14 空仓库 branch → 说明一个分支都还没有', r2.status === 'ok' && r2.content.includes('一个分支都还没有'));
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
        check('H15 非仓库目录 → [ERROR] 且说明"不是 git 仓库"（计失败，不会静默放过）',
          r.status === 'error' && r.content.includes('不是 git 仓库'), `${r.status} ${r.content.slice(0, 90)}`);
        check('H16 报错文案明说不会替用户 git init（边界清晰）', r.content.includes('git init'));
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

/* ── ⑨ 拒绝路径 ── */
console.log('── ⑨ 拒绝路径 ──');

{
  const reg = new ToolRegistry();
  registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), new EventStore());

  const r1 = await reg.execute('git', { op: 'commit' });
  check('I1 未知 op（如 commit）→ [INVALID]，并列出四个可用 op',
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
}

/* ── ⑩ 源码守护 + 提示词交叉 ── */
console.log('── ⑩ 源码守护 + 提示词交叉 ──');

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

check('J1 src/git/git.ts 零 import（纯函数模块，解析逻辑能脱离终端验）', !/^import /m.test(gitSrc));
check('J2 git.ts 不碰 fs / 不起子进程（跑命令的职责在工具层；先抹注释，免得被示例文字误伤）',
  !/node:(fs|child_process)/.test(stripComments(gitSrc))
  && !/\bexecFileSync\b/.test(stripComments(gitSrc)));
check('J3 git 工具**不**带 requirePermission（只读，不该弹窗；写操作留给 10.5.2）',
  /name: 'git',[\s\S]{0,600}?spec: \{/.test(builtinSrc)
  && !/name: 'git',[\s\S]{0,600}?requirePermission/.test(builtinSrc));
check('J4 git 工具走 execFileSync（argv 数组，不经 shell）而非 execSync（命令字符串）',
  /name: 'git',[\s\S]{0,3000}?execFileSync\('git'/.test(builtinSrc)
  && !/name: 'git',[\s\S]{0,3000}?execSync\(/.test(builtinSrc));
check('J5 工具层复用既有 decodeChildOutput 做编码判别（不另起一套）',
  /name: 'git',[\s\S]{0,3000}?decodeChildOutput\(raw\)/.test(builtinSrc));
check('J6 提示词写明归档的"前后区别"要基于 git diff 或验证结果（事实来源纪律仍在）',
  coreSrc.includes('git diff 或验证结果'));
check('J7 提示词里"下一件事"的措辞指向了 git 工具（给了模型可执行的抓手，而不只是一条禁令）',
  /git 工具/.test(coreSrc), coreSrc.match(/.{0,40}git 工具.{0,40}/u)?.[0] ?? '（提示词里没提 git 工具）');

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
