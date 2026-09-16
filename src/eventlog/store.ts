/**
 * EventStore —— 历史事件库（**追加型**：只增不改，一条 = 一个有名字的经验/决策/行为）。
 * 调用方：tools/builtin.ts（record_event 写 / search_events 读）、
 *         harness/main.ts（启动种子 + tool_call span 自动捕获）、commands/builtin/events.ts
 * 服务于：与"必然注入的记忆"相对的**按需检索**档案 —— 平时只躺在磁盘上，
 *         search_events 命中时才作为 tool 结果进入当轮上下文（拉通道，不是推通道）。
 *
 * ── 三层账本里它站在哪 ──
 *   trace.jsonl（机器流水，人复盘用）→ events.jsonl（叙事精选，按需拉）→ memory.md（索引结论，每次推）
 * 打卡机（span/collector）记的是"每次调用都有的过程"，本库存的是"值得留的结论与来龙去脉"。
 * 两者用 turnId 关联：tool_call 条目带当时那轮的 turnId，要复盘完整过程回 trace.jsonl 翻。
 *
 * ── 两份文件（2026-09-13 拆分）──
 *   events.jsonl      只存**叙事 + system 关键节点**——人看、检索、分享的都是它。
 *                     条目不嵌路径（自包含），文件本身可移植：发给别人 = 拷文件。
 *   tool-calls.jsonl  tool_call 机器流水单独落这里（append-only 同纪律），
 *                     防流水把叙事淹没（实测 27 秒的任务就产生 24 条流水）。
 *   启动载入按 kind 路由：旧 events.jsonl 里已存在的 tool_call 行进流水索引，
 *   不回写、不搬家（append-only 不因重构破例）。
 *
 * ── 数据形状 ──
 *   每条事件一行 JSON（与 sessions/*.jsonl、trace.jsonl 同一范式），字段：
 *     kind     decision / experience / incident（叙事，record_event 写）
 *              | tool_call（机器流水，span 自动捕获写，落 tool-calls.jsonl）
 *              | system（机器里程碑，确定性钩子自动写：任务归档 / 压缩发生）
 *     title    一句话书签；context/decision/reason/outcome 叙事四段（可选，空则缺省不写键）
 *     tags     检索标签；turnId 关联当时的执行轮次
 *   修正 = 追加新条目，绝不改写旧行（与 Log/ 追加日志同一纪律：历史条目冻死）。
 *
 * ── 一致性口径（与 TaskStore 相同的选择）──
 *   运行期以**内存索引**为准（启动时 loadFromFile 一次），不回读文件；
 *   外部手工改文件要到下次启动才可见 —— 档案的正确入口是工具与 /events 命令，不是手改。
 *   写盘失败不抛：追加一条失败不该炸掉正在执行的工具；错误信息返回给调用方决定怎么提示。
 *
 * 零运行时依赖：只用 node:fs（内置）+ 纯数据结构。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CollectedSpan } from '../core/events.js';

/** 事件库文件落点 —— 与 memory.md 同住 cwd/.flint/（隐藏目录，ls/grep 工具天然跳过）。 */
export const EVENTS_FILE = '.flint/events.jsonl';

/** tool_call 机器流水的独立落点（2026-09-13 与叙事拆分——叙事库不被流水淹没）。 */
export const CALLS_FILE = '.flint/tool-calls.jsonl';

/** 叙事事件的三种人类可记类型；tool_call / system 是机器自动产生的（record_event 不接受）。 */
export const NARRATIVE_KINDS = ['decision', 'experience', 'incident'] as const;
export type EventKind = (typeof NARRATIVE_KINDS)[number] | 'tool_call' | 'system';

export interface EventEntry {
  id: string;
  /** ISO 时间（落盘即定，展示原样输出） */
  time: string;
  kind: EventKind;
  title: string;
  /** 叙事四段：当时的情境 / 做了什么决定 / 为什么 / 结果如何。空段缺省不写键（行更紧凑） */
  context?: string;
  decision?: string;
  reason?: string;
  outcome?: string;
  tags: string[];
  /** 关联的执行轮次（tool_call 条目由 span 带入；复盘完整过程时回 trace.jsonl 按它翻） */
  turnId?: string;
}

/** 叙事条目的输入（id/time 由 store 生成，调用方不碰） */
export interface NarrativeInput {
  kind: EventKind;
  title: string;
  context?: string;
  decision?: string;
  reason?: string;
  outcome?: string;
  tags?: string[];
}

let entryCounter = 0;
function nextEntryId(): string {
  entryCounter++;
  return `ev_${Date.now()}_${entryCounter}`;
}

/** 单行裁剪（写盘前把长文本压到限额内：事件库是书签不是全文备份） */
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 把一段可选文本规整成"有内容才写键"的形状 */
function opt(value: string | undefined, n: number): string | undefined {
  const t = (value ?? '').replace(/\s+/g, ' ').trim();
  return t ? clip(t, n) : undefined;
}

export class EventStore {
  /** 叙事 + system 索引（events.jsonl 的内存像；all/count/search 的缺省口径） */
  private entries: EventEntry[] = [];
  /** tool_call 流水索引（tool-calls.jsonl 的内存像；旧 events.jsonl 里的 tool_call 行也路由到这里） */
  private calls: EventEntry[] = [];

  /** 只读快照（防御性拷贝；存进顺序 = 时间正序，最新的在末尾）。**只含叙事 + system**。 */
  all(): EventEntry[] {
    return this.entries.map((e) => ({ ...e, tags: [...e.tags] }));
  }

  /** 流水快照（防御性拷贝；只含 tool_call，检索 kind=tool_call 时用）。 */
  allCalls(): EventEntry[] {
    return this.calls.map((e) => ({ ...e, tags: [...e.tags] }));
  }

  count(): number {
    return this.entries.length;
  }

  countCalls(): number {
    return this.calls.length;
  }

  /**
   * 清空两个索引（叙事 + 流水），**不动磁盘上的任何文件**。
   *
   * 两个合法用法，都不是"随手清一下"：
   *   ① **测试隔离** —— 与 taskStore/memoryStore 的 reset() 同一条理由（进程级单例，
   *      测完必须擦干净，否则后一套测到的条目属于前一套造的）。
   *   ② **项目切换**（`/projects --switch`，ROADMAP 10.11.1）—— 事件库的档案住在
   *      `.flint/events.jsonl`，那是**项目资产**。换了项目却留着上一个项目的事件索引，
   *      模型检索时就会把别的项目的来龙去脉当成这个项目的（比"查不到"坏得多）。
   *      切换时的顺序固定为 reset() → loadFromFile() → loadCallsFile()：
   *      **先清后栽**，因为 loadFromFile 在文件不存在时是"保持现状"而不是"清空"。
   */
  reset(): void {
    this.entries = [];
    this.calls = [];
  }

  /**
   * 追加一条叙事事件（record_event 的落点）：生成 id/time → 内存入列 → 追加落盘。
   * 落盘失败不抛，返回错误信息（内存索引仍然有效，只是这份没进档案）。
   */
  addNarrative(input: NarrativeInput, file: string): { entry: EventEntry; warn?: string } {
    const context = opt(input.context, 400);
    const decision = opt(input.decision, 400);
    const reason = opt(input.reason, 400);
    const outcome = opt(input.outcome, 400);
    const entry: EventEntry = {
      id: nextEntryId(),
      time: new Date().toISOString(),
      kind: input.kind,
      title: clip(input.title.replace(/\s+/g, ' ').trim(), 120),
      ...(context ? { context } : {}),
      ...(decision ? { decision } : {}),
      ...(reason ? { reason } : {}),
      ...(outcome ? { outcome } : {}),
      tags: input.tags ?? [],
    };
    this.entries.push(entry);
    const warn = this.appendLine(entry, file);
    return warn === undefined ? { entry } : { entry, warn };
  }

  /**
   * 打卡自动捕获：把一段**已收束的 tool_call span** 转成事件条目。
   * 复用的是 span-collector 的配对产物（CollectedSpan：进门/出门已合成一段、字段齐全），
   * 与 trace-log watcher 同一用法（capacity 0、只吃 feed 返回值）——配对逻辑零重复。
   * 调用方：main.ts 订阅总线，name === 'tool_call' 的才送进来（落点 = CALLS_FILE 流水档案）。
   * 落盘失败静默（自动捕获是旁路观测，不能反噬主流程——与 trace-log 同一原则）。
   */
  recordToolCall(span: CollectedSpan, file: string): void {
    const toolName = typeof span.input.name === 'string' ? span.input.name : 'unknown';
    const argsDigest = clip(JSON.stringify(span.input.args ?? {}), 200);
    const resultLen = typeof span.output.resultLength === 'number' ? span.output.resultLength : undefined;
    const entry: EventEntry = {
      id: nextEntryId(),
      time: new Date(span.startedAt).toISOString(),
      kind: 'tool_call',
      title: `工具 ${toolName} 调用`,
      ...(argsDigest !== '{}' ? { context: `参数: ${argsDigest}` } : {}),
      ...(resultLen !== undefined ? { outcome: `status=${span.status}, ${span.durationMs}ms, 结果 ${resultLen} 字符` }
        : { outcome: `status=${span.status}, ${span.durationMs}ms` }),
      tags: ['tool', toolName],
      turnId: span.turnId,
    };
    this.calls.push(entry);
    this.appendLine(entry, file);
  }

  /**
   * 确定性钩子 ①：任务清单"全完成归档"那一刻自动补记（不经模型——用户不必记得说，
   * 程序上能确定判定的时刻由代码保证）。接线：todo 工具在 archiveToFile 真正消费掉
   * 快照的那次调用后触发（写失败不记——快照保留会重试，避免双记）。
   * 与 recordToolCall 同一原则：旁路观测，落盘失败静默，绝不反噬主流程。
   */
  recordTaskArchive(items: ReadonlyArray<{ text: string }>, file: string): void {
    const digest = items.map((i) => i.text).join('、');
    const outcome = opt(`完成清单：${digest}`, 400);
    const entry: EventEntry = {
      id: nextEntryId(),
      time: new Date().toISOString(),
      kind: 'system',
      title: clip(`任务清单全完成（${items.length} 项）：${digest}`, 120),
      ...(outcome ? { outcome } : {}),
      tags: ['task', 'archive'],
    };
    this.entries.push(entry);
    this.appendLine(entry, file);
  }

  /**
   * 确定性钩子 ②：压缩发生时自动补记——旧上下文被摘要替代的那一刻给事件库留书签
   * （被压掉的细节从此只活在摘要里，"什么时候压过一次"本身值得记）。
   * 接线：runtime 在 maybeCompact 返回 summary 时触发。落盘失败静默（同上）。
   */
  recordCompaction(summary: string, file: string): void {
    const digest = opt(summary, 400);
    const entry: EventEntry = {
      id: nextEntryId(),
      time: new Date().toISOString(),
      kind: 'system',
      title: '对话历史已压缩（旧上下文被摘要替代）',
      ...(digest ? { context: `摘要快照: ${digest}` } : {}),
      tags: ['compaction'],
    };
    this.entries.push(entry);
    this.appendLine(entry, file);
  }

  /** 追加一行进档案（自动建目录）。返回出错信息（成功 null）。 */
  private appendLine(entry: EventEntry, file: string): string | undefined {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8');
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * 检索：按 类型 / 标签（精确匹配一个）/ 关键词（标题+四段子串、不分大小写）过滤，
   * **最新的在前**，limit 截断（缺省 10，防一次检索灌爆上下文——拉通道的节制）。
   * 口径（2026-09-13 拆分后）：**缺省只查叙事库**（entries：叙事 + system）——流水是
   * 噪音默认不进结果；kind=tool_call 时改查流水索引（calls）。
   */
  search(opts: { kind?: string; tag?: string; keyword?: string; limit?: number }): EventEntry[] {
    const kw = (opts.keyword ?? '').toLowerCase();
    const tag = (opts.tag ?? '').trim();
    const kind = (opts.kind ?? '').trim();
    const limit = opts.limit ?? 10;
    const source = kind === 'tool_call' ? this.calls : this.entries;
    const hits = [...source].reverse().filter((e) => {
      if (kind && e.kind !== kind) return false;
      if (tag && !e.tags.includes(tag)) return false;
      if (kw) {
        const hay = [e.title, e.context, e.decision, e.reason, e.outcome, e.tags.join(',')]
          .filter(Boolean).join('\n').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    return hits.slice(0, limit).map((e) => ({ ...e, tags: [...e.tags] }));
  }

  /**
   * 启动种子：把 events.jsonl 全量读进内存索引（**只此一次**，运行期不回读）。
   * 坏行（手改坏的 / 写了一半的）跳过不抛——档案允许个别行损坏，索引照常工作。
   * 拆分兼容：行内 kind=tool_call（旧文件残留）路由进流水索引，不回写不搬家。
   */
  loadFromFile(path: string): void {
    try {
      if (!existsSync(path)) return;
      const items: EventEntry[] = [];
      const legacyCalls: EventEntry[] = [];
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as EventEntry;
          if (typeof raw?.title === 'string' && typeof raw?.kind === 'string') {
            const fixed = { ...raw, tags: Array.isArray(raw.tags) ? raw.tags : [] };
            (fixed.kind === 'tool_call' ? legacyCalls : items).push(fixed);
          }
        } catch { /* 坏行跳过 */ }
      }
      this.entries = items;
      this.calls = [...legacyCalls, ...this.calls];
    } catch {
      /* 读取失败 → 空索引，保持现状 */
    }
  }

  /**
   * 流水档案种子（tool-calls.jsonl）：同 loadFromFile 的口径，行进流水索引。
   * 与叙事种子分开两个方法——两份文件、两种性质，调用方各自显式喂。
   */
  loadCallsFile(path: string): void {
    try {
      if (!existsSync(path)) return;
      const items: EventEntry[] = [];
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as EventEntry;
          if (raw?.kind === 'tool_call' && typeof raw?.title === 'string') {
            items.push({ ...raw, tags: Array.isArray(raw.tags) ? raw.tags : [] });
          }
        } catch { /* 坏行跳过 */ }
      }
      this.calls = [...this.calls, ...items];
    } catch {
      /* 读取失败 → 保持现状 */
    }
  }
}

/**
 * 单条事件的**唯一**排版实现 —— search_events（模型读）与 /events（终端打印）共用，
 * 记号不分家（与 TaskStore.renderItems 同一手法：一份模板同时喂两个消费者）。
 * @param e 事件条目
 * @param n 可选序号（检索结果带序号，方便模型引用"第 2 条"）
 */
export function formatEvent(e: EventEntry, n?: number): string {
  const head = `${n !== undefined ? `[${n}] ` : ''}${e.time.slice(0, 16).replace('T', ' ')} [${e.kind}] ${e.title}`;
  const fields: Array<[string, string | undefined]> = [
    ['背景', e.context], ['决策', e.decision], ['理由', e.reason], ['结果', e.outcome],
  ];
  const lines = [head, ...fields.filter(([, v]) => v).map(([k, v]) => `    ${k}: ${v}`)];
  if (e.tags.length > 0) lines.push(`    标签: ${e.tags.join(', ')}`);
  if (e.turnId) lines.push(`    轮次: ${e.turnId}`);
  return lines.join('\n');
}

/**
 * 进程级默认实例 —— 与 taskStore / memoryStore 同一手法。
 * 测试要隔离时自己 `new EventStore()`，互不干扰。
 */
export const eventStore = new EventStore();
