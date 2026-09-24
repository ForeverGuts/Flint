/**
 * bash 写纳管（ROADMAP 10.9.8）的验证套件。
 *
 * 判据分家（与 verify-trash / verify-danger 同一结构）：
 *   ① A 段：重定向形状（纯词法，不碰 fs、不吃 ctx）
 *   ② B 段：命令词形状（tee / cp / mv）
 *   ③ C 段：伪目标与 fail-open（判不出来的形态必须放行）
 *   ④ D 段：适配器 + 边界（expandTarget 归一 → isOutsideWorkspace —— 与 write/edit 同一个函数）
 *   ⑤ E 段：拒因渲染（给人读的文本断在渲染结果上）
 *   ⑥ F 段：真接线（真钩子链 coreBeforeToolCall：谁拒的 / 次序 / 工具名圈子）
 *   ⑦ G 段：源码守护（词法复用不另写、边界复用不另写、MSYS 不映射、main.ts 真接线）
 *   Z：沙箱自证
 *
 * ⚠ 本套的钩子链拒截会记审计 → 代码体第一件事就是 `enterSandbox()`（见 lib/sandbox.ts）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterSandbox } from './lib/sandbox.js';
import {
  PSEUDO_TARGETS, REDIRECT_OPS, WRITE_COMMANDS,
  findBashWriteTargets, guardBashWrite, isPseudoTarget, renderBashWriteReason,
} from '../src/permission/bash-write.js';
import { coreBeforeToolCall } from '../src/harness/main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 自保（不计项数）：钩子链拒截会写审计账本 ── */
const sandbox = enterSandbox('flint-bashwrite-');

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

const srcOf = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const bwSrc = srcOf('src/permission/bash-write.ts');
const mainSrc = srcOf('src/harness/main.ts');

const CWD = process.cwd(); // 沙箱目录 = 工作区根
const FAKE_HOME = path.resolve(sandbox.dir, '..', 'flint-bw-fakehome'); // 判据纯函数，家目录喂假的（**必须在 cwd 之外**，否则边界判定永远"在内"）
const OUTSIDE = path.resolve(CWD, '..', 'flint-bw-outside'); // cwd 的兄弟目录 → 必出界
const GRANTED = path.resolve(CWD, '..', 'flint-bw-granted'); // 出界、但会被授权
const ctx = { cwd: CWD, home: FAKE_HOME, grants: [] as string[] };

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 重定向形状
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ① 重定向形状（A 段） ──');

check('A1 `> 目标` 命中（op > 、raw 是原样写法）',
  JSON.stringify(findBashWriteTargets('echo x > ~/a.txt')) === JSON.stringify([{ op: '>', raw: '~/a.txt' }]),
  JSON.stringify(findBashWriteTargets('echo x > ~/a.txt')));

check('A2 `>>` 追加也是写',
  findBashWriteTargets('echo x >> log.txt')[0]?.op === '>>');

check('A3 `2>` 与 `2>>`（stderr 落文件）',
  findBashWriteTargets('cmd 2> err.txt')[0]?.op === '2>'
  && findBashWriteTargets('cmd 2>> err.txt')[0]?.op === '2>>');

check('A4 紧贴写法 `>out.txt`（无空格同样命中）',
  JSON.stringify(findBashWriteTargets('echo hi >out.txt')) === JSON.stringify([{ op: '>', raw: 'out.txt' }]));

check('A5 紧贴的 `2>>err.txt`',
  findBashWriteTargets('cmd 2>>err.txt')[0]?.op === '2>>' && findBashWriteTargets('cmd 2>>err.txt')[0]?.raw === 'err.txt');

check('A6 `&>` 形态：`&` 本身是切段分隔符，到达判据时已拆成 `cmd` 与 `> f` —— 照样命中（走 `>` 分支）',
  findBashWriteTargets('cmd &> all.txt')[0]?.op === '>' && findBashWriteTargets('cmd &> all.txt')[0]?.raw === 'all.txt');

check('A7 分段：`;` 与 `&&` 之后的重定向照样命中（每段各自扫）',
  findBashWriteTargets(`ls; echo x > ${OUTSIDE}/a.txt`).length === 1
  && findBashWriteTargets(`cmd1 && cmd2 > ${OUTSIDE}/b.txt`).length === 1);

check('A8 一段里多个重定向各自命中',
  findBashWriteTargets('echo a > b.txt 2> c.txt').length === 2);

check('A9 重定向符在段末没有目标 → 不命中（fail-open，不猜）',
  findBashWriteTargets('echo x >').length === 0);

check('A10 `2>&1` 重定向到流 → 不命中（不是文件）',
  findBashWriteTargets('cmd 2>&1').length === 0);

check('A11 引号里的 `>` 是数据：`echo "> not a redirect"` 不命中',
  findBashWriteTargets('echo "> not a redirect"').length === 0);

check('A12 `<` 是读方向，本闸不管',
  findBashWriteTargets('sort < in.txt').length === 0);

check('A13 管道右边的 tee 照样命中（`|` 切段后各管各段）',
  findBashWriteTargets('cat x | tee out.txt').length === 1
  && findBashWriteTargets('cat x | tee out.txt')[0]?.op === 'tee');

check('A14 封闭枚举：四个重定向符、三个命令词（`&>` 不列 —— 切段后它就是 `>`，列了是死代码）',
  REDIRECT_OPS.length === 4 && [...REDIRECT_OPS].every((o) => !o.startsWith('<'))
  && WRITE_COMMANDS.size === 3 && WRITE_COMMANDS.has('tee') && WRITE_COMMANDS.has('cp') && WRITE_COMMANDS.has('mv'));

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 命令词形状
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ② 命令词形状（B 段） ──');

check('B1 `tee` 的每个文件参数都是目标',
  findBashWriteTargets('tee a.txt b.txt').length === 2
  && findBashWriteTargets('tee a.txt b.txt').every((h) => h.op === 'tee'));

check('B2 `tee -a out.log`：旗标跳过、文件参数命中',
  findBashWriteTargets('tee -a out.log').length === 1
  && findBashWriteTargets('tee -a out.log')[0]?.raw === 'out.log');

check('B3 裸 `tee`（只写 stdout）不命中',
  findBashWriteTargets('echo x | tee').length === 0);

check('B4 `cp` 的目的地 = 最后一个非旗标参数',
  findBashWriteTargets(`cp a.txt b.txt ${OUTSIDE}/dir`)[0]?.raw === `${OUTSIDE}/dir`);

check('B5 `mv` 的目的地（`~` 原样保留，归一留给适配器）',
  findBashWriteTargets('mv x.txt ~/y.txt')[0]?.raw === '~/y.txt');

check('B6 `cp a.txt`（只有一个非旗标参数）没有目的地可判 → 不命中',
  findBashWriteTargets('cp a.txt').length === 0);

check('B7 旗标混排不影响取尾：`cp -r -p a b` 的目的地是 b',
  findBashWriteTargets('cp -r -p a b')[0]?.raw === 'b');

check('B8 删除命令**不归本闸**：`rm -rf dist` 零命中（那是删除闸的词，不能抢理由）',
  findBashWriteTargets('rm -rf dist').length === 0);

check('B9 无写的命令零命中',
  findBashWriteTargets('git log --oneline').length === 0
  && findBashWriteTargets('echo hello').length === 0);

check('B10 一层包装里的 cp/mv 只有**展包装**才认得出（外层没有重定向可扫，命令词是 bash）——这条是 M3 变异全绿逼出来的',
  findBashWriteTargets(`bash -c "cp a ${OUTSIDE}/x"`).length === 1
  && findBashWriteTargets(`bash -c "cp a ${OUTSIDE}/x"`)[0]?.op === 'cp');

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 伪目标与 fail-open
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ③ 伪目标与 fail-open（C 段） ──');

check('C1 `/dev/null` 是黑洞不是文件（最常用的静音写法，拦它纯属误伤）',
  findBashWriteTargets('echo x > /dev/null').length === 0 && isPseudoTarget('/dev/null'));

check('C2 cmd 的 `NUL` 同判',
  findBashWriteTargets('echo x > NUL').length === 0 && isPseudoTarget('NUL'));

check('C3 伪目标表齐全（四个 POSIX 设备 + NUL）',
  [...PSEUDO_TARGETS].join(',').includes('/dev/stdout')
  && [...PSEUDO_TARGETS].join(',').includes('/dev/stderr')
  && [...PSEUDO_TARGETS].join(',').includes('/dev/tty'));

check('C4 `>&2` / `> &2` 重定向到已打开的流 → 不命中',
  findBashWriteTargets('cmd >&2').length === 0 && findBashWriteTargets('cmd > &2').length === 0);

check('C5 变量指向判不出来：判据层照样报目标，适配器层 expandTarget 返 null 放行',
  findBashWriteTargets('cmd > $DIR/x.txt').length === 1
  && guardBashWrite('bash', { command: 'cmd > $DIR/x.txt' }, ctx) === undefined);

check('C6 命令替换（反引号）同理：适配器层放行',
  findBashWriteTargets('cmd > `pwd`/x.txt').length === 1
  && guardBashWrite('bash', { command: 'cmd > `pwd`/x.txt' }, ctx) === undefined);

check('C7 通配 `> *.txt`：截 `*` 后落在 cwd 里 → 放行',
  guardBashWrite('bash', { command: 'echo x > *.txt' }, ctx) === undefined);

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 适配器 + 边界（与 write / edit 同一个判定函数）
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ④ 适配器 + 边界（D 段） ──');

const denyOut = guardBashWrite('bash', { command: `echo x > ${OUTSIDE}/x.txt` }, ctx);
check('D1 写到工作区外 → 拒，拒因带标记与展开后的绝对路径',
  denyOut !== undefined && denyOut.action === 'deny'
  && denyOut.reason.includes('[bash 写纳管]') && denyOut.reason.includes(OUTSIDE),
  denyOut?.reason.slice(0, 60));

check('D2 写在工作区里 → 放行（undefined，交回主流程）',
  guardBashWrite('bash', { command: 'echo x > inside.txt' }, ctx) === undefined);

check('D3 放行表生效：同一目标，授权前拒、授权后放',
  guardBashWrite('bash', { command: `echo x > ${GRANTED}/x.txt` }, ctx) !== undefined
  && guardBashWrite('bash', { command: `echo x > ${GRANTED}/x.txt` },
    { ...ctx, grants: [GRANTED] }) === undefined);

check('D4 `~` 展开成家目录（含 Windows —— cmd 里 `> ~/x` 本就会失败，意图却毫无歧义）',
  guardBashWrite('bash', { command: 'echo x > ~/a.txt' }, ctx) !== undefined
  && guardBashWrite('bash', { command: 'echo x > ~/a.txt' }, ctx)!.reason.includes(FAKE_HOME));

check('D5 `$HOME` 与 `%USERPROFILE%` 同样展开',
  guardBashWrite('bash', { command: 'echo x > $HOME/a.txt' }, ctx) !== undefined
  && guardBashWrite('bash', { command: 'echo x > %USERPROFILE%/a.txt' }, ctx) !== undefined);

check('D6 MSYS 写法**刻意不映射**（cmd 的真落点就是 `<盘>:\\c\\...`，映射反而制造假放行）',
  (() => {
    const r = guardBashWrite('bash', { command: 'echo x > /c/Users/x.txt' }, ctx);
    if (r === undefined) return false;
    return process.platform === 'win32' ? r.reason.includes(':\\c\\') : r.reason.includes('/c/');
  })(),
  guardBashWrite('bash', { command: 'echo x > /c/Users/x.txt' }, ctx)?.reason.slice(0, 80));

check('D7 引号里带空格的目标会被切成片段，但片段仍在工作区内 → 放行（可见的正常行为）',
  guardBashWrite('bash', { command: 'echo x > "my file.txt"' }, ctx) === undefined);

check('D8 只管会执行命令串的工具：write / edit / git_write 不进本闸（它们有各自的家法）',
  guardBashWrite('write', { command: `echo x > ${OUTSIDE}/x` }, ctx) === undefined
  && guardBashWrite('edit', { command: `echo x > ${OUTSIDE}/x` }, ctx) === undefined
  && guardBashWrite('git_write', { command: `echo x > ${OUTSIDE}/x` }, ctx) === undefined);

check('D9 形状不对一律放行（fail-open）：args 非对象 / 无 command / command 非字符串 / 空串',
  guardBashWrite('bash', null, ctx) === undefined
  && guardBashWrite('bash', {}, ctx) === undefined
  && guardBashWrite('bash', { command: 42 }, ctx) === undefined
  && guardBashWrite('bash', { command: '   ' }, ctx) === undefined);

check('D10 一层包装里的重定向与命令词都译得出来（重定向外层就看得见，cp/mv 只有展包装才认得出）',
  guardBashWrite('bash', { command: `bash -c "echo x > ${OUTSIDE}/x.txt"` }, ctx) !== undefined
  && guardBashWrite('bash', { command: `bash -c "cp a ${OUTSIDE}/x.txt"` }, ctx) !== undefined);

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 拒因渲染
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ⑤ 拒因渲染（E 段） ──');

const reason = renderBashWriteReason('echo x > /out/x.txt', { op: '>', raw: '/out/x.txt' }, '/out/x.txt');
check('E1 拒因四样齐全：没执行 + 为什么两扇门一个规矩 + 出路（write 工具 / /workspace allow / 用户终端）+ 护栏不是沙箱',
  reason.includes('没有被执行')
  && reason.includes('同一个判定函数')
  && reason.includes('/workspace allow')
  && reason.includes('write 工具')
  && reason.includes('护栏不是沙箱'));

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑥ 真接线：真钩子链
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ⑥ 真接线（F 段） ──');

const gated = coreBeforeToolCall({ name: 'bash', args: { command: `echo hi > ${OUTSIDE}/x.txt` } }, false, false);
check('F1 真钩子链：bash 的出界重定向被拒，tag = bash-write（审计查得到是谁拒的）',
  gated !== undefined && gated.reason.includes('[bash 写纳管]'), gated?.reason.slice(0, 60));

const insideChain = coreBeforeToolCall({ name: 'bash', args: { command: 'echo hi > inside.txt' } }, false, false);
check('F2 工作区内的重定向整条链都放行（undefined，不是被别的闸顺手拦下）',
  insideChain === undefined, insideChain?.reason.slice(0, 60));

const dangerFirst = coreBeforeToolCall({ name: 'bash', args: { command: 'echo x > /dev/sda' } }, false, false);
check('F3 裸设备仍由**危险闸**先说话（判据更窄更确定的排前面）',
  dangerFirst !== undefined && dangerFirst.reason.includes('危险命令拦截'),
  dangerFirst?.reason.slice(0, 40));

const spawnGated = coreBeforeToolCall({ name: 'spawn', args: { command: `echo hi > ${OUTSIDE}/x.txt` } }, false, false);
check('F4 spawn 同判（它手里同样是一条命令串）',
  spawnGated !== undefined && spawnGated.reason.includes('[bash 写纳管]'));

const writeTool = coreBeforeToolCall({ name: 'write', args: { path: `${OUTSIDE}/x.txt`, content: 'x' } }, false, false);
check('F5 write 工具出界仍由**工作区闸**说话（本闸不抢 write 的理由）',
  writeTool !== undefined && writeTool.reason.includes('[工作区边界]') && !writeTool.reason.includes('[bash 写纳管]'),
  writeTool?.reason.slice(0, 40));

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑦ 源码守护
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ⑦ 源码守护（G 段） ──');

check('G1 判据模块零 fs（提取是纯词法，碰 fs 的只有适配器喂进来的字符串）',
  !/node:fs|readFileSync|writeFileSync|existsSync/.test(bwSrc));

check('G2 词法**复用 danger.ts 的同一套**（切段 / 命令词 / 展包装 / 目标归一），不另写一份',
  bwSrc.includes("from './danger.js'")
  && bwSrc.includes('splitSegments') && bwSrc.includes('commandWord')
  && bwSrc.includes('unwrapShell') && bwSrc.includes('expandTarget')
  && !/function tokenize|split\(\/\(\?:&&/.test(bwSrc));

check('G3 边界**复用 workspace.ts 的同一个函数**（改一处两边生效的承重点），本地零 path.relative',
  bwSrc.includes("isOutsideWorkspace") && bwSrc.includes("from './workspace.js'")
  && !bwSrc.includes('path.relative'));

check('G4 适配器圈子走 SHELL_COMMAND_TOOLS（加同形工具时危险闸那边的注释会提醒一起补）',
  bwSrc.includes('SHELL_COMMAND_TOOLS'));

check('G5 MSYS 映射**刻意缺席**：expandTarget 只喂 cwd 与 home，不带 platform',
  bwSrc.includes('{ cwd: ctx.cwd, home: ctx.home }') && !/platform:\s*'win32'/.test(bwSrc));

check('G6 main.ts 真接线：闸在钩子链上、tag 唯一、家目录每次现取',
  mainSrc.includes('guardBashWrite(toolName, e.args')
  && mainSrc.includes("deny('bash 写出工作区', 'bash-write'")
  && mainSrc.includes('homedir()'));

check('G7 拒因带**护栏不是沙箱**声明（与危险闸 / 删除闸同一条界线，不装完备）',
  bwSrc.includes('护栏不是沙箱'));

check('Z1 沙箱隔离：本套的钩子链审计只落临时目录（真仓库 .flint/ 一字未动）',
  process.cwd() === sandbox.dir, process.cwd());

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败（共 ' + (passed + failed) + ' 项）');
process.exit(failed > 0 ? 1 : 0);
