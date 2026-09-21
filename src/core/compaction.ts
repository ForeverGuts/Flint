/**
 * 上下文管理子系统接口（core 层公共契约）。
 * 调用方：Runtime（runSingleTurn 委托压缩）
 * 服务于：抽象会话压缩，隔离具体实现（context/compaction.ts）
 */
import type { CompactionStore } from './compaction-store.js';
import type { LLMUsage } from '../llm/types.js';

/**
 * 摘要**之前**的钩子（ROADMAP 10.8.4 留档用）。
 *
 * 为什么是钩子而不是"调用方自己算一遍哪些条要被压掉"：那个判据（"去掉最近 keep 条、
 * 再减去已压缩过的"）**只有一份实现，就在 `compactTo` 里**。调用方另算一遍，两处迟早漂移，
 * 而且漂移是**互相掩护**的（各测各的都绿）。交给钩子，留档拿到的就是真正要被换掉的那批。
 *
 * @param dropped 本次将被摘要替换掉的**原始**消息（完整内容；喂 LLM 那份才截 200 字）
 * @returns `ok:false` = **中止**本次压缩（`aborted` 带回原因，history 一字不动）
 */
export type BeforeSummarizeHook = (
  dropped: Array<{ role: string; content: string }>,
) => Promise<{ ok: boolean; reason?: string }>;

/** 压缩结果：历史与摘要分离，摘要独立返回（不再混入 history 前缀） */
export interface CompactionResult {
  /** 压缩后的历史（不含摘要 system 消息，摘要独立返回） */
  history: Array<{ role: string; content: string }>;
  /** 会话摘要（历史超限被压缩过才存在；代表被压缩掉的旧上下文） */
  summary?: string | undefined;
  /**
   * 压缩被 `beforeSummarize` 钩子**中止**的原因（2026-09-21，ROADMAP 10.8.4）。
   * 中止时 `summary` 缺省且 **history 原样返回**（不裁 —— 没留档就不许丢原文）。
   * 只有手动压缩传钩子，故自动压缩路径永远不出现这个字段。
   */
  aborted?: string | undefined;
  /**
   * 生成摘要那次 LLM 调用的真实用量（2026-09-12 用量回流）。
   * 只在"摘要调用成功且 API 报了用量"时存在——没压缩 / 调用失败 / API 没报都缺省，不伪报 0。
   * 调用方（runtime）负责并入 /usage 合计。
   */
  usage?: LLMUsage;
}

/** 上下文管理子系统接口（执行类 → Service 后缀） */
export interface CompactionService {
  /**
   * 上下文压缩：读当前 history，超限时生成摘要并压缩。
   * @param history 当前对话历史
   * @param storage 压缩存储（**每次调用显式传入**，2026-09-12 起不再是构造期绑死——
   *                runtime 会切换会话，绑死会把摘要写进旧文件）
   * @returns 压缩结果（history 独立于摘要，供调用方分层组装消息）
   */
  maybeCompact(
    history: Array<{ role: string; content: string }>,
    storage?: CompactionStore,
  ): Promise<CompactionResult>;

  /**
   * 强制压缩（fork 摘要用）：不判阈值，直接把除最近 keepRecent 条外的未压缩消息摘要入树。
   * 调用方：Runtime.forkSessionWithSummary（/history"带摘要从此继续"）
   * @param history 当前对话历史（fork 后新会话的完整前缀）
   * @param storage 压缩存储（每次调用显式传入，同 maybeCompact）
   * @param opts.keepRecent 压缩后保留的最近条数（缺省与 maybeCompact 同一口径，不新造参数）
   * @param opts.beforeSummarize 摘要前的钩子（手动压缩的**留档**用它；返回 ok:false 即中止）
   * @returns 压缩结果；前缀不足 keepRecent 条时不压缩，summary 为 undefined
   */
  compactNow(
    history: Array<{ role: string; content: string }>,
    storage?: CompactionStore,
    opts?: { keepRecent?: number; beforeSummarize?: BeforeSummarizeHook },
  ): Promise<CompactionResult>;
}
