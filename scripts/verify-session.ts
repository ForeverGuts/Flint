/**
 * 会话存储契约验证脚本 —— SessionStorage 双接口收敛后的能力探测等价性。
 *
 * 背景：core/storage.ts 与 types.ts 曾各有一个同名 SessionStorage 接口。
 *       RuntimeOptions.session 声明的是 types.ts 的三方法版，而 entry 树能力
 *       （getAllStored / forkTo / getDir）只写在 core 版的可选成员里，于是
 *       Runtime 拿不到它们，只能靠 `instanceof JsonlSessionStorage` 缩窄到具体类。
 *       收敛后 types.ts 只转发 core 版，Runtime 改为探测可选成员。
 *
 * 核心安全性质：**探测结果必须与 instanceof 完全一致**——否则这次重构改变了行为。
 * 第 ③ 段就是对这条性质的穷举（3 个实现 × 3 个成员）。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-session.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { JsonlSessionStorage } from '../src/session/jsonl-storage.js';
import { InMemorySession } from '../src/session/in-memory.js';
import { MockSession } from '../src/session/mock.js';

/* ── 断言 ── */

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/* ── 替身：Runtime 有 11 个必注入，这里只需要 session 是真的，其余给最小假件 ── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(session: any): any {
  return new Runtime({
    llm: { chat: async () => ({ content: '' }), stream: () => { throw new Error('本脚本不触发 LLM'); } },
    session,
    tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => '', register: () => {} },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {} },
    skills: { load: () => {} },
    events: new PromptEventEmitter(),
    spanCollector: { collect: () => [], running: () => [] },
    commandSystem: { register: () => {}, list: () => [], execute: () => null },
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction: { maybeCompact: async (m: unknown[]) => ({ compacted: false, messages: m }) },
    systemPromptService: { build: async () => ({ messages: [] }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-session-'));

/* ── ① 契约形状：core 版是唯一真身 ── */

console.log('\n① 契约形状（types.ts 不得再自己定义 SessionStorage）');
{
  const typesSrc = fs.readFileSync(path.join(ROOT, 'src/types.ts'), 'utf8');
  check('types.ts 里已无 interface SessionStorage', !/interface\s+SessionStorage/.test(typesSrc));
  check('types.ts 转发 core 版', /export type \{[^}]*SessionStorage[^}]*\} from '\.\/core\/storage\.js'/.test(typesSrc));
  check('RuntimeOptions.session 指向 core/storage.js', /session:\s*import\('\.\/core\/storage\.js'\)\.SessionStorage/.test(typesSrc));
  check('types.ts 里已无死类型 AgentConfig', !/AgentConfig/.test(typesSrc.replace(/AgentConfig（name\/version）已删[^\n]*/, '')));

  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'src/runtime/runtime.ts'), 'utf8');
  check('runtime.ts 里已无 session instanceof 缩窄', !/this\.session\s+instanceof/.test(runtimeSrc));
  check('runtime.ts 仍保留 JsonlSessionStorage 的静态调用（listAll/open/create）',
    /JsonlSessionStorage\.(listAll|open|create)/.test(runtimeSrc));
}

/* ── ② 三个实现的可选成员真值表 ── */

console.log('\n② 可选成员真值表（entry 树能力只有 Jsonl 有）');
const jsonl = await JsonlSessionStorage.create(tmpDir, 'probe.jsonl');
const inMemory = new InMemorySession();
const mock = new MockSession();

for (const m of ['getAllStored', 'forkTo', 'getDir'] as const) {
  check(`JsonlSessionStorage 实现了 ${m}`, typeof jsonl[m] === 'function');
  check(`InMemorySession 没有 ${m}`, typeof (inMemory as never as Record<string, unknown>)[m] === 'undefined');
  check(`MockSession 没有 ${m}`, typeof (mock as never as Record<string, unknown>)[m] === 'undefined');
}

/* ── ③ 核心性质：探测 ≡ instanceof ── */

console.log('\n③ 探测 ≡ instanceof（重构的行为等价性根据）');
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const impls: Array<[string, any]> = [['Jsonl', jsonl], ['InMemory', inMemory], ['Mock', mock]];
  for (const [label, s] of impls) {
    const byInstanceof = s instanceof JsonlSessionStorage;
    for (const m of ['getAllStored', 'forkTo', 'getDir'] as const) {
      check(`${label} 的 ${m}：探测结果与 instanceof 一致`,
        Boolean(s[m]) === byInstanceof,
        `探测=${Boolean(s[m])} instanceof=${byInstanceof}`);
    }
  }
}

/* ── ④ getHistoryMessages 两条分支 ── */

console.log('\n④ Runtime.getHistoryMessages（真实 msgId vs 拼装 msgId）');
await jsonl.appendMessage('user', '第一句');
await jsonl.appendMessage('assistant', '第二句');
{
  const rt = makeRuntime(jsonl);
  const hs = await rt.getHistoryMessages();
  check('Jsonl 分支：条数正确', hs.length === 2, `实得 ${hs.length}`);
  check('Jsonl 分支：msgId 是真实 entry id（不是 m0/m1 拼装）',
    hs.every((h: { msgId: string }) => h.msgId !== '' && !/^m\d+$/.test(h.msgId)),
    JSON.stringify(hs.map((h: { msgId: string }) => h.msgId)));
  check('Jsonl 分支：内容按序', hs[0].content === '第一句' && hs[1].content === '第二句');

  await inMemory.appendMessage('user', '内存第一句');
  const rt2 = makeRuntime(inMemory);
  const hs2 = await rt2.getHistoryMessages();
  check('InMemory 分支：条数正确', hs2.length === 1, `实得 ${hs2.length}`);
  check('InMemory 分支：msgId 走 m{i} 拼装', hs2[0].msgId === 'm0', `实得 ${hs2[0].msgId}`);
  check('InMemory 分支：内容正确', hs2[0].content === '内存第一句');
}

/* ── ⑤ 兜底链：StoredMessage 的 id / msgId 都可选 ── */

console.log('\n⑤ msgId 兜底链（msgId ?? id ?? 空串）');
{
  const onlyId = makeRuntime({
    getAllStored: () => [{ id: 'e1', role: 'user', content: '只有 id' }],
    getMessages: async () => [],
    clear: async () => {},
  });
  const r1 = await onlyId.getHistoryMessages();
  check('只有 id 时用 id 兜底', r1[0].msgId === 'e1', `实得 ${r1[0].msgId}`);

  const neither = makeRuntime({
    getAllStored: () => [{ role: 'user', content: '两个 id 都没有' }],
    getMessages: async () => [],
    clear: async () => {},
  });
  const r2 = await neither.getHistoryMessages();
  check('两个都缺时退化为空串而不是 undefined', r2[0].msgId === '', `实得 ${JSON.stringify(r2[0].msgId)}`);
}

/* ── ⑥ getSessionMsgCount 两条分支 ── */

console.log('\n⑥ Runtime.getSessionMsgCount');
{
  check('Jsonl 分支：计数正确', (await makeRuntime(jsonl).getSessionMsgCount()) === 2);
  check('InMemory 分支：计数正确', (await makeRuntime(inMemory).getSessionMsgCount()) === 1);
  const emptyJsonl = await JsonlSessionStorage.create(tmpDir, 'empty.jsonl');
  check('Jsonl 空会话：0', (await makeRuntime(emptyJsonl).getSessionMsgCount()) === 0);
  check('Mock 空会话：0', (await makeRuntime(new MockSession()).getSessionMsgCount()) === 0);
}

/* ── ⑦ forkSessionAt 两条分支 + fork 的审计性 ── */

console.log('\n⑦ Runtime.forkSessionAt（能力缺失退化为空串；fork 不动原文件）');
{
  check('InMemory：返回空串', (await makeRuntime(inMemory).forkSessionAt('m0')) === '');
  check('Mock：返回空串', (await makeRuntime(mock).forkSessionAt('whatever')) === '');

  const src = await JsonlSessionStorage.create(tmpDir, 'fork-src.jsonl');
  await src.appendMessage('user', 'A');
  await src.appendMessage('assistant', 'B');
  await src.appendMessage('user', 'C');
  const srcPath = src.getFilePath();
  const before = fs.readFileSync(srcPath, 'utf8');
  const ids = src.getAllMsgIds();

  const rt = makeRuntime(src);
  const newName = await rt.forkSessionAt(ids[1]);   // 分叉到第 2 条为止
  check('Jsonl：返回非空文件名', newName !== '', `实得 ${JSON.stringify(newName)}`);
  check('Jsonl：新文件真的落在同一目录', fs.existsSync(path.join(tmpDir, newName)), newName);
  check('Jsonl：原文件一字未动（审计性）', fs.readFileSync(srcPath, 'utf8') === before);

  const after = await rt.getHistoryMessages();
  check('Jsonl：fork 后 runtime 的 session 已换成新分支', after.length === 2, `实得 ${after.length}`);
  check('Jsonl：新分支只含分叉点前缀', after.map((h: { content: string }) => h.content).join(',') === 'A,B',
    JSON.stringify(after.map((h: { content: string }) => h.content)));
  check('Jsonl：原 storage 仍是完整的 3 条', src.getAllStored().length === 3);
}

/* ── ⑧ sessionDir 两条分支（private，经 listSessions 间接验）── */

console.log('\n⑧ sessionDir（Jsonl 走 getDir，其余退回 ./sessions）');
{
  const listed = await makeRuntime(jsonl).listSessions();
  const names = listed.map((s: { fileName: string }) => s.fileName);
  check('Jsonl：列出的是注入 storage 所在目录', names.includes('probe.jsonl'), JSON.stringify(names));
  check('Jsonl：没有串到项目真实的 ./sessions 去', !names.includes('default.jsonl'), JSON.stringify(names));

  const fallback = await makeRuntime(inMemory).listSessions();
  check('InMemory：退回 ./sessions 且不抛错', Array.isArray(fallback));
}

/* ── 收尾 ── */

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
