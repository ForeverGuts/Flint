/**
 * verify-hooks.ts —— 工具生命周期钩子（before_tool_call / after_tool_call）
 *
 * 验什么（手段与行为分开钉）：
 *   ① decodeDeny 纯函数 —— deny 契约逐形状喂（fail-open：形状不对一律放行）
 *   ② 行为段 —— 真 AgentLoopServiceImpl + 假 LLM / 假总线 / 探针工具替身：
 *      放行路径钩子收到的载荷形状、拦截路径 execute 真没被调、钩子异常工具照跑、
 *      程序闸（钩子）先于人闸（权限弹窗）、after 只读且带耗时
 *   ③ 源码断言 —— 发射点唯一、decodeDeny 接线，防回退
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-hooks.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeDeny, HOOK_DENY_DEFAULT_REASON } from '../src/loop/tool-hooks.js';
import { AgentLoopServiceImpl } from '../src/loop/agent-loop.js';

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

/* ── ① decodeDeny 纯函数 ── */
console.log('── ① decodeDeny 纯函数 ──');

check('C1 undefined → 放行', decodeDeny(undefined).deny === false);
check('C2 null → 放行', decodeDeny(null).deny === false);
check('C3 字符串 → 放行', decodeDeny('deny').deny === false);
check('C4 数字 → 放行', decodeDeny(42).deny === false);
check('C5 空对象 → 放行', decodeDeny({}).deny === false);
check('C6 action:allow → 放行', decodeDeny({ action: 'allow' }).deny === false);
check('C7 action 大小写敏感：DENY → 放行（fail-open）', decodeDeny({ action: 'DENY' }).deny === false);
const d1 = decodeDeny({ action: 'deny' });
check('C8 {action:deny} → 拦截 + 默认理由', d1.deny && d1.reason === HOOK_DENY_DEFAULT_REASON);
const d2 = decodeDeny({ action: 'deny', reason: '危险命令' });
check('C9 带理由 → 拦截 + 原文理由', d2.deny && d2.reason === '危险命令');
const d3 = decodeDeny({ action: 'deny', reason: '   ' });
check('C10 纯空白理由 → 回退默认理由', d3.deny && d3.reason === HOOK_DENY_DEFAULT_REASON);
const d4 = decodeDeny({ action: 'deny', reason: 123 });
check('C11 非字符串理由 → 回退默认理由', d4.deny && d4.reason === HOOK_DENY_DEFAULT_REASON);
const d5 = decodeDeny({ action: 'deny', reason: 'x', extra: 1 });
check('C12 多余字段不碍事', d5.deny && d5.reason === 'x');

/* ── 替身工厂 ── */

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

/** 造一套假依赖：LLM 按剧本吐工具调用再吐最终文本；总线/工具/权限记录收到的每一样 */
function makeFakes(opts: {
  /** emitHook 的行为剧本（缺省 = 记录调用、一律返回 undefined = 放行） */
  hookImpl?: (type: string, event: unknown) => Promise<unknown>;
  /** 造一辆**没有 emitHook** 的老总线（验 emitHook?.() 可选链的向后兼容） */
  oldBus?: boolean;
  /** 工具是否需要权限弹窗 */
  requirePerm?: boolean;
  /** execute 的返回值 */
  executeResult?: string;
}) {
  const llmCalls: LLMMessage[][] = [];
  const hookCalls: Array<{ type: string; event: unknown }> = [];
  const execCalls: RecordedCall[] = [];
  const permAsked: string[] = [];
  const timeline: string[] = []; // 钩子/权限/执行的先后顺序
  const emitted: Array<Record<string, unknown>> = [];

  // 剧本：第 1 轮吐一个 bash 工具调用，第 2 轮吐最终文本（模型视角的"工具结果已拿到"）
  const toolCallEvent = {
    type: 'tool_call',
    toolCalls: [{ id: 't1', function: { name: 'bash', arguments: JSON.stringify({ cmd: 'rm -rf /tmp/x' }) } }],
  };
  const endEvent = {
    type: 'end',
    fullText: 'done',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
  const script: Array<unknown[]> = [[toolCallEvent], [{ type: 'token', text: 'done' }, endEvent]];

  const llm = {
    stream: (messages: LLMMessage[]) => {
      llmCalls.push(messages);
      const events = script.shift() ?? [endEvent];
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };

  const bus: Record<string, unknown> = {
    subscribe: () => () => {},
    on: () => () => {},
    emit: (e: Record<string, unknown>) => emitted.push(e),
  };
  if (!opts.oldBus) {
    bus.emitHook = async (type: string, event: unknown) => {
      timeline.push(`hook:${type}`);
      hookCalls.push({ type, event });
      return opts.hookImpl ? opts.hookImpl(type, event) : undefined;
    };
  }

  const tools = {
    register: () => {},
    getLLMTools: () => [],
    requiresPermission: () => !!opts.requirePerm,
    execute: (name: string, args: Record<string, unknown>) => {
      timeline.push('exec');
      execCalls.push({ name, args });
      return Promise.resolve(opts.executeResult ?? 'ok-result');
    },
  };

  const permission = { isAutoAllowed: () => false, grantAutoAllow: () => {} };
  const deps = {
    llm,
    tools,
    permission,
    events: bus,
    onPermission: async (toolName: string) => {
      timeline.push('perm');
      permAsked.push(toolName);
      return 'allow' as const;
    },
  };

  return {
    llmCalls, hookCalls, execCalls, permAsked, timeline, emitted,
    run: () => new AgentLoopServiceImpl(deps as never).run([{ role: 'user', content: 'hi' }] as never),
  };
}

/* ── ② 行为段：真循环 + 假依赖 ── */
console.log('── ② 行为段（真 AgentLoopServiceImpl + 假依赖探针） ──');

// H1 放行路径：钩子收到正确载荷，execute 真被调，结果回到模型
{
  const f = makeFakes({});
  const result = await f.run();
  check('H1a 放行 → execute 被调一次且参数原样', f.execCalls.length === 1
    && f.execCalls[0].name === 'bash' && f.execCalls[0].args.cmd === 'rm -rf /tmp/x');
  const before = f.hookCalls.find((h) => h.type === 'before_tool_call');
  check('H1b before 钩子收到 {name, args}', !!before
    && (before.event as Record<string, unknown>).name === 'bash'
    && (before.event as Record<string, unknown>).args.cmd === 'rm -rf /tmp/x');
  const after = f.hookCalls.find((h) => h.type === 'after_tool_call');
  const afterPayload = after?.event as Record<string, unknown> | undefined;
  check('H1c after 钩子收到 {name, args, result, ok, durationMs}', !!afterPayload
    && afterPayload.name === 'bash' && afterPayload.result === 'ok-result'
    && afterPayload.ok === true && typeof afterPayload.durationMs === 'number'
    && (afterPayload.durationMs as number) >= 0);
  check('H1d 工具结果回到模型（第二轮消息含 ok-result）',
    f.llmCalls.length === 2
    && JSON.stringify(f.llmCalls[1]).includes('ok-result'));
  check('H1e 最终文本正常', result.finalText === 'done');
  check('H1f 顺序：before 钩子 → 执行 → after 钩子',
    f.hookCalls[0].type === 'before_tool_call'
    && f.hookCalls[1].type === 'after_tool_call');
}

// H2 拦截路径：execute 真没被调，模型收到拒绝理由，人闸没被触发
{
  const f = makeFakes({
    hookImpl: async (_type, event) =>
      (event as Record<string, unknown>).name === 'bash' ? { action: 'deny', reason: '危险命令' } : undefined,
    requirePerm: true,
  });
  const result = await f.run();
  check('H2a 拦截 → execute 一次都没被调', f.execCalls.length === 0);
  check('H2b 模型收到「被钩子拦截」+ 理由',
    JSON.stringify(f.llmCalls[1] ?? '').includes('[工具 bash 被钩子拦截]：危险命令'));
  const endEvent = f.emitted.find((e) => e.type === 'tool_execution_end');
  check('H2c tool_execution_end 标记失败', !!endEvent && endEvent.result === '❌ 已被钩子拦截' && endEvent.ok === false);
  check('H2d 程序闸先于人闸：钩子拦下后权限弹窗根本没弹', f.permAsked.length === 0);
  check('H2e 拦截不掀翻循环：最终文本仍正常', result.finalText === 'done');
}

// H3 拦截无理由 → 默认理由进工具结果
{
  const f = makeFakes({ hookImpl: async () => ({ action: 'deny' }) });
  await f.run();
  check('H3 无理由拦截 → 默认理由「未提供理由」进工具结果',
    JSON.stringify(f.llmCalls[1] ?? '').includes(HOOK_DENY_DEFAULT_REASON));
}

// H4 钩子异常隔离：before 钩子抛异常 → 按放行处理，工具照跑
{
  const f = makeFakes({
    hookImpl: async (type) => {
      if (type === 'before_tool_call') throw new Error('钩子炸了');
      return undefined;
    },
  });
  const result = await f.run();
  check('H4a before 钩子异常 → 工具照跑', f.execCalls.length === 1);
  check('H4b 循环不掀翻', result.finalText === 'done');
}

// H5 after 钩子异常：结果已经拿到，异常不能吞掉它
{
  const f = makeFakes({
    hookImpl: async (type) => {
      if (type === 'after_tool_call') throw new Error('after 炸了');
      return undefined;
    },
  });
  const result = await f.run();
  check('H5 after 钩子异常 → 结果照常回到模型', f.execCalls.length === 1 && result.finalText === 'done');
}

// H6 权限语义：放行路径下程序闸（钩子）先于人闸（弹窗）
{
  const f = makeFakes({ requirePerm: true });
  await f.run();
  check('H6a 放行路径：权限弹窗被触发', f.permAsked.length === 1);
  check('H6b 顺序：钩子闸 → 权限闸 → 执行（→ after 钩子）',
    f.timeline.join(',') === 'hook:before_tool_call,perm,exec,hook:after_tool_call');
}

// H7 老总线（没有 emitHook）→ 一切照旧
{
  const f = makeFakes({ oldBus: true });
  const result = await f.run();
  check('H7 emitHook 未实现 → 放行且正常完成', f.execCalls.length === 1 && result.finalText === 'done');
}

// H8 失败工具：after 钩子的 ok 如实反映失败（[ERROR] 前缀 → ok:false）
{
  const f = makeFakes({ executeResult: '[ERROR] 磁盘满了' });
  await f.run();
  const after = f.hookCalls.find((h) => h.type === 'after_tool_call');
  const payload = after?.event as Record<string, unknown> | undefined;
  check('H8 after 钩子 ok 如实标记失败', !!payload && payload.ok === false
    && payload.result === '[ERROR] 磁盘满了');
}

/* ── ③ 源码断言（防回退） ── */
console.log('── ③ 源码断言 ──');

const loopSrc = fs.readFileSync(path.join(ROOT, 'src/loop/agent-loop.ts'), 'utf8');
const hooksSrc = fs.readFileSync(path.join(ROOT, 'src/loop/tool-hooks.ts'), 'utf8');

check('S1 before_tool_call 发射点全 src 唯一（只在 agent-loop）',
  (loopSrc.match(/emitHook\?\.\('before_tool_call'/g) ?? []).length === 1);
check('S2 after_tool_call 发射点全 src 唯一（只在 agent-loop）',
  (loopSrc.match(/emitHook\?\.\('after_tool_call'/g) ?? []).length === 1);
check('S3 agent-loop 接了 decodeDeny', loopSrc.includes("import { decodeDeny } from './tool-hooks.js'"));
check('S4 decodeDeny 模块存在且导出契约', hooksSrc.includes('export function decodeDeny')
  && hooksSrc.includes('export const HOOK_DENY_DEFAULT_REASON'));

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
