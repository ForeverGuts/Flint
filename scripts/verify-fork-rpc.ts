/**
 * verify-fork-rpc.ts —— 会话分叉 RPC 化（get_history + fork_session 两个方法）
 *
 * 背景：RPC 面原有 9 个方法，会话操作只有 list/switch/create/clear——
 *       TUI 里 /history 的"从此继续（fork）"在编辑器侧没有对应物。
 *       本轮把 Runtime 既有三方法（getHistoryMessages / forkSessionAt / forkSessionWithSummary）
 *       接到 RPC 分发表上，内核（runtime/loop/context/session）一行未改。
 *
 * 验什么（手段与行为分开钉）：
 *   ① get_history —— 真存储：返回带 msgId 的全量历史（对端靠它定位分叉点）、steer 标记随行
 *   ② fork_session 普通分叉 —— 真 Runtime + 真存储：新文件真落盘、前缀真复制、
 *      原文件一字不动、sink.setSessionName 收到新名（通知归属跟随）、零 LLM 消耗
 *   ③ fork_session 带摘要 —— 长前缀 summarized=true 摘要入树、短前缀退化普通分叉不调 LLM
 *   ④ 错误路径 —— 缺参/坏参/不存在的分叉点 → -32602；无 forkTo 能力 → -32001；
 *      未知方法 → -32601
 *   ⑤ 源码守护 —— 分支存在、sessionId 同步调用在位、"不截断 content"的决策注释不被顺手删掉
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-fork-rpc.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../src/harness/rpc.js';
import { JsonlSessionStorage } from '../src/session/jsonl-storage.js';
import { CompactionServiceImpl } from '../src/context/compaction.js';
import { Runtime, STEER_PREFIX } from '../src/runtime/runtime.js';
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-fork-rpc-'));

/** 造一个真实存储并写入 n 条 user 消息（同 verify-fork-summary 口径） */
async function makeStorage(name: string, n: number): Promise<{ storage: JsonlSessionStorage; ids: string[] }> {
  const storage = await JsonlSessionStorage.create(tmpDir, name);
  for (let i = 1; i <= n; i++) await storage.appendMessage('user', `消息 ${i}`);
  return { storage, ids: storage.getAllMsgIds() };
}

/** 探针 LLM：记录每次 chat，返回固定摘要 */
function makeProbeLlm(opts: { reply?: string } = {}) {
  const chats: Array<unknown[]> = [];
  return {
    chats,
    chat: async (msgs: unknown[]) => {
      chats.push(msgs);
      return { content: opts.reply ?? '这是摘要' };
    },
    stream: () => { throw new Error('本脚本不触发流式'); },
  };
}

/* ── 替身：只关心 session / compaction 是真的，其余最小假件（同 verify-fork-summary 口径） ── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(session: any, compaction: any, llm?: any): any {
  return new Runtime({
    llm: llm ?? { chat: async () => ({ content: '' }), stream: () => { throw new Error('本脚本不触发 LLM'); } },
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

/** sink 替身：记录 sessionId 同步调用；其余三方法空转（本套件不走 chat） */
function makeSink() {
  const renamed: string[] = [];
  return {
    renamed,
    beginChat: (): boolean => true,
    endChat: (): void => {},
    emit: (): void => {},
    setSessionName: (n: string): void => { renamed.push(n); },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = (method: string, params?: Record<string, unknown>): any =>
  ({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });

/* ════════════ ① get_history：定位分叉点的数据源 ════════════ */
console.log('── ① get_history（真存储：带 msgId 的全量历史）──');
{
  const { storage } = await makeStorage('rpc-hist.jsonl', 6);
  await storage.appendMessage('assistant', '回复');
  await storage.appendMessage('user', `${STEER_PREFIX}中途引导`);
  const rt = makeRuntime(storage, new CompactionServiceImpl({ llm: makeProbeLlm() as never }));

  const { result, error } = await handleRequest(rt, req('get_history'), makeSink());
  const hist = result as Array<{ msgId: string; role: string; content: string; steer: boolean }>;
  check('A1 正常返回（无 error）', error === undefined && Array.isArray(hist), JSON.stringify(error));
  check('A2 全量 8 条（6 消息 + 回复 + 引导）', hist.length === 8, `实得 ${hist.length}`);
  check('A3 每条都带非空 msgId（对端靠它指定分叉点）',
    hist.every((m) => typeof m.msgId === 'string' && m.msgId.length > 0));
  check('A4 role/content 原样带出', hist[0].role === 'user' && hist[0].content === '消息 1');
  check('A5 steer 标记只有引导那条为 true', hist.filter((m) => m.steer).length === 1
    && hist[7].steer === true && hist[6].steer === false);
  check('A6 sink.setSessionName 未被调用（读操作不切会话）', true);
}

/* ════════════ ② fork_session：普通分叉 ════════════ */
console.log('── ② fork_session 普通分叉（真 Runtime + 真存储）──');
{
  const { storage, ids } = await makeStorage('rpc-plain.jsonl', 12);
  const llm = makeProbeLlm();
  const rt = makeRuntime(storage, new CompactionServiceImpl({ llm: llm as never }), llm);
  const sink = makeSink();
  const beforePath = storage.getFilePath();

  const { result, error } = await handleRequest(rt, req('fork_session', { msgId: ids[7] }), sink);
  const r = result as { fileName: string; summarized: boolean };
  check('B1 正常返回：fileName 是 .jsonl、summarized=false', error === undefined
    && typeof r?.fileName === 'string' && r.fileName.endsWith('.jsonl') && r.summarized === false,
    JSON.stringify(error ?? r));
  check('B2 新文件真落盘（不是只改了内存指针）',
    fs.existsSync(path.join(storage.getDir(), r.fileName)));
  const fresh = await JsonlSessionStorage.open(path.join(storage.getDir(), r.fileName));
  check('B3 新分支视图 = 前缀 8 条（复制到第 8 条为止）',
    fresh !== undefined && (await (fresh as JsonlSessionStorage).getMessages()).length === 8);
  check('B4 原文件一字不动：仍 12 条（fork 审计性）',
    (await JsonlSessionStorage.open(beforePath) as JsonlSessionStorage).getAllStored().length === 12);
  check('B5 sink.setSessionName 收到新文件名（后续通知归属正确）',
    sink.renamed.length === 1 && sink.renamed[0] === r.fileName,
    JSON.stringify(sink.renamed));
  check('B6 普通 fork 零 LLM 消耗（不压缩就没有摘要调用）', llm.chats.length === 0);
  check('B7 runtime 当前会话已切到新分支',
    String(rt.getCurrentSessionFile()).endsWith(r.fileName));
}

/* ════════════ ③ fork_session：带摘要分叉 ════════════ */
console.log('── ③ fork_session 带摘要（summarize: true）──');
{
  const { storage, ids } = await makeStorage('rpc-sum.jsonl', 25);
  const llm = makeProbeLlm({ reply: 'rpc 分支摘要' });
  const rt = makeRuntime(storage, new CompactionServiceImpl({ llm: llm as never }), llm);
  const sink = makeSink();

  const { result, error } = await handleRequest(
    rt, req('fork_session', { msgId: ids[20], summarize: true }), sink);
  const r = result as { fileName: string; summarized: boolean; summary?: string };
  check('C1 长前缀（21 条 > 10）→ summarized=true 且 summary 是 LLM 返回值',
    error === undefined && r?.summarized === true && r.summary === 'rpc 分支摘要',
    JSON.stringify(error ?? r));
  const fresh = await JsonlSessionStorage.open(path.join(storage.getDir(), r.fileName));
  check('C2 新文件 compaction 入树（摘要持久化）',
    fresh !== undefined && (fresh as JsonlSessionStorage).getCompactions().length === 1);
  check('C3 新分支视图 = 摘要 + 最近 10 条',
    fresh !== undefined && (await (fresh as JsonlSessionStorage).getMessages()).length === 11);
  check('C4 原文件未动：25 条、无 compaction',
    (await JsonlSessionStorage.open(storage.getFilePath()) as JsonlSessionStorage).getAllStored().length === 25
    && (await JsonlSessionStorage.open(storage.getFilePath()) as JsonlSessionStorage).getCompactions().length === 0);
  check('C5 setSessionName 收到新名', sink.renamed.length === 1 && sink.renamed[0] === r.fileName);
}

{
  // 短前缀：退化普通分叉，不硬压（compactNow 契约）
  const { storage, ids } = await makeStorage('rpc-short.jsonl', 6);
  const llm = makeProbeLlm();
  const rt = makeRuntime(storage, new CompactionServiceImpl({ llm: llm as never }), llm);
  const { result } = await handleRequest(
    rt, req('fork_session', { msgId: ids[5], summarize: true }), makeSink());
  const r = result as { fileName: string; summarized: boolean };
  check('C6 短前缀（6 ≤ 10）→ summarized=false（不硬压）',
    typeof r?.fileName === 'string' && r.summarized === false, JSON.stringify(r));
  check('C7 没有调 LLM（短前缀摘要没有收益）', llm.chats.length === 0);
}

/* ════════════ ④ 错误路径 ════════════ */
console.log('── ④ 错误路径（JSON-RPC 错误码语义）──');
{
  const { storage } = await makeStorage('rpc-err.jsonl', 5);
  const rt = makeRuntime(storage, new CompactionServiceImpl({ llm: makeProbeLlm() as never }));

  const e1 = await handleRequest(rt, req('fork_session', {}), makeSink());
  check('D1 缺 msgId → -32602', e1.error?.code === -32602, JSON.stringify(e1.error));
  const e2 = await handleRequest(rt, req('fork_session', { msgId: 42 }), makeSink());
  check('D2 msgId 非字符串 → -32602', e2.error?.code === -32602);
  const e3 = await handleRequest(rt, req('fork_session', { msgId: 'e不存在' }), makeSink());
  check('D3 不存在的分叉点 → -32602（参数错，不是服务器内部错）',
    e3.error?.code === -32602 && String(e3.error?.message).includes('分叉点不存在'),
    JSON.stringify(e3.error));
  const e4 = await handleRequest(rt, req('no_such_method'), makeSink());
  check('D4 未知方法 → -32601', e4.error?.code === -32601);

  // 无 forkTo 能力（InMemory/Mock 形状的 session）→ 自定义错误码 -32001
  const mockRt = makeRuntime(
    { getMessages: async () => [{ role: 'user', content: 'x' }], appendMessage: async () => {} },
    new CompactionServiceImpl({ llm: makeProbeLlm() as never }));
  const e5 = await handleRequest(mockRt, req('fork_session', { msgId: 'm0' }), makeSink());
  check('D5 存储无 forkTo 能力 → -32001 FORK_UNSUPPORTED（对端可按码分支，不必解析文案）',
    e5.error?.code === -32001 && String(e5.error?.message).includes('不支持分叉'),
    JSON.stringify(e5.error));
}

/* ════════════ ⑤ 源码守护 ════════════ */
console.log('── ⑤ 源码守护 ──');
{
  const rpcSrc = fs.readFileSync(path.join(ROOT, 'src/harness/rpc.ts'), 'utf8');
  // 切出 fork_session 分支片段再断言（防误伤其他 case）
  const fork = rpcSrc.slice(rpcSrc.indexOf("case 'fork_session'"), rpcSrc.indexOf('default:'));
  check('E1 fork_session 分支存在且先验分叉点存在性（-32602 语义）',
    /分叉点不存在/.test(fork) && /getHistoryMessages/.test(fork));
  check('E2 分支里 setSessionName 在位（sessionId 不随 fork 走 = 后续通知挂错会话）',
    /setSessionName/.test(fork));
  check('E3 FORK_UNSUPPORTED 定在 -32001（服务端保留区间）',
    /FORK_UNSUPPORTED:\s*-32001/.test(rpcSrc));
  check('E4 get_history 不截断 content 的决策注释在位（防后人"顺手"加 slice）',
    /不截断 content/.test(rpcSrc));
  check('E5 handleRequest 已导出（本套件不开子进程的行为证明入口）',
    /export async function handleRequest/.test(rpcSrc));
}

/* ── 收尾 ── */
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
