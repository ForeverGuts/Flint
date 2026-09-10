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
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentLoopServiceImpl } from '../src/loop/agent-loop.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { EventStream } from '../src/runtime/event-stream.js';
import { InMemorySession } from '../src/session/in-memory.js';
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
  execute: async () => '[OK] 已写入',
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
function makeRuntime(llm: LLMProvider): Runtime {
  return new Runtime({
    llm,
    session: new InMemorySession(),
    tools: {
      getLLMTools: () => [],
      requiresPermission: () => false,
      execute: async () => '[OK] 已写入',
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

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
