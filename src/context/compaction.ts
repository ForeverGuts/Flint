/**
 * 上下文管理子系统 —— 会话压缩（compaction）。
 * 调用方：Runtime（runSingleTurn 开头调用 maybeCompact）
 * 服务于：历史超限时用 LLM 总结早期消息，压缩结果作为 compaction 入树，
 *         让上下文保持在 LLM 窗口内
 *
 * 依赖：llm（chat 生成摘要）+ storage（core SessionStorage 可选成员）+ events（thinking 事件）
 * 不依赖具体存储实现（InMemory/Mock 无 compaction 能力时为 no-op）。
 */
import type { LLMProvider } from '../llm/types.js';
import type { CompactionStore } from '../core/compaction-store.js';
import type { EventBus } from '../core/events.js';
import type { CompactionProvider } from '../core/compaction.js';

/** 压缩阈值：历史超过此条数触发压缩 */
const COMPACT_THRESHOLD = 20;
/** 压缩后保留的最近条数 */
const KEEP_RECENT = 10;

/** CompactionService 构造依赖 */
export interface CompactionDeps {
  /** LLM（生成摘要） */
  llm: LLMProvider;
  /** 压缩存储（支持压缩的存储实现，无则跳过压缩） */
  storage?: CompactionStore | undefined;
  /** 事件总线（发射 thinking:compressing 事件） */
  events?: EventBus | undefined;
}

/** 上下文管理子系统 */
export class CompactionService implements CompactionProvider {
  constructor(private deps: CompactionDeps) {}

  /**
   * 上下文压缩：读当前 history，超限时生成摘要并压缩。
   * @param history 当前对话历史（从 storage.getMessages() 读取）
   * @returns 压缩后的 history（可能含开头的摘要 system 消息）
   */
  async maybeCompact(history: Array<{ role: string; content: string }>): Promise<Array<{ role: string; content: string }>> {
    const { storage, llm, events } = this.deps;
    if (!storage) return history;

    // 已有摘要：取最后一个 compaction 的 summary
    let compressedSummary = '';
    const compactions = storage.getCompactions();
    if (compactions.length > 0) {
      compressedSummary = compactions[compactions.length - 1].summary;
    }

    if (history.length > COMPACT_THRESHOLD) {
      const allIds = storage.getAllMsgIds();
      // 已压缩消息 id = 每个 compaction 的 firstKeptId 之前
      const summarizedIds = new Set<string>();
      for (const c of compactions) {
        const keptIdx = allIds.indexOf(c.firstKeptId);
        if (keptIdx !== -1) {
          for (let i = 0; i < keptIdx; i++) summarizedIds.add(allIds[i]);
        }
      }
      const uncompressedIds = allIds.slice(0, -KEEP_RECENT).filter((id) => !summarizedIds.has(id));
      if (uncompressedIds.length > 0) {
        events?.emit({ type: 'thinking', phase: 'compressing' });
        const toSummarize = uncompressedIds.map((id) => {
          const msg = storage.getMsgById(id);
          return msg ? `${msg.role}: ${msg.content.slice(0, 200)}` : '';
        }).filter(Boolean).join('\n');
        try {
          const result = await llm.chat([
            { role: 'system', content: '将以下对话压缩为一段摘要（50 字内），保留关键信息。只输出摘要。' },
            { role: 'user', content: toSummarize },
          ]);
          const summary = result.content;
          const firstKeptId = allIds[allIds.length - KEEP_RECENT] ?? allIds[allIds.length - 1] ?? '';
          await storage.appendCompaction(summary, firstKeptId);
          compressedSummary = summary;
          history = history.slice(-KEEP_RECENT);
        } catch {
          history = history.slice(-KEEP_RECENT);
        }
      }
    }

    if (compressedSummary) {
      history.unshift({ role: 'system' as const, content: `[对话摘要] ${compressedSummary}` });
    }
    return history;
  }
}
