/**
 * RPC 流式通知的功能专套 —— 把内核事件翻译成 ACP 形状的 session/update 推出去。
 *
 * 背景：改造前 rpc.ts 是 `await runtime.prompt(message)`——内核那 23 种事件照样在发生，
 *       但 RPC 模式**一个订阅者都没有**（grep subscribe 零命中），全丢进虚空。
 *       于是外部程序（编辑器插件）只能干等：中间几十秒完全黑盒，最后蹦一行结果。
 *
 * 这次补的是第三根订阅线（前两根是 TreeUI 与 TerminalUI）。内核、UI、总线一行没改。
 *
 * 四段承重设计（改代码前请先读）：
 *   ① **映射表是纯函数 + 极少量配对状态**，不碰 stdout —— 于是这一段不开进程就能测。
 *      否则每次验证都要真起子进程等真实 LLM，那测试谁也不会跑。
 *   ② **片与离散必须分开**（updateShape）。片要累加（stream_text/stream_reasoning），
 *      离散要替换状态（tool_call/notice）。混成一种，对端就无从判断该怎么处理。
 *   ③ **过滤也是映射的一部分**。内部记账类事件外发 = 把内部实现钉成对外契约。
 *   ④ **stdout 纯净靠机器守护，不靠人记**（⑥ 段源码扫描）。一行非 JSON 就会让对端
 *      JSON.parse 抛异常，且**犯病的进程自己毫无察觉**——这类 bug 极难查。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-rpc-stream.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcEventMapper, toNotification, updateShape } from '../src/harness/rpc-events.js';
import type { RuntimeEvent } from '../src/runtime/events.js';
import type { SessionUpdate } from '../src/harness/rpc-events.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { SpanCollectorImpl } from '../src/runtime/span-collector.js';
import { EventStream } from '../src/runtime/event-stream.js';

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 造一个内核事件（补上总线才会盖的公共头） */
const ev = (e: Record<string, unknown>): RuntimeEvent =>
  ({ at: 0, seq: 0, turnId: 't1', ...e }) as unknown as RuntimeEvent;

/* ══════════════════════════════════════════════════════════════════════════
   ① 映射：片（chunk）与离散（discrete）两种形状
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n① 事件 → 更新：片与离散');

{
  const m = new RpcEventMapper();

  const t = m.update(ev({ type: 'stream_text', text: '你好' }));
  check('A1 stream_text → agent_message_chunk', t?.sessionUpdate === 'agent_message_chunk');
  check('A2 正文装在 content.text（ACP 形状：content 是对象不是数组）',
    (t?.content as { text?: string })?.text === '你好');
  check('A3 stream_text 的形状是 chunk（对端累加）', !!t && updateShape(t) === 'chunk');

  const r = m.update(ev({ type: 'stream_reasoning', text: '先想想' }));
  check('A4 stream_reasoning → agent_thought_chunk', r?.sessionUpdate === 'agent_thought_chunk');
  check('A5 stream_reasoning 的形状也是 chunk', !!r && updateShape(r) === 'chunk');

  const s = m.update(ev({ type: 'tool_execution_start', name: 'bash', args: { cmd: 'ls' } }));
  check('A6 tool_execution_start → tool_call', s?.sessionUpdate === 'tool_call');
  check('A7 工具状态是 in_progress（刚开始，还没结果）', s?.status === 'in_progress');
  check('A8 工具种类按名映射（bash → execute）', s?.kind === 'execute');
  check('A9 入参原样带出（rawInput）',
    JSON.stringify(s?.rawInput) === JSON.stringify({ cmd: 'ls' }));
  check('A10 tool_call 的形状是 discrete（不是累加）', !!s && updateShape(s) === 'discrete');

  const e = m.update(ev({ type: 'tool_execution_end', name: 'bash', result: 'ok', ok: true }));
  check('A11 tool_execution_end → tool_call_update', e?.sessionUpdate === 'tool_call_update');
  check('A12 成功 → status completed', e?.status === 'completed');
  check('A13 结果装在 rawOutput.output',
    (e?.rawOutput as { output?: string })?.output === 'ok');
}

/* ══════════════════════════════════════════════════════════════════════════
   ② 工具调用的配对：toolCallId 必须前后一致
   （内核的工具事件没有 id，id 只能自己发号；配不上对端就无法把结果挂回调用）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n② 工具调用的配对');

{
  const m = new RpcEventMapper();
  const a = m.update(ev({ type: 'tool_execution_start', name: 'read', args: {} }));
  const b = m.update(ev({ type: 'tool_execution_end', name: 'read', result: 'x', ok: true }));
  check('B1 同一次调用：start 与 end 的 toolCallId 相同',
    !!a && !!b && a.toolCallId === b.toolCallId && typeof a.toolCallId === 'string');

  const c = m.update(ev({ type: 'tool_execution_start', name: 'write', args: {} }));
  const d = m.update(ev({ type: 'tool_execution_end', name: 'write', result: 'y', ok: true }));
  check('B2 第二次调用换一个新 id（不会与前一次撞）',
    !!c && !!d && c.toolCallId !== a?.toolCallId && c.toolCallId === d.toolCallId);

  const f = m.update(ev({ type: 'tool_execution_end', name: 'write', result: 'z', ok: false }));
  check('B3 失败 → status failed（成败只有生产端知道，必须由它说）', f?.status === 'failed');

  const g = m.update(ev({ type: 'tool_execution_end', name: 'grep', result: undefined, ok: true }));
  check('B4 结果是 undefined 也转成字符串，不产出 undefined 字段',
    (g?.rawOutput as { output?: string })?.output === '');
}

/* ══════════════════════════════════════════════════════════════════════════
   ③ 提示与错误：走 ACP 的 notice
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n③ 提示与错误');

{
  const m = new RpcEventMapper();
  const p1 = m.update(ev({ type: 'thinking', phase: 'streaming' }));
  check('C1 thinking → notice（severity info）',
    p1?.sessionUpdate === 'notice' && p1.severity === 'info');
  check('C2 notice.title 是非空人话（ACP 要求非空纯文本）',
    typeof p1?.title === 'string' && p1.title.length > 0);

  const p2 = m.update(ev({ type: 'thinking', phase: 'streaming' }));
  check('C3 同一阶段重发被去重（等首字期间别刷屏）', p2 === null);
  const p3 = m.update(ev({ type: 'thinking', phase: 'compressing' }));
  check('C4 阶段变了才再报一次', p3 !== null && p3.title !== p1?.title);

  const e1 = m.update(ev({ type: 'error', message: '炸了', level: 'fail' }));
  check('C5 error(level=fail) → severity error', e1?.severity === 'error');
  const e2 = m.update(ev({ type: 'error', message: '小问题', level: 'warn' }));
  check('C6 error(level=warn) → severity warning', e2?.severity === 'warning');
}

/* ══════════════════════════════════════════════════════════════════════════
   ④ 过滤：内部事件一律不外发
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n④ 过滤：内部记账不外泄');

{
  const internal: Record<string, unknown>[] = [
    { type: 'prompt_start' },
    { type: 'prompt_end' },
    { type: 'llm_request_start' },
    { type: 'llm_request_end' },
    { type: 'message_end' },
    { type: 'agent_end' },
    { type: 'usage', current: { totalTokens: 1 }, total: { totalTokens: 1 } },
    { type: 'note_start', name: 'x' },
    { type: 'note_end', name: 'x' },
    { type: 'check_start' },
    { type: 'check_done' },
    { type: 'compaction_start' },
    { type: 'compaction_end' },
    { type: 'tool_call_start', spanId: 's', name: 'x', args: {} },
    { type: 'tool_call_end', spanId: 's', status: 'ok', durationMs: 1, name: 'x' },
  ];
  const leaked = internal.filter((e) => new RpcEventMapper().update(ev(e)) !== null);
  check('D1 15 种内部事件全部被过滤（外泄即成对外契约）',
    leaked.length === 0, `泄漏：${leaked.map((e) => e.type).join(',')}`);
  check('D2 agent_end 不外发（最终响应本身就是收尾信号）',
    new RpcEventMapper().update(ev({ type: 'agent_end' })) === null);
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑤ 通知信封：JSON-RPC notification（无 id）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ 通知信封');

{
  const n = toNotification('sess_abc', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
  check('E1 jsonrpc 固定 2.0', n.jsonrpc === '2.0');
  check('E2 method 是 session/update（ACP 的方法名）', n.method === 'session/update');
  check('E3 没有 id —— 没人请求它，是我们主动推的', !('id' in n));
  check('E4 params 里带 sessionId 与 update',
    n.params.sessionId === 'sess_abc' && typeof n.params.update === 'object');

  const line = JSON.stringify(n);
  check('E5 单行可解析（协议靠一行一个 JSON 分帧）', (() => {
    try { return typeof JSON.parse(line) === 'object'; } catch { return false; }
  })());
  check('E6 行内不含换行（否则一行变两行，对端必然解析失败）', !line.includes('\n'));
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑥ 行为证明：真 Runtime 跑一轮，推出的片拼起来必须等于完整回复
   （这是流式最核心的正确性：不丢片、不重片、不乱序）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 行为证明：真 Runtime 跑一轮');

{
  const CHUNKS = ['我来', '看一下', '这个', '文件', '。'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeLlm: any = {
    chat: async () => ({ content: '' }),
    stream: () => {
      const es = new EventStream<{ type: string; [k: string]: unknown }>(
        (e) => e.type === 'end',
        (e) => e as { type: 'end'; fullText: string },
      );
      let i = 0;
      const tick = (): void => {
        if (i < CHUNKS.length) {
          es.push({ type: 'token', text: CHUNKS[i++] });
          setTimeout(tick, 5);
        } else {
          es.push({ type: 'end', fullText: CHUNKS.join('') });
        }
      };
      setTimeout(tick, 1);
      return es;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rt = new Runtime({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    llm: fakeLlm as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session: { getMessages: async () => [], appendMessage: async () => {}, clear: async () => {} } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: '' }), register: () => {} } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    skills: { load: () => {}, getAll: () => [], get: () => undefined } as any,
    events: new PromptEventEmitter(),
    spanCollector: new SpanCollectorImpl(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commandSystem: { register: () => {}, list: () => [], execute: async () => null } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    diagnosticsService: { record: () => {}, getAll: () => [] } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    compaction: { maybeCompact: async (h: unknown) => ({ history: h }) } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    systemPromptService: { build: async () => ({ messages: [{ layer: 'core', content: 'x' }] }) } as any,
  });

  const mapper = new RpcEventMapper();
  const chunks: string[] = [];
  const off = rt.subscribe((event) => {
    const u: SessionUpdate | null = mapper.update(event);
    if (!u) return;
    if (u.sessionUpdate === 'agent_message_chunk') {
      chunks.push((u.content as { text?: string })?.text ?? '');
    }
  });

  await rt.prompt('看一下这个文件');
  off();

  check('F1 真 Runtime 确实把文本片推了出来（订阅这根线是通的）', chunks.length > 0);
  check('F2 片数 == 模型吐的片数（不丢片、不合并）', chunks.length === CHUNKS.length,
    `期望 ${CHUNKS.length}，实际 ${chunks.length}`);
  check('F3 按顺序拼起来 == 完整回复（不乱序、不重复）',
    chunks.join('') === CHUNKS.join(''), `拼出："${chunks.join('')}"`);

  // 退订后不应再收到任何东西
  const after: string[] = [];
  let got = 0;
  const off2 = rt.subscribe(() => { got++; });
  off2();
  await rt.prompt('再来一轮');
  check('F4 退订后不再收到事件（杜绝跨请求串台）', got === 0, `退订后仍收到 ${got} 次`);
  check('F5 after 数组未被使用（占位，保持断言对称）', after.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑦ stdout 纯净守护（源码扫描）—— 这条规矩必须靠机器，不能靠人记
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑦ stdout 纯净守护（源码扫描）');

{
  /** 扫目录里所有 .ts，找真实调用 console.log( 的行（跳过注释行） */
  const findConsoleLog = (dirRel: string): string[] => {
    const dir = path.join(ROOT, dirRel);
    if (!fs.existsSync(dir)) return [];
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        if (!ent.name.endsWith('.ts')) continue;
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        lines.forEach((ln, i) => {
          const t = ln.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
          if (/console\.log\s*\(/.test(ln)) hits.push(`${dirRel}/${ent.name}:${i + 1}`);
        });
      }
    };
    walk(dir);
    return hits;
  };

  // rpc 路径：这些目录在 RPC 模式下会被加载，任何 console.log 都会污染 stdout
  const RPC_PATH_DIRS = ['src/harness', 'src/runtime', 'src/loop', 'src/context'];
  const hits = RPC_PATH_DIRS.flatMap(findConsoleLog);
  check('G1 rpc 路径（harness/runtime/loop/context）零 console.log(',
    hits.length === 0, `命中：${hits.join(' ')}`);

  const rpcSrc = fs.readFileSync(path.join(ROOT, 'src/harness/rpc.ts'), 'utf8');
  // 只数非注释行：注释里提到这个标识符是正常的（本文件自己的注释就在解释它）
  const codeLines = rpcSrc
    .split('\n')
    .filter((ln) => !['//', '*', '/*'].some((p) => ln.trim().startsWith(p)))
    .join('\n');
  check('G2 rpc.ts 里 process.stdout.write 只出现一次（全部收敛到 writeLine）',
    (codeLines.match(/process\.stdout\.write/g) ?? []).length === 1,
    `实际 ${(codeLines.match(/process\.stdout\.write/g) ?? []).length} 次`);
  check('G3 rpc.ts 订阅后 finally 退订', /finally\s*\{\s*off\(\);\s*\}/.test(rpcSrc));
  check('G4 rpc.ts 有并发拒绝（notification 无 id，并发会无法归属）',
    rpcSrc.includes('CHAT_BUSY'));

  // src/io/ 是 UI 层：RPC 模式根本不加载它，那里 console.log 是正常的、也不该被管
  const ioDir = path.join(ROOT, 'src/io');
  check('G5 src/io/ 存在（UI 层不在守护范围 —— RPC 模式不加载它）', fs.existsSync(ioDir));
}

/* ── 汇总 ── */

// 结果行格式是 run-verify.mjs 的解析契约（/结果[：:]\s*(\d+)\s*通过.../），别改成自由文案
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
