/**
 * 段收集器 —— 把成对的 span 事件合成"一段完整行为"（消费端的配对实现）。
 * 调用方：harness/main.ts（建实例 + attach 到总线，供 /traces 只读展示）、
 *         extensions/watchers/trace-log.ts（建自己的实例，成段即落盘）
 * 服务于：契约见 core/events.ts 的 SpanCollector —— "start 与 end 靠 spanId 认亲"只做一份实现
 *
 * 为什么两个消费者各建一个实例而不共享：总线的意义就是消费者互不知情，
 * 落盘的关掉不该影响上屏的；更重要的是依赖方向——核心命令不能反过来依赖一个可选扩展。
 *
 * 配对规则（从 trace-log 原样迁来，行为一字未变）：
 *   1. 只认带 spanId 的事件：tool_execution_start/end 这类 UI 事件没有 spanId，不参与配对
 *   2. `_start` 进门登记，`_end` 出门合并；孤儿 end（没有配对的进门）忽略而不是猜一个出来
 *   3. 信封字段（type/spanId/at/seq/turnId/status/durationMs/error）不算业务载荷，剥掉避免重复
 *   4. 便签段的载荷本来就在 attrs 里，直接取；骨架段没有 attrs，走逐字段过滤
 */
import type { CollectedSpan, EventBus, SpanCollector } from '../core/events.js';

/** 一条待收束的段（进门时暂存，出门时与 end 事件合并） */
interface OpenSpan {
  name: string;
  spanId: string;
  turnId: string;
  seq: number;
  at: number;
  /** 进门载荷（已剥掉公共头） */
  input: Record<string, unknown>;
}

/**
 * 信封字段（不算业务载荷，合并时剔掉避免与顶层重复）。
 * 注意 name 不在里面：tool_call 段的工具名就叫 name，剔了就把关键信息丢了——
 * 便签段的段名冲突已由 payloadOf 的 attrs 分支隔开（便签载荷全在 attrs 里，不走过滤）。
 */
const ENVELOPE_KEYS = new Set(['type', 'spanId', 'at', 'seq', 'turnId', 'status', 'durationMs', 'error']);

/** 剥掉信封，只留业务载荷 */
function payloadOf(event: Record<string, unknown>): Record<string, unknown> {
  // 便签段的载荷本来就在 attrs 里，直接取（骨架段没有 attrs，走逐字段过滤）
  const attrs = event.attrs;
  if (attrs && typeof attrs === 'object') return { ...(attrs as Record<string, unknown>) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (!ENVELOPE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/** SpanCollectorImpl 构造选项 */
export interface SpanCollectorOptions {
  /** 环形队列容量（默认 200）。0 = 不保留历史：落盘型消费者只用 feed 的返回值，不需要队列 */
  capacity?: number;
}

/** 段收集器实现 */
export class SpanCollectorImpl implements SpanCollector {
  /** 未关门的段：spanId → 进门记录。出门即删；退出时还留在里面的就是"没关门的段" */
  private readonly open = new Map<string, OpenSpan>();
  /** 已收束的段（环形：超出容量就丢最旧的） */
  private readonly done: CollectedSpan[] = [];
  private readonly capacity: number;

  constructor(options: SpanCollectorOptions = {}) {
    this.capacity = options.capacity ?? 200;
  }

  /** 喂一个事件：正好收束出一段就返回它，否则返回 null */
  feed(event: unknown): CollectedSpan | null {
    const e = event as Record<string, unknown>;
    const spanId = e.spanId;
    // 只认带 spanId 的事件：tool_execution_start/end 这类 UI 事件没有 spanId，不参与配对
    if (typeof spanId !== 'string' || !spanId) return null;
    const type = typeof e.type === 'string' ? e.type : '';

    /* ── 进门：暂存，等它的出门事件 ── */
    if (type.endsWith('_start')) {
      this.open.set(spanId, {
        name: type === 'note_start' ? String(e.name ?? 'note') : type.slice(0, -'_start'.length),
        spanId,
        turnId: String(e.turnId ?? ''),
        seq: Number(e.seq ?? -1),
        at: Number(e.at ?? Date.now()),
        input: payloadOf(e),
      });
      return null;
    }
    if (!type.endsWith('_end')) return null;

    /* ── 出门：与进门记录合并成一条完整行为 ── */
    const start = this.open.get(spanId);
    this.open.delete(spanId);
    if (!start) return null;   // 孤儿 end（没有配对的进门）：忽略而不是猜一个出来

    const at = Number(e.at ?? Date.now());
    const error = typeof e.error === 'string' ? e.error : undefined;
    const span: CollectedSpan = {
      name: start.name,
      spanId,
      turnId: start.turnId,
      seq: start.seq,
      startedAt: start.at,
      durationMs: at - start.at,
      status: String(e.status ?? 'ok'),
      input: start.input,
      output: payloadOf(e),
      // exactOptionalPropertyTypes：无异常时不给这个键，而不是给 undefined
      ...(error !== undefined ? { error } : {}),
    };
    this.retain(span);
    return span;
  }

  /** 挂到总线上自动喂（成段进环形队列），返回退订函数 */
  attach(bus: EventBus): () => void {
    return bus.subscribe((event) => {
      this.feed(event);
    });
  }

  recent(): CollectedSpan[] {
    return [...this.done];
  }

  running(): CollectedSpan[] {
    const now = Date.now();
    return [...this.open.values()].map((s) => this.shape(s, now, 'running'));
  }

  drainUnclosed(now: number = Date.now()): CollectedSpan[] {
    const out = [...this.open.values()].map((s) => this.shape(s, now, 'unclosed'));
    this.open.clear();
    return out;
  }

  /** 环形保留：容量 0 表示不留历史（落盘型消费者只用 feed 的返回值） */
  private retain(span: CollectedSpan): void {
    if (this.capacity <= 0) return;
    this.done.push(span);
    if (this.done.length > this.capacity) this.done.shift();
  }

  /** 把一条进门记录投影成 CollectedSpan（running / unclosed 两种"没出门"的状态共用） */
  private shape(s: OpenSpan, now: number, status: string): CollectedSpan {
    return {
      name: s.name,
      spanId: s.spanId,
      turnId: s.turnId,
      seq: s.seq,
      startedAt: s.at,
      durationMs: now - s.at,
      status,
      input: s.input,
      output: {},
    };
  }
}
