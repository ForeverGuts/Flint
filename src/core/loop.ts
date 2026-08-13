/**
 * Agent Loop 子系统接口（core 层公共契约）。
 * 调用方：Runtime（runSingleTurn 委托循环）
 * 服务于：抽象 LLM 流式 + 工具执行循环，隔离具体实现（loop/agent-loop.ts）
 */
import type { LLMMessage } from '../llm/types.js';

/** Agent Loop 子系统接口 */
export interface AgentLoopProvider {
  /**
   * 运行一轮 Agent Loop：LLM 生成 → 工具执行 → 循环。
   * @param toolMessages 初始消息（含 system 工具描述 + 历史 + 用户消息）
   * @param onToken 流式 token 回调（可选）
   * @returns 最终回复文本
   */
  run(toolMessages: LLMMessage[], onToken?: (chunk: string) => void): Promise<{ finalText: string }>;
}
