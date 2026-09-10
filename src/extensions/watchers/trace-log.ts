/**
 * trace-log watcher —— 把成对的 span 事件落成"一行一段完整行为"的 JSONL。
 * 调用方：extension-loader（自动扫描 src/extensions/watchers/，export registerWatchers 即装载）
 * 服务于：给骨架 span（prompt/llm_request/tool_call/compaction）与便签 span（note_*）
 *         一个开箱即用的落盘消费者，让"某次行为花了多久、成没成、输入输出是什么"可回放
 *
 * 开关：FLINT_TRACE=1（不设则本 watcher 立即返回，不订阅、零开销）
 *       FLINT_TRACE_FILE 可改输出路径（缺省项目根 trace.jsonl）
 *
 * 为什么住在 watchers/ 而不是 hooks/：两者都是扩展、都自动装载，但用的钥匙不同——
 *   hook    用 ctx.on(type, handler)，返回值经 emitHook 收回，能改写流程（如 before_request 改消息数组）
 *   watcher 用 ctx.events.subscribe(handler)，通配收所有事件、返回值没人收：只看只录，拦不住任何人
 * 本文件属于后者（配对落盘，从不影响对话走向），所以 registerWatchers 的 ctx 里刻意不给 on ——
 * "旁观者改流程"这件事在类型层面就不可能，不必靠注释提醒。
 *
 * 为什么写成扩展而不是核心代码：落盘位置/格式/开关都是可替换的"选择"，
 * 换成 LangSmith / LangFuse 只是在本目录再放一个文件，核心与 UI 一行不改。
 * 这正是"先补事件语义，再选消费者"的兑现方式。
 *
 * 本文件现在只管三件事：开关判定、落盘格式、退出补记。
 * 配对（进门登记 / spanId 认亲 / 孤儿 end 忽略 / 信封剥离）已抽到 runtime/span-collector.ts，
 * 与 /traces 命令共用同一份实现、各持独立实例 —— 落盘的关掉不影响上屏的，
 * 核心命令也不必反过来依赖这个可选扩展。
 */
import { appendFileSync } from 'node:fs';
import type { CollectedSpan, EventBus } from '../../core/events.js';
import { SpanCollectorImpl } from '../../runtime/span-collector.js';

/**
 * 落盘格式：CollectedSpan → 一行 JSON。
 * startedAt 到这里才转 ISO 字符串 —— 收集器交出来的是毫秒数，因为上屏的消费者要拿它算相对秒；
 * "用什么时间格式"属于落盘这个选择的一部分，所以留在 watcher，不塞进公共件。
 */
function toRecord(s: CollectedSpan): Record<string, unknown> {
  return {
    name: s.name,
    spanId: s.spanId,
    turnId: s.turnId,
    seq: s.seq,
    startedAt: new Date(s.startedAt).toISOString(),
    durationMs: s.durationMs,
    status: s.status,
    input: s.input,
    output: s.output,
    ...(s.error !== undefined ? { error: s.error } : {}),
  };
}

/** 落一行（同步追加：进程硬退出也不丢已写内容） */
function write(file: string, record: Record<string, unknown>): void {
  try {
    appendFileSync(file, JSON.stringify(record) + '\n');
  } catch {
    /* 落盘失败不阻塞对话（观测是旁路，不能反噬主流程） */
  }
}

/** 注册 watcher 扩展（只订阅、不改流程，故 ctx 里没有 on） */
export function registerWatchers(ctx: {
  events: EventBus;
}): void {
  if (process.env.FLINT_TRACE !== '1') return;
  const file = process.env.FLINT_TRACE_FILE ?? 'trace.jsonl';
  // 容量 0：落盘型消费者只用 feed 的返回值，不必在内存里再留一份历史
  const collector = new SpanCollectorImpl({ capacity: 0 });

  ctx.events.subscribe((raw) => {
    const span = collector.feed(raw);
    if (span) write(file, toRecord(span));
  });

  // 进程退出时把仍没关门的段记下来：这类"漏关门"过去是静默的（消费者永远以为它还在跑），
  // 现在会在日志里留下一条 status='unclosed'，一眼可见
  process.on('exit', () => {
    for (const span of collector.drainUnclosed()) write(file, toRecord(span));
  });
}
