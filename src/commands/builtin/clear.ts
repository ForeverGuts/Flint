/**
 * /clear 命令 —— 导出 activate 供自动扫描加载。
 */
import type { Runtime } from '../../runtime/runtime.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('clear', '清空当前会话', async () => {
    await runtime.clearSession();
    return '会话已清空';
  });
}
