/**
 * 压缩存储接口（core 层公共契约）。
 * 调用方：context/compaction.ts（CompactionService 依赖）
 * 服务于：定义上下文压缩所需的存储能力（读/写摘要、读消息 ID/内容），
 *         隔离具体存储实现——只有支持压缩的存储（Jsonl）实现此接口，
 *         InMemory/Mock 不实现（明确不支持压缩）。
 */

/** 压缩存储接口 */
export interface CompactionStore {
  /** 读取已有 compaction 摘要列表 */
  getCompactions(): Array<{ summary: string; firstKeptId: string }>;
  /** 追加一个 compaction 摘要 */
  appendCompaction(summary: string, firstKeptId: string): Promise<void>;
  /** 获取全部消息 ID（压缩增量判断用） */
  getAllMsgIds(): string[];
  /** 按 ID 获取消息 */
  getMsgById(msgId: string): { id?: string; msgId?: string; role: string; content: string } | undefined;
}
