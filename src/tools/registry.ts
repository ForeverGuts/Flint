/**
 * 工具注册表 —— 工具子系统实现。
 * 调用方：Runtime（持有 ToolProvider）、loop/agent-loop.ts（执行工具）
 * 服务于：实现 core 的 ToolProvider 接口——注册/查询/执行工具
 *
 * 每个工具包含：
 *   - 定义（name + description + JSON Schema），发给 LLM 让它知道怎么调
 *   - 可选的参数校验（parse），在 handler 之前把模型传来的 args 校一遍、补齐默认值
 *   - 处理器（handler），实际执行的函数
 */
import type { ToolProvider, ToolDefinition, ToolResult } from '../core/tools.js';
import type { LLMTool } from '../llm/types.js';
import { ToolInputError, toolInvalid } from './spec.js';

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

  /**
   * 取工具自定义的权限弹窗文案（实现 core ToolProvider 的可选成员）。
   * 工具没定义 permissionDetail、或工具名不存在时返回 undefined，由调用方退回默认。
   */
  permissionDetail(name: string, args: Record<string, unknown>): string | undefined {
    return this.tools.get(name)?.permissionDetail?.(args);
  }

  /**
   * 取工具自定义的授权匹配键（实现 core ToolProvider 的可选成员）。
   * 工具没定义 permissionKey、或工具名不存在时返回 undefined，由调用方退回默认。
   */
  permissionKey(name: string, args: Record<string, unknown>): string | undefined {
    return this.tools.get(name)?.permissionKey?.(args);
  }

  /**
   * 执行工具调用。
   *
   * 改前这里只有 `return await tool.handler(args)` 一行，tool.parameters **一个字段都没读**
   * ——实测造一个 parameters 声明 required: ['mustHave'] 的工具，什么都不传 / 传错类型 /
   * 传 Schema 里不存在的参数名，三次全部返回 [OK]。那份 Schema 因此只是"给模型的建议书"。
   * 现在规格真的生效了：先跑 parse，拿到校验过、默认值补齐的对象再交给 handler。
   *
   * ToolInputError 必须在这里**就地**转成 status='invalid' 的 ToolResult：这是一套结构化
   * 返回值协议（agent-loop 读 status 分类、并把 invalid 计入失败）。让它穿透出去会被
   * agent-loop 的 catch 包成 "[工具 grep 执行失败]\nError: ..."，模型看到的是一句没有
   * 参数名、也不计入失败的通用错误。
   *
   * try 只包住 parse，不包住 handler：handler 自己的异常该走它自己的 catch（那里面区分
   * invalid 与 error），在这里一并兜住会让两类错误混成一类。
   */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    let parsed = args;
    if (tool.parse) {
      try {
        parsed = tool.parse(args);
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        throw e;   // 不是模型的错（规格自己写坏了）→ 让它穿透，该报成执行失败
      }
    }
    return await tool.handler(parsed);
  }
}
