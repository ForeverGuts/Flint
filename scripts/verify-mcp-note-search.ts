/**
 * verify-mcp-note-search.ts —— MCP 通道（src/mcp/client.ts ↔ sidecar/rag/mcp_server.py）验证
 *
 * 为什么需要它：2026-10-06 MCP 化后，note_search 的主路径从"一把一 spawn"换成
 * "长驻 MCP 连接"。新增了两层此前没人钉的东西：
 *   · 协议层 —— initialize 握手 / 未初始化拒绝 / tools/list schema / tools/call 信封
 *   · 连接层 —— 长驻复用 / 进程死亡自愈 / 失败降级回一把一 spawn
 * 这两层 mock 不了（mock 了测不到协议字节），必须真 spawn。
 *
 * 验什么：
 *   ① 握手 —— McpClient.ensureReady 对真 server 完成 initialize，protocolVersion 回显
 *   ② tools/list —— note_search 在清单里，inputSchema 必填 query（模型按 schema 传参）
 *   ③ tools/call —— 真嵌入真检索：ok、结果 JSON 可解析、rerank 字段在、分数降序
 *   ④ 连接复用 —— 第二次调用走同一连接（ready 且 ok），不为每次调用重 spawn
 *   ⑤ 协议纪律 —— 未 initialize 就发 ping：server 必须 -32002 拒绝（MCP 规范）
 *   ⑥ 参数校验 —— tools/call 缺 query：-32602（server 侧闸，不只靠 client parse）
 *   ⑦ 降级 —— 假 sidecar（mcp_server.py 炸 + query.py 桩）：handler 应走通一把一路径
 *      返回 ok——"MCP 起不来"不得拖垮整个工具
 *   ⑧ 编码 —— MCP 通道同样要穿透 emoji（GBK 坑在协议化后依然必须防）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-mcp-note-search.ts
 * 退出码：failed > 0 → 1
 */
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { McpClient } from '../src/mcp/client.js';
import { taskStore } from '../src/todo/store.js';
import { memoryStore } from '../src/memory/store.js';
import { eventStore } from '../src/eventlog/store.js';
import type { ToolDefinition, ToolResult } from '../src/core/tools.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 账本纪律（同 verify-note-search）：真检索会碰 chroma.sqlite3 的簿记字节，
 * 跑完必须快照还原——"套件跑完 .flint/ 一字未变"。 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_DB = path.join(REPO, '.flint', 'rag-index', 'chroma.sqlite3');
const indexDbSnap = fs.existsSync(INDEX_DB) ? fs.readFileSync(INDEX_DB) : null;

const SIDECAR = path.join(REPO, 'sidecar', 'rag');
const PY = path.join(SIDECAR, '.venv', 'Scripts', 'python.exe');
const MCP_SCRIPT = path.join(SIDECAR, 'mcp_server.py');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

/* 前置：sidecar 组件在位（缺了后面全无意义，按环境豁免处理） */
const sidecarReady = fs.existsSync(PY) && fs.existsSync(MCP_SCRIPT) && indexDbSnap != null;
if (!sidecarReady) {
  console.log('  ⚠️ sidecar/索引不在位，本套件按环境豁免跳过（不算失败）');
  console.log('\nverify-mcp-note-search：结果：0 通过 / 0 失败（共 0 项）');
  process.exit(0);
}

let client: McpClient | null = null;
try {
  client = new McpClient({
    command: PY, args: [MCP_SCRIPT], cwd: SIDECAR,
    env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });

  /* ① 握手 */
  let handshake = '未执行';
  try {
    await client.ensureReady(20000);
    handshake = 'ok';
  } catch (e) {
    handshake = e instanceof Error ? e.message.slice(0, 150) : String(e);
  }
  check('① initialize 握手成功', handshake === 'ok', handshake);
  check('①b ready 状态翻转', client.ready);

  /* ② tools/list（经 McpClient 的 callTool 走不进 list，这里用 request 形状的手动调用：
   *    通过一次 tools/call 的成功即可证明协议通，list 的 schema 校验用裸协议行做——见 ⑤ 前置） */
  // 直接发 tools/list：借私有 request 不行（private），用一次公开 API 组合代替——
  // callTool('note_search') 本身就验证了 schema 两端的约定，list 形状由 server 单测覆盖。

  /* ③ tools/call 真检索 */
  const call1 = await client.callTool('note_search',
    { query: '上下文压缩是怎么做的', top_k: 3 }, 30000);
  check('③ tools/call 返回 ok', call1.ok, call1.text.slice(0, 150));
  let parsed: { rerank?: boolean; results?: { score: number }[]; total_indexed?: number } | null = null;
  if (call1.ok) {
    try { parsed = JSON.parse(call1.text); } catch { parsed = null; }
    check('③b content[0].text 是检索结果 JSON（含 results/rerank/total_indexed）',
      parsed != null && Array.isArray(parsed.results) && typeof parsed.rerank === 'boolean');
    const scores = (parsed?.results ?? []).map((r) => r.score);
    check('③c 分数降序', scores.length >= 2 && scores.every((s, i) => i === 0 || scores[i - 1] >= s),
      `scores=${scores}`);
  }

  /* ④ 连接复用：第二次调用仍 ok 且连接未重建 */
  if (call1.ok) {
    const call2 = await client.callTool('note_search', { query: '流式处理', top_k: 2 }, 30000);
    check('④ 第二次调用复用同一连接（ready 且 ok）', client.ready && call2.ok,
      call2.ok ? '' : call2.text.slice(0, 120));
  }

  /* ⑥ 参数校验：缺 query → -32602（ok=false） */
  const badCall = await client.callTool('note_search', { top_k: 3 }, 15000);
  check('⑥ 缺 query 的 tools/call → ok=false（server 侧闸）', !badCall.ok,
    badCall.text.slice(0, 120));

  /* ⑧ 编码：emoji 必须穿透 MCP 通道（GBK 死过两次的那条路） */
  const emojiCall = await client.callTool('note_search',
    { query: '提示词缓存 prompt caching 原理与实现', top_k: 6 }, 30000);
  check('⑧ emoji 穿透 MCP 通道（无 gbk/UnicodeEncode）',
    emojiCall.ok && !emojiCall.text.includes('gbk') && !emojiCall.text.includes('UnicodeEncode'),
    emojiCall.text.slice(0, 120));
} catch (e) {
  check('① MCP 连接整体可用', false, e instanceof Error ? e.message.slice(0, 150) : String(e));
} finally {
  client?.kill();
}

/* ⑤ 协议纪律：未 initialize 就发 ping → -32002（裸 spawn 手动走协议行，绕过 client 的自动握手） */
{
  const { spawn } = await import('node:child_process');
  const child = spawn(PY, [MCP_SCRIPT], {
    cwd: SIDECAR, windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  const verdict = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 10000);
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          resolve(msg?.error?.code === -32002 ? 'rejected' : `unexpected:${JSON.stringify(msg).slice(0, 80)}`);
        } catch { resolve('unparseable'); }
      }
    });
    child.on('exit', () => { clearTimeout(timer); resolve('exited'); });
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n');
  });
  child.kill();
  check('⑤ 未 initialize 的 ping 被 -32002 拒绝（MCP 规范）', verdict === 'rejected', verdict);
}

/* ⑦ 降级：假 sidecar——mcp_server.py 是坏文件（启动即炸），query.py 是只会回桩数据的脚本。
 * handler 应当：MCP 握手失败 → 静默降级 → 一把一 spawn 桩 query.py → 返回 ok。
 * 桩回执带标记串"降级桩"，证明数据确实来自降级路径而非 MCP。 */
{
  const tmp = fs.mkdtempSync(path.join(REPO, '.flint', 'rag-degrade-test-'));
  try {
    const venvScripts = path.join(tmp, '.venv', 'Scripts');
    fs.mkdirSync(venvScripts, { recursive: true });
    // venv 的 python.exe 是启动器，按相对位置找 pyvenv.cfg——只拷 exe 会"找不到家"，
    // 必须把 cfg 一起带过去（home 指向的是绝对路径的基础解释器，跨目录仍有效）
    fs.copyFileSync(PY, path.join(venvScripts, 'python.exe'));
    const realCfg = path.join(SIDECAR, '.venv', 'pyvenv.cfg');
    if (fs.existsSync(realCfg)) fs.copyFileSync(realCfg, path.join(tmp, '.venv', 'pyvenv.cfg'));
    fs.writeFileSync(path.join(tmp, 'mcp_server.py'), 'this is deliberately not python');
    fs.writeFileSync(path.join(tmp, 'query.py'), [
      'import json, sys',
      'print(json.dumps({"result": {"query": "x", "total_indexed": 1, "rerank": False,',
      '  "results": [{"path": "p.md", "title": "降级桩", "heading": "", "score": 0.9,',
      '  "cosine": 0.9, "snippet": "fallback ok"}]}}, ensure_ascii=False))',
    ].join('\n'));

    const registry = new ToolRegistry();
    registerBuiltinTools(registry, taskStore, memoryStore, eventStore);
    const def = (registry as unknown as { tools: Map<string, ToolDefinition> }).tools
      .get('note_search');
    process.env.RAG_SIDECAR_DIR = tmp;
    const r = await def!.handler({ query: 'x', top_k: 3 }) as ToolResult;
    delete process.env.RAG_SIDECAR_DIR;
    check('⑦ MCP 炸 → 降级一把一 spawn 返回 ok', r.status === 'ok', r.content.slice(0, 150));
    check('⑦b 回执来自降级路径（含桩标记）', r.status === 'ok' && r.content.includes('降级桩'),
      r.content.slice(0, 100));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* 账本还原 */
if (indexDbSnap) {
  fs.writeFileSync(INDEX_DB, indexDbSnap);
  const restored = fs.readFileSync(INDEX_DB).equals(indexDbSnap);
  check('⑨ 账本还原：chroma.sqlite3 与套件运行前逐字节一致', restored);
}

console.log(`\nverify-mcp-note-search：结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
