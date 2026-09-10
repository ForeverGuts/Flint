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
import type { Runtime } from '../../runtime/runtime.js';
import { STEER_PREFIX } from '../../runtime/runtime.js';

/** 角色显示名 + 图标 */
const ROLE_LABEL: Record<string, string> = {
  user: '👤 你',
  assistant: '🤖 助手',
  system: '⚙️ 系统',
  tool: '🔧 工具',
};

/**
 * 条目显示名：内层引导（steering）优先判定。
 * 引导落盘时是 user 角色（role + content 是三个存储后端都保的通道），只看角色会与用户输入
 * 混淆，所以按内容前缀单独标一行 —— 用户看得出这句是在助手执行途中插进去的。
 */
function labelOf(m: { role: string; steer: boolean }): string {
  return m.steer ? '⚡ 中途引导' : (ROLE_LABEL[m.role] ?? m.role);
}

/** 内容摘要：取首行、限 30 可见字符（引导条目剥掉标记前缀，免得每行都以 [用户引导] 开头） */
function summarize(content: string): string {
  const body = content.startsWith(STEER_PREFIX) ? content.slice(STEER_PREFIX.length) : content;
  const firstLine = body.split('\n')[0] || '';
  return firstLine.length > 30 ? firstLine.slice(0, 30) + '…' : firstLine;
}

export function activate(runtime: Runtime): void {
  runtime.registerCommand('history', '查看/回溯/分叉对话历史', async () => {
    const msgs = await runtime.getHistoryMessages();
    if (msgs.length === 0) return '📭 当前会话还没有消息。';

    // ── ① 列出当前分支历史消息 ──
    const choices = msgs.map((m, i) => ({
      value: m.msgId,
      label: `${String(i + 1).padStart(2)} ${labelOf(m)}  ${summarize(m.content)}`,
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
      `选择操作 — ${labelOf(chosen)}  ${summarize(chosen.content)}`,
    );

    switch (action) {
      case 'view':
        return `📄 ${labelOf(chosen)}：\n${chosen.content}`;

      case 'fork': {
        const newName = await runtime.forkSessionAt(chosen.msgId);
        return `🔀 已分叉到新分支「${newName}」（复制到「${summarize(chosen.content)}」为止），原历史保留。可以直接继续对话。`;
      }

      default:
        return '❌ 已取消';
    }
  });
}
