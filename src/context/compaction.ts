/**
 * 上下文管理子系统 —— 会话压缩（compaction）。
 * 调用方：Runtime（runSingleTurn 开头调用 maybeCompact）
 * 服务于：历史超限时用 LLM 总结早期消息，压缩结果作为 compaction 入树，
 *         让上下文保持在 LLM 窗口内
 *
 * 依赖：llm（chat 生成摘要）+ events（thinking 事件 + compaction 段打卡）。
 *       storage（CompactionStore）**每次调用传入**——runtime 会切换会话（/sessions、fork），
 *       构造期绑死会把摘要写进旧会话文件（2026-09-12 修复）。
 * 不依赖具体存储实现（InMemory/Mock 无 compaction 能力时为 no-op）。
 *
 * 可观测：压缩是一次完整的 LLM 摘要调用（可能十几秒），过去对外只发一个
 * thinking{'compressing'} —— 一个没有边界、没有耗时的黑箱。现在包在 compaction span 里。
 */
import type { LLMProvider, LLMUsage } from '../llm/types.js';
import type { CompactionStore } from '../core/compaction-store.js';
import type { EventBus } from '../core/events.js';
import { spanRecorderOf } from '../core/events.js';
import type { SpanAttrs, SpanResult } from '../runtime/events.js';
import type { CompactionResult, CompactionService } from '../core/compaction.js';

/** 压缩阈值：历史超过此条数触发压缩 */
const COMPACT_THRESHOLD = 20;
/** 压缩后保留的最近条数 */
const KEEP_RECENT = 10;

/** CompactionService 构造依赖（storage 2026-09-12 起改为每次调用传入——runtime 会切换会话，
 *  构造期绑死会把摘要写进旧会话文件，见 core/compaction.ts 契约注释） */
export interface CompactionDeps {
  /** LLM（生成摘要） */
  llm: LLMProvider;
  /** 事件总线（发 thinking:compressing 事件 + compaction 段打卡；无打卡能力时自动退化为空打卡器） */
  events?: EventBus | undefined;
}

/** 上下文管理子系统实现 */
export class CompactionServiceImpl implements CompactionService {
  constructor(private deps: CompactionDeps) {}

  /**
   * 上下文压缩：读当前 history，超限时生成摘要并压缩。
   * @param history 当前对话历史（从 storage.getMessages() 读取）
   * @param storage 压缩存储（每次调用显式传入；无则跳过压缩）
   * @returns 压缩结果：history（不含摘要）+ 独立 summary（供 SystemPromptService 摘要层用）
   */
  async maybeCompact(
    history: Array<{ role: string; content: string }>,
    storage?: CompactionStore,
  ): Promise<CompactionResult> {
    if (!storage) return { history, summary: undefined };

    // 已有摘要：取最后一个 compaction 的 summary
    let compressedSummary = '';
    const compactions = storage.getCompactions();
    if (compactions.length > 0) {
      compressedSummary = compactions[compactions.length - 1].summary;
    }

    // 本轮触发压缩时的用量（compactTo 带回；不压缩则缺省）
    let compactionUsage: LLMUsage | undefined;
    if (history.length > COMPACT_THRESHOLD) {
      const r = await this.compactTo(storage, history, KEEP_RECENT);
      history = r.history;
      if (r.summary) compressedSummary = r.summary;
      if (r.usage) compactionUsage = r.usage;
    }

    // 摘要独立返回（不 unshift 进 history，避免污染缓存前缀）；用量随行（runtime 入账 /usage）
    return {
      history,
      summary: compressedSummary || undefined,
      ...(compactionUsage ? { usage: compactionUsage } : {}),
    };
  }

  /**
   * 强制压缩（fork 摘要用）：不判阈值，直接压缩到"摘要 + 最近 keepRecent 条"。
   * 前缀不足 keepRecent 条时不压缩（摘要一段短前缀没有收益，等同普通分叉）。
   */
  async compactNow(
    history: Array<{ role: string; content: string }>,
    storage?: CompactionStore,
    opts?: { keepRecent?: number },
  ): Promise<CompactionResult> {
    if (!storage) return { history, summary: undefined };
    const keep = opts?.keepRecent ?? KEEP_RECENT;
    if (history.length <= keep) return { history, summary: undefined };
    return this.compactTo(storage, history, keep);
  }

  /**
   * 压缩主体（maybeCompact 与 compactNow 共用，行为与抽取前逐字一致）：
   * 取"全部消息 id 去掉最近 keep 条、再减去已压缩过的"→ LLM 摘要 → appendCompaction 入树。
   * 失败兜底：只裁历史、不升压（无摘要返回，下次请求 maybeCompact 会再试）。
   * 没有未压缩消息时不裁剪、不调用 LLM（history 原样返回）。
   */
  private async compactTo(
    storage: CompactionStore,
    history: Array<{ role: string; content: string }>,
    keep: number,
  ): Promise<CompactionResult> {
    const { llm, events } = this.deps;
    const allIds = storage.getAllMsgIds();
    // 已压缩消息 id = 每个 compaction 的 firstKeptId 之前
    const summarizedIds = new Set<string>();
    for (const c of storage.getCompactions()) {
      const keptIdx = allIds.indexOf(c.firstKeptId);
      if (keptIdx !== -1) {
        for (let i = 0; i < keptIdx; i++) summarizedIds.add(allIds[i]);
      }
    }
    const uncompressedIds = allIds.slice(0, -keep).filter((id) => !summarizedIds.has(id));
    if (uncompressedIds.length === 0) return { history, summary: undefined };

    events?.emit({ type: 'thinking', phase: 'compressing' });
    const toSummarize = uncompressedIds.map((id) => {
      const msg = storage.getMsgById(id);
      return msg ? `${msg.role}: ${msg.content.slice(0, 200)}` : '';
    }).filter(Boolean).join('\n');
    try {
      // 摘要调用包在 compaction span 里：失败时 trace() 会先打 error 卡再重抛，
      // 下面的 catch 仍照原样兜底（只裁历史、不升压）——行为与改造前一致
      const compactAttrs: SpanAttrs<'compaction'> = { msgCount: uncompressedIds.length };
      const { summary, usage } = await spanRecorderOf(events).trace('compaction', compactAttrs, async (span) => {
        const result = await llm.chat([
          { role: 'system', content: '将以下对话压缩为一段摘要（50 字内），保留关键信息。只输出摘要。' },
          { role: 'user', content: toSummarize },
        ]);
        const done: SpanResult<'compaction'> = { summaryLength: result.content.length };
        span.set(done);
        return { summary: result.content, usage: result.usage };
      });
      const firstKeptId = allIds[allIds.length - keep] ?? allIds[allIds.length - 1] ?? '';
      await storage.appendCompaction(summary, firstKeptId);
      return { history: history.slice(-keep), summary, ...(usage ? { usage } : {}) };
    } catch {
      return { history: history.slice(-keep) };
    }
  }
}
