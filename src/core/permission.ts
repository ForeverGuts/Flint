/**
 * 权限子系统接口（core 层公共契约）。
 * 调用方：loop/agent-loop.ts（执行工具前权限检查）
 * 服务于：抽象权限管理，隔离具体实现（runtime/permission.ts 的 PermissionManager）
 */
export interface PermissionProvider {
  /** 检查某操作是否已被"本次全部允许"放过 */
  isAutoAllowed(toolName: string, detail: string): boolean;
  /** 授权某操作 "本次全部允许" */
  grantAutoAllow(toolName: string, detail: string): void;
  /** 清空所有授权 */
  clear(): void;
}
