/**
 * 文件操作清单验证套件（ROADMAP 10.8.11，2026-09-24）。
 *
 * 背景：摘要由 LLM 散文生成、细节会丢，但"这个会话碰过哪些文件"是可操作性最高的窄信息
 * （Pi 的 compaction entry 带 readFiles / modifiedFiles 并逐层累积，2026-09-22 调研）。
 * 落地形状：判据纯函数 `src/context/file-ledger.ts`（抽取 / 合并 / 渲染 / 成文四件套）+
 * compaction entry 结构化字段（filesModified / filesRead）+ runtime 摘要层确定性拼接。
 * 本套逐条打靶：
 *   ① 抽取 —— 封闭枚举工具名、目标格、坏参数跳过、**最近优先**排序
 *   ② 合并 —— 去重、上限截断丢最老、prev 缺省
 *   ③ 渲染 —— **断言断在渲染文本上**（给人/模型读的输出）
 *   ④ 真件驱动 —— 真 JsonlSessionStorage + 真 CompactionServiceImpl：抽取、
 *      逐层累积（第二次压缩合并第一条的清单）、无工具不写字段、旧文件兼容、
 *      maybeCompact 每轮现读
 *   ⑤ 源码守护 —— 判据零 import、core 不依赖 llm、拼接点唯一、工具名清单不漂移
 *
 * ⚠ 本套真写会话文件 → 代码体第一件事就是 `enterSandbox()`（见 `scripts/lib/sandbox.ts`）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterSandbox } from './lib/sandbox.js';
import { JsonlSessionStorage } from '../src/session/jsonl-storage.js';
import { CompactionServiceImpl } from '../src/context/compaction.js';
import {
  LEDGER_MODIFIED_CAP, LEDGER_READ_CAP, LEDGER_READ_TOOLS, LEDGER_WRITE_TOOLS,
  extractTouched, glueSummaryLedger, isLedgerEmpty, mergeLedger, renderLedger,
} from '../src/context/file-ledger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 自保（不计项数）：本套真写会话文件 ── */
const sandbox = enterSandbox('flint-file-ledger-');
const tmpDir = sandbox.dir;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail !== undefined ? ` —— ${String(detail)}` : ''}`); }
}

/** 造一条带工具调用的 assistant 消息 */
function acall(name: string, args: unknown): { role: string; tool_calls: Array<{ function: { name: string; arguments: string } }> } {
  return { role: 'assistant', tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 抽取（extractTouched）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ① 抽取：封闭枚举 + 目标格 + 坏参数 ──');
{
  const r = extractTouched([
    acall('write', { path: 'src/a.ts' }),
    acall('edit', { path: 'src/b.ts' }),
    acall('git_write', { target: 'src/c.ts' }),
    acall('trash', { path: 'src/old.ts' }),
  ]);
  check('A1 write/edit/git_write/trash → 改写桶（git_write 认 target 格）',
    r.modified.length === 4 && r.modified.includes('src/a.ts') && r.modified.includes('src/b.ts')
    && r.modified.includes('src/c.ts') && r.modified.includes('src/old.ts'),
    JSON.stringify(r.modified));
  check('A2 改写桶**最近优先**（trash 是最后一条 → 排第一）', r.modified[0] === 'src/old.ts',
    r.modified[0]);
}
{
  const r = extractTouched([acall('read', { path: 'docs/x.md' }), acall('ls', { path: 'src' })]);
  check('A3 read/ls → 只读桶', r.read.length === 2 && r.read.includes('docs/x.md') && r.read.includes('src')
    && r.modified.length === 0, JSON.stringify(r));
}
{
  const r = extractTouched([
    acall('grep', { pattern: 'x', path: 'src' }),
    acall('bash', { command: 'echo hi > ~/a.txt' }),
    acall('symbols', { query: 'foo' }),
  ]);
  check('A4 枚举外的工具一概不抽（bash 看不见是**已知边界**，不是漏）',
    r.modified.length === 0 && r.read.length === 0, JSON.stringify(r));
}
{
  const r = extractTouched([
    { role: 'assistant', tool_calls: [{ function: { name: 'write', arguments: '{path: 不是JSON' } }] },
    acall('write', { target: 42 }),
    acall('write', { path: '' }),
    acall('write', { path: '   ' }),
    acall('write', { path: 42 }),
    { role: 'user', tool_calls: [{ function: { name: 'write', arguments: '{"path":"u.txt"}' } }] },
    { role: 'assistant' },
    undefined,
  ]);
  check('A5 坏参数 / 非字符串目标 / 空目标 / 非 assistant / 无 tool_calls 全部跳过',
    r.modified.length === 0 && r.read.length === 0, JSON.stringify(r));
}
{
  const r = extractTouched([acall('read', { target: '备格也认.md' })]);
  check('A5b `target` 是**通用备格**（不只 git_write 认，认出来就记）',
    r.read.length === 1 && r.read[0] === '备格也认.md', JSON.stringify(r.read));
}
{
  const r = extractTouched([acall('read', { path: '主格.md', target: '备格.md' })]);
  check('A6 path 主格优先于 target 备格（都有时只记主格）',
    r.read.length === 1 && r.read[0] === '主格.md', JSON.stringify(r.read));
}
{
  const long = 'x'.repeat(200);
  const r = extractTouched([acall('write', { path: long })]);
  check('A7 超长路径截到 160（清单体积恒定的前提）', r.modified[0]?.length === 160,
    r.modified[0]?.length);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 合并（mergeLedger）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ② 合并：去重 + 上限丢最老 ──');
{
  const m = mergeLedger({ modified: ['a.ts', 'b.ts'], read: ['r1.md'] }, { modified: ['b.ts', 'c.ts'], read: [] });
  check('B1 两桶各自去重合并（prev + next）',
    m.modified.length === 3 && m.modified.includes('a.ts') && m.modified.includes('b.ts')
    && m.modified.includes('c.ts') && m.read.length === 1 && m.read[0] === 'r1.md',
    JSON.stringify(m));
  check('B2 next 排前面（本轮被压的比历史清单新）', m.modified.indexOf('c.ts') < m.modified.indexOf('a.ts'),
    JSON.stringify(m.modified));
}
{
  const prev = { modified: Array.from({ length: 45 }, (_, i) => `old${i}.ts`), read: [] };
  const next = { modified: Array.from({ length: 10 }, (_, i) => `new${i}.ts`), read: [] };
  const m = mergeLedger(prev, next);
  check(`B3 改写桶上限 ${LEDGER_MODIFIED_CAP}：超限丢**合并序列尾部**（prev 里最老的那段）`,
    m.modified.length === LEDGER_MODIFIED_CAP && m.modified.includes('new0.ts')
    && m.modified.includes('old34.ts') && !m.modified.includes('old44.ts'),
    `len=${m.modified.length} first=${m.modified[0]} last=${m.modified.at(-1)}`);
}
{
  const next = { modified: [], read: Array.from({ length: 35 }, (_, i) => `d${i}/`) };
  const m = mergeLedger(undefined, next);
  check(`B4 只读桶上限 ${LEDGER_READ_CAP} + prev 缺省不炸`,
    m.read.length === LEDGER_READ_CAP && m.modified.length === 0,
    `len=${m.read.length}`);
}
{
  const m = mergeLedger({ modified: ['keep.ts'], read: ['r.md'] }, { modified: [], read: [] });
  check('B5 本轮没抽出任何路径 → 上一版清单原样保留（不因空批清空历史）',
    m.modified.length === 1 && m.read.length === 1, JSON.stringify(m));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 渲染（renderLedger / glueSummaryLedger）—— 断言断在渲染文本上
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ③ 渲染：空不渲染、单边只渲染一边 ──');
{
  const text = renderLedger({ modified: ['a.ts', 'b.ts'], read: ['r.md'] });
  check('C1 双桶渲染成一行，改过在前看过在后',
    text.includes('[本会话碰过的文件') && text.indexOf('改过') < text.indexOf('看过')
    && text.includes('a.ts、b.ts') && text.includes('r.md'), text);
  check('C2 空清单渲染成空串（不产生空节）',
    renderLedger({ modified: [], read: [] }) === '' && renderLedger(undefined) === '');
  check('C3 isLedgerEmpty 是"空"的唯一判定', isLedgerEmpty({ modified: [], read: [] })
    && !isLedgerEmpty({ modified: ['x'], read: [] }));
  check('C4 glueSummaryLedger：摘要 + 清单 = 摘要\\n\\n清单节',
    glueSummaryLedger('这是摘要', { modified: ['a.ts'], read: [] })
      === '这是摘要\n\n[本会话碰过的文件（截至最近一次压缩）] 改过: a.ts',
    JSON.stringify(glueSummaryLedger('这是摘要', { modified: ['a.ts'], read: [] })));
  check('C5 无清单 → 摘要**逐字不回退**', glueSummaryLedger('这是摘要', undefined) === '这是摘要'
    && glueSummaryLedger('这是摘要', { modified: [], read: [] }) === '这是摘要');
  check('C6 没摘要 → undefined（摘要层整层不出现，清单不单独成层）',
    glueSummaryLedger(undefined, { modified: ['a.ts'], read: [] }) === undefined);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 真件驱动 —— 真存储 + 真压缩服务（测函数 ≠ 测接线）
   ═══════════════════════════════════════════════════════════════════════════════ */

function makeLlm() {
  let calls = 0;
  return {
    calls,
    chat: async () => { calls++; return { content: `第${calls}次摘要` }; },
    stream: () => { throw new Error('不走流式'); },
  } as never as LlmProbe;
}
interface LlmProbe { calls: number; chat: (...a: never[]) => Promise<{ content: string }> }

async function makeStorage(name: string): Promise<JsonlSessionStorage> {
  return JsonlSessionStorage.create(tmpDir, name);
}

console.log('\n── ④ 真件驱动：真存储 + 真压缩服务 ──');
{
  // 20 条消息：前 14 条里 3 条 assistant 带工具调用（write a / read b / write c），后 6 条普通
  const storage = await makeStorage('ledger-basic.jsonl');
  await storage.appendMessage('user', '开始干活');
  await storage.appendMessage('assistant', '我先写文件', {
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: '{"path":"src/a.ts"}' } }] as never,
  });
  await storage.appendMessage('tool', 'ok', { tool_call_id: 'c1' });
  await storage.appendMessage('assistant', '再读一个', {
    tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read', arguments: '{"path":"docs/x.md"}' } }] as never,
  });
  await storage.appendMessage('tool', '内容', { tool_call_id: 'c2' });
  await storage.appendMessage('assistant', '编辑', {
    tool_calls: [{ id: 'c3', type: 'function', function: { name: 'edit', arguments: '{"path":"src/a.ts"}' } }] as never,
  });
  await storage.appendMessage('tool', 'ok', { tool_call_id: 'c3' });
  for (let i = 0; i < 13; i++) await storage.appendMessage('user', `第 ${i} 句`);

  const llm = makeLlm();
  const svc = new CompactionServiceImpl({ llm });
  const r = await svc.compactNow(await storage.getMessages(), storage, { keepRecent: 10 });
  const comp = storage.getCompactions()[0];
  check('D1 压缩入树且带清单字段（真存储真抽取）',
    r.summary !== undefined && comp?.filesModified !== undefined && comp?.filesRead !== undefined
    && comp.filesModified.includes('src/a.ts') && comp.filesRead.includes('docs/x.md'),
    JSON.stringify(comp));
  check('D2 同一路径写+编辑只记一次（去重）', comp?.filesModified?.length === 1,
    JSON.stringify(comp?.filesModified));
  check('D3 CompactionResult 也带回清单（runtime 摘要层要用）',
    r.ledger !== undefined && r.ledger.modified.length === 1 && r.ledger.read.length === 1,
    JSON.stringify(r.ledger));
  check('D4 成文渲染（真数据走 glueSummaryLedger 出全文）',
    (glueSummaryLedger(r.summary, r.ledger) ?? '').includes('docs/x.md'));
}
{
  // 逐层累积：第一次压缩记下 a.ts；再聊带 b.ts 的新消息、第二次压缩 → 清单含 a.ts + b.ts
  const storage = await makeStorage('ledger-accumulate.jsonl');
  await storage.appendMessage('assistant', '写 a', {
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: '{"path":"a.ts"}' } }] as never,
  });
  await storage.appendMessage('tool', 'ok', { tool_call_id: 'c1' });
  for (let i = 0; i < 20; i++) await storage.appendMessage('user', `第一批 ${i}`);
  const llm = makeLlm();
  const svc = new CompactionServiceImpl({ llm });
  await svc.compactNow(await storage.getMessages(), storage, { keepRecent: 5 });
  // 继续聊：新一批带 write b.ts
  await storage.appendMessage('assistant', '写 b', {
    tool_calls: [{ id: 'c2', type: 'function', function: { name: 'write', arguments: '{"path":"b.ts"}' } }] as never,
  });
  await storage.appendMessage('tool', 'ok', { tool_call_id: 'c2' });
  for (let i = 0; i < 20; i++) await storage.appendMessage('user', `第二批 ${i}`);
  await svc.compactNow(await storage.getMessages(), storage, { keepRecent: 5 });
  const comps = storage.getCompactions();
  check('D5 两次压缩两条记录', comps.length === 2, String(comps.length));
  check('D6 第二次压缩的清单**吸收**第一次的（逐层累积，摘要丢细节清单不丢）',
    comps[1]?.filesModified?.includes('a.ts') && comps[1]?.filesModified?.includes('b.ts'),
    JSON.stringify(comps[1]?.filesModified));
  check('D7 新路径排前面（最近优先跨层同样成立）',
    comps[1]?.filesModified?.[0] === 'b.ts', JSON.stringify(comps[1]?.filesModified));
}
{
  // 无工具调用 → 不写字段（不是空数组）
  const storage = await makeStorage('ledger-empty.jsonl');
  for (let i = 0; i < 20; i++) await storage.appendMessage('user', `闲聊 ${i}`);
  const llm = makeLlm();
  const svc = new CompactionServiceImpl({ llm });
  const r = await svc.compactNow(await storage.getMessages(), storage, { keepRecent: 5 });
  const comp = storage.getCompactions()[0];
  check('D8 没抽出任何文件 → entry **不写字段**（缺省，不是空数组）',
    r.summary !== undefined && comp?.filesModified === undefined && comp?.filesRead === undefined,
    JSON.stringify(comp));
  check('D9 结果里也不带 ledger 字段', r.ledger === undefined, JSON.stringify(r.ledger));
}
{
  // 旧文件兼容：把 entry 里的新字段从磁盘上抹掉再重开 —— 读得出、字段缺省、能继续追加
  const dir = path.join(tmpDir, 'legacy');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'legacy.jsonl');
  const header = JSON.stringify({ type: 'session', version: 2, id: 'legacy', createdAt: new Date().toISOString() });
  const compactionLine = JSON.stringify({ type: 'compaction', id: 'c1', parentId: 'm20', summary: '旧摘要', firstKeptId: 'm9', timestamp: 1 });
  const lines = [header];
  for (let i = 1; i <= 20; i++) lines.push(JSON.stringify({ type: 'message', id: `m${i}`, parentId: i === 1 ? null : `m${i - 1}`, role: 'user', content: `旧消息 ${i}`, timestamp: i }));
  lines.push(compactionLine);
  // 真流程形状：压缩入树后 HEAD = compaction 本身（leaf.targetId = c1），
  // getPathToRoot 从 c1 走 parent 链 → c1 → m20 → ... —— 夹具照此构造
  lines.push(JSON.stringify({ type: 'leaf', id: 'l1', parentId: 'c1', targetId: 'c1', timestamp: 2 }));
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
  const storage = await JsonlSessionStorage.open(file);
  const comps = storage.getCompactions();
  check('D10 旧格式 compaction 行照常加载（无新字段 → undefined）',
    comps.length === 1 && comps[0].summary === '旧摘要' && comps[0].filesModified === undefined,
    JSON.stringify(comps[0]));
  const llm = makeLlm();
  const svc = new CompactionServiceImpl({ llm });
  await storage.appendMessage('assistant', '新写的', {
    tool_calls: [{ id: 'c9', type: 'function', function: { name: 'write', arguments: '{"path":"new.ts"}' } }] as never,
  });
  for (let i = 0; i < 25; i++) await storage.appendMessage('user', `新消息 ${i}`);
  await svc.compactNow(await storage.getMessages(), storage, { keepRecent: 5 });
  const comps2 = storage.getCompactions();
  check('D11 旧记录之上继续压缩：清单从**零**累积（旧记录没有清单 ≠ 清单是空的）',
    comps2.length === 2 && comps2[1]?.filesModified?.length === 1 && comps2[1]?.filesModified?.[0] === 'new.ts',
    JSON.stringify(comps2[1]?.filesModified));
}
{
  // maybeCompact 每轮现读：不触发压缩的轮次也把最后一条 compaction 的清单带回
  const storage = await makeStorage('ledger-roundread.jsonl');
  await storage.appendMessage('assistant', '写', {
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: '{"path":"x.ts"}' } }] as never,
  });
  await storage.appendMessage('tool', 'ok', { tool_call_id: 'c1' });
  for (let i = 0; i < 20; i++) await storage.appendMessage('user', `历史 ${i}`);
  const llm = makeLlm();
  const svc = new CompactionServiceImpl({ llm });
  await svc.compactNow(await storage.getMessages(), storage, { keepRecent: 5 });
  const short = (await storage.getMessages()).slice(-3);
  const r = await svc.maybeCompact(short, storage);
  check('D12 不触发压缩的轮次：maybeCompact 仍从最后一条 compaction 现读清单',
    r.summary !== undefined && r.ledger?.modified?.[0] === 'x.ts',
    JSON.stringify(r.ledger));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 源码守护
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑤ 源码守护 ──');
{
  const src = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf-8');
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const ledgerSrc = src('src/context/file-ledger.ts');
  check('E1 判据模块零 import（stripComments 之后一个 import 都没有）',
    !/^import /m.test(strip(ledgerSrc)));
  check('E2 core/compaction-store.ts 零 import（结构子类型，不拉 llm 类型进 core）',
    !/^import /m.test(strip(src('src/core/compaction-store.ts'))));
  // 工具名清单不漂移：枚举里的每个名字都必须还是 builtin.ts 里的真实工具
  const builtinSrc = src('src/tools/builtin.ts');
  const enumOK = [...LEDGER_WRITE_TOOLS, ...LEDGER_READ_TOOLS].every((n) =>
    new RegExp(`name: '${n}'`).test(builtinSrc));
  check('E3 清单枚举里的工具名全部真实存在（改名必回来改枚举）', enumOK,
    [...LEDGER_WRITE_TOOLS, ...LEDGER_READ_TOOLS].join(','));
  const runtimeSrc = strip(src('src/runtime/runtime.ts'));
  check('E4 拼接点唯一：runtime 调 glueSummaryLedger，且不再自己拼 renderLedger',
    runtimeSrc.includes('glueSummaryLedger(') && !runtimeSrc.includes('renderLedger('));
  const holders = ['src/context/compaction.ts', 'src/session/jsonl-storage.ts', 'src/runtime/runtime.ts']
    .map((p) => strip(src(p)).includes('renderLedger') || strip(src(p)).includes('glueSummaryLedger') ? p : '')
    .filter(Boolean);
  check('E5 渲染只从 runtime 一处出口（compaction / storage 层不自己拼文本）',
    holders.length === 1 && holders[0] === 'src/runtime/runtime.ts', holders.join(','));
  check('E6 节头字符串只此一处（全 src/ 只有 file-ledger.ts 写节头文案）',
    ['src/context/compaction.ts', 'src/session/jsonl-storage.ts', 'src/runtime/runtime.ts',
      'src/context/system-prompt.ts'].every((p) => !strip(src(p)).includes('本会话碰过的文件')));
  check('E7 上限是两个不同的封闭常量（改一个不会静默带动另一个）',
    LEDGER_MODIFIED_CAP === 50 && LEDGER_READ_CAP === 30 && LEDGER_MODIFIED_CAP !== LEDGER_READ_CAP);
}

/* ── 清理与汇总 ── */
check('Z1 沙箱隔离：本套只在临时目录里造文件（真仓库一字未动）',
  process.cwd() === sandbox.dir, process.cwd());
console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败（共 ' + (passed + failed) + ' 项）');
process.exit(failed > 0 ? 1 : 0);
