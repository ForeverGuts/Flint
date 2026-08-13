/**
 * 上下文管理子系统接口（core 层公共契约）。
 * 调用方：Runtime（runSingleTurn 委托压缩）
 * 服务于：抽象会话压缩，隔离具体实现（context/compaction.ts）
 */

/** 上下文管理子系统接口（执行类 → Service 后缀） */
export interface CompactionService {
  /**
   * 上下文压缩：读当前 history，超限时生成摘要并压缩。
   * @param history 当前对话历史
   * @returns 压缩后的 history（可能含开头的摘要 system 消息）
   */
  maybeCompact(history: Array<{ role: string; content: string }>): Promise<Array<{ role: string; content: string }>>;
}
