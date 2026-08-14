/**
 * 工具段落 —— 告诉 LLM 当前可用工具。
 * 调用方：SystemPromptService（配置的 sections 之一）
 * 服务于：把 ToolProvider 的工具描述注入系统提示词（动态，ctx.tools）
 */
import type { SectionFn } from '../system-prompt.js';

/** 工具段（ctx.tools 为空时返回 undefined，跳过本段） */
export const toolsSection: SectionFn = (ctx) => {
  if (!ctx.tools) return undefined;
  return `你有以下工具：\n${ctx.tools}`;
};
