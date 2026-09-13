/**
 * /usage 命令 —— 导出 activate 供自动扫描加载。
 */
import type { Runtime } from '../../runtime/runtime.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('usage', '显示 Token 用量统计', () => {
    const u = runtime.totalUsage;
    const lines = [
      'Token 用量（累计）：',
      `  Prompt tokens:      ${u.promptTokens.toLocaleString()}`,
      `  Completion tokens:  ${u.completionTokens.toLocaleString()}`,
      `  Total tokens:       ${u.totalTokens.toLocaleString()}`,
    ];
    // 缓存明细：API 报过才有（全程没报不显示，不伪报 0）。命中占输入的比
    // 是调优提示词结构最直接的反馈——系统提示/工具描述越稳定前置，这个占比越高、账单越便宜
    if (u.cacheReadTokens !== undefined) {
      const pct = u.promptTokens > 0 ? `（占输入 ${Math.round((u.cacheReadTokens / u.promptTokens) * 100)}%）` : '';
      lines.push(`  缓存命中:           ${u.cacheReadTokens.toLocaleString()}${pct}`);
    }
    if (u.cacheCreationTokens !== undefined) {
      lines.push(`  缓存写入:           ${u.cacheCreationTokens.toLocaleString()}`);
    }
    return lines.join('\n');
  });
}
