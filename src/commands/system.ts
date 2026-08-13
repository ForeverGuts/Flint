/**
 * 命令子系统 —— 命令注册、列表、分发。
 * 调用方：Runtime（prompt 中委托 execute）、命令加载器（register）
 * 服务于：命令的存储/注册/分发 —— 从 Runtime 抽离，与 loader + builtin 合成完整命令子系统
 *
 * 消费者：REPL（prompt 处理 /xxx）、RPC（chat 走 prompt）—— 两个消费者
 */
import type { CommandProvider, CommandHandler } from '../core/commands.js';

/** 已注册的命令 */
interface RegisteredCommand {
  description: string;
  handler: CommandHandler;
}

/** 命令子系统 */
export class CommandSystem implements CommandProvider {
  private commands = new Map<string, RegisteredCommand>();

  /** 注册一个命令 */
  register(name: string, description: string, handler: CommandHandler): void {
    this.commands.set(name, { description, handler });
  }

  /** 列出所有命令 */
  list(): Array<{ name: string; description: string }> {
    return [...this.commands.entries()].map(([name, cmd]) => ({ name, description: cmd.description }));
  }

  /**
   * 尝试执行命令（输入以 / 开头时）。
   * 调用方：Runtime.prompt 开头（① 扩展命令检查）
   * @returns 命令返回结果；非命令或未知命令返回 null
   */
  async execute(text: string): Promise<string | null> {
    if (!text.startsWith('/')) return null;
    const spaceIndex = text.indexOf(' ');
    const cmdName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1);
    const cmd = this.commands.get(cmdName);
    if (!cmd) return null;
    return await cmd.handler(args);
  }
}
