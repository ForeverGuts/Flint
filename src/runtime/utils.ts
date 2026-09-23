/**
 * 工具函数 —— 从 runtime.ts 抽离的通用方法。
 * 调用方：runtime.ts（Token 用量估算）
 * 服务于：API 未返回精确用量时的兜底估算
 *
 * 注：旧版 parseToolCalls / createToolCallFilter / fixJSON（标签解析工具调用）
 * 已在 function calling 升级中删除——结构化工具调用由 API 的 tool_calls 字段返回，
 * 不再需要从回复文本抠 <tool_call> 标签。
 */
import { estimateTokens } from '../core/token-estimate.js';

/** Token 用量估算（API 未返回精确用量时的兜底） */
export function estimateTokenUsage(
  input: string,
  output: string,
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  // 估算口径只有一份（src/core/token-estimate.ts）—— 压缩的触发判据用的是同一个函数，
  // 两处各写一份就会漂，而且漂了各测各的都绿（2026-09-23 抽出来的直接原因）。
  const promptTokens = estimateTokens(input);
  const completionTokens = estimateTokens(output);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}
