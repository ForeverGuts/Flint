/**
 * 工具生命周期钩子的 deny 契约解码（P6：工具生命周期 Hook）。
 * 调用方：loop/agent-loop.ts（before_tool_call 发射点拿到 emitHook 返回值后解码）
 * 服务于：把"钩子想拦"这个意图从 unknown 返回值里安全地解出来，形状错了不掀翻主流程
 *
 * 契约（before_tool_call 钩子的返回值）：
 *   - undefined                      → 放行（没钩子 / 钩子没意见 / emitHook 未实现）
 *   - { action: 'deny', reason? }    → 拦截。reason 缺省、非字符串或纯空白 → 用默认理由
 *   - 其它任何形状                    → 放行（fail-open：钩子是基础设施不是策略，
 *                                      写错了不能让所有工具调用集体瘫痪；
 *                                      异常与形状不对都由调用侧记 stderr 后放行）
 *
 * 刻意**没有**改参能力：钩子能拒绝执行（模型与日志都明确知道没跑），
 * 不能静默换参数（模型以为在跑原命令、日志记的也是原命令，实际执行的是另一条，
 * 出了问题两头对不上）。语义决策见 Log/DECISION_LOG.md 锚点 log-2026-09-11-tool-hooks。
 */

/** 钩子表达"拦截"的返回值形状 */
export interface HookDeny {
  action: 'deny';
  /** 拦截理由（会进工具结果给模型看；缺省用默认理由） */
  reason?: string;
}

/** 解码结论：deny=true 时 reason 一定非空 */
export interface DenyVerdict {
  deny: boolean;
  reason: string;
}

/** 钩子返回 deny 形状但没给理由时的默认文案 */
export const HOOK_DENY_DEFAULT_REASON = '未提供理由';

/**
 * 解码 before_tool_call 钩子的返回值。
 * 纯函数：不开进程、不碰总线，verify-hooks.ts 直接逐形状喂假值断言。
 */
export function decodeDeny(result: unknown): DenyVerdict {
  if (typeof result !== 'object' || result === null) return { deny: false, reason: '' };
  if ((result as { action?: unknown }).action !== 'deny') return { deny: false, reason: '' };
  const reason = (result as { reason?: unknown }).reason;
  return {
    deny: true,
    reason:
      typeof reason === 'string' && reason.trim() !== '' ? reason : HOOK_DENY_DEFAULT_REASON,
  };
}
