/**
 * /diagnostics 命令 —— 查看运行时诊断历史。
 * 调用方：commands.ts（自动扫描器加载）
 * 服务于：可靠性工程「错误日志与诊断」—— 查看本次会话累积的错误/警告（LLM/工具失败）
 *
 * 诊断由 runtime.recordDiagnostic 收集（emit error 事件 + 入队列），
 * 此命令只读展示，不修改。
 */
import type { Runtime } from '../runtime.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('diagnostics', '查看运行时诊断历史（错误/警告）', async () => {
    const diags = runtime.getDiagnostics();
    if (diags.length === 0) return '📭 暂无诊断记录。';

    // 倒序展示（最新在前），限 20 条
    const recent = diags.slice(-20).reverse();
    const lines = recent.map((d) => {
      const icon = d.level === 'fail' ? '❌' : d.level === 'warn' ? '⚠️' : '✅';
      return `  ${icon} [${d.item}] ${d.message}`;
    });
    const failCount = diags.filter((d) => d.level === 'fail').length;
    const warnCount = diags.filter((d) => d.level === 'warn').length;
    return `诊断历史（共 ${diags.length} 条 · ❌ ${failCount} · ⚠️ ${warnCount}）:\n${lines.join('\n')}`;
  });
}
