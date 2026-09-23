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
import type { BeforeSummarizeHook, CompactionResult, CompactionService } from '../core/compaction.js';
import {
  COMPACT_MESSAGE_THRESHOLD,
  CONTEXT_BUDGET_TOKENS,
  KEEP_BUDGET_RATIO,
  chooseKeep,
  renderSummaryPrompt,
  safeCutIndex,
  shouldCompact,
  shouldRetryAfterFailure,
} from './compaction-policy.js';

/** 压缩阈值：历史超过此条数触发压缩（**体积之外的兜底**，判据见 compaction-policy.ts） */
const COMPACT_THRESHOLD = COMPACT_MESSAGE_THRESHOLD;
/** 压缩后保留的最近条数（**缺省口径只有这一处**；`/compact` 的默认值也取它，不另立一份） */
export const DEFAULT_KEEP_RECENT = 10;

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
   * 上次摘要**失败**那一刻的历史条数（ROADMAP 10.8.6 退避用）。
   *
   * 为什么是"条数"而不是计时器：失败后历史**原样不动**，于是下一轮仍然超阈值 ——
   * 要退避就得有个"什么情况下再试一次"的判据。**对话又变长了**是最自然的那个：
   * 说明有新内容可压，重试才有意义；否则就是把同一个失败反复重试。
   *
   * ⚠ 这是本类唯一的实例状态，且是**粗粒度**的：切会话时不会清零。
   * 后果可接受——新会话的 history 一开始就短，根本到不了触发线，退避判据自然不生效。
   */
  private failedAtLength: number | undefined;

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
    let failure: string | undefined;

    // 触发：**体积或条数**任一超了就压（10.8.9）。条数阈值不再删掉，留作体积估算看不见的那一半的兜底。
    const verdict = shouldCompact(history, CONTEXT_BUDGET_TOKENS, COMPACT_THRESHOLD);
    if (verdict.needed) {
      // 退避（10.8.6）：上次没压成、对话又没变长，就别每轮都白烧一次摘要调用
      if (!shouldRetryAfterFailure(history.length, this.failedAtLength, DEFAULT_KEEP_RECENT)) {
        return {
          history,
          summary: compressedSummary || undefined,
          failed: '上次摘要没生成出来，等对话再长一些才会重试',
        };
      }
      // 保留窗口：**按体积算**，条数只是上限（10.8.9）。短消息时结果与改前的"保留 10 条"一致。
      const keep = chooseKeep(history, CONTEXT_BUDGET_TOKENS * KEEP_BUDGET_RATIO, DEFAULT_KEEP_RECENT);
      const r = await this.compactTo(storage, history, keep);
      history = r.history;
      if (r.summary) {
        compressedSummary = r.summary;
        this.failedAtLength = undefined;
      }
      if (r.failed) {
        failure = r.failed;
        this.failedAtLength = history.length;
      }
      if (r.usage) compactionUsage = r.usage;
    }

    // 摘要独立返回（不 unshift 进 history，避免污染缓存前缀）；用量随行（runtime 入账 /usage）
    return {
      history,
      summary: compressedSummary || undefined,
      ...(failure ? { failed: failure } : {}),
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
    opts?: { keepRecent?: number; beforeSummarize?: BeforeSummarizeHook },
  ): Promise<CompactionResult> {
    if (!storage) return { history, summary: undefined };
    const keep = opts?.keepRecent ?? DEFAULT_KEEP_RECENT;
    if (history.length <= keep) return { history, summary: undefined };
    return this.compactTo(storage, history, keep, opts?.beforeSummarize);
  }

  /**
   * 压缩主体（maybeCompact 与 compactNow 共用）：
   * 取"全部消息 id 去掉保留窗口、再减去已压缩过的"→ LLM 摘要 → appendCompaction 入树。
   * 保留窗口由 `chooseKeep` 按体积算，切割点再由 `safeCutIndex` 挪到合法边界（判据都在
   * compaction-policy.ts，本方法只管把它们串起来）。
   * 失败兜底：**history 原样返回 + `failed` 带回原因**（10.8.6，不再偷偷裁历史）。
   * 没有未压缩消息时不裁剪、不调用 LLM（history 原样返回）。
   */
  private async compactTo(
    storage: CompactionStore,
    history: Array<{ role: string; content: string }>,
    keep: number,
    beforeSummarize?: BeforeSummarizeHook,
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
    // 切割点（10.8.12）：先按保留条数算出位置，再**挪到合法边界** —— 绝不能落在工具结果上。
    // 工具结果是逐条落盘的独立条目（role='tool'），"倒数第 keep 条"完全可能是它；
    // 真落在上面，保留窗口第一条就成了没有配对 tool_use 的孤儿结果，多数模型 API 直接拒。
    const roles = allIds.map((id) => storage.getMsgById(id)?.role ?? '');
    const cut = safeCutIndex(roles, allIds.length - keep);
    const uncompressedIds = allIds.slice(0, cut).filter((id) => !summarizedIds.has(id));
    if (uncompressedIds.length === 0) return { history, summary: undefined };

    // 留档（手动压缩才有钩子）：**在生成摘要之前** —— 留的是"即将被换掉"的那批原文。
    // 钩子说不成就**中止**：没留档却把历史裁了，等于不可逆地丢了原文（见 core/compaction.ts
    // 钩子的契约注释）。中止时 history 原样返回，一个字都不裁。
    if (beforeSummarize) {
      const dropped: Array<{ role: string; content: string }> = [];
      for (const id of uncompressedIds) {
        const msg = storage.getMsgById(id);
        if (msg) dropped.push({ role: msg.role, content: msg.content });
      }
      const verdict = await beforeSummarize(dropped);
      if (!verdict.ok) {
        return { history, summary: undefined, aborted: verdict.reason ?? '留档未通过' };
      }
    }

    events?.emit({ type: 'thinking', phase: 'compressing' });
    // 滚动摘要（10.8.8）：上一版摘要**前置**喂进去，让信息能跨层传承。
    // 改前每版都从零重写、完全不含上一版，压三次之后开头那批在模型视野里彻底消失。
    const prevSummary = storage.getCompactions().at(-1)?.summary;
    const toSummarize = uncompressedIds.map((id) => {
      const msg = storage.getMsgById(id);
      return msg ? `${msg.role}: ${msg.content.slice(0, 200)}` : '';
    }).filter(Boolean).join('\n');
    try {
      // 摘要调用包在 compaction span 里：失败时 trace() 会先打 error 卡再重抛，
      // 下面的 catch 负责**如实**兜底（见下）
      const compactAttrs: SpanAttrs<'compaction'> = { msgCount: uncompressedIds.length };
      const { summary, usage } = await spanRecorderOf(events).trace('compaction', compactAttrs, async (span) => {
        const result = await llm.chat([
          { role: 'system', content: renderSummaryPrompt(prevSummary) },
          { role: 'user', content: toSummarize },
        ]);
        const done: SpanResult<'compaction'> = { summaryLength: result.content.length };
        span.set(done);
        return { summary: result.content, usage: result.usage };
      });
      // 切割点用挪过的那个（不是 `length - keep`）：保留窗口因此可能比 keep 多几条，
      // 这是刻意的安全代价 —— 宁可多留两条，不可造一个孤儿工具结果。
      const firstKeptId = allIds[cut] ?? '';
      await storage.appendCompaction(summary, firstKeptId);
      const keptCount = Math.min(allIds.length - cut, history.length);
      return { history: history.slice(history.length - keptCount), summary, ...(usage ? { usage } : {}) };
    } catch {
      // 10.8.6：失败就**什么都没发生**。改前是"照常裁掉但不写记录"——那等于骗自己压过了：
      // 下一轮视图找不到分界线、历史整体滚回来，于是又触发、又失败，待压那批从 10 条涨到 20、30，
      // 输入越来越长也更容易失败。压缩不可逆、没有回滚基线，所以没压成必须一字不裁。
      return { history, failed: '摘要没生成出来（LLM 调用失败）' };
    }
  }
}
