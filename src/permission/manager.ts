/**
 * 权限管理器 —— 追踪用户已授权的操作（实现 core PermissionProvider）。
 * 调用方：runtime.ts（tool loop 中执行工具前检查）
 * 服务于：允许一次 / 本次全部允许 / 拒绝
 */
import type { PermissionProvider } from '../core/permission.js';

export class PermissionManager implements PermissionProvider {
  /** "本次全部允许"的路径前缀列表 */
  private autoAllowed: string[] = [];

  /**
   * 检查某操作是否已被"本次全部允许"放过。
   *
   * 逻辑：遍历 autoAllowed 列表，看是否有任一条目是当前操作的前缀。
   *
   * 示例场景：
   *   用户选了"本次全部允许" write:src/
   *   → autoAllowed = ["write:src/"]
   *
   *   后续检查 write:src/data.txt 时：
   *     key = "write:src/data.txt"
   *     autoAllowed.some((prefix) => key.startsWith(prefix))
   *     → "write:src/data.txt".startsWith("write:src/") === true
   *     → 返回 true（自动放行，不再弹窗）
   *
   *   但 check write:/etc/passwd 时：
   *     "write:/etc/passwd".startsWith("write:src/") === false
   *     → 返回 false（不同路径，仍需确认）
   *
   * 用 startsWith 而非 ===，是为了实现"路径前缀匹配"——
   * 授权了一个目录，该目录下所有文件自动放行。
   */
  isAutoAllowed(toolName: string, detail: string): boolean {
    const key = `${toolName}:${detail}`;
    return this.autoAllowed.some((prefix) => key.startsWith(prefix));
  }

  /** 授权某操作 "本次全部允许" */
  grantAutoAllow(toolName: string, detail: string): void {
    this.autoAllowed.push(`${toolName}:${detail}`);
  }

  /** 清空所有授权 */
  clear(): void {
    this.autoAllowed = [];
  }
}
