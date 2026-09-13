/**
 * TaskStore —— 任务清单的**唯一真相源**（内存里的结构化状态）。
 * 调用方：tools/builtin.ts（todo 工具做增删改）、runtime/runtime.ts（注入 system 的 task 层）、
 *         harness/main.ts（启动时把 TASK.md 作为**种子**吸收一次）
 *
 * ── 这套设计的由来：把 CoT 从 token 流里搬出来 ──
 * 思维链（CoT）发生在模型的一次生成里，harness 看不见、拿不到，压缩历史时也不在。
 * 任务列表的价值就是**把这条易失的链外化成一个物件**，让运行时能读到它并据此决策
 * （这正是 flint 早就在做的事：用 TASK.md 是否存在来决定轮数预算与 thinking 开关）。
 *
 * ── C 方案：工具做接口、文件做持久层（本项目 2026-09-11 落地）──
 * 改造前是"文件即状态"：模型用 write 维护 TASK.md，harness 用一个正则数复选框。
 * 三个真实弱点：① write 是**全量覆盖**，改一个勾要重抄整份清单（违背 edit 那条"重抄会误伤"的原则）；
 * ② "结构"只是一个正则（没有 id、没有顺序保证、没有"同时只有一个进行中"的不变量）；
 * ③ 模型可以谎报完成，因为那次"更新"根本不经过工具、不留调用记录。
 *
 * 现在：
 *   - **真相源 = 这份内存状态**（本类）。运行期**只让它说了算** —— runtime 注入 task 层时读它，
 *     不读文件。
 *   - **TASK.md = 投影 + 存档**。每次变更后由工具写盘（`projectToFile`）；进程重启后内存没了，
 *     TASK.md 是唯一还活着的东西，于是启动时**反方向**读它当种子（`loadFromFile`）。
 *     它不是"纯投影"（丢了可从真相源重生），而是"投影 + 存档" —— 这条身份差别见 DECISION_LOG。
 *   - `render` 与 `parse` 必须**严格互逆**：写盘用前者、启动读盘用后者，两者不互逆则重启一次漂一次。
 *     （同一手法在 `Log/` 的生成区已经用过：`syncText` 一份模板同时给"写"和"查"用，两边不会分家。）
 *
 * 零运行时依赖：只用 node:fs（内置）+ 纯数据结构，满足 flint 的硬约束。
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/** 单项状态。`active` 是"进行中"，**同一时刻至多一项**（不变量，由 start 与 parse 共同维护）。 */
export type TaskStatus = 'pending' | 'active' | 'done';

/**
 * 任务历史归档文件名 —— 与 TASK.md 同目录（cwd）。
 * 写入方：todo 工具（每次操作后顺手调 `archiveToFile`）；读取方：/tasks 命令。
 * 任务清单是"当前轮"的状态，历史归档是"过去每一轮全完成时"的存档——两者刻意分文件：
 * TASK.md 有"全勾选即删"语义，归档文件只追加、永不删。
 */
export const TASK_HISTORY_FILE = 'TASK_HISTORY.md';

export interface TaskItem {
  text: string;
  status: TaskStatus;
}

export interface TaskCounts {
  total: number;
  done: number;
  active: number;
  pending: number;
}

/** 状态 → 复选框内的字符（render 用）。`pending` 是空格，与旧 TASK.md 格式逐字兼容。 */
const GLYPH: Record<TaskStatus, string> = { pending: ' ', active: '>', done: 'x' };

/**
 * 匹配一行清单项。兼容旧 TASK.md 的写法（`- [ ] 1. 步骤` / `* [x] 完成` / 缩进变体）。
 * 允许 `]` 后无空格（模型偶尔这么写）；文本两端空白最后统一 trim。
 */
const ITEM_RE = /^\s*[-*]\s*\[([ xX>])\]\s*(.+)$/;

/** 把任意文本规整成单行（换行压成空格、两端 trim）——保证 render/parse 互逆的前提。 */
function sanitize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export class TaskStore {
  private items: TaskItem[] = [];

  /**
   * 变更观察者（**零依赖**：不引入事件总线，只是一个回调集合）。
   *
   * 为什么需要它：任务清单的真相源在内存里，而 `todo` 工具拿不到事件总线
   * （`registerBuiltinTools` 只收 ToolProvider 与 store），改完内存就结束了，
   * UI 无从知晓 → 项目里因此长期没有任务展示。观察者是补这根线的最小手段：
   * store 不必知道"UI"是什么，只需在状态变了的时候吆喝一声。
   *
   * 为什么不走事件总线：那会把 `todo/` 拖进 runtime 的依赖圈，而本目录的立身之本是
   * **零依赖 + 纯数据结构**。观察者保持这个性质——订阅方（UI）反过来 import 本模块。
   */
  private listeners = new Set<() => void>();

  /**
   * 订阅变更。返回**退订函数**（调用方负责在生命周期结束时退订，防泄漏）。
   * 通知是**同步**的：UI 收到后自己决定何时重绘（通常是置一个 dirty 标记）。
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 通知所有订阅者（每个会改变对外可见状态的出口都要调）。单个订阅者抛错不影响其余。 */
  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* 订阅者的错不该打断 store */ }
    }
  }

  /**
   * **最近一份"全部完成"的清单**（面板收起后仍能回看，配套 `/tasks` 命令）。
   *
   * 记录的时机有讲究：不是"清空时"，而是"**最后一项被标记完成的那一刻**"。
   * 前者会把"半途而废被 clear 掉的清单"也存进来，那就不叫"已完成"了。
   * 所以只在 `done()` 之后检查"是否已全完成且非空"才落快照。
   *
   * `clear()` **不清它** —— 这正是它的用途：面板收起、TASK.md 也因"全勾选即删"
   * 被删掉之后，用户还能通过 `/tasks` 看到上一轮干完了什么。
   */
  private lastDone: TaskItem[] | null = null;

  /** 最近一份全部完成的清单（防御性拷贝）；从未完成过任何一轮时为 null。 */
  lastCompleted(): TaskItem[] | null {
    return this.lastDone ? this.lastDone.map((i) => ({ ...i })) : null;
  }

  /**
   * 若当前清单"全部完成且非空"，把它记为最近一份已完成快照。
   * 只在 `done()` 后调用（别的出口不可能让清单从"未完成"变成"全完成"）。
   * 同时挂起一份**待归档**（含完成时刻的时间戳），由 `archiveToFile` 落盘——
   * store 自己不定路径（与 projectToFile 同一分工：文件在哪由调用方说了算）。
   */
  private snapshotIfCompleted(): void {
    if (this.items.length > 0 && !this.hasUnchecked()) {
      const snap = this.items.map((i) => ({ ...i }));
      this.lastDone = snap;
      this.pendingArchive = { at: new Date(), items: snap };
    }
  }

  /**
   * 待归档的"全完成"快照。时间戳记的是**最后一项被标记完成的那一刻**
   * （与 lastDone 同一取时哲学），落盘后即消费置 null（重复调用不产生重复条目）。
   */
  private pendingArchive: { at: Date; items: TaskItem[] } | null = null;

  /**
   * 把待归档快照**追加**进历史文件（`TASK_HISTORY_FILE`，/tasks 回看的落盘侧）。
   * 调用方：todo 工具（每次变更 projectToFile 之后顺手调）。
   * 没有待归档 → 返回 null 且不写。写失败不抛——历史是纯回看性质的存档，
   * 不该让一次 todo 变 [ERROR]；pendingArchive 保留（下次操作重试），
   * 错误信息交工具附进返回值提醒。
   */
  archiveToFile(path: string): string | null {
    if (!this.pendingArchive) return null;
    try {
      const { at, items } = this.pendingArchive;
      const pad = (n: number): string => String(n).padStart(2, '0');
      const ts = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
        + ` ${pad(at.getHours())}:${pad(at.getMinutes())}`;
      appendFileSync(path, `## ${ts} 完成\n${TaskStore.renderItems(items)}\n\n`, 'utf-8');
      this.pendingArchive = null;
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * 读历史归档（/tasks 回看）。与归档格式严格配对：`## <时间戳> 完成` 开块，
   * 块内是 renderItems 的清单行（解析复用 ITEM_RE，glyph 语义与 fromMarkdown 同一套）。
   * 文件不存在 / 读失败 → 空数组（历史是锦上添花，不能让它炸掉命令）。
   * 空块（只有标题没有条目）丢弃——那不是一份完整的清单。
   */
  static readHistory(path: string): Array<{ at: string; items: TaskItem[] }> {
    try {
      if (!existsSync(path)) return [];
      const entries: Array<{ at: string; items: TaskItem[] }> = [];
      let cur: { at: string; items: TaskItem[] } | null = null;
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        if (line.startsWith('## ')) {
          cur = { at: line.slice(3).replace(/\s*完成\s*$/, '').trim(), items: [] };
          entries.push(cur);
          continue;
        }
        const m = ITEM_RE.exec(line);
        if (!m || !cur) continue;
        const text = sanitize(m[2]);
        if (!text) continue;
        const raw = m[1].toLowerCase();
        cur.items.push({ text, status: raw === 'x' ? 'done' : raw === '>' ? 'active' : 'pending' });
      }
      return entries.filter((e) => e.items.length > 0);
    } catch {
      return [];
    }
  }

  /** 只读快照（防御性拷贝：调用方拿不到内部数组的引用） */
  list(): TaskItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  counts(): TaskCounts {
    const c: TaskCounts = { total: this.items.length, done: 0, active: 0, pending: 0 };
    for (const it of this.items) c[it.status]++;
    return c;
  }

  /** 还有"未完成"（pending 或 active）吗 —— 决定续传提示 / 轮数预算 / thinking auto。 */
  hasUnchecked(): boolean {
    return this.items.some((i) => i.status !== 'done');
  }

  /** 空清单（无任何项）。 */
  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * 追加一项（pending）。返回它的 **1 基序号**。
   * 空白文本拒绝（返回 -1），由工具转成 [INVALID] —— 空步骤是无意义的状态。
   */
  add(text: string): number {
    const t = sanitize(text);
    if (!t) return -1;              // 拒绝 → 状态没变 → 不通知（避免 UI 无谓重绘）
    this.items.push({ text: t, status: 'pending' });
    this.notify();
    return this.items.length;
  }

  /**
   * 把第 index（1 基）项标记为**进行中**。同时把其它进行中项降回 pending，维持唯一 active 不变量。
   * 越界返回 false。允许对已完成的项重新 start（回退意图）。
   */
  start(index: number): boolean {
    if (!this.valid(index)) return false;
    this.items = this.items.map((it, i) =>
      i === index - 1 ? { ...it, status: 'active' }
        : it.status === 'active' ? { ...it, status: 'pending' } : it,
    );
    this.notify();
    return true;
  }

  /** 把第 index（1 基）项标记为完成。越界返回 false。 */
  done(index: number): boolean {
    if (!this.valid(index)) return false;
    this.items[index - 1] = { ...this.items[index - 1], status: 'done' };
    this.snapshotIfCompleted();   // 全完成的那一刻留下快照（供 /tasks 回看）
    this.notify();
    return true;
  }

  /**
   * 清空清单。**不清 `lastCompleted`** —— 见该字段的注释：
   * 面板收起 + TASK.md 已删之后，它是唯一还能回看上一轮的地方。
   */
  clear(): void {
    const had = this.items.length > 0;
    this.items = [];
    if (had) this.notify();
  }

  /**
   * 彻底复位：清空当前清单**并丢掉快照**。
   *
   * 与 `clear()` 的差别只有一件事——**它连 `lastCompleted` 一起清掉**。
   * `clear()` 是模型说"这轮干完了"，快照必须留着给 `/tasks` 回看；
   * `reset()` 是"假装这个进程从没跑过"，只服务于**测试隔离**
   * （尤其 `/tasks` 命令测的是进程级单例，测完必须把它擦干净）。
   * 生产代码不该用它。
   */
  reset(): void {
    this.items = [];
    this.lastDone = null;
    this.pendingArchive = null;   // 测试隔离同样不欠历史账
    this.notify();
  }

  private valid(index: number): boolean {
    return Number.isInteger(index) && index >= 1 && index <= this.items.length;
  }

  /**
   * 渲染成 Markdown 清单 —— 这是写进 TASK.md 的**投影**，也是注入 system 的文本来源。
   * 与 `parse` 严格互逆：`parse(render())` 还原出逐字相同的 items（verify-todo ②段用属性测试钉死）。
   */
  /**
   * 渲染任意一份清单 —— **全项目唯一的"清单怎么排版"的实现**。
   * `render()` / `renderNumbered()` / `/tasks` 的输出全部走这里，
   * 于是 glyph 只有 `GLYPH` 一处定义，不可能出现"磁盘上是 `[x]`、终端上画成别的"。
   * （同一手法：Log/ 生成区的 `syncText` 一份模板同时给"写"和"查"用。）
   */
  static renderItems(items: TaskItem[], numbered = false): string {
    return items
      .map((it, i) => numbered
        ? `${i + 1}. [${GLYPH[it.status]}] ${it.text}`
        : `- [${GLYPH[it.status]}] ${it.text}`)
      .join('\n');
  }

  render(): string {
    return TaskStore.renderItems(this.items);
  }

  /**
   * 渲染成**给模型看的**带序号清单（工具返回值）。
   * 序号即后续 `start` / `done` 要传的 index —— 模型据此指认目标，不必靠猜。
   */
  renderNumbered(): string {
    return TaskStore.renderItems(this.items, true);
  }

  /**
   * 从 Markdown 解析出清单（**启动种子**方向）。
   * 只认清单行；标题、散文、空行一律跳过（旧 TASK.md 的 `## 目标` 等 prose 因此被丢弃——
   * 本机制只负责**步骤**，这是刻意的简化，见 DECISION_LOG）。
   * 多 `[>]` 归一：只保留第一处为 active，其余降为 pending（维持不变量）。
   */
  static fromMarkdown(md: string): TaskStore {
    const store = new TaskStore();
    let activeTaken = false;
    for (const line of md.split('\n')) {
      const m = ITEM_RE.exec(line);
      if (!m) continue;
      const text = sanitize(m[2]);
      if (!text) continue;
      const raw = m[1].toLowerCase();
      let status: TaskStatus = raw === 'x' ? 'done' : raw === '>' ? 'active' : 'pending';
      if (status === 'active') {
        if (activeTaken) status = 'pending';
        else activeTaken = true;
      }
      store.items.push({ text, status });
    }
    return store;
  }

  /**
   * 启动种子：把 TASK.md 读进来当初始清单。
   * 顺手做**旧清理语义**（阶段 C2 的"全勾选即删"）：文件里没有未完成项（空文件 / 全 [x]）
   * 时，删除文件、保持空清单 —— 遗留的已完成计划不再放大轮数预算、不再触发 auto thinking。
   * 读不到/读失败一律当空清单，不阻塞启动。
   */
  loadFromFile(path: string): void {
    try {
      if (!existsSync(path)) return;
      const content = readFileSync(path, 'utf-8');
      const store = TaskStore.fromMarkdown(content);
      if (!store.hasUnchecked()) {
        try { unlinkSync(path); } catch { /* 清理失败不阻塞启动 */ }
        this.items = [];
        this.notify();
        return;
      }
      this.items = store.items;
      this.notify();
    } catch {
      /* 读取失败 → 无工作记忆，保持现状 */
    }
  }

  /**
   * 投影：把当前状态写进 TASK.md（每次变更后由 todo 工具调用）。
   * 有未完成项 → 写 `render()`；无（空 / 全完成）→ **删除文件**（沿用"全勾选即删"语义）。
   *
   * 这是**系统行为**，不是模型动作：不走权限弹窗（否则每次更新都弹窗）。失败不抛——
   * 内存状态仍是真相源，写盘失败最多丢"跨重启存档"，不该让一次 todo 变成 [ERROR]。
   * @returns 出错信息（成功为 null），供工具附在返回值里提醒模型
   */
  projectToFile(path: string): string | null {
    try {
      if (!this.hasUnchecked()) {
        if (existsSync(path)) unlinkSync(path);
        return null;
      }
      writeFileSync(path, `${this.render()}\n`, 'utf-8');
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
}

/**
 * 进程级默认实例 —— flint 是单 Agent CLI（一个进程 = 一个会话 = 一份清单），
 * 与既有的模块级 `loadTaskMemory` 同一手法：tool 与 runtime 自动共享同一份状态，不必层层透传参数。
 * 测试要隔离时自己 `new TaskStore()`（或调 `reset()`），互不干扰。
 */
export const taskStore = new TaskStore();
