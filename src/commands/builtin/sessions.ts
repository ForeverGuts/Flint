/**
 * /sessions 命令 —— 切换/新建/删除会话。
 * 调用方：commands.ts（自动扫描器加载）
 * 服务于：ROADMAP P3「多会话管理」+ P6「会话仓库层」——
 *         fork 出多个会话文件后，在此列出、切换、新建、删除
 *
 * 交互流程：
 *   ① 列出 sessions/ 下所有会话文件（名称 + 消息数，当前会话带 ● 标记）
 *   ② 选择切换到某会话、新建会话，或进入删除流程
 *   ③ 删除流程：选定目标（当前会话被禁用，Runtime 守卫双保险）→ 二次确认 → 删除
 *
 * 删除走 repo 层（runtime.deleteSession → SessionRepo.remove）；
 * 守卫分两层：UI 禁选当前会话 + Runtime 拒绝删除当前会话文件（防误删活跃线）。
 */
import type { Runtime } from '../../runtime/runtime.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('sessions', '切换/新建/删除会话', async () => {
    const list = await runtime.listSessions();
    const currentFile = runtime.getCurrentSessionFile();
    // 只取文件名做比对（getCurrentSessionFile 返回完整路径）
    const currentName = currentFile ? currentFile.replace(/^.*[\\/]/, '') : undefined;

    // ── 列出已有会话 + 新建/删除入口 ──
    const choices = list.map((s) => ({
      value: `switch:${s.fileName}`,
      label: `${s.fileName === currentName ? '● ' : ''}${s.fileName}  ·  ${s.msgCount} 条消息`,
      description: '',
    }));
    choices.push({ value: 'create', label: '＋ 新建空会话', description: '' });
    choices.push({ value: 'delete', label: '🗑 删除会话…', description: '' });

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

    // ── 删除流程：选定目标（当前会话禁选）→ 二次确认 ──
    if (chosen === 'delete') {
      const targets = list.map((s) => ({
        value: s.fileName,
        label: `${s.fileName}  ·  ${s.msgCount} 条消息`,
        // 当前活跃会话禁选（UI 层守卫；Runtime 的 deleteSession 还有第二道）
        disabled: s.fileName === currentName,
        description: s.fileName === currentName ? '当前会话不可删除，请先切换' : '',
      }));
      if (targets.every((t) => t.disabled)) return 'ℹ️ 没有可删除的会话（目录里只有当前会话）。';

      const target = await runtime.select(targets, '要删除哪个会话？（当前会话已禁选）');
      if (!target) return '❌ 已取消';

      const confirm = await runtime.select(
        [
          { value: 'yes', label: `🗑 确认删除「${target}」（不可恢复）`, description: '' },
          { value: 'no', label: '取消', description: '' },
        ],
        '二次确认',
      );
      if (confirm !== 'yes') return '❌ 已取消';

      const ok = await runtime.deleteSession(target);
      if (!ok) return `❌ 无法删除会话「${target}」（不存在，或它是当前会话）。`;
      return `🗑 已删除会话「${target}」。`;
    }

    return '❌ 已取消';
  });
}
