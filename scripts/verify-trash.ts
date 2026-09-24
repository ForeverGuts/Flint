/**
 * 删除回收站化验证套件（ROADMAP 10.9.6，2026-09-24）。
 *
 * 背景：危险闸（10.9.2）的判决书是"**删除不可逆，所以只能有 L1、没有 L2**"——L2 是事后
 * 拿得出去比对、回滚得回来的基线，而删除一旦发生什么都没留下。本条给删除补上 L2：
 * bash / spawn 里的删除命令**一律改道**到 `trash` 工具，目标进 `.flint/trash/` 并记一笔，
 * 于是"删除"从不可逆变成可撤销（`/undo`）。
 *
 * 验证七段：
 *   ① 判据（命令词）—— 段首命中、大小写/基名/后缀归一、**不看目标**、段首之外的是数据
 *   ② 判据（目标）—— 工作区外 / 项目根 / 回收站自己 三种该拒的形状，纯函数逐条打靶
 *   ③ 真执行 —— 沙箱里真删真移：原处没了、回收站里有了、**保留目录结构**、manifest 一笔
 *   ④ 还原 —— 最近一笔回到原处且字节一致、二次还原报 EMPTY、原处被占**不动**、实体没了报 GONE
 *   ⑤ 清理 —— 超期的清掉并记出库、未超期与"时间读不出来"的一律不动
 *   ⑥ 真接线 —— 真钩子链（rm 被改道、灾难形态仍由危险闸先说话）、真工具注册表（trash 存在
 *      且要确认）、计划模式名单**真的**含 trash
 *   ⑦ 源码守护 —— 判据不碰 fs、落盘只一处、名单不手抄、mv 不在删除词里
 *
 * ⚠ 本套会真写 `.flint/trash/` → 代码体第一件事就是 `enterSandbox()`（见 lib/sandbox.ts）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterSandbox } from './lib/sandbox.js';
import { DELETE_WORDS, findDeleteCommand, guardDeleteRedirect, renderTrashReason } from '../src/permission/trash.js';
import {
  PRUNE_AFTER_DAYS, TRASH_DIR, TRASH_MANIFEST, TRASH_OUT,
  pendingRecords, pruneTrash, readRecords, refuseTarget, trashTarget, undoLast,
} from '../src/tools/trash-bin.js';
import { coreBeforeToolCall } from '../src/harness/main.js';
import { PLAN_BLOCKED_TOOLS, guardPlanMode } from '../src/loop/plan-mode.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 自保（不计项数）：本套真写 .flint/trash/ 与账本 ── */
const sandbox = enterSandbox('flint-trash-');

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
const trashSrc = srcOf('src/permission/trash.ts');
const binSrc = srcOf('src/tools/trash-bin.ts');
const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8');
const undoSrc = srcOf('src/commands/builtin/undo.ts');

/** 建一个文件（含父目录），返回绝对路径 */
function makeFile(rel: string, content: string): string {
  const p = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}
const exists = (p: string): boolean => fs.existsSync(p);
const read = (p: string): string => fs.readFileSync(p, 'utf-8');

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 判据（命令词）：只看段首那一个词
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ① 删除类命令词的判据 ──');

check('A1 七个删除命令词全命中（POSIX 三 + cmd 三 + PowerShell 一）',
  ['rm', 'rmdir', 'unlink', 'del', 'rd', 'erase', 'remove-item']
    .every((w) => findDeleteCommand(`${w} foo`) === w),
  JSON.stringify([...DELETE_WORDS]));

check('A2 **不看目标**：`rm foo.txt` 与 `rm -rf dist` 同样命中（删什么都要入回收站）',
  findDeleteCommand('rm foo.txt') === 'rm' && findDeleteCommand('rm -rf dist') === 'rm');

check('A3 大小写混写归一（RM.EXE 也是 rm）',
  findDeleteCommand('RM -RF dist') === 'rm' && findDeleteCommand('rm.exe x') === 'rm');

check('A4 取基名：`/bin/rm` 与 `rm` 同判（命令词在路径最后一段）',
  findDeleteCommand('/bin/rm -f x') === 'rm'
  && findDeleteCommand('C:/Windows/System32/rd.exe /s /q dist') === 'rd');

check('A5 段首判据：`grep x rm` 与 `echo "rm -rf /"` 里的 rm 是**数据**，不命中',
  findDeleteCommand('grep x rm') === null && findDeleteCommand('echo "rm -rf /"') === null);

check('A6 多段命令：只有某一段的段首是删除 → 命中（`ls && rm x`）',
  findDeleteCommand('ls && rm x') === 'rm' && findDeleteCommand('ls | grep rm') === null);

check('A7 一层包装展开：`bash -c "rm -rf dist"` 命中',
  findDeleteCommand('bash -c "rm -rf dist"') === 'rm');

check('A8 **只展开一层**（与危险闸同口径，不递归就没有收敛问题）',
  findDeleteCommand('bash -c "bash -c \\"rm x\\""') === null);

check('A9 空串 / 全空白 → 不命中（fail-open 交给主流程）',
  findDeleteCommand('') === null && findDeleteCommand('   ') === null);

check('A10 `mv` **不**在删除词里（它是移动，判成删除就误伤了正当用法）',
  !DELETE_WORDS.has('mv') && findDeleteCommand('mv a b') === null);

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 判据（目标）：三种该拒的形状 + 拒因文案
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ② 回收目标的判据（纯函数）──');

const CWD = process.cwd();
check('B1 工作区外的目标 → OUTSIDE', refuseTarget(path.join(CWD, '../out.txt'), CWD, true)?.code === 'OUTSIDE');
check('B2 项目根目录本身 → IS_ROOT（回收它等于把项目和回收站一起搬进自己）',
  refuseTarget(CWD, CWD, false)?.code === 'IS_ROOT');
check('B3 回收站里的东西 → IS_TRASH（不重复回收）',
  refuseTarget(path.join(CWD, TRASH_DIR, 't1/x'), CWD, false)?.code === 'IS_TRASH');
check('B4 回收站目录自身 → 同样是 IS_TRASH',
  refuseTarget(path.join(CWD, TRASH_DIR), CWD, false)?.code === 'IS_TRASH');
check('B5 正常目标 → 不拒（null）', refuseTarget(path.join(CWD, 'src/a.ts'), CWD, false) === null);
check('B6 拒因里都带"人话"（三种各有一句能看懂的理由）',
  ['OUTSIDE', 'IS_ROOT', 'IS_TRASH'].every((c) => {
    const cases: Record<string, string> = {
      OUTSIDE: path.join(CWD, '../out.txt'),
      IS_ROOT: CWD,
      IS_TRASH: path.join(CWD, TRASH_DIR, 't1/x'),
    };
    const r = refuseTarget(cases[c]!, CWD, c === 'OUTSIDE');
    return r !== null && r.message.length > 8;
  }));

const reason = renderTrashReason('rm -rf dist', 'rm');
check('B7 拒因说清"没有被执行"+ 指出 trash 工具 + /undo + 边界声明（四样齐全）',
  reason.includes('没有被执行') && reason.includes('trash') && reason.includes('/undo')
  && reason.includes('护栏不是沙箱'));

check('B8 适配器只看会执行命令串的工具（write 工具传 rm 内容**不**拦）',
  guardDeleteRedirect('write', { path: 'a', content: 'rm x' }) === undefined
  && guardDeleteRedirect('bash', { command: 'rm x' }) !== undefined);
check('B9 spawn 同样在射程内（后台执行也是执行，与危险闸同一口径）',
  guardDeleteRedirect('spawn', { command: 'rm x' }) !== undefined);
check('B10 缺 command / 空串 → fail-open',
  guardDeleteRedirect('bash', {}) === undefined
  && guardDeleteRedirect('bash', { command: '   ' }) === undefined);

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 真执行：沙箱里真删真移
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ③ 真执行（真 fs）──');

const f1 = makeFile('src/tmp/a.txt', 'hello');
const r1 = trashTarget(f1, CWD, false);
check('C1 回收成功：ok=true 且原处**没了**', r1.ok === true && !exists(f1));
check('C2 实体真在回收站里（`.flint/trash/<id>/原相对路径`）',
  r1.ok && exists(path.join(CWD, r1.record.to)) && r1.record.to.startsWith(`${TRASH_DIR}/`),
  r1.ok ? r1.record.to : String(r1.message));
check('C3 **保留原目录结构**（否则还原时不知它原来在哪，也会撞名）',
  r1.ok && r1.record.from === 'src/tmp/a.txt' && r1.record.to.endsWith('/src/tmp/a.txt'),
  r1.ok ? r1.record.to : '');
check('C4 记录字段对：文件 isDir=false、bytes 是真字节数',
  r1.ok && r1.record.isDir === false && r1.record.bytes === 5, r1.ok ? String(r1.record.bytes) : '');
check('C5 manifest 真落盘且只有一笔', readRecords(CWD).length === 1
  && exists(path.join(CWD, TRASH_MANIFEST)));

makeFile('dist/b.js', 'js');
const r2 = trashTarget(path.join(CWD, 'dist'), CWD, false);
check('C6 目录照收：isDir=true、bytes 记 -1（不递归统计，那对大目录是白跑）',
  r2.ok && r2.record.isDir === true && r2.record.bytes === -1);
check('C7 两笔不撞名（id 带序号，同一毫秒连删也不冲突）',
  r1.ok && r2.ok && r1.record.id !== r2.record.id);

const r3 = trashTarget(path.join(CWD, 'no/such.txt'), CWD, false);
check('C8 目标不存在 → NOT_FOUND 且**不记一笔**（不存在的事不该进清单）',
  r3.ok === false && r3.code === 'NOT_FOUND' && readRecords(CWD).length === 2);

const r4 = trashTarget(path.join(CWD, '../outside.txt'), CWD, true);
check('C9 工作区外 → OUTSIDE（回收站只管这个项目里的东西）',
  r4.ok === false && r4.code === 'OUTSIDE');

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 还原：栈式、可撤销、不覆盖
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ④ /undo 还原 ──');

const u1 = undoLast(CWD);
check('D1 还原最近一笔（**后删的先还原** = 刚删的 dist）',
  u1.ok && u1.record.from === 'dist', u1.ok ? u1.record.from : u1.message);
check('D2 文件真回到原处、内容一字未变', exists(path.join(CWD, 'dist/b.js'))
  && read(path.join(CWD, 'dist/b.js')) === 'js');
check('D3 回收站里那份已经不在了（是**移动**不是复制）',
  u1.ok && !exists(path.join(CWD, u1.record.to)));
check('D4 出库记录落盘（out.jsonl 一笔，how=restore）',
  exists(path.join(CWD, TRASH_OUT))
  && read(path.join(CWD, TRASH_OUT)).includes('"how":"restore"'));

const u2 = undoLast(CWD);
check('D5 第二笔还原（src/tmp/a.txt）', u2.ok && u2.record.from === 'src/tmp/a.txt');
check('D6 再还原 → EMPTY（**不是报错**：空回收站是常态）',
  undoLast(CWD).code === 'EMPTY');

// 原位置被占 → 不动任何一方
const f5 = makeFile('occupied.txt', 'new');
trashTarget(f5, CWD, false);
makeFile('occupied.txt', 'other');
const u3 = undoLast(CWD);
check('D7 原位置被占 → OCCUPIED，**两边都没动**（还原不覆盖已有文件）',
  u3.ok === false && u3.code === 'OCCUPIED'
  && read(path.join(CWD, 'occupied.txt')) === 'other'
  && pendingRecords(CWD).some((r) => r.from === 'occupied.txt'));

// 实体被手工清掉 → GONE
const f6 = makeFile('gone.txt', 'x');
trashTarget(f6, CWD, false);
const goneRec = pendingRecords(CWD).find((r) => r.from === 'gone.txt')!;
fs.rmSync(path.join(CWD, goneRec.to), { recursive: true, force: true });
check('D8 实体没了 → GONE，且**记录仍在清单里**（不假装没发生过）',
  undoLast(CWD).code === 'GONE'
  && pendingRecords(CWD).some((r) => r.id === goneRec.id));

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 清理：超期的清掉，读不出来的留着
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ⑤ 超期清理 ──');

const oldFile = makeFile('old.txt', 'old');
trashTarget(oldFile, CWD, false);
const oldRec = pendingRecords(CWD).find((r) => r.from === 'old.txt')!;
// 把这一笔的时间改写成 30 天前（直接改 manifest：本段测的是清理判据，不是写入路径）
const rows = read(path.join(CWD, TRASH_MANIFEST)).trim().split('\n')
  .map((line) => JSON.parse(line) as { id: string; time: string });
const aged = rows.map((r) => (r.id === oldRec.id
  ? { ...r, time: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() }
  : r));
fs.writeFileSync(path.join(CWD, TRASH_MANIFEST),
  aged.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

const pruned = pruneTrash(CWD);
check('E1 超期的被清掉（实体没了）', pruned >= 1 && !exists(path.join(CWD, oldRec.to)), String(pruned));
check('E2 清理记一笔出库（how=prune，与 restore 区分得开）',
  read(path.join(CWD, TRASH_OUT)).includes('"how":"prune"'));
check('E3 未超期的**不动**（清理不是清空）',
  pendingRecords(CWD).length >= 1);

const badFile = makeFile('bad.txt', 'bad');
trashTarget(badFile, CWD, false);
const badRec = pendingRecords(CWD).find((r) => r.from === 'bad.txt')!;
const rows2 = read(path.join(CWD, TRASH_MANIFEST)).trim().split('\n')
  .map((line) => JSON.parse(line) as Record<string, unknown>);
fs.writeFileSync(path.join(CWD, TRASH_MANIFEST),
  rows2.map((r) => (r.id === badRec.id ? { ...r, time: 'not-a-date' } : r))
    .map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
pruneTrash(CWD);
check('E4 时间读不出来 → **一律不清理**（宁可留着，也不凭空删东西）',
  exists(path.join(CWD, badRec.to)));

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑥ 真接线：真钩子链 + 真工具注册表 + 计划模式名单
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ⑥ 真接线 ──');

const gated = coreBeforeToolCall({ name: 'bash', args: { command: 'rm -rf dist' } }, false, false);
check('F1 真钩子链：bash 的 rm 被**改道**（拒 + 拒因指向回收站）',
  gated !== undefined && gated.reason.includes('回收站'), gated?.reason.slice(0, 60));

const stillDanger = coreBeforeToolCall({ name: 'bash', args: { command: 'rm -rf /' } }, false, false);
check('F2 灾难形态仍由**危险闸**先说话（判据更窄的排前面，它给的理由更具体）',
  stillDanger !== undefined && stillDanger.reason.includes('危险命令拦截'),
  stillDanger?.reason.slice(0, 40));

check('F3 计划模式名单**真的**含 trash（它是删除的唯一入口，漏了就整道闸被绕）',
  PLAN_BLOCKED_TOOLS.has('trash') && guardPlanMode('trash', true) !== undefined);

const registry = new ToolRegistry();
registerBuiltinTools(registry);
const names = registry.getLLMTools().map((t) => t.function.name);
check('F4 真注册表里有 trash 工具，且工具数到 20（不是"悄悄多一个"）',
  names.includes('trash') && names.length === 20, String(names.length));
check('F5 trash 需要用户确认（删除是改类动作，不可静默执行）',
  registry.requiresPermission('trash') === true);

const trashOut = await registry.execute('trash', { path: 'wired.txt' });
check('F6 删不存在的 → [INVALID] 且一字不动（拿不准就不动，同 write/edit 的纪律）',
  trashOut.status === 'invalid', `${trashOut.status}: ${trashOut.content.slice(0, 60)}`);

makeFile('wired.txt', 'w');
const wired = await registry.execute('trash', { path: 'wired.txt' });
check('F7 真工具真落回收站：原处没了 + 回执说清撤销办法（**给人读的输出**）',
  wired.status === 'ok' && !exists(path.join(CWD, 'wired.txt'))
  && wired.content.includes('/undo'), `${wired.status}: ${wired.content.slice(0, 80)}`);

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑦ 源码守护
   ═══════════════════════════════════════════════════════════════════════════════ */
console.log('\n── ⑦ 源码守护 ──');

check('G1 判据模块**不碰 fs**（不 import node:fs，才能喂假值逐形状打靶）',
  !/from 'node:fs'/.test(trashSrc) && !/require\(/.test(trashSrc));
check('G2 判据复用 danger.ts 的**同一套词法**（两道闸读命令串的方式必须一致）',
  /from '\.\/danger\.js'/.test(trashSrc) && /splitSegments/.test(trashSrc)
  && /commandWord/.test(trashSrc) && /unwrapShell/.test(trashSrc));
check('G3 会执行命令串的工具名单**不手抄**（直接复用 SHELL_COMMAND_TOOLS）',
  /SHELL_COMMAND_TOOLS/.test(trashSrc) && !/new Set\(\['bash'/.test(trashSrc));
// 全 src/ 扫一遍：`.flint/trash` 这个字面量只许出现在一个文件里 —— 两处各写一份 = 迟早漂移
// （10.7.3 那条教训："同一份跳过表抄了两遍"）。命令层与工具层都只能 import 常量。
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const holders = (needle: string): string[] => walk(path.join(ROOT, 'src'))
  .filter((p) => fs.readFileSync(p, 'utf-8').includes(needle))
  .map((p) => path.relative(ROOT, p).replace(/\\/g, '/'));
// 两个"落点常量"只许活在 trash-bin.ts：别处要用就 import，不许再抄一份路径字面量
check('G4 回收站的两个落点常量只此一处（manifest / out 都不在别处出现）',
  holders('TRASH_MANIFEST').join() === 'src/tools/trash-bin.ts'
  && holders('TRASH_OUT').join() === 'src/tools/trash-bin.ts',
  [...holders('TRASH_MANIFEST'), ...holders('TRASH_OUT')].join(','));

// trash 工具那一块（切片到下一个工具定义为止）必须**只调 trashTarget**，自己不动手
const trashAt = builtinSrc.indexOf("name: 'trash'");
const nextAt = builtinSrc.indexOf("name: '", trashAt + 10);
const trashBlock = builtinSrc.slice(trashAt, nextAt === -1 ? undefined : nextAt);
check('G4b trash 工具自己**不碰回收站**（块内没有 renameSync / appendFileSync，动手全在 trash-bin）',
  trashAt !== -1 && trashBlock.includes('trashTarget')
  && !/renameSync|appendFileSync/.test(trashBlock), `切到 ${trashBlock.length} 字符`);
check('G4c 命令层**不碰 fs**（/undo 只调 trash-bin 的函数，不自己读写文件）',
  !/node:fs/.test(undoSrc) && /trashTarget|undoLast/.test(undoSrc));
check('G5 回收站目录常量只此一处（回收站相关的三处落点都从它派生）',
  (binSrc.match(/\.flint\/trash/g) ?? []).length >= 3 && /TRASH_DIR/.test(undoSrc));
check('G6 移动用 rename（**要么整体搬走、要么没动**，不存在搬了一半）',
  /renameSync/.test(binSrc) && !/rmSync/.test(binSrc.split('pruneTrash')[0] ?? ''));
check('G7 命令注册名 undo，用法里写清两条（还原 / 看清单）',
  /registerCommand\(\s*'undo'/.test(undoSrc) && /\/undo list/.test(undoSrc));
check('G8 清理阈值是**单一来源**（命令层 import 它，不另写一个数字）',
  /PRUNE_AFTER_DAYS/.test(undoSrc) && /export const PRUNE_AFTER_DAYS/.test(binSrc));
check('G9 沙箱隔离：本套只在临时目录里造回收站（真仓库 .flint/ 一字未动）',
  process.cwd() === sandbox.dir, process.cwd());

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败（共 ' + (passed + failed) + ' 项）');
process.exit(failed > 0 ? 1 : 0);
