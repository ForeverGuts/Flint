/**
 * /tasks 命令 —— 显示当前任务清单；没有进行中任务时，回看**最近一份已完成的** + 历史归档。
 *
 * 调用方：commands/loader.ts 自动扫描（本目录每个导出 activate 的文件都会被加载，
 *         新增命令不需要改任何项目代码）
 *
 * ── 为什么需要这个命令 ──
 * 常驻面板在清单清空**或全部完成**后都会**完全收起**（一行都不占，屏幕保持干净），而
 * TASK.md 又因"全勾选即删"语义被删掉了。于是"刚刚那一轮到底干完了什么"在屏幕上一个
 * 入口都没有。本命令就是那个入口：内存快照（lastCompleted）+ 磁盘历史（TASK_HISTORY.md，
 * 2026-09-13 起每次全完成时由 todo 工具自动归档，跨重启可回看）。
 *
 * ── 输出刻意不含 ANSI ──
 * 命令返回值会经 RPC / 非 TTY 通道出去（编辑器插件、脚本），那里颜色转义是噪音。
 * 带颜色的版本在 `io/ui/task-panel.ts` 的 `renderTaskPanel()`，只给终端面板用。
 * 两者共用同一个 `formatTaskList()`，所以记号（✓/▶/☐）不会分家。
 */
import type { Runtime } from '../../runtime/runtime.js';
import { TASK_HISTORY_FILE, TaskStore, taskStore } from '../../todo/store.js';
import { formatTaskList } from '../../io/ui/task-panel.js';

/** 历史最多回看的份数（防一个跑了很久的 cwd 把 /tasks 刷成千行） */
const MAX_HISTORY_SHOWN = 10;

export function activate(runtime: Runtime): void {
  runtime.registerCommand('tasks', '显示任务清单（或历史完成记录）', () => {
    const current = taskStore.list();
    const history = TaskStore.readHistory(TASK_HISTORY_FILE);

    // 有进行中的清单：显示当前 +（若有）一句历史提示
    if (current.length > 0) {
      const c = taskStore.counts();
      return [
        `任务清单（${c.total} 项：${c.done} 完成 / ${c.active} 进行中 / ${c.pending} 待办）`,
        ...formatTaskList(current, { withDuration: true }),
        ...(history.length > 0
          ? ['', `（另有 ${history.length} 份历史完成记录；清单清空或全部完成后 /tasks 可回看）`]
          : []),
      ].join('\n');
    }

    // 没有当前清单：内存快照（最近一份全完成）+ 磁盘历史（带时间戳，最近 N 份）
    const lines: string[] = [];
    const last = taskStore.lastCompleted();
    if (last && last.length > 0) {
      lines.push(
        `当前没有进行中的任务。最近一份已完成的清单（${last.length} 项）：`,
        ...formatTaskList(last, { withDuration: true }),
      );
    }
    if (history.length > 0) {
      const shown = history.slice(-MAX_HISTORY_SHOWN).reverse();   // 最近完成的排最前
      if (lines.length > 0) lines.push('');
      lines.push(`历史完成记录（共 ${history.length} 份${history.length > shown.length ? `，显示最近 ${shown.length} 份` : ''}）：`);
      for (const entry of shown) {
        // 历史那几段**不显示逐项耗时**：归档里刻意没有逐项时间戳（TASK.md 投影不带时间戳，
        // 归档跟着投影走），所以逐项耗时算不出来；能算的只有表头那句**整份跨度**。
        lines.push('', `── ${entry.at} 完成（${entry.items.length} 项${entry.duration ? `，耗时 ${entry.duration}` : ''}）`,
          ...formatTaskList(entry.items));
      }
    }
    if (lines.length > 0) return lines.join('\n');

    return '当前没有进行中的任务，也没有已完成的历史清单。';
  });
}
