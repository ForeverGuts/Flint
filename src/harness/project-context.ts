/**
 * 项目上下文播种 —— 「把一个项目装进内存」的**唯一实现**。
 *
 * 调用方：harness/main.ts（启动时一次）、commands/builtin/projects.ts（`/projects --switch` 时一次）
 * 服务于：ROADMAP 10.11.1（`/projects` 列表与切换）——切换项目的实质是"换一个目录，再把
 *         这个项目的上下文装进内存"。既然启动与切换做的是同一件事，就必须只有一份实现：
 *         两份实现不会同时错，只会**各错一半**（启动装了四样、切换忘了第三样），
 *         而"少装一样"的症状是**看着一切正常**——用的是上一个项目的数据。
 *
 * 装进来的是四样（都是**进程级单例**，所以只能由一处统一负责）：
 *   taskStore    ← TASK.md（清单的投影 + 跨重启种子）
 *   memoryStore  ← .flint/memory.md（跨会话结论）
 *   eventStore   ← .flint/events.jsonl + .flint/tool-calls.jsonl（来龙去脉 + 流水索引）
 *   charterLock  ← 复位成**已锁**
 * 外加 projectRegistry.ensure()：用过 flint 的项目进 ~/.flint/projects.jsonl 电话簿。
 *
 * ── 为什么这里的每个 store 都"先 reset 再 load" ──
 * 三个 store 的 `loadFromFile` 在**文件不存在**时的语义是"保持现状"，不是"清空"——
 * 启动时这个语义是对的（读不到就当没有，别把已有的擦了）。但**切换项目时"现状"是上一个
 * 项目的状态**：直接 load 会把 A 的清单、A 的记忆、A 的事件留在 B 里，而且一路无提示。
 * 故切换方必须显式 reset()；本函数把「reset + load」配成一对，调用方不必记住这条。
 *
 * ── 契约锁为什么要复位（而不是继承）──
 * `charterLock` 是**会话级**开关，挡的是"改当前项目的 .flint/CHARTER.md"。切换后
 * `guardContractWrite` 会把目标路径按**新 cwd** 解析，于是 A 的解锁状态会直接变成
 * "有权限改 B 的目标文档"——一次解锁被搬到另一个项目上，正是契约锁最不该有的行为。
 *
 * ── 刻意不做的两件（边界，不装糊涂）──
 *   ① **不读** package.json / .flint/postcheck.json。它们是**授权类配置**（"声明即授权"
 *      的登记表，以及它引用的命令表），"运行期不回读"本身就是那条防线的组成部分
 *      （理由见 ROADMAP 10.6.1 / 10.6.2 与 DECISION_LOG 的对应锚点）。项目切换确实由
 *      用户显式发起，但它发生在**运行期**；一旦多出第二个读取点，判据就从"不许回读"
 *      退化成"看是谁触发的能不能回读"——那是**策略**，不是正确性。故切换方**清空**
 *      commandRegistry / postcheckRegistry / postcheckBaseline，并在回执里明说
 *      "新项目的项目命令与改完自检要重启 flint 才生效"：用**看得见的缺失**，
 *      换掉**看不见的通路**。
 *   ② **不碰**配置（`~/.flint/config.json` 与项目的 `config/provider-keys.json`）：
 *      ConfigManager 是启动时构造的进程级单例。切过来的项目若在 provider-keys.json 里
 *      另配了密钥，本会话读不到——同样在回执里点明。
 *
 * 零运行时依赖：只用 node 内置 + 本项目其它模块。
 */
import { taskStore } from '../todo/store.js';
import { MEMORY_FILE, memoryStore } from '../memory/store.js';
import { CALLS_FILE, EVENTS_FILE, eventStore } from '../eventlog/store.js';
import { projectRegistry } from '../eventlog/registry.js';
import { charterLock } from '../project/charter.js';

/** 清单落点（cwd 根，不是 .flint/ 下——历史原因，见 todo/store.ts） */
const TASK_FILE = 'TASK.md';

/** 播种结果 —— 只用于回执展示（调用方不该拿它做判定） */
export interface ProjectContextReport {
  /** 归一化之前的原始 cwd（人读） */
  cwd: string;
  /** 载入的未完成任务数 */
  task: number;
  memory: number;
  /** 叙事 + system 事件数 */
  events: number;
  /** 工具调用流水条数 */
  calls: number;
}

/**
 * 把一个项目的上下文装进内存。**不抛异常**（每个 store 自己吞掉读写失败，
 * 契约锁与登记都是无失败的字段操作）——它是切换流程里"剩下那几步"，
 * 失败也不该让调用方回滚到一半。
 *
 * 注意顺序：先 reset 再 load（理由见文件头）。文件不存在 → 装载后是**空**，不是旧值。
 */
export function seedProjectContext(): ProjectContextReport {
  taskStore.reset();
  taskStore.loadFromFile(TASK_FILE);

  memoryStore.reset();
  memoryStore.loadFromFile(MEMORY_FILE);

  eventStore.reset();
  eventStore.loadFromFile(EVENTS_FILE);
  eventStore.loadCallsFile(CALLS_FILE);

  // 目标文档的锁**不跨项目继承**：新项目一律从"已锁"开始（要改就再 /charter unlock）。
  charterLock.lock();

  // 电话簿登记（幂等）：切换到的项目也进 ~/.flint/projects.jsonl。
  projectRegistry.ensure(process.cwd());

  const tasks = taskStore.counts();
  return {
    cwd: process.cwd(),
    task: tasks.pending + tasks.active,
    memory: memoryStore.count(),
    events: eventStore.count(),
    calls: eventStore.countCalls(),
  };
}
