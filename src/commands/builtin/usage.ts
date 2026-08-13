/**
 * /usage 命令 —— 导出 activate 供自动扫描加载。
 */
import type { Runtime } from '../../runtime/runtime.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('usage', '显示 Token 用量统计', () => {
    const u = runtime.totalUsage;
    return `Token 用量（累计）：\n  Prompt tokens:      ${u.promptTokens.toLocaleString()}\n  Completion tokens:  ${u.completionTokens.toLocaleString()}\n  Total tokens:       ${u.totalTokens.toLocaleString()}`;
  });
}
