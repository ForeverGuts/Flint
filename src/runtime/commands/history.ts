/**
 * /history 命令 —— 查看对话历史、回溯（fork）分叉。
 * 调用方：commands.ts（自动扫描器加载）
 * 服务于：ROADMAP P1「对话历史管理」—— 展示当前分支历史 → 选择一条 → 查看/从此继续(fork)
 *
 * 交互流程：
 *   ① 列出当前分支的全部历史消息（每行一条：序号 + 角色 + 内容摘要）
 *   ② 选择一条消息
 *   ③ 子操作：
 *      - 查看：展示该条完整内容
 *      - 从此继续：fork 出新分支（复制到该消息为止），原历史保留，切到新分支
 *      - 取消
 *
 * 设计：树不可变，无"编辑/删除"。要改历史 = fork 到该点重新提问，原历史可审计。
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
  runtime.registerCommand('history', '查看/回溯/分叉对话历史', async () => {
    const msgs = await runtime.getHistoryMessages();
    if (msgs.length === 0) return '📭 当前会话还没有消息。';

    // ── ① 列出当前分支历史消息 ──
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
        { value: 'fork', label: '从此继续（分叉新分支，保留原历史）', description: '' },
        { value: 'cancel', label: '取消', description: '' },
      ],
      `选择操作 — ${ROLE_LABEL[chosen.role] ?? chosen.role}  ${summarize(chosen.content)}`,
    );

    switch (action) {
      case 'view':
        return `📄 ${ROLE_LABEL[chosen.role] ?? chosen.role}：\n${chosen.content}`;

      case 'fork': {
        const newName = await runtime.forkSessionAt(chosen.msgId);
        return `🔀 已分叉到新分支「${newName}」（复制到「${summarize(chosen.content)}」为止），原历史保留。可以直接继续对话。`;
      }

      default:
        return '❌ 已取消';
    }
  });
}
