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
 * ── 层级与耗时（2026-09-17，ROADMAP 10.3.1 / 10.3.4）──
 *   层级：按 parent 链算深度，每层多缩进 `INDENT_UNIT`（算法在 `todo/store.ts` 的 `depthsOf`，
 *         与写盘用的 renderItems **同一份** —— 两处各写一份迟早出现"文件里缩进对了、屏幕上是平的"）。
 *   耗时：**只有 `/tasks` 显示，面板不显示**。面板是常驻的，宽度要留给任务正文；
 *         而且耗时是"看报告"时才关心的事，不是"扫一眼进度"时的信息。这条写在函数签名上
 *         （`withDuration` 由调用方决定），不靠面板自觉。
 *
 * ── 关于 ANSI 常量 ──
 * tree-ui.ts 里有一份更全的 `C`，这里只取面板用得着的四个、就地定义。
 * 抽公共模块当然更"干净"，但那要动一个 823 行的文件去换 4 个转义序列，
 * 代价与收益不成比例。真到需要第三处共用 ANSI 时再抽——那时才算有了动机。
 */
import { INDENT_UNIT, depthsOf, formatDuration, itemDuration, type TaskItem } from '../../todo/store.js';
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

export interface TaskListOptions {
  /** 行首基础缩进，默认 2 空格（与 UI 其它行对齐） */
  indent?: string;
  /** 每层再缩进几个字符，默认 `INDENT_UNIT`；传 0 可关掉层级缩进（旧式平铺输出） */
  step?: number;
  /** 是否在行尾附上耗时（`（耗时 2m30s）`）。从未 start 过的项永远不显示 */
  withDuration?: boolean;
  /** 计算"进行中"耗时的基准时刻，默认 `Date.now()`；测试传定值就能断言到秒 */
  now?: number;
}

/**
 * 渲染成**纯文本**行（不含 ANSI）。
 * 服务于 `/tasks` 命令：命令输出会走 RPC / 非 TTY 通道，那里 ANSI 是噪音。
 * 层级按 `parent` 缩进；`withDuration` 打开时，已开始过的项在行尾附 `（耗时 …）`。
 */
export function formatTaskList(items: TaskItem[], opts: TaskListOptions = {}): string[] {
  const indent = opts.indent ?? '  ';
  const step = opts.step ?? INDENT_UNIT;
  const now = opts.now ?? Date.now();
  const depths = depthsOf(items);
  return items.map((it, i) => {
    const dur = opts.withDuration ? itemDuration(it, now) : null;
    const tail = dur !== null ? `（耗时 ${formatDuration(dur)}）` : '';
    return `${indent}${' '.repeat(step * depths[i])}${MARK[it.status]} ${it.text}${tail}`;
  });
}

/**
 * 渲染常驻面板（带颜色），返回要挂进组件树的行数组。
 *
 * 返回 `[]`（收起）的条件有两个：
 *   ① **空清单** —— 容器没子组件就不渲染，一行都不占。用户要求"没有任务时屏幕保持干净"。
 *   ② **全部完成**（2026-09-13，用户实测反馈）—— 任务做完进入后续对话，面板还挂着
 *      "任务 5/5 ✓✓✓"不散场，只会挡输入框。全完成那一刻 TASK.md 已被"全勾选即删"删掉、
 *      快照进了 `lastCompleted()`（/tasks 回看，历史归档落 TASK_HISTORY.md），
 *      面板没有继续存在的理由——直接零行收起。
 *
 * @param width 终端宽度（超宽截断，避免长任务名把整屏撑歪）
 */
export function renderTaskPanel(items: TaskItem[], width: number): string[] {
  if (items.length === 0 || !items.some((it) => it.status !== 'done')) return [];
  const depths = depthsOf(items);
  const done = items.filter((i) => i.status === 'done').length;
  const lines: string[] = [`${DIM}  任务 ${done}/${items.length}${RESET}`];
  for (const [i, it] of items.entries()) {
    const pad = ' '.repeat(INDENT_UNIT * depths[i]);
    // 宽度按**这一行**的缩进算：深层子项可见宽度更窄，不能拿根层的余量套
    const maxText = Math.max(1, width - 6 - INDENT_UNIT * depths[i]);
    const color = it.status === 'done' ? GREEN : it.status === 'active' ? CYAN : DIM;
    // 已完成项整体压暗（含文本）：一眼看去"已经翻篇的"退到背景里，剩下的才显眼
    const textColor = it.status === 'done' ? DIM : RESET;
    lines.push(`  ${pad}${color}${MARK[it.status]}${RESET} ${textColor}${fitWidth(it.text, maxText)}${RESET}`);
  }
  return lines;
}
