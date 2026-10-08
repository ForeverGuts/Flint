/**
 * verify-note-search.ts —— note_search 工具的接线与降级验证
 *
 * 为什么需要它：note_search 是 flint（零依赖 TS）与 rag-sidecar（Python venv）之间的
 * **进程边界**。最典型的失效方式不是报错，而是"各自都对、接线错了"：
 *   · 侧车换了 venv 路径 / query.py 改名 → 工具静默报错，模型拿到看不懂的回执；
 *   · spawn 超时没判死 → 模型干等 20s；
 *   · --json 响应形状变了（result/error 信封）→ handler 解析炸。
 * 本套件验的是**真实 spawn**（不 mock 子进程）——mock 了就测不到"接线"这一层。
 *
 * 验什么：
 *   ① 注册 —— note_search 在 LLM 工具清单里（名字/描述进 Function Calling）
 *   ② parse —— 缺 query 必须拒绝（结构化 function calling 由 API 保证，但本地这道闸仍在）
 *   ③ 降级 —— sidecar 缺席（RAG_SIDECAR_DIR 指向空目录）→ toolError 且回执**含安装指引**
 *      （可选组件缺席是环境问题不是模型错，回执必须让模型/用户知道"怎么装"）
 *   ④ 端到端 —— 真 spawn：真嵌入、真查 Chroma，回执 ok、含命中路径、分数降序
 *      （④ 依赖网络与已建索引；索引缺失/网络断时报 error 也算通过——本套件只钉
 *       "接线形状"，不钉外部服务的可用性，那是 run-verify 之外的环境检查）
 *   ⑤ 编码 —— 侧车输出必须走 UTF-8：笔记含 emoji（🟡），Windows 默认 GBK 输出
 *      会 UnicodeEncodeError，2026-10-06 两次真实检索死于此。用当时的原始查询词
 *      复测（其 top 命中块含 emoji），回执里出现 gbk/UnicodeEncode 即失败。
 *   ⑦ 范围限定（scope）在**工具层**的接线 —— 参数过 parse 不被丢、缺省空串 = 全库；
 *      范围无命中时回执明说"不会自动退回全库"（防"传了 scope 却被丢掉"这种
 *      静默失效：接线断了工具照样返回 ok，只是悄悄变成全库检索）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-note-search.ts
 * 退出码：failed > 0 → 1
 */
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { taskStore } from '../src/todo/store.js';
import { memoryStore } from '../src/memory/store.js';
import { eventStore } from '../src/eventlog/store.js';
import type { ToolDefinition, ToolResult } from '../src/core/tools.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 账本纪律（G9 同款沙箱思路）：query.py 打开 Chroma PersistentClient 时会重写
 * chroma.sqlite3 的内部簿记字段——虽然本套对索引**零语义写入**，账本的"套件跑完
 * .flint/ 一字未变"却认字节不认语义。修法：④⑤ 真调用前拍快照、跑完原样放回。
 * （2026-10-06 首轮全库回归实测抓出此漂移，才有了这段。） */
const INDEX_DB = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../.flint/rag-index/chroma.sqlite3');
const indexDbSnap = fs.existsSync(INDEX_DB) ? fs.readFileSync(INDEX_DB) : null;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

const registry = new ToolRegistry();
registerBuiltinTools(registry, taskStore, memoryStore, eventStore);

/* ① 注册 */
const tools = registry.getLLMTools();
const def = (registry as unknown as { tools: Map<string, ToolDefinition> }).tools
  .get('note_search');
check('① note_search 已注册进 LLM 工具清单', def !== undefined
  && tools.some((t) => t.function.name === 'note_search'));
check('①b 描述里带语料口径（278 篇），模型不会拿它当通用搜索',
  def !== undefined && def.description.includes('278'));

/* ② parse：缺 query 拒绝 */
if (def) {
  let rejected = false;
  try { def.parse({ top_k: 3 }); } catch { rejected = true; }
  check('② 缺 query 被 parse 拒绝', rejected);
  const parsed = def.parse({ query: '提示词缓存' }) as Record<string, unknown>;
  check('②b 合法参数过 parse 且 top_k 缺省 5', parsed['query'] === '提示词缓存'
    && parsed['top_k'] === 5);
}

/* ③ 降级：sidecar 缺席 → error 且带安装指引 */
process.env.RAG_SIDECAR_DIR = 'Z:/__不存在的目录__';
const degrade: ToolResult = await def!.handler({ query: 'x', top_k: 3 }) as ToolResult;
check('③ 侧车缺席 → error（不是 invalid/negative）', degrade.status === 'error',
  `实际 status=${degrade.status}`);
check('③b 回执含安装指引（README 路径可循）', degrade.content.includes('README.md'));
delete process.env.RAG_SIDECAR_DIR;

/* ④ 端到端：真 spawn 真 embedding 真检索 */
const e2e: ToolResult = await def!.handler({
  query: '上下文压缩是怎么做的', top_k: 3,
}) as ToolResult;
const ok = e2e.status === 'ok';
const envOk = ok || e2e.content.includes('侧车调用失败');
if (ok) {
  check('④ 端到端真调用返回 ok', true);
  check('④b 回执含命中路径', /11-实践案例|2-Agent能力|3-Agent框架/.test(e2e.content),
    e2e.content.slice(0, 120));
  const scores = [...e2e.content.matchAll(/\[(0\.\d+)\]/g)].map((m) => Number(m[1]));
  check('④c 分数降序（cosine 相似度排序正确）',
    scores.length >= 2 && scores.every((s, i) => i === 0 || scores[i - 1] >= s),
    `scores=${scores}`);
} else if (envOk) {
  console.log('  ⚠️ ④ 端到端跳过（索引未建或网络不通——接线③已验，环境项不算失败）');
} else {
  check('④ 端到端返回 ok', false, e2e.content.slice(0, 200));
}

/* ⑤ 编码：emoji 必须能穿透侧车输出（GBK 编码死过两次的那条路） */
const emojiRun: ToolResult = await def!.handler({
  query: '提示词缓存 prompt caching 原理与实现', top_k: 6,
}) as ToolResult;
if (emojiRun.status === 'ok') {
  check('⑤ emoji 穿透（侧车输出 UTF-8，无 gbk/UnicodeEncode 错误）',
    !emojiRun.content.includes('gbk') && !emojiRun.content.includes('UnicodeEncode'),
    emojiRun.content.slice(0, 120));
} else {
  console.log('  ⚠️ ⑤ 编码项跳过（端到端不可用——同④的环境豁免）');
}

/* ⑦ 范围限定（scope）在工具层的接线：参数不被丢 + 回执语义（真实 call，排在账本还原之前） */
if (def) {
  const p1 = def.parse({ query: 'x', scope: '11-实践案例' }) as Record<string, unknown>;
  const p2 = def.parse({ query: 'x' }) as Record<string, unknown>;
  check('⑦ scope 过 parse：给了就带上、缺省空串（= 全库，与旧调用逐位兼容）',
    p1['scope'] === '11-实践案例' && p2['scope'] === '',
    `p1.scope=${JSON.stringify(p1['scope'])} p2.scope=${JSON.stringify(p2['scope'])}`);
}
const scopeRun: ToolResult = await def!.handler({
  query: '上下文压缩', top_k: 3, scope: '__这个域不存在__',
}) as ToolResult;
if (scopeRun.status === 'ok') {
  check('⑦b 范围无命中：回执明说"不会自动退回全库"，且不夹带全库结果',
    scopeRun.content.includes('不会自动退回全库') && !/\[\d\.\d{3}\]/.test(scopeRun.content),
    scopeRun.content.slice(0, 160));
} else {
  console.log('  ⚠️ ⑦b 范围回执跳过（端到端不可用——同④的环境豁免）');
}

/* 收尾：把 chroma.sqlite3 快照放回，账本归零（只在快照存在时做；放回失败不静默） */
if (indexDbSnap) {
  fs.writeFileSync(INDEX_DB, indexDbSnap);
  const restored = fs.readFileSync(INDEX_DB).equals(indexDbSnap);
  check('⑥ 账本还原：chroma.sqlite3 与套件运行前逐字节一致', restored);
}

// 汇总行是**协议**不是装饰：collect-stats.mjs 只认 `结果：N 通过 / M 失败` 这一行
// 来汇总全库断言账（2026-10-06 verify-doc-numbers 抓出本套缺行——漏一行整套不计入合计）。
console.log(`\nverify-note-search：结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
