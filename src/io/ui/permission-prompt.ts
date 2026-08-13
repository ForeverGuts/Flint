/**
 * 权限确认选择器 —— 操作前拦截，显示选项供用户 ↑↓ 选择、Enter 确认。
 * 调用方：tool-loop（Runtime 执行工具前调用）
 * 服务于：允许/拒绝/本次全部允许 等权限选择
 *
 * 现委托给通用选择器 selectFromList() 实现。
 */
import { selectFromList } from './selector.js';

export type PermissionChoice = 'once' | 'always' | 'deny';

/**
 * 展示权限选择弹窗，返回用户选择的权限。
 * 非 TTY 环境自动允许。
 */
export async function promptPermission(toolName: string, detail: string): Promise<PermissionChoice> {
  if (!process.stdin.isTTY) {
    console.log(`  🔧 ${toolName} ${detail}（非交互环境，自动允许）`);
    return 'once';
  }

  const result = await selectFromList<PermissionChoice>([
    { value: 'once',   label: '允许一次',     description: '仅本次放行' },
    { value: 'always', label: '本次全部允许', description: '后续自动放行' },
    { value: 'deny',   label: '拒绝',        description: '取消操作' },
  ], `🔧 ${toolName} 请求：${detail}`);

  return result ?? 'deny';
}
