/**
 * 工具函数 —— 从 runtime.ts 抽离的通用方法。
 * 调用方：runtime.ts（Token 用量估算）
 * 服务于：API 未返回精确用量时的兜底估算
 *
 * 注：旧版 parseToolCalls / createToolCallFilter / fixJSON（标签解析工具调用）
 * 已在 function calling 升级中删除——结构化工具调用由 API 的 tool_calls 字段返回，
 * 不再需要从回复文本抠 <tool_call> 标签。
 */

/** Token 用量估算（API 未返回精确用量时的兜底） */
export function estimateTokenUsage(
  input: string,
  output: string,
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const estimate = (text: string) => {
    let tokens = 0;
    for (const char of text) {
      if (/[一-鿿]/.test(char)) {
        tokens += 1; // 中文字符
      } else if (/\s/.test(char)) {
        tokens += 0.2; // 空格
      } else {
        tokens += 0.25; // 英文字符
      }
    }
    return Math.max(1, Math.ceil(tokens));
  };
  const promptTokens = estimate(input);
  const completionTokens = estimate(output);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}
