/**
 * 工具系统 —— Skill + Function Calling 模式。
 * 调用方：runtime.ts（prompt 中执行 Agent Loop）
 * 服务于：LLM 可通过 Function Calling 调用工具（读文件、执行命令等）
 *
 * 每个工具包含：
 *   - 定义（name + description + JSON Schema），发给 LLM 让它知道怎么调
 *   - 处理器（handler），实际执行的函数
 */
import type { LLMTool } from '../llm/types.js';

/** 工具参数 Schema（JSON Schema 格式） */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/** 工具定义 —— 注册到 Runtime，供 LLM 调用 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  handler: (args: Record<string, unknown>) => Promise<string>;
  /** 是否需要用户确认才能执行（写/改类工具为 true，只读类为 false） */
  requirePermission?: boolean;
}

/** 工具注册表管理器 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** 注册一个工具 */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** 获取 LLM 可用的工具定义（Function Calling 格式） */
  getLLMTools(): LLMTool[] {
    return [...this.tools.values()].map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
      },
    }));
  }

  /** 检查工具是否需要用户确认 */
  requiresPermission(name: string): boolean {
    return this.tools.get(name)?.requirePermission ?? false;
  }

  /** 执行工具调用 */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return await tool.handler(args);
  }
}
