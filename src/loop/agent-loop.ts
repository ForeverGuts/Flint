/**
 * Agent Loop 子系统 —— LLM 流式调用 + 工具执行循环。
 * 调用方：Runtime（runSingleTurn 中委托 run）
 * 服务于：单一 stream() 循环 —— 模型生成文本 + 结构化 tool_calls，
 *         执行工具 → 结果塞回 → 下一轮，直到无工具调用或达最大轮数
 *
 * 依赖（core 接口 + 注入回调）：
 *   - llm（LLMProvider）流式生成
 *   - tools（ToolProvider）执行工具
 *   - permission（PermissionProvider）工具权限
 *   - events（EventBus）发射工具/流事件
 *   - 回调：onPermission（权限弹窗）、onDiagnostic（记录错误）、onFallback（LLM 失败切换）
 */
import type { LLMProvider, LLMMessage, LLMToolCall } from '../llm/types.js';
import type { ToolProvider } from '../core/tools.js';
import type { PermissionProvider } from '../core/permission.js';
import type { EventBus } from '../core/events.js';

/** 最大循环轮数（防死循环） */
const MAX_TURNS = 5;

/** AgentLoop 依赖 */
export interface AgentLoopDeps {
  llm: LLMProvider;
  tools: ToolProvider;
  permission: PermissionProvider;
  events: EventBus;
  /** 权限确认回调（返回 'allow' | 'deny' | 'always'；默认 allow） */
  onPermission?: (toolName: string, detail: string) => Promise<'allow' | 'deny' | 'always'>;
  /** 诊断记录回调（LLM/工具失败时） */
  onDiagnostic?: (level: string, item: string, message: string) => void;
  /** LLM 失败兜底回调（返回 true 表示已切换可重试；默认 false） */
  onFallback?: (error: unknown) => Promise<boolean>;
}

/** Agent Loop 执行结果 */
export interface AgentLoopResult {
  /** 最终回复文本 */
  finalText: string;
}

/** Agent Loop 子系统 */
export class AgentLoop {
  constructor(private deps: AgentLoopDeps) {}

  /**
   * 运行一轮 Agent Loop：LLM 生成 → 工具执行 → 循环。
   * @param toolMessages 初始消息（含 system 工具描述 + 历史 + 用户消息）
   * @param onToken 流式 token 回调（可选，透传给 UI）
   */
  async run(toolMessages: LLMMessage[], onToken?: (chunk: string) => void): Promise<AgentLoopResult> {
    const { llm, tools, events } = this.deps;
    const toolDefs = tools.getLLMTools();
    let finalText = '';

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // ── ① LLM 流式生成 + 收集工具调用 ──
      let turnText = '';
      const turnCalls: LLMToolCall[] = [];
      try {
        const eventStream = llm.stream(toolMessages, toolDefs);
        for await (const event of eventStream) {
          if (event.type === 'token') {
            turnText += event.text;
            onToken?.(event.text);
            events.emit({ type: 'stream_text', text: event.text });
          } else if (event.type === 'tool_call') {
            turnCalls.push(...event.toolCalls);
          } else if (event.type === 'end') {
            turnText = event.fullText;
          }
        }
      } catch (err) {
        // 流异常 → 诊断 + 兜底切换（可重试则 continue）
        this.deps.onDiagnostic?.('fail', 'llm', err instanceof Error ? err.message.split('\n')[0] : String(err));
        const switched = await this.deps.onFallback?.(err) ?? false;
        if (switched) continue;
        finalText = `❌ LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }

      // ── ② 无工具调用 → 最终答案 ──
      if (turnCalls.length === 0) {
        finalText = turnText;
        break;
      }

      // ── ③ 执行工具，结果塞回 ──
      toolMessages.push({ role: 'assistant', content: turnText, tool_calls: turnCalls });
      for (const tc of turnCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch { args = {}; }
        events.emit({ type: 'tool_execution_start', name: tc.function.name, args });
        try {
          // 权限检查
          if (tools.requiresPermission(tc.function.name)) {
            const detail = JSON.stringify(args).slice(0, 80);
            if (!this.deps.permission.isAutoAllowed(tc.function.name, detail)) {
              const choice = await this.deps.onPermission?.(tc.function.name, detail) ?? 'allow';
              if (choice === 'deny') {
                toolMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: `[工具 ${tc.function.name} 被用户拒绝]` });
                events.emit({ type: 'tool_execution_end', name: tc.function.name, result: '❌ 已拒绝' });
                continue;
              }
              if (choice === 'always') {
                this.deps.permission.grantAutoAllow(tc.function.name, detail);
              }
            }
          }
          const result = await tools.execute(tc.function.name, args);
          toolMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result });
          events.emit({ type: 'tool_execution_end', name: tc.function.name, result });
        } catch (err) {
          toolMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: `[工具 ${tc.function.name} 执行失败]\n${err}` });
          this.deps.onDiagnostic?.('fail', 'tool', `工具 ${tc.function.name} 执行失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // ④ 工具执行完 → 下一轮
    }

    // ⑤ 5 轮没得到回复 → 用最后一次消息兜底
    if (!finalText) {
      const last = toolMessages[toolMessages.length - 1];
      finalText = typeof last?.content === 'string' ? last.content : '';
    }

    return { finalText };
  }
}
