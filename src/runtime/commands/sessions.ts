/**
 * /sessions 命令 —— 切换/新建会话。
 * 调用方：commands.ts（自动扫描器加载）
 * 服务于：ROADMAP P3「多会话管理」—— fork 出多个会话文件后，在此列出、切换、新建
 *
 * 交互流程：
 *   ① 列出 sessions/ 下所有会话文件（名称 + 消息数）
 *   ② 选择切换到某会话，或"新建会话"开一条新线
 *   ③ 切换后 Runtime 换 session，后续对话/历史都在新会话上
 */
import type { Runtime } from '../runtime.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('sessions', '切换/新建会话', async () => {
    const list = await runtime.listSessions();

    // ── 列出已有会话 + 新建选项 ──
    const choices = list.map((s) => ({
      value: `switch:${s.fileName}`,
      label: `${s.fileName}  ·  ${s.msgCount} 条消息`,
      description: '',
    }));
    choices.push({ value: 'create', label: '＋ 新建空会话', description: '' });

    const chosen = await runtime.select(choices, '会话列表（↑↓ 切换  Enter 选择）');
    if (!chosen) return '❌ 已取消';

    if (chosen === 'create') {
      const newName = await runtime.createSession();
      return `🆕 已新建并切换到空会话「${newName}」。`;
    }

    if (chosen.startsWith('switch:')) {
      const fileName = chosen.slice('switch:'.length);
      const ok = await runtime.switchSession(fileName);
      if (!ok) return `❌ 无法切换到会话「${fileName}」`;
      return `🔀 已切换到会话「${fileName}」。`;
    }

    return '❌ 已取消';
  });
}
