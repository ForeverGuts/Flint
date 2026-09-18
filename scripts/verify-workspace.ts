/**
 * verify-workspace.ts —— 工作区外写保护（ROADMAP 10.9.3）
 *
 * 验什么（手段与行为分开钉）：
 *   ① 路径包含判定 `isUnder` —— 逐形状正反各一组。这一段的形状**全部来自探针实测**：
 *      · 兄弟目录 `Ts_Agent2` 的字符串前缀就是 `Ts_Agent`，故判据**不许**用前缀匹配（A5/A6）
 *      · 跨盘与 UNC 让 `path.relative` 直接返回绝对路径（A9/A10）
 *      · 名叫 `..foo` 的文件**在内部**，只写 `startsWith('..')` 会误伤（A4）
 *   ② `isOutsideWorkspace` —— 内部 / 外部逐形状；放行表含子树、不向上传染、不横向拓宽；
 *      `~` 与 MSYS 形式**刻意不展开**（B14/B16：它们不是漏拦，是"没碰外面"）
 *   ③ `guardWorkspaceWrite` —— 只认有目标路径参数的那两个工具（bash 在**外面**，C4 记着边界）、
 *      参数形状逐形状 fail-open、注入的 cwd 与放行表**真的被用上**（C12/C14）
 *   ④ 拒因文案 —— 读的人（模型）要靠它自救：标记 / 没执行 / 绝对路径 / 工作区根 /
 *      三条出路的钥匙 / 自认边界；以及"字面量等于解析结果时不许重复印"（D8/D9）
 *   ⑤ 放行表 `workspaceGrants` —— 归一化、去重、副本语义、清空
 *   ⑥ `/workspace` 命令 —— 三态回执 + 带空格的路径 + 不存在目录的提醒 + 宽范围提醒**正反对照**
 *   ⑦ 源码守护 —— 四闸顺序、注册时机、零项目依赖、纯函数、唯一实现、**唯一开门口**、
 *      `..` 判据带分隔符、判据里没有 `homedir`（`~` 不展开是判据性质，不是文档承诺）
 *   ⑧ 真目录 + 真 PromptEventEmitter 四闸链 —— 真造一棵树当工作区；
 *      并证明**新加的这一环没把前三环挤掉**（契约闸 / 危险闸 / git 路由各自仍生效）
 *
 * 一条设计选择值得单说：**行为级"闸序"在这里是**测得到**的，但**不需要**像危险闸那样
 * 造"同一条调用同时命中两道闸"的用例 —— 四道闸的**域刻意不重叠**（契约按文件、危险按 bash、
 * 工作区按 write/edit 的路径、路由按 bash）。所以顺序只能靠源码位置钉（G3），
 * 而"域不重叠"本身用 H12-H15 逐条记录：新环接上之后，旧环一条都没被遮住。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-workspace.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeDeny } from '../src/loop/tool-hooks.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { charterLock, guardContractWrite } from '../src/project/charter.js';
import { guardDangerousCommand } from '../src/permission/danger.js';
import {
  GUARDED_WRITE_TOOLS,
  WORKSPACE_MARK,
  guardWorkspaceWrite,
  isOutsideWorkspace,
  isUnder,
  renderWorkspaceReason,
  workspaceGrants,
  type WorkspaceContext,
} from '../src/permission/workspace.js';
import { routeBashGitRead } from '../src/git/route.js';
import { activate as activateWorkspace } from '../src/commands/builtin/workspace.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

// ⚠ **必须把授权持久化文件重定向到临时目录**（ROADMAP 10.9.1）：`/workspace clear` 现在
//   会**连盘一起清**，而 F14/F15 就在敲它 —— 不重定向的话，跑一次套件就会把**用户真实的**
//   `~/.flint/permissions.json` 里本项目那一份长期放行删掉，一次静默的数据丢失。
//   与 `FLINT_PROJECTS_FILE`（verify-projects）同一手法：**用的时候现读环境变量**，
//   所以在这里（import 之后）设也来得及。
process.env.FLINT_PERMISSIONS_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ws-perm-')), 'permissions.json');

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

/** 判据的注入上下文（假目录，不碰真盘）—— 与真机无关，故两个平台跑出来的结论一致 */
const CWD = isWin ? 'C:/work/proj' : '/work/proj';
const ctx = (grants: readonly string[] = []): WorkspaceContext => ({ cwd: CWD, grants });
/** 一句话判定：命中返回 true（就是"在工作区之外"） */
const out = (target: string, grants: readonly string[] = []): boolean =>
  isOutsideWorkspace(target, ctx(grants));

/** 平台无歧义的"绝对在工作区外"的目标（盘根下一个子目录 / 文件系统根下一个子目录） */
const OUTSIDE = path.join(path.parse(process.cwd()).root, 'flint-verify-workspace-outside', 'x.ts');

/* ── ① 路径包含判定 ── */
console.log('── ① 路径包含判定 isUnder（形状全部来自探针实测）──');

check('A1 就是自己 → 内部', isUnder(CWD, CWD));
check('A2 直接子目录 → 内部', isUnder(CWD, `${CWD}/src`));
check('A3 深层子路径 → 内部', isUnder(CWD, `${CWD}/src/deep/a.ts`));
check('A4 名叫 `..foo` 的子文件 → **内部**（名字以两个点开头，但不是上级）',
  isUnder(CWD, `${CWD}/..foo`));
check('A5 ⚠ 兄弟目录 → **外部**（字符串前缀会把它判成内部，探针实测）',
  !isUnder(CWD, isWin ? 'C:/work/proj2' : '/work/proj2'));
check('A6 ⚠ 名字更长、前缀相同的兄弟 → 外部（`Ts_Agent` 与 `Ts_Agent2` 那类）',
  !isUnder(CWD, isWin ? 'C:/work/proj-extra' : '/work/proj-extra'));
check('A7 上级 → 外部', !isUnder(CWD, isWin ? 'C:/work' : '/work'));
check('A8 上级的上级 → 外部', !isUnder(CWD, isWin ? 'C:/' : '/'));
check('A9 跨盘 → 外部（relative 给不出相对路径）',
  isWin ? !isUnder(CWD, 'D:/other/x') : !isUnder(CWD, '/mnt/other/x'));
check('A10 UNC 共享根 → 外部', !isUnder(CWD, '//server/share/x'));
check('A11 反斜杠写法 → 归一后仍是内部',
  isWin ? isUnder(CWD, 'C:\\work\\proj\\src\\a.ts') : isUnder(CWD, `${CWD}/src/a.ts`));
check('A12 大小写：win32 算内部（path.relative 自带归一），POSIX 算外部（路径大小写敏感）',
  isUnder(CWD, isWin ? 'c:/WORK/PROJ/src' : CWD + '/src'));
check('A13 带 `.` 段 → 归一后仍是内部', isUnder(CWD, `${CWD}/./src/./a.ts`));
check('A14 尾斜杠写法 → 仍是内部', isUnder(CWD, `${CWD}/src/`));
// ⚠ 不要拿空串测 `isUnder`：空串归到的是**真** process.cwd()，而这里的 CWD 是假目录，
//   于是它必然"外部"—— 那测的是 path.resolve('') 的语义，不是包含判定的语义。
//   空串该测的地方是 `isOutsideWorkspace`（它先 resolve(cwd, target)，B16 钉着）。

/* ── ② 工作区外判定 ── */
console.log('── ② isOutsideWorkspace：内部 / 外部 / 放行表 ──');

check('B1 相对路径（项目内）→ 内部', !out('src/a.ts'));
check('B2 绝对路径（项目内）→ 内部', !out(`${CWD}/src/a.ts`));
check('B3 `./` 前缀 → 内部', !out('./src/a.ts'));
check('B4 绕一圈仍在内部（`sub/../x`）→ 内部', !out('sub/../x.ts'));
check('B5 `..foo` → 内部', !out('..foo'));
check('B6 `..` → 外部', out('..'));
check('B7 `../x` → 外部', out('../x.ts'));
check('B8 `../../x` → 外部', out('../../x.ts'));
check('B9 兄弟目录（绝对）→ 外部', out(isWin ? 'C:/work/other/x.ts' : '/work/other/x.ts'));
check('B10 家目录 → 外部', out(path.join(os.homedir(), 'z.ts')));
check('B11 盘根 → 外部', out(path.parse(process.cwd()).root));
check('B12 跨盘 → 外部', isWin ? out('D:/x/y.ts') : out('/mnt/elsewhere/y.ts'));
check('B13 UNC → 外部', out('//server/share/y.ts'));
check('B14 ⚠ `~` **不展开**（判成内部是对的：写的是 cwd 下那个叫 `~` 的目录，没碰家目录）',
  !out('~/x.ts') && !out('~'));
// ⚠ 这条初稿的方向写反了（"会被判成内部"）—— 实测是**外部**：`path.resolve` 把开头的 `/`
//   读成"当前盘的根"，于是 `/c/Users/...` 变成 `C:\c\Users\...`，落在工作区外面。
//   方向其实更好：得到一句**带完整解释的拒**，而不是静默误解成"内部的某个文件"。
check('B15 ⚠ MSYS 形式 `/c/...` 不认（与 read 同口径）→ 判成**外部**，得一句可见的拒',
  out('/c/Users/31075/x.ts'));
check('B16 空串 → cwd 自己 → 内部', !out(''));

check('B17 放行目录本身 → 内部', !out('/granted/a.ts', ['/granted']));
check('B18 放行目录的直接子 → 内部', !out('/granted/sub/a.ts', ['/granted']));
check('B19 放行目录的深层子 → 内部', !out('/granted/sub/deep/a.ts', ['/granted']));
check('B20 放行目录的兄弟 → 外部（放行不横向拓宽）', out('/granted2/a.ts', ['/granted']));
check('B21 放行目录的上级 → 外部（放行不向上传染）', out('/a.ts', ['/granted']));
check('B22 放行目录的父路径前缀相同者 → 外部（`/grant` vs `/granted`）',
  out('/grant/a.ts', ['/granted']));
check('B23 多个放行目录各自生效', !out('/g1/a.ts', ['/g1', '/g2']) && !out('/g2/b.ts', ['/g1', '/g2']));
check('B24 放行表为空 → 只有工作区内部', out('/granted/a.ts', []));
check('B25 放行表里的表项带尾斜杠也照旧生效', !out('/granted/a.ts', ['/granted/']));

/* ── ③ 钩子适配器 ── */
console.log('── ③ guardWorkspaceWrite：工具面与 fail-open ──');

check('C1 write + 工作区内 → 放行', guardWorkspaceWrite('write', { path: 'src/a.ts' }, ctx()) === undefined);
check('C2 write + 工作区外 → deny', guardWorkspaceWrite('write', { path: OUTSIDE }, ctx())?.action === 'deny');
check('C3 edit + 工作区外 → deny', guardWorkspaceWrite('edit', { path: OUTSIDE }, ctx())?.action === 'deny');
check('C4 ⚠ bash + 工作区外 → **放行**（刻意不进：命令串里判不出读还是写，写在头注）',
  guardWorkspaceWrite('bash', { command: `echo x > ${OUTSIDE}` }, ctx()) === undefined);
for (const t of ['read', 'ls', 'grep', 'todo', 'memory', 'record_event', 'archive', 'ask', 'git', 'pull_events']) {
  check(`C5:${t} 不在闸内（非写类工具一律放行）`,
    guardWorkspaceWrite(t, { path: OUTSIDE }, ctx()) === undefined);
}
check('C6 args 为 null → 放行', guardWorkspaceWrite('write', null, ctx()) === undefined);
check('C7 args 是字符串 → 放行', guardWorkspaceWrite('write', 'C:/x', ctx()) === undefined);
check('C8 args 里没有 path 字段 → 放行', guardWorkspaceWrite('write', { content: 'x' }, ctx()) === undefined);
// ⚠ 这一条同时是"**别让套件崩掉**"的守卫：去掉 fail-open 里的"非字符串"检查之后，
//   `path.resolve(cwd, 42)` 会当场抛（变异 M14 实测）。故这里自己 catch ——
//   把"整个套件死在半路"降级成"这一条失败"，后者信息量大得多（崩溃会连带藏掉后面所有断言）。
check('C9 path 不是字符串 → 放行（fail-open 同时是防崩：path.resolve 拿到数字会抛）',
  (() => {
    try { return guardWorkspaceWrite('write', { path: 42 }, ctx()) === undefined; } catch { return false; }
  })());
check('C10 path 是空串 → 放行（不是"cwd 自己"被误当成一个具体文件）',
  guardWorkspaceWrite('write', { path: '' }, ctx()) === undefined);
// 空白路径**不需要特判**：它 resolve 之后落在工作区之内，判据自然放行。
// 原来判据里有一支 `target.trim() === ''`，被变异 M14 的探针照出"永远改不了结论"→ 已删。
// 这条断言留着是**登记那个结论**，免得日后有人"顺手补回去"。
check('C11 path 全空白 → 放行（resolve 后在工作区内，无需特判；原 trim 分支已按实证删除）',
  guardWorkspaceWrite('write', { path: '   ' }, ctx()) === undefined);

// ⚠ 用**绝对**目标才测得出"换 cwd 就换结论"：相对路径在**任何** cwd 下都落在自己内部，
//   拿相对路径测等于什么都没测（初稿就是这么写的，被首跑逮住）。
check('C12 注入的 cwd 真的被用上：同一个 args，换 cwd 就换结论',
  guardWorkspaceWrite('write', { path: `${CWD}/src/a.ts` }, { cwd: '/other', grants: [] })?.action === 'deny'
  && guardWorkspaceWrite('write', { path: `${CWD}/src/a.ts` }, ctx()) === undefined);

// 缺省 ctx 走真 cwd（真机仓库根）+ 模块级放行表
workspaceGrants.clear();
check('C13 缺省 ctx 取真 cwd：真工作区外的绝对路径被拒，真工作区内的相对路径放行',
  guardWorkspaceWrite('write', { path: OUTSIDE })?.action === 'deny'
  && guardWorkspaceWrite('write', { path: 'WorkBuddy_Test/zzz.ts' }) === undefined);
check('C14 缺省 ctx 读的是模块级放行表：放行后同一目标放行，清空后重新被拒',
  (() => {
    workspaceGrants.allow(path.dirname(OUTSIDE));
    const allowed = guardWorkspaceWrite('write', { path: OUTSIDE }) === undefined;
    workspaceGrants.clear();
    const back = guardWorkspaceWrite('write', { path: OUTSIDE })?.action === 'deny';
    return allowed && back;
  })());

/* ── ④ 拒因文案 ── */
console.log('── ④ 拒因文案（模型要靠它自救）──');

const reason = renderWorkspaceReason(isWin ? 'C:/work/other/x.ts' : '/work/other/x.ts', ctx());
check('D1 以标记开头（套件与用户都靠它认出是这道闸）', reason.startsWith(WORKSPACE_MARK));
check('D2 明说"没有被执行"（别让模型以为写了一半）', reason.includes('没有被执行'));
check('D3 印出解析后的绝对路径', reason.includes(isWin ? 'C:\\work\\other\\x.ts' : '/work/other/x.ts'));
check('D4 印出工作区根', reason.includes(path.resolve(CWD)) || reason.includes(CWD.replace(/\//g, path.sep)));
check('D5 给出第二条出路的钥匙 `/workspace allow`', reason.includes('/workspace allow'));
check('D6 给出第三条出路（读不受影响 → 用 read）', reason.includes('read'));
check('D7 末段自认边界：提到 bash 与"不是沙箱"', reason.includes('bash') && reason.includes('不是沙箱'));
check('D8 字面量等于解析结果时**不重复印**（少一行噪音）',
  !renderWorkspaceReason(isWin ? 'C:/work/other/x.ts' : '/work/other/x.ts', ctx()).includes('解析后 ='));
check('D9 字面量是相对/怪写法时**两边都印**（否则读的人不知道落到哪）',
  renderWorkspaceReason('../other/x.ts', ctx()).includes('解析后 ='));
check('D10 是给模型读的多行说明（≥6 行）', reason.split('\n').length >= 6);

/* ── ⑤ 放行表 ── */
console.log('── ⑤ 放行表 workspaceGrants ──');

workspaceGrants.clear();
check('E1 初始为空（前置：后面几条才有意义）', workspaceGrants.list().length === 0);
const g1 = workspaceGrants.allow('rel/dir');
check('E2 allow 归一化成绝对路径并返回', path.isAbsolute(g1) && g1 === path.resolve('rel/dir'));
check('E3 list 拿到的是副本（改返回值不影响状态）',
  (() => { workspaceGrants.list().push('/bogus'); return workspaceGrants.list().length === 1; })());
check('E4 同一路径重复 allow → 去重', (() => {
  workspaceGrants.allow('rel/dir');
  return workspaceGrants.list().length === 1;
})());
check('E5 换一种写法指向同一目录 → 仍去重（反斜杠 / 尾斜杠 / `.` 段）',
  (() => {
    workspaceGrants.allow(isWin ? 'rel\\dir\\' : 'rel/dir/');
    workspaceGrants.allow('rel/./dir');
    return workspaceGrants.list().length === 1;
  })());
check('E6 多个不同目录 → 按放行顺序保留',
  (() => {
    workspaceGrants.allow('/second');
    const l = workspaceGrants.list();
    return l.length === 2 && l[0] === g1 && l[1] === path.resolve('/second');
  })());
check('E7 clear 清空', (() => { workspaceGrants.clear(); return workspaceGrants.list().length === 0; })());
check('E8 clear 在空表上是幂等的（不抛、不留痕）',
  (() => { workspaceGrants.clear(); workspaceGrants.clear(); return workspaceGrants.list().length === 0; })());

/* ── ⑥ /workspace 命令 ── */
console.log('── ⑥ /workspace 命令 ──');

let reg: { name: string; desc: string; fn: (a: string) => string } | null = null;
activateWorkspace({
  registerCommand: (name: string, desc: string, fn: (a: string) => string) => { reg = { name, desc, fn }; },
} as never);
const cmd = (a: string): string => reg!.fn(a);

check('F1 注册名是 workspace', reg!.name === 'workspace');
check('F2 描述里点了"工作区"（/help 里认得出来）', reg!.desc.includes('工作区'));

workspaceGrants.clear();
const listEmpty = cmd('');
check('F3 无参数回执照出工作区根', listEmpty.includes(process.cwd()));
check('F4 没放行时明说"只能写工作区内"（不留空让人猜）', listEmpty.includes('只能写工作区内'));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cmd-'));
const realDir = path.join(tempDir, 'exists');
fs.mkdirSync(realDir, { recursive: true });
const withSpace = `${tempDir}/a b/c`;

check('F5 allow → 回执含归一化后的绝对路径', cmd(`allow ${realDir}`).includes(path.resolve(realDir)));
// ⚠ 这条**必须真的调用一次 `cmd`**：初稿只写了右边那半（断言），于是它测的是**上一条留下的
//   状态** —— 一条没有活性的断言（与上一轮 D13 同型：标题与内容不符）。
check('F6 allow 带空格的路径：整段当路径（不被第一个空格截断）',
  cmd(`allow ${withSpace}`).includes(path.resolve(withSpace))
  && workspaceGrants.list().includes(path.resolve(withSpace)));
check('F7 allow 相对路径 → 归一化后入表',
  (() => { workspaceGrants.clear(); cmd('allow .'); return workspaceGrants.list().includes(path.resolve('.')); })());
check('F8 allow 一个**不存在**的目录 → 补一句"还不存在"的提醒（静默的失败最坏）',
  cmd(`allow ${path.join(tempDir, 'not-yet')}`).includes('还不存在'));
check('F9 对照组：allow 一个**存在**的目录 → **不**出现那句提醒',
  !cmd(`allow ${realDir}`).includes('还不存在'));
check('F10 allow 盘根 → 宽范围提醒（等于本会话内闸失效）',
  cmd(`allow ${path.parse(process.cwd()).root}`).includes('⚠'));
check('F11 allow 家目录本身 → 宽范围提醒', cmd(`allow ${os.homedir()}`).includes('⚠'));
check('F12 对照组：allow 一个普通目录 → **不**出现宽范围提醒',
  !cmd(`allow ${realDir}`).includes('⚠'));

check('F13 无参数列表在有放行时逐条列出', (() => {
  workspaceGrants.clear();
  workspaceGrants.allow(realDir);
  const s = cmd('');
  return s.includes(path.resolve(realDir)) && s.includes('已放行');
})());
check('F14 clear 有内容时报回收了几个', (() => {
  const s = cmd('clear');
  return s.includes('已收回全部放行') && workspaceGrants.list().length === 0;
})());
check('F15 clear 空表时明说本来就是空的', cmd('clear').includes('本来就是空的'));
check('F16 未知参数 → 报未知 + 给用法', (() => {
  const s = cmd('alow /x');
  return s.includes('未知参数') && s.includes('用法');
})());
check('F17 显式 show 与无参数同效（不报未知）', !cmd('show').includes('未知参数'));

/* ── ⑦ 源码守护 ── */
console.log('── ⑦ 源码守护 ──');

const workSrc = fs.readFileSync(path.join(ROOT, 'src/permission/workspace.ts'), 'utf8');
const cmdSrc = fs.readFileSync(path.join(ROOT, 'src/commands/builtin/workspace.ts'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const workCode = stripComments(workSrc);

check('G1 判据零**项目**依赖（import 只指向 node: 内置与钩子契约类型）',
  (workSrc.match(/^import .*from '([^']+)'/gm) ?? [])
    .every((line) => /from '(node:|\.\.\/loop\/tool-hooks\.js')/.test(line)));
check('G2 判据不碰 fs、不起进程（纯函数：目标文件可能还不存在）',
  !/child_process|node:fs|readFileSync|existsSync|mkdirSync/.test(workCode));
check('G3 main.ts 里**四道闸**的顺序：契约 → 危险 → 工作区 → git 路由',
  mainSrc.indexOf('guardContractWrite(') < mainSrc.indexOf('guardDangerousCommand(')
  && mainSrc.indexOf('guardDangerousCommand(') < mainSrc.indexOf('guardWorkspaceWrite(')
  && mainSrc.indexOf('guardWorkspaceWrite(') < mainSrc.indexOf('routeBashGitRead('));
// G4 刻意不设：`before_tool_call` 的**注册时机**（排在 loadExtensions 之前）是全钩子块共有的
// 性质，verify-danger 的 G4 已经逐字钉着它 —— 在这里再钉一遍就是本仓点过名的"僵尸断言"。
check('G5 main.ts 走的是模块导出的实现（不是就地写一份箭头函数）',
  /import \{ guardWorkspaceWrite \} from '\.\.\/permission\/workspace\.js'/.test(mainSrc));
check('G6 钩子适配器只有一处实现（判据不散成多份）',
  (workSrc.match(/export function guardWorkspaceWrite/g) ?? []).length === 1);

// ⚠ 回归守卫：判"在工作区之外"**不许**用字符串前缀（兄弟目录会被误判成内部，探针实测）
check('G7 用 `path.relative` 判包含，不是字符串前缀',
  workCode.includes('path.relative(') && !workCode.includes('.startsWith(cwd'));
// ⚠ 回归守卫：`..` 那一条必须带分隔符，否则 `..foo` 被误判成外部（A4 钉行为，这条钉手段）
check('G8 `..` 判据带分隔符（`..foo` 是内部的文件名）',
  workCode.includes('startsWith(`..${path.sep}`)') && !workCode.includes(".startsWith('..')"));
// ⚠ 回归守卫：`~` 不展开是**判据性质**，不是文档承诺 —— 判据里出现 homedir 就说明有人"顺手加了"
check('G9 判据里没有 homedir / os（`~` 不展开，与 read/write 同口径）',
  !workCode.includes('homedir') && !/from 'node:os'/.test(workSrc));
check('G10 bash 不在被闸工具表里（边界写成判据，不是写成注释）',
  !GUARDED_WRITE_TOOLS.has('bash') && GUARDED_WRITE_TOOLS.has('write') && GUARDED_WRITE_TOOLS.has('edit'));
check('G11 拒因里的两处边界声明在**代码里**（剥掉注释后仍有）',
  workCode.includes('没有被执行') && workCode.includes('不是沙箱'));
check('G12 拒因前缀只有一处定义', (workSrc.match(/export const WORKSPACE_MARK/g) ?? []).length === 1);

// 唯一开门口：全 src/ 里只有命令层调 workspaceGrants.allow()
// ⚠ **必须剥注释再判**。本仓记过多次"源码文本断言误伤注释"，这是同一个坑的**第八次**形态：
//   10.9.1 在 permission/grants.ts 的注释里写了一句"`workspaceGrants.allow()` 的返回值"，
//   这条当场变红。剥掉注释之后**断言本身一个字没改** —— 它要钉的仍然是"谁在调 `allow()`"。
//   （另一半"批量开门"的守卫在 verify-grants 的 G7：`workspaceGrants.fill(` 的唯一调用方是播种。）
const srcFiles = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }) as string[];
const allowCallers = srcFiles
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => stripComments(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')).includes('workspaceGrants.allow('));
check('G13 放行表只有**一个**写入口（/workspace 命令）—— 模型自己开不了',
  allowCallers.length === 1 && allowCallers[0]!.replace(/\\/g, '/') === 'commands/builtin/workspace.ts',
  JSON.stringify(allowCallers));
// ⚠ 必须在 stripComments 之后判：源码里那句"与 PermissionManager 无任何交集"的**解释性注释**
//   会把这条喂饱 —— 本仓记过多次"源码文本断言误伤注释"，这是同一个坑的第七次形态。
check('G14 判据与权限子系统**无交集**（决策 C11 同源：独立许可通道，非 TTY 自动放行够不着它）',
  !workCode.includes('PermissionManager') && !workCode.includes('permission/manager'));
check('G15 命令层的宽范围提醒复用 danger.ts 的 `isFilesystemRoot`（不另抄一份盘根判定）',
  /import \{ isFilesystemRoot \} from '\.\.\/\.\.\/permission\/danger\.js'/.test(cmdSrc));

/* ── ⑧ 真目录 + 真链路 ── */
console.log('── ⑧ 真目录 + 真 PromptEventEmitter 四闸链 ──');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-verify-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

const home = path.join(tmp, 'home');
const proj = path.join(home, 'proj');
const app = path.join(proj, 'app');
const sibling = path.join(home, 'other');
fs.mkdirSync(path.join(app, 'sub'), { recursive: true });
fs.mkdirSync(sibling, { recursive: true });

/** 每轮现取（放行表是活的）—— 与 main.ts 的缺省 ctx 同形，只把 cwd 换成那棵真树 */
const treeCtx = (): WorkspaceContext => ({ cwd: app, grants: workspaceGrants.list() });

check('H1 真目录：`sub`（下级）→ 内部', !isOutsideWorkspace('sub/a.ts', treeCtx()));
check('H2 真目录：`..`（proj，真实存在的上级）→ 外部', isOutsideWorkspace('..', treeCtx()));
check('H3 真目录：兄弟目录 other → 外部', isOutsideWorkspace(sibling, treeCtx()));
check('H4 真目录：绝对路径指向 app → 内部', !isOutsideWorkspace(app, treeCtx()));
check('H5 真目录：`..\\other`（Windows 反斜杠上级写法）→ 外部',
  isOutsideWorkspace(path.join('..', 'other', 'x.ts'), treeCtx()));

const bus = new PromptEventEmitter();
bus.on('before_tool_call', (event) => {
  const e = event as { name?: unknown; args?: unknown };
  const toolName = typeof e.name === 'string' ? e.name : '';
  const contract = guardContractWrite(toolName, e.args, charterLock.isUnlocked());
  if (contract) return contract;
  const danger = guardDangerousCommand(toolName, e.args);
  if (danger) return danger;
  const workspace = guardWorkspaceWrite(toolName, e.args, treeCtx());
  if (workspace) return workspace;
  return routeBashGitRead(toolName, e.args);
});
charterLock.lock();
workspaceGrants.clear();

const emitWrite = async (p: string): Promise<string> =>
  decodeDeny(await bus.emitHook('before_tool_call', { name: 'write', args: { path: p, content: 'x' } })).reason;
const emitBash = async (command: string): Promise<string> =>
  decodeDeny(await bus.emitHook('before_tool_call', { name: 'bash', args: { command } })).reason;

check('H6 真链路：项目内写放行', (await emitWrite(path.join(app, 'sub', 'a.ts'))) === '');
check('H7 真链路：项目外写被拦，理由是工作区那一条',
  (await emitWrite(path.join(sibling, 'x.ts'))).includes(WORKSPACE_MARK));
check('H8 真链路：用户放行 sibling 之后，同一目标放行（含其子目录）',
  (() => { workspaceGrants.allow(sibling); return true; })()
  && (await emitWrite(path.join(sibling, 'deep', 'y.ts'))) === '');
check('H9 真链路：放行 sibling 不会让 proj 也跟着放行（`..` 方向仍被拦）',
  (await emitWrite(path.join(proj, 'other.ts'))).includes(WORKSPACE_MARK)
  && (await emitWrite('../outside.ts')).includes(WORKSPACE_MARK));
workspaceGrants.clear();

// 新加的这一环**没有把前三环挤掉** —— 四道闸的域刻意不重叠，故逐条记录
check('H10 真链路：契约闸仍生效且**优先**（`cat .flint/CHARTER.md` 命中的必须是契约那条）',
  (() => { charterLock.reset(); return true; })()
  && (await emitBash('cat .flint/CHARTER.md')).includes('契约')
  && !(await emitBash('cat .flint/CHARTER.md')).includes(WORKSPACE_MARK));
charterLock.lock();
check('H11 真链路：危险闸仍生效（`rm -rf /` 没被新环遮住）',
  (await emitBash('rm -rf /')).includes('[危险命令拦截]'));
check('H12 真链路：git 路由仍生效（第四个环没把它挤掉）',
  (await emitBash('git status')).includes('git 工具'));
check('H13 真链路：域不重叠 —— 同一条 bash 外写，工作区闸**不**出手（记录边界）',
  (await emitBash(`echo hi > ${path.join(sibling, 'via-bash.ts')}`)).includes('git') === false
  && !(await emitBash(`echo hi > ${path.join(sibling, 'via-bash.ts')}`)).includes(WORKSPACE_MARK));
check('H14 真链路：相对路径仍在项目内（未被误拦）', (await emitWrite('Deep/Deeper/z.ts')) === '');
check('H15 没注册钩子时返回 undefined（向后兼容）',
  (await new PromptEventEmitter().emitHook('before_tool_call',
    { name: 'write', args: { path: OUTSIDE } })) === undefined);

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
if (failed > 0) process.exit(1);
