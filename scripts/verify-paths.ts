/**
 * verify-paths.ts —— 路径穿越防护（ROADMAP 10.9.5）
 *
 * 验什么（手段与行为分开钉）：
 *   ① `resolveToolPath` —— 工具层**唯一**的"相对 → 绝对"实现：逐形状（相对 / 绝对 / `..` /
 *      `~` / MSYS / 反斜杠）钉它，并钉"回执形态与解析结果**刻意是两个值**"（D 段之外的核心取舍）
 *   ② `realPathOf` —— 追真落点：已存在目标 / 不存在的尾巴 / 深层不存在 / junction /
 *      追不动时 fail-open。**形状全部来自探针实测**（见下）
 *   ③ `findTraversal` —— 注入**假解析器**逐形状正反打靶。这一段是本次的主判据，
 *      三个关键反例都在：① 声明不在根里 → **不是它的责任**（C5）；② cwd 自己是符号链接
 *      → **不许假阳**（C9）；③ 解析器抛异常 → fail-open（C10）
 *   ④ 拒因文案 —— 读的人（模型）要靠它自救；且**出路方向刻意与第一步不同**
 *      （放行那个目录解决不了"链接指向外面"，D6 钉着）
 *   ⑤ 真目录 + 真 junction 端到端 —— 含一条**对照用例**：绕过钩子直接跑真 `write` 工具，
 *      证明这条路**真的**会把文件落到外面；再证明过钩子时它**真没落**（E4/E5）
 *   ⑥ 源码守护 —— 唯一实现、零项目依赖、`native` 而非普通版、五个 handler 都接了、
 *      main.ts 真注入了
 *   ⑦ 真钩子链 `coreBeforeToolCall` —— 证明**生产接线**（而不是只有源码文本看得见）
 *
 * ── 两条探针实测（2026-09-19），形状来自它们 ──
 *   · junction：`realpathSync(link)` 与 `realpathSync.native(link)` **结果逐字符相同**
 *     —— 这推翻了本仓旧说法"普通版不解 junction"的后半句（前半句"普通版原样返回入参
 *     大小写"复现成立）。遂把选 `native` 的理由**收窄成"要规范大小写"**，而不是"只有它能追"。
 *   · `path.relative` 在 Windows 上**大小写不敏感**（`relative(MixedCase, MIXEDCASE/f)` 得 `f`）
 *     —— 这正是判据敢拿"真落点"与"声明路径"比边界、而不担大小写假阳的原因。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-paths.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { coreBeforeToolCall } from '../src/harness/main.js';
import { WORKSPACE_MARK, guardWorkspaceWrite, workspaceGrants } from '../src/permission/workspace.js';
import { findTraversal, renderTraversalReason } from '../src/permission/workspace.js';
import { realPathOf, resolveToolPath } from '../src/tools/paths.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { enterSandbox } from './lib/sandbox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

// ⚠ **必须进沙箱**：⑦ 段真跑 `coreBeforeToolCall`，而它命中即 `recordGateDeny` → 往账本
//   （相对路径 `.flint/events.jsonl`）写一条审计。不搬 cwd 的话，跑一次套件就往本仓库的
//   真账本里塞十几条测试产物 —— 这正是 `verify-audit.ts` 的 J1 与账本对账要治的病。
enterSandbox('flint-paths-');

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

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ═══ ① resolveToolPath：工具层唯一的"相对 → 绝对" ═══ */
console.log('── ① resolveToolPath（统一解析：唯一实现、显示与落点分离）──');

const CWD = isWin ? 'C:/work/proj' : '/work/proj';
const cwdAbs = path.resolve(CWD);

{
  const r = resolveToolPath('src/a.ts', CWD);
  check('A1 相对路径 → 解析到 cwd 之下', r.abs === path.resolve(cwdAbs, 'src/a.ts'));
  check('A2 display 是原文的反斜杠归一，abs 是绝对路径（**两个值刻意分开**）',
    r.display === 'src/a.ts' && r.abs !== r.display && r.raw === 'src/a.ts');
  check('A3 反斜杠写法：raw 原样、display 归一、落点与正斜杠写法相同',
    resolveToolPath('src\\a.ts', CWD).display === 'src/a.ts'
    && resolveToolPath('src\\a.ts', CWD).abs === resolveToolPath('src/a.ts', CWD).abs
    && resolveToolPath('src\\a.ts', CWD).raw === 'src\\a.ts');
  check('A4 绝对路径 → 幂等（resolve 两次结果相同）',
    resolveToolPath(r.abs, CWD).abs === r.abs);
  check('A5 `..` 被归一（代数，不看目标存不存在）',
    resolveToolPath('src/../b.ts', CWD).abs === path.resolve(cwdAbs, 'b.ts'));
  check('A6 直接写 `..` 指向上级', resolveToolPath('..', CWD).abs === path.resolve(cwdAbs, '..'));
  check('A7 `.` → 就是 cwd 自己', resolveToolPath('.', CWD).abs === cwdAbs);

  // `~` 不展开：与 read / write / 闸同口径 —— 它落在 cwd 下一个名叫 `~` 的目录里
  const tilde = resolveToolPath('~/x', CWD).abs;
  check('A8 `~` **不展开**（落 cwd 下的 `~` 目录，不碰家目录）',
    tilde === path.resolve(cwdAbs, '~', 'x') && !tilde.startsWith(path.resolve(os.homedir()) + path.sep));

  // MSYS 形式 `/c/...` 不认：`path.resolve` 把开头的 `/` 读成"当前盘的根"
  const msys = resolveToolPath('/c/x', CWD).abs;
  check('A9 MSYS 形式 `/c/x` **不认**（解成当前盘根下的 c/x，不是 cwd 下的 c/x）',
    isWin ? msys === path.resolve('C:/c/x') : msys === '/c/x');
  check('A10 空串 → cwd（不抛，交给上层判）', resolveToolPath('', CWD).abs === cwdAbs);
  check('A11 纯净：只做代数，不碰 fs（对"还不存在"的深层路径照样给结果）',
    resolveToolPath('no/such/deep/a.ts', CWD).abs === path.resolve(cwdAbs, 'no/such/deep/a.ts'));
  check('A12 注入的 cwd 真的被用上（换成另一个根，落点跟着变）',
    resolveToolPath('a.ts', isWin ? 'D:/other' : '/other').abs
    !== resolveToolPath('a.ts', CWD).abs);
}

/* ═══ ② realPathOf：追真落点（最长已存在前缀） ═══ */
console.log('── ② realPathOf（追真落点：不存在的尾巴照样算得出）──');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-verify-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

const realDir = path.join(TMP, 'real');
const realFile = path.join(realDir, 'f.txt');
fs.mkdirSync(realDir, { recursive: true });
fs.writeFileSync(realFile, 'x');

check('B1 已存在的目录 → 与 realpathSync.native 逐字符相同',
  realPathOf(realDir) === realpathSync.native(realDir));
check('B2 已存在的文件 → 同上', realPathOf(realFile) === realpathSync.native(realFile));
check('B3 不存在的**直接子文件** → 父目录真落点 + 文件名',
  realPathOf(path.join(realDir, 'new.txt')) === path.join(realpathSync.native(realDir), 'new.txt'));
check('B4 不存在的**多层**子路径 → 最长已存在祖先 + 整条尾巴',
  realPathOf(path.join(realDir, 'a', 'b', 'c.ts'))
  === path.join(realpathSync.native(realDir), 'a', 'b', 'c.ts'));
check('B5 尾巴的**顺序**不许乱（三层按序接回）',
  realPathOf(path.join(realDir, 'x', 'y', 'z.ts')).endsWith(path.join('x', 'y', 'z.ts')));
check('B6 相对路径兜底：不抛，先补成绝对',
  realPathOf('src/a.ts') === path.join(process.cwd(), 'src', 'a.ts'));
check('B7 追不动时 **fail-open 退化成入参**（畸形输入不抛）', (() => {
  try { return realPathOf(path.join(TMP, 'bad\u0000name')); } catch { return false; }
})() !== false);

if (isWin) {
  const free = ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z']
    .find((l) => !fs.existsSync(`${l}:/`));
  check(`B8 不存在的盘符 → 退化成入参（fail-open，盘符取 ${free ?? '无'}）`,
    free !== undefined ? realPathOf(`${free}:/nope/x`) === `${free}:/nope/x` : true,
    free === undefined ? '本机所有候选盘符都存在，该形态不可造' : '');
} else {
  check('B8 不存在的盘符形态仅 Windows 存在（POSIX 下根永远存在，跳过）', true);
}

// junction 追真落点（建不起来就**如实记**，不静默跳过）
const outside = path.join(TMP, 'outside');
const linkOut = path.join(realDir, 'link-out');
fs.mkdirSync(outside, { recursive: true });
let junctionOk = false;
try {
  fs.symlinkSync(outside, linkOut, 'junction');
  junctionOk = true;
} catch {
  junctionOk = false;
}

if (junctionOk) {
  check('B9 junction（目录软链）被追到真实目录',
    realPathOf(linkOut) === realpathSync.native(outside));
  check('B10 junction 下**还不存在**的文件 → 真目录 + 尾部',
    realPathOf(path.join(linkOut, 'n.txt')) === path.join(realpathSync.native(outside), 'n.txt'));
  check('B11 junction 下的**已存在**文件同样追得到',
    (() => { fs.writeFileSync(path.join(outside, 'e.txt'), 'x');
      return realPathOf(path.join(linkOut, 'e.txt')) === path.join(realpathSync.native(outside), 'e.txt'); })());
} else {
  check('B9-B11 junction 无法在本机创建（EPERM / 平台不支持）—— **未实测**，不当通过', false,
    'junction 创建失败，追真落点在真文件系统这一面本轮没有覆盖');
}
check('B12 普通目录下真实存在的路径 → realPathOf 不改变它与 realpath 的关系',
  realPathOf(realDir) === realpathSync.native(realDir));

/* ═══ ③ findTraversal：注入假解析器逐形状打靶 ═══ */
console.log('── ③ findTraversal（第二步判据：注入假解析器，不依赖真文件系统）──');

const fake = (map: Record<string, string>) => (p: string) => map[p] ?? p;

const R1 = path.resolve(isWin ? 'C:/work/proj' : '/work/proj');
const R2 = path.resolve(isWin ? 'C:/work/granted' : '/work/granted');
const OUT = path.resolve(isWin ? 'C:/work/elsewhere' : '/work/elsewhere');

const ctxNoResolver = { cwd: R1, grants: [] as string[] };
check('C1 没注入解析器 → 一律不追（判据退回纯代数，等于改动前的行为）',
  findTraversal(path.join(R1, 'src', 'a.ts'), ctxNoResolver) === undefined);

check('C2 声明在内、真落点也在内 → 不拦',
  findTraversal(path.join(R1, 'src', 'a.ts'),
    { cwd: R1, grants: [], realpath: fake({}) }) === undefined);

check('C3 声明在内、真落点在外 → 返回**那个根**（cwd）',
  findTraversal(path.join(R1, 'link', 'a.ts'),
    { cwd: R1, grants: [], realpath: fake({ [path.join(R1, 'link', 'a.ts')]: path.join(OUT, 'a.ts') }) })
  === R1);

// ⚠ 第①段判据的反例：声明根本不在这个根里 → 不是它的责任（少了这句就会拿 A 根套 B 根）
check('C4 声明在**别的根**里（不在 cwd 之下）→ 不拦（避免拿 A 根套 B 根）',
  findTraversal(path.join(OUT, 'a.ts'),
    { cwd: R1, grants: [], realpath: fake({ [path.join(OUT, 'a.ts')]: path.join(R1, 'a.ts') }) })
  === undefined);

check('C5 放行目录里的路径用**那条放行目录**当根：真落点出它 → 报的是那一条（不是 cwd）',
  findTraversal(path.join(R2, 'link', 'b.ts'),
    { cwd: R1, grants: [R2], realpath: fake({ [path.join(R2, 'link', 'b.ts')]: path.join(OUT, 'b.ts') }) })
  === R2);

check('C6 放行目录里的路径、真落点仍在放行目录里 → 不拦',
  findTraversal(path.join(R2, 'x', 'b.ts'),
    { cwd: R1, grants: [R2], realpath: fake({ [path.join(R2, 'x', 'b.ts')]: path.join(R2, 'real', 'b.ts') }) })
  === undefined);

check('C7 一条路径同时落在两个根都不出界 → 不拦（多根取交集语义：只要有一条根容得下就放行）',
  findTraversal(path.join(R2, 'c.ts'),
    { cwd: R2, grants: [R2], realpath: fake({}) }) === undefined);

// ⚠ 第②段判据的反例：**cwd 自己就是符号链接**时不许假阳（macOS 的 /tmp → /private/tmp 是常态）
{
  const linkRoot = path.resolve(isWin ? 'C:/link/proj' : '/link/proj');
  const realRoot = path.resolve(isWin ? 'C:/real/proj' : '/real/proj');
  check('C8 cwd 自己是符号链接、声明与真落点都在**同一个真实子树**里 → **不假阳**',
    findTraversal(path.join(linkRoot, 'src', 'a.ts'), {
      cwd: linkRoot,
      grants: [],
      realpath: fake({ [linkRoot]: realRoot, [path.join(linkRoot, 'src', 'a.ts')]: path.join(realRoot, 'src', 'a.ts') }),
    }) === undefined);
}

check('C9 解析器抛异常 → fail-open（不拦，也不把整个调用带崩）',
  findTraversal(path.join(R1, 'a.ts'), {
    cwd: R1, grants: [], realpath: () => { throw new Error('boom'); },
  }) === undefined);

check('C10 Windows 大小写差异不造成假阳（路径代数大小写不敏感，探针实测）',
  !isWin ? true : findTraversal(path.resolve('C:/WORK/PROJ/src/a.ts'),
    { cwd: R1, grants: [], realpath: fake({ [path.resolve('C:/WORK/PROJ/src/a.ts')]: path.resolve('C:/work/proj/src/a.ts') }) })
  === undefined);

check('C11 `..` 已在传参前归一：归一后仍在内 → 不拦（判据只对"已解析的绝对路径"负责）',
  findTraversal(path.resolve(R1, 'b.ts'),
    { cwd: R1, grants: [], realpath: fake({}) }) === undefined);

// ⚠ 正反两组（只留"不拦"那一半，等于只证明了"没判"，不是"判对了"）：
//   · 否定组：`..foo` 在内部、真落点也在内部 → 不许拦；
//   · 肯定组：同一条声明路径，真落点换到**外面** → 必须拦得住。
{
  const decIn = path.join(R1, '..foo');
  check('C12 名字带 `..` 前缀的文件（`..foo`）**在内部**，不许被误判成出界',
    findTraversal(decIn, { cwd: R1, grants: [], realpath: fake({ [decIn]: decIn }) }) === undefined
    && findTraversal(decIn, { cwd: R1, grants: [], realpath: fake({ [decIn]: path.join(OUT, '..foo') }) }) === R1);
}

check('C13 真落点是**上级的兄弟**（`..` 方向）→ 拦（放行表不向上传染）',
  findTraversal(path.join(R1, 'up.ts'),
    { cwd: R1, grants: [], realpath: fake({ [path.join(R1, 'up.ts')]: path.resolve(R1, '..', 'up.ts') }) })
  === R1);

check('C14 返回的是"哪一个根出的界"，而不是布尔 —— 拒因要靠它说清"出界于"',
  typeof findTraversal(path.join(R1, 'l', 'a.ts'),
    { cwd: R1, grants: [], realpath: fake({ [path.join(R1, 'l', 'a.ts')]: path.join(OUT, 'a.ts') }) }) === 'string');

/* ═══ ④ 拒因文案 ═══ */
console.log('── ④ 第二步的拒因（模型要靠它自救）──');

{
  const target = 'link-out/d.ts';
  const declared = path.join(R1, 'link-out', 'd.ts');
  const real = path.join(OUT, 'd.ts');
  const reason = renderTraversalReason(target, declared, real, R1);

  check('D1 以工作区标记开头（套件与用户都靠它认出是这道闸）', reason.startsWith(WORKSPACE_MARK));
  check('D2 说清"没有被执行"', reason.includes('没有被执行'));
  check('D3 三条实路径都在：声明 / 真落点 / 出界于哪个根',
    reason.includes(declared) && reason.includes(real) && reason.includes(R1));
  check('D4 点明病因是符号链接 / junction', reason.includes('符号链接') && reason.includes('junction'));
  check('D5 自认边界（"不是沙箱"）', reason.includes('不是沙箱'));
  // ⚠ 方向给错比不给更坏：这条出路**不是**"放行那个目录" —— 声明路径本来就在项目里
  check('D6 第一条出路指向"改成真实路径"，**不是**"放行那个目录"',
    reason.includes('真实指向') && !/^.*·\s*目标本来就在项目里/m.test(reason));
  check('D7 拒因里**不出现** `--save`（长期放行只该由用户自己发现，同 10.9.1 的 G11）',
    !reason.includes('--save'));
}

/* ═══ ⑤ 真目录 + 真 junction 端到端（含"绕过钩子会怎样"的对照） ═══ */
console.log('── ⑤ 真目录 + 真 junction 端到端 ──');

const proj = path.join(TMP, 'proj');
const outDir = path.join(TMP, 'escape');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

let eOk = false;
try {
  fs.symlinkSync(outDir, path.join(proj, 'link-out'), 'junction');
  fs.symlinkSync(path.join(proj, 'src'), path.join(proj, 'link-in'), 'junction');
  eOk = true;
} catch {
  eOk = false;
}

if (eOk) {
  const ctx = (): { cwd: string; grants: string[]; realpath: (p: string) => string } =>
    ({ cwd: proj, grants: workspaceGrants.list(), realpath: realPathOf });
  const ctxOff = (): { cwd: string; grants: string[] } => ({ cwd: proj, grants: workspaceGrants.list() });

  check('E1 **缺省不追**：不注入解析器时，junction 外写**照旧放行**（行为与 10.9.5 之前逐字相同）',
    guardWorkspaceWrite('write', { path: 'link-out/d.ts', content: 'x' }, ctxOff()) === undefined);
  check('E2 注入解析器后：junction 指向项目外 → 拒，且用的是第二步的拒因',
    (() => { const d = guardWorkspaceWrite('write', { path: 'link-out/d.ts', content: 'x' }, ctx());
      return d !== undefined && d.reason.includes('符号链接'); })());
  check('E3 junction 指向**项目内** → 放行（不假阳）',
    guardWorkspaceWrite('write', { path: 'link-in/e.ts', content: 'x' }, ctx()) === undefined);
  check('E4 普通项目内路径 → 放行（第二步不误伤日常写）',
    guardWorkspaceWrite('write', { path: 'src/b.ts', content: 'x' }, ctx()) === undefined);
  check('E5 项目外（第一步原有那一半）仍拒，且理由还是第一条（两步分工没被搅乱）',
    (() => { const d = guardWorkspaceWrite('write', { path: '../escape/c.ts', content: 'x' }, ctx());
      return d !== undefined && d.reason.includes('目标落在工作区之外'); })());

  // **对照**：绕过钩子直接跑真 `write` 工具 —— 证明这条路真的会把文件落到项目外。
  // 没有这条，"拦住了"可以被读成"这条路径本来就写不出去"。
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  fs.writeFileSync(path.join(outDir, 'marker.txt'), 'x');
  await registry.execute('write', { path: path.join(proj, 'link-out', 'h.ts'), content: 'bypass' });
  check('E6 对照：**绕过钩子**直接跑真 write 工具，文件真的落到了项目外（`link-out/h.ts` → `escape/h.ts`）',
    fs.existsSync(path.join(outDir, 'h.ts')));

  // 而经钩子时它不会执行 —— 这里只断言"闸给了拒绝"，落点的缺失由 E6 的对照反衬
  check('E7 过钩子同一条目标被拒（对照 E6：同一条路径，差别只在有没有过闸）',
    guardWorkspaceWrite('write', { path: 'link-out/h2.ts', content: 'x' }, ctx()) !== undefined
    && !fs.existsSync(path.join(outDir, 'h2.ts')));
  check('E8 junction 下的**已存在文件**同样拦得住（尾巴是文件不是目录）',
    guardWorkspaceWrite('write', { path: 'link-out/marker.txt', content: 'y' }, ctx()) !== undefined);
  check('E9 `edit` 与 `write` 同域（同一个受管名单，两步判对两者都生效）',
    guardWorkspaceWrite('edit', { path: 'link-out/marker.txt', oldText: 'x', newText: 'y' }, ctx()) !== undefined);
  check('E10 非受管工具（bash）**不进**这两步（域不扩张，同 10.9.3 的边界）',
    guardWorkspaceWrite('bash', { command: `echo x > ${path.join(outDir, 'z')}` }, ctx()) === undefined);
} else {
  check('E1-E10 真 junction 无法在本机创建 —— 端到端那一段**未实测**，不当通过', false,
    'junction 创建失败；本段是"真文件系统"那一面的唯一覆盖，缺了就只能靠 ③ 段的假解析器');
}

/* ═══ ⑥ 源码守护 ═══ */
console.log('── ⑥ 源码守护 ──');

const pathsSrc = fs.readFileSync(path.join(ROOT, 'src/tools/paths.ts'), 'utf8');
const pathsCode = stripComments(pathsSrc);
const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf8');
const builtinCode = stripComments(builtinSrc);
const wsCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/permission/workspace.ts'), 'utf8'));
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf8');

check('F1 paths.ts 零**项目**依赖（import 只指向 node: 内置）',
  (pathsSrc.match(/^import .*from '([^']+)'/gm) ?? [])
    .every((line) => /from 'node:/.test(line)));
check('F2 `resolveToolPath` 只有一处实现（"统一 resolve"的前提）',
  (pathsCode.match(/export function resolveToolPath/g) ?? []).length === 1);
check('F3 `realPathOf` 只有一处实现', (pathsCode.match(/export function realPathOf/g) ?? []).length === 1);
check('F4 用 `realpathSync.native` 而不是普通版（只有它规范大小写，探针实测）',
  pathsCode.includes('realpathSync.native(') && !/realpathSync\((?!.*native)/.test(pathsCode));
check('F5 七个路径工具都接了统一解析（read / write / edit / ls / grep / symbols / refs）',
  (builtinCode.match(/resolveToolPath\(/g) ?? []).length === 7);
check('F6 解析出来的绝对路径**真的喂给了 fs**（不是算了不用）',
  builtinCode.includes('readFileSync(resolvedAbs') && builtinCode.includes('writeFileSync(resolvedAbs')
  && builtinCode.includes('existsSync(resolvedAbs)'));
// ⚠ 反方向那一半：**原始串与 display 形态都不许流进 fs**。只断"出现了 resolvedAbs"是不够的 ——
//   把 `resolvedAbs` 定义改成 `= resolvedPath`、或把某个 handler 的 fs 调用改回吃入参 `path`，
//   上面那条照样绿（标识符还在，喂进去的却是别的东西）。五个 handler 逐个都在这一条里。
check('F6b 原始串（`path` / `searchPath`）与 display 形态（`resolvedPath`）**一次都没有**流进 fs 调用',
  (builtinCode.match(
    /(?:existsSync|statSync|readFileSync|writeFileSync|mkdirSync|loadIgnoreRules|walk|scanFile)\(\s*(?:path|searchPath|resolvedPath)\b/g,
  ) ?? []).length === 0);
check('F7 main.ts 给工作区闸注入了真落点解析器（否则第二步在生产里永远不跑）',
  /realpath:\s*realPathOf/.test(mainSrc));
// ⚠ 这里原来第一项是 `(wsCode.match(...) ?? []).length >= 0` —— **恒真的空断言**（任何长度都 ≥ 0）。
//   换成"逐条 import 都必须是 node: 或钩子契约"的**意图式**断言：判据要能不碰 fs，
//   靠的就是它**不** import tools/paths（真落点那份实现留在装配处注入）。
check('F8 workspace.ts 仍然只依赖 node / 钩子契约（所以**不** import tools/paths —— 判据不碰 fs）',
  (wsCode.match(/^import .*from '([^']+)'/gm) ?? [])
    .every((l) => /from 'node:/.test(l) || /from '\.\.\/loop\/tool-hooks\.js'/.test(l))
  && !/node:fs|realpathSync/.test(wsCode));
check('F9 `findTraversal` 只被工作区闸调用（唯一调用点，不散成多份判据）',
  (wsCode.match(/findTraversal\(/g) ?? []).length === 2); // 定义处 1 + 调用处 1
// ⚠ 只数"导出几个 `_MARK`"不够：另起一个局部 `TRAVERSAL_MARK` 照样只有 1 个 export。
//   改成钉两件事：全文件**只有一个** `_MARK` 常量声明 + 它被两条拒因**都用上**（各一次）。
check('F10 第二步**不新增**拒因前缀（与第一步共用 WORKSPACE_MARK：同一个问题的两个判据）',
  (wsCode.match(/^\s*(?:export )?const \w+_MARK\s*=/gm) ?? []).length === 1
  && (wsCode.match(/\$\{WORKSPACE_MARK\}/g) ?? []).length === 2);

/* ═══ ⑦ 真钩子链（生产接线） ═══ */
console.log('── ⑦ 真钩子链 coreBeforeToolCall ──');

if (eOk) {
  const prevCwd = process.cwd();
  process.chdir(proj);
  workspaceGrants.clear();
  try {
    check('G1 真钩子链：项目内写 → 放行',
      coreBeforeToolCall({ name: 'write', args: { path: 'src/ok.ts', content: 'x' } }, true) === undefined);
    check('G2 真钩子链：junction 指向项目外 → **拒**（第二步在生产链路上真的生效）',
      (() => { const d = coreBeforeToolCall({ name: 'write', args: { path: 'link-out/g.ts', content: 'x' } }, true);
        return d !== undefined && d.reason.includes(WORKSPACE_MARK) && d.reason.includes('符号链接'); })());
    check('G3 真钩子链：junction 指向项目内 → 放行（生产里也不假阳）',
      coreBeforeToolCall({ name: 'write', args: { path: 'link-in/g.ts', content: 'x' } }, true) === undefined);
    check('G4 真钩子链：`/workspace allow` 放行项目外那个目录之后，junction 那条**仍被拒**'
      + '（声明在 proj 内 → 由 proj 这根判，放行别的目录不解决它）',
      (() => { workspaceGrants.allow(outDir, proj);
        const d = coreBeforeToolCall({ name: 'write', args: { path: 'link-out/g2.ts', content: 'x' } }, true);
        return d !== undefined && d.reason.includes('符号链接'); })());
  } finally {
    workspaceGrants.clear();
    process.chdir(prevCwd);
  }
} else {
  check('G1-G4 真钩子链需要真 junction —— 本机未实测，不当通过', false, 'junction 创建失败');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
