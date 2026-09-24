/**
 * 压缩存储接口（core 层公共契约）。
 * 调用方：context/compaction.ts（CompactionService 依赖）
 * 服务于：定义上下文压缩所需的存储能力（读/写摘要、读消息 ID/内容），
 *         隔离具体存储实现——只有支持压缩的存储（Jsonl）实现此接口，
 *         InMemory/Mock 不实现（明确不支持压缩）。
 */

/** 压缩存储接口 */
export interface CompactionStore {
  /**
   * 读取已有 compaction 摘要列表。
   * `filesModified` / `filesRead` 是随条目累积的文件操作清单（10.8.11）；
   * 旧文件 / mock 存储没有这两个字段 → undefined，压缩层当"空清单"处理。
   */
  getCompactions(): Array<{
    summary: string;
    firstKeptId: string;
    filesModified?: string[];
    filesRead?: string[];
  }>;
  /**
   * 追加一个 compaction 摘要。
   * `ledger` 缺省 = 本轮没抽出任何文件操作（或全部为空）—— **不写字段**，与旧文件兼容。
   */
  appendCompaction(
    summary: string,
    firstKeptId: string,
    ledger?: { modified: string[]; read: string[] },
  ): Promise<void>;
  /** 获取全部消息 ID（压缩增量判断用） */
  getAllMsgIds(): string[];
  /**
   * 按 ID 获取消息。`tool_calls`（10.8.11 起被压缩层消费）是 assistant 条目的结构化
   * 工具调用——**故意用结构子类型**而不是 import LLMToolCall：core 层不依赖 llm 层，
   * 压缩层只需要 `function.name` + `function.arguments` 两格。
   */
  getMsgById(msgId: string): {
    id?: string;
    msgId?: string;
    role: string;
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  } | undefined;
}
