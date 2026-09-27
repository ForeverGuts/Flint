/**
 * verify-repo-status.ts —— 仓库状态注入（ROADMAP 10.5.5）
 *
 * 为什么需要它：模型此前**不知道自己在哪条分支、工作区脏不脏**，每次都得用 `bash` 跑一条
 * `git status` 才看得见——而 `bash` 走的是弹窗 / 危险闸通道，纯"想看一眼"却要付出交互代价，
 * 且只回原始文本（分支领先落后得自己数 porcelain 码）。本条把这份信息在**会话起点**摆进视野。
 *
 * 验什么（手段与行为分开钉）：
 *   ① summarizeRepoStatus（纯函数，逐分支穷举）—— 已暂存 / 未暂存 / 未跟踪各自计数口径；
 *      未跟踪只进 untracked、已忽略跳过、重命名计一次已暂存、分支/游离/未诞生透传、领先落后透传
 *   ② renderRepoStatusSection —— 空（非仓库/失败→''）；标题；分支/游离/未诞生各自形状；
 *      领先落后行；工作区干净 vs 脏（计数文案）
 *   ③ 注册表 —— 初值 / set / get / clear 往返
 *   ④ 真探针 —— 非仓库目录 → null（不抛）；真仓库根 → 非 null 且带分支或游离
 *   ⑤ 源码守护 —— repo-status.ts 对 git 只用 `import type`（运行期零依赖、不引入 child_process）；
 *      接线落点唯一（runtime 传 repo 字段、project 层渲染 ctx.repo）；非仓库整段缺席
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-repo-status.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterSandbox } from './lib/sandbox.js';
import { probeRepoStatus } from '../src/project/probe.js';
import {
  summarizeRepoStatus, renderRepoStatusSection, repoStatusRegistry,
  type RepoStatusView,
} from '../src/project/repo-status.js';
import type { RepoStatus, StatusEntry } from '../src/git/git.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 自保（D1 真探针要在临时目录里探）── */
const sandbox = enterSandbox('flint-repo-status-');
const tmpDir = sandbox.dir;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail !== undefined ? ` —— ${String(detail)}` : ''}`); }
}

/** 造一份 parseStatus 的输出（判据是纯函数，每条分支这样打靶，不必先造真仓库） */
const rs = (o: Partial<RepoStatus> & { entries?: StatusEntry[] }): RepoStatus => ({
  branch: '', upstream: null, ahead: 0, behind: 0,
  detached: false, unborn: false, entries: [], ...o,
});
/** 造一条变更条目（path 无关，计数只看 xy 两字母码） */
const e = (xy: string): StatusEntry => ({ xy, path: 'f', orig: null });

/* ═══════════════════════════════════════════════════════════════════════════════
   ① summarizeRepoStatus：按位归类（X=已暂存 / Y=未暂存 / '??'=未跟踪 / '!!'=忽略）
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ① summarizeRepoStatus：计数口径 ──');
{
  const a1 = summarizeRepoStatus(rs({}));
  check('A1 干净仓库：三项改动全 0', a1.staged === 0 && a1.unstaged === 0 && a1.untracked === 0);
  check('A1b 干净仓库：在仓库内、无领先落后', a1.inRepo && a1.ahead === 0 && a1.behind === 0);

  const a2 = summarizeRepoStatus(rs({ entries: [e('M '), e(' M'), e('??'), e('!!')] }));
  check('A2 混合脏：已暂存 1（M ）/ 未暂存 1（ M）/ 未跟踪 1（??）',
    a2.staged === 1 && a2.unstaged === 1 && a2.untracked === 1);
  check('A2b 已忽略 !! 不计入任何一项', a2.staged === 1 && a2.unstaged === 1 && a2.untracked === 1);

  const a3 = summarizeRepoStatus(rs({ entries: [e('R ')] }));
  check('A3 重命名 R 只计一次已暂存（Y 位是空格，不计未暂存）', a3.staged === 1 && a3.unstaged === 0);

  const a4 = summarizeRepoStatus(rs({ entries: [e('??'), e('??')] }));
  check('A4 两个未跟踪：untracked=2、staged/unstaged 仍 0', a4.untracked === 2 && a4.staged === 0 && a4.unstaged === 0);

  const a5 = summarizeRepoStatus(rs({ entries: [e('!!'), e(' M')] }));
  check('A5 忽略 + 未暂存：unstaged=1、staged=0、untracked=0', a5.unstaged === 1 && a5.staged === 0 && a5.untracked === 0);

  const a6 = summarizeRepoStatus(rs({ branch: 'dev', ahead: 2, behind: 1 }));
  check('A6 分支名 / 领先 / 落后透传', a6.branch === 'dev' && a6.ahead === 2 && a6.behind === 1);

  const a7 = summarizeRepoStatus(rs({ detached: true, branch: 'abc123' }));
  check('A7 游离：detached=true 且 branch 被抹成 null', a7.detached && a7.branch === null);

  const a8 = summarizeRepoStatus(rs({ unborn: true, branch: 'main' }));
  check('A8 未诞生：unborn=true 且 branch 保留', a8.unborn && a8.branch === 'main');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ② renderRepoStatusSection：断言断在渲染文本上
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ② renderRepoStatusSection：给人/模型读的输出 ──');
{
  check('B1 非仓库（null）→ 空串（整段缺席）', renderRepoStatusSection(null) === '');
  check('B1b 非仓库（inRepo=false 的视图）→ 空串',
    renderRepoStatusSection({ inRepo: false, branch: null, detached: false, unborn: false, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 }) === '');

  const v3 = summarizeRepoStatus(rs({ branch: 'main', entries: [] }));
  const t3 = renderRepoStatusSection(v3);
  check('B3 干净分支：含「分支：main」与「工作区干净」、不含领先/已暂存',
    t3.includes('分支：main') && t3.includes('工作区干净') && !t3.includes('领先') && !t3.includes('已暂存'));
  check('B3b 标题含快照声明（交代这是起点而非实时）', t3.includes('[仓库状态]（会话开始时的快照'));

  const v4 = summarizeRepoStatus(rs({ branch: 'main', entries: [e('M '), e('??')] }));
  const t4 = renderRepoStatusSection(v4);
  check('B4 脏：含「已暂存改动」与未跟踪计数', t4.includes('1 处已暂存改动') && t4.includes('1 个未跟踪文件'));

  const v5 = summarizeRepoStatus(rs({ detached: true, branch: '' }));
  check('B5 游离：含「HEAD 游离」', renderRepoStatusSection(v5).includes('HEAD 游离（不在任何分支上）'));

  const v6 = summarizeRepoStatus(rs({ unborn: true, branch: 'main' }));
  check('B6 未诞生：含「尚无任何提交」', renderRepoStatusSection(v6).includes('尚无任何提交'));

  const v7 = summarizeRepoStatus(rs({ branch: 'main', ahead: 2, behind: 1 }));
  check('B7 领先/落后：含「领先上游 2 / 落后 1」', renderRepoStatusSection(v7).includes('领先上游 2 / 落后 1'));
  check('B7b 无领先落后时不出现该行', !t3.includes('领先上游'));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 注册表：模块级单例的 set/get/clear 往返
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ③ 注册表 ──');
{
  repoStatusRegistry.clear();
  check('C1 初值 / 清后 = null（非仓库时不注入）', repoStatusRegistry.get() === null);
  const v: RepoStatusView = { inRepo: true, branch: 'main', detached: false, unborn: false, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 };
  repoStatusRegistry.set(v);
  check('C2 set 后 get 取回同一引用', repoStatusRegistry.get() === v);
  check('C3 set 非 null 后渲染非空（接线形态正确）', renderRepoStatusSection(repoStatusRegistry.get()) !== '');
  repoStatusRegistry.set(null);
  check('C4 set(null) 等价于清：整段缺席', repoStatusRegistry.get() === null && renderRepoStatusSection(repoStatusRegistry.get()) === '');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 真探针：非仓库 → null（不抛）；真仓库根 → 非 null
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ④ 真探针（真实 git 子进程）──');
{
  const probe = probeRepoStatus(tmpDir);
  check('D1 非仓库目录探测 → null（认不出即丢弃，不抛、不崩）', probe === null);
  const inRepo = probeRepoStatus(ROOT);
  check('D2 真仓库根探测 → 非 null', inRepo !== null);
  check('D2b 真仓库结果 inRepo=true 且带分支名或处于游离',
    !!inRepo && inRepo.inRepo && (inRepo.branch !== null || inRepo.detached));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 源码守护：运行期零依赖 + 接线落点唯一 + 非仓库整段缺席
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ⑤ 源码守护 ──');
{
  const repoSrc = fs.readFileSync(path.join(ROOT, 'src/project/repo-status.ts'), 'utf-8');
  const gitImports = repoSrc.split('\n').filter((l) => l.includes("from '../git/git.js'"));
  check('E1 repo-status.ts 对 git 只用 import type（运行期不引入 child_process）',
    gitImports.length === 1 && gitImports[0]!.trim().startsWith('import type'));
  check('E2 repo-status.ts 不 import 任何运行时值（零依赖）',
    !/^\s*import\s+\{/.test(repoSrc) && !/^\s*import\s+\w/.test(repoSrc));

  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'src/runtime/runtime.ts'), 'utf-8');
  check('E3 runtime 把 repo 字段传给 systemPromptService.build',
    /repo:\s*repoStatusSection\s*===?\s*''\s*\?\s*undefined\s*:\s*repoStatusSection/.test(runtimeSrc));

  const ctxSrc = fs.readFileSync(path.join(ROOT, 'src/context/system-prompt.ts'), 'utf-8');
  check('E4 project 层渲染 ctx.repo（接线落点唯一，在 project 半段里）',
    /if \(ctx\.project \|\| ctx\.stack \|\| ctx\.commands \|\| ctx\.repo\)/.test(ctxSrc)
    && /if \(ctx\.repo\) parts\.push\(ctx\.repo\)/.test(ctxSrc));
  check('E5 非仓库时不进 project 层（null→空串→整段缺席，与 stack/rules 同一纪律）',
    /repo:\s*repoStatusSection\s*===?\s*''\s*\?\s*undefined/.test(runtimeSrc));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
