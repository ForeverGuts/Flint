/**
 * 事件订阅系统 —— 参考 Pi 的 subscribe/emit 分层模式。
 *
 * 两层事件（类似 Pi 的 AgentEvent | AgentHarnessOwnEvent）：
 *   1. AgentEvent        ← agent loop 层（prompt 内部发射）
 *   2. HarnessEvent      ← harness 编排层（队列、配置等）
 *   └─ RuntimeEvent      ← 两者的联合，订阅者接收此类型
 *
 * 两层订阅：
 *   1. subscribe(handler)       ← 通配：收到所有事件，用于 UI 展示（只看不说）
 *   2. on(type, handler)        ← 精确：只收某类事件，可返回结果影响流程（看了还要改）
 */

/* ===================================================================== */
/*  第一层：AgentEvent — Agent Core 生命周期事件                          */
/*  对应 Pi 的 AgentEvent（types.ts）                                    */
/* ===================================================================== */

/** 流式文本块（LLM 每输出一个 token 触发一次） */
export interface StreamTextEvent {
  type: 'stream_text';
  text: string;
}

/** 一条消息完成 */
export interface MessageEndEvent {
  type: 'message_end';
}

/** 工具执行开始 */
export interface ToolExecutionStartEvent {
  type: 'tool_execution_start';
  name: string;
  args: Record<string, unknown>;
}

/** 工具执行结束 */
export interface ToolExecutionEndEvent {
  type: 'tool_execution_end';
  name: string;
  result: unknown;
}

/** Agent 运行结束（一轮 prompt 完全完成） */
export interface AgentEndEvent {
  type: 'agent_end';
}

/** Token 用量事件（本轮 + 累计） */
export interface UsageEvent {
  type: 'usage';
  /** 本轮用量 */
  current: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** 累计用量 */
  total: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** Agent 开始思考（用户输入后、LLM 响应前） */
export interface ThinkingEvent {
  type: 'thinking';
  /** 思考阶段标识：'analyzing' | 'compressing' | 'calling_tools' | 'streaming' */
  phase: string;
}

/** 错误（结构化，复用 Diagnostic 语义；level 可选，默认 warn） */
export interface ErrorEvent {
  type: 'error';
  /** 级别：fail=阻断 / warn=警告 */
  level?: import('../types.js').DiagnosticLevel;
  /** 来源标识：llm / tool / config / network 等 */
  item?: string;
  /** 人类可读错误说明 */
  message: string;
}

/** Agent 层事件联合 */
export type AgentEvent =
  | ThinkingEvent
  | StreamTextEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | UsageEvent
  | AgentEndEvent
  | ErrorEvent;

/* ===================================================================== */
/*  第二层：HarnessEvent — 编排层事件                                    */
/*  对应 Pi 的 AgentHarnessOwnEvent（harness/types.ts）                  */
/* ===================================================================== */

// TODO: prompt 开始/结束
// export interface PromptStartEvent { type: 'prompt_start'; input: string }
// export interface PromptEndEvent   { type: 'prompt_end'; reply: string }

// TODO: 队列状态变更
// export interface QueueUpdateEvent { type: 'queue_update'; followUpCount: number }

// TODO: 上下文构建
// export interface ContextEvent      { type: 'context'; messages: unknown[] }

/** 启动自检开始（Harness.run 调 check() 前发射） */
export interface CheckStartEvent {
  type: 'check_start';
}

/** 启动自检完成（携带逐项诊断结果，供 UI/订阅者展示） */
export interface CheckDoneEvent {
  type: 'check_done';
  /** 各检查项诊断（配置/API key/连通性/模型列表等） */
  diagnostics: import('../types.js').Diagnostic[];
}

/** Harness 层事件联合 */
export type HarnessEvent =
  | CheckStartEvent
  | CheckDoneEvent;

/* ===================================================================== */
/*  联合类型 — 订阅者接收的总类型                                        */
/* ===================================================================== */

/** 所有运行时事件的联合（类似 Pi 的 AgentHarnessEvent） */
export type RuntimeEvent = AgentEvent | HarnessEvent;

/** 通配订阅的 handler 签名 */
export type EventHandler = (event: RuntimeEvent) => void;

/** Hook 事件映射 */
export interface HookEventResultMap {
  context?: { messages: unknown[] };
}

export type HookHandler = (event: RuntimeEvent) => unknown;

/* ===================================================================== */
/*  PromptEventEmitter                                                    */
/* ===================================================================== */

export class PromptEventEmitter {
  private subscribers = new Set<EventHandler>();
  private hooks = new Map<string, Set<HookHandler>>();

  /**
   * 注册通配监听 —— 收到所有事件，用于 UI 展示。
   * 只看不说：能接收事件更新界面，但不能返回结果影响流程。
   */
  subscribe(handler: EventHandler): () => void {
    this.subscribers.add(handler);
    return () => { this.subscribers.delete(handler); };
  }

  /**
   * 注册精确监听 —— 只收某类事件，可返回结果影响流程。
   * 看了还要改：能接收到特定事件，handler 返回值可被 Runtime 使用。
   */
  on(type: string, handler: HookHandler): () => void {
    if (!this.hooks.has(type)) this.hooks.set(type, new Set());
    this.hooks.get(type)!.add(handler);
    return () => { this.hooks.get(type)?.delete(handler); };
  }

  /** 发射事件 —— 通知所有 subscribe 订阅者 */
  emit(event: RuntimeEvent): void {
    for (const handler of this.subscribers) {
      handler(event);
    }
  }

  /** 发射钩子事件 —— 通知 on('xxx') 订阅者，收集返回结果（供 SystemPromptService 等调用） */
  async emitHook(type: string, event: RuntimeEvent): Promise<unknown> {
    const handlers = this.hooks.get(type);
    if (!handlers) return undefined;

    let lastResult: unknown;
    for (const handler of handlers) {
      const result = await handler(event);
      if (result !== undefined) lastResult = result;
    }
    return lastResult;
  }

  /** 清空所有订阅 */
  clearSubscribers(): void {
    this.subscribers.clear();
    this.hooks.clear();
  }
}
