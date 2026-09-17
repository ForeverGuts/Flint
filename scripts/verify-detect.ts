/**
 * verify-detect.ts —— 项目准入判据（ROADMAP 10.11.6：保守准入 + 候选兜底）
 *
 * 为什么需要它：这条功能**没有界面**，它的产物是一个**跨会话的持久文件**
 * （`~/.flint/projects.jsonl`）。判错的方向有两个，后果不对称：
 *   · 判宽了（垃圾条目进簿子）—— 通讯录的另一个读者是 `pull_events`，
 *     它按**短名**找项目、重名时**静默**取最先登记的一条。多一条 = 多一分
 *     "模型去 A 拉经验、拉到的是另一个同名项目的档案"的概率，**没人会发现**。
 *   · 判窄了（该记的没记）—— 用户手输一次路径，或 `/projects --add`。
 * 所以判据往"少记"偏，而"少记"的正确性必须逐条钉住：每条分支的正反两组都要有
 * （本仓的老教训：只钉一半时，去掉另一半照样全绿）。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 判据（纯函数，逐分支穷举）—— 四类硬排除 / 三类证据 / 归并 / 候选，
 *      以及**惰性**（不该探 git 的分支传一个"被调用就炸"的探针）
 *   ② 探针（真目录 + 真 git）—— .flint/ / 清单文件真被读到；仓库根与仓库外真被区分
 *   ③ 归一化 —— 大小写 / junction / 不存在的路径；老记录（反斜杠、大小写不符、重复）
 *      载入时合成一行且取最早那条
 *   ④ 登记装配（seedProjectContext 三态 + 显式通道）—— 候选**不写盘**、
 *      归并写的是**仓库根**、候选**照样装载上下文**、显式通道**绕过判据**
 *   ⑤ 源码守护 —— 判据零 import；表示层不碰 IO；探针是唯一起子进程的地方；
 *      启动提示接到 banner，而**非 TTY 不展示**
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-detect.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 * 退出码：failed > 0 → 1
 *
 * 环境依赖：
 *   · ② 依赖"本仓是一个 git 仓库"（用 `rev-parse --show-toplevel` 对拍）；
 *     仓库外那一半用 os.tmpdir() 下的临时目录验。
 *   · ④ 会真的 chdir（家目录 / 临时目录 / 本仓子目录，结束时还原），并把注册表用
 *     `FLINT_PROJECTS_FILE` 重定向到临时文件 —— **绝不碰用户真实的
 *     ~/.flint/projects.jsonl**（那条开关的理由见 registry.ts 的 projectsFilePath）。
 *   · ③ 会建一个 NTFS junction（Windows 上不需要管理员权限；`symlink` 需要，
 *     实测 EPERM，所以只验 junction —— 没实测到的那一半不宣称）。
 *
 * 已知留白（不装糊涂）：**manifest 分支没有端到端**（造不出一个"既不在家目录 /
 * 临时目录 / node_modules，又不在任何 git 仓库里，还不是盘根"的真目录）。
 * 该分支由 ① 的 B9/B11 纯函数用例 + ② 的 C3~C5 探针用例合起来覆盖，
 * 而装配点（`independent → ensure`）只此一处、已由 archive 那条端到端打到。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry, normalizeProjectPath } from '../src/eventlog/registry.js';
import { seedProjectContext } from '../src/harness/project-context.js';
import {
  judgeProject, MANIFEST_FILES, isFsRoot, reasonText,
  type CandidateReason, type ProjectProbes, type ProjectVerdict, type ProjectVia,
} from '../src/project/detect.js';
import { classifyProject, probeProject } from '../src/project/probe.js';
import { renderRegistrationNote } from '../src/project/projects.js';

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

/** 抹掉注释再查（本仓已多次踩"源码文本断言被自己的说明文字判红"） */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** 造一份探针结果（判据是纯函数，所以每条分支都能这样打靶，不必先造真目录） */
const probes = (over: Partial<ProjectProbes> = {}): ProjectProbes => ({
  cwd: 'C:/work/app',
  home: 'C:/Users/me',
  tmp: 'C:/Users/me/AppData/Local/Temp',
  hasArchive: false,
  manifest: null,
  gitRoot: () => null,
  ...over,
});

/**
 * "被调用就炸"的 git 探针 —— 用来钉**惰性**。
 * 比计时稳得多：它不依赖机器快慢，只回答"这条分支到底有没有去探 git"。
 */
const boomGit = (): string | null => { throw new Error('这条分支不该探 git'); };

const isCand = (v: ProjectVerdict, reason?: CandidateReason): boolean =>
  v.kind === 'candidate' && (reason === undefined || v.reason === reason);
const isIndep = (v: ProjectVerdict, via?: ProjectVia): boolean =>
  v.kind === 'independent' && (via === undefined || v.via === via);
const isNested = (v: ProjectVerdict, root?: string): boolean =>
  v.kind === 'nested' && (root === undefined || v.root === root);

/** 跑一段可能抛的代码，返回它有没有抛 */
const throws = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch { return true; }
};

/**
 * 取 `gitRoot()` 的值，同时记下"有没有抛"。
 * **套件自己不许崩**：崩了就没有 `❌` 行，而变异驱动把"一行红都没有"读成"全绿 = 没覆盖"——
 * 一次崩溃会把整条结论反转（本仓的老教训：先验证探针/断言本身，再信它的结论）。
 */
const tryGit = (fn: () => string | null): { ok: boolean; value: string | null } => {
  try { return { ok: true, value: fn() }; } catch { return { ok: false, value: null }; }
};

/* 临时落点：全部建在 WorkBuddy_Test/ 下（本仓内 → 是 git 仓库子目录，这正是 ② 要的环境）。
   注册表另用 os.tmpdir() 下的文件（④ 段）。 */
const scratch = fs.mkdtempSync(path.join(ROOT, 'WorkBuddy_Test', 'detect-'));
/* ⚠ 清理挂在 process 'exit' 上，**不是写在文末的收尾行**。
   顶层脚本没有外层 try 可写 finally，而 'exit' 在「正常收尾 / 中途抛异常崩溃 / 显式
   process.exit()」三种收场都会触发 —— 它就是顶层脚本里的 finally。
   教训很具体：原先那句 rmSync 写在第 496 行，脚本在 ①~⑤ 段任意一处抛异常就整段跑不到，
   于是 WorkBuddy_Test/ 里慢慢积了 85 个空壳 detect-*（被 .gitignore 盖住，只是脏，不影响仓库）。 */
process.on('exit', () => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* 清理失败不掩盖结论 */ }
});
const cwd0 = process.cwd();

/* ════════════════════════════════════════════════════════════════════
   ① 判据 · 硬排除（不看证据，一票否决）
   ════════════════════════════════════════════════════════════════════ */

console.log('── ① 判据 · 硬排除（顺序是承重的：家目录的 ~/.flint 是全局配置目录）──');

check('A1 家目录 → 候选 home（不登记）',
  isCand(judgeProject(probes({ cwd: 'C:/Users/me' })), 'home'));
check('A2 **家目录即使有 .flint/ 也是候选**（~/.flint 是 flint 的全局配置目录，不是项目档案；'
  + '把"看档案"排在排除之前，家目录必然被认成项目）',
  isCand(judgeProject(probes({ cwd: 'C:/Users/me', hasArchive: true })), 'home'));
check('A3 家目录 + 清单文件 → 仍是候选（排除不看证据）',
  isCand(judgeProject(probes({ cwd: 'C:/Users/me', manifest: 'package.json' })), 'home'));
check('A4 临时目录本身 → 候选 tmp',
  isCand(judgeProject(probes({ cwd: 'C:/Users/me/AppData/Local/Temp' })), 'tmp'));
check('A5 临时目录的子目录 → 候选 tmp（前缀即在内）',
  isCand(judgeProject(probes({ cwd: 'C:/Users/me/AppData/Local/Temp/npm/x/y' })), 'tmp'));
check('A6 临时目录里**有档案**也是候选（临时目录会被系统清理，登记它注定是条僵尸记录）',
  isCand(judgeProject(probes({ cwd: 'C:/Users/me/AppData/Local/Temp/proj', hasArchive: true })), 'tmp'));
check('A7 盘根 `C:/` → 候选 fs-root',
  isCand(judgeProject(probes({ cwd: 'C:/' })), 'fs-root'));
check('A8 POSIX 根 `/` → 候选 fs-root（归一化会把它留成 `/`）',
  isCand(judgeProject(probes({ cwd: '/' })), 'fs-root'));
check('A9 反斜杠写法的盘根 `C:\\` → 候选（判据不假设调用方归一化过）',
  isCand(judgeProject(probes({ cwd: 'C:\\' })), 'fs-root'));
check('A10 空串 → 候选 fs-root（宁可判成"不像项目"）',
  isFsRoot('') && isCand(judgeProject(probes({ cwd: '' })), 'fs-root'));
check('A11 node_modules 下的包 → 候选 node_modules（有 package.json 也不作数）',
  isCand(judgeProject(probes({ cwd: 'C:/work/app/node_modules/left-pad', manifest: 'package.json' })), 'node_modules'));
check('A12 反斜杠写法的 node_modules 也认',
  isCand(judgeProject(probes({ cwd: 'C:\\work\\app\\node_modules\\left-pad' })), 'node_modules'));
check('A13 硬排除命中的分支**根本不探 git**（探针传"被调用就炸"）',
  !throws(() => judgeProject(probes({ cwd: 'C:/Users/me', hasArchive: true, gitRoot: boomGit }))));

console.log('\n── ①b 判据 · 边界不能误伤（前缀陷阱 / 段相等）──');
check('A14 `C:/Users/melody` **不是**家目录 `C:/Users/me`（前缀匹配会把整条街都算进家门）',
  !isCand(judgeProject(probes({ cwd: 'C:/Users/melody', home: 'C:/Users/me' })), 'home'));
check('A15 `.../Temporary` **不是**临时目录（同上，必须整段相等）',
  !isCand(judgeProject(probes({ cwd: 'C:/Users/me/AppData/Local/Temporary' })), 'tmp'));
check('A16 `my-node_modules` **不算** node_modules 段（整段相等）',
  !isCand(judgeProject(probes({ cwd: 'C:/work/my-node_modules/pkg' })), 'node_modules'));
check('A17 家目录 / 临时目录取不到（null）时**跳过**这两条排除，判据照常往下走',
  isCand(judgeProject(probes({ cwd: 'C:/work/app', home: null, tmp: null })), 'no-evidence'));

/* ════════════════════════════════════════════════════════════════════
   ① c 判据 · 三类证据 + 归并 + 候选
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ①c 判据 · 三类证据（档案 / 仓库根 / 清单）与归并 ──');

check('B1 有 .flint/ 或 TASK.md → 独立项目（via archive）',
  isIndep(judgeProject(probes({ hasArchive: true })), 'archive'));
check('B2 有档案时**不探 git**（最硬的证据先定案，省一次子进程）',
  !throws(() => judgeProject(probes({ hasArchive: true, gitRoot: boomGit }))));
check('B3 **仓库子目录里若自己有档案 → 仍算独立**（实物证据优先于位置：用户确实在把它当项目用）',
  isIndep(judgeProject(probes({ cwd: 'C:/repo/packages/auth', hasArchive: true, gitRoot: () => 'C:/repo' })), 'archive'));
check('B4 是 git 仓库根 → 独立项目（via git-root）',
  isIndep(judgeProject(probes({ cwd: 'C:/repo', gitRoot: () => 'C:/repo' })), 'git-root'));
check('B5 仓库的子目录（自己没档案）→ 归并（nested，root = 仓库根）',
  isNested(judgeProject(probes({ cwd: 'C:/repo/src', gitRoot: () => 'C:/repo' })), 'C:/repo'));
check('B6 大小写不同但同一个仓库 → 仍判独立（Windows 路径不区分大小写，折过再比）',
  isIndep(judgeProject(probes({ cwd: 'C:/Repo', gitRoot: () => 'c:/repo' })), 'git-root'));
check('B7 反斜杠写法也能对上（判据不假设调用方归一化过）',
  isIndep(judgeProject(probes({ cwd: 'C:\\Repo', gitRoot: () => 'C:/repo' })), 'git-root'));
check('B8 **仓库子目录里的清单文件不作数**（否则 monorepo 的每个子包都会进簿子）',
  isNested(judgeProject(probes({
    cwd: 'C:/repo/packages/auth', manifest: 'package.json', gitRoot: () => 'C:/repo',
  }))));
check('B9 不在任何仓库里 + 有清单 → 独立项目（via manifest）',
  isIndep(judgeProject(probes({ manifest: 'pyproject.toml' })), 'manifest'));
check('B10 什么都没有 → 候选（no-evidence，不写盘）',
  isCand(judgeProject(probes()), 'no-evidence'));
check('B11 没有 git 时的降级是**往保守偏**：有清单仍独立，无清单则候选',
  isIndep(judgeProject(probes({ manifest: 'go.mod', gitRoot: () => null })))
  && isCand(judgeProject(probes({ gitRoot: () => null })), 'no-evidence'));
check('B12 归并只在"没继承仓库"时判（gitRoot 为空串也算没有）',
  isCand(judgeProject(probes({ gitRoot: () => '' })), 'no-evidence'));

check('C1 MANIFEST_FILES 克制到五个（requirements.txt / Makefile 之类在子目录里遍地都是）',
  MANIFEST_FILES.length === 5, MANIFEST_FILES.join(','));
check('C2 每个候选理由都有中文说明（回执与启动提示共用的那一句）',
  (['home', 'tmp', 'fs-root', 'node_modules', 'no-evidence'] as const)
    .every((r) => reasonText(r).length > 0));

console.log('\n── ①d 提示文案（启动 banner 与 `/projects` 列表共用同一份）──');
check('C3 判成**独立项目 → 不提示**（绝大多数启动不该有任何提示 —— 提示只该在"你可能好奇它为什么没进簿子"时出现）',
  renderRegistrationNote({ kind: 'independent', path: 'C:/work/app', via: 'archive' }) === null
  && renderRegistrationNote({ kind: 'independent', path: 'C:/work/app', via: 'explicit' }) === null);
{
  const n = renderRegistrationNote({ kind: 'candidate', path: 'C:/work/app', reason: 'no-evidence' }) ?? '';
  check('C4 候选 → 说清理由 + 怎么登记，且**拆成两行**（拼一行会被 banner 的 fitWidth 截掉后半截 = 截掉"怎么做"）',
    n.includes('没进通讯录') && n.includes('要登记它：/projects --add') && n.includes('\n'));
}
{
  const n = renderRegistrationNote({ kind: 'nested', path: 'C:/repo/src/io', root: 'C:/repo' }) ?? '';
  check('C5 归并 → 说清"是哪个项目的子目录"与"按哪个项目记账"',
    n.includes('子目录') && n.includes('repo') && n.includes('src/io'));
}

/* ════════════════════════════════════════════════════════════════════
   ② 探针（真目录 + 真 git）
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ② 探针 · 真目录上读到什么 ──');

const emptyDir = path.join(scratch, 'empty');
const archiveDir = path.join(scratch, 'with-archive');
const manifestDir = path.join(scratch, 'with-manifest');
const bothDir = path.join(scratch, 'with-both');
const taskOnlyDir = path.join(scratch, 'task-only');
for (const d of [emptyDir, archiveDir, manifestDir, bothDir, taskOnlyDir]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(archiveDir, '.flint'), { recursive: true });
fs.writeFileSync(path.join(archiveDir, 'TASK.md'), '- [ ] 甲\n', 'utf-8');
fs.writeFileSync(path.join(taskOnlyDir, 'TASK.md'), '- [ ] 只有清单没有 .flint\n', 'utf-8');
fs.writeFileSync(path.join(manifestDir, 'package.json'), '{}\n', 'utf-8');
fs.writeFileSync(path.join(bothDir, 'pyproject.toml'), '[project]\n', 'utf-8');
fs.mkdirSync(path.join(bothDir, '.flint'), { recursive: true });
fs.writeFileSync(path.join(bothDir, 'package.json'), '{}\n', 'utf-8');

check('D1 空目录：档案与清单都为假',
  probeProject(emptyDir).hasArchive === false && probeProject(emptyDir).manifest === null);
check('D2 `.flint/` 存在 → hasArchive（TASK.md 同样算，下面 D3 的目录两者都有）',
  probeProject(archiveDir).hasArchive === true);
check('D3 清单文件被认出来（package.json）',
  probeProject(manifestDir).manifest === 'package.json');
check('D4 清单按 MANIFEST_FILES 的次序取最先命中的那个（package.json 排在最前，所以是它）',
  probeProject(bothDir).manifest === 'package.json', String(probeProject(bothDir).manifest));
check('D5 探针同时报出档案与清单（两条证据不互斥）', probeProject(bothDir).hasArchive === true);

{
  const g = tryGit(() => probeProject(ROOT).gitRoot());
  check('D6 git：仓库根被 `rev-parse --show-toplevel` 正确读出（归一化后与 ROOT 一致）',
    g.ok && g.value === normalizeProjectPath(ROOT), g.ok ? String(g.value) : '抛异常');
}
{
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-detect-outside-'));
  try {
    const g = tryGit(() => probeProject(outside).gitRoot());
    check('D7 git：仓库之外返回 null 且**不抛**（认不出即丢弃 → 最多判成候选，从不变成垃圾条目）',
      g.ok && g.value === null, g.ok ? String(g.value) : '抛异常');
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}
check('D8 classifyProject(本仓根) → 独立项目（本仓有 package.json / .flint，两者都够）',
  classifyProject(ROOT).kind === 'independent', JSON.stringify(classifyProject(ROOT)));
check('D9 classifyProject(本仓子目录 src) → 归并到仓库根（子目录不单独占一行）',
  isNested(classifyProject(path.join(ROOT, 'src')), normalizeProjectPath(ROOT)),
  JSON.stringify(classifyProject(path.join(ROOT, 'src'))));
check('D10 classifyProject(家目录) → 候选 home',
  isCand(classifyProject(os.homedir()), 'home'), JSON.stringify(classifyProject(os.homedir())));
check('D11 classifyProject(临时目录) → 候选 tmp',
  isCand(classifyProject(os.tmpdir()), 'tmp'), JSON.stringify(classifyProject(os.tmpdir())));

{
  // 复现"要堵的那个口子"的真实前提：家目录下**确实**有 .flint/（那是 flint 的全局配置目录）。
  // 前提不成立（从没用过 flint）时不断言它，但两种情况都计一项，项数才不会浮动。
  const homeHasArchive = probeProject(os.homedir()).hasArchive;
  check(homeHasArchive
    ? 'D12 家目录下**确实**有 .flint/（全局配置目录），判据仍判它候选 —— 这就是 10.11.6 堵的那个口子'
    : 'D12 家目录下还没有 .flint/（全局配置目录尚未创建），前提不成立 → 记为通过',
    homeHasArchive ? isCand(classifyProject(os.homedir()), 'home') : true);
}

check('D13 `TASK.md` **单独**也算实物档案（清单落在 cwd 根而不是 .flint/ 下，两个落点都得认）',
  probeProject(taskOnlyDir).hasArchive === true && probeProject(taskOnlyDir).manifest === null);

{
  // git 不在 PATH 上：必须**快且不抛**（认不出即丢弃 → 最多判成候选，不炸启动）。
  // 这不是假想场景：本仓的 git 由 PortableGit 提供，换台机器就未必有（实测 ENOENT 3ms）。
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const g = tryGit(() => probeProject(path.join(ROOT, 'src')).gitRoot());
    check('D14 git 不可用（PATH 里没有）→ 探针返回 null 且**不抛**（降级到"没有这个证据"）',
      g.ok && g.value === null, g.ok ? String(g.value) : '抛异常');
  } finally { process.env.PATH = savedPath; }
}

/* ════════════════════════════════════════════════════════════════════
   ③ 归一化（大小写 / junction / 老记录升级）
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ③ 归一化 · 同一个项目不许占两行 ──');

const normRoot = normalizeProjectPath(ROOT);
check('E1 大小写归一成磁盘上的真实形态（`C:/foo` 与 `C:/Foo` 是同一个项目）',
  normalizeProjectPath(ROOT.toUpperCase()) === normRoot
  && normalizeProjectPath(ROOT.toLowerCase()) === normRoot);
check('E2 反斜杠 / 尾斜杠 / 混合写法 → 同一结果',
  normalizeProjectPath(ROOT.replace(/\//g, '\\')) === normRoot
  && normalizeProjectPath(`${ROOT}/`) === normRoot
  && normalizeProjectPath(`${ROOT.toUpperCase()}\\`) === normRoot);
check('E3 不存在的路径 → 退回字面形态（**不抛**：注册表里全是"目录早被删了"的行）',
  !throws(() => normalizeProjectPath(path.join(ROOT, 'no-such-xyz')))
  && normalizeProjectPath(path.join(ROOT, 'no-such-xyz')).endsWith('/no-such-xyz'));
check('E4 相对路径先绝对化（项目身份是绝对路径）',
  normalizeProjectPath('.') === normRoot);

{
  // junction：实测同一目录经 junction 进来时 `process.cwd()` **报的是别名**，
  // 所以"只做字符串处理"挡不住这类重复，必须真解引用（.native）。
  // symlink 在 Windows 上要管理员权限（实测 EPERM），故只验 junction —— 没实测到的不宣称。
  const junc = path.join(scratch, 'junc-to-root');
  let created = false;
  try { fs.symlinkSync(ROOT, junc, 'junction'); created = true; } catch { /* 平台不支持则跳过 */ }
  try {
    check(created
      ? 'E5 junction 归一成**真实目标**（同一个目录经别名进来不占第二行）'
      : 'E5 本平台建不了 junction → 记为通过（这条只在 Windows 上可验）',
      created ? normalizeProjectPath(junc) === normRoot : true);
    check('E6 junction 的判据结论与真实路径一致（连 verdict 里的 path 也是真实路径）',
      !created || JSON.stringify(classifyProject(junc)) === JSON.stringify(classifyProject(ROOT)));
  } finally { try { fs.rmSync(junc); } catch { /* 清理失败不掩盖结论 */ } }
}

{
  // 老记录升级：反斜杠 / 大小写不符 / 完全重复 —— 三条指向同一个真目录，读进来必须并成一行。
  // 去重放**读侧**（不回写文件，记录是足迹不是状态），所以这条用例不打桩磁盘写入。
  const regFile = path.join(scratch, 'legacy.jsonl');
  const rec = (p: string, name: string, firstSeen: string): string =>
    JSON.stringify({ path: p, name, firstSeen });
  fs.writeFileSync(regFile, [
    rec(ROOT.replace(/\//g, '\\'), 'old-backslash', '2026-01-01T00:00:00.000Z'),
    rec(ROOT.toUpperCase(), 'old-case', '2026-01-02T00:00:00.000Z'),
    rec(normRoot, 'old-dup', '2026-01-03T00:00:00.000Z'),
    rec(path.join(ROOT, 'gone-a'), 'gone-a', '2026-01-04T00:00:00.000Z'),
    rec(path.join(ROOT, 'gone-b'), 'gone-b', '2026-01-05T00:00:00.000Z'),
  ].join('\n') + '\n', 'utf-8');
  process.env.FLINT_PROJECTS_FILE = regFile;
  try {
    const reg = new ProjectRegistry();
    check('E7 老记录（反斜杠 / 大小写不符 / 重复行）载入后**合成一行** —— 老文件不必迁移也立刻正确',
      reg.list().length === 3, `实际 ${reg.list().length} 行`);
    check('E8 合成后取**最先登记**的那条（名字与 firstSeen 都留最早的）',
      reg.list().find((r) => r.path === normRoot)?.name === 'old-backslash',
      JSON.stringify(reg.list().map((r) => r.name)));
    check('E9 去重只合"同一个目录的两种写法"：两条**不同**的僵尸路径仍是两行（不许合错）',
      reg.list().filter((r) => r.name.startsWith('gone-')).length === 2);
    check('E10 归一化后能与当前目录对上（has）', reg.has(ROOT) && reg.has(ROOT.toLowerCase()));
    check('E11 has 对没登记过的路径是 false', !reg.has(path.join(ROOT, 'src')));
    check('E12 has 是只读的：问过之后文件没有被改写（记录是足迹）',
      fs.readFileSync(regFile, 'utf-8').split('\n').filter(Boolean).length === 5);
  } finally {
    delete process.env.FLINT_PROJECTS_FILE;
  }
}

/* ════════════════════════════════════════════════════════════════════
   ④ 登记装配（seedProjectContext 三态 + 显式通道）
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ④ 登记装配 · 候选不写盘 / 归并写仓库根 / 显式绕过判据 ──');

const regTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-detect-reg-'));
const regFile2 = path.join(regTmp, 'projects.jsonl');
fs.writeFileSync(regFile2, '', 'utf-8');
process.env.FLINT_PROJECTS_FILE = regFile2;
/**
 * 注册表里的 path 列表 —— **逐行精确比对，绝不用 includes**。
 * 必须精确的理由很具体：下面这些临时目录全都位于家目录 / 本仓之下，
 * 而"文件内容里含不含某个前缀"用子串判是**恒真**的（任何一行都以家目录开头）——
 * 于是 F2 会恒假、F11 会恒真，两条断言一起变成摆设。
 * 本仓的老教训：能给出"一致结论"的断言，先验证断言本身。
 */
const regPaths = (): string[] => fs.readFileSync(regFile2, 'utf-8')
  .split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { path: string }).path);
const registered = (p: string): boolean => regPaths().includes(normalizeProjectPath(p));

/** 临时目录里的"项目"（有 TASK.md）—— 用来证明**硬排除优先于档案**、且候选照样装载上下文 */
const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-detect-tmp-'));
fs.writeFileSync(path.join(tmpProj, 'TASK.md'), '- [ ] 临时目录里的待办\n- [x] 已完成一条\n', 'utf-8');

try {
  // ── 候选：家目录 ──
  process.chdir(os.homedir());
  const rHome = seedProjectContext();
  check('F1 家目录启动 → 判成候选 home',
    isCand(rHome.verdict, 'home'), JSON.stringify(rHome.verdict));
  check('F2 **候选不写盘**：通讯录里没有家目录那一行（这条就是老行为的 bug 现场）',
    !registered(os.homedir()), regPaths().join(' | '));

  // ── 候选：临时目录（且硬排除优先于档案）──
  process.chdir(tmpProj);
  const rTmp = seedProjectContext();
  check('F3 临时目录里的项目 → 仍是候选 tmp（硬排除优先于"有档案"）',
    isCand(rTmp.verdict, 'tmp'), JSON.stringify(rTmp.verdict));
  check('F4 **候选照样装载上下文**（"登记进通讯录"与"把项目装进内存"是两件事：'
    + '用户就在这儿干活，只是不写跨项目检索的簿子）',
    rTmp.task === 1, `task=${rTmp.task}`);
  check('F5 候选不写盘（第二次：到这儿通讯录应当**一行都还没有**）',
    !registered(tmpProj) && regPaths().length === 0);

  // ── 显式通道：绕过判据 ──
  const rExplicit = seedProjectContext({ register: 'explicit' });
  check('F6 显式通道**绕过判据**：刚判成候选的目录也被登记了（用户点名了就算数）',
    rExplicit.verdict.via === 'explicit' && registered(tmpProj),
    JSON.stringify(rExplicit.verdict));
  {
    const before = regPaths().length;
    seedProjectContext({ register: 'explicit' });
    check('F7 显式登记**幂等**（同一个目录不会写第二行）', regPaths().length === before);
  }

  // ── 独立项目：有档案 → 写盘 ──
  process.chdir(archiveDir);
  const rArchive = seedProjectContext();
  check('F8 有 .flint/ 的目录 → 独立项目（archive）并**写盘**',
    isIndep(rArchive.verdict, 'archive') && registered(archiveDir),
    JSON.stringify(rArchive.verdict));
  check('F9 登记的是归一化后的真实路径（反斜杠 / 大小写都折过 —— process.cwd() 原样带反斜杠）',
    !fs.readFileSync(regFile2, 'utf-8').includes('\\'), '注册表里出现了反斜杠');

  // ── 归并：仓库子目录 → 写仓库根 ──
  process.chdir(emptyDir);
  const rNested = seedProjectContext();
  check('F10 仓库子目录（自己没档案）→ 归并到**仓库根**',
    isNested(rNested.verdict, normRoot), JSON.stringify(rNested.verdict));
  check('F11 归并写进去的是仓库根、**不是那个子目录**（否则每个子目录都会占一行）',
    registered(normRoot) && !registered(emptyDir), regPaths().join(' | '));
  check('F12 归并也幂等：再播种一次，行数不变',
    (() => {
      const before = regPaths().length;
      seedProjectContext();
      return regPaths().length === before;
    })());
} finally {
  process.chdir(cwd0);
  delete process.env.FLINT_PROJECTS_FILE;
  fs.rmSync(regTmp, { recursive: true, force: true });
  fs.rmSync(tmpProj, { recursive: true, force: true });
}

/* ════════════════════════════════════════════════════════════════════
   ⑤ 源码守护
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑤ 源码守护 ──');

const detectSrc = read('src/project/detect.ts');
const probeSrc = read('src/project/probe.ts');
const layerSrc = read('src/project/projects.ts');
const seedSrc = read('src/harness/project-context.ts');
const cmdSrc = read('src/commands/builtin/projects.ts');
const mainSrc = read('src/harness/main.ts');
const treeSrc = read('src/io/ui/tree-ui.ts');
const termSrc = read('src/io/ui/index.ts');

check('G1 判据模块**零 import**（不碰磁盘、不起进程 —— 于是每条分支都能穷举打靶）',
  !/^import\s/m.test(detectSrc));
check('G2 表示层只 import 同层纯判据（列表与提示于是可以逐字校验，不必真起进程）',
  (() => {
    const imports = stripComments(layerSrc).match(/^import[^\n]*$/gm) ?? [];
    return imports.length > 0 && imports.every((l) => l.includes("'./detect.js'"));
  })(), (stripComments(layerSrc).match(/^import[^\n]*$/gm) ?? []).join(' | '));
check('G3 探针是**唯一**起子进程 / 读磁盘的地方（判据与表示层都碰不到）',
  probeSrc.includes("from 'node:child_process'")
  && !stripComments(detectSrc).includes('child_process')
  && !stripComments(layerSrc).includes('child_process'));
check('G4 登记走**判据**而不是无条件写：播种里 classifyProject 在场，ensure 只在三态各自的分支里',
  stripComments(seedSrc).includes('classifyProject(')
  && (stripComments(seedSrc).match(/projectRegistry\.ensure\(/g) ?? []).length === 3);
check('G5 显式通道确实绕开了判据（`--switch` 传 register: explicit；`--add` 直接 ensure）',
  (stripComments(cmdSrc).match(/register: 'explicit'/g) ?? []).length === 1
  && stripComments(cmdSrc).includes("seedProjectContext({ register: 'explicit' })"));
check('G6 模型的路径碰不到准入判据（tools/ 与 loop/ 零引用 —— 写跨会话文件的判断不许交给模型）',
  !read('src/tools/builtin.ts').includes('classifyProject')
  && !read('src/tools/builtin.ts').includes('judgeProject')
  && !read('src/loop/agent-loop.ts').includes('classifyProject'));
check('G7 启动提示接到了 banner（main 渲染 → TreeUI 消费）',
  stripComments(mainSrc).includes('renderRegistrationNote(seed.verdict)')
  && treeSrc.includes('this.info.projectNote'));
check('G8 非 TTY（管道）**不展示**提示（管道输出要能直接被脚本消费，诊断都不展示）',
  !stripComments(termSrc).includes('projectNote'));
check('G9 `/projects --add` 是显式通道（判不出来的由人拍板），且**不切 cwd**',
  cmdSrc.includes("parsed.action === 'add'") && layerSrc.includes("'--add'"));
check('G10 提示只在"没进通讯录"时才出现（已在册再提示"没进"就是错的）',
  stripComments(cmdSrc).includes('rows.some((r) => r.current)'));

/* ── 清扫 ── */

/* scratch 的删除挂在开头的 process 'exit' 钩子上（见 ① 段前的注释），此处不再重复一句
   —— 两处并存会让人误以为文末那句才是真闸。 */

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
