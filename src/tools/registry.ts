/**
 * 工具注册表 —— 工具子系统实现。
 * 调用方：Runtime（持有 ToolProvider）、loop/agent-loop.ts（执行工具）
 * 服务于：实现 core 的 ToolProvider 接口——注册/查询/执行工具
 *
 * 每个工具包含：
 *   - 定义（name + description + JSON Schema），发给 LLM 让它知道怎么调
 *   - 处理器（handler），实际执行的函数
 */
import type { ToolProvider, ToolDefinition } from '../core/tools.js';
import type { LLMTool } from '../llm/types.js';

/** 工具注册表管理器（实现 core ToolProvider） */
export class ToolRegistry implements ToolProvider {
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
