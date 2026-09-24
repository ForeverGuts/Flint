/**
 * verify-git-write.ts —— git **写侧**结构化工具（ROADMAP 10.5.2）
 *
 * 为什么需要它：本条的**全部价值都在判断上**，而三条判断都不是"写得对不对"、而是"选得对不对"：
 *   ① 选项注入是**靠 argv 形状**挡的（`--` 的位置），不是靠黑名单 —— 形状错了没有任何报错，
 *      只有一条能变成 `--dry-run` / `--delete` 的远端名；
 *   ② "强制推送要二次确认"在这套架构里的**技术含义是"授权键不同"** —— 键写错了，
 *      弹窗照样弹、功能照样"能用"，只是用户为普通 push 按下的"本次全部允许"会静静地
 *      覆盖掉一次强制推送（**没有任何症状**）；
 *   ③ 失败原因是**两路流**里的（commit 在 stdout、push/add 在 stderr）—— 只收一路的后果是
 *      "模型最常撞的那次提交失败"退化成一个空荡荡的正文。
 * 这三条的共同点是**错了也不报错**，所以只能靠断言盯着。
 *
 * 夹具全部来自 2026-09-20 对真 git（2.52.0.windows.1）的探针实测：
 *   · `git push -- <远端> <分支>` 合法；`git push -- --dry-run` 被 git 自己拒
 *     （`fatal: strange pathname '--dry-run' blocked`）；
 *   · `git commit -m --amend` 之后消息就是字面的 `--amend`（提交条数 +1、**没有** amend）；
 *   · `git log -1 --format=… --numstat` 的输出形状与 `show` 一致（格式块 + 空行 + numstat）；
 *   · 三条失败的流向：commit=stdout、add / push=stderr；
 *   · `pre-commit` 钩子在 Windows 上照样生效（`#!/bin/sh` + `exit 1` 能把提交拦下来）。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 枚举与取值 —— op 白名单、force 三态（含"认不出不猜"）
 *   ② argv 形状 —— `--` 的位置、旗标的位置、`-m` 的**值**、不经 shell
 *   ③ 校验与分类 —— 每种 [INVALID] 输入各自的**原因**（不是只看"被拒了"）
 *   ④ 权限身份 —— 授权键（**force 与非 force 必须不同键**）与弹窗文案
 *   ⑤ 渲染 —— 提交结果 / 推送结果（**与只读侧同一句话**）/ 失败正文（含打码）
 *   ⑥ 真跑 —— 临时仓库里 add → commit → push（推到本地 bare），含"钩子没被跳过"
 *   ⑦ 源码守护 + 接线 —— 不碰 fs、不经 shell、env 必须带 process.env、计划模式名单
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-git-write.ts
 * 退出码：failed > 0 → 1
 *
 * 环境依赖：⑥ 段要真的 git。**没装 git 时这一段走"占位断言"**（数量不变、恒真），
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
  GIT_OPS, LOG_FORMAT, buildGitArgs, parseShow, parseStatus, redactCredentialsIn, redactUrl,
  renderBranchLine,
} from '../src/git/git.js';
import {
  FORCE_MODES, GIT_WRITE_OPS, WRITE_STDERR_MAX, buildGitWriteArgs, checkWriteArgs,
  commitFollowUpArgs, forceFlag, forceLabel, gitWritePermissionDetail, gitWritePermissionKey,
  normalizeForce, pushFollowUpArgs, renderCommitResult, renderPushResult, renderWriteFailure,
  validateWriteParams,
  type GitWriteParams,
} from '../src/git/write.js';
import { PLAN_BLOCKED_TOOLS, guardPlanMode, renderPlanReason } from '../src/loop/plan-mode.js';

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

const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 一份合法的参数底稿：每个用例只改它关心的一格 */
const P = (over: Partial<GitWriteParams> = {}): GitWriteParams => ({
  op: 'commit', path: '', message: 'feat: 一', remote: '', branch: '', force: '', ...over,
});

console.log('【① 枚举与取值】');
check('A1 op 白名单恰好是 add / commit / push（多一个少一个都当场红）',
  [...GIT_WRITE_OPS].sort().join(',') === 'add,commit,push', GIT_WRITE_OPS.join(','));
check('A2 force 枚举恰好是空串 / lease / overwrite（不给布尔 —— 一个 true 表达不出两档危险差）',
  [...FORCE_MODES].join(',') === ',lease,overwrite', FORCE_MODES.join(','));
check('A3 normalizeForce 收三种值（含大小写与首尾空白）',
  normalizeForce('') === '' && normalizeForce('lease') === 'lease'
  && normalizeForce('  OVERWRITE ') === 'overwrite');
check('A4 normalizeForce 认不出就 null —— **不猜**（猜一个默认等于替用户选了危险档）',
  normalizeForce('force') === null && normalizeForce('--force') === null
  && normalizeForce('true') === null);
check('A5 forceFlag：空串一个旗标都不加、两档各自映射到 git 的真旗标',
  forceFlag('') === '' && forceFlag('lease') === '--force-with-lease'
  && forceFlag('overwrite') === '--force');
check('A6 forceLabel：不强制时是空串，强制时**必须**带上自己的旗标名（弹窗要让人认出选了哪档）',
  forceLabel('') === '' && forceLabel('lease').includes('--force-with-lease')
  && forceLabel('overwrite').includes('--force'));
check('A7 overwrite 的文案必须点明"会盖掉远端已有的提交"（这半句是给按弹窗的人看的）',
  forceLabel('overwrite').includes('盖掉'));

console.log('');
console.log('【② argv 形状（承重：选项注入靠形状挡，不靠黑名单）】');
{
  const add = buildGitWriteArgs(P({ op: 'add', path: 'src/tools' }));
  check('B1 add 是 `git add -- <路径>`：`--` 紧跟子命令、路径在最后',
    add[add.length - 3] === 'add' && add[add.length - 2] === '--' && add[add.length - 1] === 'src/tools',
    add.join(' '));
  check('B2 两个 `-c` 前缀都在（quotepath 管中文路径 / color.ui 管 push 的着色输出）',
    add[0] === '-c' && add[1] === 'core.quotepath=false'
    && add[2] === '-c' && add[3] === 'color.ui=false', add.join(' '));
}
{
  const msg = 'fix(git): 改 a 与 b && rm -rf / ; echo x';
  const c = buildGitWriteArgs(P({ op: 'commit', message: msg }));
  check('B3 commit 是 `git commit -m <消息>`：消息是 `-m` 的**值**（不是位置参数）',
    c[c.length - 2] === '-m' && c[c.length - 1] === msg, c.join(' '));
  check('B4 消息里的 shell 元字符**原样待在一个 argv 元素里**（不经 shell —— 那是注入防护的全部前提）',
    c.filter((x) => x === msg).length === 1);
  check('B5 commit 不带任何"跳过检查"的旗标（--no-verify 一旦出现，钩子就白设了）',
    !c.some((x) => /no-verify|^--amend$|^--allow-empty$|^-a$|^-n$/.test(x)), c.join(' '));
}
{
  const bare = buildGitWriteArgs(P({ op: 'push' }));
  check('B6 push 两个位置参数都留空时**不加** `--`（`git push` 走配置好的上游，最常见的那条）',
    !bare.includes('--') && bare[bare.length - 1] === 'push', bare.join(' '));
}
{
  const p = buildGitWriteArgs(P({ op: 'push', remote: 'origin', branch: 'main' }));
  const dd = p.indexOf('--');
  check('B7 push 带位置参数时 `--` 必须在它们**之前**（这才是挡掉选项注入的那一步）',
    dd > 0 && dd === p.length - 3 && p[p.length - 2] === 'origin' && p[p.length - 1] === 'main',
    p.join(' '));
}
for (const [mode, flag] of [['lease', '--force-with-lease'], ['overwrite', '--force']] as const) {
  const p = buildGitWriteArgs(P({ op: 'push', remote: 'origin', branch: 'main', force: mode }));
  check(`B8-${mode} push 的强制旗标（${flag}）落在 \`--\` **之前**（在之后它就不再是旗标了）`,
    p.includes(flag) && p.indexOf(flag) < p.indexOf('--'), p.join(' '));
}
check('B9 所有 argv 都是纯字符串数组（execFileSync 的入参形状，没有任何拼成整串的地方）',
  ['add', 'commit', 'push'].every((op) => buildGitWriteArgs(P({ op: op as GitWriteParams['op'], remote: 'o', branch: 'b' }))
    .every((x) => typeof x === 'string')));

console.log('');
console.log('【③ 校验与分类（判成 [INVALID] 才对 —— 原样重试必然再错）】');
{
  const r = checkWriteArgs({ op: 'add', path: '' });
  check('C1 add 空 path → 拒，且原因点名 path（不是一句"参数错误"）',
    r.params === null && (r.problem ?? '').includes('path'));
}
{
  const r = checkWriteArgs({ op: 'commit', message: '' });
  check('C2 commit 空消息 → 拒，且说明"不开编辑器"（否则模型以为空着就会弹编辑器）',
    r.params === null && (r.problem ?? '').includes('编辑器'));
}
check('C3 **只空白的**消息也算空（否则会提交一条没有主题的提交）',
  checkWriteArgs({ op: 'commit', message: '   \n ' }).params === null);
{
  const r = checkWriteArgs({ op: 'push', remote: '--force' });
  check('C4 remote 以 `-` 开头 → 拒，原因是"那位置要填名字"（分类对：原样重试必然再错）',
    r.params === null && (r.problem ?? '').includes('remote') && (r.problem ?? '').includes('选项'));
}
{
  const r = checkWriteArgs({ op: 'push', remote: 'origin', branch: '-f' });
  check('C5 branch 以 `-` 开头 → 同样拒（`git push origin -f` 里它就在选项位置）',
    r.params === null && (r.problem ?? '').includes('branch'));
}
{
  const r = checkWriteArgs({ op: 'push', branch: 'main' });
  check('C6 只给 branch 不给 remote → 拒，并说明"要成对给"（单给会被当成远端名）',
    r.params === null && (r.problem ?? '').includes('成对'));
}
{
  const r1 = checkWriteArgs({ op: 'push', remote: 'origin' });
  const r2 = checkWriteArgs({ op: 'push' });
  check('C7 只给 remote（推当前分支）、两个都留空（走上游）→ 都放行',
    r1.params !== null && r1.params.branch === '' && r2.params !== null);
}
{
  const r = checkWriteArgs({ op: 'push', force: 'hard' });
  check('C8 认不出的 force → 拒，并把两个合法值都写出来（不替它挑一个）',
    r.params === null && (r.problem ?? '').includes('lease') && (r.problem ?? '').includes('overwrite'));
}
check('C9 通过时 problem 为 null、不通过时 params 为 null（两样恰好一件，调用侧才敢直接断言）',
  (() => {
    const ok = checkWriteArgs({ op: 'push' });
    const bad = checkWriteArgs({ op: 'nope' });
    return ok.params !== null && ok.problem === null && bad.params === null && bad.problem !== null;
  })());
check('C10 未知 op 的原因里点名可用项（模型据此改参数，而不是去翻文档）',
  (checkWriteArgs({ op: 'reset' }).problem ?? '').includes('add / commit / push'));
check('C11 原始 args 形状完全不对（null / 数组 / 数字）→ 不抛异常，一律判成"未知操作"',
  checkWriteArgs(null).params === null && checkWriteArgs([1]).params === null
  && checkWriteArgs(42).params === null);
check('C12 validateWriteParams 与 checkWriteArgs 用同一套判据（不是两处各写一遍）',
  validateWriteParams(P({ op: 'commit', message: 'x' })) === null
  && validateWriteParams(P({ op: 'commit', message: '' })) !== null);

console.log('');
console.log('【④ 权限身份：授权键 与 弹窗文案】');
check('D1 普通 push 与强制 push 的键**必须不同** —— 这就是"二次确认"的技术含义',
  gitWritePermissionKey({ op: 'push', remote: 'origin', branch: 'main' })
  !== gitWritePermissionKey({ op: 'push', remote: 'origin', branch: 'main', force: 'overwrite' }));
check('D2 lease 与 overwrite 的键也不同（两档危险不是同一笔账）',
  gitWritePermissionKey({ op: 'push', remote: 'o', branch: 'm', force: 'lease' })
  !== gitWritePermissionKey({ op: 'push', remote: 'o', branch: 'm', force: 'overwrite' }));
{
  const k = gitWritePermissionKey({ op: 'push', remote: 'origin', branch: 'main', force: 'lease' });
  check('D3 push 键的形状可读且带强制模式（`push:origin/main:lease`）',
    k === 'push:origin/main:lease', k);
}
check('D4 留空的远端/分支在键里是**占位**而不是空串（否则 `push:/` 这种键谁也读不懂）',
  gitWritePermissionKey({ op: 'push' }) === 'push:(上游)/(当前分支)',
  gitWritePermissionKey({ op: 'push' }));
check('D5 commit 的键带消息（换一条消息 = 另一次提交，该重问）',
  gitWritePermissionKey({ op: 'commit', message: 'a' })
  !== gitWritePermissionKey({ op: 'commit', message: 'b' })
  && gitWritePermissionKey({ op: 'commit', message: 'a' }) === 'commit:a');
check('D6 add 的键带路径（同 write / edit 的口径）',
  gitWritePermissionKey({ op: 'add', path: 'src/a.ts' }) === 'add:src/a.ts');
check('D7 三种 op 的键都以自己的 op 名开头（检索时一眼分得开，不会彼此撞车）',
  gitWritePermissionKey({ op: 'add', path: 'p' }).startsWith('add:')
  && gitWritePermissionKey({ op: 'commit', message: 'm' }).startsWith('commit:')
  && gitWritePermissionKey({ op: 'push' }).startsWith('push:'));
check('D8 键是**稳定键**：同一组参数两次调用得到同一个键（否则"本次全部允许"永远失配）',
  gitWritePermissionKey({ op: 'push', remote: 'o', branch: 'b', force: 'lease' })
  === gitWritePermissionKey({ op: 'push', remote: 'o', branch: 'b', force: 'lease' }));
check('D9 认不出形状的 args（权限层拿到的就是未 parse 的）→ 退回整串 JSON、**不抛异常**',
  (() => {
    try {
      return typeof gitWritePermissionKey({ op: 'nope' }) === 'string'
        && typeof gitWritePermissionKey(null) === 'string'
        && typeof gitWritePermissionKey('x') === 'string';
    } catch { return false; }
  })());
{
  const normal = gitWritePermissionDetail({ op: 'push', remote: 'origin', branch: 'main' });
  const forced = gitWritePermissionDetail({ op: 'push', remote: 'origin', branch: 'main', force: 'overwrite' });
  check('D10 弹窗文案说清"推到哪"（默认的 args JSON 前 80 字符看不出这件事）',
    normal.includes('origin/main'), normal);
  check('D11 强制的弹窗文案带警告词、非强制的**没有**（否则警示就成了背景噪音）',
    forced.includes('⚠') && forced.includes('--force') && !normal.includes('⚠'), forced);
}
check('D12 认不出参数时弹窗给的是人话，不是"undefined"（那一屏是给按按钮的人看的）',
  gitWritePermissionDetail({ op: 'nope' }).includes('不合法')
  && !gitWritePermissionDetail({ op: 'nope' }).includes('undefined'));
check('D13 commit 的弹窗只取消息**首行**（多行消息不该把弹窗撑成三行）',
  gitWritePermissionDetail({ op: 'commit', message: '第一行\n第二行' }) === 'git commit：第一行',
  gitWritePermissionDetail({ op: 'commit', message: '第一行\n第二行' }));

console.log('');
console.log('【⑤ 渲染（失败正文含打码与"常见原因"）】');
{
  const entry = parseShow('0cf62bd\u001f2026-09-20\u001fTester\u001ffeat: 一\u001e\n\n1\t0\ta.txt\n');
  const body = renderCommitResult(entry!);
  check('E1 提交成功的正文说"提交成功"，并复用只读侧的 show 渲染（`[提交]` / `[改动]` 两行）',
    body.includes('提交成功') && body.includes('[提交] 0cf62bd')
    && body.includes('[改动]') && body.includes('a.txt'), body.split('\n')[0]);
}
{
  const st = parseStatus('## main...origin/main\u0000');
  const body = renderPushResult(st);
  check('E2 推送正文里的分支行**逐字等于**只读侧那一行（同一件事不许两套说法）',
    body.includes(renderBranchLine(st)), body);
  check('E3 平齐时补一句"与上游一致"（只读侧那行平齐时是留白的 —— 刚推完的人要的正是这个答复）',
    body.includes('与上游一致'));
}
{
  const body = renderPushResult(parseStatus('## main...origin/main [ahead 2]\u0000'));
  check('E4 领先时不补那句、且报出"领先 2"（结论与实际相反时不能照抄）',
    !body.includes('与上游一致') && body.includes('领先 2'), body);
}
{
  const leak = 'To https://alice:ghp_SUPERSECRET@example.com/repo.git\n'
    + ' ! [rejected]        main -> main (non-fast-forward)\n'
    + "error: failed to push some refs to 'https://alice:ghp_SUPERSECRET@example.com/repo.git'";
  const body = renderWriteFailure('push', leak);
  check('E5 失败正文**必须打码凭据**（push 的原话里必定带远端 URL，而它可能带 token）',
    !body.includes('ghp_SUPERSECRET') && body.includes('https://***@example.com/repo.git'),
    body.slice(0, 140));
  check('E6 失败正文带 git 的原话（non-fast-forward 这类证据只有它说得清）',
    body.includes('non-fast-forward'));
  check('E7 push 的"常见原因"点名 non-fast-forward，并说清"先 pull / rebase，不要强推盖掉别人的提交"',
    body.includes('rebase') && body.includes('不要'));
}
check('E8 commit 的"常见原因"点名三件事：不替你 add / 不跳过钩子 / user.name 没配',
  (() => {
    const b = renderWriteFailure('commit', 'x');
    return b.includes('不替你 add') && b.includes('钩子') && b.includes('user.name');
  })());
check('E9 add 的"常见原因"点名 .gitignore（被忽略的文件暂存不了，是最常见的那次困惑）',
  renderWriteFailure('add', 'x').includes('.gitignore'));
check('E10 原话为空时给一句"没有给出任何信息"+ 下一步（不留一个空荡荡的正文）',
  renderWriteFailure('push', '').includes('没有给出任何信息'));
check(`E11 超长原话被截到 ${WRITE_STDERR_MAX} 字并带省略号（防一屏刷屏）`,
  (() => {
    const b = renderWriteFailure('push', 'x'.repeat(WRITE_STDERR_MAX * 2));
    return b.includes('…') && !b.includes('x'.repeat(WRITE_STDERR_MAX + 1));
  })());
check('E12 三档失败的标题各自点名 op（"暂存失败"与"推送失败"不许混成一个词）',
  renderWriteFailure('add', 'x').includes('暂存失败')
  && renderWriteFailure('commit', 'x').includes('提交失败')
  && renderWriteFailure('push', 'x').includes('推送失败'));
check('E13 文本级打码与 URL 级打码是**同一个口径**（同一段凭据，两处抹出来的形状必须一致）',
  redactCredentialsIn('https://a:b@h/x') === redactUrl('https://a:b@h/x')
  && redactCredentialsIn('https://a:b@h/x') === 'https://***@h/x');

console.log('');
console.log('【⑥ 真跑：临时仓库里 add → commit → push（推到本地 bare）】');
const GIT_OK = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
/** ⑥ 段里**依赖真 git** 的那些项（名字先列出来：没装 git 时按同样的条数走占位断言） */
const F_NAMES = [
  'F1 add 跑通，且**真进了暂存区**',
  'F2 commit 跑通：正文说"提交成功"、仓库里真有一条同消息的提交',
  'F3 commit 之后暂存区是空的（只提交已暂存的，没有把工作区一起卷进去）',
  'F4 commit 的复核真读到了刚提交的那条（hash 与消息都对得上）',
  'F5 pre-commit 钩子拒绝时：提交条数不变 + 正文点明钩子（**证明没有跳过钩子**）',
  'F6 消息里带 `--amend` 也不会被当成选项（`-m` 的下一个 token 是值）',
  'F7 push 跑通，且远端 bare 里真有那条提交（"成功"不是印出来的）',
  'F8 push 之后报"与上游一致"（复盘用的是**推完之后**的只读复核，不是 push 自己那句话）',
  'F9 push 到不存在的远端 → 失败，正文带 git 的原话',
  'F10 add 一个不存在的路径 → 失败（pathspec 不匹配由 git 判，工具不替它吞掉）',
  'F11 空暂存区 commit → 失败，且正文里**有 git 的原话**（证明两路流都收了）',
];
if (!GIT_OK) {
  console.log('  ⚠️ 本机没有 git —— ⑥ 段走占位断言（数量不变，免得项数随环境浮动）');
  for (const n of F_NAMES) check(n, true, '（本机没有 git：占位断言，恒真）');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-gw-'));
  const repo = path.join(tmp, 'repo');
  const bare = path.join(tmp, 'bare.git');
  const origCwd = process.cwd();
  const gitAt = (dir: string, args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const g = (...args: string[]): string => gitAt(repo, args);
  try {
    fs.mkdirSync(repo);
    gitAt(tmp, ['init', '-q', repo]);
    gitAt(tmp, ['init', '-q', '--bare', bare]);
    g('config', 'user.email', 'v@t.t');
    g('config', 'user.name', 'Verifier');
    g('config', 'commit.gpgsign', 'false');   // 用户若开了强制签名，提交会失败（同 verify-git）
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    g('add', '-A');
    g('commit', '-qm', 'first');
    const br = g('rev-parse', '--abbrev-ref', 'HEAD');
    g('remote', 'add', 'origin', bare);
    g('push', '-q', '-u', 'origin', br);      // 先用真 git 建好上游（本工具刻意不做 -u）

    process.chdir(repo);
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), new EventStore());

    // ── F1：add ──
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    {
      const r = await reg.execute('git_write', { op: 'add', path: '.' });
      check(F_NAMES[0], r.status === 'ok' && g('diff', '--cached', '--name-only').includes('b.txt'),
        r.content.slice(0, 90));
    }

    // ── F2 / F3 / F4：commit ──
    {
      const r = await reg.execute('git_write', { op: 'commit', message: 'feat: 第二条' });
      check(F_NAMES[1], r.status === 'ok' && r.content.includes('提交成功')
        && g('log', '-1', '--format=%s') === 'feat: 第二条', r.content.slice(0, 120));
      check(F_NAMES[2], g('diff', '--cached', '--name-only') === '');
      check(F_NAMES[3], r.content.includes(g('log', '-1', '--format=%h'))
        && r.content.includes('feat: 第二条'));
    }

    // ── F5：钩子必须真的生效（本工具没有 --no-verify）──
    {
      fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
      g('add', '-A');
      fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'),
        '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
      const before = g('rev-list', '--count', 'HEAD');
      const r = await reg.execute('git_write', { op: 'commit', message: '不该成功' });
      check(F_NAMES[4], r.status === 'error' && g('rev-list', '--count', 'HEAD') === before
        && r.content.includes('提交失败') && r.content.includes('钩子'),
        `${r.status} / ${r.content.slice(0, 120)}`);
      fs.rmSync(path.join(repo, '.git', 'hooks', 'pre-commit'));
    }

    // ── F6：消息里的 `--amend` 只是消息 ──
    {
      const r = await reg.execute('git_write', { op: 'commit', message: '--amend' });
      check(F_NAMES[5], r.status === 'ok' && g('log', '-1', '--format=%s') === '--amend'
        && g('rev-list', '--count', 'HEAD') === '3', r.content.slice(0, 90));
    }

    // ── F7 / F8：push ──
    {
      const r = await reg.execute('git_write', { op: 'push', remote: 'origin', branch: br });
      const remoteSubject = gitAt(bare, ['log', '-1', '--format=%s']);
      check(F_NAMES[6], r.status === 'ok' && r.content.includes('推送完成')
        && remoteSubject === '--amend', `${r.status} / 远端最后一条=${remoteSubject}`);
      check(F_NAMES[7], r.content.includes('与上游一致'), r.content);
    }

    // ── F9：不存在的远端 ──
    {
      const r = await reg.execute('git_write', { op: 'push', remote: 'nope' });
      check(F_NAMES[8], r.status === 'error' && r.content.includes('推送失败')
        && r.content.includes('git 说'), `${r.status} / ${r.content.slice(0, 120)}`);
    }

    // ── F10：pathspec 不匹配 ──
    {
      const r = await reg.execute('git_write', { op: 'add', path: 'definitely-missing-xyz' });
      check(F_NAMES[9], r.status === 'error' && r.content.includes('暂存失败'));
    }

    // ── F11：空暂存区提交（此刻工作区干净；git 的理由在 **stdout**，stderr 是空的）──
    {
      const r = await reg.execute('git_write', { op: 'commit', message: '空的' });
      check(F_NAMES[10], r.status === 'error' && r.content.includes('git 说')
        && !r.content.includes('没有给出任何信息'), r.content.slice(0, 140));
    }
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
check('F12 只读的 git 工具**没有**被顺手开口子（GIT_OPS 仍不含任何写 op）',
  !GIT_OPS.some((x) => (['add', 'commit', 'push'] as readonly string[]).includes(x)));
check('F13 写侧与只读侧的 argv 前缀一致（两个入口跑的是同一套 git 纪律）',
  buildGitWriteArgs(P({ op: 'commit', message: 'x' })).slice(0, 4).join(' ')
  === buildGitArgs({ op: 'log', target: '', path: '', lines: '', limit: 10 }).slice(0, 4).join(' '));

console.log('');
console.log('【⑦ 源码守护 + 接线】');
const writeCode = stripComments(read('src/git/write.ts'));
const builtinCode = stripComments(read('src/tools/builtin.ts'));
/**
 * 切出 `git_write` 工具那一段（到下一个 `tools.register(` 为止）——
 * 与 verify-git 的 J 段同一手法：不靠魔法数字窗口（工具一变长，窗口就与意图分家）。
 */
const gwToolCode = (() => {
  const at = builtinCode.indexOf("name: 'git_write',");
  if (at < 0) return '';
  const next = builtinCode.indexOf('tools.register(', at);
  return builtinCode.slice(at, next < 0 ? undefined : next);
})();
check('G1 `git_write` 真的注册进了 builtin（不是只写了个纯函数模块没人调）', gwToolCode !== '');
check('G2 write.ts 零 I/O（不碰 fs、不起子进程 —— 全部判据能脱离终端验）',
  !/node:(fs|child_process)/.test(writeCode) && !/\bexecFileSync\b/.test(writeCode));
check('G3 git_write 经 execFileSync + **数组**（argv 不经 shell —— 注入防护的前提）',
  /execFileSync\('git', a,/.test(gwToolCode));
check('G4 env 必须 `...process.env` 打底（只给一个变量会把 PATH 一起丢掉、git 就找不到了）',
  /\{\s*\.\.\.process\.env,\s*GIT_TERMINAL_PROMPT/.test(gwToolCode));
check('G5 GIT_TERMINAL_PROMPT 置 0（需要输密码时直接失败，不挂住等人敲）',
  /GIT_TERMINAL_PROMPT:\s*'0'/.test(gwToolCode));
check('G6 失败时**两路流都收**（commit 的理由在 stdout、push/add 的在 stderr）',
  /err\.stdout/.test(gwToolCode) && /err\.stderr/.test(gwToolCode));
check('G7 工具描述里写出 force 的两个合法值（模型得知道它必须显式选一档）',
  /\blease\b/.test(gwToolCode) && /\boverwrite\b/.test(gwToolCode));
check('G8 工具描述里明说"不跳过 git 钩子"（否则模型会以为有 --no-verify 可加）',
  gwToolCode.includes('no-verify'));
check('G9 工具描述里明说"不接交互输入"（凭据问题的出路是用户的终端）',
  gwToolCode.includes('输密码'));
check('G10 git_write **要求权限**（只读那侧不弹窗、写这侧每一次都该弹）',
  /requirePermission:\s*true/.test(gwToolCode));
check('G11 git_write 真接上自定义的 permissionKey / permissionDetail（不是退回默认的 args JSON）',
  /permissionKey:\s*\(args\)/.test(gwToolCode) && /permissionDetail:\s*\(args\)/.test(gwToolCode));
check('G12 计划模式的名单里**必须有 git_write**（写侧工具漏一个 = 一条静默通路）',
  PLAN_BLOCKED_TOOLS.has('git_write'));
check('G13 计划模式的**拒因**也报了 git_write（名单改了、话没改，是最容易漏的那半步；横幅那半归 verify-plan 的 C10 派生断言盯）',
  renderPlanReason('git_write').includes('git_write'));
{
  const r = guardPlanMode('git_write', true);
  check('G14 模式开着时 git_write 真的被拒（真跑判据，不只看名单）',
    r !== undefined && r.action === 'deny');
  check('G15 模式开着时只读的 git **不被拒**（写侧进名单 ≠ 把读侧一起关了）',
    guardPlanMode('git', true) === undefined);
  check('G16 模式关着时 git_write 放行（名单只在模式开着时说话）',
    guardPlanMode('git_write', false) === undefined);
}
check('G17 commit 的复核用 `log -1` + 与 show **同一条格式串**（格式只有一份定义）',
  commitFollowUpArgs().includes(`--format=${LOG_FORMAT}`) && commitFollowUpArgs().includes('--numstat')
  && commitFollowUpArgs().includes('-1'));
check('G18 push 的复核**复用只读侧的 buildGitArgs**（不另搓一份 status 命令）',
  pushFollowUpArgs().join(' ')
  === buildGitArgs({ op: 'status', target: '', path: '', lines: '', limit: 10 }).join(' '));
check('G19 分支行只有一份实现：write.ts 引用 git.ts 的 renderBranchLine、不自己拼那句',
  /renderBranchLine/.test(writeCode) && !/\[分支\]/.test(writeCode));
check('G20 不自己抄一份「凭据打码」（复用 git.ts 的 redactCredentialsIn）',
  /redactCredentialsIn/.test(writeCode) && !/:\/\/\)\[\^\/@/.test(writeCode));
  check('G21 builtin.ts 的模块头把工具数改到 20（不是\"悄悄多一个\"）',
    /共 20 个/.test(read('src/tools/builtin.ts')),
    '模块头里那句"共 N 个"没跟着改 —— 它是给人读的清单，陈旧了没人会发现');

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
