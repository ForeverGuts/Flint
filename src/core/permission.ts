/**
 * 权限子系统接口（core 层公共契约）。
 * 调用方：loop/agent-loop.ts（执行工具前权限检查）、runtime.ts（clearSession 时清授权）
 * 服务于：抽象权限管理，隔离具体实现（permission/manager.ts 的 PermissionManager）
 */
export interface PermissionProvider {
  /**
   * 检查某操作是否已被"本次全部允许"放过。
   * authKey 由调用方算出：agent-loop 取工具的 permissionKey（core/tools.ts 的可选成员），
   * 工具没定义则退回完整的 args JSON。刻意不叫 detail——detail 在本项目里专指弹窗
   * 显示文案，两者必须是不同的字符串（显示要详细、匹配键要稳定）。
   */
  isAutoAllowed(toolName: string, authKey: string): boolean;
  /** 授权某操作 "本次全部允许"（authKey 同上，必须与检查时用的同一个键） */
  grantAutoAllow(toolName: string, authKey: string): void;
  /** 清空所有授权。调用方：runtime.clearSession()——会话清了，"本次"就到期了 */
  clear(): void;
}
