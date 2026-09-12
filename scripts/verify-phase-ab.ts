/**
 * 阶段 A+B 逻辑验证脚本 —— 脚本化假 LLM + 假工具，不消耗真实 API。
 * 调用方：开发者手动运行
 * 运行方式：node node_modules/tsx/dist/cli.mjs scripts/verify-phase-ab.ts
 *
 * 验证项：
 *   A1 重复失败保护：同调用连续失败 2 次 → 换策略提示、3 次 → 弃路径提示；仅建议不阻断
 *   A2 轮数耗尽收尾：最后一轮前注入收尾提示 + 耗尽后结构化进展兜底
 *   A3 空流区分：流被异常中断（空流）→ 不误报为轮数耗尽，而是空内容提示 + warn 诊断
 *   A4 参数无效计入失败：[INVALID] 连续 2/3 次同样触发系统提示（改前不计失败 → 这层保护对参数错误完全失效）
 *   A5 对照组：有效否定（[NO_MATCH]）反复出现**不**触发保护，钉住 A4 改的是分类而不是把闸门全打开
 *   B1 续传检测：清单文本有未完成项（[ ] / [>]）→ task 层含 [续传提示]；全勾选则无
 */
import { AgentLoopServiceImpl } from '../src/loop/agent-loop.js';
import { SystemPromptServiceImpl } from '../src/context/system-prompt.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { EventStream } from '../src/runtime/event-stream.js';
import type { LLMMessage, LLMProvider, LLMStreamEvent } from '../src/llm/types.js';

/* ── 脚本化假 LLM：按预定剧本逐轮返回（工具调用 或 纯文本） ── */
type Step = { toolCall?: boolean; text?: string };

function makeScriptedLlm(script: Step[]): LLMProvider {
  let turn = 0;
  return {
    async chat() {
      return { content: '' };
    },
    stream() {
      const step = script[Math.min(turn, script.length - 1)];
      turn++;
      const es = new EventStream<LLMStreamEvent>(
        (e) => e.type === 'end',
        (e) => e as { type: 'end'; fullText: string },
      );
      queueMicrotask(() => {
        if (step.toolCall) {
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
          es.push({ type: 'token', text: step.text ?? 'done' });
          es.push({ type: 'end', fullText: step.text ?? 'done' });
        }
      });
      return es;
    },
  };
}

/* ── 假工具（execute 永远抛错 = 硬失败）+ 假权限（全放行，不弹窗） ── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const failingTools: any = {
  getLLMTools: () => [],
  requiresPermission: () => false,
  execute: async () => { throw new Error('模拟写入失败'); },
  register: () => {},
};
/* 两类**不抛异常**的软返回，A4/A5 靠它们的差别说话：
   [INVALID] = 工具没能工作（模型给的输入不合法，原样重试必然再错）
   [NO_MATCH] = 工具正常工作了，答案是"没有"（连查三个不同的词都落空是合法探索） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invalidTools: any = {
  getLLMTools: () => [],
  requiresPermission: () => false,
  execute: async () => ({ status: 'invalid', content: '[INVALID] 搜索模式 (pattern) 是必填参数' }),
  register: () => {},
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noMatchTools: any = {
  getLLMTools: () => [],
  requiresPermission: () => false,
  execute: async () => ({ status: 'negative', content: '[NO_MATCH] 无匹配结果: 某个确实不存在的符号' }),
  register: () => {},
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openPermission: any = {
  isAutoAllowed: () => true,
  grantAutoAllow: () => {},
};

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

async function main(): Promise<void> {
  const events = new PromptEventEmitter();

  /* ── A1 重复失败保护 ── */
  console.log('[A1] 重复失败保护（同调用连续失败 2/3 次）');
  {
    const loop = new AgentLoopServiceImpl({
      llm: makeScriptedLlm([
        { toolCall: true }, { toolCall: true }, { toolCall: true }, { text: '总结' },
      ]),
      tools: failingTools,
      permission: openPermission,
      events,
    });
    const msgs: LLMMessage[] = [{ role: 'user', content: '开始任务' }];
    const { finalText } = await loop.run(msgs);
    const toolResults = msgs.filter((m) => m.role === 'tool').map((m) => m.content);
    check('第 1 次失败无提示', !!toolResults[0] && !toolResults[0].includes('[系统提示]'));
    check('第 2 次连续失败追加换策略提示', toolResults[1]?.includes('已连续失败 2 次') === true);
    check('第 3 次连续失败追加弃路径提示', toolResults[2]?.includes('已连续失败 3 次') === true);
    check('提示后仍可正常收尾（finalText=总结）', finalText === '总结', `finalText=${finalText}`);
  }

  /* ── A2 轮数耗尽收尾 + 优雅兜底 ── */
  console.log('[A2] 轮数耗尽收尾 + 优雅兜底（maxTurns=3，模型一直调工具）');
  {
    const loop = new AgentLoopServiceImpl({
      llm: makeScriptedLlm([{ toolCall: true }]),
      tools: failingTools,
      permission: openPermission,
      events,
    });
    const msgs: LLMMessage[] = [{ role: 'user', content: '开始任务' }];
    const { finalText } = await loop.run(msgs, undefined, { maxTurns: 3 });
    const toolResults = msgs.filter((m) => m.role === 'tool').map((m) => m.content);
    check('最后一轮前注入收尾提示', toolResults.some((c) => c.includes('轮次即将耗尽')));
    check('兜底为结构化进展总结（非工具原始输出）', finalText.startsWith('⚠️ 达到最大轮数（3）'), `finalText=${finalText.slice(0, 40)}`);
  }

  /* ── A3 空流不误报轮数耗尽 ── */
  console.log('[A3] 空流区分（流异常中断 → 不误报轮数耗尽）');
  {
    const silentLlm: LLMProvider = {
      async chat() { return { content: '' }; },
      stream() {
        // 模拟 provider 层吞错后直接 end()：不推任何事件（如 401 余额不足场景）
        const es = new EventStream<LLMStreamEvent>(
          (e) => e.type === 'end',
          (e) => e as { type: 'end'; fullText: string },
        );
        queueMicrotask(() => es.end());
        return es;
      },
    };
    let warnDiagnostic = '';
    const loop = new AgentLoopServiceImpl({
      llm: silentLlm,
      tools: failingTools,
      permission: openPermission,
      events,
      onDiagnostic: (level, item, message) => { warnDiagnostic = `${level}:${item}:${message}`; },
    });
    const { finalText } = await loop.run([{ role: 'user', content: '你好' }]);
    check('空流不误报轮数耗尽', !finalText.includes('达到最大轮数'), `finalText=${finalText.slice(0, 30)}`);
    check('空流提示空内容', finalText.includes('空内容'));
    check('记录 warn 诊断', warnDiagnostic.startsWith('warn:llm'), warnDiagnostic);
  }

  /* ── A4 参数无效计入失败（[INVALID] 也要触发重复失败保护） ── */
  console.log('[A4] 参数无效计入失败（[INVALID] 连续 2/3 次 → 系统提示）');
  {
    const loop = new AgentLoopServiceImpl({
      llm: makeScriptedLlm([
        { toolCall: true }, { toolCall: true }, { toolCall: true }, { text: '总结' },
      ]),
      tools: invalidTools,
      permission: openPermission,
      events,
    });
    const msgs: LLMMessage[] = [{ role: 'user', content: '开始任务' }];
    await loop.run(msgs);
    const results = msgs.filter((m) => m.role === 'tool').map((m) => m.content);
    check('A4-1 第 1 次 [INVALID] 无提示（第一次不该被念）',
      !!results[0] && !results[0].includes('[系统提示]'), results[0]?.slice(0, 60));
    check('A4-2 第 2 次连续 [INVALID] 追加换策略提示',
      results[1]?.includes('已连续失败 2 次') === true, results[1]?.slice(0, 80));
    check('A4-3 第 3 次追加弃路径提示',
      results[2]?.includes('已连续失败 3 次') === true, results[2]?.slice(0, 80));
  }

  /* ── A5 对照组：有效否定仍不计失败 ── */
  // 没有这一段，A4 可以被"顺手"实现成"除了 [OK] 都算失败"而照样全绿——那条路会让模型
  // 每查一个不存在的符号都被念一次"你在重复犯错"。A5 钉住 A4 改的是**分类**：
  // 只有"工具没能工作"才计失败，"工具工作正常但答案是没有"不计。
  console.log('[A5] 对照组：有效否定（[NO_MATCH]）反复出现不触发保护');
  {
    const loop = new AgentLoopServiceImpl({
      llm: makeScriptedLlm([
        { toolCall: true }, { toolCall: true }, { toolCall: true }, { text: '总结' },
      ]),
      tools: noMatchTools,
      permission: openPermission,
      events,
    });
    const msgs: LLMMessage[] = [{ role: 'user', content: '开始任务' }];
    await loop.run(msgs);
    const results = msgs.filter((m) => m.role === 'tool').map((m) => m.content);
    check('A5-1 连续 3 次 [NO_MATCH] 都没有系统提示（有效否定不是犯错）',
      results.length === 3 && results.every((c) => !c.includes('[系统提示]')),
      results.map((c) => c.slice(0, 30)).join(' / '));
  }

  /* ── B1 续传检测（task 层） ── */
  console.log('[B1] 续传检测（清单文本复选框 → task 层 [续传提示]）');
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sps = new SystemPromptServiceImpl({ core: [], tools: [], skills: [], fallback: '兜底' }, events as any);
    const withUnchecked = await sps.build({
      tools: '', skills: [], model: 'm', historyCount: 0,
      task: '# TASK\n- [ ] 第一步\n- [x] 第二步',
    });
    const taskMsg = withUnchecked.messages.find((m) => m.layer === 'task');
    check('有未勾选项 → 含 [续传提示]', taskMsg?.content.includes('[续传提示]') === true);
    check('续传提示指明"从第一个未完成项继续"', taskMsg?.content.includes('从第一个未完成项继续') === true);

    const allDone = await sps.build({
      tools: '', skills: [], model: 'm', historyCount: 0,
      task: '# TASK\n- [x] 全部完成',
    });
    const taskMsg2 = allDone.messages.find((m) => m.layer === 'task');
    check('全勾选 → 无续传提示', !!taskMsg2 && !taskMsg2.content.includes('[续传提示]'));

    const noTask = await sps.build({ tools: '', skills: [], model: 'm', historyCount: 0 });
    check('无 TASK.md → 无 task 层', !noTask.messages.some((m) => m.layer === 'task'));
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
