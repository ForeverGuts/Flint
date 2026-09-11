/**
 * hook 扩展示例 —— 演示用户如何订阅系统提示词 hook 与工具生命周期 hook。
 * 用户操作：在本目录（src/extensions/hooks/）建文件，export registerHooks(ctx)，
 * 系统自动装载，无需改 main。
 *
 * 该放这里还是放 watchers/：看你要不要改写流程。
 *   - 要改（如本例追加一条 system 层消息、拦截工具调用）→ 用 ctx.on，放 hooks/
 *   - 不改，只想通配收事件做落盘/统计  → 用 ctx.events.subscribe，放 watchers/（参见 trace-log.ts）
 *
 * 工具生命周期 hook（P6）：
 *   - before_tool_call：返回 { action: 'deny', reason } 拦截该次工具执行（工具不跑，
 *     模型收到拒绝理由）；返回 undefined 放行。**没有改参能力**（语义决策见
 *     Log/DECISION_LOG.md 锚点 log-2026-09-11-tool-hooks）。顺序：钩子闸 → 权限弹窗 → 执行。
 *   - after_tool_call：只读观察，收到 { name, args, result, ok, durationMs }，返回值不消费。
 */
import type { SystemPromptMessage } from '../../core/system-prompt.js';

/** 注册 hook 扩展 */
export function registerHooks(ctx: {
  on(type: string, handler: (event: unknown) => unknown): () => void;
  events: unknown;
}): void {
  // 示例：在发送前给分层消息数组追加一条 custom 层 system 消息
  //（独立层追加在末尾，属于变化区，不破坏 core/tools/skills 稳定前缀）
  ctx.on('before_request', (event) => {
    if (event && typeof event === 'object' && 'messages' in event) {
      const e = event as { messages: SystemPromptMessage[] };
      return { messages: [...e.messages, { layer: 'custom', content: '## 扩展追加\n（来自 hook 示例）' }] };
    }
    return undefined;
  });

  // 示例：工具执行前的审计 + 拦截演示（默认只审计；要体验拦截，取消注释 deny 分支）
  ctx.on('before_tool_call', (event) => {
    if (event && typeof event === 'object' && 'name' in event) {
      const e = event as { name: string; args: Record<string, unknown> };
      console.error(`[example-hook] 工具调用：${e.name} ${JSON.stringify(e.args)}`); // stderr，不污染 RPC stdout
      // 拦截演示：拦下所有 bash 调用（返回 undefined 则放行）
      // if (e.name === 'bash') return { action: 'deny', reason: '示例钩子禁止 bash' };
    }
    return undefined;
  });

  // 示例：工具执行后的只读观察（含结果、成败与耗时）
  ctx.on('after_tool_call', (event) => {
    if (event && typeof event === 'object' && 'name' in event) {
      const e = event as { name: string; ok: boolean; durationMs: number };
      console.error(`[example-hook] 工具完成：${e.name} ok=${e.ok} ${e.durationMs}ms`);
    }
    return undefined;
  });
}
