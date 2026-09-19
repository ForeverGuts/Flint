/**
 * verify-audit.ts —— 审计留痕（ROADMAP 10.9.4）
 *
 * 为什么需要它：这条功能**不改任何判据**，它唯一的作用是"事后查得到"。于是它最典型的失效
 * 方式不是报错，而是**静默地记错**：
 *   · 明明拦了却记成"放行"，或者记了但**来源串了位**（把工作区闸的账记到危险闸头上）；
 *   · 该记的没记（授权动作无痕 —— 那正是它要治的病）；
 *   · **不该记的记了**（每次正常调用都留一条，真事件被噪音淹掉）；
 *   · 落盘失败把工具调用带崩（审计是旁路，反噬主流程比记不上更坏）。
 * 所以本套件的重心是"**身份**对不对"和"**该不该记**"，不是"字符串拼得好不好看"。
 *
 * 验什么：
 *   ① 目标摘要纯函数 —— path/command 取值顺序、各异常形状、截断口径
 *   ② 条目形状 —— kind / 标题拼法 / tags / **缺省就不写键** / 真落盘
 *   ③ 落盘失败**静默**（内存索引仍然收下）
 *   ④ 四道闸的**身份** —— 真跑 `coreBeforeToolCall`：谁拒的、tag 对不对、一次只记一条、放行不记
 *   ⑤ 命令层 —— `allow` / `--save` / `clear` 记什么；只看与空 clear **不记**
 *   ⑥ 权限弹窗 —— 拒绝与「本次全部允许」记、**允许一次不记**；**并真跑一遍
 *      `runtime.askPermission`** —— 光测 audit.ts 那个函数测不到"接线有没有接对"
 *      （接线错了就是记错账，正是本套件要治的病）
 *   ⑦ 拉通道守护 —— 提示词组装层零 eventStore 引用（模型不会自动看到审计）
 *   ⑧ 源码守护 —— 落点唯一（只有 audit.ts 调 recordAudit）、调用方各自不再自己拼条目
 *
 * 一条自保（写在最前面、**不计项数**）：钩子链的落点是**相对路径** `.flint/events.jsonl`
 * ——那是**项目资产**，不换 cwd 就会把测试条目塞进本仓库的事件库。所以本套件先 chdir 到
 * 临时目录，跑完再 chdir 回来。同理，授权落点也要重定向（否则 `allow --save` 会写进用户
 * 真实的 `~/.flint/permissions.json`）。任一条不成立就 exit(1)，不继续跑。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-audit.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventStore } from '../src/eventlog/store.js';
import {
  DIGEST_LIMIT,
  recordGateDeny,
  recordGrant,
  recordPermissionChoice,
  recordRevoke,
  targetDigest,
} from '../src/permission/audit.js';
import { coreBeforeToolCall } from '../src/harness/main.js';
import { activate as activateWorkspace } from '../src/commands/builtin/workspace.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { CHARTER_FILE } from '../src/project/charter.js';
import { permissionsFilePath, resetGrantsFileCache } from '../src/permission/grants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-audit-'));
const CWD0 = process.cwd();
const PERM = path.join(TMP, 'permissions.json');
process.env.FLINT_PERMISSIONS_FILE = PERM;
process.chdir(TMP);

/* ── 自保（不计项数）：任何写入之前先确认 cwd 与授权落点都被重定向 ── */
if (process.cwd() !== TMP || !process.cwd().startsWith(os.tmpdir())
  || permissionsFilePath() !== PERM || !PERM.startsWith(TMP)) {
  console.error(`❌ cwd / 授权落点没有重定向到临时目录（cwd=${process.cwd()}，落点=${permissionsFilePath()}），`
    + '拒绝继续：本套件会真写事件库与授权文件，跑下去会污染本项目与用户真实的长期放行。');
  process.exit(1);
}

process.on('exit', () => {
  try { process.chdir(CWD0); } catch { /* 回不去也不影响结论 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 擦不动就留着 */ }
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

const lastOf = () => {
  const all = eventStore.all();
  return all[all.length - 1]!;
};
/** 从某个水位之后取全部审计条目（水位 = 调用前的 eventStore.count()） */
const auditsSince = (mark: number) => eventStore.all().slice(mark).filter((e) => e.tags.includes('audit'));
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

/**
 * 「只留首行」的判据：取**拒因第二行开头**当探针 —— 审计条目里一旦出现它，就说明那封信
 * 被整封抄进去了。
 *
 * 为什么用第二行而不是某个固定文案：**不绑在闸的措辞上**（改一句教学话不该让套件红）。
 * 为什么不能写成"outcome 里不含 `\n`"：落库那一步（`eventlog/store.ts` 的 `opt`）会先把
 * 所有空白**折叠成单个空格**，于是 outcome 永远不含 `\n` —— 那样写是恒真的空断言（踩过）。
 * 局限：判据要靠"第二行落在折叠后前 200 字之内"才有效（超过就被 200 字上限剪掉了）；
 * 当前三条多行拒因都满足（第二行分别起于第 66 / 29 / 99 字），真要越界也只会失效成"绿"，
 * 不会误报红。
 */
const secondLineMark = (reason: string): string =>
  (reason.split('\n')[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 12);

/* ═══ ① 目标摘要（纯函数）═══ */
console.log('\n── ① 目标摘要 targetDigest（纯函数，按参数形状取值）──');
check('A1 write 的 path', targetDigest({ path: 'C:/x/y.ts' }) === 'C:/x/y.ts');
check('A2 edit 的 path（同一个键）', targetDigest({ path: 'src/a.ts', oldText: 'a', newText: 'b' }) === 'src/a.ts');
check('A3 bash 的 command', targetDigest({ command: 'git status' }) === 'git status');
check('A4 两个键都有 → 取 path（取值顺序**就是**判据）', targetDigest({ command: 'c', path: 'p' }) === 'p');
check('A5 path 不是字符串 → 退到 command', targetDigest({ path: 42, command: 'c' }) === 'c');
check('A6 path 是空白 → 退到 command', targetDigest({ path: '   ', command: 'c' }) === 'c');
check('A7 前后空白被裁掉', targetDigest({ path: '  C:/x.ts  ' }) === 'C:/x.ts');
check('A8 两个键都是空白 → 兜底整串 JSON（键**确实存在**，与"没有这两个键"不是一回事）',
  targetDigest({ path: '', command: '  ' }) === '{"path":"","command":"  "}',
  String(targetDigest({ path: '', command: '  ' })));
check('A9 空对象 → undefined', targetDigest({}) === undefined);
check('A10 null → undefined', targetDigest(null) === undefined);
check('A11 数组 → undefined', targetDigest([1, 2]) === undefined);
check('A12 字符串 → undefined', targetDigest('x') === undefined);
check('A13 数字 → undefined', targetDigest(42) === undefined);
check('A14 只有别的键 → 兜底整串 JSON（宁可粗糙也别让条目空着）',
  targetDigest({ foo: 'bar' }) === '{"foo":"bar"}');
check('A15 超长值截到限额 + 省略号（与流水的 argsDigest 同口径）',
  targetDigest({ path: 'x'.repeat(500) }) === `${'x'.repeat(DIGEST_LIMIT)}…`);
check('A16 恰好等于限额时不加省略号', targetDigest({ path: 'x'.repeat(DIGEST_LIMIT) }) === 'x'.repeat(DIGEST_LIMIT));
check('A17 兜底 JSON 受同一限额', (targetDigest({ foo: 'x'.repeat(500) }) ?? '').length === DIGEST_LIMIT + 1);

/* ═══ ② 条目形状 ═══ */
console.log('\n── ② 条目形状（构成审计档案的那一行）──');
const EFILE = path.join(TMP, 'events-shape.jsonl');

eventStore.recordAudit(
  { action: 'deny', subject: 'write', source: '工作区外写', target: 'D:/x/y.ts', reason: '目标在工作目录之外', tag: 'workspace' },
  EFILE,
);
check('B1 kind = system（与 tool_call 流水分开、与叙事同列）', lastOf().kind === 'system');
check('B2 标题 = 动作 + 主语 +（来源）', lastOf().title === '拦截 write（工作区外写）', lastOf().title);
check('B3 目标进 context 且带前缀', lastOf().context === '目标: D:/x/y.ts', String(lastOf().context));
check('B4 理由进 outcome', lastOf().outcome === '目标在工作目录之外', String(lastOf().outcome));
check('B5 tags = audit + 动作 + 来源分类', lastOf().tags.join(',') === 'audit,deny,workspace', lastOf().tags.join(','));
check('B6 有 id 与 ISO 时间', /^ev_/.test(lastOf().id) && /^\d{4}-\d{2}-\d{2}T/.test(lastOf().time));
const shapeLines = fs.readFileSync(EFILE, 'utf-8').trim().split('\n');
check('B7 真的落盘了（文件最后一行就是这条）',
  shapeLines.length === 1 && JSON.parse(shapeLines[0]!).id === lastOf().id);

eventStore.recordAudit({ action: 'grant', subject: 'D:/shared', source: '长期' }, EFILE);
check('B8 grant → 「放行」', lastOf().title === '放行 D:/shared（长期）', lastOf().title);
eventStore.recordAudit({ action: 'revoke', subject: '本项目的外写放行' }, EFILE);
check('B9 revoke → 「撤销」，无来源时标题不带括号', lastOf().title === '撤销 本项目的外写放行', lastOf().title);
eventStore.recordAudit({ action: 'refuse', subject: 'bash' }, EFILE);
check('B10 refuse → 「拒绝」', lastOf().title === '拒绝 bash', lastOf().title);
check('B11 没有目标 → **不写** context 键（不留空壳）', !('context' in lastOf()));
check('B12 没有理由 → **不写** outcome 键', !('outcome' in lastOf()));
eventStore.recordAudit({ action: 'deny', subject: 'bash', target: '  ', reason: '   ' }, EFILE);
check('B13 空白目标 / 空白理由同样不写键', !('context' in lastOf()) && !('outcome' in lastOf()));
eventStore.recordAudit({ action: 'deny', subject: 'x'.repeat(200) }, EFILE);
check('B14 主语超长 → 截到 80 + 省略号',
  lastOf().title.endsWith('…') && lastOf().title.length === '拦截 '.length + 81, String(lastOf().title.length));
eventStore.recordAudit({ action: 'deny', subject: 'bash', tag: '' }, EFILE);
check('B15 tag 是空串 → 不加多余标签', lastOf().tags.join(',') === 'audit,deny', lastOf().tags.join(','));

const mark = eventStore.count();
recordGateDeny({ source: '工作区外写', tag: 'workspace', toolName: '', args: { path: 'p' } });
check('B16 工具名空串 → 主语记成 (未知工具)（只影响显示，不改判据）',
  lastOf().title === '拦截 (未知工具)（工作区外写）', lastOf().title);
check('B17 recordGateDeny 也把目标带上了', lastOf().context === '目标: p', String(lastOf().context));
recordGateDeny({ source: 'x', tag: 'y', toolName: 'write', args: {}, reason: '' });
check('B18 空 args + 空 reason → 两个键都不写', !('context' in lastOf()) && !('outcome' in lastOf()));
check('B19 每次调用各记一条（不是覆盖）', eventStore.count() === mark + 2);
recordGateDeny({
  source: 'x', tag: 'y', toolName: 'write', args: {}, reason: '第一行结论\n\n第二段是那封几百字的拒因信（给模型看的）',
});
check('B20 拒因只取首行 —— 审计是书签，不做拒因全文的第二份拷贝',
  lastOf().outcome === '第一行结论', String(lastOf().outcome));
recordGateDeny({ source: 'x', tag: 'y', toolName: 'write', args: {}, reason: 'y'.repeat(500) });
check('B21 但那首行也受 200 字限额（与目标同口径）',
  (lastOf().outcome ?? '').length === 201, String((lastOf().outcome ?? '').length));

/* ═══ ③ 落盘失败静默 ═══ */
console.log('\n── ③ 落盘失败必须静默（审计是旁路，不许反噬主流程）──');
const blocker = path.join(TMP, 'blocker');
fs.writeFileSync(blocker, 'x');
const beforeC = eventStore.count();
let threw = false;
try {
  eventStore.recordAudit({ action: 'deny', subject: 'write' }, path.join(blocker, 'events.jsonl'));
} catch {
  threw = true;
}
check('C1 落点不可写 → 不抛（只是这份没进档案）', !threw);
check('C2 内存索引仍然收下了它（当轮还查得到）', eventStore.count() === beforeC + 1);

/* ═══ ④ 四道闸的身份（真跑钩子链）═══ */
console.log('\n── ④ 四道闸的身份（真跑 coreBeforeToolCall）──');
const runGate = (name: unknown, args: unknown, unlocked = false) => {
  const m = eventStore.count();
  const deny = coreBeforeToolCall({ name, args }, unlocked);
  return { deny, audits: auditsSince(m) };
};

const gCharter = runGate('write', { path: CHARTER_FILE });
check('D1 契约锁命中 → 被拒', gCharter.deny !== undefined);
check('D2 来源记的是「契约锁」（来源不另存字段，落在标题里）',
  gCharter.audits[0]?.title === '拦截 write（契约锁）', String(gCharter.audits[0]?.title));
check('D3 tag = charter', gCharter.audits[0]?.tags.includes('charter') === true, gCharter.audits[0]?.tags.join(','));
check('D4 一次拦截**只记一条**（不是每道闸各记一条）', gCharter.audits.length === 1, String(gCharter.audits.length));
check('D5 目标 = 那个被保护的路径', gCharter.audits[0]?.context === `目标: ${CHARTER_FILE}`,
  String(gCharter.audits[0]?.context));
check('D6 拒因进了 outcome（查账看得到为什么）',
  typeof gCharter.audits[0]?.outcome === 'string' && (gCharter.audits[0]!.outcome ?? '').length > 0,
  String(gCharter.audits[0]?.outcome));
// 注：契约锁这条拒因本身就是**单行**，所以"只留首行"在它身上照不出来（照了也是恒真）。
// 「只取首行」这条判据必须拿**真的多行拒因**打靶 —— 见 D8b（危险闸）与 D10b（路由）。

const gDanger = runGate('bash', { command: `rm -rf ${os.homedir()}` });
check('D7 危险命令命中 → 来源「危险命令」/ tag danger',
  gDanger.deny !== undefined && gDanger.audits[0]?.title === '拦截 bash（危险命令）'
  && gDanger.audits[0]?.tags.includes('danger') === true,
  `${String(gDanger.audits[0]?.title)} / ${String(gDanger.audits[0]?.tags.join(','))}`);
check('D8 目标 = 那条命令（与流水同一截断口径）',
  gDanger.audits[0]?.context === `目标: rm -rf ${os.homedir()}`, String(gDanger.audits[0]?.context));
check('D8b 危险闸的多行拒因**只留首行** —— 审计是书签，不做那封几百字信的第二份拷贝',
  typeof gDanger.audits[0]?.outcome === 'string' && gDanger.audits[0]!.outcome!.startsWith('[危险命令拦截]')
  && secondLineMark(gDanger.deny?.reason ?? '') !== ''
  && !gDanger.audits[0]!.outcome!.includes(secondLineMark(gDanger.deny?.reason ?? '')),
  `${String(gDanger.audits[0]?.outcome)} / 探针=${secondLineMark(gDanger.deny?.reason ?? '')}`);

const OUTSIDE = path.join(os.homedir(), 'flint-audit-outside.txt');
const gWs = runGate('write', { path: OUTSIDE });
check('D9 工作区外写 → 来源「工作区外写」/ tag workspace',
  gWs.deny !== undefined && gWs.audits[0]?.title === '拦截 write（工作区外写）'
  && gWs.audits[0]?.tags.includes('workspace') === true,
  `${String(gWs.audits[0]?.title)} / ${String(gWs.audits[0]?.tags.join(','))}`);
check('D9b 工作区闸那条更长的信同样只留首行（三个多行拒因的产出方各打一次）',
  typeof gWs.audits[0]?.outcome === 'string' && gWs.audits[0]!.outcome!.startsWith('[工作区边界]')
  && secondLineMark(gWs.deny?.reason ?? '') !== ''
  && !gWs.audits[0]!.outcome!.includes(secondLineMark(gWs.deny?.reason ?? '')),
  `${String(gWs.audits[0]?.outcome)} / 探针=${secondLineMark(gWs.deny?.reason ?? '')}`);

const gRoute = runGate('bash', { command: 'git status' });
check('D10 裸 git 只读 → 记为「改道 git 工具」/ tag route（改道也是"没按原样执行"的事实）',
  gRoute.deny !== undefined && gRoute.audits[0]?.title === '拦截 bash（改道 git 工具）'
  && gRoute.audits[0]?.tags.includes('route') === true,
  `${String(gRoute.audits[0]?.title)} / ${String(gRoute.audits[0]?.tags.join(','))}`);
check('D10b 改道理由同样只留首行（路由不在四道闸里，但它也写审计）',
  typeof gRoute.audits[0]?.outcome === 'string' && gRoute.audits[0]!.outcome!.startsWith('「')
  && secondLineMark(gRoute.deny?.reason ?? '') !== ''
  && !gRoute.audits[0]!.outcome!.includes(secondLineMark(gRoute.deny?.reason ?? '')),
  `${String(gRoute.audits[0]?.outcome)} / 探针=${secondLineMark(gRoute.deny?.reason ?? '')}`);

const gOk = runGate('write', { path: path.join(TMP, 'inside.txt') });
check('D11 放行的调用 → 返回 undefined', gOk.deny === undefined);
check('D12 放行的调用**一条都不记**（流水已经全量记了，审计别重复）', gOk.audits.length === 0);
const gUnknown = runGate(undefined, { command: 'echo hi' });
check('D13 工具名不是字符串 → 不崩、不记', gUnknown.deny === undefined && gUnknown.audits.length === 0);
const gUnlocked = runGate('write', { path: CHARTER_FILE }, true);
check('D14 契约锁已解锁 → 放行且不记（解锁与否只由 charterLock 说）',
  gUnlocked.deny === undefined && gUnlocked.audits.length === 0);

// 次序的**行为**打靶：一道命令同时踩中两道闸时，记下来的必须是**排前面**那道。
// （单闸用例照不出次序 —— 这也是为什么光靠"各闸各测一条"不够。）
const gBoth = runGate('bash', { command: `rm -rf ${os.homedir()} ; echo x > .flint/CHARTER.md` });
check('D15 同时踩中契约闸与危险闸 → 记的是排前面的「契约锁」（次序即设计）',
  gBoth.audits[0]?.title === '拦截 bash（契约锁）', String(gBoth.audits[0]?.title));

/* ═══ ⑤ 命令层 ═══ */
console.log('\n── ⑤ 命令层：放行与收回 ──');
let reg: { fn: (a: string) => string } | null = null;
activateWorkspace({
  registerCommand: (_n: string, _d: string, f: (a: string) => string) => { reg = { fn: f }; },
} as never);
const cmd = (a: string) => reg!.fn(a);
const DIR_A = path.join(TMP, 'shared-a');
fs.mkdirSync(DIR_A, { recursive: true });

let m5 = eventStore.count();
cmd(`allow ${DIR_A}`);
let recs = auditsSince(m5);
check('E1 `allow` 记一条 grant', recs.length === 1 && recs[0]!.tags.includes('grant') === true, String(recs.length));
check('E2 标题里带着「本会话」这个来源', recs[0]?.title.endsWith('（本会话）') === true, String(recs[0]?.title));
check('E3 主语是那个目录的绝对路径', recs[0]?.title === `放行 ${path.resolve(DIR_A)}（本会话）`, String(recs[0]?.title));
check('E4 理由说明重启后失效', recs[0]?.outcome === '本会话有效，重启后失效', String(recs[0]?.outcome));

// 上面那条传的**本来就是绝对路径**，所以"记的是归一化后的绝对路径"在它身上照不出来
// （原串与归一化结果逐字相同）。这里喂一个相对写法，让两者**必然不同** —— 那才是判据。
m5 = eventStore.count();
cmd('allow ./inner/../shared-b');
recs = auditsSince(m5);
check('E4b 相对写法 → 账里记的是**归一化后的绝对路径**（相对路径换个 cwd 就指向别处，查账的人没法凭它找目录）',
  recs[0]?.title === `放行 ${path.resolve(TMP, 'shared-b')}（本会话）`, String(recs[0]?.title));

m5 = eventStore.count();
cmd(`allow --save ${DIR_A}`);
recs = auditsSince(m5);
check('E5 `allow --save` 的来源是「长期」', recs[0]?.title.endsWith('（长期）') === true, String(recs[0]?.title));
check('E6 理由说明重启后自动回来', recs[0]?.outcome === '长期有效，重启后自动回来', String(recs[0]?.outcome));

m5 = eventStore.count();
cmd('');
check('E7 只查看（无参数）**不记** —— 它不是授权动作', auditsSince(m5).length === 0);

m5 = eventStore.count();
cmd('clear');
recs = auditsSince(m5);
check('E8 `clear` 记一条 revoke', recs.length === 1 && recs[0]!.tags.includes('revoke') === true, String(recs.length));
check('E9 理由里带上了收回的条数', /\d+ 条/.test(recs[0]?.outcome ?? ''), String(recs[0]?.outcome));
check('E10 主语说的是"本项目的外写放行"', recs[0]?.title === '撤销 本项目的外写放行', String(recs[0]?.title));

m5 = eventStore.count();
cmd('clear');
check('E11 本来就空的 clear **不记**（不改变任何账目）', auditsSince(m5).length === 0);

m5 = eventStore.count();
cmd('bogus');
check('E12 未知参数**不记**（它连授权都没发生）', auditsSince(m5).length === 0);

// 落盘失败的那两条路：授权**已经生效**了，账要照记，但话必须说清 —— 谎报比漏记更坏
// （用户按"已经长期化了"的账去理解，下次启动发现没了，会以为程序坏了）。
process.env.FLINT_PERMISSIONS_FILE = path.join(blocker, 'permissions.json');
m5 = eventStore.count();
cmd(`allow --save ${DIR_A}`);
recs = auditsSince(m5);
check('E13 `--save` 写盘失败时，账里写明"只本会话有效"（不谎报成长期）',
  recs[0]?.outcome?.includes('长期化失败') === true, String(recs[0]?.outcome));

process.env.FLINT_PERMISSIONS_FILE = PERM;   // 先把落点从"写不进去的那个"复位回来
fs.writeFileSync(PERM, '{ 这是坏的 JSON');
resetGrantsFileCache();
cmd(`allow ${DIR_A}`);
m5 = eventStore.count();
cmd('clear');
recs = auditsSince(m5);
check('E14 盘上那份读不懂、清不掉时，账里照样如实写出来',
  /没能清掉/.test(recs[recs.length - 1]?.outcome ?? ''), String(recs[recs.length - 1]?.outcome));
fs.rmSync(PERM, { force: true });
resetGrantsFileCache();
process.env.FLINT_PERMISSIONS_FILE = PERM;

/* ═══ ⑥ 权限弹窗 ═══ */
console.log('\n── ⑥ 权限弹窗上的决定 ──');
m5 = eventStore.count();
recordPermissionChoice('bash', 'rm -rf build', 'allow');
check('F1 「允许一次」**不记**（不改变授权状态，且每次调用都点它）', auditsSince(m5).length === 0);

m5 = eventStore.count();
recordPermissionChoice('bash', 'rm -rf build', 'deny');
recs = auditsSince(m5);
check('F2 「拒绝」记一条 refuse', recs.length === 1 && recs[0]!.tags.includes('refuse') === true, String(recs.length));
check('F3 弹窗文案进目标（认得出是哪一次）', recs[0]?.context === '目标: rm -rf build', String(recs[0]?.context));
check('F4 来源是「权限弹窗」', recs[0]?.title === '拒绝 bash（权限弹窗）', String(recs[0]?.title));

m5 = eventStore.count();
recordPermissionChoice('bash', 'rm -rf build', undefined);
check('F5 弹窗被取消（undefined）也记，且说清是取消',
  auditsSince(m5)[0]?.outcome?.includes('取消') === true, String(auditsSince(m5)[0]?.outcome));

m5 = eventStore.count();
recordPermissionChoice('write', 'C:/x.ts', 'always');
recs = auditsSince(m5);
check('F6 「本次全部允许」记一条 grant（它把"每次都问"改成了"不再问"）',
  recs.length === 1 && recs[0]!.tags.includes('grant') === true, String(recs.length));
check('F7 理由点明"本会话内不再询问"', /不再询问/.test(recs[0]?.outcome ?? ''), String(recs[0]?.outcome));

m5 = eventStore.count();
recordPermissionChoice('', 'd', 'deny');
check('F8 工具名空串 → 主语记成 (未知工具)', lastOf().title === '拒绝 (未知工具)（权限弹窗）', lastOf().title);

/* ── 接线打靶：真的从 runtime.askPermission 走一遍 ──
   F1-F8 打的是 audit.ts 那个函数**本身**；"runtime 到底有没有调它、把选择器的返回值传对没有"
   是另一回事 —— 而接线错了就是**记错账**（把「允许一次」记成拒绝、把取消记成同意之类），
   正是本套件头注里列的头号失效方式。所以这里起一个真 Runtime（子系统全打桩，只借它的
   选择器钩子与弹窗那条路），喂进四种决定。 */
const rt = new Runtime({
  llm: { chat: async () => ({ content: '' }), stream: () => { throw new Error('本套件不触发 LLM'); } },
  session: {} as never,
  tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: '' }), register: () => {} },
  permission: { isAutoAllowed: () => false, grantAutoAllow: () => {}, clear: () => {} },
  skills: { load: () => {} },
  events: new PromptEventEmitter(),
  spanCollector: { collect: () => [], running: () => [] },
  commandSystem: { register: () => {}, list: () => [], execute: () => null },
  diagnosticsService: { record: () => {}, getAll: () => [] },
  compaction: { maybeCompact: async (m: unknown[]) => ({ compacted: false, messages: m }) },
  systemPromptService: { build: async () => ({ messages: [] }) },
} as never);
// 弹窗是私有方法 —— 这里刻意从"窗口"敲进去：那是生产上唯一会被走到的入口
const ask = (t: string, d: string): Promise<'allow' | 'deny' | 'always'> =>
  (rt as unknown as { askPermission(a: string, b: string): Promise<'allow' | 'deny' | 'always'> })
    .askPermission(t, d);

rt.registerSelect(async () => 'deny');
m5 = eventStore.count();
let ret = await ask('bash', 'rm -rf build');
recs = auditsSince(m5);
check('F9 真弹窗选「拒绝」→ 照记一条，且**返回值不变**（留痕不许改动流程）',
  ret === 'deny' && recs.length === 1 && recs[0]!.tags.includes('refuse') === true,
  `${ret} / ${String(recs.length)}`);

rt.registerSelect(async () => 'allow');
m5 = eventStore.count();
ret = await ask('bash', 'rm -rf build');
check('F10 真弹窗选「允许一次」→ **不记**，返回值是允许',
  ret === 'allow' && auditsSince(m5).length === 0, `${ret} / ${String(auditsSince(m5).length)}`);

rt.registerSelect(async () => 'always');
m5 = eventStore.count();
ret = await ask('write', 'C:/x.ts');
recs = auditsSince(m5);
check('F11 真弹窗选「本次全部允许」→ 记 grant，返回值是 always',
  ret === 'always' && recs.length === 1 && recs[0]!.tags.includes('grant') === true,
  `${ret} / ${String(recs.length)}`);

rt.registerSelect(async () => undefined);   // 选择器返回 undefined = 弹窗被取消
m5 = eventStore.count();
ret = await ask('bash', 'rm -rf build');
recs = auditsSince(m5);
check('F12 真弹窗被取消 → 记一条拒绝且写明是取消，返回值是拒绝（取消 ≡ 不做）',
  ret === 'deny' && recs.length === 1 && recs[0]!.outcome?.includes('取消') === true,
  `${ret} / ${String(recs[0]?.outcome)}`);

/* ═══ ⑦ 拉通道守护 ═══ */
console.log('\n── ⑦ 审计留在拉通道里（模型不会自动看到它）──');
const ctxFiles = walk(path.join(ROOT, 'src/context')).filter((f) => f.endsWith('.ts'));
check('G1 提示词组装层（src/context）零 eventStore 引用 —— 审计不会被自动注入上下文',
  ctxFiles.length > 0 && ctxFiles.every((f) => !fs.readFileSync(f, 'utf-8').includes('eventStore')),
  ctxFiles.filter((f) => fs.readFileSync(f, 'utf-8').includes('eventStore')).join(','));
check('G2 审计条目能被事件库检索到（kind=system 不是孤岛）',
  eventStore.search({ kind: 'system' }).some((e) => e.tags.includes('audit')));
check('G3 按 tag 能圈出某一类（查账的入口靠它）',
  eventStore.search({ tag: 'workspace' }).some((e) => e.tags.includes('audit')));

/* ═══ ⑧ 源码守护 ═══ */
console.log('\n── ⑧ 源码守护：落点唯一 ──');
const readSrc = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const mainSrc = readSrc('src/harness/main.ts');
const rtSrc = readSrc('src/runtime/runtime.ts');
const wsSrc = readSrc('src/commands/builtin/workspace.ts');
const auditSrc = readSrc('src/permission/audit.ts');

check('H1 main.ts 不自己拼条目，只调统一落点',
  !mainSrc.includes('recordAudit(') && mainSrc.includes('recordGateDeny('));
check('H2 runtime.ts 走统一落点',
  !rtSrc.includes('recordAudit(') && rtSrc.includes('recordPermissionChoice('));
check('H3 命令层走统一落点',
  !wsSrc.includes('recordAudit(') && wsSrc.includes('recordGrant(') && wsSrc.includes('recordRevoke('));
const gateTags = [...mainSrc.matchAll(/deny\('[^']+', '([^']+)',/g)].map((mm) => mm[1]!);
check('H4 四道闸各有一个 tag 且互不相同（不许两道闸共用一个来源名）',
  gateTags.length === 4 && new Set(gateTags).size === 4, gateTags.join(','));
const srcFiles = walk(path.join(ROOT, 'src')).filter((f) => f.endsWith('.ts'));
check('H5 全仓只有 audit.ts 调 eventStore.recordAudit（落点唯一）',
  srcFiles.every((f) => path.resolve(f) === path.resolve(ROOT, 'src/permission/audit.ts')
    || !fs.readFileSync(f, 'utf-8').includes('.recordAudit(')));
check('H6 audit.ts 只往叙事库写，不碰 tool_call 流水（两本账各归各）', !auditSrc.includes('CALLS_FILE'));
check('H7 审计条目**不带 turnId**（钩子载荷里没有它；要复盘按时间窗回流水翻）',
  !auditSrc.includes('turnId'));
check('H8 三条落点都在 audit.ts 里且各只导出一处实现',
  (auditSrc.match(/export function recordGateDeny/g) ?? []).length === 1
  && (auditSrc.match(/export function recordGrant/g) ?? []).length === 1
  && (auditSrc.match(/export function recordRevoke/g) ?? []).length === 1
  && (auditSrc.match(/export function recordPermissionChoice/g) ?? []).length === 1);

/* ═══ 收尾对照：一次真实拦截只留一条账 ═══ */
console.log('\n── ⑨ 端到端：一次被拦的调用只留一条账，且查得到 ──');
const beforeAll = eventStore.count();
coreBeforeToolCall({ name: 'write', args: { path: OUTSIDE } }, false);
const afterAll = auditsSince(beforeAll);
check('I1 真链跑一次 → 恰好多一条审计', afterAll.length === 1, String(afterAll.length));
check('I2 它会出现在 /events 与检索里（拉通道拿得到）',
  eventStore.search({ keyword: '工作区外写' }).some((e) => e.tags.includes('audit')));

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
if (failed > 0) process.exit(1);
