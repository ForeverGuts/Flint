/**
 * 上下文管理子系统接口（core 层公共契约）。
 * 调用方：Runtime（runSingleTurn 委托压缩）
 * 服务于：抽象会话压缩，隔离具体实现（context/compaction.ts）
 */

/** 压缩结果：历史与摘要分离，摘要独立返回（不再混入 history 前缀） */
export interface CompactionResult {
  /** 压缩后的历史（不含摘要 system 消息，摘要独立返回） */
  history: Array<{ role: string; content: string }>;
  /** 会话摘要（历史超限被压缩过才存在；代表被压缩掉的旧上下文） */
  summary?: string | undefined;
}

/** 上下文管理子系统接口（执行类 → Service 后缀） */
export interface CompactionService {
  /**
   * 上下文压缩：读当前 history，超限时生成摘要并压缩。
   * @param history 当前对话历史
   * @returns 压缩结果（history 独立于摘要，供调用方分层组装消息）
   */
  maybeCompact(history: Array<{ role: string; content: string }>): Promise<CompactionResult>;
}
