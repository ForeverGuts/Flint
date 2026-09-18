/**
 * verify-grants.ts —— 授权持久化（ROADMAP 10.9.1 的"工作区外写"那一半）
 *
 * 为什么需要它：这条功能**唯一**的价值就是"跨重启还在"，而它同时也是本仓第一个
 * "把授权写进磁盘"的东西 —— 盘上的东西会被**下一次启动**当成用户的签名。
 * 于是一个坏文件、一次读不懂的解析、一次写盘失败，都会变成"授权静默地多出来或消失"。
 * 所以本套件的重心不是"存得对不对"，而是**存错的时候会往哪边倒**。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 落点与文件形状 —— 默认 `~/.flint/permissions.json`、env 优先、version / projects / write
 *      三层形状、键归一化、值绝对化、去重、**落盘排序**（同一状态 → 同一串字节）、
 *      `clear` 不留空壳
 *   ② 按项目分区 —— 两项目互不串；`forgetGrants` 只删本项目、别人的键原样留着；
 *      相对写法按**项目键**解析（不是按当前 cwd）
 *   ③ **读不懂一律不启用**（10 种坏形状逐一打靶，全都不许抛）+ **读不懂不许覆盖**
 *      （坏文件时 `persistGrant` / `forgetGrants` 拒写，且文件**一字未变**）
 *   ④ **磁盘只读一次** —— 读完之后改盘不生效；对照组证明这条有活性
 *   ⑤ `/workspace` 命令的持久化面 —— `allow` 不碰盘 / `allow --save` 落盘 /
 *      状态里的 `[长期]` 与 `[本会话]` 标签 / `clear` 连盘一起清 / 清空不凭空造文件 /
 *      `--save` 的位置语义（写在路径后面就只是路径） / **写盘失败照实说**
 *   ⑥ 真目录 + 真 `seedProjectContext` —— 先清后栽：换项目后表里是**新项目自己**那一份；
 *      真 `guardWorkspaceWrite` 放行 / 拒绝各自正确；播种后改盘、切走再切回来**不生效**
 *   ⑦ 源码守护 —— 落点常量只有一个定义处、判据模块仍然零 fs、`resetGrantsFileCache` 零生产调用方、
 *      写入口的唯一调用方、`fill` 的唯一调用方、模型路径（tools/loop）零引用、
 *      播种里 clear 在 fill **之前**、用法里必须写着 `--save`、拒因里**不许**出现 `--save`
 *   ⑧ 端到端 —— `--save` 之后模拟"新开一个进程"，那条授权**自己回来**且真的放行
 *
 * 一条自保（写在最前面、**不计项数**）：本套件会真写、真清文件，所以**先确认落点被重定向**。
 * 不重定向的话，⑤ 里的 `clear` 用例会把**用户真实的** `~/.flint/permissions.json` 里
 * 本项目那一份长期放行删掉 —— 一次静默的数据丢失。失败就 `exit(1)`，不继续跑。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-grants.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProjectPath } from '../src/eventlog/registry.js';
import { seedProjectContext } from '../src/harness/project-context.js';
import { guardWorkspaceWrite, workspaceGrants } from '../src/permission/workspace.js';
import {
  GRANTS_NAMESPACE,
  forgetGrants,
  loadGrantsFile,
  permissionsFilePath,
  persistGrant,
  persistedGrants,
  resetGrantsFileCache,
} from '../src/permission/grants.js';
import { activate as activateWorkspace } from '../src/commands/builtin/workspace.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-grants-'));
const PERM = path.join(TMP, 'permissions.json');
process.env.FLINT_PERMISSIONS_FILE = PERM;
process.env.FLINT_PROJECTS_FILE = path.join(TMP, 'projects.jsonl');

/* ── 自保（不计项数）：任何写入之前先确认落点被重定向了 ── */
if (permissionsFilePath() !== PERM || !PERM.startsWith(TMP)) {
  console.error(`❌ 落点未重定向到临时目录（当前 = ${permissionsFilePath()}），拒绝继续：`
    + '本套件会清清盘，跑下去会删掉用户真实的长期放行。');
  process.exit(1);
}

/** 临时目录与临时文件在退出时擦掉（挂 exit，不写文末 —— 中途 throw 也要擦） */
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 擦不动就留着，不影响结论 */ }
});

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

/* ── 手法 ── */
const PROJ_A = path.resolve(TMP, 'proj-a'); // 故意**不创建**：归一化对不存在的路径退回字面形态
const PROJ_B = path.resolve(TMP, 'proj-b');
const OUT_A = path.resolve(TMP, 'out-a');
const OUT_B = path.resolve(TMP, 'out-b');
const KEY_A = normalizeProjectPath(PROJ_A);
const KEY_B = normalizeProjectPath(PROJ_B);

/** 造一份合法配置文件（一律过 JSON.stringify —— 路径里有反斜杠，手拼模板串会被当成转义） */
const cfg = (projects: unknown, version: unknown = 1): string => JSON.stringify({ version, projects });

/** 覆盖写盘（null = 删掉）。**不**动内存快照 —— "改盘"和"读盘"要能分开测 */
function setDisk(content: string | null): void {
  if (content === null) {
    if (fs.existsSync(PERM)) fs.rmSync(PERM);
    return;
  }
  fs.mkdirSync(path.dirname(PERM), { recursive: true });
  fs.writeFileSync(PERM, content, 'utf-8');
}
const readDisk = (): string => (fs.existsSync(PERM) ? fs.readFileSync(PERM, 'utf-8') : '');

interface GrantsFile { version?: unknown; projects?: Record<string, Record<string, unknown>> }
const diskJson = (): GrantsFile => JSON.parse(readDisk()) as GrantsFile;
const diskDirs = (key: string): unknown => diskJson().projects?.[key]?.[GRANTS_NAMESPACE];

/** 一轮用例的起点：忘掉"只读一次"的记忆 + 盘上清空 */
function fresh(): void {
  resetGrantsFileCache();
  setDisk(null);
}

/* ══ ① 落点与文件形状 ══ */
console.log('── ① 落点与文件形状 ──');

{
  const saved = process.env.FLINT_PERMISSIONS_FILE;
  delete process.env.FLINT_PERMISSIONS_FILE;
  const def = permissionsFilePath();
  process.env.FLINT_PERMISSIONS_FILE = saved;
  check('A1 默认落点 = `~/.flint/permissions.json`（全局目录，跨项目共享）',
    def === path.join(os.homedir(), '.flint', 'permissions.json'), def);
}
check('A2 `FLINT_PERMISSIONS_FILE` 优先（套件靠它不碰用户真实文件）',
  permissionsFilePath() === PERM, permissionsFilePath());

fresh();
check('A3 文件不存在 → 空表（不报错、不猜）', persistedGrants(PROJ_A).length === 0);

fresh();
check('A4 `persistGrant` 成功返回 undefined', persistGrant(PROJ_A, OUT_A) === undefined);
check('A5 盘上文件真的建出来了', fs.existsSync(PERM));
check('A6 顶层带 `version: 1`（格式可演进，将来加 `read` 层不用换文件）',
  diskJson().version === 1, JSON.stringify(diskJson().version));
check('A7 分区结构是 `projects[键].write[]`',
  Array.isArray(diskDirs(KEY_A)) && (diskDirs(KEY_A) as unknown[]).length === 1,
  JSON.stringify(diskDirs(KEY_A)));
check('A8 键是**归一化**后的项目路径（正斜杠，与通讯录同一把尺子）',
  KEY_A.includes('/') && !KEY_A.includes('\\') && diskJson().projects?.[KEY_A] !== undefined, KEY_A);
check('A9 值是真的绝对路径',
  path.isAbsolute((diskDirs(KEY_A) as string[])[0]!), String((diskDirs(KEY_A) as string[])[0]));
resetGrantsFileCache();
check('A10 忘掉内存、重新读盘 → 与写进去的一致（真往返）',
  persistedGrants(PROJ_A).join('|') === OUT_A, JSON.stringify(persistedGrants(PROJ_A)));

// ⚠ 去重有**两处**实现（写侧 `persistGrant`、读侧载入），而它们会**互相掩护**：
//   初稿只写了一条"记两次 → 重读 → 1 条"，结果把**两处**各自改坏都不红（变异 N03/N08
//   双双全绿 = 实证）。所以这里拆成两条**各自独立**的断言：一条只读内存（不让读侧兜底），
//   一条喂一个**手写重复**的文件（不让写侧兜底）。
fresh();
persistGrant(PROJ_A, OUT_A);
persistGrant(PROJ_A, OUT_A);
check('A11 写侧去重：同一个目录记两次 → **内存里立刻**就是 1 条',
  persistedGrants(PROJ_A).length === 1, JSON.stringify(persistedGrants(PROJ_A)));

fresh();
setDisk(cfg({ [KEY_A]: { write: [OUT_A, OUT_A] } }));
check('A11b 读侧去重：文件里本来就有重复（老文件 / 手改过的）也能收成一个',
  persistedGrants(PROJ_A).length === 1, JSON.stringify(persistedGrants(PROJ_A)));

fresh();
persistGrant(PROJ_A, OUT_A);
persistGrant(PROJ_A, OUT_B);
const bytes1 = readDisk();
fresh();
persistGrant(PROJ_A, OUT_B);
persistGrant(PROJ_A, OUT_A);
check('A12 落盘是**排序**的：加入顺序不同 → 文件字节相同（diff 干净、套件可整串比对）',
  bytes1 === readDisk() && bytes1.length > 0);

fresh();
persistGrant(PROJ_A, OUT_A);
forgetGrants(PROJ_A);
check('A13 `clear` 之后不留空壳（键被删掉，而不是留一个空数组骗人）',
  diskJson().projects?.[KEY_A] === undefined, JSON.stringify(diskJson().projects));

fresh();
persistGrant(PROJ_A, OUT_A);
const copy = persistedGrants(PROJ_A);
copy.push('被调用方塞进来的脏东西');
check('A14 `persistedGrants` 返回**副本**：调用方改它改不到快照（同 `list()` 的语义）',
  persistedGrants(PROJ_A).length === 1, JSON.stringify(persistedGrants(PROJ_A)));

{
  const deep = path.join(TMP, 'not-yet', 'deeper', 'permissions.json');
  const savedEnv = process.env.FLINT_PERMISSIONS_FILE!;
  process.env.FLINT_PERMISSIONS_FILE = deep;
  resetGrantsFileCache();
  const errDeep = persistGrant(PROJ_A, OUT_A);
  process.env.FLINT_PERMISSIONS_FILE = savedEnv;
  resetGrantsFileCache();
  check('A15 落点父目录还不存在 → 自己建出来（第一次用时 `~/.flint/` 本来就不存在）',
    errDeep === undefined && fs.existsSync(deep), String(errDeep));
}

/* ══ ② 按项目分区 ══ */
console.log('── ② 按项目分区 ──');

fresh();
persistGrant(PROJ_A, OUT_A);
persistGrant(PROJ_B, OUT_B);
resetGrantsFileCache();
check('B1 两个项目各记各的，互不串（否则 A 的长期放行会替 B 开门）',
  persistedGrants(PROJ_A).join('|') === OUT_A && persistedGrants(PROJ_B).join('|') === OUT_B,
  `A=${JSON.stringify(persistedGrants(PROJ_A))} B=${JSON.stringify(persistedGrants(PROJ_B))}`);

const fg = forgetGrants(PROJ_A);
check('B2 `forgetGrants` 把删掉的条目返回出来（回执靠它报"盘上清了几个"）',
  fg.removed.join('|') === OUT_A && fg.error === undefined, JSON.stringify(fg));
resetGrantsFileCache();
check('B3 只删本项目：B 的条目还在内存可见',
  persistedGrants(PROJ_A).length === 0 && persistedGrants(PROJ_B).join('|') === OUT_B);
check('B4 而且 B 的键在**盘上**也还在（没被整份覆盖）',
  diskJson().projects?.[KEY_B] !== undefined, JSON.stringify(diskJson().projects));

resetGrantsFileCache();
setDisk(cfg({ [KEY_A]: { write: ['out-rel'] } }));
check('B5 相对写法按**项目键**解析（不是按当前 cwd —— 文件是写给项目看的，不是写给进程看的）',
  persistedGrants(PROJ_A).join('|') === path.resolve(PROJ_A, 'out-rel'),
  JSON.stringify(persistedGrants(PROJ_A)));

/* ══ ③ 读不懂一律不启用；读不懂不许覆盖 ══ */
console.log('── ③ 读不懂一律不启用；读不懂不许覆盖 ──');

// 每一行都是"读出来必须空、且不许抛"的坏形状。10 条覆盖 6 个层级：
// 语法 / 顶层类型 / version / projects 类型 / 项目段类型 / 元素类型与空值。
const badShapes: Array<[string, string]> = [
  ['C1 坏 JSON（截断）', '{"version":1,"proje'],
  ['C2 顶层是数组', '[1,2,3]'],
  ['C3 顶层是字符串', '"hello"'],
  ['C4 projects 是字符串', '{"version":1,"projects":"x"}'],
  ['C5 projects 是数组', '{"version":1,"projects":[]}'],
  ['C6 version 不认识（2）', cfg({ [KEY_A]: { write: [OUT_A] } }, 2)],
  ['C7 项目段是字符串', cfg({ [KEY_A]: 'x' })],
  ['C8 write 不是数组', cfg({ [KEY_A]: { write: 'x' } })],
  ['C9 元素是数字', cfg({ [KEY_A]: { write: [42] } })],
  ['C10 元素是全空白', cfg({ [KEY_A]: { write: ['   '] } })],
];
for (const [name, content] of badShapes) {
  fresh();
  setDisk(content);
  let threw = false;
  let got: string[] = [];
  try {
    got = persistedGrants(PROJ_A);
  } catch {
    threw = true;
  }
  check(`${name} → 空表且**不抛**`, !threw && got.length === 0,
    threw ? '抛了异常' : JSON.stringify(got));
}

fresh();
setDisk(cfg({ [KEY_B]: '不是对象', [KEY_A]: { write: [OUT_A] } }));
check('C11 坏了一半：坏的那段跳过、好的一段**照常生效**（不是整份失效，也不是整份启用）',
  persistedGrants(PROJ_A).join('|') === OUT_A && persistedGrants(PROJ_B).length === 0,
  `A=${JSON.stringify(persistedGrants(PROJ_A))} B=${JSON.stringify(persistedGrants(PROJ_B))}`);

{
  // 承重③：读不懂就**不许覆盖**。这一组是本套件最要紧的一组 ——
  // 没有它，一次 `allow --save` 就能把"读不懂但里面有别的项目"的文件覆盖成只剩当前条目，
  // 而那是一次**静默的跨项目数据丢失**（用户不会知道别人的授权没了）。
  fresh();
  const broken = '{"version":1,"proje';
  setDisk(broken);
  const before = readDisk();
  const errWrite = persistGrant(PROJ_A, OUT_A);
  check('C12 读不懂的文件：`persistGrant` **拒绝写入**并说清原因',
    typeof errWrite === 'string' && errWrite.includes('读不懂'), String(errWrite));
  check('C13 而且文件**一字未变**', readDisk() === before, readDisk().slice(0, 60));

  const fgBroken = forgetGrants(PROJ_A);
  check('C14 同一情况下 `forgetGrants` 也拒绝、`removed` 为空（不许"清了个读不懂的文件"）',
    fgBroken.removed.length === 0 && typeof fgBroken.error === 'string', JSON.stringify(fgBroken));
  check('C15 文件仍然一字未变', readDisk() === before, readDisk().slice(0, 60));

  fresh();
  setDisk(cfg({ [KEY_A]: { write: [OUT_A] } }, 2));
  check('C16 version 不认识 → 同样拒写（不猜怎么迁移）',
    typeof persistGrant(PROJ_B, OUT_B) === 'string' && !readDisk().includes(KEY_B));

  fresh();
  setDisk(cfg({ [KEY_B]: { write: [OUT_B] } }));
  const okWrite = persistGrant(PROJ_A, OUT_A);
  resetGrantsFileCache();
  check('C17 对照：正常文件里加一条 → 成功，且**别的项目原样保留**（读-改-写，不是整份重写）',
    okWrite === undefined && persistedGrants(PROJ_A).join('|') === OUT_A
    && persistedGrants(PROJ_B).join('|') === OUT_B,
    `A=${JSON.stringify(persistedGrants(PROJ_A))} B=${JSON.stringify(persistedGrants(PROJ_B))}`);
}

/* ══ ④ 磁盘只读一次 ══ */
console.log('── ④ 磁盘只读一次（承重①）──');

fresh();
setDisk(cfg({ [KEY_A]: { write: [OUT_A] } }));
check('D1 第一次读拿到盘上的内容', persistedGrants(PROJ_A).join('|') === OUT_A);
setDisk(cfg({ [KEY_A]: { write: [OUT_B] } }));
check('D2 读完之后改盘 → 内存里一点没变（"运行期回读"这条路不存在）',
  persistedGrants(PROJ_A).join('|') === OUT_A, JSON.stringify(persistedGrants(PROJ_A)));
loadGrantsFile();
check('D3 显式再调一次 `loadGrantsFile` 也不重读（它是幂等的）',
  persistedGrants(PROJ_A).join('|') === OUT_A);
resetGrantsFileCache();
check('D4 对照组：清掉"只读一次"的记忆之后才看得到新内容（证明 D2 有活性）',
  persistedGrants(PROJ_A).join('|') === OUT_B, JSON.stringify(persistedGrants(PROJ_A)));

/* ══ ⑤ /workspace 命令的持久化面 ══ */
console.log('── ⑤ /workspace 命令的持久化面 ──');

let reg: { name: string; desc: string; fn: (a: string) => string } | null = null;
activateWorkspace({
  registerCommand: (n: string, d: string, f: (a: string) => string) => { reg = { name: n, desc: d, fn: f }; },
} as never);
const cmd = (a: string): string => reg!.fn(a);

fresh();
workspaceGrants.clear();
const sE1 = cmd(`allow ${OUT_A}`);
check('E1 `allow`（不带 --save）**不碰盘**：随手同意不许静默长期化',
  !fs.existsSync(PERM) && workspaceGrants.list().includes(path.resolve(OUT_A)), sE1.slice(0, 90));

fresh();
workspaceGrants.clear();
const sE2 = cmd(`allow --save ${OUT_A}`);
check('E2 `allow --save` 落了盘',
  fs.existsSync(PERM) && persistedGrants(process.cwd()).includes(path.resolve(OUT_A)),
  JSON.stringify(persistedGrants(process.cwd())));
check('E3 回执明说"已记入长期放行"并给出配置文件路径（用户得知道东西存哪儿了）',
  sE2.includes('已记入长期放行') && sE2.includes(permissionsFilePath()), sE2.slice(0, 200));

fresh();
workspaceGrants.clear();
const sE4 = cmd('allow --save');
check('E4 `allow --save` 没给目录 → 报出来，且不写盘',
  sE4.includes('没给目录') && !fs.existsSync(PERM), sE4.slice(0, 90));

fresh();
workspaceGrants.clear();
cmd(`allow ${OUT_A}`);
check('E5 状态里把只活本会话的标成 `[本会话]`（不标 = 用户以为重启就没了）',
  cmd('').includes('[本会话]') && !cmd('').includes('[长期]'), cmd(''));
cmd(`allow --save ${OUT_B}`);
const sE6 = cmd('');
check('E6 落过盘的标成 `[长期]`（反过来说反了同样误导）',
  sE6.includes('[长期]') && sE6.includes('[本会话]') && sE6.includes(path.resolve(OUT_B)), sE6);

fresh();
workspaceGrants.clear();
cmd(`allow --save ${OUT_A}`);
const sE7 = cmd('clear');
resetGrantsFileCache();
check('E7 `clear` 连盘一起清（只清内存 = 用户刚收回的授权下次启动自己回来）',
  persistedGrants(process.cwd()).length === 0 && workspaceGrants.list().length === 0,
  JSON.stringify(persistedGrants(process.cwd())));
check('E8 回执报出"本会话 N 个 + 盘上 M 个"（撤销了多少要看得见）',
  sE7.includes('已收回全部放行') && sE7.includes('盘上长期条目 1 个'), sE7.slice(0, 140));

fresh();
workspaceGrants.clear();
const sE9 = cmd('clear');
check('E9 盘上本来就没有 → `clear` **不凭空 create 一个文件**，并明说本来就是空的',
  !fs.existsSync(PERM) && sE9.includes('本来就是空的'), sE9.slice(0, 90));

// 盘上**同时**放本项目与别的项目两条：这样 `clear` 才是完整的读-改-写 ——
// 只有本项目那条时才看不出"写回时把别人抹掉"这一类错（初稿就是这么写的，
// 变异 N09"清空变成清掉所有人的"在这条上被漏掉了）。
resetGrantsFileCache();
setDisk(cfg({ [normalizeProjectPath(process.cwd())]: { write: [OUT_A] }, [KEY_B]: { write: [OUT_B] } }));
workspaceGrants.clear();
cmd('clear');
check('E10 `clear` 只清本项目：本项目那条没了，**别人的键在盘上原样留着**（读-改-写，不是整份重写）',
  diskJson().projects?.[KEY_B] !== undefined
  && JSON.stringify(diskDirs(KEY_B)) === JSON.stringify([OUT_B])
  && Object.keys(diskJson().projects ?? {}).length === 1,
  JSON.stringify(diskJson().projects));

{
  // 写盘失败：把落点指到一个"父级是文件"的路径上 → mkdirSync 必炸。
  // 挑了这种造法而不是"只读目录"，因为它在 Windows 上同样可靠。
  const notADir = path.join(TMP, 'a-file-not-a-dir');
  fs.writeFileSync(notADir, 'x');
  const savedEnv = process.env.FLINT_PERMISSIONS_FILE!;
  process.env.FLINT_PERMISSIONS_FILE = path.join(notADir, 'permissions.json');
  resetGrantsFileCache();
  workspaceGrants.clear();
  const sE11 = cmd(`allow --save ${OUT_A}`);
  process.env.FLINT_PERMISSIONS_FILE = savedEnv;
  resetGrantsFileCache();
  check('E11 写盘失败 → 回执照实说"没存上"（不许假装成功：他不会再检查一遍）',
    sE11.includes('没存上') && sE11.includes('重启后不会生效'), sE11.slice(0, 220));
  check('E12 但**本会话仍然放行**（存不上不等于这次授权作废）',
    workspaceGrants.list().includes(path.resolve(OUT_A)), JSON.stringify(workspaceGrants.list()));
}

fresh();
workspaceGrants.clear();
const sE13 = cmd(`allow ${OUT_A} --save`);
check('E13 `--save` 写在路径**后面**时它只是路径的一部分（否则带空格的路径会被从中间咬掉一截）',
  !fs.existsSync(PERM) && workspaceGrants.list().length === 1, sE13.slice(0, 110));

fresh();
workspaceGrants.clear();
const DIR_SP = path.join(TMP, 'a b', 'c');
const sE14 = cmd(`allow --save ${DIR_SP}`);
check('E14 `--save` 之后带空格的路径仍然**整段**当路径',
  persistedGrants(process.cwd()).includes(path.resolve(DIR_SP)), sE14.slice(0, 130));

// ⚠ 这条必须打在**渲染出来的**文本上，不能打在源码上 —— 用法是 `--save` 的**唯一**发现路径
//   （拒因刻意不提它），可源码里躺着 `raw === '--save'` 这个比较式，于是"删掉用法那一行"
//   在源码上完全看不出来。初稿写成源码断言，变异 N19 当场全绿，这就是实证。
check('E15 用法文本里写着 `--save` 与"仅本会话"（删了它 = 这个功能再没人发现得了）',
  cmd(`allow ${OUT_A}`).includes('--save') && cmd(`allow ${OUT_A}`).includes('仅本会话'));

/* ══ ⑥ 真目录 + 真播种：先清后栽 ══ */
console.log('── ⑥ 真目录 + 真播种：先清后栽 ──');

const cwd0 = process.cwd();
const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-pA-'));
const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-pB-'));
const projC = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-pC-'));
const outA = path.join(TMP, 'outside-a');
const outB = path.join(TMP, 'outside-b');
fs.mkdirSync(outA, { recursive: true });
fs.mkdirSync(outB, { recursive: true });
// 真目录要过 realpath 才有确定的键（临时目录的短名/大小写与字面写法可能不同）
const keyA = normalizeProjectPath(projA);
const keyB = normalizeProjectPath(projB);

fresh();
setDisk(cfg({ [keyA]: { write: [outA] }, [keyB]: { write: [outB] } }));

process.chdir(projA);
seedProjectContext({ register: 'explicit' });
check('F1 播种（A）：表里是 **A 自己**盘上那条',
  workspaceGrants.list().join('|') === outA, JSON.stringify(workspaceGrants.list()));

process.chdir(projB);
seedProjectContext({ register: 'explicit' });
check('F2 换到 B：A 的条目**不在**表里（凡在旧项目取得的许可都不跟着搬）',
  !workspaceGrants.list().includes(outA), JSON.stringify(workspaceGrants.list()));
check('F3 且 **B 自己**盘上那条在表里（先清后栽 —— 栽的是 B 自己的，不是从 A 搬来的）',
  workspaceGrants.list().join('|') === outB, JSON.stringify(workspaceGrants.list()));

process.chdir(projC);
seedProjectContext({ register: 'explicit' });
check('F4 盘上没有条目的项目 → 空表（漏清的症状是静默的，所以这条单钉）',
  workspaceGrants.list().length === 0, JSON.stringify(workspaceGrants.list()));

process.chdir(projB);
seedProjectContext({ register: 'explicit' });
check('F5 播种之后：写**本项目的**长期放行目录 → 放行',
  guardWorkspaceWrite('write', { path: path.join(outB, 'x.txt') }) === undefined);
const deniedF6 = guardWorkspaceWrite('write', { path: path.join(outA, 'x.txt') });
check('F6 播种之后：写 A 的（不在本项目名单里）→ 拒，且拒因是这道闸给的',
  deniedF6 !== undefined && deniedF6.reason.includes('[工作区边界]'),
  deniedF6 === undefined ? '放行了' : deniedF6.reason.slice(0, 60));

setDisk(cfg({ [keyB]: { write: [outA] } }));
process.chdir(projC);
seedProjectContext({ register: 'explicit' });
process.chdir(projB);
seedProjectContext({ register: 'explicit' });
check('F7 运行期改盘**不生效**：切走再切回来，表里仍是播种时读到的那条（不是刚写进去的）',
  workspaceGrants.list().join('|') === outB, JSON.stringify(workspaceGrants.list()));
resetGrantsFileCache();
seedProjectContext({ register: 'explicit' });
check('F8 对照组：清掉"只读一次"的记忆之后新内容才生效（证明 F7 有活性）',
  workspaceGrants.list().join('|') === outA, JSON.stringify(workspaceGrants.list()));
process.chdir(cwd0);

/* ══ ⑦ 源码守护 ══ */
console.log('── ⑦ 源码守护 ──');

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, out);
    else if (e.name.endsWith('.ts')) out.push(path.relative(path.join(ROOT, 'src'), p).replace(/\\/g, '/'));
  }
  return out;
}
const srcFiles = walkSrc(path.join(ROOT, 'src')).sort();
const readSrc = (rel: string): string => fs.readFileSync(path.join(ROOT, 'src', rel), 'utf-8');
/** ⚠ 先剥注释再断言：本仓踩过五次"源码文本断言误伤注释" */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const holders = (needle: string): string[] =>
  // ⚠ **必须剥注释再数**：本仓踩过八次"源码文本断言误伤注释"，最近一次就在 verify-workspace
  //   的 G13 —— 一句解释性的 `workspaceGrants.allow()` 把守卫喂饱了。这里七条守卫全走本函数，
  //   一次剥干净，免得同一个坑换个文件再踩一遍。
  [...srcFiles].sort().filter((f) => stripComments(readSrc(f)).includes(needle));

check('G1 `FLINT_PERMISSIONS_FILE` 只有一个定义处（多一处 = 多一个落点，两份会各写各的）',
  JSON.stringify(holders('FLINT_PERMISSIONS_FILE')) === JSON.stringify(['permission/grants.ts']),
  JSON.stringify(holders('FLINT_PERMISSIONS_FILE')));
check('G2 `permissions.json` 这个文件名只在一处出现（别处硬编码就会绕过 env 重定向）',
  JSON.stringify(holders("'permissions.json'")) === JSON.stringify(['permission/grants.ts']),
  JSON.stringify(holders("'permissions.json'")));

const wsCode = stripComments(readSrc('permission/workspace.ts'));
check('G3 判据模块仍然**一个 fs 都不碰**（持久化没有把纯判据拖下水）',
  !/node:fs|child_process|readFileSync|writeFileSync|existsSync|mkdirSync/.test(wsCode));
check('G4 `resetGrantsFileCache` 在生产代码里**零调用方**（有了调用方，"运行期回读"就只差它）',
  JSON.stringify(holders('resetGrantsFileCache(')) === JSON.stringify(['permission/grants.ts']),
  JSON.stringify(holders('resetGrantsFileCache(')));
check('G5 写入口（`persistGrant` / `forgetGrants`）的调用方只有命令层',
  JSON.stringify(holders('persistGrant(')) === JSON.stringify(['commands/builtin/workspace.ts', 'permission/grants.ts'])
  && JSON.stringify(holders('forgetGrants(')) === JSON.stringify(['commands/builtin/workspace.ts', 'permission/grants.ts']),
  `${JSON.stringify(holders('persistGrant('))} / ${JSON.stringify(holders('forgetGrants('))}`);
check('G6 读入口的调用方只有"播种"与命令层的状态渲染（模型路径不在其中）',
  JSON.stringify(holders('persistedGrants(')) === JSON.stringify(
    ['commands/builtin/workspace.ts', 'harness/project-context.ts', 'permission/grants.ts']),
  JSON.stringify(holders('persistedGrants(')));
check('G7 `workspaceGrants.fill(` 的唯一调用方是播种（它是一条"批量开门"，不许扩散）',
  JSON.stringify(holders('workspaceGrants.fill(')) === JSON.stringify(['harness/project-context.ts']),
  JSON.stringify(holders('workspaceGrants.fill(')));
check('G8 模型的路径碰不到它：tools/ 与 loop/ 下零引用',
  srcFiles.filter((f) => /^(tools|loop)\//.test(f) && readSrc(f).includes('permission/grants')).length === 0,
  JSON.stringify(srcFiles.filter((f) => /^(tools|loop)\//.test(f) && readSrc(f).includes('permission/grants'))));

const seedCode = stripComments(readSrc('harness/project-context.ts'));
check('G9 播种里**先清后栽**：`clear()` 紧接 `fill()`，且 clear 在前（顺序反了就是每次播种都清空）',
  /workspaceGrants\.clear\(\);\s*workspaceGrants\.fill\(/.test(seedCode));

const gSrc = readSrc('permission/grants.ts');
check('G10 持久化模块零第三方依赖（import 只指向 node: 内置与本项目模块）',
  (gSrc.match(/^import .*from '([^']+)'/gm) ?? []).every((l) => /from '(node:|\.\.\/)/.test(l)),
  JSON.stringify(gSrc.match(/^import .*from '([^']+)'/gm)));

const cmdCode = stripComments(readSrc('commands/builtin/workspace.ts'));
check('G11 拒因里**不许**出现 `--save`（拒因是递给模型的，长期放行的提示不该由模型来说）',
  !wsCode.includes('--save'));
check('G12 `clear` 分支同时清内存与清盘（只清一边 = 撤销不彻底）',
  cmdCode.includes('workspaceGrants.clear()') && cmdCode.includes('forgetGrants('));

/* ══ ⑧ 端到端：--save 之后"重启"仍然生效 ══ */
console.log('── ⑧ 端到端：--save 之后"重启"仍然生效 ──');

process.chdir(projB);
fresh(); // 盘上清空 + 忘掉"只读一次"
seedProjectContext({ register: 'explicit' });
workspaceGrants.clear(); // 模拟"本会话什么都没放行过"
check('H1 重启前：写项目外 → 拒',
  guardWorkspaceWrite('write', { path: path.join(outA, 'x.txt') }) !== undefined);
check('H2 `--save` 的回执确认存上了', cmd(`allow --save ${outA}`).includes('已记入长期放行'));
check('H3 同一会话内写出去 → 放行',
  guardWorkspaceWrite('write', { path: path.join(outA, 'x.txt') }) === undefined);

// 模拟"新开一个 flint 进程"：清掉"只读一次"的记忆 = 新进程的第一次读盘。
// 这是本套件最想证明的一件事 —— **用户不用重打**。
resetGrantsFileCache();
seedProjectContext({ register: 'explicit' });
check('H4 "重启"之后那条长期放行**自己回来了**（这才是用户要的东西）',
  workspaceGrants.list().join('|') === path.resolve(outA), JSON.stringify(workspaceGrants.list()));
check('H5 "重启"之后写那个目录 → 放行',
  guardWorkspaceWrite('write', { path: path.join(outA, 'x.txt') }) === undefined);
check('H6 对照组：没被 `--save` 过的目录"重启"后**仍然是拒的**（别把闸整个放开）',
  guardWorkspaceWrite('write', { path: path.join(TMP, 'never-saved', 'x.txt') }) !== undefined);
process.chdir(cwd0);

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
if (failed > 0) process.exit(1);
