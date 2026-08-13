/**
 * 命令子系统接口（core 层公共契约）。
 * 调用方：Runtime（prompt 委托 execute）、命令加载器（register）
 * 服务于：抽象命令的注册/列表/分发，隔离具体实现（commands/system.ts）
 */

/** 命令处理函数签名 */
export type CommandHandler = (args: string) => string | Promise<string>;

/** 命令子系统接口 */
export interface CommandProvider {
  /** 注册一个命令 */
  register(name: string, description: string, handler: CommandHandler): void;
  /** 列出所有命令 */
  list(): Array<{ name: string; description: string }>;
  /**
   * 尝试执行命令（输入以 / 开头时）。
   * @returns 命令返回结果；非命令或未知命令返回 null
   */
  execute(text: string): Promise<string | null>;
}
