/**
 * 内层引导（steering）验证脚本 —— 脚本化假 LLM，不消耗真实 API。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-steering.ts
 *
 * 背景（改造前）：steerQueue 只有两个出队点，都在 Runtime 外层 while(true) 里
 * （prompt 顶部、runSingleTurn 返回之后），而 AgentLoop 的 for 循环**一处队列检查都没有**。
 * 于是"用户在工具执行期间插入的指示"必须等整轮工具循环全部跑完才被读到 ——
 * 它和 followUp 的实质差别只剩优先级，不是吸收时机。
 *
 * 本次把消费点下沉到内层：工具执行完、下一次 llm.stream() 之前取件，
 * 追加进**最后一条 tool 结果**的 content（不新开 user 消息：tool 结果在 anthropic.ts
 * 里已转成 user 角色，再插一条就是连续两条 user → 400）。
 *
 * 覆盖：
 *   S0 契约：takeSteer 必须是**可选**成员（加必需成员会打坏 9 处 ToolProvider/选项替身）
 *   S1 内层吸收：引导当轮可见（第 N+1 次 LLM 请求里就能看到），且落在 tool 消息上
 *   S2 逐条消费：两条引导分别落进两条不同的 tool 结果，不堆叠、顺序正确
 *   S3 无工具调用 → 不取件（没有注入落点，留给外层循环当新回合，不吞消息）
 *   S4 最后一轮 → 不取件（取走会无人消费 = 把用户的话吞掉）
 *   S5 向后兼容：不传 takeSteer / 回调恒返回 null → 行为与改造前完全一致
 *   S6 端到端（真 Runtime）：prompt(text,'steer') 入队 → 下一轮 LLM 请求里出现 [用户引导]
 *   S7 端到端兜底：本轮无工具调用 → 引导退回外层循环，成为一条**真正的 user 消息**
 *   S8 落盘：被内层吸收的引导落成独立 user 条目，位置在本轮 assistant **之前**，内容带标记
 *   S9 适配器归并：会话历史里的 user,user,assistant → Anthropic 线上并成一条（抓真实请求体），
 *      序列严格交替；含「没有连续同角色时不合并」与「连续 tool 结果仍合并」两条对照组
 *   S10 对照组：OpenAI 兼容路径**原样透传**连续 user —— 本方案刻意的不对称，登记为现状
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { AgentLoopServiceImpl } from '../src/loop/agent-loop.js';
import { Runtime, STEER_PREFIX } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { EventStream } from '../src/runtime/event-stream.js';
import { InMemorySession } from '../src/session/in-memory.js';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { DeepSeekProvider } from '../src/llm/deepseek.js';
import type { LLMMessage, LLMProvider, LLMStreamEvent } from '../src/llm/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/* ── 脚本化假 LLM：按预定剧本逐轮返回（工具调用 或 纯文本） ── */
type Step = { toolCall: true } | { text: string };

/** 消息快照用不可见分隔符，避免与正文里的冒号混淆 */
const snap = (msgs: LLMMessage[]): string[] => msgs.map((m) => `${m.role}\u0000${m.content ?? ''}`);

function makeScriptedLlm(
  script: Step[],
  seen?: string[][],
  onStream?: (turn: number) => void,
): LLMProvider {
  let turn = 0;
  return {
    async chat() { return { content: '' }; },
    stream(messages) {
      seen?.push(snap(messages));
      onStream?.(turn);
      const step = script[Math.min(turn, script.length - 1)]!;
      turn++;
      const es = new EventStream<LLMStreamEvent>(
        (e) => e.type === 'end',
        (e) => e as { type: 'end'; fullText: string },
      );
      queueMicrotask(() => {
        if ('toolCall' in step) {
          es.push({
            type: 'tool_call',
            toolCalls: [{
              id: `call_${turn}`,
              type: 'function',
              function: { name: 'write', arguments: '{"path":"a.txt","content":"x"}' },
            }],
          });
          es.push({ type: 'end', fullText: '' });
        } else {
          es.push({ type: 'token', text: step.text });
          es.push({ type: 'end', fullText: step.text });
        }
      });
      return es;
    },
  };
}

/* ── 假工具 / 假权限 ── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const okTools: any = {
  getLLMTools: () => [],
  requiresPermission: () => false,
  execute: async () => ({ status: 'ok', content: '[OK] 已写入' }),
  register: () => {},
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openPermission: any = {
  isAutoAllowed: () => true,
  grantAutoAllow: () => {},
};

/** 可观测的引导来源：记录每次取件时的剩余长度，便于断言"取了几次" */
function makeSteerSource(initial: string[] = []) {
  const q = [...initial];
  const calls: number[] = [];
  return {
    q,
    calls,
    take: (): string | null => {
      calls.push(q.length);
      return q.shift() ?? null;
    },
  };
}

/* ── Runtime 端到端：11 个必注入，这里只有 llm / session 是真的 ── */
/** session 可外部传入，便于直接断言落盘结果（S8 用） */
function makeRuntime(llm: LLMProvider, session?: InMemorySession): Runtime {
  return new Runtime({
    llm,
    session: session ?? new InMemorySession(),
    tools: {
      getLLMTools: () => [],
      requiresPermission: () => false,
      execute: async () => ({ status: 'ok', content: '[OK] 已写入' }),
      register: () => {},
    },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {} },
    skills: { getAll: () => [], get: () => undefined, load: () => ({ skills: [], errors: [] }) },
    events: new PromptEventEmitter(),
    spanCollector: { collect: () => [], running: () => [] },
    commandSystem: { register: () => {}, list: () => [], execute: () => null },
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction: { maybeCompact: async (m: unknown[]) => ({ history: m }) },
    systemPromptService: { build: async () => ({ messages: [{ layer: 'core', content: 'SYS' }] }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

async function main(): Promise<void> {
  const events = new PromptEventEmitter();

  /* ── S0 契约形状 ── */
  console.log('\n[S0] 契约形状（takeSteer 必须是可选成员）');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/loop.ts'), 'utf8');
    check('S0-1 AgentLoopOptions 含 takeSteer 且为可选',
      /takeSteer\?:\s*\(\)\s*=>\s*string\s*\|\s*null/.test(src));
    check('S0-2 注释写明"追加进最后一条 tool 结果"的协议原因',
      src.includes('roles must alternate') || src.includes('连续两条 user'));
  }

  /* ── S1 内层吸收：引导当轮可见 ── */
  console.log('\n[S1] 内层吸收（工具跑完 → 下一次 LLM 调用之前注入）');
  {
    const seen: string[][] = [];
    const steer = makeSteerSource(['改成 B']);
    const loop = new AgentLoopServiceImpl({
      llm: makeScriptedLlm([{ toolCall: true }, { text: '完成' }], seen),
      tools: okTools,
      permission: openPermission,
      events,
    });
    const msgs: LLMMessage[] = [{ role: 'user', content: '开始' }];
    const { finalText } = await loop.run(msgs, undefined, { takeSteer: steer.take });

    check('S1-1 边界处取了一次件', steer.calls.length === 1, `calls=${JSON.stringify(steer.calls)}`);
    check('S1-2 第 2 次 LLM 请求里就看得见（当轮生效，不是下一回合）',
      seen[1]?.some((l) => l.includes('[用户引导]') && l.includes('改成 B')) === true);
    const injected = (seen[1] ?? []).filter((l) => l.includes('[用户引导]'));
    check('S1-3 引导落在 tool 消息上（不是新开 user）',
      injected.length === 1 && injected[0]!.startsWith('tool\u0000'), injected[0]?.slice(0, 30));
    check('S1-4 该轮 user 消息仍只有 1 条（协议安全：无连续 user）',
      (seen[1] ?? []).filter((l) => l.startsWith('user\u0000')).length === 1);
    check('S1-5 队列已排空', steer.q.length === 0);
    check('S1-6 收尾正常', finalText === '完成', `finalText=${finalText}`);
  }

  /* ── S2 逐条消费、不堆叠 ── */
  console.log('\n[S2] 逐条消费（两条引导 → 两条不同的 tool 结果，顺序正确）');
  {
    const steer = makeSteerSource(['先做 A', '再做 B']);
    const loop = new AgentLoopServiceImpl({
      llm: makeScriptedLlm([{ toolCall: true }, { toolCall: true }, { text: '完' }]),
      tools: okTools,
      permission: openPermission,
      events,
    });
    const msgs: LLMMessage[] = [{ role: 'user', content: '开始' }];
    await loop.run(msgs, undefined, { takeSteer: steer.take });
    const toolResults = msgs.filter((m) => m.role === 'tool').map((m) => m.content);

    check('S2-1 每条 tool 结果各带一条引导',
      toolResults[0]?.includes('先做 A') === true && toolResults[1]?.includes('再做 B') === true);
    check('S2-2 两条引导没有堆在同一条结果里（每个边界只消费一条）',
      toolResults[0]?.includes('再做 B') === false && toolResults[1]?.includes('先做 A') === false);
    check('S2-3 共取件两次、队列排空', steer.calls.length === 2 && steer.q.length === 0,
      `calls=${JSON.stringify(steer.calls)}`);
  }

  /* ── S3 无工具调用 → 不取件（绝不吞消息） ── */
  console.log('\n[S3] 本轮没有工具调用 → 内层不取件（留给外层循环）');
  {
    const steer = makeSteerSource(['改成 C']);
    const loop = new AgentLoopServiceImpl({
      llm: makeScriptedLlm([{ text: '直接回答' }]),
      tools: okTools,
      permission: openPermission,
      events,
    });
    const msgs: LLMMessage[] = [{ role: 'user', content: '开始' }];
    await loop.run(msgs, undefined, { takeSteer: steer.take });

    check('S3-1 一次都没取（没有注入落点）', steer.calls.length === 0);
    check('S3-2 引导仍在队列里（外层循环能拿到）', steer.q.length === 1 && steer.q[0] === '改成 C');
    check('S3-3 消息里没有凭空多出引导',
      msgs.every((m) => !m.content.includes('用户引导')));
  }

  /* ── S4 最后一轮 → 不取件（取走会无人消费） ── */
  console.log('\n[S4] 已是最后一轮 → 内层不取件（否则等于吞掉用户的话）');
  {
    const steer = makeSteerSource(['改成 D']);
    const loop = new AgentLoopServiceImpl({
      llm: makeScriptedLlm([{ toolCall: true }]),
      tools: okTools,
      permission: openPermission,
      events,
    });
    const msgs: LLMMessage[] = [{ role: 'user', content: '开始' }];
    const { finalText } = await loop.run(msgs, undefined, { maxTurns: 1, takeSteer: steer.take });

    check('S4-1 最后一轮不取件', steer.calls.length === 0);
    check('S4-2 引导仍在队列里，不会被丢弃', steer.q.length === 1 && steer.q[0] === '改成 D');
    check('S4-3 轮数耗尽兜底照常（finalText 仍给出进展说明）',
      finalText.startsWith('⚠️ 达到最大轮数（1）'), `finalText=${finalText.slice(0, 30)}`);
  }

  /* ── S5 向后兼容 ── */
  console.log('\n[S5] 向后兼容（不传 takeSteer / 回调恒 null）');
  {
    const loopA = new AgentLoopServiceImpl({
      llm: makeScriptedLlm([{ toolCall: true }, { text: '完成' }]),
      tools: okTools,
      permission: openPermission,
      events,
    });
    const msgsA: LLMMessage[] = [{ role: 'user', content: '开始' }];
    await loopA.run(msgsA);
    check('S5-1 不传 takeSteer：不注入任何引导',
      msgsA.every((m) => !m.content.includes('用户引导')));

    const loopB = new AgentLoopServiceImpl({
      llm: makeScriptedLlm([{ toolCall: true }, { text: '完成' }]),
      tools: okTools,
      permission: openPermission,
      events,
    });
    const msgsB: LLMMessage[] = [{ role: 'user', content: '开始' }];
    await loopB.run(msgsB, undefined, { takeSteer: () => null });
    check('S5-2 回调恒返回 null：结果与不传时一致（无引导、无异常）',
      msgsB.every((m) => !m.content.includes('用户引导')));
  }

  /* ── S6 端到端：真 Runtime 里 steer 进本轮 ── */
  console.log('\n[S6] 端到端（真 Runtime）：prompt(text,"steer") → 当轮 LLM 请求可见');
  {
    const seen: string[][] = [];
    let steerAck = '';
    let rt: Runtime | null = null;
    const llm = makeScriptedLlm(
      [{ toolCall: true }, { toolCall: true }, { text: '完成' }],
      seen,
      (turn) => {
        // 第 2 次 LLM 往返（turn=1）期间入队 —— 模拟"Agent 正在调工具时用户插入"
        if (turn === 1) {
          void rt!.prompt('改成 B', undefined, 'steer').then((r) => { steerAck = r; }).catch(() => {});
        }
      },
    );
    rt = makeRuntime(llm);
    const finalText = await rt.prompt('开始');

    check('S6-1 入队返回"（已插入）"', steerAck === '（已插入）', `ack=${steerAck}`);
    check('S6-2 第 3 次 LLM 请求里出现 [用户引导]（内层吸收，本轮内生效）',
      seen[2]?.some((l) => l.includes('[用户引导]') && l.includes('改成 B')) === true);
    check('S6-3 引导落在 tool 消息上，user 消息没有变多（仍是 1 条）',
      (seen[2] ?? []).some((l) => l.startsWith('tool\u0000') && l.includes('改成 B'))
      && (seen[2] ?? []).filter((l) => l.startsWith('user\u0000')).length === 1);
    check('S6-4 共 3 次 LLM 往返（没有为引导多开一回合）', seen.length === 3, `rounds=${seen.length}`);
    check('S6-5 最终回复正常', finalText === '完成', `finalText=${finalText}`);
  }

  /* ── S7 端到端兜底：无工具调用时退回外层，不丢失 ── */
  console.log('\n[S7] 端到端兜底：本轮无工具调用 → 引导退回外层循环（成为真正的 user 消息）');
  {
    const seen: string[][] = [];
    let rt: Runtime | null = null;
    const llm = makeScriptedLlm(
      [{ text: '答1' }, { text: '答2' }],
      seen,
      (turn) => {
        if (turn === 0) void rt!.prompt('改成 E', undefined, 'steer').catch(() => {});
      },
    );
    rt = makeRuntime(llm);
    const finalText = await rt.prompt('开始');

    check('S7-1 引导没有进内层（本轮无工具，内层刻意不取）',
      seen.every((snapTurn) => !snapTurn.some((l) => l.includes('用户引导'))));
    check('S7-2 外层接到了它，成为第 2 次请求的最后一条 user 消息',
      (seen[1] ?? []).filter((l) => l.startsWith('user\u0000')).at(-1) === 'user\u0000改成 E',
      (seen[1] ?? []).filter((l) => l.startsWith('user\u0000')).join(' | '));
    check('S7-3 用户的话没被吞：确实多跑了一回合', seen.length === 2, `rounds=${seen.length}`);
    check('S7-4 最终回复是第 2 回合的产物', finalText === '答2', `finalText=${finalText}`);
  }

  /* ── S8 落盘：被内层吸收的引导成为本轮 assistant 之前的独立 user 条目 ── */
  console.log('\n[S8] 落盘：内层吸收的引导落成本轮 assistant 之前的独立 user 条目');
  {
    const session = new InMemorySession();
    let rt: Runtime | null = null;
    const llm = makeScriptedLlm(
      [{ toolCall: true }, { toolCall: true }, { text: '完成' }],
      undefined,
      (turn) => {
        // 与 S6 同一时点入队：第 2 次 LLM 往返期间（Agent 正在调工具）用户插入
        if (turn === 1) void rt!.prompt('改成 B', undefined, 'steer').catch(() => {});
      },
    );
    rt = makeRuntime(llm, session);
    await rt.prompt('开始');

    const stored = await session.getMessages();
    // 2026-09-12 跨轮结构化接通后，turnLog（assistant+tool_calls / tool 结果）真实落盘：
    // user(开始) → user(引导) → assistant(tc) → tool → assistant(tc) → tool → assistant(完成)
    check('S8-1 会话历史变成 7 条（引导条目 + 两轮工具循环 + 最终回复都落盘）', stored.length === 7,
      stored.map((m) => m.role).join(','));
    check('S8-2 第 1 条是用户原始输入，内容未被改写', stored[0]?.content === '开始',
      stored[0]?.content);
    check('S8-3 第 2 条是引导条目，且带标记前缀',
      stored[1]?.role === 'user' && stored[1]!.content.startsWith(STEER_PREFIX),
      stored[1]?.content);
    check('S8-4 引导正文完整保留（不只是标记）', stored[1]!.content.includes('改成 B'));
    check('S8-5 位置正确：引导在 assistant **之前**（不是等回复完才补）',
      stored[2]?.role === 'assistant', stored[2]?.content);

    const hist = await rt.getHistoryMessages();
    check('S8-6 债 11 正题：下一次请求的历史里看得见它（模型不再"不知道你中途改过方向"）',
      hist.some((h) => h.role === 'user' && h.steer && h.content.includes('改成 B')));
    check('S8-7 /history 视图把它标记出来（不会被当成普通用户输入）',
      hist.length === 7 && hist[0]?.steer === false && hist[1]?.steer === true
      && hist.slice(2).every((h) => h.steer === false),
      hist.map((h) => `${h.role}:${h.steer}`).join(' | '));
  }

  /* ── S8 对照组：没有引导时历史形状完全不变 ── */
  console.log('\n[S8-对照组] 没有引导时：历史形状与标记都不得发生变化');
  {
    const session = new InMemorySession();
    const llm = makeScriptedLlm([{ toolCall: true }, { text: '完成' }]);
    const rt = makeRuntime(llm, session);
    await rt.prompt('开始');

    const stored = await session.getMessages();
    const hist = await rt.getHistoryMessages();
    check('S8c-1 变成 4 条（user,assistant(tc),tool,assistant），只多工具循环的真实条目',
      stored.length === 4
      && stored.map((m) => m.role).join(',') === 'user,assistant,tool,assistant',
      stored.map((m) => m.role).join(','));
    check('S8c-2 全部不带 steer 标记', hist.every((h) => h.steer === false),
      hist.map((h) => `${h.role}:${h.steer}`).join(' | '));
    check('S8c-3 首尾内容原样', stored[0]?.content === '开始' && stored[3]?.content === '完成');
  }

  /* ── S9/S10 起一台假服务器，抓真实请求体看线上形状 ── */
  console.log('\n[S9] 适配器归并：user,user,assistant → Anthropic 线上并成一条（抓真实请求体）');
  {
    let lastBody: Record<string, unknown> = {};
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        lastBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (req.url === '/v1/messages') {
          res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"text":"ok"}}\n\n');
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
          res.write('data: [DONE]\n\n');
        }
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const drain = async (es: AsyncIterable<unknown>): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of es) { /* 请求体已在服务器侧抓到 */ }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anWire = async (msgs: LLMMessage[]): Promise<any[]> => {
      await drain(new AnthropicProvider({ baseUrl: base, apiKey: 'k', model: 'm' }).stream(msgs));
      return (lastBody.messages ?? []) as unknown[];
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oaWire = async (msgs: LLMMessage[]): Promise<any[]> => {
      await drain(new DeepSeekProvider({ baseUrl: `${base}/v1`, apiKey: 'k', model: 'm' }).stream(msgs));
      return (lastBody.messages ?? []) as unknown[];
    };

    // S8 落盘后的真实形状
    const merged = await anWire([
      { role: 'user', content: '开始' },
      { role: 'user', content: `${STEER_PREFIX}改成 B` },
      { role: 'assistant', content: '完成' },
    ]);
    check('S9-1 连续两条 user 并成一条（消息数 3 → 2）', merged.length === 2,
      merged.map((m) => m.role).join(','));
    check('S9-2 两条正文都保留在同一条 user 里（并成两个文本块，不丢也不粘接）',
      merged[0]?.content.length === 2
      && merged[0]!.content[0]!.text === '开始'
      && merged[0]!.content[1]!.text === `${STEER_PREFIX}改成 B`,
      JSON.stringify(merged[0]?.content));
    check('S9-3 线上序列严格交替（无相邻同角色）',
      merged.every((m, i) => i === 0 || m.role !== merged[i - 1]!.role));
    check('S9-4 首条仍是 user（协议要求）', merged[0]?.role === 'user');
    check('S9-5 引导正文在线上可见', JSON.stringify(merged).includes('改成 B'));

    // 对照组一：没有相邻同角色时不得合并
    // （防"把所有 user 都并成一条"这类蒙混实现 —— 它能让上面四条全绿）
    const single = await anWire([{ role: 'user', content: '只有一句' }]);
    check('S9-6 对照组：无相邻同角色时不合并（1 条消息、1 个文本块）',
      single.length === 1 && single[0]!.content.length === 1
      && single[0]!.content[0]!.text === '只有一句',
      JSON.stringify(single));

    // 对照组二：同一函数里的 tool_result 合并不得回归
    const withTools = await anWire([
      { role: 'user', content: '任务' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
      },
      { role: 'tool', content: '[OK] a', tool_call_id: 't1' },
      { role: 'tool', content: '[OK] b', tool_call_id: 't1' },
    ]);
    check('S9-7 回归：连续 tool 结果仍合并进同一条 user（两个 tool_result 块）',
      withTools.length === 3 && withTools[2]?.role === 'user'
      && withTools[2]!.content.length === 2
      && withTools[2]!.content.every((b: { type: string }) => b.type === 'tool_result'),
      withTools.map((m) => `${m.role}/${m.content.length}`).join(' | '));

    console.log('\n[S10] 对照组：OpenAI 兼容路径原样透传连续 user（本方案刻意的不对称，登记为现状）');
    const oa = await oaWire([
      { role: 'user', content: '开始' },
      { role: 'user', content: `${STEER_PREFIX}改成 B` },
      { role: 'assistant', content: '完成' },
    ]);
    check('S10-1 不归并：仍是 3 条、两条 user 相邻', oa.length === 3
      && oa[0]?.role === 'user' && oa[1]?.role === 'user',
      oa.map((m) => m.role).join(','));
    check('S10-2 内容原样透传（未加料、未剥标记）',
      JSON.stringify(oa[1]?.content).includes('改成 B')
      && JSON.stringify(oa[1]?.content).includes(STEER_PREFIX));
    check('S10-3 两条 user 的正文各自独立（没被粘成一条）',
      JSON.stringify(oa[0]?.content) !== JSON.stringify(oa[1]?.content));

    server.close();
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
