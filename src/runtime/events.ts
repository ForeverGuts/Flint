/**
 * 事件订阅系统 —— 参考 Pi 的 subscribe/emit 分层模式。
 * 调用方：Runtime / AgentLoop / Compaction（emit 与打卡）、TreeUI / RPC / 扩展 hook（subscribe）
 * 服务于：把系统内部发生的事广播出去；本文件是全部事件契约的唯一真源
 *
 * 四类事件：
 *   1. AgentEvent   ← agent loop 层（流式文本、工具执行、用量）—— 给 UI 看的"画面"
 *   2. SpanEvent    ← 骨架 span 层（prompt / llm_request / tool_call / compaction 四段的进门与出门）
 *                     —— 给观测后端看的"账本"：有边界、有耗时、有成败、有 spanId 可配对
 *   3. NoteEvent    ← 便签 span 层（note_start / note_end）—— 用户扩展想圈什么就圈什么，核心零改动
 *   4. HarnessEvent ← harness 编排层（启动自检）
 *
 * 两种类型（生产端 / 消费端不是同一个类型）：
 *   RuntimeEventIn = 生产端发射的"草稿"（四类事件的联合，不含公共头）
 *   RuntimeEvent   = 消费端收到的完整事件（草稿 & EventMeta —— 总线在 emit 时统一盖 at/seq/turnId）
 *   为什么分开：时间戳/序号只有总线知道（生产端各写各的必然漏、必然不一致），
 *              让它成为总线的职责，生产端就只管说"发生了什么"。
 *
 * 两层订阅：
 *   1. subscribe(handler)       ← 通配：收到所有事件，用于 UI 展示（只看不说）
 *   2. on(type, handler)        ← 精确：只收某类事件，可返回结果影响流程（看了还要改）
 */
import type { EventBus, Span, SpanRecorder } from '../core/events.js';
import type { LLMUsage } from '../llm/types.js';

/* ===================================================================== */
/*  公共头 — 总线在 emit() 时统一盖上（生产端不写、也写不了）              */
/* ===================================================================== */

/**
 * 事件元信息（每条事件出总线时必带）。
 * 作用：让"完全不知情的旁观者"仅凭日志就能排序、分组、配对——
 *   at     何时发生（旧实现只有落盘时才拼时间戳，内存里的事件全都没有时间）
 *   seq    第几条（同一 turn 内从 0 自增；消费端可据此发现丢事件）
 *   turnId 属于哪一次 prompt（把散落的事件收成一组，是重建调用树的地基）
 */
export interface EventMeta {
  /** 发射时刻（Date.now() 毫秒） */
  at: number;
  /** 本次 prompt 内的序号（beginTurn 归零，之后每条 +1） */
  seq: number;
  /** 所属 prompt 的分组 ID（未进入任何 prompt 时为 ''，如启动自检事件） */
  turnId: string;
}

/* ===================================================================== */
/*  第一层：AgentEvent — Agent Core 生命周期事件（给 UI 的"画面"）        */
/* ===================================================================== */

/** 流式文本块（LLM 每输出一个 token 触发一次） */
export interface StreamTextEvent {
  type: 'stream_text';
  text: string;
}

/**
 * 流式思维链推理片段（阶段 C1：thinking 开启时，模型先推理再作答）。
 * 先于 stream_text 到达；不进回复文本/会话历史，仅供 UI 展示（展示不持久）。
 */
export interface StreamReasoningEvent {
  type: 'stream_reasoning';
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

/**
 * 工具执行结束。
 * ok 字段是本次改造补的语义缺口：过去消费端只能拿 result 做子串猜测
 * （includes('✅') / includes('失败')）来判断红绿——工具输出里出现"失败"两个字
 * 就会被误判成红色。成败只有生产端知道，必须由生产端说。
 *
 * 与 tool_call_end 的分工：本事件给 UI 画框（含完整结果文本），
 * tool_call_end 给观测后端记账（含耗时/状态，不含结果正文）。两者并存不冲突。
 */
export interface ToolExecutionEndEvent {
  type: 'tool_execution_end';
  name: string;
  result: unknown;
  /** 是否成功（false = 抛异常 / [ERROR] / [VERIFY_FAILED] / [INVALID] / 用户拒绝） */
  ok: boolean;
}

/** Agent 运行结束（一轮 prompt 完全完成） */
export interface AgentEndEvent {
  type: 'agent_end';
}

/** Token 用量事件（本轮 + 累计）。缓存明细字段有报才有，全程无报缺省 */
export interface UsageEvent {
  type: 'usage';
  /** 本轮用量 */
  current: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  /** 累计用量 */
  total: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

/** Agent 开始思考（用户输入后、LLM 响应前） */
export interface ThinkingEvent {
  type: 'thinking';
  /**
   * 思考阶段标识。实际发射的只有三个：
   *   'analyzing'   → 已收到输入、还没发请求（runtime.ts）
   *   'compressing' → 正在压缩历史（compaction.ts）
   *   'streaming'   → 请求已发出、等首字（runtime.ts）
   * 工具执行期不发本事件：那段由 tool_execution_start / tool_call_start 承载。
   */
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
  | StreamReasoningEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | UsageEvent
  | AgentEndEvent
  | ErrorEvent;

/* ===================================================================== */
/*  第二层：SpanEvent — 骨架 span（路 A：身份证，强类型，UI 直接消费）     */
/*                                                                     */
/*  四段覆盖三重循环：                                                   */
/*    prompt      外层（runtime.ts while：一次用户输入含全部 followUp）   */
/*    llm_request 中层（agent-loop.ts for turn：一次 LLM 网络往返）       */
/*    tool_call   内层（agent-loop.ts for tc：一次工具执行）              */
/*    compaction  旁支（compaction.ts：一次历史压缩摘要调用）             */
/*                                                                     */
/*  为什么必须成对：一次带 3 个工具的 prompt 实际发生 4 次 LLM 往返，      */
/*  过去对外一个边界事件都没有 —— 四次网络请求被压成一个不可分割的黑盒，   */
/*  "单次 LLM 多久""首字多慢""压缩占了多少时间"永久无法回答。             */
/* ===================================================================== */

/**
 * 段的收束状态（三个值全部有发射点，不留空语义）。
 * ok=正常 / empty=跑完但没有内容（空流）/ error=异常
 * 异常细节看 error 字段；"失败后是否已切兜底供应商"不占用状态位——
 * 重试会开出新的一段 llm_request（带新 model），比一个 switched 标记信息量大。
 */
export type SpanStatus = 'ok' | 'empty' | 'error';

/** ① prompt 段 · 进门 */
export interface PromptStartEvent {
  type: 'prompt_start';
  spanId: string;
  /** 用户原始输入（生产端截断到 200 字，防整篇文章灌进日志） */
  input: string;
}

/** ① prompt 段 · 出门（结果字段可缺：status=error 时确实没有回复可报） */
export interface PromptEndEvent {
  type: 'prompt_end';
  spanId: string;
  status: SpanStatus;
  durationMs: number;
  /** 最终回复（生产端截断到 200 字） */
  reply?: string;
  /** 实际处理的单轮数（followUp / steering 会 > 1） */
  turns?: number;
  /** 截至本次 prompt 结束的累计用量 */
  totalUsage?: LLMUsage;
  error?: string;
}

/** ② llm_request 段 · 进门 */
export interface LLMRequestStartEvent {
  type: 'llm_request_start';
  spanId: string;
  /** Agent Loop 内第几轮（0 起） */
  turn: number;
  /** 本轮实际使用的模型（onFallback 会切供应商，只有 turn 级的值才是真值） */
  model: string;
  /** 发出去的消息条数 */
  messageCount: number;
  /** 随请求下发的工具定义数 */
  toolCount: number;
  /** thinking 按次覆盖值；缺省 = 未覆盖（跟 Provider 配置走，真实值只有 Provider 知道） */
  thinking?: boolean;
}

/**
 * ② llm_request 段 · 出门。
 * 结果字段全部可缺：流中途抛异常时 span.set() 根本没机会跑，
 * 这时确实没有首字延迟/字数/用量可报——把它们写成必填就是在逗消费端，
 * 也会逼出伪报的 0（与"真的收到 0 个字"无法区分）。status/durationMs 由总线算，永远在。
 */
export interface LLMRequestEndEvent {
  type: 'llm_request_end';
  spanId: string;
  status: SpanStatus;
  durationMs: number;
  /**
   * TTFT（首字延迟，毫秒）；null = 一个字都没收到；字段缺失 = 流异常中断（无从统计）。
   * 只能在收到第一个 token 的那一刻量 —— 出了这个作用域永久丢失，
   * 任何下游消费者都无法重建，所以必须由生产端记。
   */
  firstTokenMs?: number | null;
  /** 回复字符数（正文全文已由 stream_text 逐片给过 UI，这里只留体量） */
  textLength?: number;
  /** 本轮模型决定调用的工具数 */
  toolCallCount?: number;
  /**
   * API 返回的真实用量；null = Provider 没给（区别于 0）。
   * 两条流式协议都已接上：OpenAI 兼容端靠 stream_options.include_usage 显式索取
   * （撞上不认这个参数的端点会自动降级，此时为 null），
   * Anthropic 由 message_start（输入，含缓存写入/命中）+ message_delta（输出累计值）合成。
   * null 时上层回退本地估算，消费端不必区分两者。
   */
  usage?: LLMUsage | null;
  error?: string;
}

/** ③ tool_call 段 · 进门 */
export interface ToolCallStartEvent {
  type: 'tool_call_start';
  spanId: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * ③ tool_call 段 · 出门。
 * resultLength 可缺：工具抛异常时它根本没产出结果，此时字段不存在而不是报 0。
 * （agent-loop 事后拼的 `[工具 X 执行失败]` 文本是兜底话术，不是工具输出，不算体量）
 */
export interface ToolCallEndEvent {
  type: 'tool_call_end';
  spanId: string;
  status: SpanStatus;
  durationMs: number;
  name: string;
  /** 结果字符数（完整结果文本已由 tool_execution_end 给 UI，这里只留体量） */
  resultLength?: number;
  error?: string;
}

/** ④ compaction 段 · 进门 */
export interface CompactionStartEvent {
  type: 'compaction_start';
  spanId: string;
  /** 待压缩的消息条数 */
  msgCount: number;
}

/** ④ compaction 段 · 出门（summaryLength 可缺：摘要调用失败时没有摘要可报） */
export interface CompactionEndEvent {
  type: 'compaction_end';
  spanId: string;
  status: SpanStatus;
  durationMs: number;
  /** 摘要字符数 */
  summaryLength?: number;
  error?: string;
}

/** 骨架 span 事件联合 */
export type SpanEvent =
  | PromptStartEvent
  | PromptEndEvent
  | LLMRequestStartEvent
  | LLMRequestEndEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | CompactionStartEvent
  | CompactionEndEvent;

/**
 * 段名 → 载荷契约（生产端写字段的唯一依据）。
 * 加一个新骨架段 = 在这里加一行 + 定义两个 interface，编译器负责其余全部对齐。
 */
export interface SpanContracts {
  prompt: { start: PromptStartEvent; end: PromptEndEvent };
  llm_request: { start: LLMRequestStartEvent; end: LLMRequestEndEvent };
  tool_call: { start: ToolCallStartEvent; end: ToolCallEndEvent };
  compaction: { start: CompactionStartEvent; end: CompactionEndEvent };
}

/** 合法的骨架段名（写错名字当场编译不过，不会静默发出一条没人消费的事件） */
export type SpanName = keyof SpanContracts;

/** 生产端进门时要给的字段（type / spanId 由总线补） */
export type SpanAttrs<K extends SpanName> = Omit<SpanContracts[K]['start'], 'type' | 'spanId'>;

/** 生产端出门时要给的字段（type / spanId / durationMs / error 由总线补；status 可覆盖，缺省 ok） */
export type SpanResult<K extends SpanName> =
  Omit<SpanContracts[K]['end'], 'type' | 'spanId' | 'status' | 'durationMs' | 'error'>
  & { status?: SpanStatus };

/* ===================================================================== */
/*  第三层：NoteEvent — 便签 span（路 B：核心零改动的自由观测通道）        */
/*                                                                     */
/*  与骨架 span 的区别：事件类型固定为 note_start / note_end，            */
/*  段名降级成 name 字段、载荷是自由字典。                                */
/*  代价是编译器不帮你查字段名；换来的是用户在 hook 里想圈什么就圈什么，   */
/*  不必回头改本文件。骨架事件负责"系统必须观测的四处"，便签负责"临时想看   */
/*  的任意一处"。                                                       */
/* ===================================================================== */

/** 便签段 · 进门 */
export interface NoteStartEvent {
  type: 'note_start';
  spanId: string;
  /** 段名（调用方任意起） */
  name: string;
  /** 自由载荷 */
  attrs: Record<string, unknown>;
}

/** 便签段 · 出门 */
export interface NoteEndEvent {
  type: 'note_end';
  spanId: string;
  name: string;
  status: SpanStatus;
  durationMs: number;
  /** 进门载荷 + 中途 set 的字段合并后的结果 */
  attrs: Record<string, unknown>;
  error?: string;
}

/** 便签 span 事件联合 */
export type NoteEvent = NoteStartEvent | NoteEndEvent;

/* ===================================================================== */
/*  第四层：HarnessEvent — 编排层事件                                    */
/*  对应 Pi 的 AgentHarnessOwnEvent（harness/types.ts）                  */
/* ===================================================================== */

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
/*  联合类型 — 生产端草稿 / 消费端完整事件                                */
/* ===================================================================== */

/** 生产端发射的草稿（四类事件的联合，不含公共头） */
export type RuntimeEventIn = AgentEvent | SpanEvent | NoteEvent | HarnessEvent;

/** 消费端收到的完整事件（草稿 + 总线盖的 at/seq/turnId） */
export type RuntimeEvent = RuntimeEventIn & EventMeta;

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

/** 合法骨架段名集合（beginSpan/trace 传了集合外的名字 → 警告一次，防静默发空事件） */
const SPAN_NAMES = new Set<string>(['prompt', 'llm_request', 'tool_call', 'compaction']);

export class PromptEventEmitter implements EventBus<RuntimeEventIn, RuntimeEvent>, SpanRecorder {
  private subscribers = new Set<EventHandler>();
  private hooks = new Map<string, Set<HookHandler>>();

  /* ── 公共头的三个来源（只有总线知道，所以由总线盖） ── */

  /** 事件序号（beginTurn 归零） */
  private seq = 0;
  /** 当前 prompt 分组 ID（beginTurn 换发） */
  private turnId = '';
  /** prompt 计数（拼 turnId 用，保证同毫秒内的两次 prompt 不同名） */
  private turnCount = 0;
  /** span 计数（拼 spanId 用；消费端靠它配对，不靠段名猜） */
  private spanCount = 0;
  /** 已警告过的非法段名（只警告一次，不刷屏） */
  private warnedNames = new Set<string>();

  /**
   * 开一个新回合（换发 turnId + seq 归零）。
   * 调用方：Runtime.prompt()（仅当 !isStreaming —— 排队中的输入不能掀翻在飞回合的分组）
   */
  beginTurn(): string {
    this.turnId = `t${Date.now().toString(36)}-${++this.turnCount}`;
    this.seq = 0;
    return this.turnId;
  }

  /** 当前 turnId（供诊断/测试读取） */
  currentTurnId(): string {
    return this.turnId;
  }

  /**
   * 注册通配监听 —— 收到所有事件，用于 UI 展示。
   * 只看不说：能接收事件更新界面，但不能返回结果影响流程。
   */
  subscribe(handler: (event: RuntimeEvent) => void): () => void {
    this.subscribers.add(handler as EventHandler);
    return () => { this.subscribers.delete(handler as EventHandler); };
  }

  /**
   * 注册精确监听 —— 只收某类事件，可返回结果影响流程。
   * 看了还要改：能接收到特定事件，handler 返回值可被 Runtime 使用。
   */
  on(type: string, handler: (event: RuntimeEvent) => unknown): () => void {
    if (!this.hooks.has(type)) this.hooks.set(type, new Set());
    this.hooks.get(type)!.add(handler as HookHandler);
    return () => { this.hooks.get(type)?.delete(handler as HookHandler); };
  }

  /**
   * 发射事件 —— 盖上公共头后通知所有 subscribe 订阅者。
   * 盖戳放在这里（而不是让每个生产端自己写）：46 个 catch、39 处 console 散落各文件，
   * 靠自觉必然漏；总线是唯一必经之路，一处改动全量生效。
   */
  emit(event: RuntimeEventIn): void {
    const stamped = { ...event, at: Date.now(), seq: this.seq++, turnId: this.turnId } as RuntimeEvent;
    for (const handler of this.subscribers) {
      handler(stamped);
    }
  }

  /** 发射钩子事件 —— 通知 on('xxx') 订阅者，收集返回结果（供 SystemPromptService 等调用） */
  async emitHook(type: string, event: RuntimeEventIn): Promise<unknown> {
    const handlers = this.hooks.get(type);
    if (!handlers) return undefined;

    let lastResult: unknown;
    for (const handler of handlers) {
      const result = await handler(event as RuntimeEvent);
      if (result !== undefined) lastResult = result;
    }
    return lastResult;
  }

  /* ── 打卡机（SpanRecorder）：把"一段行为"的边界与耗时交给总线 ── */

  /** 开一段骨架 span（进门即发 `<name>_start`）—— 用于跨 return/continue/finally 的场景 */
  beginSpan(name: string, attrs: Record<string, unknown> = {}): Span {
    return this.openSpan(name, attrs, false);
  }

  /** 开一段便签 span（进门即发 `note_start`）—— 用户扩展的自由观测通道 */
  beginNote(name: string, attrs: Record<string, unknown> = {}): Span {
    return this.openSpan(name, attrs, true);
  }

  /**
   * 包住一段异步逻辑：进门/出门自动打卡。
   * 配对由 try/finally 结构保证 —— 业务代码抛异常、提前 return、continue 都漏不掉，
   * 这正是"catch 分支忘发 tool_execution_end"那类 bug 的根治方式。
   * 不吞异常：打完 error 卡后原样重抛，兜底策略仍归调用方。
   */
  async trace<T>(name: string, attrs: Record<string, unknown>, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.runSpan(name, attrs, fn, false);
  }

  /** 便签版 trace */
  async traceNote<T>(name: string, attrs: Record<string, unknown>, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.runSpan(name, attrs, fn, true);
  }

  /** 开门：发 start 事件并返回句柄（note=true 走便签通道） */
  private openSpan(name: string, attrs: Record<string, unknown>, note: boolean): Span {
    if (!note && !SPAN_NAMES.has(name) && !this.warnedNames.has(name)) {
      this.warnedNames.add(name);
      console.warn(`[events] beginSpan/trace 收到未知骨架段名 '${name}'：事件会发出但无人消费。自由段名请改用 beginNote/traceNote。`);
    }
    const spanId = `s${(++this.spanCount).toString(36)}`;
    const startedAt = Date.now();
    let closed = false;
    let extra: Record<string, unknown> = {};

    const close = (status: SpanStatus, errText?: string): void => {
      if (closed) return;   // 防重复打卡（trace 里业务已手动 end 过就不再补）
      closed = true;
      const durationMs = Date.now() - startedAt;
      if (note) {
        this.emit({ type: 'note_end', spanId, name, status, durationMs, attrs: { ...attrs, ...extra }, ...(errText ? { error: errText } : {}) });
        return;
      }
      // 骨架段：事件类型 = `<name>_start` / `<name>_end`，载荷字段由 SpanContracts 约束
      this.emit({ type: `${name}_end`, spanId, status, durationMs, ...extra, ...(errText ? { error: errText } : {}) } as unknown as RuntimeEventIn);
    };

    if (note) {
      this.emit({ type: 'note_start', spanId, name, attrs });
    } else {
      this.emit({ type: `${name}_start`, spanId, ...attrs } as unknown as RuntimeEventIn);
    }

    return {
      spanId,
      name,
      startedAt,
      get closed() { return closed; },
      set: (a) => { extra = { ...extra, ...a }; },
      end: (a) => {
        if (a) extra = { ...extra, ...a };
        close((extra.status as SpanStatus | undefined) ?? 'ok');
      },
      fail: (err) => close('error', err instanceof Error ? err.message : String(err)),
    };
  }

  /** trace/traceNote 的共用实现 */
  private async runSpan<T>(name: string, attrs: Record<string, unknown>, fn: (span: Span) => Promise<T>, note: boolean): Promise<T> {
    const span = this.openSpan(name, attrs, note);
    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (err) {
      span.fail(err);
      throw err;
    }
  }

  /** 清空所有订阅 */
  clearSubscribers(): void {
    this.subscribers.clear();
    this.hooks.clear();
  }
}
