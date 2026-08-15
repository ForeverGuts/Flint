/**
 * hook 扩展示例 —— 演示用户如何订阅系统提示词 hook。
 * 用户操作：在本目录（src/extensions/hooks/）建文件，export registerHooks(ctx)，
 * 系统自动装载，无需改 main。
 */
/** 注册 hook 扩展 */
export function registerHooks(ctx: {
  on(type: string, handler: (event: unknown) => unknown): () => void;
  events: unknown;
}): void {
  // 示例：在发送前给系统提示词追加一段（可被 hook 改写）
  ctx.on('before_request', (event) => {
    if (event && typeof event === 'object' && 'systemPrompt' in event) {
      const e = event as { systemPrompt: string };
      return { systemPrompt: e.systemPrompt + '\n\n## 扩展追加\n（来自 hook 示例）' };
    }
    return undefined;
  });
}
