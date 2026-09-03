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
}

/** Agent Loop 执行结果 */
export interface AgentLoopResult {
  /** 最终回复文本 */
  finalText: string;
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
