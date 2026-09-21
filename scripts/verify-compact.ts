/**
 * 手动压缩与留档验证套件（ROADMAP 10.8.4，2026-09-21）。
 *
 * 背景：压缩 = 用一段 LLM 摘要替换掉 N 条原始消息，**有损且不可逆**（摘要没有可回滚的基线）。
 * 此前只有**自动**压缩（历史超 20 条触发）：用户既不能主动压，压掉的内容也无处可查。
 * 本条补两样：① `/compact` 手动压缩；② 压缩**前**把原文整份留档到 `.flint/snapshots/`。
 *
 * 验证六段：
 *   ① 参数解析 —— 只认 `keep=N` / 裸数字；认不出就**报错给用法**（不猜）
 *   ② 文件名与路径 —— 会话名进文件名（对得上哪次会话）、非法字符换掉、超长截断
 *   ③ 渲染 —— 留档正文**不截断**（截了等于没留；超限才截且**标出来**）、回执两态都说清
 *   ④ 钩子与中止 —— 拿到的必须是**完整原文**、钩子说不成就**不调 LLM 且一字不裁**、
 *      **自动压缩刻意不留档**
 *   ⑤ 真接线 —— 真 Runtime + 真存储 + 真命令层：留档真落盘、失败即拒压、用量入账、事件库补记
 *   ⑥ 源码守护 —— 判据零 import、落盘只一处、自动压缩那条路不挂钩子、缺省保留条数单一来源
 *
 * ⚠ 本套会真写 `.flint/snapshots/` 与真写账本（`recordCompaction`）→ 代码体第一件事
 * 就是 `enterSandbox()`（见 `scripts/lib/sandbox.ts`）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterSandbox } from './lib/sandbox.js';
import { JsonlSessionStorage } from '../src/session/jsonl-storage.js';
import { CompactionServiceImpl, DEFAULT_KEEP_RECENT } from '../src/context/compaction.js';
import {
  SNAPSHOT_DIR, parseCompactArgs, renderCompactReceipt, renderSnapshot,
  safeSessionPart, snapshotFileName, snapshotRelPath,
} from '../src/context/compact-snapshot.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { CommandServiceImpl } from '../src/commands/system.js';
import { activate } from '../src/commands/builtin/compact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 自保（不计项数）：本套真写 `.flint/snapshots/` 与账本 ── */
const sandbox = enterSandbox('flint-compact-');

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
const snapshotSrc = srcOf('src/context/compact-snapshot.ts');
const compactionSrc = srcOf('src/context/compaction.ts');

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 参数解析：认不出就报错，不做"尽力猜"
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('── ① 参数解析 ──');
check('A1 空参数 → 用缺省（keep=null）', parseCompactArgs('').ok && parseCompactArgs('').keep === null);
check('A2 裸数字 → keep=5', parseCompactArgs('5').ok && parseCompactArgs('5').keep === 5);
check('A3 keep=N → keep=5', parseCompactArgs('keep=5').ok && parseCompactArgs('keep=5').keep === 5);
check('A4 前后空白不影响（trim）', parseCompactArgs('  7  ').ok && parseCompactArgs('  7  ').keep === 7);
check('A5 keep=0 合法（全压成摘要）', parseCompactArgs('keep=0').ok && parseCompactArgs('keep=0').keep === 0);
const badArgs = ['abc', '-1', 'keep=', '5x', 'keep=5=6', 'keep=1.5', 'N=5'];
check('A6 认不出的七种写法一律报错（不猜、不静默当成缺省）',
  badArgs.every((a) => !parseCompactArgs(a).ok),
  badArgs.filter((a) => parseCompactArgs(a).ok).join(','));
check('A7 报错里带着用户写进去的那串（他知道是哪个没认出来）',
  !parseCompactArgs('abc').ok && parseCompactArgs('abc').error.includes('abc'),
  String(parseCompactArgs('abc').error));
check('A8 报错里给得出用法（不只是"错"）',
  !parseCompactArgs('abc').ok && /keep=N/.test(String(parseCompactArgs('abc').error)));

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 文件名与路径
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ② 文件名与路径 ──');
const at = new Date(2026, 8, 21, 18, 20, 33);
const nameEmpty = snapshotFileName(at, undefined);
check('B1 无会话时文件名 = compact-<日期>-<时间>.md',
  nameEmpty === 'compact-20260921-182033.md', nameEmpty);
const nameSess = snapshotFileName(at, 'session-abc.jsonl');
check('B2 会话名进文件名（一份留档对得上它是哪次会话压下来的）',
  nameSess === 'compact-20260921-182033-session-abc.jsonl.md', nameSess);
check('B3 会话名里的非法字符换成 -（Windows 文件名活不下来的那些）',
  safeSessionPart('a/b c*d.jsonl') === 'a-b-c-d.jsonl', safeSessionPart('a/b c*d.jsonl'));
check('B4 文件名里不含冒号 / 星号 / 斜杠（造出来就写不进去的那批）',
  !/[:*\/\\?<>|]/.test(snapshotFileName(at, 'a/b c*d?.jsonl')));
check('B5 空会话名 → 不留尾巴（不编一个名字）', safeSessionPart('') === '' && safeSessionPart(undefined) === '');
check('B6 超长会话名截到 40（防一个长名把文件名撑爆）',
  safeSessionPart('x'.repeat(200)).length === 40);
check('B7 留档路径 = .flint/snapshots/<文件名>（相对 cwd，与账本同住 .flint/）',
  snapshotRelPath('x.md') === `${SNAPSHOT_DIR}/x.md` && SNAPSHOT_DIR === '.flint/snapshots',
  snapshotRelPath('x.md'));

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 渲染：留档正文不截断；回执两态都说清
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ③ 渲染 ──');
const dropMsgs = [
  { role: 'user', content: '第一条原文' },
  { role: 'assistant', content: '第二条原文，比喂给 LLM 那份长得多'.repeat(20) },
];
const snapText = renderSnapshot({ at, session: 's.jsonl', keep: 10 }, dropMsgs);
check('C1 留档正文带元信息（时间 / 会话 / 保留条数 / 被压条数）',
  snapText.includes('2026-09-21 18:20:33') && snapText.includes('s.jsonl')
  && snapText.includes('保留最近 10 条') && snapText.includes('以下 2 条'));
check('C2 留档是**完整原文**（喂 LLM 那份才截 200 字，留档截了等于没留）',
  snapText.includes('第一条原文') && snapText.includes('第二条原文，比喂给 LLM 那份长得多'.repeat(20)));
check('C3 会话名拿不到时写「（未标注）」，不编一个',
  renderSnapshot({ at, keep: 10 }, dropMsgs).includes('（未标注）'));
const huge = renderSnapshot({ at, keep: 1 }, [{ role: 'user', content: 'y'.repeat(80 * 1024) }]);
check('C4 单条超限时**截断且标出来**（静默截断 = 谎报"原文完整"）',
  huge.includes('已截断') && huge.includes('y'.repeat(64 * 1024)) && !huge.includes('y'.repeat(70 * 1024)));
const okReceipt = renderCompactReceipt({
  compressed: true, keep: 10, dropped: 12, kept: 10,
  snapshot: '.flint/snapshots/compact-1.md', summary: '这是一段摘要',
});
check('C5 成功回执四要素齐全（压了几条 / 保留几条 / 留档在哪 / 摘要是什么）',
  okReceipt.includes('✅') && okReceipt.includes('压缩掉 12 条') && okReceipt.includes('保留最近 10 条')
  && okReceipt.includes('.flint/snapshots/compact-1.md') && okReceipt.includes('这是一段摘要'),
  okReceipt);
const noReceipt = renderCompactReceipt({
  compressed: false, keep: 10, dropped: 0, kept: 8, reason: '对话只有 8 条',
});
check('C6 没压的回执**明说没压**并给原因（按下命令却什么都没变，最贵的是他以为压过了）',
  noReceipt.includes('没有压缩') && noReceipt.includes('对话只有 8 条'), noReceipt);
check('C7 没压的回执不带 ✅（不假装成功）', !noReceipt.includes('✅'));

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 钩子与中止：真 CompactionServiceImpl + 真存储
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ④ 钩子与中止 ──');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-compact-'));

/** 造一个真实存储并写入 n 条消息 */
async function makeStorage(name: string, n: number): Promise<JsonlSessionStorage> {
  const storage = await JsonlSessionStorage.create(tmpDir, name);
  for (let i = 1; i <= n; i++) await storage.appendMessage('user', `消息 ${i} 的原文内容`);
  return storage;
}

/** 探针 LLM：记录被调顺序、返回固定摘要与用量 */
function makeProbeLlm() {
  const order: string[] = [];
  return {
    order,
    chat: async () => {
      order.push('llm');
      return {
        content: '这是摘要',
        usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
      };
    },
    stream: () => { throw new Error('本段不触发流式'); },
  };
}

{
  const storage = await makeStorage('hook-ok.jsonl', 25);
  const llm = makeProbeLlm();
  const svc = new CompactionServiceImpl({ llm: llm as never });
  let got: Array<{ role: string; content: string }> = [];
  const r = await svc.compactNow(await storage.getMessages(), storage, {
    keepRecent: 10,
    beforeSummarize: async (dropped) => {
      got = dropped;
      llm.order.push('snapshot');
      return { ok: true };
    },
  });
  check('D1 钩子拿到的是**完整原文**（不是喂 LLM 那份 200 字截断）',
    got.length === 15 && got[0].content === '消息 1 的原文内容', `got=${got.length} 首条=${got[0]?.content}`);
  check('D2 留档条数 = 真正要被压掉的条数（判据只在 compactTo 里有一份）',
    got.length === 15 && r.summary === '这是摘要');
  check('D3 留档发生在**生成摘要之前**（先留后压，顺序不能反）',
    llm.order.join(',') === 'snapshot,llm', llm.order.join(','));
  check('D4 压缩后视图只剩保留窗口（摘要 + 最近 10 条）',
    r.history.length === 10);
}
{
  // D3b：「先留后压」真正值钱的地方 —— 留档**不依赖摘要成功**。
  // 要是把留档挪到摘要之后，LLM 一抛错就跳进 catch，原文一份也没留下。
  const storage = await makeStorage('hook-llm-throw.jsonl', 25);
  const llm = makeProbeLlm();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const boom = { ...llm, chat: async () => { llm.order.push('llm'); throw new Error('LLM 挂了'); } } as any;
  const svc = new CompactionServiceImpl({ llm: boom });
  let hookRan = false;
  const r = await svc.compactNow(await storage.getMessages(), storage, {
    keepRecent: 10,
    beforeSummarize: async () => { hookRan = true; return { ok: true }; },
  });
  check('D3b 摘要失败（LLM 抛错）时原文**也已经留档**（留档不依赖摘要成功）',
    hookRan === true, `hookRan=${hookRan}`);
  check('D3c 摘要失败这条兜底路径本身没被改坏（无摘要、只裁历史）',
    r.summary === undefined && r.history.length === 10, JSON.stringify(r));
}
{
  const storage = await makeStorage('hook-abort.jsonl', 25);
  const llm = makeProbeLlm();
  const svc = new CompactionServiceImpl({ llm: llm as never });
  const before = await storage.getMessages();
  const r = await svc.compactNow(before, storage, {
    keepRecent: 10,
    beforeSummarize: async () => ({ ok: false, reason: 'ENOTDIR: 目录建不出来' }),
  });
  check('D5 留档说不成 → **中止**：不要摘要（没留档就不许丢原文）',
    r.summary === undefined && r.aborted === 'ENOTDIR: 目录建不出来', JSON.stringify(r));
  check('D6 中止时 history **一字不裁**（原样退回，不是裁完再说没压成）',
    r.history.length === before.length, `${r.history.length} vs ${before.length}`);
  check('D7 中止时**压根没调 LLM**（留档没过就不该花这一次调用）',
    llm.order.length === 0, llm.order.join(','));
  check('D8 中止后存储里没有新 compaction（树没被动过）',
    storage.getCompactions().length === 0);
}
{
  // 对照：自动压缩照旧压（"不留档"的**行为证明**放在 ⑤ E12 —— 那条要真 Runtime 跑一轮才验得到）
  const storage = await makeStorage('auto.jsonl', 25);
  const llm = makeProbeLlm();
  const svc = new CompactionServiceImpl({ llm: llm as never });
  const r = await svc.maybeCompact(await storage.getMessages(), storage);
  check('D9 自动压缩超阈值照旧压（25 > 20）—— 本条不改它的行为',
    r.summary === '这是摘要' && r.history.length === 10);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 真接线：真 Runtime + 真命令层
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑤ 真接线（Runtime + /compact 命令）──');

async function makeRuntime(file: string, n: number): Promise<{ rt: Runtime; cmds: CommandServiceImpl }> {
  const llm = makeProbeLlm();
  const session = await makeStorage(file, n);
  const cmds = new CommandServiceImpl();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rt = new Runtime({
    llm: llm as never,
    session,
    tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: '' }), register: () => {} },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} },
    skills: { load: () => {}, getAll: () => [], get: () => undefined },
    events: new PromptEventEmitter(),
    spanCollector: { collect: () => [], running: () => [] },
    commandSystem: cmds,
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction: new CompactionServiceImpl({ llm: llm as never }),
    systemPromptService: { build: async () => ({ messages: [] }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  activate(rt);
  return { rt, cmds };
}

const snapDirAbs = path.join(process.cwd(), '.flint', 'snapshots');
const listSnaps = (): string[] => (fs.existsSync(snapDirAbs) ? fs.readdirSync(snapDirAbs) : []);

{
  const { rt, cmds } = await makeRuntime('cmd-ok.jsonl', 25);
  const out = await cmds.execute('/compact');
  check('E1 /compact 回执说压成了（真命令层：注册 → 解析 → runtime → 回执）',
    typeof out === 'string' && out.includes('✅') && out.includes('压缩掉 15 条'), String(out).slice(0, 90));
  const files = listSnaps();
  check('E2 留档**真的落盘**了（.flint/snapshots/ 下多出一份）', files.length === 1, files.join(','));
  const body = files.length === 1 ? fs.readFileSync(path.join(snapDirAbs, files[0]), 'utf-8') : '';
  check('E3 落盘的那份含**被压掉的原文**（打开就能找回，不是只留个文件名）',
    body.includes('消息 1 的原文内容') && body.includes('消息 15 的原文内容'), body.slice(0, 60));
  check('E4 回执里的留档路径指的就是真落盘的那个文件',
    typeof out === 'string' && out.includes(files[0]), String(out).slice(0, 120));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check('E5 摘要那次 LLM 用量回流 /usage（与自动压缩同口径）', (rt as any).totalUsage.totalTokens === 12,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    JSON.stringify((rt as any).totalUsage));
  const eventsFile = path.join(process.cwd(), '.flint', 'events.jsonl');
  check('E6 事件库补记一笔（旧上下文被摘要替代这个时刻留了书签）',
    fs.existsSync(eventsFile) && fs.readFileSync(eventsFile, 'utf-8').includes('这是摘要'));
}
{
  const { cmds } = await makeRuntime('cmd-keep.jsonl', 25);
  const out = await cmds.execute('/compact keep=3');
  check('E7 keep=N 生效（保留 3 条 → 压掉 22 条）',
    typeof out === 'string' && out.includes('保留最近 3 条') && out.includes('压缩掉 22 条'), String(out).slice(0, 90));
}
{
  const { cmds } = await makeRuntime('cmd-short.jsonl', 8);
  const before = listSnaps().length;
  const out = await cmds.execute('/compact');
  check('E8 条数不够 → 明说没压并给条数（不是"静默什么都没做"）',
    typeof out === 'string' && out.includes('没有压缩') && out.includes('8 条'), String(out).slice(0, 90));
  check('E9 没压就不留档（不留空文件占位）', listSnaps().length === before);
}
{
  const { cmds } = await makeRuntime('cmd-badarg.jsonl', 25);
  const before = listSnaps().length;
  const out = await cmds.execute('/compact keep=abc');
  check('E10 参数认不出 → 给用法、且不压缩、不留档',
    typeof out === 'string' && out.includes('用法') && !out.includes('✅') && listSnaps().length === before,
    String(out).slice(0, 90));
}
{
  // 留档写不进去：把 `.flint` 变成**一个普通文件**（mkdir 必失败）→ 必须拒压。
  // ⚠ 先整个删掉再建文件 —— 前面的用例已经把 `.flint/` 建成目录了，不删的话
  // 「占位」根本写不进去，这条断言会**假绿**（第一次跑就是这样）。
  const blocker = path.join(process.cwd(), '.flint');
  fs.rmSync(blocker, { recursive: true, force: true });
  fs.writeFileSync(blocker, '占位：故意让 .flint 不是目录');
  const { cmds } = await makeRuntime('cmd-nodir.jsonl', 25);
  const out = await cmds.execute('/compact');
  check('E11 留档写不进去 → **拒绝压缩**并报出原因（说好留底却没留是最坏的丢）',
    typeof out === 'string' && out.includes('没有压缩') && out.includes('留档没写成'), String(out).slice(0, 120));
  fs.rmSync(blocker, { force: true });
}
{
  // 真 Runtime 真跑一轮：主轮**自动**压缩（21 > 20）→ 一份留档都不许多
  const llm = {
    chat: async () => ({ content: '这是摘要', usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } }),
    stream: () => (async function* () {
      yield { type: 'token', text: 'done' };
      yield { type: 'end', fullText: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })(),
  };
  const session = await makeStorage('auto-nosnap.jsonl', 21);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rt = new Runtime({
    llm: llm as never,
    session,
    tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: '' }), register: () => {} },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} },
    skills: { load: () => {}, getAll: () => [], get: () => undefined },
    events: new PromptEventEmitter(),
    spanCollector: { collect: () => [], running: () => [] },
    commandSystem: new CommandServiceImpl(),
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction: new CompactionServiceImpl({ llm: llm as never }),
    systemPromptService: { build: async () => ({ messages: [{ role: 'system', content: 'sys' }] }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const before = listSnaps().length;
  await rt.prompt('继续');
  check('E12 **自动**压缩刻意不留档（真跑一轮主轮：留档数纹丝不动）',
    listSnaps().length === before, `${before} → ${listSnaps().length}`);
  check('E12b 但自动压缩确实发生了（否则上一条是空转全绿）',
    session.getCompactions().length === 1, String(session.getCompactions().length));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑥ 源码守护
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑥ 源码守护 ──');
const fileSrc = srcOf('src/context/compact-snapshot-file.ts');
const runtimeSrc = srcOf('src/runtime/runtime.ts');
const cmdSrc = srcOf('src/commands/builtin/compact.ts');

check('F1 判据模块零 import（文件名 / 渲染 / 解析全是字符串活儿，能内存打靶）',
  !/^import\s/m.test(snapshotSrc));
check('F2 判据模块不碰 fs（落盘只许在 compact-snapshot-file.ts）',
  !/node:fs/.test(snapshotSrc) && /node:fs/.test(fileSrc));
// ⚠ 按 `async maybeCompact` → `async compactNow` 切出**方法体**再剥注释判：
// 两个方法相邻，而且 compactNow 的 JSDoc 里就写着 beforeSummarize —— 不切段、不剥注释
// 就会被邻座的散文喂饱（这条第一次跑就是这么绿的）。
const mcBody = compactionSrc
  .slice(compactionSrc.indexOf('async maybeCompact'), compactionSrc.indexOf('async compactNow'))
  .replace(/\/\*[\s\S]*?\*\//g, '');
check('F3 自动压缩那条路**不挂**钩子（不留档是刻意，不是漏接）',
  /this\.compactTo\(storage, history, DEFAULT_KEEP_RECENT\)/.test(mcBody)
  && !/beforeSummarize/.test(mcBody), mcBody.slice(0, 120));
check('F4 compactNow 把钩子往下传（手动压缩才有留档）',
  /opts\?\.beforeSummarize/.test(compactionSrc));
check('F5 钩子失败 → 不裁历史、不带摘要（中止那一支真的存在）',
  /aborted: verdict\.reason/.test(compactionSrc) && /if \(!verdict\.ok\)/.test(compactionSrc));
check('F6 缺省保留条数**只有一个来源**（runtime 与自动压缩都取 DEFAULT_KEEP_RECENT）',
  /export const DEFAULT_KEEP_RECENT/.test(compactionSrc)
  && /DEFAULT_KEEP_RECENT/.test(runtimeSrc)
  && (compactionSrc.match(/= 10;/g) ?? []).length === 1,
  String((compactionSrc.match(/= 10;/g) ?? []).length));
check('F7 留档目录常量只此一处（落盘模块 import 它，不另抄一份）',
  (snapshotSrc.match(/\.flint\/snapshots/g) ?? []).length === 1 && /SNAPSHOT_DIR/.test(fileSrc));
check('F8 命令注册名 compact，描述里写明会留档（用户按之前就看得见代价）',
  /registerCommand\(\s*'compact'/.test(cmdSrc) && /留档/.test(cmdSrc));
check('F9 回执两态都由判据渲染（命令层不自己拼字符串）',
  /renderCompactReceipt/.test(cmdSrc) && !/已压缩：/.test(cmdSrc));

/* ── 清理与汇总 ── */
const snaps = listSnaps();
check('Z1 沙箱隔离：本套只在临时目录里造留档（真仓库 .flint/ 一字未动）',
  process.cwd() === sandbox.dir, process.cwd());
console.log(`\n（本套在沙箱里留下 ${snaps.length} 份留档，随临时目录一并删除）`);
console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败（共 ' + (passed + failed) + ' 项）');
process.exit(failed > 0 ? 1 : 0);
