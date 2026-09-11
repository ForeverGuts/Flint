/**
 * /tasks 命令 —— 显示当前任务清单；没有进行中任务时，回看**最近一份已完成的**。
 *
 * 调用方：commands/loader.ts 自动扫描（本目录每个导出 activate 的文件都会被加载，
 *         新增命令不需要改任何项目代码）
 *
 * ── 为什么需要这个命令 ──
 * 常驻面板在清单清空后会**完全收起**（一行都不占，屏幕保持干净），而 TASK.md 又因
 * "全勾选即删"语义被删掉了。于是"刚刚那一轮到底干完了什么"在屏幕上一个入口都没有。
 * 本命令就是那个入口：把 `TaskStore.lastCompleted()` 这份快照接出来。
 *
 * ── 输出刻意不含 ANSI ──
 * 命令返回值会经 RPC / 非 TTY 通道出去（编辑器插件、脚本），那里颜色转义是噪音。
 * 带颜色的版本在 `io/ui/task-panel.ts` 的 `renderTaskPanel()`，只给终端面板用。
 * 两者共用同一个 `formatTaskList()`，所以记号（✓/▶/☐）不会分家。
 */
import type { Runtime } from '../../runtime/runtime.js';
import { taskStore } from '../../todo/store.js';
import { formatTaskList } from '../../io/ui/task-panel.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('tasks', '显示任务清单（或最近一份已完成的）', () => {
    const current = taskStore.list();
    if (current.length > 0) {
      const c = taskStore.counts();
      return [
        `任务清单（${c.total} 项：${c.done} 完成 / ${c.active} 进行中 / ${c.pending} 待办）`,
        ...formatTaskList(current),
      ].join('\n');
    }

    const last = taskStore.lastCompleted();
    if (last && last.length > 0) {
      return [
        `当前没有进行中的任务。最近一份已完成的清单（${last.length} 项）：`,
        ...formatTaskList(last),
        '',
        '（清单全完成后面板会收起、TASK.md 也会被删，这份快照是回看上一轮的唯一入口）',
      ].join('\n');
    }

    return '当前没有进行中的任务，也没有已完成的历史清单。';
  });
}
