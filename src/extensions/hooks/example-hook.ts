/**
 * hook 扩展示例 —— 演示用户如何订阅系统提示词 hook。
 * 用户操作：在本目录（src/extensions/hooks/）建文件，export registerHooks(ctx)，
 * 系统自动装载，无需改 main。
 *
 * 该放这里还是放 watchers/：看你要不要改写流程。
 *   - 要改（如本例追加一条 system 层消息）→ 用 ctx.on，放 hooks/
 *   - 不改，只想通配收事件做落盘/统计  → 用 ctx.events.subscribe，放 watchers/（参见 trace-log.ts）
 */
import type { SystemPromptMessage } from '../../core/system-prompt.js';

/** 注册 hook 扩展 */
export function registerHooks(ctx: {
  on(type: string, handler: (event: unknown) => unknown): () => void;
  events: unknown;
}): void {
  // 示例：在发送前给分层消息数组追加一条 custom 层 system 消息
  //（独立层追加在末尾，属于变化区，不破坏 core/tools/skills 稳定前缀）
  ctx.on('before_request', (event) => {
    if (event && typeof event === 'object' && 'messages' in event) {
      const e = event as { messages: SystemPromptMessage[] };
      return { messages: [...e.messages, { layer: 'custom', content: '## 扩展追加\n（来自 hook 示例）' }] };
    }
    return undefined;
  });
}
