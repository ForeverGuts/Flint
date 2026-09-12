/**
 * 会话存储接口（core 层公共契约）。
 * 调用方：Runtime（编排）、session/ 实现、loop/（读写历史）
 * 服务于：定义消息存取的通用契约，隔离存储实现（JSONL/内存/Mock）
 *
 * 设计：entry 树能力（compaction/fork）作为**可选成员**加入接口——
 * 这样 Runtime 无需 instanceof 判断，但 InMemory/Mock 可实现为 no-op/空。
 *
 * 本接口是 SessionStorage 的**唯一真身**（types.ts 只做转发）。曾经 types.ts 里另有一个
 * 三方法版，与本接口同名不同体，而 RuntimeOptions.session 声明的是那一版，导致可选成员
 * 在接口层面拿不到、Runtime 只能靠 instanceof 缩窄到 JsonlSessionStorage 才能调。
 * 收敛后：Runtime 改为探测可选成员（`if (session.getAllStored)`），上面那句设计意图至此落实。
 */

/**
 * 单个存储消息（含可选 tool_calls 等结构）。
 * 注：id/msgId 兼容 JSONL（用 id）与对外 API（用 msgId）。
 */
export interface StoredMessage {
  /** 消息 ID（JSONL 的 entry id） */
  id?: string;
  /** 消息 ID（对外 API 别名，如 /history 展示） */
  msgId?: string;
  role: string;
  content: string;
}

/** 会话存储接口 */
export interface SessionStorage {
  /** 追加一条消息（可带工具调用/结果信息） */
  appendMessage(
    role: string,
    content: string,
    extra?: { tool_calls?: unknown[]; tool_call_id?: string; name?: string },
  ): Promise<void>;
  /** 读取当前会话全部消息 */
  getMessages(): Promise<Array<{ role: string; content: string }>>;
  /** 清空会话 */
  clear(): Promise<void>;

  // ── 可选能力（entry 树存储实现；InMemory/Mock 可为 no-op） ──

  /** 获取当前分支全部存储消息（/history 用） */
  getAllStored?(): StoredMessage[];
  /** fork：复制根→该 entry 前缀到新会话（/history 分叉用） */
  forkTo?(forkEntryId: string): Promise<{ fileName: string; storage: SessionStorage }>;
  /** 获取会话目录（/sessions 列表用） */
  getDir?(): string;
  /** 获取会话文件完整路径（/sessions 删除守卫用它比对"是不是当前会话"；InMemory/Mock 无） */
  getFilePath?(): string;
}
