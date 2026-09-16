/**
 * verify-projects.ts —— `/projects` 列表与切换（ROADMAP 10.11.1）
 *
 * 为什么需要它：这条功能"看着全是展示"，其实是本仓**代价最大**的一个用户动作 ——
 * 它换掉 cwd，而全项目的项目级路径都是**相对**的（`.flint/*`、`TASK.md`、`sessions/`、
 * bash/git 的 `process.cwd()`），于是 chdir 之后一堆东西会**自动**指向新项目。
 * 自动自愈的那一半是免费的，"跟着一起指过去"的那一半才是危险的：
 * 上一个项目的**内存状态**（清单 / 记忆 / 事件索引 / 契约锁 / 会话对象）如果没跟着换，
 * 症状全都是**看着一切正常**——
 *   · 清单还是 A 的 → 模型在 B 里干 A 的活；
 *   · 会话对象还持有相对路径 → **A 的对话被续写进 B 的会话文件**（一次静默的跨项目污染）；
 *   · 契约锁还开着 → 一次解锁被搬到另一个项目上，B 的目标文档白送。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 参数解析 —— 逐形状（空 / `--switch 名` / `--switch=名` / 带空格的路径 / `--help` / 未知参数）
 *   ② nameFromPath —— 正反斜杠 / 尾斜杠 / 裸名 / 根
 *   ③ 排序 —— 最近活动倒序 / null 退到首次登记 / 并列用名字与路径兜底 / 不改入参
 *   ④ 选项目 —— 精确 / 忽略大小写 / **重名不猜** / 未知名 / 空
 *   ⑤ 时间格式化 —— null / NaN / 固定时刻（本地时区，不依赖 TZ）
 *   ⑥ 列表渲染 —— 空表 / 当前标记**只**在当前行 / 目录不存在要显式标 / 长名截断 / 用法行
 *   ⑦ 切换回执 —— 目标 / 会话 / 四个计数 / 上一项目名 / 两条边界（授权类配置 + 顶栏快照）
 *   ⑧ 真切换端到端 —— 临时项目目录 + **真** Runtime + **真** JsonlSessionRepo：
 *      换上下文（三个 store）、换会话（**并且 A 的会话文件一字未动**）、契约锁回锁、
 *      授权类配置被清空、幂等、未知名、目录不存在、目录是个文件、会话那步失败时**回滚 cwd**
 *   ⑨ 源码守护 —— projects.ts 零 import；命令层不碰 io/ 与授权类配置文件；
 *      `seedProjectContext` 的**唯一实现 + 调用点只有启动与切换**（模型路径碰不到）；
 *      "先清后栽"（reset 与 loadFromFile 成对）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-projects.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 * 退出码：failed > 0 → 1
 *
 * 环境依赖：⑧ 会真的 chdir 到 os.tmpdir() 下的临时项目里（结束时还原），
 *          并把注册表用 `FLINT_PROJECTS_FILE` 重定向到临时文件 —— **绝不碰用户真实的
 *          `~/.flint/projects.jsonl`**（那条开关的理由见 registry.ts 的 projectsFilePath）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../src/runtime/runtime.js';
import { CommandServiceImpl } from '../src/commands/system.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { JsonlSessionRepo } from '../src/session/jsonl-repo.js';
import { JsonlSessionStorage } from '../src/session/jsonl-storage.js';
import { taskStore } from '../src/todo/store.js';
import { memoryStore } from '../src/memory/store.js';
import { eventStore } from '../src/eventlog/store.js';
import { charterLock } from '../src/project/charter.js';
import { commandRegistry } from '../src/project/commands.js';
import { normalizeProjectPath } from '../src/eventlog/registry.js';
import { postcheckBaseline, postcheckRegistry } from '../src/project/postcheck.js';
import { seedProjectContext } from '../src/harness/project-context.js';
import { activate } from '../src/commands/builtin/projects.js';
import {
  PROJECTS_USAGE, formatActivity, nameFromPath, parseProjectsArgs, pickProject,
  renderProjectList, renderSwitchReceipt, sortProjectRows, type ProjectRow,
} from '../src/project/projects.js';

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

/* ════════════════════════════════════════════════════════════════════
   ① 参数解析
   ════════════════════════════════════════════════════════════════════ */

console.log('── ① 参数解析（认不出的必须报用法，不许静默当成"只列个表"）──');

check('A1 空参数 → list（只列不改）', parseProjectsArgs('').action === 'list');
check('A2 纯空白 → list', parseProjectsArgs('   \t ').action === 'list');

{
  const r = parseProjectsArgs('--switch beta');
  check('A3 `--switch 名` → switch + 目标', r.action === 'switch' && r.query === 'beta');
}
{
  const r = parseProjectsArgs('--switch=beta');
  check('A4 `--switch=名` → switch + 目标', r.action === 'switch' && r.query === 'beta');
}
{
  const r = parseProjectsArgs('--switch C:/Users/me/my project');
  check('A5 目标带空格 → 原样接回去（路径真的会有空格）',
    r.action === 'switch' && r.query === 'C:/Users/me/my project');
}
{
  const r = parseProjectsArgs('switch beta');
  check('A6 不带横线的 `switch 名` 也认（少打两个减号不该变成"没带参数"）',
    r.action === 'switch' && r.query === 'beta');
}
check('A7 `--switch` 缺目标 → error', parseProjectsArgs('--switch').action === 'error');
check('A8 `--switch=` 空值 → error', parseProjectsArgs('--switch=').action === 'error');
check('A9 `--help` → help（不是 error）', parseProjectsArgs('--help').action === 'help');
check('A10 `-h` → help', parseProjectsArgs('-h').action === 'help');
{
  const r = parseProjectsArgs('--swtich beta'); // 拼错
  check('A11 拼错的参数 → error（**不许**当成"没带参数"于是只列个表，那会让人以为已经切了）',
    r.action === 'error' && r.message.includes('--swtich'));
}
{
  const r = parseProjectsArgs('beta');
  check('A12 裸名字（既不是 switch 也不是 help）→ error + 带用法',
    r.action === 'error' && r.message.includes(PROJECTS_USAGE));
}

/* ════════════════════════════════════════════════════════════════════
   ② nameFromPath
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ② nameFromPath（纯字符串，不 import path）──');

check('B1 正斜杠路径 → 末段', nameFromPath('C:/a/b/proj') === 'proj');
check('B2 反斜杠路径 → 末段', nameFromPath('C:\\a\\b\\proj') === 'proj');
check('B3 带尾分隔符 → 末段（不返回空串）', nameFromPath('/a/b/proj/') === 'proj');
check('B4 裸名字 → 原样', nameFromPath('proj') === 'proj');

/* ════════════════════════════════════════════════════════════════════
   ③ 排序
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ③ 排序（最近活动倒序 + 并列有确定兜底）──');

const row = (name: string, extra: Partial<ProjectRow> = {}): ProjectRow => ({
  name,
  path: `/x/${name}`,
  firstSeen: '2026-01-01T00:00:00.000Z',
  lastActivityMs: null,
  current: false,
  exists: true,
  ...extra,
});

{
  const rows = [row('old', { lastActivityMs: 1000 }), row('new', { lastActivityMs: 9000 })];
  check('C1 最近活动倒序（新的在前）',
    sortProjectRows(rows).map((r) => r.name).join(',') === 'new,old');
}
{
  // "最近活动"与"首次登记"**同一把尺子**（都是 epoch 毫秒），所以两者可以混着比 ——
  // 它们的含义也确实一致："关于这个项目，我们最后知道的一件事发生在什么时候"。
  // （第一版这里喂了 lastActivityMs: 5，也就是 1970 年，于是断言写反了 —— 是测试数据不真实，不是实现错。）
  const rows = [
    row('probed', { lastActivityMs: Date.parse('2026-01-05T00:00:00.000Z') }),
    row('onlySeen', { firstSeen: '2026-09-01T00:00:00.000Z' }),
  ];
  check('C2 探测不到活动（null）退到首次登记时间，与"有活动"的项目同尺对比',
    sortProjectRows(rows).map((r) => r.name).join(',') === 'onlySeen,probed');
}
{
  const rows = [row('b', { firstSeen: '2026-02-01T00:00:00.000Z' }), row('a', { firstSeen: '2026-03-01T00:00:00.000Z' })];
  check('C3 都没有活动时按首次登记倒序', sortProjectRows(rows).map((r) => r.name).join(',') === 'a,b');
}
{
  const rows = [row('b'), row('a')];
  check('C4 完全并列 → 按名字兜底（同一份输入永远同一个顺序，列表不许乱跳）',
    sortProjectRows(rows).map((r) => r.name).join(',') === 'a,b');
}
{
  const rows = [row('old', { lastActivityMs: 1 }), row('new', { lastActivityMs: 9 })];
  const snapshot = rows.map((r) => r.name).join(',');
  sortProjectRows(rows);
  check('C5 不改入参（返回新数组 —— 列表渲染不该有副作用）',
    rows.map((r) => r.name).join(',') === snapshot);
}

/* ════════════════════════════════════════════════════════════════════
   ④ 选项目
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ④ 选项目（重名不猜 —— 选错 = 把 cwd 切到别的项目）──');

check('D1 精确命中', (() => {
  const r = pickProject([row('a'), row('b')], 'b');
  return r.ok && r.row.name === 'b';
})());
check('D2 忽略大小写命中', (() => {
  const r = pickProject([row('Proj')], 'proj');
  return r.ok && r.row.name === 'Proj';
})());
{
  const r = pickProject([row('a'), row('a', { path: '/y/a' })], 'a');
  check('D3 重名 → ambiguous（**不猜**，把两条路径都摆出来让人点名）',
    !r.ok && r.reason === 'ambiguous' && r.matches.length === 2);
}
{
  const r = pickProject([row('a')], 'zzz');
  check('D4 未知名 → missing', !r.ok && r.reason === 'missing');
}
{
  const r = pickProject([row('a')], '   ');
  check('D5 空白查询 → missing（不许命中"名字为空"的行）', !r.ok);
}
{
  const r = pickProject([row('a'), row('a', { path: '/y/a' })], 'A');
  check('D6 忽略大小写命中多个 → 仍然 ambiguous', !r.ok && r.reason === 'ambiguous');
}

/* ════════════════════════════════════════════════════════════════════
   ⑤ 时间格式化
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑤ 时间格式化（拿不到就是 —，**绝不许**渲染成 1970）──');

check('E1 null → —', formatActivity(null) === '—');
check('E2 NaN → —', formatActivity(Number.NaN) === '—');
check('E3 固定时刻 → 本地 YYYY-MM-DD HH:mm', formatActivity(new Date(2026, 8, 15, 20, 30).getTime()) === '2026-09-15 20:30');
check('E4 月/日补零', formatActivity(new Date(2026, 0, 3, 4, 5).getTime()) === '2026-01-03 04:05');

/* ════════════════════════════════════════════════════════════════════
   ⑥ 列表渲染
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑥ 列表渲染 ──');

{
  const out = renderProjectList([]);
  check('F1 空表 → 说清"还没有"+ 怎么才会有（不是空白一片）',
    out.includes('还没有登记过任何项目') && out.includes('projects.jsonl'));
}
{
  const rows = [row('alpha', { current: true }), row('beta')];
  const out = renderProjectList(rows);
  const lines = out.split('\n').filter((l) => l.includes('/x/'));
  const alphaLine = lines.find((l) => l.includes('/x/alpha'))!;
  const betaLine = lines.find((l) => l.includes('/x/beta'))!;
  check('F2 当前项目带 ●，非当前不带', alphaLine.includes('●') && !betaLine.includes('●'));
}
{
  const rows = [row('alpha', { current: true }), row('beta')];
  const out = renderProjectList(rows);
  check('F3 表头点名当前项目', out.includes('当前：alpha'));
}
{
  const out = renderProjectList([row('gone', { exists: false })]);
  check('F4 目录不存在 → 显式标出来（**不许静默省略**：省略会让人以为它不在列表里）',
    out.includes('目录已不存在'));
}
{
  const out = renderProjectList([row('ok')]);
  check('F5 目录在 → 不出现"不存在"的标记', !out.includes('目录已不存在'));
}
{
  const long = 'x'.repeat(40);
  const out = renderProjectList([row(long, { path: '/x/short' })]);
  check('F6 超长名字截断且带 …（防一行被一个长目录名撑爆，也让人知道被截了）',
    out.includes('…') && !out.includes(long));
}
check('F7 渲染里带切换用法（不然用户不知道下一步怎么走）',
  renderProjectList([row('a')]).includes('/projects --switch'));

/* ════════════════════════════════════════════════════════════════════
   ⑦ 切换回执
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑦ 切换回执（边界不写在这儿，就等于没说）──');

const receipt = renderSwitchReceipt({
  from: 'C:/w/flint',
  row: row('beta', { path: 'C:/w/beta' }),
  sessionNote: 'default.jsonl（3 条消息 · 该项目原有的主会话）',
  context: { task: 2, memory: 5, events: 18, calls: 40 },
});

check('G1 点名目标项目与路径', receipt.includes('beta') && receipt.includes('C:/w/beta'));
check('G2 会话那步的结果原样带出', receipt.includes('default.jsonl（3 条消息'));
check('G3 四个计数都在', receipt.includes('任务 2') && receipt.includes('记忆 5')
  && receipt.includes('事件 18') && receipt.includes('工具流水 40'));
check('G4 说明上一个项目的档案未受影响（不然会怀疑"切走是不是把我的记忆搬走了"）',
  receipt.includes('flint') && receipt.includes('未受影响'));
check('G5 边界①：授权类配置本次不生效、需重启',
  receipt.includes('需重启 flint') && receipt.includes('项目命令') && receipt.includes('自检'));
check('G6 边界②：顶栏哪些像素是启动快照', receipt.includes('顶栏') && receipt.includes('快照'));

/* ════════════════════════════════════════════════════════════════════
   ⑧ 真切换端到端
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑧ 真切换端到端（真 Runtime + 真 repo + 真目录）──');

/** 最小 Runtime：只关心会话那半边是真的（会话仓库注入真 JsonlSessionRepo）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(session: any, sessionRepo: any, commandSystem: CommandServiceImpl): Runtime {
  return new Runtime({
    llm: { chat: async () => ({ content: '' }), stream: () => { throw new Error('本脚本不触发 LLM'); } },
    session,
    sessionRepo,
    tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: '' }), register: () => {} },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {} },
    skills: { load: () => {}, getAll: () => [], get: () => undefined },
    events: new PromptEventEmitter(),
    spanCollector: { collect: () => [], running: () => [] },
    commandSystem,
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction: { maybeCompact: async (m: unknown[]) => ({ compacted: false, messages: m }) },
    systemPromptService: { build: async () => ({ messages: [] }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const cwd0 = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-projects-'));
process.env.FLINT_PROJECTS_FILE = path.join(tmpRoot, 'projects.jsonl');

const alpha = path.join(tmpRoot, 'alpha');
const beta = path.join(tmpRoot, 'beta');
const ghost = path.join(tmpRoot, 'ghost');
const asFile = path.join(tmpRoot, 'as-file');
const dupA = path.join(tmpRoot, 'x', 'dup');
const dupB = path.join(tmpRoot, 'y', 'dup');
const fresh = path.join(tmpRoot, 'fresh');
const broken = path.join(tmpRoot, 'broken');
/** 什么都没有的项目（连 TASK.md / .flint/ 都没有）—— "先清后栽"只有在这里才看得出来 */
const bare = path.join(tmpRoot, 'bare');

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}
const eventLine = (id: string, title: string, kind = 'decision'): string =>
  `${JSON.stringify({ id, time: '2026-09-01T10:00:00.000Z', kind, title, tags: [] })}\n`;
const fwd = (p: string): string => p.replace(/\\/g, '/');

/**
 * 注册表**一次性写好**再开测。它自己的口径是"启动/首用时全量载入内存，运行期不回读"
 * （registry.ts 头注），所以**载入之后再往文件里追加行是看不见的** ——
 * 测试必须尊重这条，否则测的是另一个系统（第一版就踩了这个：注册表里只有 alpha，
 * 后面所有按名字的切换全走了"未知名"分支，看着像功能坏了，其实是测试没搭对台子）。
 */
write(process.env.FLINT_PROJECTS_FILE, [
  { path: fwd(alpha), name: 'alpha' },
  { path: fwd(beta), name: 'beta' },
  { path: fwd(ghost), name: 'ghost' },
  { path: fwd(asFile), name: 'as-file' },
  { path: fwd(dupA), name: 'dup' },
  { path: fwd(dupB), name: 'dup' },
  { path: fwd(bare), name: 'bare' },
].map((r) => JSON.stringify({ ...r, firstSeen: '2026-01-01T00:00:00.000Z' })).join('\n') + '\n');

/** 造一个项目：清单 / 记忆 / 事件 / 流水 / 目标文档 五样都写，好断言"整套都换了" */
function makeProject(dir: string, tag: string): void {
  write(path.join(dir, 'TASK.md'), `- [ ] ${tag}待办\n- [x] ${tag}已完成\n`);
  write(path.join(dir, '.flint/memory.md'), `# 项目记忆\n\n- ${tag}约定一\n- ${tag}约定二\n`);
  write(path.join(dir, '.flint/events.jsonl'), eventLine(`ev_${tag}_1`, `${tag}的事件`));
  write(path.join(dir, '.flint/tool-calls.jsonl'),
    eventLine(`ev_${tag}_c1`, `${tag}·工具 read 调用`, 'tool_call'));
  write(path.join(dir, '.flint/CHARTER.md'), `# ${tag} 的目标\n`);
}

try {
  makeProject(alpha, '甲');
  makeProject(beta, '乙');
  makeProject(fresh, '新');
  makeProject(broken, '坏');
  fs.mkdirSync(dupA, { recursive: true });
  fs.mkdirSync(dupB, { recursive: true });
  fs.mkdirSync(bare, { recursive: true });   // 空目录：什么都没写
  fs.writeFileSync(asFile, 'i am a file', 'utf-8');

  // 两个项目各有自己的会话（alpha 1 条 / beta 3 条）—— 条数不同才能证明切过去的是哪一份
  const alphaSession = await JsonlSessionStorage.create(path.join(alpha, 'sessions'), 'default');
  await alphaSession.appendMessage('user', '甲说的话');
  const betaSession = await JsonlSessionStorage.create(path.join(beta, 'sessions'), 'default');
  await betaSession.appendMessage('user', '乙第一句');
  await betaSession.appendMessage('assistant', '乙第二句');
  await betaSession.appendMessage('user', '乙第三句');

  // 先站到 alpha 里，走一遍"启动那几步"（与 main.ts 同一条实现）
  process.chdir(alpha);
  const seeded = seedProjectContext();
  check('H1 播种：清单/记忆/事件/流水四样都按当前项目装载',
    seeded.task === 1 && seeded.memory === 2 && seeded.events === 1 && seeded.calls === 1,
    JSON.stringify(seeded));

  // 真 Runtime：会话对象就是 alpha 的那份
  const commandSystem = new CommandServiceImpl();
  const runtime = makeRuntime(
    await JsonlSessionStorage.open(path.join(alpha, 'sessions/default.jsonl')),
    new JsonlSessionRepo('./sessions'),
    commandSystem,
  );
  activate(runtime);

  const listOut = await commandSystem.execute('/projects');
  check('H2 `/projects` 能跑通并列出当前项目（● + 用法行）',
    typeof listOut === 'string' && listOut.includes('●') && listOut.includes('--switch'),
    String(listOut).slice(0, 120));

  const alphaSessionFile = path.join(alpha, 'sessions/default.jsonl');
  const alphaBefore = fs.readFileSync(alphaSessionFile, 'utf-8');
  const alphaMtime = fs.statSync(alphaSessionFile).mtimeMs;

  // 契约锁先解开 —— 它**不许**跨项目继承
  charterLock.unlock();
  // 授权类配置先塞上 —— 切换后必须被**清空**（而不是重读）
  commandRegistry.set([{ name: 'verify', run: 'npm run verify', script: 'node x.mjs', kind: 'verify' }]);
  postcheckRegistry.set({ commands: [{ command: 'npm run verify', timeoutMs: 1000 }] });
  postcheckBaseline.set(['src/x.ts|TS1|假的基线']);

  const switched = await commandSystem.execute('/projects --switch beta');
  check('H3 切换成功并回执', typeof switched === 'string' && switched.includes('已切换到项目「beta」'),
    String(switched).slice(0, 160));
  check('H4 cwd 真的换了', fs.realpathSync(process.cwd()) === fs.realpathSync(beta));

  check('H5 清单换成了新项目的（**这是最要命的一条**：不换 = 模型在 B 里干 A 的活）',
    taskStore.list().length === 2 && taskStore.list()[0]!.text === '乙待办',
    JSON.stringify(taskStore.list()));
  check('H6 记忆换成了新项目的',
    memoryStore.list().join('|') === '乙约定一|乙约定二', memoryStore.list().join('|'));
  check('H7 事件索引换成了新项目的（跨项目检索不会把别人的来龙去脉当成自己的）',
    eventStore.count() === 1 && eventStore.all()[0]!.title === '乙的事件');
  check('H8 工具流水也换了（索引里是新项目那些调用）',
    eventStore.countCalls() === 1 && eventStore.allCalls()[0]!.title.includes('乙'));

  check('H9 会话切到新项目的主会话（3 条 = beta 的，不是 1 条 = alpha 的）',
    (await runtime.getSessionMsgCount()) === 3);
  check('H10 会话文件确实落在新项目里',
    fs.realpathSync(path.resolve(runtime.getCurrentSessionFile()!)).startsWith(fs.realpathSync(beta)));

  check('H11 **alpha 的会话文件一字未动**（否则就是一次静默的跨项目污染）',
    fs.readFileSync(alphaSessionFile, 'utf-8') === alphaBefore
    && fs.statSync(alphaSessionFile).mtimeMs === alphaMtime);

  check('H12 契约锁不跨项目继承（A 的解锁不许让 B 的目标文档白送）', !charterLock.isUnlocked());

  check('H13 授权类配置被**清空**（不是重读）：命令表 / 登记表 / 基线三样都空',
    commandRegistry.get().length === 0 && postcheckRegistry.get() === null && postcheckBaseline.get() === null);

  const again = await commandSystem.execute('/projects --switch beta');
  check('H14 切到当前项目 → 幂等（明说"未做任何改动"，不重复播种）',
    typeof again === 'string' && again.includes('当前就在项目'), String(again));

  const unknown = await commandSystem.execute('/projects --switch 不存在的项目');
  check('H15 未知名 → 报错并指出先看列表',
    typeof unknown === 'string' && unknown.includes('没有叫') && unknown.includes('/projects'),
    String(unknown));

  // 切回 alpha：会话必须回到 alpha 那一份（证明是"打开项目自己的主会话"，不是新建）
  const back = await commandSystem.execute('/projects --switch alpha');
  check('H16 切回 alpha → 回到它自己的主会话（1 条）',
    typeof back === 'string' && back.includes('已切换到项目「alpha」')
    && (await runtime.getSessionMsgCount()) === 1, String(back).slice(0, 160));

  /* ── 边缘：注册表里的名字成了"僵尸 / 文件" ── */
  const gone = await commandSystem.execute('/projects --switch ghost');
  check('H17 目录已不存在 → 拒绝，并说清"注册表只是记账"',
    typeof gone === 'string' && gone.includes('目录已经不存在'), String(gone));

  const fileCase = await commandSystem.execute('/projects --switch as-file');
  check('H18 目标是个文件 → chdir 失败被接住（不抛到 REPL 之外）',
    typeof fileCase === 'string' && fileCase.includes('切换失败'), String(fileCase));

  /* ── 会话那步失败 → 必须**回滚 cwd**（半路状态会把 A 的对话写进 B）── */
  fs.writeFileSync(path.join(broken, 'sessions'), 'i am a file, not a dir', 'utf-8');
  const beforeRollback = process.cwd();
  const rollback = await commandSystem.execute(`/projects --switch ${broken}`);
  check('H19 会话打不开 → 回滚 cwd（**不许**留在半路状态）',
    typeof rollback === 'string' && rollback.includes('已回滚')
    && fs.realpathSync(process.cwd()) === fs.realpathSync(beforeRollback), String(rollback).slice(0, 160));
  check('H20 回滚后上下文也没被换掉（seedProjectContext 排在会话那步之后）',
    eventStore.count() === 1 && eventStore.all()[0]!.title === '甲的事件');

  /* ── 路径写法：未登记的目录也能切过去，并顺手登记 ── */
  const byPath = await commandSystem.execute(`/projects --switch ${fresh}`);
  check('H21 路径写法可切**未登记**的项目（项目身份就是 cwd），并顺手登记进电话簿',
    typeof byPath === 'string' && byPath.includes('已切换到项目「fresh」')
    && fs.readFileSync(process.env.FLINT_PROJECTS_FILE!, 'utf-8').includes('fresh'),
    String(byPath).slice(0, 160));

  /* ── 重名不猜 ── */
  const dupOut = await commandSystem.execute('/projects --switch dup');
  check('H22 重名 → 拒绝并列出两条路径（选错 = 把 cwd 切到另一个项目，不许猜）',
    typeof dupOut === 'string' && dupOut.includes('同名项目')
    && dupOut.includes(normalizeProjectPath(dupA)) && dupOut.includes(normalizeProjectPath(dupB)),
    String(dupOut).slice(0, 200));

  /**
   * **"先清后栽"只有在这里才看得出来。**
   * 上一轮的 alpha ↔ beta 两个项目**都有** TASK.md / memory.md / events.jsonl，
   * 而 `loadFromFile` 对"文件存在"是**替换**语义 —— 于是漏掉 reset() 照样全绿
   * （这正是"变异全绿 = 那条分支没被覆盖"的典型形态）。
   * 换到一个**什么都没有**的项目，reset() 才成为唯一把上一个项目擦掉的动作：
   * 漏了它，模型会带着 A 的清单/A 的记忆/A 的事件在空项目里干活。
   */
  const bareOut = await commandSystem.execute('/projects --switch bare');
  check('H23 切到空项目 → 清单/记忆/事件三样都是空的（**先清后栽**，不许留着上一个项目的）',
    taskStore.isEmpty() && memoryStore.count() === 0 && eventStore.count() === 0
    && eventStore.countCalls() === 0,
    `task=${taskStore.list().length} memory=${memoryStore.count()} events=${eventStore.count()}`);
  check('H24 空项目此前没有会话 → 走"新建"分支（回执把这步说清楚）',
    typeof bareOut === 'string' && bareOut.includes('已切换到项目「bare」')
    && bareOut.includes('新建') && bareOut.includes('任务 0'), String(bareOut).slice(0, 160));
} finally {
  process.chdir(cwd0);
  delete process.env.FLINT_PROJECTS_FILE;
  taskStore.reset();
  memoryStore.reset();
  eventStore.reset();
  charterLock.lock();
  commandRegistry.clear();
  postcheckRegistry.set(null);
  postcheckBaseline.set(null);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清理失败不掩盖结论 */ }
}

/* ════════════════════════════════════════════════════════════════════
   ⑨ 源码守护
   ════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑨ 源码守护 ──');

const projectsSrc = fs.readFileSync(path.join(ROOT, 'src/project/projects.ts'), 'utf-8');
const cmdSrc = fs.readFileSync(path.join(ROOT, 'src/commands/builtin/projects.ts'), 'utf-8');
const seedSrc = fs.readFileSync(path.join(ROOT, 'src/harness/project-context.ts'), 'utf-8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf-8');

check('I1 表示层零 import（不认识 fs / 注册表 / runtime，于是它能在不起进程的前提下逐字校验）',
  !/^import\s/m.test(projectsSrc));
check('I2 命令层不碰 io/（RPC 启动路径不许被拖进会写 stdout 的 UI 层）',
  !cmdSrc.includes("from '../../io/"));
check('I3 切换**不做交互选择**（非 TTY 下选择器会自动返回第一项 = 默认切到某个项目）',
  !stripComments(cmdSrc).includes('runtime.select'));
check('I4 命令层**不读**授权类配置文件（多一个运行期读取点就把"不许回读"退成"谁触发的可以回读"）',
  !stripComments(cmdSrc).includes('readFileSync') && !stripComments(cmdSrc).includes('package.json')
  && !stripComments(cmdSrc).includes('postcheck.json'));
check('I5 切换时显式清空授权类配置（不清 = 注入了 A 的命令却在 B 里跑）',
  cmdSrc.includes('commandRegistry.clear()') && cmdSrc.includes('postcheckRegistry.set(null)')
  && cmdSrc.includes('postcheckBaseline.set(null)'));
{
  const body = stripComments(seedSrc);
  check('I6 播种是"先清后栽"：三个 store 各 reset 一次、loadFromFile 紧随其后',
    (body.match(/\.reset\(\)/g) ?? []).length === 3
    && body.includes("taskStore.loadFromFile(TASK_FILE)")
    && body.includes('memoryStore.loadFromFile(MEMORY_FILE)')
    && body.includes('eventStore.loadFromFile(EVENTS_FILE)')
    && body.includes('eventStore.loadCallsFile(CALLS_FILE)'));
}
check('I7 契约锁在播种时复位（不跨项目继承）', stripComments(seedSrc).includes('charterLock.lock()'));

{
  // "只在启动读一次"的**新表述**：读取点在 project-context 那边是唯一的，
  // 而播种的**调用点**只有两处 —— 启动与用户显式切换。
  // 真正要钉的性质是：**模型的路径碰不到它**（tools / loop 里零引用）。
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8');
  const loopSrc = fs.readFileSync(path.join(ROOT, 'src/loop/agent-loop.ts'), 'utf-8');
  check('I8 main.ts 启动时调用播种（启动与切换共用同一份实现）',
    stripComments(mainSrc).includes('seedProjectContext()'));
  check('I9 模型的路径碰不到播种：tools/ 与 loop/ 零引用',
    !toolsSrc.includes('seedProjectContext') && !loopSrc.includes('seedProjectContext'));
  check('I10 命令层不 import tools/（切换是用户动作，不是工具 —— 模型无从调用）',
    !cmdSrc.includes("from '../../tools/"));
}

check('I11 事件库补了 reset()（不补就没法"先清后栽"，跨项目检索会捞到别人的事件）',
  /reset\(\): void \{[\s\S]*?this\.entries = \[\];[\s\S]*?this\.calls = \[\];/.test(
    fs.readFileSync(path.join(ROOT, 'src/eventlog/store.ts'), 'utf-8')));
check('I12 注册表落点可用 FLINT_PROJECTS_FILE 重定向（否则每跑一次套件就往用户真实注册表里塞临时目录）',
  fs.readFileSync(path.join(ROOT, 'src/eventlog/registry.ts'), 'utf-8').includes('FLINT_PROJECTS_FILE'));

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
