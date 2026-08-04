/**
 * /history 命令 —— 查看对话历史、回溯与编辑。
 * 调用方：commands.ts（自动扫描器加载）
 * 服务于：ROADMAP P1「对话历史管理」—— 展示历史 → 选择一条 → 查看/从此继续/编辑
 *
 * 交互流程：
 *   ① 列出全部历史消息（每行一条：序号 + 角色 + 内容摘要）
 *   ② 选择一条消息
 *   ③ 子操作：
 *      - 查看：展示该条完整内容
 *      - 从此继续：删除该条之后的所有消息，回退到该点重新对话
 *      - 编辑：交互输入新内容替换该条
 *      （编辑后该条之后的对话作废，由 truncateSessionAfter 一并删除）
 */
import type { Runtime } from '../runtime.js';

/** 角色显示名 + 图标 */
const ROLE_LABEL: Record<string, string> = {
  user: '👤 你',
  assistant: '🤖 助手',
  system: '⚙️ 系统',
  tool: '🔧 工具',
};

/** 内容摘要：取首行、限 30 可见字符 */
function summarize(content: string): string {
  const firstLine = content.split('\n')[0] || '';
  return firstLine.length > 30 ? firstLine.slice(0, 30) + '…' : firstLine;
}

export function activate(runtime: Runtime): void {
  runtime.registerCommand('history', '查看/回溯/编辑对话历史', async () => {
    const msgs = await runtime.getHistoryMessages();
    if (msgs.length === 0) return '📭 当前会话还没有消息。';

    // ── ① 列出全部历史消息 ──
    const choices = msgs.map((m, i) => ({
      value: m.msgId,
      label: `${String(i + 1).padStart(2)} ${ROLE_LABEL[m.role] ?? m.role}  ${summarize(m.content)}`,
      description: '',
    }));

    const chosenId = await runtime.select(choices, '对话历史（↑↓ 切换  Enter 查看）');
    if (!chosenId) return '❌ 已取消';

    const chosen = msgs.find((m) => m.msgId === chosenId);
    if (!chosen) return '❌ 消息不存在';

    // ── ② 子操作选择 ──
    const action = await runtime.select(
      [
        { value: 'view', label: '查看完整内容', description: '' },
        { value: 'continue', label: '从此继续（删除之后的消息）', description: '' },
        { value: 'edit', label: '编辑这条消息', description: '' },
        { value: 'cancel', label: '取消', description: '' },
      ],
      `选择操作 — ${ROLE_LABEL[chosen.role] ?? chosen.role}  ${summarize(chosen.content)}`,
    );

    switch (action) {
      case 'view':
        return `📄 ${ROLE_LABEL[chosen.role] ?? chosen.role}：\n${chosen.content}`;

      case 'continue': {
        await runtime.truncateSessionAfter(chosen.msgId);
        return `🔀 已回退到「${summarize(chosen.content)}」，此后的消息已删除。可以直接继续对话。`;
      }

      case 'edit': {
        const newContent = await runtime.readLineInput('  输入新内容：');
        if (!newContent.trim()) return '❌ 已取消（内容为空）';
        await runtime.updateSessionMessage(chosen.msgId, newContent);
        await runtime.truncateSessionAfter(chosen.msgId);
        return `✏️ 已更新该消息，后续对话已作废。新内容：\n${newContent}`;
      }

      default:
        return '❌ 已取消';
    }
  });
}
