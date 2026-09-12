/**
 * Agent Loop 子系统接口（core 层公共契约）。
 * 调用方：Runtime（runSingleTurn 委托循环）
 * 服务于：抽象 LLM 流式 + 工具执行循环，隔离具体实现（loop/agent-loop.ts）
 */
import type { LLMMessage, LLMUsage } from '../llm/types.js';

/** Agent Loop 按次可选参数 */
export interface AgentLoopOptions {
  /** 本次循环最大轮数（缺省实现侧 DEFAULT_MAX_TURNS；Runtime 在带 TASK.md 计划时放大） */
  maxTurns?: number;
  /**
   * 本次循环的 thinking 按次覆盖（阶段 C2）：Runtime 按“配置模式 + 有无任务”判定后下发；
   * 缺省时 Provider 按自身 config.thinking 解析（'on' 开、其余关）
   */
  thinking?: boolean;
  /**
   * 本次循环使用的模型名（写进 llm_request_start 事件）。
   * 为什么按次下发而不是构造时注入：/model 命令与 LLM 失败兜底都会热切换模型，
   * 构造快照会在切换后永久陈旧（报出来的耗时归到错误的模型头上）。
   */
  model?: string;
  /**
   * 内层引导（steering）取件回调 —— 每次工具执行完、下一次 LLM 调用之前调用一次。
   *
   * 返回非空文本时，实现侧把它追加进**最后一条 tool 结果**的 content：
   * 不能新开一条 user 消息 —— tool 结果在 Anthropic 转换后已经是 user 角色，
   * 再插一条 user 会连续两条 user（roles must alternate）直接 400。
   *
   * 语义边界（实现侧负责，调用方只需给一个「取一条，没有返回 null」的函数）：
   *   - 只在**确实还有下一次 LLM 调用**时取件（最后一轮取走 = 吞掉用户的话）
   *   - 只在**本轮产出过工具调用**时取件（没有工具就没有注入落点，留给外层循环当新回合）
   * 缺省不传 = 无内层引导，行为与改造前完全一致。
   *
   * 与落盘的关系：取走的文本同时被 Runtime 记入本轮缓冲，在本轮 assistant 之前落盘为
   * 独立 user 条目（带 STEER_PREFIX），所以内层引导既进**本轮**上下文，也进会话历史。
   * 落盘是 Runtime 的职责，本契约不关心 —— 回调只需如实把取到的文本交出去。
   */
  takeSteer?: () => string | null;
}

/** Agent Loop 执行结果 */
export interface AgentLoopResult {
  /** 最终回复文本 */
  finalText: string;
  /**
   * 本轮循环**实际生成**的中间消息（assistant（带 tool_calls）与 tool 结果，按发生顺序），
   * 不含最终回复本身——它由 Runtime 走 appendMessage('assistant', finalText) 落盘。
   *
   * 为什么由 Runtime 落盘而不是循环自己写（C3 断言钉着"agent-loop 不碰存储"）：
   * 存储是 Runtime 的编排职责，循环只管把"模型真实看到/说过什么"如实上交——
   * 落盘时序（steer 在前、最终回复在后）只有 Runtime 知道。
   * 引导/收尾提示对 tool 结果的追加改写发生在消息对象上，turnLog 持有同一引用，如实包含。
   * thinkingBlocks 不在上交范围之外另行剥离——落盘时 Runtime 只取 extra 三字段，块自然不落盘。
   */
  turnLog: LLMMessage[];
  /**
   * 各轮 API 报的真实用量合计。
   * null = 至少一轮没拿到（流异常、或端点不支持用量）——宁可整体不报，
   * 也不给一个少报的"真值"：消费端无法区分"这就是全部"与"这只是其中几轮"。
   * 上层拿到 null 时自行回退估算。
   */
  usage: LLMUsage | null;
}

/** Agent Loop 子系统接口（执行类 → Service 后缀） */
export interface AgentLoopService {
  /**
   * 运行一轮 Agent Loop：LLM 生成 → 工具执行 → 循环。
   * @param toolMessages 初始消息（含 system 工具描述 + 历史 + 用户消息）
   * @param onToken 流式 token 回调（可选）
   * @param opts 可选参数（maxTurns：本次循环最大轮数）
   * @returns 最终回复文本 + 各轮真实用量合计（可能为 null）
   */
  run(
    toolMessages: LLMMessage[],
    onToken?: (chunk: string) => void,
    opts?: AgentLoopOptions,
  ): Promise<AgentLoopResult>;
}
