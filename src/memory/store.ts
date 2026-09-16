/**
 * MemoryStore —— 项目级长期记忆的**唯一真相源**（内存里的结构化状态）。
 * 调用方：tools/builtin.ts（memory 工具做增删）、runtime/runtime.ts（注入 system 的 memory 层）、
 *         harness/main.ts（启动时把 .flint/memory.md 作为**种子**吸收一次）、commands/builtin/memory.ts
 * 服务于：把"项目约定 / 架构决策 / 踩过的坑 / 经验"沉淀成跨会话可用的记忆 ——
 *         每次请求注入 system 的 memory 层（推通道），与对话历史、压缩摘要都无关。
 *
 * ── 与 TaskStore 的关系：同一套 C 方案，第二次落地 ──
 *   - **真相源 = 这份内存状态**（本类）。运行期只让它说了算，不回读文件。
 *   - **.flint/memory.md = 投影 + 存档**。每次变更后写盘（`projectToFile`）；进程重启后
 *     内存没了，文件是唯一还活着的东西，启动时反方向读它当种子（`loadFromFile`）。
 *   - `render` 与 `fromMarkdown` **严格互逆**：`fromMarkdown(render())` 还原出逐字相同的
 *     条目（verify-memory 的属性测试钉死）。与 TASK.md 不同的是**没有状态**（没有复选框、
 *     没有"全勾选即删"）——记忆只有"存在/不存在"，删除是显式的 remove。
 *
 * ── 与 todo 的一个刻意差别：没有 onChange 观察者 ──
 * 任务清单有常驻 UI 面板，改了内存屏幕不动就是静默错位，所以必须补通知线。
 * 记忆没有 UI 展示面：模型可见的反馈由工具返回值承担（返回整份清单），
 * 用户回看走 /memory 命令按需读内存真相源。没有"需要被通知的订阅方"，就不建通知线
 * ——不为对称而对称，多一根没人听的线就是多一处要维护的协议。
 *
 * ── 注入上限 ──
 * store 的 render() 永远输出**全部**条目（投影必须完整）；截断是**注入侧**（runtime）的事，
 * 与 TASK.md 的 2000 字符截断同一分工：投影可逆、注入可截。
 *
 * 零运行时依赖：只用 node:fs（内置）+ 纯数据结构。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 记忆文件落点 —— cwd 下的项目级目录（隐藏目录，ls/grep 工具天然跳过不打扰项目列表）。 */
export const MEMORY_FILE = '.flint/memory.md';

/**
 * 把任意文本规整成单行（换行压成空格、两端 trim）——保证 render/parse 互逆的前提。
 * 与 TaskStore.sanitize 同一语义：一条记忆 = 一行。
 */
function sanitize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 匹配一行记忆条目（`- 内容`，兼容 `* 内容` 变体）。 */
const ITEM_RE = /^\s*[-*]\s+(.+)$/;

export class MemoryStore {
  private items: string[] = [];

  /** 只读快照（防御性拷贝）。 */
  list(): string[] {
    return [...this.items];
  }

  count(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * 追加一条记忆，返回它的 **1 基序号**。
   * 空白文本 → -1（无意义状态）；与已有条目逐字相同 → -2（重复记录只会稀释注意力，
   * 模型常犯"换个措辞再存一遍"的毛病，在 store 层挡住它）。
   * 两种拒绝都不改状态。
   */
  add(text: string): number {
    const t = sanitize(text);
    if (!t) return -1;
    if (this.items.includes(t)) return -2;
    this.items.push(t);
    return this.items.length;
  }

  /** 删除第 index（1 基）条。越界返回 false。 */
  remove(index: number): boolean {
    if (!this.valid(index)) return false;
    this.items.splice(index - 1, 1);
    return true;
  }

  /** 清空全部记忆。 */
  clear(): void {
    this.items = [];
  }

  /**
   * 彻底复位（清空内存）。与 clear() 目前等价，留名字是为测试隔离语义与 TaskStore 对齐：
   * 日常用 clear()；reset() 服务两个"假装这个进程从没跑过"的场景——**测试隔离**，
   * 以及**项目切换**（`/projects --switch`，ROADMAP 10.11.1：记忆住在 `.flint/memory.md`，
   * 换了项目就必须先清后栽，否则 A 的约定会被当成 B 的）。
   */
  reset(): void {
    this.items = [];
  }

  private valid(index: number): boolean {
    return Number.isInteger(index) && index >= 1 && index <= this.items.length;
  }

  /**
   * 渲染成 Markdown 清单 —— 写进 memory.md 的**投影**，也是注入 system 的文本来源。
   * 与 `fromMarkdown` 严格互逆：`fromMarkdown(render())` 的 items 逐字相同。
   */
  static renderItems(items: string[], numbered = false): string {
    return items
      .map((it, i) => (numbered ? `${i + 1}. ${it}` : `- ${it}`))
      .join('\n');
  }

  render(): string {
    return MemoryStore.renderItems(this.items);
  }

  /** 给模型看的带序号清单（工具返回值），序号即 remove 的 index。 */
  renderNumbered(): string {
    return MemoryStore.renderItems(this.items, true);
  }

  /**
   * 从 Markdown 解析（**启动种子**方向）。只认 `- `/`* ` 条目行；
   * 标题、散文、空行一律跳过（memory.md 的 `# 项目记忆` 头因此被丢弃——
   * 本机制只负责**条目**，与 TaskStore.fromMarkdown 只认清单行同一纪律）。
   */
  static fromMarkdown(md: string): MemoryStore {
    const store = new MemoryStore();
    for (const line of md.split('\n')) {
      const m = ITEM_RE.exec(line);
      if (!m) continue;
      const text = sanitize(m[1]);
      if (!text) continue;
      store.items.push(text);
    }
    return store;
  }

  /**
   * 启动种子：把 memory.md 读进来当初始清单（**只此一次**，运行期不回读）。
   * 与 TASK.md 不同，**没有清理语义**——记忆不会"过期作废"，文件留下，内存照单全收。
   * 读不到 / 读失败一律当空清单，不阻塞启动。
   */
  loadFromFile(path: string): void {
    try {
      if (!existsSync(path)) return;
      this.items = MemoryStore.fromMarkdown(readFileSync(path, 'utf-8')).items;
    } catch {
      /* 读取失败 → 无项目记忆，保持现状 */
    }
  }

  /**
   * 投影：把当前状态写进 memory.md（每次变更后由 memory 工具调用）。
   * 空清单**删除文件**（不留空壳）；首次写入自动创建 .flint/ 目录。
   * 系统行为，不走权限弹窗；失败不抛——内存仍是真相源，写盘失败最多丢"跨重启存档"。
   * @returns 出错信息（成功为 null），供工具附在返回值里提醒模型
   */
  projectToFile(path: string): string | null {
    try {
      if (this.items.length === 0) {
        // 空清单只删文件，不删 .flint/ 目录（events.jsonl 可能还住在里面）
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch { /* 删除失败不致命 */ }
        return null;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `# 项目记忆\n\n${this.render()}\n`, 'utf-8');
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
}

/**
 * 进程级默认实例 —— 与 taskStore 同一手法：tool 与 runtime 自动共享同一份状态，不必层层透传。
 * 测试要隔离时自己 `new MemoryStore()`（或调 `reset()`），互不干扰。
 */
export const memoryStore = new MemoryStore();
