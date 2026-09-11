/**
 * RPC 事件映射 —— 把内核事件翻译成 ACP 形状的 session/update。
 * 调用方：harness/rpc.ts（chat 期间订阅事件，逐条外发）
 * 服务于：让编辑器等外部前端也能看见"正在发生什么"，而不是干等最终结果
 *
 * 三条硬规矩：
 *   ① 不碰 stdout、不碰 IO —— 本模块只产出普通对象。
 *      于是这一层**不开进程就能测**（见 scripts/verify-rpc-stream.ts），
 *      否则每次验证都得真起子进程、等真实 LLM，那测试谁也不会跑。
 *   ② 过滤也是映射的一部分：内部记账类事件（span / note / harness 自检）一律不外发。
 *      外发等于把内部实现钉成对外契约，将来改内部就得先考虑兼容性。
 *   ③ 字段名优先用 ACP 规范里真实存在的（已逐个核对规范），
 *      将来真要全量对齐，只差一层壳（session/new、session/prompt 等），不用推倒重来。
 *
 * ACP 传送门：https://agentclientprotocol.com/protocol/v2/draft/prompt-lifecycle
 */
import type { RuntimeEvent } from '../runtime/events.js';

/** ACP 会话更新。sessionUpdate 是判别式，决定对端怎么解释本条。 */
export interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

/** JSON-RPC notification（无 id —— 没人请求它，是我们主动推的） */
export interface RpcNotification {
  jsonrpc: '2.0';
  method: 'session/update';
  params: { sessionId: string; update: SessionUpdate };
}

/** 工具名 → ACP ToolKind（规范取值：read / edit / delete / move / search / execute / think / fetch / other） */
const TOOL_KIND: Record<string, string> = {
  ls: 'read',
  read: 'read',
  grep: 'search',
  write: 'edit',
  edit: 'edit',
  bash: 'execute',
};

/** thinking 阶段 → 人话标题（notice.title 要求非空的纯文本） */
const PHASE_TITLE: Record<string, string> = {
  analyzing: '正在分析输入',
  compressing: '正在压缩上下文',
  streaming: '正在等待模型响应',
};

/**
 * 事件 → 更新。返回 null 表示这条不外发。
 *
 * 状态只有三个、且都是"配对/去重"所必需的最小量：
 *   toolSeq / currentToolId —— 内核的工具事件**没有 id**（类型里就没这字段），
 *     而 ACP 的 tool_call 与 tool_call_update 必须靠 toolCallId 配对，
 *     只能自己发号。另：span 层的 tool_call_start/end 虽有 spanId，
 *     但那两个事件全 src/ 从没被发射过（只有类型定义），指望不上。
 *   lastPhase —— 等首字期间 thinking 可能重发同一阶段，只报一次免得刷屏。
 */
export class RpcEventMapper {
  private toolSeq = 0;
  private currentToolId: string | null = null;
  private lastPhase = '';

  update(event: RuntimeEvent): SessionUpdate | null {
    switch (event.type) {
      // ── 片（chunk）：对端累加到上一条后面 ──
      case 'stream_text':
        return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } };
      case 'stream_reasoning':
        return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.text } };

      // ── 离散事件：对端新建或替换状态 ──
      case 'tool_execution_start': {
        this.currentToolId = `call_${++this.toolSeq}`;
        return {
          sessionUpdate: 'tool_call',
          toolCallId: this.currentToolId,
          title: event.name,
          kind: TOOL_KIND[event.name] ?? 'other',
          status: 'in_progress',
          rawInput: event.args,
        };
      }
      case 'tool_execution_end': {
        const id = this.currentToolId ?? `call_${++this.toolSeq}`;
        this.currentToolId = null;
        return {
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status: event.ok ? 'completed' : 'failed',
          rawOutput: { output: stringifyResult(event.result) },
        };
      }

      case 'thinking': {
        if (event.phase === this.lastPhase) return null;
        this.lastPhase = event.phase;
        return {
          sessionUpdate: 'notice',
          severity: 'info',
          title: PHASE_TITLE[event.phase] ?? `正在处理（${event.phase}）`,
        };
      }

      case 'error':
        return {
          sessionUpdate: 'notice',
          severity: event.level === 'fail' ? 'error' : 'warning',
          title: event.message,
        };

      // ── 以下一律不外发 ──
      // usage：ACP 里用量属于"一轮的结果"，应在 session/prompt 的响应里返回；
      //        而本版 chat 的 result 仍是字符串（保持与既有客户端兼容），无处安放，
      //        故先不发。等做全量 ACP 对齐（result 改成 {stopReason, usage}）时再接。
      // agent_end / message_end：最终响应本身就是收尾信号，不必重复报一次。
      // prompt_* / llm_request_* / compaction_* / note_* / check_*：内部记账，外泄即成契约。
      default:
        return null;
    }
  }
}

/** 工具结果转成字符串（结果类型不定：字符串 / 对象 / undefined） */
function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined || result === null) return '';
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

/**
 * 这条更新对端该怎么处理。
 *   chunk    —— 累加到上一条后面（流式正文 / 推理）
 *   discrete —— 新建或替换状态（工具调用、提示、错误）
 * 判据取自命名：ACP 的流式片一律以 _chunk 结尾。
 */
export function updateShape(update: SessionUpdate): 'chunk' | 'discrete' {
  return update.sessionUpdate.endsWith('_chunk') ? 'chunk' : 'discrete';
}

/** 包成 ACP 的 session/update notification */
export function toNotification(sessionId: string, update: SessionUpdate): RpcNotification {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } };
}
