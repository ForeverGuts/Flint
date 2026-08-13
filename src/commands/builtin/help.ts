/**
 * /help 命令 —— 导出 activate 供自动扫描加载。
 * 调用方：commands.ts（自动扫描器扫描到本文件后调用 activate）
 */
import type { Runtime } from '../../runtime/runtime.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('help', '显示帮助信息', () => {
    const lines = runtime.listCommands().map((c) => `  /${c.name}  — ${c.description}`);
    return `可用命令：\n${lines.join('\n')}`;
  });
}
