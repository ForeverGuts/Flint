/**
 * 压缩判据验证套件（ROADMAP 10.8.6 / 10.8.7 / 10.8.8 / 10.8.9 / 10.8.12，2026-09-23）。
 *
 * 背景：压缩有五个决定都挤在同一个位置（切割点），改前它们散在 `compactTo` 的一串 if 里，
 * 牵一条动三条、谁也说不清为什么。现在抽成 `src/context/compaction-policy.ts` 的纯函数，
 * 本套逐条打靶：
 *   ① token 估算 —— **全项目只有一份**（两处各写一份必然漂移，且漂移互相掩护）
 *   ② 触发（10.8.9）—— 体积或条数，**任一超了就压**（3 条超长消息改前不触发，这是原洞）
 *   ③ 保留窗口（10.8.9）—— 按体积算，条数只是上限与下限
 *   ④ 切割点（10.8.12）—— **绝不能落在工具结果上**（否则孤儿 tool_result，多数 API 直接拒）
 *   ⑤ 摘要（10.8.7/8）—— 预算从 50 字放宽到 400；新摘要**吸收**上一版（滚动摘要）
 *   ⑥ 失败与退避（10.8.6）—— 失败 = 什么都没发生；且不能每轮都白烧一次摘要调用
 *   ⑦ 源码守护 —— 判据不碰 fs、摘要提示词只有一处、估算只有一处
 *
 * ⚠ 本套会真写会话文件（JsonlSessionStorage）与真写留档（真 Runtime 那段）→
 * 代码体第一件事就是 `enterSandbox()`（见 `scripts/lib/sandbox.ts`）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterSandbox } from './lib/sandbox.js';
import { JsonlSessionStorage } from '../src/session/jsonl-storage.js';
import { CompactionServiceImpl, DEFAULT_KEEP_RECENT } from '../src/context/compaction.js';
import {
  COMPACT_MESSAGE_THRESHOLD, CONTEXT_BUDGET_TOKENS, KEEP_BUDGET_RATIO, MIN_KEEP,
  SUMMARY_BUDGET_CHARS, chooseKeep, renderSummaryPrompt, safeCutIndex, shouldCompact,
  shouldRetryAfterFailure,
} from '../src/context/compaction-policy.js';
import { estimateMessagesTokens, estimateTokens } from '../src/core/token-estimate.js';
import { renderCompactReceipt } from '../src/context/compact-snapshot.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { CommandServiceImpl } from '../src/commands/system.js';
import { activate } from '../src/commands/builtin/compact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 自保（不计项数）：本套真写会话文件与留档 ── */
const sandbox = enterSandbox('flint-compaction-policy-');

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

const srcOf = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-policy-'));

const msg = (content: string, role = 'user') => ({ role, content });
const long = (n: number) => '长'.repeat(n); // 每个中文字符 ≈ 1 token，方便算体积

/* ═══════════════════════════════════════════════════════════════════════════════
   ① token 估算：口径只能有一份
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ① token 估算 ──');
{
  check('A1 中文按 1 token/字（10 个"长" ≈ 10）', estimateTokens(long(10)) === 10, String(estimateTokens(long(10))));
  check('A2 英文按 0.25 token/字（8 字符 ≈ 2）', estimateTokens('abcdabcd') === 2, String(estimateTokens('abcdabcd')));
  check('A3 空文本也算 1（不出现 0 这种"什么都没发"的假象）', estimateTokens('') === 1);
  check('A4 一批消息 = 各条累加', estimateMessagesTokens([msg(long(10)), msg(long(5))]) === 15);
  // 同一逻辑两处实现 → 互相掩护（各测各的都绿）。所以直接扫源码：全 src 只有一处估算。
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  };
  const estimators = walk(path.join(ROOT, 'src')).filter((f) => fs.readFileSync(f, 'utf8').includes('一-鿿'));
  check('A5 全 src 只有一处 token 估算（utils 与 policy 都 import 它，不再各写一份）',
    estimators.length === 1 && estimators[0].endsWith('token-estimate.ts'), estimators.join(','));
  check('A6 runtime 的用量兜底改用同一份估算（不再是第二份实现）',
    /estimateTokens\(input\)/.test(srcOf('src/runtime/utils.ts')));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 触发：体积或条数（10.8.9）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ② 触发判据（按体积，不只看条数）──');
{
  const short = Array.from({ length: 25 }, (_, i) => msg(`第 ${i} 句`));
  const fewButHuge = [msg(long(5000)), msg(long(5000)), msg(long(5000))];
  check('B1 条数与体积都没超 → 不压', shouldCompact(Array.from({ length: 10 }, (_, i) => msg(`第 ${i} 句`))).needed === false);
  check('B2 条数超（25 > 20）→ 压，reason=messages',
    shouldCompact(short).needed === true && shouldCompact(short).reason === 'messages');
  // 这一条就是 10.8.9 的原洞：3 条消息，条数远不到 20，但体积已经远超预算
  check('B3 **3 条超长消息**体积超预算 → 压，reason=tokens（改前这条不触发）',
    shouldCompact(fewButHuge).needed === true && shouldCompact(fewButHuge).reason === 'tokens',
    JSON.stringify(shouldCompact(fewButHuge)));
  check('B4 触发原因体积优先（两者都超时报 tokens）',
    shouldCompact([msg(long(5000)), msg(long(5000)), msg(long(5000)), msg(long(5000)), msg(long(5000))]).reason === 'tokens');
  check('B5 预算与条数阈值都是**显式常量**（不埋在函数体里）',
    CONTEXT_BUDGET_TOKENS > 0 && COMPACT_MESSAGE_THRESHOLD === 20);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 保留窗口：按体积算（10.8.9）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ③ 保留窗口（按体积，条数是上下限）──');
{
  const budget = CONTEXT_BUDGET_TOKENS * KEEP_BUDGET_RATIO;
  const short = Array.from({ length: 25 }, (_, i) => msg(`第 ${i} 句`));
  check('C1 短消息（常见情况）→ 夹到上限 10 条，与改前"保留 10 条"一致',
    chooseKeep(short, budget, DEFAULT_KEEP_RECENT) === 10, String(chooseKeep(short, budget, DEFAULT_KEEP_RECENT)));

  // 每条 1500 token：累加到 6000 预算是 4 条、第 5 条超 → 收窄到 5（既小于上限 10、又高于下限 4）
  const huge = Array.from({ length: 10 }, () => msg(long(1500)));
  const keepHuge = chooseKeep(huge, budget, DEFAULT_KEEP_RECENT);
  check('C2 超长消息 → 窗口**自动收窄**（小于上限 10 条且不撞下限）',
    keepHuge === 5, String(keepHuge));

  const huge2 = Array.from({ length: 6 }, () => msg(long(5000)));
  const keepFloor = chooseKeep(huge2, budget, DEFAULT_KEEP_RECENT);
  check(`C3 有下限 MIN_KEEP=${MIN_KEEP}（一条就超预算也不能把刚做的事全清掉）`,
    keepFloor === MIN_KEEP, String(keepFloor));

  check('C4 空历史 → 0', chooseKeep([], budget, DEFAULT_KEEP_RECENT) === 0);
  const many = Array.from({ length: 100 }, () => msg('好'));
  check('C5 上限生效（再多极短消息也不会超过 maxKeep）',
    chooseKeep(many, budget, DEFAULT_KEEP_RECENT) === DEFAULT_KEEP_RECENT);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 切割点：不能落在工具结果上（10.8.12）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ④ 切割点合法性 ──');
{
  // 会话里的真实顺序：…assistant(带 tool_calls) → tool → tool → assistant…
  const roles = ['user', 'assistant', 'tool', 'tool', 'user', 'assistant', 'tool', 'user'];
  check('D1 落在 user 上 → 不动', safeCutIndex(roles, 4) === 4);
  check('D2 落在 assistant 上 → 不动', safeCutIndex(roles, 5) === 5);
  check('D3 落在 tool 上 → **往前挪**（不能拿孤儿结果当窗口第一条）', safeCutIndex(roles, 6) === 5,
    String(safeCutIndex(roles, 6)));
  check('D4 连续多条 tool → 一直挪到发起调用的那条 assistant 之前', safeCutIndex(roles, 3) === 1,
    String(safeCutIndex(roles, 3)));
  // 断言的是**结果**（挪完不是 tool），不是"挪了几步"——后者一改顺序就红，与意图无关
  for (const cut of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const i = safeCutIndex(roles, cut);
    if (roles[i] === 'tool') { failed++; console.log(`  ❌ D5 切割点 ${cut} 挪完仍是 tool`); }
  }
  if (!roles.includes('tool')) { /* 不可能，占位 */ }
  check('D5 任意切割点挪完都**不在 tool 上**（逐个验，不是只验一个样本）',
    [0, 1, 2, 3, 4, 5, 6, 7].every((c) => roles[safeCutIndex(roles, c)] !== 'tool'));
  check('D6 越界的切割点 → 夹到末尾', safeCutIndex(roles, 99) === roles.length - 1);
  check('D7 负数 / 0 → 0（不会挪成负下标）', safeCutIndex(roles, -5) === 0 && safeCutIndex(roles, 0) === 0);
  check('D8 空角色表 → 0', safeCutIndex([], 3) === 0);
}

/* ── D9：真接线 —— 真存储里塞工具结果，看落进树的 firstKeptId ── */
async function makeStorage(
  name: string,
  spec: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }>,
): Promise<JsonlSessionStorage> {
  const storage = await JsonlSessionStorage.create(tmpDir, name);
  for (const m of spec) {
    await storage.appendMessage(m.role, m.content, {
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls as never } : {}),
    });
  }
  return storage;
}

{
  // 25 条：第 15 条（0-based，= 25-10 的裸切割点）刻意放成 tool 结果
  const spec: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }> = [];
  for (let i = 0; i < 14; i++) spec.push({ role: 'user', content: `第 ${i} 句` });
  spec.push({ role: 'assistant', content: '我来读一下', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] });
  spec.push({ role: 'tool', content: '文件内容 A', tool_call_id: 'c1' });
  spec.push({ role: 'tool', content: '文件内容 B', tool_call_id: 'c1' });
  for (let i = 17; i < 25; i++) spec.push({ role: 'user', content: `第 ${i} 句` });

  const storage = await makeStorage('cut-on-tool.jsonl', spec);
  const ids = storage.getAllMsgIds();
  const svc = new CompactionServiceImpl({ llm: {
    chat: async () => ({ content: '这是摘要', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
    stream: () => { throw new Error('不走流式'); },
  } as never });
  const r = await svc.compactNow(await storage.getMessages(), storage, { keepRecent: 10 });
  const comp = storage.getCompactions()[0];
  const firstKeptRole = comp ? storage.getMsgById(comp.firstKeptId)?.role : '（没入树）';
  check('D9 真存储：裸切割点正好是 tool 时，入树的 firstKeptId **不是** tool（没有孤儿）',
    r.summary !== undefined && firstKeptRole !== 'tool' && firstKeptRole === 'assistant',
    `firstKeptRole=${firstKeptRole}`);
  check('D9b 挪动后保留窗口比 keep 多几条（安全优先，宁可多留不可造孤儿）',
    r.history.length > 10, `kept=${r.history.length}`);
  check('D9c 被换掉的那批不含窗口第一条之后的任何内容（切割点没被挪反方向）',
    comp?.firstKeptId === ids[14], `firstKeptId=${comp?.firstKeptId} ids[14]=${ids[14]}`);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 摘要：预算放宽 + 吸收上一版（10.8.7 / 10.8.8）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑤ 摘要提示词 ──');
{
  const p0 = renderSummaryPrompt();
  check('E1 没有上一版摘要 → 提示词里不出现"更早阶段的概括"', !p0.includes('更早阶段的概括'), p0);
  check(`E2 预算写进提示词且是 ${SUMMARY_BUDGET_CHARS} 字（不再是写死的 50 字）`,
    p0.includes(String(SUMMARY_BUDGET_CHARS)) && !p0.includes('50 字'), p0);
  const p1 = renderSummaryPrompt('上一版摘要：决定用 A 方案');
  check('E3 有上一版摘要 → **原样带进提示词**（信息能跨层传承）', p1.includes('上一版摘要：决定用 A 方案'), p1);
  check('E4 带旧摘要时必须写清"冲突以新对话为准"（否则过时结论会被一直传下去）',
    p1.includes('冲突') && p1.includes('新对话为准'), p1);
  check('E5 两种形态都保留"压缩为一段摘要"这个稳定措辞（fork-summary 的断言认它）',
    p0.includes('压缩为一段摘要') && p1.includes('压缩为一段摘要'));
}

{
  // 真接线：第二次压缩时，喂给 LLM 的 system 提示词必须含上一版摘要
  const spec = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `第 ${i} 句` }));
  const storage = await makeStorage('rolling.jsonl', spec);
  const calls: Array<{ system: string; user: string }> = [];
  let n = 0;
  const svc = new CompactionServiceImpl({ llm: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chat: async (msgs: any[]) => {
      calls.push({ system: String(msgs[0]?.content ?? ''), user: String(msgs[1]?.content ?? '') });
      n++;
      return { content: `第 ${n} 版摘要`, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
    stream: () => { throw new Error('不走流式'); },
  } as never });
  await svc.compactNow(await storage.getMessages(), storage, { keepRecent: 10 });
  for (let i = 25; i < 35; i++) await storage.appendMessage('user', `第 ${i} 句`);
  await svc.compactNow(await storage.getMessages(), storage, { keepRecent: 10 });
  check('E6 真接线：第二次压缩把**上一版摘要**喂进了 LLM（滚动摘要真的接上了）',
    calls.length === 2 && calls[1].system.includes('第 1 版摘要'), JSON.stringify(calls[1]?.system.slice(0, 60)));
  check('E7 第一次压缩没有上一版（不该硬塞一个空的"更早概括"）',
    calls[0].system.includes('更早阶段的概括') === false, calls[0].system.slice(0, 40));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑥ 失败语义与退避（10.8.6）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑥ 失败与退避 ──');
{
  check('F1 退避判据：没失败过 → 永远试', shouldRetryAfterFailure(25, undefined, 10) === true);
  check('F2 退避判据：对话没变长 → 不重试（否则每轮白烧一次摘要调用）',
    shouldRetryAfterFailure(25, 25, 10) === false);
  check('F3 退避判据：又长了 10 条 → 重试', shouldRetryAfterFailure(35, 25, 10) === true);
}

{
  // 真接线：失败 → 历史不动 → 再跑一次不再调 LLM → 对话变长后才重试
  const spec = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `第 ${i} 句` }));
  const storage = await makeStorage('fail-backoff.jsonl', spec);
  let chatCount = 0;
  let throwNow = true;
  const svc = new CompactionServiceImpl({ llm: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chat: async (_msgs: any[]) => {
      chatCount++;
      if (throwNow) throw new Error('LLM 挂了');
      return { content: '补考成功', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
    stream: () => { throw new Error('不走流式'); },
  } as never });

  const r1 = await svc.maybeCompact(await storage.getMessages(), storage);
  check('F4 失败时 history **一条都不裁**（没压成 = 什么都没发生）',
    r1.history.length === 25 && r1.summary === undefined && typeof r1.failed === 'string', JSON.stringify(r1).slice(0, 80));
  check('F5 失败不入树（没有那条 compaction 记录）', storage.getCompactions().length === 0);

  const r2 = await svc.maybeCompact(await storage.getMessages(), storage);
  check('F6 退避真的退了：对话没变长 → **不再调 LLM**（chatCount 不变）',
    chatCount === 1 && typeof r2.failed === 'string' && r2.failed.includes('等对话再长一些'), `chatCount=${chatCount}`);

  for (let i = 25; i < 35; i++) await storage.appendMessage('user', `第 ${i} 句`);
  throwNow = false;
  const r3 = await svc.maybeCompact(await storage.getMessages(), storage);
  check('F7 对话又长了 10 条 → 重试并成功（退避不是永久放弃）',
    r3.summary === '补考成功' && chatCount === 2 && storage.getCompactions().length === 1, `chatCount=${chatCount}`);

  // 成功后退避必须清零：否则下一次压缩会被上次的失败计数挡住
  // ⚠ 追加 11 条而非 10 条（F 修复 2026-09-24 后的口径）：条数阈值只数**真实消息**，
  // 压缩后视图 10 条 + 10 = 20 不触发（以前摘要条目占 1 个名额，21 就触发），+11 = 21 > 20 才压。
  for (let i = 35; i < 46; i++) await storage.appendMessage('user', `第 ${i} 句`);
  await svc.maybeCompact(await storage.getMessages(), storage);
  check('F8 成功后退避清零（下一次还能正常压，不会被上次失败挡住）', chatCount === 3, `chatCount=${chatCount}`);
}

{
  // 真 Runtime：手动 /compact 的回执必须说"摘要没生成出来"，而不是"已经被压过了"
  const storage = await makeStorage('receipt.jsonl', Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `第 ${i} 句` })));
  const llm = {
    chat: async () => { throw new Error('LLM 挂了'); },
    stream: () => { throw new Error('不走流式'); },
  };
  const cmds = new CommandServiceImpl();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rt = new Runtime({
    llm: llm as never,
    session: storage,
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
  const out = await rt.compactSession();
  check('F9 真 Runtime：手动压缩失败时回执说"摘要没生成出来"（**不再**说成"已经被压过了"）',
    out.compressed === false && typeof out.reason === 'string'
    && out.reason.includes('摘要没生成出来') && !out.reason.includes('已经被压过了'), String(out.reason));
  check('F10 失败时留档**照样写了**（先留后压：留档不依赖摘要成功）',
    typeof out.snapshot === 'string' && out.snapshot.length > 0, String(out.snapshot));
  // ⚠ 给**人读**的输出必须断在渲染出的文本上：只验对象里有 snapshot 字段，
  // 渲染器不输出的话用户照样看不见（M11 变异就是这么全绿的）。
  const failReceipt = renderCompactReceipt({
    compressed: false, keep: 10, dropped: 0, kept: 25,
    reason: '摘要没生成出来（LLM 调用失败）', snapshot: '.flint/snapshots/compact-x.md',
  });
  check('F11 没压成但留档已落盘时，回执**明说留档在哪**（否则磁盘上悄悄多一个文件）',
    failReceipt.includes('.flint/snapshots/compact-x.md') && failReceipt.includes('留档已写入'), failReceipt);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑦ 源码守护
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑦ 源码守护 ──');
{
  const policySrc = srcOf('src/context/compaction-policy.ts');
  const ctxSrc = srcOf('src/context/compaction.ts');
  const runtimeSrc = srcOf('src/runtime/runtime.ts');

  check('G1 判据模块不碰 fs（落盘只在执行层）', !/node:fs/.test(policySrc));
  check('G2 判据模块只 import token 估算这一个纯模块（不依赖运行时）',
    (policySrc.match(/^import\s/gm) ?? []).length === 1 && policySrc.includes('core/token-estimate.js'),
    String((policySrc.match(/^import\s/gm) ?? []).length));
  check('G3 摘要提示词不在执行层（执行层只调 renderSummaryPrompt）',
    !/50 字/.test(ctxSrc) && /renderSummaryPrompt\(prevSummary\)/.test(ctxSrc));
  check('G4 执行层用 safeCutIndex 算切割点（不是裸的 length - keep）',
    /safeCutIndex\(roles, allIds\.length - keep\)/.test(ctxSrc));
  check('G5 执行层触发判据走 shouldCompact（不再自己比条数）',
    /shouldCompact\(history, CONTEXT_BUDGET_TOKENS, COMPACT_THRESHOLD\)/.test(ctxSrc));
  check('G6 保留条数由 chooseKeep 按体积算（条数只是上限）',
    /chooseKeep\(history, CONTEXT_BUDGET_TOKENS \* KEEP_BUDGET_RATIO, DEFAULT_KEEP_RECENT\)/.test(ctxSrc));

  // 手动回执那两个分支的**顺序**承重：失败时 summary 同样是 undefined，
  // 判反了就会把"摘要没生成出来"说成"已经压过了"
  const csBody = runtimeSrc.slice(runtimeSrc.indexOf('async compactSession'), runtimeSrc.indexOf('private async forkToStorage'));
  check('G7 手动回执先判 failed 再判 !summary（顺序反了就会说谎）',
    csBody.indexOf('result.failed') !== -1 && csBody.indexOf('result.failed') < csBody.indexOf('!result.summary'),
    `failed@${csBody.indexOf('result.failed')} !summary@${csBody.indexOf('!result.summary')}`);
}

/* ── 清理与汇总 ── */
check('Z1 沙箱隔离：本套只在临时目录里造文件（真仓库一字未动）',
  process.cwd() === sandbox.dir, process.cwd());
console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败（共 ' + (passed + failed) + ' 项）');
process.exit(failed > 0 ? 1 : 0);
