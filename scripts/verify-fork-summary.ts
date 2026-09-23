/**
 * verify-fork-summary.ts —— 分支摘要（fork 带摘要从此继续）+ 压缩视图裁剪修复
 *
 * 验什么（手段与行为分开钉）：
 *   ① 视图裁剪回归（真存储，bug 修复本体）—— getMessages 只端出 [对话摘要] + firstKeptId 起的
 *      消息；后续轮次稳定；审计层（getAllStored/getAllMsgIds）不裁；无 compaction 全量；
 *      多次 compaction 只认最后一个（与 SystemPromptService 摘要层同一口径）
 *   ② compactNow 契约行为（真 CompactionServiceImpl + 真存储 + 探针 llm）—— 短前缀 no-op、
 *      长前缀摘要入树、firstKeptId 正确、llm 探针收到待压缩内容、keepRecent 覆盖、
 *      失败路径不入树且下轮 maybeCompact 能再试
 *   ③ Runtime 接线（真 Runtime + 真存储 + 真 CompactionServiceImpl）—— forkSessionWithSummary
 *      长前缀 summarized=true 且切会话且入树、原文件未动（审计性）、短前缀退化普通分叉、
 *      无 forkTo 能力返回空、forkSessionAt 回归不变；
 *      **leaf 持久化回归**（2026-09-12 修复的第二个 bug）—— fork 后继续聊 / fork 摘要入树，
 *      重开文件后新消息与摘要仍在视图（此前 fork 文件的 leaf 永远停在 fork 点，重开即丢）
 *   ④ /history 接线 —— 菜单项、forkSessionWithSummary 调用、两种回执文案
 *   ⑤ 源码守护 —— 裁剪逻辑在 getMessages 里（先切片段防误伤注释）、摘要 prompt 全库单一来源、
 *      runtime 真 compactNow 委托、maybeCompact 阈值闸仍在
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-fork-summary.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlSessionStorage } from '../src/session/jsonl-storage.js';
import { CompactionServiceImpl } from '../src/context/compaction.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-fork-summary-'));

/** 造一个真实存储并写入 n 条 user 消息，返回 { storage, ids } */
async function makeStorage(name: string, n: number): Promise<{ storage: JsonlSessionStorage; ids: string[] }> {
  const storage = await JsonlSessionStorage.create(tmpDir, name);
  for (let i = 1; i <= n; i++) await storage.appendMessage('user', `消息 ${i}`);
  return { storage, ids: storage.getAllMsgIds() };
}

/** 探针 LLM：记录每次 chat 收到的消息，返回固定摘要 */
function makeProbeLlm(opts: { reply?: string; throwOnChat?: boolean } = {}) {
  const chats: Array<Array<{ role: string; content: string }>> = [];
  return {
    chats,
    chat: async (msgs: Array<{ role: string; content: string }>) => {
      chats.push(msgs);
      if (opts.throwOnChat) throw new Error('llm 炸了');
      return { content: opts.reply ?? '这是摘要' };
    },
    stream: () => { throw new Error('压缩不该走流式'); },
  };
}

/* ── 替身：只关心 session / compaction 是真的，其余最小假件（同 verify-repo 口径） ── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(session: any, compaction: any): any {
  return new Runtime({
    llm: { chat: async () => ({ content: '' }), stream: () => { throw new Error('本脚本不触发 LLM'); } },
    session,
    tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: '' }), register: () => {} },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {} },
    skills: { load: () => {} },
    events: new PromptEventEmitter(),
    spanCollector: { collect: () => [], running: () => [] },
    commandSystem: { register: () => {}, list: () => [], execute: () => null },
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction,
    systemPromptService: { build: async () => ({ messages: [] }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/* ════════════ ① 视图裁剪回归（bug 修复本体） ════════════ */
console.log('── ① 视图裁剪回归（真存储：getMessages 只端出摘要 + 保留窗口）──');
{
  const { storage, ids } = await makeStorage('view.jsonl', 25);
  // 模拟压缩子系统落账：摘要顶替前 15 条，保留最近 10 条（firstKeptId = 第 16 条）
  await storage.appendCompaction('前 15 条的摘要', ids[15]);

  const view = await storage.getMessages();
  check('F1 视图 = 11 条（1 摘要 + 保留 10 条），修复前是 26 条全量', view.length === 11, `实得 ${view.length}`);
  check('F2 视图首条是 [对话摘要] system 消息', view[0].role === 'system' && view[0].content === '[对话摘要] 前 15 条的摘要');
  check('F3 被顶替的旧消息（消息 1）不在视图', !view.some((m) => m.content === '消息 1'));
  check('F4 保留窗口从第 16 条开始', view[1].content === '消息 16', `实得 ${String(view[1]?.content)}`);
  check('F5 保留窗口到第 25 条结束（最后 10 条原样）', view[10].content === '消息 25');

  // 后续轮次稳定：再聊一条，旧消息仍不回流
  await storage.appendMessage('user', '消息 26');
  const view2 = await storage.getMessages();
  check('F6 再聊一条后视图 = 12 条，旧消息不回流（修复前会涨回 27 条全量）',
    view2.length === 12 && !view2.some((m) => m.content === '消息 1'), `实得 ${view2.length}`);

  // 审计层不裁：/history 展示与压缩增量判断仍见全量
  check('F7 getAllStored 审计层仍是全量 26 条（视图裁剪只影响 LLM 看到的）',
    (await storage.getAllStored()).length === 26);
  check('F8 getAllMsgIds 审计层仍是全量 26 条（压缩增量判断靠它）', storage.getAllMsgIds().length === 26);
}

{
  const { storage } = await makeStorage('view-clean.jsonl', 25);
  check('F9 无 compaction → 视图全量 25 条（不误裁）', (await storage.getMessages()).length === 25);
}

{
  // 多次 compaction：只认最后一个（更早的摘要被覆盖、一并出视图）
  const { storage, ids } = await makeStorage('view-multi.jsonl', 25);
  await storage.appendCompaction('第一段摘要', ids[15]);
  for (let i = 26; i <= 30; i++) await storage.appendMessage('user', `消息 ${i}`);
  await storage.appendCompaction('第二段摘要', storage.getAllMsgIds()[20]); // 压 16..20，保留 21..30
  const view = await storage.getMessages();
  check('F10 两次 compaction → 视图 = 第二段摘要 + 21..30 共 11 条',
    view.length === 11 && view[0].content === '[对话摘要] 第二段摘要', `实得 ${view.length}`);
  check('F11 被覆盖的第一段摘要不在视图（单一摘要口径）',
    !view.some((m) => m.content.includes('第一段摘要')));
  check('F12 保留窗口从第 21 条开始', view[1].content === '消息 21', `实得 ${String(view[1]?.content)}`);
}

/* ════════════ ② compactNow 契约行为 ════════════ */
console.log('── ② compactNow（真 CompactionServiceImpl + 真存储 + 探针 llm）──');
{
  const { storage } = await makeStorage('cn-short.jsonl', 8);
  const llm = makeProbeLlm();
  const svc = new CompactionServiceImpl({ llm: llm as never });
  const history = await storage.getMessages();
  const r = await svc.compactNow(history);
  check('G1 前缀 8 条（≤10）→ 不压缩，summary 为 undefined', r.summary === undefined && r.history.length === 8);
  check('G2 没有调 LLM（短前缀摘要没有收益）', llm.chats.length === 0);
  check('G3 没有 compaction 入树', storage.getCompactions().length === 0);
}

{
  const { storage, ids } = await makeStorage('cn-long.jsonl', 25);
  const llm = makeProbeLlm({ reply: '分支前缀摘要' });
  const svc = new CompactionServiceImpl({ llm: llm as never });
  const r = await svc.compactNow(await storage.getMessages(), storage);
  check('G4 25 条 → 压缩生效，summary 独立返回', r.summary === '分支前缀摘要');
  check('G5 history 裁到最近 10 条', r.history.length === 10 && r.history[0].content === '消息 16');
  check('G6 compaction 入树 1 个，firstKeptId = 第 16 条的 id',
    storage.getCompactions().length === 1 && storage.getCompactions()[0].firstKeptId === ids[15]);
  check('G7 探针 llm 收到摘要指令（压缩 prompt 单一来源）',
    llm.chats.length === 1 && llm.chats[0][0].role === 'system' && llm.chats[0][0].content.includes('压缩为一段摘要'));
  check('G8 待压缩内容是前 15 条（25 - 保留 10）',
    (llm.chats[0][1].content.match(/^user: 消息 /gm) ?? []).length === 15);
  // 视图联动：入树后 getMessages 立即变成"摘要 + 10 条"
  const view = await storage.getMessages();
  check('G9 入树后视图 = 摘要 + 最近 10 条（fork 摘要当场生效）',
    view.length === 11 && view[0].content === '[对话摘要] 分支前缀摘要');
}

{
  // keepRecent 覆盖
  const { storage, ids } = await makeStorage('cn-keep.jsonl', 20);
  const svc = new CompactionServiceImpl({ llm: makeProbeLlm() as never });
  const r = await svc.compactNow(await storage.getMessages(), storage, { keepRecent: 5 });
  check('G10 keepRecent=5 → 压 15 条保留 5，firstKeptId = 第 16 条',
    r.history.length === 5 && storage.getCompactions()[0].firstKeptId === ids[15]);
}

{
  // 失败路径：不入树、只裁历史；下轮 maybeCompact 能再试
  const { storage } = await makeStorage('cn-fail.jsonl', 25);
  const svc = new CompactionServiceImpl({ llm: makeProbeLlm({ throwOnChat: true }) as never });
  const r = await svc.compactNow(await storage.getMessages(), storage);
  check('G11 llm 炸了 → summary undefined、不升压', r.summary === undefined);
  check('G12 失败不入树（下次请求 maybeCompact 会再试）', storage.getCompactions().length === 0);
  // 10.8.6 反掉了这条：改前"裁了历史却没写记录"，下一轮历史整体滚回来又触发又失败。
  // 现在失败 = 什么都没发生（history 原样、failed 带回原因），压缩不可逆所以不能假成功。
  check('G13 失败**一条都不裁**（没压成 = 什么都没发生）',
    r.history.length === 25 && typeof r.failed === 'string', JSON.stringify(r.failed));
  const svc2 = new CompactionServiceImpl({ llm: makeProbeLlm({ reply: '补考成功' }) as never });
  const r2 = await svc2.maybeCompact(await storage.getMessages(), storage);
  check('G14 下轮 maybeCompact 补考成功（25 > 阈值 20 → 摘要入树）',
    r2.summary === '补考成功' && storage.getCompactions().length === 1);
}

{
  // span 可观测：compaction 段成对发出
  const { storage } = await makeStorage('cn-span.jsonl', 25);
  const bus = new PromptEventEmitter();
  const got: Array<Record<string, unknown>> = [];
  bus.subscribe((e) => got.push(e as unknown as Record<string, unknown>));
  const svc = new CompactionServiceImpl({ llm: makeProbeLlm() as never, storage, events: bus });
  await svc.compactNow(await storage.getMessages(), storage);
  const byType = (t: string) => got.filter((e) => e.type === t);
  check('G15 compaction 段成对发出（start/end 各 1）',
    byType('compaction_start').length === 1 && byType('compaction_end').length === 1);
  check('G16 thinking:compressing 照发（UI 行为不变）',
    got.some((e) => e.type === 'thinking' && (e as { phase?: string }).phase === 'compressing'));
}

/* ════════════ ③ Runtime 接线 ════════════ */
console.log('── ③ Runtime.forkSessionWithSummary（真 Runtime + 真存储 + 真 CompactionServiceImpl）──');
{
  const { storage, ids } = await makeStorage('rt-main.jsonl', 25);
  const llm = makeProbeLlm({ reply: 'runtime 摘要' });
  const compaction = new CompactionServiceImpl({ llm: llm as never }); // storage 无关紧要，下面会换成新分支的
  const rt = makeRuntime(storage, compaction);

  const beforePath = storage.getFilePath();
  const r = await rt.forkSessionWithSummary(ids[20]); // 分叉到第 21 条为止 → 新分支前缀 21 条

  check('H1 长前缀 → summarized=true', r.summarized === true);
  check('H2 返回文件名非空且 summary 是 llm 返回值', r.fileName.endsWith('.jsonl') && r.summary === 'runtime 摘要');
  const cur = rt.getCurrentSessionFile();
  check('H3 当前会话已切到新分支文件', !!cur && cur !== beforePath && cur?.endsWith(r.fileName));
  const fresh = await JsonlSessionStorage.open(String(cur));
  check('H4 新文件 compaction 入树（持久化，不只在内存）',
    fresh !== undefined && (fresh as JsonlSessionStorage).getCompactions().length === 1);
  check('H5 新分支视图 = 摘要 + 保留窗口（21 条前缀 → 压 11 留 10）',
    fresh !== undefined && (await (fresh as JsonlSessionStorage).getMessages()).length === 11);
  const orig = await JsonlSessionStorage.open(beforePath);
  check('H6 原文件未动：仍 25 条、无 compaction（fork 审计性）',
    orig !== undefined && (orig as JsonlSessionStorage).getAllStored().length === 25
    && (orig as JsonlSessionStorage).getCompactions().length === 0);
  check('H7 /history 展示层（getAllStored）在新分支仍是全量前缀 21 条（审计不裁）',
    fresh !== undefined && (fresh as JsonlSessionStorage).getAllStored().length === 21);
}

{
  // 短前缀：退化普通分叉（ids[5] 是第 6 条 → 新分支前缀 6 条）
  const { storage, ids } = await makeStorage('rt-short.jsonl', 6);
  const rt = makeRuntime(storage, new CompactionServiceImpl({ llm: makeProbeLlm() as never }));
  const r = await rt.forkSessionWithSummary(ids[5]);
  check('H8 短前缀 → summarized=false（不硬压）', r.summarized === false && r.summary === undefined);
  const cur = rt.getCurrentSessionFile();
  const fresh = await JsonlSessionStorage.open(String(cur));
  check('H9 短前缀分支无 compaction、视图全量 6 条',
    fresh !== undefined && (fresh as JsonlSessionStorage).getCompactions().length === 0
    && (await (fresh as JsonlSessionStorage).getMessages()).length === 6);
}

{
  // leaf 持久化回归（2026-09-12 修复的第二个 bug：fork 文件此前只有 forkTo 写过一次 leaf，
  // 之后追加的消息/摘要重开后全部从视图消失——create 的文件没 leaf 走兜底，既有测试没抓到）
  const { storage, ids } = await makeStorage('rt-leaf.jsonl', 3);
  const rt = makeRuntime(storage, new CompactionServiceImpl({ llm: makeProbeLlm() as never }));
  const r = await rt.forkSessionWithSummary(ids[2]); // 前缀 3 条，不压
  await rt.session.appendMessage('user', 'fork 之后聊的新消息');
  await rt.session.appendMessage('assistant', 'fork 之后的回复');
  const reopened = await JsonlSessionStorage.open(String(rt.getCurrentSessionFile()));
  check('H14 fork → 继续聊 → 重开：新消息仍在视图（修复前会回退到 fork 点全部失踪）',
    reopened !== undefined
    && (await (reopened as JsonlSessionStorage).getMessages()).some((m) => m.content === 'fork 之后聊的新消息')
    && (await (reopened as JsonlSessionStorage).getMessages()).some((m) => m.content === 'fork 之后的回复'));
  // 长前缀版：compaction 追加后重开也不丢
  const { storage: s2, ids: ids2 } = await makeStorage('rt-leaf2.jsonl', 25);
  const rt2 = makeRuntime(s2, new CompactionServiceImpl({ llm: makeProbeLlm({ reply: '重启后仍在' }) as never }));
  const r2 = await rt2.forkSessionWithSummary(ids2[20]);
  const reopened2 = await JsonlSessionStorage.open(String(rt2.getCurrentSessionFile()));
  const view2 = await (reopened2 as JsonlSessionStorage).getMessages();
  check('H15 fork 摘要 → 重开：视图仍是摘要 + 10 条（compaction 落盘且 leaf 指向它）',
    r2.summarized === true && view2.length === 11 && view2[0].content === '[对话摘要] 重启后仍在');
}

{
  // 无 forkTo 能力（InMemory/Mock）
  const rt = makeRuntime({ getMessages: async () => [], appendMessage: async () => {} },
    new CompactionServiceImpl({ llm: makeProbeLlm() as never }));
  const r = await rt.forkSessionWithSummary('m0');
  check('H10 无 forkTo 能力 → { fileName: \'\', summarized: false }（不抛异常）',
    r.fileName === '' && r.summarized === false);
  const at = await rt.forkSessionAt('m0');
  check('H11 forkSessionAt 回归：同样能力缺失返回空串（原行为不变）', at === '');
}

{
  // forkSessionAt 回归：普通分叉仍工作、不产生 compaction
  const { storage, ids } = await makeStorage('rt-plain.jsonl', 12);
  const rt = makeRuntime(storage, new CompactionServiceImpl({ llm: makeProbeLlm() as never }));
  const name = await rt.forkSessionAt(ids[7]);
  check('H12 forkSessionAt 仍返回新文件名（行为未变）', typeof name === 'string' && name.endsWith('.jsonl'));
  const cur = rt.getCurrentSessionFile();
  const fresh = await JsonlSessionStorage.open(String(cur));
  check('H13 普通分叉不产生 compaction、视图 8 条全量',
    fresh !== undefined && (fresh as JsonlSessionStorage).getCompactions().length === 0
    && (await (fresh as JsonlSessionStorage).getMessages()).length === 8);
}

/* ════════════ ④ /history 接线 ════════════ */
console.log('── ④ /history 命令接线（源码断言）──');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/commands/builtin/history.ts'), 'utf8');
  check('I1 菜单里有"带摘要从此继续"选项', src.includes("'fork-summary'") && src.includes('带摘要从此继续'));
  check('I2 选它走 forkSessionWithSummary', /case 'fork-summary'[\s\S]*?forkSessionWithSummary/.test(src));
  check('I3 长前缀回执文案存在（压缩为摘要 + 最近 10 条）', src.includes('旧前缀已压缩为摘要'));
  check('I4 短前缀回执文案存在（未生成摘要，等同普通分叉）', src.includes('未生成摘要，等同普通分叉'));
}

/* ════════════ ⑤ 源码守护 ════════════ */
console.log('── ⑤ 源码守护 ──');
{
  const storageSrc = fs.readFileSync(path.join(ROOT, 'src/session/jsonl-storage.ts'), 'utf8');
  // 先切出 getMessages 函数片段再断言（防误伤文件其他区域的注释/实现）
  const gm = storageSrc.slice(storageSrc.indexOf('async getMessages'), storageSrc.indexOf('getAllStored'));
  check('J1 getMessages 里真有裁剪逻辑（找 lastCompIdx 的定位循环）',
    /lastCompIdx/.test(gm) && /firstKeptId/.test(gm) && /slice\(keptIdx\)/.test(gm));
  check('J2 裁剪失败兜底：firstKeptId 不在路径上 → 不裁全量渲染',
    /不裁剪，全量渲染兜底/.test(gm));

  // 摘要 prompt 全库单一来源
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  };
  const hits = walk(path.join(ROOT, 'src'))
    .filter((f) => fs.readFileSync(f, 'utf8').includes('压缩为一段摘要'));
  // 2026-09-23：提示词搬到判据模块（10.8.7 放宽预算 + 10.8.8 滚动摘要要按参数渲染），
  // 唯一性这条**仍然承重** —— 只是落点从 compaction.ts 换成了 compaction-policy.ts。
  check('J3 摘要 prompt 全 src 只有一处（compaction-policy.ts 的 renderSummaryPrompt，不复制第二份）',
    hits.length === 1 && hits[0].endsWith('compaction-policy.ts'), hits.join(','));

  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'src/runtime/runtime.ts'), 'utf8');
  check('J4 runtime 的 forkSessionWithSummary 真委托 compactNow',
    /forkSessionWithSummary[\s\S]{0,600}compactNow/.test(runtimeSrc));
  check('J5 maybeCompact 的阈值闸仍在（compactNow 不该把它顶掉）',
    /COMPACT_THRESHOLD/.test(fs.readFileSync(path.join(ROOT, 'src/context/compaction.ts'), 'utf8')));
}

/* ── 收尾 ── */
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
