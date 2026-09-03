/**
 * 事件总线接口（core 层公共契约）。
 * 调用方：Runtime（emit 事件）、loop/（emit 工具/流事件）、UI（subscribe 展示）
 * 服务于：抽象事件订阅/发射，隔离具体实现（runtime/events.ts 的 PromptEventEmitter）
 *
 * 事件类型定义保留在 runtime/events.ts（RuntimeEvent），这里只定义总线行为契约。
 *
 * 双类型参数（TIn / TOut）：
 *   TIn  = 生产端发射的"草稿"（不含公共头）
 *   TOut = 消费端收到的完整事件（总线已盖上 at / seq / turnId）
 *   默认 TOut = TIn，旧的单参数写法 EventBus<X> 行为不变。
 */

/**
 * 一段可观测行为的句柄（"打卡记录"）—— beginSpan / beginNote 返回。
 * 进门时已发出 start 事件；end()/fail() 时发出配对的 end 事件。
 *
 * 为什么要有它：观测的本质是"一段行为的开始与结束"，而不是一个个孤立的点。
 * 生产端手工发两条 emit 必然会漏（工具抛异常时忘发 end），交给句柄就漏不掉。
 */
export interface Span {
  /** 本段唯一 ID —— 消费端靠它把 start 与 end 配成一条完整记录（不靠名字猜） */
  readonly spanId: string;
  /** 段名（骨架 span 是 'llm_request' 等；便签是调用方任意起的名字） */
  readonly name: string;
  /** 进门时刻（Date.now() 毫秒）—— 供生产端算 firstTokenMs 之类的相对时延 */
  readonly startedAt: number;
  /** 是否已收束（重复 end/fail 会被忽略，防重复打卡） */
  readonly closed: boolean;
  /** 中途补记字段（会并入出门事件；trace() 回调里靠它把结果交出来） */
  set(attrs: Record<string, unknown>): void;
  /** 正常出门：发 end 事件，自动带 status='ok' 与 durationMs。attrs 可覆盖 status */
  end(attrs?: Record<string, unknown>): void;
  /** 异常出门：发 end 事件，status='error' + error 文本。不吞异常，重抛由调用方决定 */
  fail(err: unknown): void;
}

/**
 * 打卡能力 —— EventBus 的可观测扩展契约。
 * 调用方：runtime.ts（prompt 段）、loop/agent-loop.ts（LLM 往返段、工具段）、
 *         context/compaction.ts（压缩段）、用户扩展 hook（便签段）
 * 服务于：把"一段行为"的边界与耗时交给总线统一记录，消费者只做字段映射
 *
 * 两种通道（对应"身份证 / 便签纸"）：
 *   - beginSpan / trace      骨架事件：事件类型就是 `<name>_start` / `<name>_end`，
 *                            载荷字段由 runtime/events.ts 的 interface 约束，UI 直接消费
 *   - beginNote / traceNote  自由事件：事件类型固定 note_start / note_end，段名放在 name 字段，
 *                            载荷是自由字典 —— 用户加观测点不必改核心类型
 */
export interface SpanRecorder {
  /** 开一段骨架 span（进门即发 `<name>_start`） */
  beginSpan(name: string, attrs?: Record<string, unknown>): Span;
  /** 开一段便签 span（进门即发 `note_start`） */
  beginNote(name: string, attrs?: Record<string, unknown>): Span;
  /** 包住一段异步逻辑：进门/出门自动打卡，抛错也打卡后原样重抛（配对结构上不可能漏） */
  trace<T>(name: string, attrs: Record<string, unknown>, fn: (span: Span) => Promise<T>): Promise<T>;
  /** 便签版 trace */
  traceNote<T>(name: string, attrs: Record<string, unknown>, fn: (span: Span) => Promise<T>): Promise<T>;
}

/**
 * 空打卡器 —— 什么都不发，只保证业务逻辑照常跑完。
 * 调用方：spanRecorderOf（总线不具备打卡能力时的退化返回）
 * 服务于：让生产端的 trace()/beginSpan() 调用点不必判空——
 *   测试替身（verify-c2/c3 的 noopEvents）、未接观测的旧总线都能直接跑，
 *   业务代码不需要为"有没有观测"写两套分支。
 */
function noopSpan(name: string): Span {
  return {
    spanId: '',
    name,
    startedAt: Date.now(),
    closed: false,
    set: () => {},
    end: () => {},
    fail: () => {},
  };
}

export const NOOP_SPAN_RECORDER: SpanRecorder = {
  beginSpan: (name) => noopSpan(name),
  beginNote: (name) => noopSpan(name),
  trace: (_name, _attrs, fn) => fn(noopSpan(_name)),
  traceNote: (_name, _attrs, fn) => fn(noopSpan(_name)),
};

/**
 * 取总线的打卡能力：有则用真的，没有则退化成空打卡器。
 * 调用方：loop/agent-loop.ts、context/compaction.ts（依赖只声明 EventBus，不强求打卡能力）
 * 服务于：把"这条总线支不支持观测"的判定收在一处，生产端拿到的永远是可调用的 SpanRecorder
 */
export function spanRecorderOf(bus: EventBus | undefined): SpanRecorder {
  const candidate = bus as (EventBus & Partial<SpanRecorder>) | undefined;
  if (!candidate) return NOOP_SPAN_RECORDER;
  return typeof candidate.beginSpan === 'function' && typeof candidate.trace === 'function'
    ? (bus as EventBus & SpanRecorder)
    : NOOP_SPAN_RECORDER;
}

/** 事件总线接口（TIn = 生产端发射的事件，TOut = 消费端收到的事件） */
export interface EventBus<TIn = unknown, TOut = TIn> {
  /** 注册通配监听 —— 收到所有事件，用于 UI 展示（只看不说） */
  subscribe(handler: (event: TOut) => void): () => void;
  /** 注册精确监听 —— 只收某类事件，可返回结果影响流程（看了还要改） */
  on(type: string, handler: (event: TOut) => unknown): () => void;
  /** 发射事件 —— 通知所有 subscribe 订阅者 */
  emit(event: TIn): void;
  /** 发射钩子事件 —— 通知 on('xxx') 订阅者，收集返回结果（供 SystemPromptService 等调用） */
  emitHook?(type: string, event: TIn): Promise<unknown>;
}

/**
 * 一段已收束的完整行为（消费端视角）—— 进门与出门两条事件合并后的成品。
 * 调用方：trace-log watcher（落盘成一行）、/traces 命令（内存展示）
 * 服务于：把"两条事件"还原成"一段行为"，让每个消费者不必各自实现一遍配对
 *
 * 与 Span 的分工：Span 是生产端手里的句柄（还没结束、可以继续 set），
 * CollectedSpan 是消费端拿到手的成品（已经结束、字段齐全、只读）。
 */
export interface CollectedSpan {
  /** 段名（骨架段取自事件类型前缀；便签段取自 name 字段） */
  readonly name: string;
  readonly spanId: string;
  readonly turnId: string;
  /** 进门事件的序号（不是出门的 —— 一段的"发生位置"以进门为准） */
  readonly seq: number;
  /** 进门时刻（Date.now() 毫秒）。格式化是消费者的事：落盘转 ISO，上屏转相对秒 */
  readonly startedAt: number;
  readonly durationMs: number;
  /** 'ok' / 'error' / 'unclosed'（退出时仍未关门）/ 'running'（还没出门，仅 running() 里出现） */
  readonly status: string;
  /** 进门载荷（已剥掉信封字段） */
  readonly input: Record<string, unknown>;
  /** 出门载荷（已剥掉信封字段；含中途 set 进去的字段） */
  readonly output: Record<string, unknown>;
  /** 异常文本（仅 status='error' 时有；其余情况不给这个键，而不是给 undefined） */
  readonly error?: string;
}

/**
 * 配对能力 —— 消费端的 SpanRecorder 对称物（一个帮生产端打卡，一个帮消费端收段）。
 * 契约在此，实现在 runtime/span-collector.ts 的 SpanCollectorImpl。
 * 调用方：trace-log watcher 与 /traces 命令各持一个独立实例
 * 服务于：把"start 与 end 靠 spanId 认亲"这件事只做一份实现
 *
 * 为何共用代码而不共用实例：总线的意义就是多个消费者互不知情。
 * 落盘型与展示型各自订阅、各自配对，一个关掉不影响另一个；
 * 更关键的是依赖方向：核心命令不能反过来依赖一个可选扩展。
 */
export interface SpanCollector {
  /** 喂一个事件：正好收束出一段就返回它，否则返回 null（进门事件与无关事件都是 null） */
  feed(event: unknown): CollectedSpan | null;
  /** 挂到总线上自动喂（成段进内部环形队列），返回退订函数 */
  attach(bus: EventBus): () => void;
  /** 最近收束的段（新的在后），上限由构造时的容量决定 */
  recent(): CollectedSpan[];
  /** 仍未关门的段（status='running'，durationMs 算到此刻）—— 只窥视，不清空 */
  running(): CollectedSpan[];
  /** 取出所有未关门的段并标成 unclosed，同时清空（进程退出时用） */
  drainUnclosed(now?: number): CollectedSpan[];
}
