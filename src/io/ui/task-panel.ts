/**
 * 任务面板渲染 —— 终端里那块常驻的进度面板（输入框上方）。
 *
 * 调用方：io/ui/tree-ui.ts（画面板）、commands/builtin/tasks.ts（`/tasks` 命令输出）
 *
 * ── 为什么是纯函数、且不碰 TreeUI ──
 * TreeUI 要 TTY 才跑得起来，而"清单长什么样"这件事值得单独验。
 * 于是这里只收 `TaskItem[]` 与 width、返回 `string[]`，**不知道 Screen 是什么**——
 * 测试可以在内存里喂任意清单断言输出，不必起终端。
 *
 * ── 三态记号 ──
 *   完成 ✓ / 进行中 ▶ / 待办 ☐
 * "没完成的留空框"是用户明确要的效果：☐ 是**空**的，一眼能数出还剩几个没干。
 * 进行中单独用一个实心三角：它是"没完成"，但和"还没轮到"不是一回事，压成同一个记号就丢信息了。
 *
 * ── 关于 ANSI 常量 ──
 * tree-ui.ts 里有一份更全的 `C`，这里只取面板用得着的四个、就地定义。
 * 抽公共模块当然更"干净"，但那要动一个 823 行的文件去换 4 个转义序列，
 * 代价与收益不成比例。真到需要第三处共用 ANSI 时再抽——那时才算有了动机。
 */
import type { TaskItem } from '../../todo/store.js';
import { fitWidth } from './fit-width.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';

/** 状态 → 记号。`pending` 是**空框**（对应"没完成的留有余空"）。 */
const MARK: Record<TaskItem['status'], string> = {
  done: '✓',
  active: '▶',
  pending: '☐',
};

/**
 * 渲染成**纯文本**行（不含 ANSI）。
 * 服务于 `/tasks` 命令：命令输出会走 RPC / 非 TTY 通道，那里 ANSI 是噪音。
 * @param indent 行首缩进，默认 2 空格（与 UI 其它行对齐）
 */
export function formatTaskList(items: TaskItem[], indent = '  '): string[] {
  return items.map((it) => `${indent}${MARK[it.status]} ${it.text}`);
}

/**
 * 渲染常驻面板（带颜色），返回要挂进组件树的行数组。
 *
 * **空清单返回 `[]`** —— 这是"立即收起"的实现方式：容器没子组件就不渲染，
 * 一行都不占。用户要求"没有任务时屏幕保持干净"，代价是清空后当前快照查不到，
 * 由 `/tasks` 命令 + `TaskStore.lastCompleted()` 兜底回看。
 *
 * @param width 终端宽度（超宽截断，避免长任务名把整屏撑歪）
 */
export function renderTaskPanel(items: TaskItem[], width: number): string[] {
  if (items.length === 0) return [];
  const done = items.filter((i) => i.status === 'done').length;
  const maxText = Math.max(1, width - 6);   // 2 缩进 + 1 记号 + 1 空格 + 2 安全边距
  const lines: string[] = [`${DIM}  任务 ${done}/${items.length}${RESET}`];
  for (const it of items) {
    const color = it.status === 'done' ? GREEN : it.status === 'active' ? CYAN : DIM;
    // 已完成项整体压暗（含文本）：一眼看去"已经翻篇的"退到背景里，剩下的才显眼
    const textColor = it.status === 'done' ? DIM : RESET;
    lines.push(`  ${color}${MARK[it.status]}${RESET} ${textColor}${fitWidth(it.text, maxText)}${RESET}`);
  }
  return lines;
}
