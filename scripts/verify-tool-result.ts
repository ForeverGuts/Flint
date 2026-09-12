/**
 * 工具结构化返回值验证 —— 脚本化假 LLM + 假工具 + 真注册表，不消耗真实 API。
 * 调用方：run-verify.mjs（npm run verify）
 * 运行方式：node node_modules/tsx/dist/cli.mjs scripts/verify-tool-result.ts
 *
 * 验证项：
 *   ① 构造器（生产端形状）：五个构造器的 status 与 content 前缀逐字节正确；
 *      toolStatusFails 名单恰好 invalid/error/verify_failed 三个
 *   ② registry 接线：ToolInputError 就地转 invalid（含未知参数）；非 ToolInputError
 *      穿透不吞；handler 的 ToolResult 原样透传（status 不被改写）
 *   ③ agent-loop 行为证明：五个 status 各跑一遍真循环，tool_execution_end 的 ok
 *      如实反映；重复失败保护只对计失败的状态触发（invalid 计、negative 不计）
 *   ④ 源码守护（防回退）：前缀解析从 agent-loop 消失、builtin 不再手写前缀 return
 *
 * 背景（2026-09-12）：改前 handler 返回裸字符串，"算不算失败"由 agent-loop 对前缀
 * 做 startsWith——前缀是工具层与消费层之间唯一的协议，拼错一个字母分类就静默漂移。
 * 现在生产方在 ToolResult.status 里声明分类，机器读字段、模型读 content（措辞不变）。
 */
import { AgentLoopServiceImpl } from '../src/loop/agent-loop.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { EventStream } from '../src/runtime/event-stream.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import {
  toolOk, toolInvalid, toolError, toolVerifyFailed, toolNegative,
} from '../src/tools/spec.js';
import { toolStatusFails } from '../src/core/tools.js';
import type { ToolDefinition, ToolResult } from '../src/core/tools.js';
import type { LLMMessage, LLMProvider, LLMStreamEvent } from '../src/llm/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/* ── 脚本化假 LLM：前 toolTurns 轮吐工具调用，之后吐最终文本 ── */
function makeScriptedLlm(toolTurns = 1): LLMProvider {
  let turn = 0;
  return {
    async chat() { return { content: '' }; },
    stream() {
      turn++;
      const es = new EventStream<LLMStreamEvent>(
        (e) => e.type === 'end',
        (e) => e as { type: 'end'; fullText: string },
      );
      queueMicrotask(() => {
        if (turn <= toolTurns) {
          es.push({
            type: 'tool_call',
            toolCalls: [{
              id: `call_${turn}`, type: 'function',
              function: { name: 'grep', arguments: '{"pattern":"x"}' },
            }],
          });
          es.push({ type: 'end', fullText: '' });
        } else {
          es.push({ type: 'token', text: 'done' });
          es.push({ type: 'end', fullText: 'done' });
        }
      });
      return es;
    },
  };
}

/** 造一套跑真循环的假环境：tools 每次返回同一个 ToolResult，收集 end 事件与历史消息 */
async function runOneTurn(result: ToolResult, toolTurns = 1) {
  const events = new PromptEventEmitter();
  const endEvents: Array<Record<string, unknown>> = [];
  events.subscribe((e) => {
    if (e.type === 'tool_execution_end') endEvents.push(e as unknown as Record<string, unknown>);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any = {
    getLLMTools: () => [],
    requiresPermission: () => false,
    execute: async () => result,
    register: () => {},
  };
  const loop = new AgentLoopServiceImpl({
    // 重复失败保护需要"同一调用"——工具名与参数每次相同，天然满足
    llm: makeScriptedLlm(toolTurns),
    tools,
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {} },
    events,
  });
  const msgs: LLMMessage[] = [{ role: 'user', content: '开始任务' }];
  // 多留一轮（+2 而非 +1）：+1 会让"下一轮即最后一轮"的收尾提示追加进最后一条工具结果，
  // 污染"content 原样进历史"这条断言的观察面
  await loop.run(msgs, undefined, { maxTurns: toolTurns + 2 });
  const toolMsgs = msgs.filter((m) => m.role === 'tool').map((m) => m.content);
  return { endEvents, toolMsgs };
}

async function main(): Promise<void> {
  /* ── ① 构造器：status 与 content 前缀逐字节正确 ── */
  console.log('\n① 构造器（生产端形状）');
  {
    check('1-1 toolOk → status=ok 且 content=[OK] 正文',
      toolOk('正文').status === 'ok' && toolOk('正文').content === '[OK] 正文',
      JSON.stringify(toolOk('正文')));
    check('1-2 toolInvalid → status=invalid 且 content=[INVALID] 正文',
      toolInvalid('正文').status === 'invalid' && toolInvalid('正文').content === '[INVALID] 正文',
      JSON.stringify(toolInvalid('正文')));
    check('1-3 toolError → status=error 且 content=[ERROR] 正文',
      toolError('正文').status === 'error' && toolError('正文').content === '[ERROR] 正文',
      JSON.stringify(toolError('正文')));
    check('1-4 toolVerifyFailed → status=verify_failed 且 content=[VERIFY_FAILED] 正文',
      toolVerifyFailed('正文').status === 'verify_failed'
      && toolVerifyFailed('正文').content === '[VERIFY_FAILED] 正文',
      JSON.stringify(toolVerifyFailed('正文')));
    const negatives: Array<[Parameters<typeof toolNegative>[0], string]> = [
      ['NOT_FOUND', 'x'], ['NOT_DIR', 'x'], ['NOT_FILE', 'x'], ['NO_MATCH', 'x'], ['EMPTY', 'x'],
    ];
    check('1-5 toolNegative 五个前缀逐字节正确且都是 negative（模型可见协议一字未变）',
      negatives.every(([p, c]) => {
        const r = toolNegative(p, c);
        return r.status === 'negative' && r.content === `[${p}] ${c}`;
      }),
      JSON.stringify(negatives.map(([p, c]) => toolNegative(p, c).content)));
    check('1-6 toolStatusFails 名单恰好 invalid/error/verify_failed 三个（唯一判定式）',
      toolStatusFails('invalid') && toolStatusFails('error') && toolStatusFails('verify_failed')
      && !toolStatusFails('ok') && !toolStatusFails('negative'));
  }

  /* ── ② registry 接线：parse 错误就地转 invalid，ToolResult 原样透传 ── */
  console.log('\n② registry 接线');
  {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const r1 = await registry.execute('grep', {});
    check('2-1 缺 pattern → status=invalid 且 content=[INVALID] 开头（参数名单不被吞）',
      r1.status === 'invalid' && r1.content.startsWith('[INVALID]'), JSON.stringify(r1).slice(0, 120));
    const r2 = await registry.execute('grep', { pattern: 'x', pathh: 'typo' });
    check('2-2 未知参数 → status=invalid 且文案列出可用参数名',
      r2.status === 'invalid' && r2.content.includes('pattern'), JSON.stringify(r2).slice(0, 120));

    // 非 ToolInputError 必须穿透（规格自己写坏了 → 该报执行失败，不能混进 invalid）
    const badTool: ToolDefinition = {
      name: 'badparse',
      description: '规格写坏的替身',
      parameters: { type: 'object', properties: {} },
      parse: () => { throw new RangeError('规格坏了'); },
      handler: async () => toolOk('不该到达'),
    };
    registry.register(badTool);
    let passthrough = false;
    try { await registry.execute('badparse', {}); } catch (e) {
      passthrough = e instanceof RangeError;
    }
    check('2-3 非 ToolInputError 穿透（不吞、不混成 invalid）', passthrough);

    // handler 的 ToolResult 原样透传：status 不被 execute 改写
    const probe: ToolDefinition = {
      name: 'probe',
      description: '透传探针',
      parameters: { type: 'object', properties: {} },
      handler: async () => toolNegative('EMPTY', '探针'),
    };
    registry.register(probe);
    const r3 = await registry.execute('probe', {});
    check('2-4 handler 的 ToolResult 原样透传（status 不被改写）',
      r3.status === 'negative' && r3.content === '[EMPTY] 探针', JSON.stringify(r3));
  }

  /* ── ③ agent-loop 行为证明：五个 status 各跑一遍真循环 ── */
  console.log('\n③ agent-loop 五态行为（真循环 + 假工具）');
  {
    const cases: Array<[ToolResult, boolean, string]> = [
      [toolOk('成功了'), true, 'ok'],
      [toolNegative('NO_MATCH', '没有'), true, 'negative'],
      [toolInvalid('参数错了'), false, 'invalid'],
      [toolError('磁盘满了'), false, 'error'],
      [toolVerifyFailed('写回不一致'), false, 'verify_failed'],
    ];
    for (const [result, expectOk, label] of cases) {
      const { endEvents, toolMsgs } = await runOneTurn(result);
      const ev = endEvents[0];
      check(`3-${label} tool_execution_end ok=${expectOk}（分类读 status，不解析文本）`,
        !!ev && ev.ok === expectOk, JSON.stringify(ev));
      check(`3-${label} content 原样进历史（模型可见协议不变）`,
        toolMsgs[0] === result.content, JSON.stringify(toolMsgs[0]));
    }

    // 重复失败保护联动：invalid 连续 2 次 → 注入 [系统提示]；negative 连续多次 → 不注入
    const invalid = await runOneTurn(toolInvalid('参数错了'), 2);
    check('3-repeat invalid 连续 2 次触发重复失败保护',
      invalid.toolMsgs.length >= 2 && invalid.toolMsgs[1].includes('[系统提示]'),
      JSON.stringify(invalid.toolMsgs[1] ?? '').slice(0, 120));
    const negative = await runOneTurn(toolNegative('NO_MATCH', '没有'), 2);
    check('3-ctrl negative 连续多次不触发保护（有效否定不是犯错）',
      negative.toolMsgs.length >= 2 && negative.toolMsgs.every((c) => !c.includes('[系统提示]')),
      JSON.stringify(negative.toolMsgs.map((c) => c.slice(0, 30))));
  }

  /* ── ④ 源码守护（防回退） ── */
  console.log('\n④ 源码守护（防回退）');
  {
    const loopSrc = fs.readFileSync(path.join(ROOT, 'src/loop/agent-loop.ts'), 'utf-8');
    const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8');
    const coreSrc = fs.readFileSync(path.join(ROOT, 'src/core/tools.ts'), 'utf-8');
    const specSrc = fs.readFileSync(path.join(ROOT, 'src/tools/spec.ts'), 'utf-8');

    // 注释里保留着"startsWith 解析前缀"的解释性文字（不含 .startsWith( 调用形态），
    // 钉调用形态就不会误伤注释——与 verify-tools G1 同一手法的反面运用
    check('4-1 agent-loop 里不再有 .startsWith( 的前缀解析（结构化分类取代文本解析）',
      !/\.startsWith\(/.test(loopSrc));

    check('4-2 builtin 不再手写前缀 return（前缀一律由构造器生成，杜绝 [ERORR] 式拼错）',
      !/return `\[/m.test(builtinSrc) && /return toolError\(/.test(builtinSrc));

    const failsDef = coreSrc.match(/export function toolStatusFails[\s\S]*?\n}/)?.[0] ?? '';
    const failsList = [...failsDef.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    check('4-3 core 里 toolStatusFails 名单恰好三个（副本会漂移，名单只此一处）',
      failsList.join(',') === 'invalid,error,verify_failed', JSON.stringify(failsList));

    check('4-4 ToolResult 进 core 契约（handler 与 execute 都返回它，不是旁路可选成员）',
      /handler: \(args: Record<string, unknown>\) => Promise<ToolResult>;/.test(coreSrc)
      && /execute\(name: string, args: Record<string, unknown>\): Promise<ToolResult>;/.test(coreSrc));

    check('4-5 ToolNegativePrefix 类型限定五个既有标识（新前缀必须显式扩名单，不许随手字符串）',
      /export type ToolNegativePrefix = 'NOT_FOUND' \| 'NOT_DIR' \| 'NOT_FILE' \| 'NO_MATCH' \| 'EMPTY';/.test(specSrc));
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
