/**
 * 工具子系统接口（core 层公共契约）。
 * 调用方：loop/agent-loop.ts（执行工具）、Runtime（提供工具给 LLM）
 * 服务于：抽象工具注册表，隔离具体实现（tools/registry.ts）
 */
import type { LLMTool } from '../llm/types.js';

/** 工具参数 Schema（JSON Schema 格式） */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/** 工具定义 —— 注册到工具子系统，供 LLM 调用 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  handler: (args: Record<string, unknown>) => Promise<string>;
  /** 是否需要用户确认才能执行（写/改类工具为 true，只读类为 false） */
  requirePermission?: boolean;
}

/** 工具子系统接口 */
export interface ToolProvider {
  /** 注册一个工具 */
  register(tool: ToolDefinition): void;
  /** 获取 LLM 可用的工具定义（Function Calling 格式） */
  getLLMTools(): LLMTool[];
  /** 检查工具是否需要用户确认 */
  requiresPermission(name: string): boolean;
  /** 执行工具调用 */
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}
