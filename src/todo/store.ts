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
 * ── 层级 / 依赖 / 时间戳（2026-09-17，ROADMAP 10.3.1 · 10.3.2 · 10.3.4）──
 * 清单从"扁平一维"长成**一棵树 + 一张先后图**，但**不新增任何状态概念**：
 *   - **层级**用 `parent`（指向**更早**登记的项，0 = 根）。层级只影响**排版缩进**与"这条挂在谁下面"，
 *     **不派生父项状态** —— 父项仍是一条普通步骤，与路线图那边的"父级状态由子树派生"**刻意相反**：
 *     那边父级是**坐标系**（一个容器），这边父级是**步骤**（自己也要被执行）。所以会出现
 *     "子项进行中、父项还是待办"，那是真的。
 *   - **依赖**用 `after`（指向**更早**的项），语义只有一条：**它没完成就不能 `start`**。
 *     `done` 刻意不拦（完成是事实陈述，拦住它只会把模型卡死在一个错登记的依赖上）。
 *   - **两个字段都只许指向更早的项** —— 这一条同时给出两个免费的性质：**不可能有环**（指向过去），
 *     以及**序号永远稳定**（清单只追加、从无删除，于是 1 基序号不会因增删而漂移）。
 *   - **时间戳三个**：`createdAt` / `startedAt` / `doneAt`（epoch ms）。它们**刻意不进 TASK.md 投影**：
 *     时间戳是**会话内**的运行时事实，而 TASK.md 是投影 + 启动种子 —— 落盘就要进互逆契约，而"从文件里
 *     恢复出'这个步骤当时是几点开始的'"只会给出一个假精确的答案。跨会话的耗时由**归档表头**承载
 *     （`TASK_HISTORY.md` 的 `## <时间> 完成（耗时 X）` 记的是**整份清单**的跨度，那是真的算得出来的）。
 *     代价写在这里而不是藏起来：**属性测试的互逆口径 = 结构字段（text/status/parent/after）**，
 *     时间戳由另一条断言单独钉（`verify-todo.ts` ② 段把"哪些字段参与互逆"列成白名单并断言键数，
 *     于是"以后新增字段忘了归类"会当场变红，而不是静默漏测）。
 *
 * ── 依赖标记为什么要转义 ──
 * 依赖写在行尾（`- [ ] 写测试 ←1`），parse 靠 `/\s←(\d+)$/` 摘回来 —— 那么**任务正文本身以
 * ` ←3` 结尾**时就会歧义。修法是把 `←` 在渲染时编码成一个**前缀码**：`⇐⇐` → `⇐`、`⇐←` → `←`
 * （`⇐` 自己先被翻倍，`←` 则编成两字符）。前缀码保证解码唯一，于是 `render → parse` 对**任意**
 * 正文都是可逆的 —— 包括正文里本来就有 `←` 或 `⇐` 的情况（属性测试的字符池刻意含这两个字符）。
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

/** 每层缩进的空格数。render 与 parse 共用这一个常量（各写一份就会漂）。 */
export const INDENT_UNIT = 2;

export interface TaskItem {
  text: string;
  status: TaskStatus;
  /**
   * 父项序号（1 基，指向**更早**登记的项）；0 = 顶层。
   * 层级**不派生状态**：父项也是一条要执行的步骤，不是容器。
   */
  parent: number;
  /**
   * 前置依赖（1 基，指向**更早**的项）：没完成就不能 `start`。`null` = 无依赖。
   * 只许指向更早的项 ⇒ 不可能有环。
   */
  after: number | null;
  /** 登记时刻（epoch ms）。从 TASK.md 种子恢复的项为 null（文件里没有这个事实）。 */
  createdAt: number | null;
  /** 开始时刻；从未 start 过为 null。 */
  startedAt: number | null;
  /** 完成时刻；未完成 / 由种子恢复的项为 null。 */
  doneAt: number | null;
  /**
   * **落实这项的那次提交的短 hash**（ROADMAP 10.5.4 的"任务 ↔ 提交关联"）；null = 还没关联。
   *
   * ⚠ **它只活在内存里，不进 TASK.md 投影**（`render()` 不带它）。三条理由：
   *   ① 投影的 **render/parse 严格互逆**是本机制三条承重之一，加第三个行尾标记要同时改
   *      encode / render / parse 三处并把一整批互逆断言重新钉一遍 —— 风险落在最承重的地方；
   *   ② hash 是**本轮的事实**：TASK.md 的用途是"续传还没做完的步骤"，而"上次是在哪个提交
   *      里做的"是**回看**性质，那条路归事件库（events.jsonl，拉通道、不占上下文）；
   *   ③ 一个提交 hash 挂在一行清单里，下一轮再读进来时没人消费它 —— 只占地方。
   * 于是：本轮内模型能在清单上看见它（`renderNumbered`）、UI 不显示（面板宽度按"还剩几项"
   * 排的），**跨会话则只留在 events.jsonl 里**（那里每次关联都记一条，历史不丢）。
   *
   * **只留最后一次**：同一项改了两次会有两个 hash，这里保留后写的那个（清单是"当前状态"，
   * 完整的那串提交在 git log 里，不需要在这里再存一份数组）。
   */
  commit: string | null;
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

/** 依赖标记：行尾的 ` ←<序号>`（"等 N 做完"）。渲染时追加，解析时摘掉。 */
const AFTER_RE = /\s←(\d+)$/;

/**
 * 父项标记：行尾的 ` ⤴<序号>`（"挂在 N 之下"）。**只在缩进推不出来的时候才出现** ——
 * 为什么必须有它：Markdown 大纲能表达的是"子项紧跟在父项之后"，而本清单是**只追加**的，
 * 于是"给早已登记的第 1 项补一个子步骤、而它后面还排着同层的第 2、3 项"这种位置，
 * **缩进表达不了**（解析方只会把它认成第 3 项的子项）。这条不是理论问题：
 * 探针实测就复现了——投影出去再读回来，parent 从 1 变成 3，**层级静默漂移**。
 * 缩进推得出来时（正常按大纲顺序规划）一个标记都不加，于是常见形态的行与改前**逐字相同**。
 */
const PARENT_RE = /\s⤴(\d+)$/;

/** 行首空格数 → 层级（向下取整；跳级由"挂到最近的更浅一项"吸收）。 */
const LEADING_RE = /^\s*/;

/**
 * 把任意文本规整成单行（换行压成空格、两端 trim）——保证 render/parse 互逆的前提。
 */
function sanitize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 正文编码（前缀码，解码唯一）：`⇐` → `⇐⇐`、`←` → `⇐←`、`⤴` → `⇐⤴`。
 * 三个码字都是"以 `⇐` 开头的两字符"，第二个字符彼此不同 ⇒ 无歧义。
 * 两步顺序是承重的：先把 `⇐` 翻倍，再把另两个字符编成两字符 —— 第二步只认第一步**没碰过**的字符。
 */
function encodeText(text: string): string {
  return text.replace(/⇐/g, '⇐⇐').replace(/←/g, '⇐←').replace(/⤴/g, '⇐⤴');
}

/**
 * 正文解码。**只认三个码字**（`⇐⇐` → `⇐`、`⇐←` → `←`、`⇐⤴` → `⤴`），其余字符原样透传；
 * 孤立的 `⇐`（后面接的既不是 `⇐` 也不是那两个箭头）也原样保留 —— 手写的 TASK.md 里本来就
 * 可能冒出来，宽容读取比当场报错更符合"种子读不进来就不阻塞启动"的口径。
 */
function decodeText(enc: string): string {
  let out = '';
  for (let i = 0; i < enc.length; i++) {
    const ch = enc[i];
    if (ch !== '⇐') { out += ch; continue; }
    const next = enc[i + 1];
    if (next === '⇐') { out += '⇐'; i++; }
    else if (next === '←') { out += '←'; i++; }
    else if (next === '⤴') { out += '⤴'; i++; }
    else out += '⇐';
  }
  return out;
}

/**
 * 每项的**层级深度**（根为 0）—— 全项目唯一的算法，render 与面板共用。
 * 父项一定指向更早的项（add / parse 都保证），所以一趟顺序扫描即可，**不可能有环**；
 * 越界或自指的 parent（手写文件 / 手工构造）按根处理，**不抛**。
 */
export function depthsOf(items: ReadonlyArray<Pick<TaskItem, 'parent'>>): number[] {
  const depth: number[] = [];
  return items.map((it, i) => {
    const p = it.parent;
    const d = p >= 1 && p <= i ? depth[p - 1] + 1 : 0;
    depth.push(d);
    return d;
  });
}

/** 把时长格式化成人类读得懂的一小段（`45s` / `2m30s` / `1h05m`）。负值按 0。 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * 单项耗时。三态：
 *   - 从未 start 过 → null（**答不出来就说答不出来**，不编一个 0）
 *   - 进行中 → now - startedAt（随时间生长）
 *   - 已完成 → doneAt - startedAt（定格）
 * 时钟回拨导致 end < startedAt 时也返回 null，而不是负数。
 */
export function itemDuration(it: TaskItem, now: number): number | null {
  if (it.startedAt === null) return null;
  const end = it.doneAt ?? (it.status === 'active' ? now : null);
  if (end === null || end < it.startedAt) return null;
  return end - it.startedAt;
}

/** `add` 的三种拒绝理由（机器读字段，工具层据此选文案，不解析文本）。 */
export type AddFailure = 'empty-text' | 'bad-parent' | 'bad-after';

export type AddOutcome =
  | { kind: 'added'; index: number }
  | { kind: 'empty-text' }
  | { kind: 'bad-parent'; parent: number }
  | { kind: 'bad-after'; after: number };

/**
 * `start` 的三种结局。`blocked` 带上是**谁**挡着的（序号 + 正文）——
 * 回执要能直接告诉模型"先去做哪一项"，否则它只会反复重试同一个 start。
 */
export type StartOutcome =
  | { kind: 'started'; index: number }
  | { kind: 'out-of-range'; index: number; total: number }
  | { kind: 'blocked'; index: number; by: number; byText: string };

export class TaskStore {
  private items: TaskItem[] = [];

  /**
   * 时钟（可注入）。默认 `Date.now`；测试传假时钟，就能对耗时做**确定性**断言，
   * 而不是"跑一下大概差几百毫秒"。
   */
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

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
      this.pendingArchive = { at: new Date(this.now()), items: snap };
    }
  }

  /**
   * 待归档的"全完成"快照。时间戳记的是**最后一项被标记完成的那一刻**
   * （与 lastDone 同一取时哲学），落盘后即消费置 null（重复调用不产生重复条目）。
   */
  private pendingArchive: { at: Date; items: TaskItem[] } | null = null;

  /**
   * 是否有待归档快照（"全完成"已发生、archiveToFile 还没消费掉）。
   * archiveToFile 成功与"无事可归"都返回 null，光看返回值分不出这两态——
   * 事件库的自动补记（recordTaskArchive）靠它当判据：只有真归档了那次才补。
   */
  hasPendingArchive(): boolean {
    return this.pendingArchive !== null;
  }

  /**
   * 把待归档快照**追加**进历史文件（`TASK_HISTORY_FILE`，/tasks 回看的落盘侧）。
   * 调用方：todo 工具（每次变更 projectToFile 之后顺手调）。
   * 没有待归档 → 返回 null 且不写。写失败不抛——历史是纯回看性质的存档，
   * 不该让一次 todo 变 [ERROR]；pendingArchive 保留（下次操作重试），
   * 错误信息交工具附进返回值提醒。
   *
   * 2026-09-17 起表头多一段**整份清单的耗时**：`## <时间> 完成（耗时 2m30s）`。
   * 跨会话的耗时只在这里有（逐项时间戳刻意不进 TASK.md 投影），而它**算得出来**：
   * 最后一项完成时刻 − 最早一项登记时刻。任一时刻缺失或为负就不写那半句
   * （旧文件、种子恢复的清单都会缺），此时表头与改前**逐字相同** ⇒ 解析向后兼容。
   */
  archiveToFile(path: string): string | null {
    if (!this.pendingArchive) return null;
    try {
      const { at, items } = this.pendingArchive;
      const pad = (n: number): string => String(n).padStart(2, '0');
      const ts = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
        + ` ${pad(at.getHours())}:${pad(at.getMinutes())}`;
      const span = TaskStore.spanOf(items);
      const dur = span !== null ? `（耗时 ${formatDuration(span)}）` : '';
      appendFileSync(path, `## ${ts} 完成${dur}\n${TaskStore.renderItems(items)}\n\n`, 'utf-8');
      this.pendingArchive = null;
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * 整份清单的耗时跨度 = 最后一个完成时刻 − 最早一个登记时刻。
   * 缺任一时刻（种子恢复 / 手写文件）或算出负数 → null（**答不出就说答不出**）。
   */
  static spanOf(items: ReadonlyArray<TaskItem>): number | null {
    const created = items.map((i) => i.createdAt).filter((n): n is number => n !== null);
    const done = items.map((i) => i.doneAt).filter((n): n is number => n !== null);
    if (created.length === 0 || done.length === 0) return null;
    const span = Math.max(...done) - Math.min(...created);
    return span >= 0 ? span : null;
  }

  /**
   * 读历史归档（/tasks 回看）。与归档格式严格配对：`## <时间戳> 完成[（耗时 X）]` 开块，
   * 块内是 renderItems 的清单行（解析复用 `parseLines`，glyph 与层级语义与 fromMarkdown 同一套）。
   * 文件不存在 / 读失败 → 空数组（历史是锦上添花，不能让它炸掉命令）。
   * 空块（只有标题没有条目）丢弃——那不是一份完整的清单。
   * 旧格式（表头没有耗时那半句）照样认，此时 `duration` 为 null。
   */
  static readHistory(path: string): Array<{ at: string; duration: string | null; items: TaskItem[] }> {
    try {
      if (!existsSync(path)) return [];
      return TaskStore.blocksOf(readFileSync(path, 'utf-8')).filter((b) => b.items.length > 0);
    } catch {
      return [];
    }
  }

  /** 把归档文件切成一"块"一"块"（表头 + 行），块内解析复用 `parseLines`。 */
  private static blocksOf(content: string): Array<{ at: string; duration: string | null; items: TaskItem[] }> {
    const blocks: Array<{ at: string; duration: string | null; items: TaskItem[] }> = [];
    let cur: { at: string; duration: string | null; lines: string[] } | null = null;
    const flush = (): void => {
      if (cur) blocks.push({ at: cur.at, duration: cur.duration, items: TaskStore.parseLines(cur.lines) });
      cur = null;
    };
    for (const line of content.split('\n')) {
      const h = /^##\s*(.+?)\s*完成(?:\s*（耗时\s*([^）]*)）)?\s*$/.exec(line);
      if (h) { flush(); cur = { at: h[1].trim(), duration: h[2]?.trim() || null, lines: [] }; continue; }
      if (cur) cur.lines.push(line);
    }
    flush();
    return blocks;
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
   * 追加一项（pending）。三种拒绝各有**独立形状**（机器读 `kind`，工具层去选文案）：
   * 空正文 / 父项不存在 / 依赖项不存在。
   *
   * 为什么 `parent`/`after` 只许指向**已存在**的项：这条同时给出"不可能有环"（只能指向过去）
   * 与"序号稳定"（清单只追加、从不删除）两个性质。二者都不是风格问题——
   * 环会让 render 的层级计算发散，序号漂移会让"index=3"这句话在两次调用之间指向不同的项。
   */
  add(text: string, parent = 0, after = 0): AddOutcome {
    const t = sanitize(text);
    if (!t) return { kind: 'empty-text' };          // 拒绝 → 状态没变 → 不通知（避免 UI 无谓重绘）
    const total = this.items.length;
    if (parent !== 0 && !(parent >= 1 && parent <= total)) return { kind: 'bad-parent', parent };
    if (after !== 0 && !(after >= 1 && after <= total)) return { kind: 'bad-after', after };
    this.items.push({
      text: t, status: 'pending', parent, after: after === 0 ? null : after,
      createdAt: this.now(), startedAt: null, doneAt: null,
      commit: null,   // 新登记的一项还没被任何提交落实
    });
    this.notify();
    return { kind: 'added', index: this.items.length };
  }

  /**
   * 把第 index（1 基）项标记为**进行中**。同时把其它进行中项降回 pending，
   * 维持"**全局至多一项**进行中"这条唯一不变量 —— 层级不影响它（2026-09-17 拍定：
   * 不变量的判定保持全局，插入层级一个字都不用改）。允许对已完成的项重新 start（回退意图）。
   *
   * **前置校验**：`after` 指向的那项还没完成 → 拒绝（`blocked`，带上是谁挡着）。
   * 前置缺失（理论上不可能：指向前序项 + 无删除）按**已满足**处理 —— fail-open，
   * 不让一条读不出来的依赖把整个清单锁死。
   *
   * 时间戳：pending → active 记 `startedAt`；已 active 再 start 保持原 `startedAt`（不重记）；
   * 从 done 回退则 `doneAt` 清空、`startedAt` 重记（那是**新的一次尝试**）。
   * 被降回 pending 的项**不动** `startedAt` —— 它的耗时不显示（展示口径按状态判），
   * 免得为了显示干净去抹掉一个真实发生过的事实。
   */
  start(index: number): StartOutcome {
    if (!this.valid(index)) return { kind: 'out-of-range', index, total: this.items.length };
    const target = this.items[index - 1];
    if (target.after !== null) {
      const pre = this.items[target.after - 1];
      if (pre && pre.status !== 'done') {
        return { kind: 'blocked', index, by: target.after, byText: pre.text };
      }
    }
    const restart = target.status !== 'active';
    this.items = this.items.map((it, i) =>
      i === index - 1
        ? { ...it, status: 'active', startedAt: restart ? this.now() : it.startedAt, doneAt: null }
        : it.status === 'active' ? { ...it, status: 'pending' } : it,
    );
    this.notify();
    return { kind: 'started', index };
  }

  /**
   * 把第 index（1 基）项标记为完成。越界返回 false。
   * `doneAt` **只在由非完成转成完成时**记（重复 done 不改写已完成时刻——那是历史）。
   * 依赖不满足也允许 done：完成是**事实陈述**，拦住它只会把模型卡死在一个登记错的依赖上。
   */
  done(index: number): boolean {
    if (!this.valid(index)) return false;
    const was = this.items[index - 1];
    this.items[index - 1] = was.status === 'done' ? was : { ...was, status: 'done', doneAt: this.now() };
    this.snapshotIfCompleted();   // 全完成的那一刻留下快照（供 /tasks 回看）
    this.notify();
    return true;
  }

  /**
   * 把一次提交的短 hash 挂到第 index 项上（ROADMAP 10.5.4 的"任务 ↔ 提交关联"）。
   *
   * 两条拒绝（都返回 false，**不改任何状态**）：序号越界、hash 是空串。
   * 越界这里挡的是**防御性**那一层 —— 真正的越界由调用方在提交**之前**就拒掉
   * （git 已经跑完再发现序号不存在，那时只能干瞪眼，见 commit-link.ts 的注释）；
   * store 是共享单例，两次调用之间清单可能被改，所以这一层不能省。
   *
   * **重复挂同一个 hash 视为成功但不通知**（幂等）：UI 不会为一个没变的状态重绘。
   *
   * 刻意**不顺手把这项标成完成**：提交 ≠ 那件活儿干完了（可能还要推、还要验证）。
   * 一件事只做一件 —— 要标完成请走 `done()`。
   */
  attachCommit(index: number, hash: string): boolean {
    const h = hash.trim();
    if (h === '') return false;
    if (!this.valid(index)) return false;
    const it = this.items[index - 1]!;
    if (it.commit === h) return true;
    this.items[index - 1] = { ...it, commit: h };
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
   * `reset()` 是"假装这个进程从没跑过"。
   * 两个用法：**测试隔离**（尤其 `/tasks` 命令测的是进程级单例，测完必须把它擦干净），
   * 以及**项目切换**（`/projects --switch`，ROADMAP 10.11.1）——上一个项目的快照
   * 在新项目里必须一起丢掉，否则 `/tasks` 会拿 A 的"最后完成项"当 B 的。
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
   * 渲染任意一份清单 —— **全项目唯一的"清单怎么排版"的实现**。
   * `render()` / `renderNumbered()` / 归档 / `/tasks` / 终端面板全部走这里，
   * 于是 glyph 只有 `GLYPH` 一处定义、缩进只有 `INDENT_UNIT` 一处定义，
   * 不可能出现"磁盘上是 `[x]`、终端上画成别的"。
   * （同一手法：Log/ 生成区的 `syncText` 一份模板同时给"写"和"查"用。）
   *
   * 行形状：`<缩进>- [<glyph>] <正文>[ ⤴<父项>][ ←<前置>][ #<提交短 hash>]`。
   * 最后那个提交号**只在 `numbered` 版出现**（10.5.4）—— 它不落盘，见 `TaskItem.commit`。
   * **父标记按需出现**：只有当"缩进 + 顺序"推不出真实父项时才补（见 `PARENT_RE` 的注释）——
   * 判据与 `parseLines` 的推导规则**逐字对应**（同一个 `lastAtDepth` 扫描），
   * 于是"渲染时不加、解析时推错"这种分家不可能发生。
   * `numbered` 只影响"给模型看的那两样"—— 每行前面的序号、以及行尾的提交号 ——
   * **都不影响可逆性**：`renderNumbered` 的产物从不被 parse（它只在工具回执里走一趟）。
   */
  static renderItems(items: ReadonlyArray<TaskItem>, numbered = false): string {
    const depths = depthsOf(items);
    /** 每层"最近一项"的序号（与 parseLines 同一张表、同一套维护方式） */
    const lastAtDepth: number[] = [];
    return items
      .map((it, i) => {
        const d = depths[i];
        let inferred = 0;   // 光看缩进 + 顺序，解析方会认成谁的子项
        for (let dd = Math.min(d, lastAtDepth.length) - 1; dd >= 0; dd--) {
          if (lastAtDepth[dd]) { inferred = lastAtDepth[dd]; break; }
        }
        const needParent = it.parent !== 0 && it.parent !== inferred;
        // 提交号**只在给模型看的那一版**出现（10.5.4）：它不落盘、不参与 parse，
        // 所以写在这里不会碰到 render/parse 互逆那条承重。
        // 用真值判断而不是 `!== null`：`scripts/` 下的套件不受 tsc 检查，手工构造的
        // TaskItem 字面量可能没带这个字段（那时 undefined 会印成字面量 "#undefined"）。
        const commitMark = numbered && it.commit ? ` #${it.commit}` : '';
        const markers = `${needParent ? ` ⤴${it.parent}` : ''}${it.after !== null ? ` ←${it.after}` : ''}${commitMark}`;
        const body = encodeText(it.text);
        lastAtDepth.length = d + 1;
        lastAtDepth[d] = i + 1;
        return numbered
          ? `${' '.repeat(INDENT_UNIT * d)}${i + 1}. [${GLYPH[it.status]}] ${body}${markers}`
          : `${' '.repeat(INDENT_UNIT * d)}- [${GLYPH[it.status]}] ${body}${markers}`;
      })
      .join('\n');
  }

  render(): string {
    return TaskStore.renderItems(this.items);
  }

  /**
   * 渲染成**给模型看的**带序号清单（工具返回值）。
   * 序号即后续 `start` / `done` / `parent` / `after` 要传的 index —— 模型据此指认目标，不必靠猜。
   */
  renderNumbered(): string {
    return TaskStore.renderItems(this.items, true);
  }

  /**
   * 把若干行解析成清单项 —— **fromMarkdown 与历史归档共用**的一段（两边都靠它，
   * 于是"层级怎么从缩进算出来"只有一份实现）。
   *
   * 四条口径：
   *   - 行尾的 ` ⤴N`（父项）优先：有它就按它，没有才用**缩进 + 顺序**推 ——
   *     推法 = "取最近的更浅一项"，与 `renderItems` 决定"要不要补父标记"用的是同一张表、
   *     同一个扫描（两边分家就会出现"渲染时不加、解析时推错"）。
   *   - 行首空格数 → 缩进层级（`INDENT_UNIT` 个空格一层，向下取整）；缩进跳级
   *     （如 0 空格后写成 4 空格）时挂到最近祖先 —— 手写文件的怪缩进被**归一化**，
   *     于是 `parse(render(x))` 稳定（互逆的必需条件）。
   *   - 两个标记的序号都必须是**合法且更早**的，否则整段留在正文里（宁可不认，不乱摘）。
   *   - 时间戳一律 null：文件里没有"几点开始的"这个事实，`createdAt`/`startedAt`/`doneAt`
   *     都空着，由后续的 start / done 现填。
   */
  private static parseLines(lines: ReadonlyArray<string>): TaskItem[] {
    const items: TaskItem[] = [];
    /** 每层"最近一项"的 1 基序号（按**规范深度**记；更浅的项出现后，其更深的记录全部作废） */
    const lastAtDepth: number[] = [];
    /** 已解析各项的规范深度（与 items 同步增长）——算下一项的深度用，不必回头重扫 */
    const depths: number[] = [];
    for (const line of lines) {
      const m = ITEM_RE.exec(line);
      if (!m) continue;
      const textDepth = Math.floor((LEADING_RE.exec(line)?.[0].length ?? 0) / INDENT_UNIT);
      let raw = sanitize(m[2]);
      if (!raw) continue;
      const idx = items.length + 1;
      // ① 摘行尾标记（先摘靠后的，两个标记的顺序由 renderItems 固定：先 ⤴ 后 ←）
      let after: number | null = null;
      let parentMark: number | null = null;
      for (;;) {
        const am = AFTER_RE.exec(raw);
        if (am && after === null) {
          const n = Number(am[1]);
          if (n >= 1 && n < idx) { after = n; raw = raw.slice(0, am.index).trim(); continue; }
        }
        const pm = PARENT_RE.exec(raw);
        if (pm && parentMark === null) {
          const n = Number(pm[1]);
          if (n >= 1 && n < idx) { parentMark = n; raw = raw.slice(0, pm.index).trim(); continue; }
        }
        break;
      }
      const text = decodeText(raw);
      if (!text) continue;          // 只有标记、没有正文的行丢弃
      // ② 定父项：显式标记优先，否则按缩进推（最近的更浅一项）
      let parent = 0;
      if (parentMark !== null) {
        parent = parentMark;
      } else {
        for (let d = Math.min(textDepth, lastAtDepth.length) - 1; d >= 0; d--) {
          if (lastAtDepth[d]) { parent = lastAtDepth[d]; break; }
        }
      }
      const glyph = m[1].toLowerCase();
      let status: TaskStatus = glyph === 'x' ? 'done' : glyph === '>' ? 'active' : 'pending';
      // commit 一律 null：文件里没有"它对应哪次提交"这个事实（该字段刻意不落盘，见接口注释）
      items.push({ text, status, parent, after, createdAt: null, startedAt: null, doneAt: null, commit: null });
      // ③ 记表：按**规范深度**（= 父项深度 + 1）而不是行首缩进 —— 显式父标记可能把一项
      //    挂得比它的缩进更深/更浅，若按缩进记，后面的兄弟项会认错爹
      const canonical = parent === 0 ? 0 : depths[parent - 1] + 1;
      depths.push(canonical);
      lastAtDepth.length = canonical + 1;
      lastAtDepth[canonical] = idx;
    }
    // 多 [>] 归一：只保留第一处为 active，其余降为 pending（维持全局唯一不变量）
    let activeTaken = false;
    for (const it of items) {
      if (it.status !== 'active') continue;
      if (activeTaken) it.status = 'pending';
      else activeTaken = true;
    }
    return items;
  }

  /**
   * 从 Markdown 解析出清单（**启动种子**方向）。
   * 只认清单行；标题、散文、空行一律跳过（旧 TASK.md 的 `## 目标` 等 prose 因此被丢弃——
   * 本机制只负责**步骤**，这是刻意的简化，见 DECISION_LOG）。
   */
  static fromMarkdown(md: string): TaskStore {
    const store = new TaskStore();
    store.items = TaskStore.parseLines(md.split('\n'));
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
