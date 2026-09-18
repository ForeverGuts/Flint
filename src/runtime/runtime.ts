/**
 * Runtime 运行时 —— Agent 运行时的上下文与全局状态管理。
 * 调用方：main.ts（初始化并启动）
 * 服务于：串联 LLM 调用、session 对话、命令注册、input 事件、skill 展开
 */
import type { LLMMessage, LLMProvider, LLMUsage } from '../llm/types.js';
import type { Diagnostic, RuntimeOptions } from '../types.js';
import { SkillLoader } from './skill.js';
import { PromptEventEmitter } from './events.js';
import { JsonlSessionStorage } from '../session/jsonl-storage.js';
import type { SessionStorage } from '../core/storage.js';
import { JsonlSessionRepo } from '../session/jsonl-repo.js';
import type { SessionRepo } from '../core/session-repo.js';
import * as path from 'node:path';
import type { EventHandler, HookHandler, SpanAttrs, SpanResult } from './events.js';
import type { CollectedSpan, SpanCollector } from '../core/events.js';
import { AgentLoopServiceImpl, DEFAULT_MAX_TURNS, WITH_PLAN_MAX_TURNS } from '../loop/agent-loop.js';
import { estimateTokenUsage } from './utils.js';
import { PERMISSION_OPTIONS, permissionTitle } from '../io/ui/permission-prompt.js';
import { selectFromList } from '../io/ui/selector.js';
import { readLine } from '../io/terminal.js';
import { taskStore } from '../todo/store.js';
import { memoryStore } from '../memory/store.js';
import { readProjectSnapshot } from '../project/snapshot.js';
import { commandRegistry, renderCommandsSection } from '../project/commands.js';
import { renderStackSection, stackRegistry } from '../project/stack.js';
import { EVENTS_FILE, eventStore } from '../eventlog/store.js';

/* ── 工作记忆：真相源是 `taskStore`（src/todo/store.ts） ──
   改造前这里有个模块级函数：每次请求读 TASK.md、数复选框、全勾选即删。那套是"文件即状态"。
   C 方案落地后，**运行期只认内存里的 TaskStore**：
     · 注入 system 的 task 层 → 读 `taskStore.render()`（不再是文件）
     · 轮数预算 / thinking auto → 读 `taskStore.hasUnchecked()`
   TASK.md 降级为**投影 + 启动种子**：写盘由 `todo` 工具在每次变更后做（store.projectToFile），
   读盘只在进程启动时做一次（main.ts 的 `taskStore.loadFromFile('TASK.md')`）。
   为什么删除而不是保留双读：两处判定（store 与文件）迟早漂移，正是本文件旧注释担心的
   "避免两处正则漂移"的同构病——单一真相源才治得掉。 */

/* ── 类型定义 ── */

/**
 * 落盘后的内层引导（steering）条目前缀 —— 内容即唯一真相源。
 *
 * 为什么用内容前缀而不是给 MessageEntry 加一个结构化字段：`session/in-memory.ts` 与
 * `session/mock.ts` 的 `appendMessage(role, content)` **根本不接第三个参数**，extra 会被
 * 静默丢弃 → 同一条引导会「JSONL 里存得下、内存/Mock 里凭空消失」，重演架构债第 9 条
 * 「格式支持、入口未接线」的病。走 role + content 则三个后端天然一致。
 *
 * 措辞与 agent-loop 内层注入用的 `[用户引导]` 同一套词表（那里是长句式，这里是紧凑前缀）。
 * 双消费方：模型（后续轮次能看出这是中途插入的指示）+ `/history`（据此单独标记）。
 */
export const STEER_PREFIX = '[用户引导] ';

/** 命令处理函数签名（re-export 自 core，保持兼容） */
export type CommandHandler = import('../core/commands.js').CommandHandler;

/** 选择器条目（命令系统调 runtime.select 用） */
export type SelectItem = { value: string; label: string; description?: string; disabled?: boolean };

/** Input 事件处理器返回结果 */
export type InputEventResult =
  | { action: 'continue' }
  | { action: 'transform'; text: string }
  | { action: 'handled' };

/** Input 事件处理器签名 */
export type InputHandler = (text: string) => InputEventResult | Promise<InputEventResult>;

/* ── Runtime 类 ── */

export class Runtime {
  private llm: LLMProvider;
  private session;
  /** 会话仓库层（可选注入）——目录级管理；缺省时回退 JsonlSessionStorage 静态路径 */
  private sessionRepo: SessionRepo | undefined;
  /** 命令子系统（接口注入，存储/注册/分发） */
  private commandSystem: import('../core/commands.js').CommandService;
  /** 诊断子系统（接口注入，收集/查询/落盘） */
  private diagnosticsService: import('../core/diagnostics.js').DiagnosticsService;
  private inputHandlers: InputHandler[] = [];
  private skills: SkillLoader;
  /** 上下文管理子系统（接口注入，压缩） */
  private compaction: import('../core/compaction.js').CompactionService;
  /** 系统提示词子系统（接口注入，动态构建 + hook） */
  private systemPromptService: import('../core/system-prompt.js').SystemPromptService;
  /** Agent Loop 子系统（接口注入，LLM+工具循环） */
  private agentLoop: import('../core/loop.js').AgentLoopService;
  /** 工具子系统（构造注入，缺省默认） */
  tools: import('../core/tools.js').ToolProvider;
  /** 权限子系统（构造注入，缺省默认） */
  permission: import('../core/permission.js').PermissionProvider;
  /** 事件总线（构造注入，缺省默认 PromptEventEmitter） */
  private events: PromptEventEmitter;
  /** 段收集器（接口注入，把成对 span 合成一段完整行为；/traces 只读，不参与对话流程） */
  private spanCollector: SpanCollector;
  /** 当前模型名（供 /model 命令读写） */
  currentModel: string = '';
  /** 当前 provider 类型（供 /model 命令读写） */
  currentProvider: string = 'deepseek';
  /** 当前 baseUrl（供 /model 命令读写） */
  currentBaseUrl: string = '';
  /** thinking 配置模式（阶段 C2：'on' 常开 / 'off' 常关 / 'auto' 按有无进行中任务判定，缺省 auto） */
  private thinkingMode: 'auto' | 'on' | 'off' = 'auto';
  /** 选择器钩子（TTY 由 TreeUI 注册，管道用默认 selectFromList） */
  private selectHook: ((items: SelectItem[], title?: string) => Promise<string | undefined>) | null = null;
  /** TTY 读行钩子（由 TreeUI 注册，走 InputHandler；管道用 readLine） */
  private readLineHook: ((prompt?: string) => Promise<string>) | null = null;
  /* ── 事件发射器（组合模式，Runtime 只持自己的事件） ── */

  /** 订阅运行时事件 */
  subscribe(handler: EventHandler): () => void {
    return this.events.subscribe(handler);
  }
  /** 精确订阅（钩子，可返回结果影响流程） */
  on(type: string, handler: HookHandler): () => void {
    return this.events.on(type, handler);
  }

  /* ── 流式队列（仿 Pi 的双层循环结构） ── */

  /**
   * 当前是否处于"外层循环进行中"（处理一条或多条 followUp 消息）。
   * 为 true 时，新输入入队 followUp 而非直接进入 prompt。
   */
  private isStreaming = false;

  /**
   * followUp 队列：等当前回复完全结束后才处理的消息。
   * 用户在 Agent 生成时输入的新消息进入此队列。
   * 由外层循环（prompt 顶部）消费 —— 仿 Pi runLoop 的 getFollowUpMessages()。
   */
  private followUpQueue: string[] = [];

  /**
   * 内层引导（steering）队列：用户在执行中途插入的指示。
   *
   * 消费顺序（两处，先内后外）：
   *   1) 内层 —— AgentLoop 每次**工具执行完、下一次 LLM 调用之前**取一条，
   *      追加进最后一条 tool 结果 → 引导在**本轮内**生效（真·引导）
   *   2) 外层 —— 本轮没有工具调用、或已经是最后一轮（内层不取，避免吞消息）时，
   *      由外层循环取走，当**下一回合**处理（退化成高优先级的 followUp）
   *
   * 注意这里**不做** abort：中断在飞的 fetch 需 llm.stream() 支持 AbortSignal，
   * 而且半截 tool_call 的 JSON 不可执行、已跑过的工具副作用无法撤销 —— 仍属【预留】。
   */
  private steerQueue: string[] = [];

  /** 累计 token 用量（缓存明细字段：API 报过才有，全程没报缺省） */
  totalUsage: LLMUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  /** 发送一条 followUp 消息到队列中（等当前回复结束后处理） */
  private queueFollowUp(text: string): void {
    this.followUpQueue.push(text);
  }

  /** 取出下一条待处理的 followUp 消息（无则返回 null） */
  private dequeueFollowUp(): string | null {
    return this.followUpQueue.shift() ?? null;
  }

  /**
   * 发送一条 steering 消息（内层引导）。
   * 消费点有两处，先内后外：AgentLoop 的工具边界（本轮内生效）→ 外层循环（退化成高优先级 followUp）。
   */
  private queueSteer(text: string): void {
    this.steerQueue.push(text);
  }

  /** 取出下一条 steering 消息（无则返回 null） */
  private dequeueSteer(): string | null {
    return this.steerQueue.shift() ?? null;
  }

  constructor(options: RuntimeOptions) {
    this.llm = options.llm;
    this.session = options.session;
    this.sessionRepo = options.sessionRepo;
    // 子系统：全部必注入（多系统分离——Runtime 不创建任何子系统，只编排）
    this.tools = options.tools;
    this.permission = options.permission;
    this.events = options.events;
    // 段收集器（main 建实例并 attach 到同一条总线；与 trace-log watcher 各持一份，互不知情）
    this.spanCollector = options.spanCollector;
    this.skills = options.skills;
    this.skills.load();
    this.commandSystem = options.commandSystem;
    this.diagnosticsService = options.diagnosticsService;
    // 上下文管理（压缩）——注入（main 组装，Jsonl 时启用）
    this.compaction = options.compaction;
    // 系统提示词——注入（main 组装，配置驱动 + hook）
    this.systemPromptService = options.systemPromptService;
    // Agent Loop——内部创建（回调依赖 runtime 的权限弹窗/诊断/兜底）
    this.agentLoop = this.buildAgentLoop();
    if (options.model) this.currentModel = options.model;
    if (options.provider) this.currentProvider = options.provider;
    if (options.baseUrl) this.currentBaseUrl = options.baseUrl;
    if (options.thinking) this.thinkingMode = options.thinking;
  }

  /**
   * 组装 Agent Loop（构造时与热切换时各调一次）。
   * 为什么抽成方法：AgentLoop 持有的是注入时的 Provider 引用，
   * setLLM() 只改 this.llm 不重建它，循环就会继续用旧的那只。
   */
  private buildAgentLoop(): import('../core/loop.js').AgentLoopService {
    return new AgentLoopServiceImpl({
      llm: this.llm,
      tools: this.tools,
      permission: this.permission,
      events: this.events,
      onPermission: (toolName, detail) => this.askPermission(toolName, detail),
      onDiagnostic: (level, item, message) => this.recordDiagnostic(level as 'fail' | 'warn', item, message),
      onFallback: (err) => this.tryFallbackOnError(err),
    });
  }

  /* ── 命令注册（委托给命令子系统） ── */

  registerCommand(name: string, description: string, handler: CommandHandler): void {
    this.commandSystem.register(name, description, handler);
  }

  listCommands(): Array<{ name: string; description: string }> {
    return this.commandSystem.list();
  }

  /** 选择器钩子（单选） */
  private selectMultiHook: ((items: SelectItem[], title?: string) => Promise<string[] | undefined>) | null = null;

  /** 注册选择器实现（TTY 由 TreeUI 提供组件树选择器，管道用默认） */
  registerSelect(fn: (items: SelectItem[], title?: string) => Promise<string | undefined>): void {
    this.selectHook = fn;
  }

  /** 注册多选选择器实现（TTY 由 TreeUI 提供） */
  registerMultiSelect(fn: (items: SelectItem[], title?: string) => Promise<string[] | undefined>): void {
    this.selectMultiHook = fn;
  }

  /** 注册 TTY 读行实现（由 TreeUI 提供，走 InputHandler 而非 readline，避免 lineBuffer 污染） */
  registerReadLine(fn: (prompt?: string) => Promise<string>): void {
    this.readLineHook = fn;
  }

  /**
   * 读取一行输入（命令表单用）。
   * TTY 下走 InputHandler（绕过 readline 的 lineBuffer 污染）；
   * 管道模式用 readLine。
   */
  readLineInput(prompt?: string): Promise<string> {
    if (this.readLineHook) return this.readLineHook(prompt);
    // 管道模式：用 readline
    return readLine(prompt);
  }

  /** 运行选择器（命令系统调用；TTY 走 TreeUI 组件树，否则用默认 selectFromList） */
  select(items: SelectItem[], title?: string): Promise<string | undefined> {
    if (this.selectHook) return this.selectHook(items, title);
    // 未注册钩子（管道模式）→ 用默认选择器
    return selectFromList(items as any, title);
  }

  /** 运行多选选择器（Space 勾选，Enter 确认返回勾选集） */
  selectMulti(items: SelectItem[], title?: string): Promise<string[] | undefined> {
    if (this.selectMultiHook) return this.selectMultiHook(items, title);
    // 管道模式无多选 → 退回单选单个
    return selectFromList(items as any, title).then((v) => (v ? [v] : undefined));
  }

  /* ── Input 事件 ── */

  /**
   * 注册输入预处理器（改写 / 吞掉用户输入）。
   * **消费点在 `prompt()` 的第 ③ 段 —— 命令分发之后、skill 展开之前**
   * （`/cmd` 不会经过这里：命令那一支在 ② 段就 return 了）。
   * 2026-09-18 更正：本行原文写的是"在命令分发**前**"，与实现相反，属注释失真。
   * 注：这里的 InputHandler 是**函数类型**（见本文件上方定义），与 io/ui/input-handler.ts
   *     那个逐键解析的 InputHandler **类**同名不同物。
   * 当前注册者只有一位：`harness/main.ts` 挂的 `@file` 输入引用（ROADMAP 10.8.1）。
   * 此前挂过的 demoInputHandler 会静默吞掉 "@@" 开头的输入，属未文档化的演示行为，已摘除。
   */
  onInput(handler: InputHandler): void {
    this.inputHandlers.push(handler);
  }

  /* ── 公开方法 ── */

  /**
   * 开启新会话：清历史 + 清授权。
   * 调用方：/clear 命令（commands/builtin/clear.ts）、RPC 的 clear（harness/rpc.ts）。
   *
   * 为什么连带清授权："本次全部允许"的"本次"就是本次会话。在此之前 permission.clear()
   * 契约声明了、PermissionManager 实现了、permission 还是 public 字段，却全 src/ 零调用方
   * ——那个"本次"实际是"本进程"，一直有效到退出为止。
   */
  async clearSession(): Promise<void> {
    await this.session?.clear();
    this.permission.clear();
  }

  /**
   * 获取当前分支上的全部历史消息（含 msgId）。
   * 调用方：/history 命令
   * 服务于：展示会话历史、定位 fork 点
   */
  async getHistoryMessages(): Promise<Array<{ msgId: string; role: string; content: string; steer: boolean }>> {
    // steer 标记由内容前缀判定（不是结构化字段）——三个存储后端都只保 role + content，
    // 前缀是唯一通用的标记通道，理由见 STEER_PREFIX 的注释。
    // 能力探测代替 instanceof：契约里 getAllStored 是可选成员，实现了就是 entry 树存储
    if (this.session?.getAllStored) {
      // StoredMessage 的 id/msgId 都可选（兼容 JSONL 用 id、对外 API 用 msgId），这里显式兜底
      return this.session.getAllStored().map((m) => ({
        msgId: m.msgId ?? m.id ?? '',
        role: m.role,
        content: m.content,
        steer: m.content.startsWith(STEER_PREFIX),
      }));
    }
    // 非 entry 树存储（InMemory/Mock）：从 getMessages 拼装（无 msgId）
    const msgs = (await this.session?.getMessages()) ?? [];
    return msgs.map((m, i) => ({
      msgId: `m${i}`,
      role: m.role,
      content: m.content,
      steer: m.content.startsWith(STEER_PREFIX),
    }));
  }

  /**
   * fork 出新分支：从某条消息之前复制前缀到新会话，原历史不动。
   * 调用方：/history 命令（"从此继续"）
   * 服务于：不破坏原历史，长出新分支，并把当前会话切到新分支
   *
   * @param msgId 分叉点消息 id（新分支复制到它为止）
   * @returns 新会话文件名
   */
  async forkSessionAt(msgId: string): Promise<string> {
    const forked = await this.forkToStorage(msgId);
    if (!forked) return '';
    this.session = forked.storage;
    return forked.fileName;
  }

  /**
   * fork 并把长前缀压缩成摘要（/history"带摘要从此继续"）。
   * 调用方：/history 命令
   * 服务于：长对话分叉后 LLM 不再每轮背着整个前缀跑——forkTo 先原样复制整条前缀
   * （文件仍是完整历史，append-only 不破，审计性同普通 fork），再对新会话强制压缩
   * （CompactionService.compactNow）：compaction 入树后，getMessages() 视图 =
   * [对话摘要] + 最近 KEEP_RECENT 条。前缀不足时不压缩（summarized=false，等同普通分叉）。
   */
  async forkSessionWithSummary(
    msgId: string,
  ): Promise<{ fileName: string; summarized: boolean; summary?: string }> {
    const forked = await this.forkToStorage(msgId);
    if (!forked) return { fileName: '', summarized: false };
    this.session = forked.storage;
    const history = await forked.storage.getMessages();
    // storage 传当前（=新分支的）会话：摘要入树进新文件，原文件不动
    const result = await this.compaction.compactNow(history, this.compactionStore());
    // fork 摘要的 LLM 消耗同样回流 /usage（口径与主轮压缩一致）
    if (result.usage) this.bumpUsage(result.usage);
    return {
      fileName: forked.fileName,
      summarized: !!result.summary,
      ...(result.summary ? { summary: result.summary } : {}),
    };
  }

  /** fork 共用：复制前缀到新会话存储（**不**切换 this.session）；无 forkTo 能力（InMemory/Mock）返回 null */
  private async forkToStorage(msgId: string): Promise<{ fileName: string; storage: SessionStorage } | null> {
    if (!this.session?.forkTo) return null;
    return this.session.forkTo(msgId);
  }

  /**
   * 当前会话作为压缩存储（与 main.ts 装配同判据：支持 CompactionStore 四方法才算）。
   * 每次取**当下**的 this.session——压缩服务因此无状态，切会话/fork 后自动跟随。
   * 用**可选成员探测**而不是 instanceof（探测 ≡ instanceof 的架构决策见 verify-session.ts，
   * runtime 不对具体存储类做缩窄）。
   */
  private compactionStore(): import('../core/compaction-store.js').CompactionStore | undefined {
    const s = this.session as Partial<import('../core/compaction-store.js').CompactionStore> | undefined;
    if (!s) return undefined;
    const ok = typeof s.getCompactions === 'function' && typeof s.appendCompaction === 'function'
      && typeof s.getAllMsgIds === 'function' && typeof s.getMsgById === 'function';
    return ok ? (s as import('../core/compaction-store.js').CompactionStore) : undefined;
  }

  /**
   * 列出 sessions/ 下所有会话文件。
   * 调用方：/sessions 命令
   * 有 repo 时委托 repo 层（core/session-repo.ts 契约）；缺省回退旧静态路径。
   */
  async listSessions(): Promise<Array<{ fileName: string; msgCount: number; updatedAt: number }>> {
    if (this.sessionRepo) return this.sessionRepo.list();
    // 回退：临时建一个 repo（列表逻辑只在 jsonl-repo 一处，不在 runtime 复制第二份）
    return new JsonlSessionRepo(this.sessionDir()).list();
  }

  /**
   * 切换到指定会话文件。
   * 调用方：/sessions 命令
   */
  async switchSession(fileName: string): Promise<boolean> {
    if (this.sessionRepo) {
      try {
        this.session = await this.sessionRepo.open(fileName);
        return true;
      } catch {
        return false;
      }
    }
    const dir = this.sessionDir();
    const storage = await JsonlSessionStorage.open(`${dir}/${fileName}`);
    if (!storage) return false;
    this.session = storage;
    return true;
  }

  /**
   * 新建一个空会话并切换过去。
   * 调用方：/sessions 命令（"新建会话"）
   */
  async createSession(name?: string): Promise<string> {
    if (this.sessionRepo) {
      const { fileName, storage } = await this.sessionRepo.create(name);
      this.session = storage;
      return fileName;
    }
    const dir = this.sessionDir();
    const fileName = name?.endsWith('.jsonl') ? name : `${name ?? `session-${Date.now().toString(36)}`}.jsonl`;
    const storage = await JsonlSessionStorage.create(dir, fileName);
    this.session = storage;
    return fileName;
  }

  /**
   * 删除指定会话文件（repo 层能力，此前整个项目没有删除会话的入口）。
   * 调用方：/sessions 命令（"删除会话"）
   *
   * 守卫：**当前活跃会话不可删**——删掉后 this.session 指向已 unlink 的文件，
   * 后续 append 会静默丢消息。想删它请先切换到别的会话。
   * 守卫比对用 getFilePath（可选成员探测，InMemory/Mock 无此成员则跳过比对）。
   */
  async deleteSession(fileName: string): Promise<boolean> {
    if (!this.sessionRepo) return false;
    const currentPath = this.session?.getFilePath?.();
    if (currentPath) {
      const target = path.join(this.sessionRepo.getDir(), fileName);
      if (path.resolve(currentPath) === path.resolve(target)) return false;
    }
    return this.sessionRepo.remove(fileName);
  }

  /** 当前会话文件路径（供 /sessions 标记"当前"；InMemory/Mock 无 → undefined） */
  getCurrentSessionFile(): string | undefined {
    return this.session?.getFilePath?.();
  }

  /** 当前会话目录（供列表/切换/新建复用） */
  private sessionDir(): string {
    if (this.session?.getDir) return this.session.getDir();
    return './sessions';
  }

  /** 当前会话消息数（供 banner 展示，读取当前分支路径长度） */
  async getSessionMsgCount(): Promise<number> {
    if (this.session?.getAllStored) return this.session.getAllStored().length;
    return (await this.session?.getMessages())?.length ?? 0;
  }

  getSkillLoader(): SkillLoader {
    return this.skills;
  }

  /** 获取历史诊断列表（供 /diagnostics 命令查看、外部导出）—— 委托诊断子系统 */
  getDiagnostics(): Diagnostic[] {
    return this.diagnosticsService.getAll();
  }

  /** 获取最近收束的行为段（供 /traces 命令查看）—— 委托段收集器，只读不改 */
  getTraces(): CollectedSpan[] {
    return this.spanCollector.recent();
  }

  /** 获取仍未关门的行为段（供 /traces 显示"正在跑"）—— 委托段收集器 */
  getRunningSpans(): CollectedSpan[] {
    return this.spanCollector.running();
  }

  /** 记录一条运行时诊断 —— 委托诊断子系统 */
  private recordDiagnostic(level: Diagnostic['level'], item: string, message: string): void {
    this.diagnosticsService.record(level, item, message);
  }

  /** 获取当前 LLM Provider（用于 /model 命令读取） */
  getLLM(): LLMProvider {
    return this.llm;
  }

  /** 运行时替换 LLM Provider（实现热切换模型） */
  setLLM(provider: LLMProvider): void {
    this.llm = provider;
    // 重建 Agent Loop：否则它仍持旧 Provider，兜底切换形同虚设——
    // 用户点了"切换到兜底模型"，下一轮却仍打向刚刚失败的那只
    this.agentLoop = this.buildAgentLoop();
  }

  /* ── 生命周期 ── */

  async start(): Promise<void> {
    // TODO: 使用 session / services 启动子模块
  }

  async stop(): Promise<void> {
    // TODO: 停止 Runtime 子模块
  }

  /* ── 核心方法 ── */

  async prompt(
    input: string,
    onToken?: (chunk: string) => void,
    streamingBehavior: 'steer' | 'followUp' = 'followUp',
    /** 按次覆盖轮数预算（RPC chat params.maxTurns 透传；缺省仍走"有清单 30 / 无清单 5"的自动口径） */
    opts?: { maxTurns?: number },
  ): Promise<string> {
    // ① 开新回合：换发 turnId + 事件序号归零，把这一次输入引发的全部事件收成一组。
    //   仅在不在流式中时换发——用户在生成期间输入的消息会走排队分支再次进入本方法，
    //   那时若换发 turnId，在飞回合的后续事件会被错误归到新组里
    if (!this.isStreaming) this.events.beginTurn();

    // ② 扩展命令检查
    if (input.startsWith('/')) {
      const handled = await this.tryExecuteCommand(input);
      if (handled !== null) {
        if (onToken) onToken(handled);
        this.events.emit({ type: 'stream_text', text: handled });
        this.events.emit({ type: 'message_end' });
        this.events.emit({ type: 'agent_end' });
        return handled;
      }
    }

    // ③ Input 事件
    let currentText = input;
    for (const handler of this.inputHandlers) {
      const result = await handler(currentText);
      switch (result.action) {
        case 'handled':
          if (onToken) onToken('');
          return '';
        case 'transform':
          currentText = result.text;
          break;
        case 'continue':
          break;
      }
    }

    // ④ Skill/模板展开
    if (currentText.startsWith('/')) {
      currentText = this.expandSkill(currentText);
    }

    // ⑤ 流式队列检查 —— 外层循环进行中，新消息按 streamingBehavior 分流
    //   - 'followUp'（默认）：等当前所有回复完全结束后处理
    //   - 'steer'：尽快采纳。第一消费点是 AgentLoop 的工具边界（下一次 LLM 调用前追加进
    //     tool 结果 → 本轮内生效）；本轮没有工具调用或已是最后一轮时，退回外层循环当新回合处理。
    //     两条路都不 abort 在飞的流（中断需 AbortSignal + 半截 tool_call 不可执行，仍属【预留】）
    if (this.isStreaming) {
      if (streamingBehavior === 'steer') {
        this.queueSteer(currentText);
        if (onToken) onToken('（已插入，当前步骤结束后立即采纳）');
        return '（已插入）';
      }
      this.queueFollowUp(currentText);
      if (onToken) onToken('（消息已排队，等当前回复完成后处理）');
      return '（已排队）';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ⑥ 外层循环（仿 Pi runLoop 的 outer loop）：消费 followUp 队列
    //
    //   首条消息 = 用户当前输入；处理完后检查队列：
    //     - 有 followUp → 插入上下文继续处理（等当前回复完全结束后才轮到它）
    //     - 无 followUp → 退出外层循环
    //
    //   内层 = runSingleTurn()（单条消息的 LLM + 工具循环）。
    //   steering 的**常规**消费点已经下沉到内层（AgentLoop 的工具边界，见 opts.takeSteer）；
    //   下面两处出队是**兜底**：本轮没有工具调用（没有注入落点）或已是最后一轮（取走会吞消息）时，
    //   引导词仍留在队列里，由这里当下一回合处理 —— 退化成"优先级更高的 followUp"，但绝不丢失。
    //   【预留】硬打断（abort 在飞的流）仍需内层 stream 支持 AbortSignal，暂未接入。
    //
    //   整段包在 prompt span 里（根段）：这是观测树的树根，所有 llm_request / tool_call /
    //   compaction 段都落在它的 turnId 下。用 beginSpan 而非 trace()：本段跨 continue/finally，
    //   自动包裹套不进来；改由 finally 里的 root.closed 判定兼顾正常与异常两条出路。
    // ═══════════════════════════════════════════════════════════════════════════
    this.isStreaming = true;
    let finalResult = '';
    const rootAttrs: SpanAttrs<'prompt'> = { input: currentText.slice(0, 200) };
    const root = this.events.beginSpan('prompt', rootAttrs);
    let turnCount = 0;
    try {
      let turnText = currentText;
      while (true) {
        // ── ① steering 兜底出队（优先于 followUp） ──
        //   常规路径已在内层工具边界消费掉；这里能取到，说明上一轮**没有工具调用**
        //   （没地方注入）或**已是最后一轮**（内层刻意不取）。两种情况都只能另起一回合。
        //   优先级：steering > followUp。
        const steer = this.dequeueSteer();
        if (steer) {
          turnText = steer;
          this.events.emit({ type: 'thinking', phase: 'analyzing' });
          continue;
        }

        // ── ② 处理一条消息（内层单循环） ──
        const result = await this.runSingleTurn(turnText, onToken, opts);
        finalResult = result;
        turnCount++;

        // ── ③ 本轮结束后再查一次 steering（兜底，同上：内层没消费掉的才落这里） ──
        //   有 → 下一轮优先处理它（steering 优先于 followUp）
        const steerAfterTurn = this.dequeueSteer();
        if (steerAfterTurn) {
          turnText = steerAfterTurn;
          this.events.emit({ type: 'thinking', phase: 'analyzing' });
          continue;
        }

        // ── ④ 检查 followUp 队列：有则继续，无则退出 ──
        const next = this.dequeueFollowUp();
        if (!next) break;
        turnText = next;
        this.events.emit({ type: 'thinking', phase: 'analyzing' });
      }
    } catch (err) {
      root.fail(err);   // 先打异常卡，再原样重抛（兜底与报错仍归调用方）
      throw err;
    } finally {
      this.isStreaming = false;
      // 正常出路（包括 break 退出）在这里关门；已 fail 过的不重复打卡
      if (!root.closed) {
        const done: SpanResult<'prompt'> = {
          reply: finalResult.slice(0, 200),
          turns: turnCount,
          totalUsage: { ...this.totalUsage },
        };
        root.end(done);
      }
      this.events.emit({ type: 'agent_end' });
    }

    return finalResult;
  }

  /**
   * 处理单条用户消息的完整一轮（内层循环，仿 Pi 的 runLoop inner loop）。
   * 调用方：prompt 的外层循环，可能被多条 followUp 消息连续调用
   * 服务于：读历史 → 上下文压缩 → LLM 单 stream 循环（检测+执行工具）→ 存会话 → 统计
   *
   * @param currentText 本条要处理的消息文本
   * @param onToken     流式 token 回调（可选，透传给 UI 展示）
   * @returns 最终回复文本
   */
  private async runSingleTurn(
    currentText: string,
    onToken?: (chunk: string) => void,
    /** prompt 传下的按次轮数覆盖（undefined = 走自动口径） */
    turnOpts?: { maxTurns?: number },
  ): Promise<string> {
    // 发射 thinking 事件（告诉 UI 开始旋转）
    this.events.emit({ type: 'thinking', phase: 'analyzing' });

    // 本轮**被内层吸收**的引导（takeSteer 的副产物）。落盘时要按序补在本轮 assistant 之前，
    // 否则用户中途改的方向只活在本次请求的 toolMessages 里，下一轮起就无从知晓。
    const absorbedSteers: string[] = [];

    // ⑦: 上下文压缩 —— 委托给 CompactionService（历史超限时 LLM 摘要 + 入树）
    // storage 每次显式传入：压缩服务无状态，跟着当前会话走（构造期绑死会写进旧文件）
    let history = this.session ? await this.session.getMessages() : [];
    const compacted = await this.compaction.maybeCompact(history, this.compactionStore());
    history = compacted.history;
    // 压缩摘要的 LLM 消耗回流 /usage 合计（没压缩 / 失败 / API 没报时 usage 缺省）
    if (compacted.usage) this.bumpUsage(compacted.usage);
    // 事件库自动补记（确定性钩子）：旧上下文被摘要替代的那一刻给事件库留书签。
    // 与 taskStore/memoryStore 单例同一直连手法——压缩判定点只在 runtime 这一处。
    if (compacted.summary) eventStore.recordCompaction(compacted.summary, EVENTS_FILE);
    this.events.emit({ type: 'thinking', phase: 'streaming' });

    // ⑧: Agent Loop —— LLM 调用 → Tool 执行 → 循环
    const toolDescriptions = this.tools.getLLMTools().map((t) =>
      `  - ${t.function.name}: ${t.function.description}（参数: ${JSON.stringify(t.function.parameters)}）`
    ).join('\n');

    // 系统提示词：分层构建（稳定前缀缓存友好：core → tools → skills → project → memory → task → summary）
    // 每层独立 system 消息，越稳定越靠前；摘要来自 compaction 独立返回（不混入 history）
    // 工作记忆：读**内存真相源**（taskStore）——它独立于对话历史，压缩碰不到，每次请求重新渲染注入。
    // 只在"还有未完成项"时注入：空清单 / 全完成 = 无进行中计划，不注入、不放大预算、不开 auto thinking
    const rawTask = taskStore.hasUnchecked() ? taskStore.render() : undefined;
    // 截断防膨胀：注入是**展示**，可以截；而投影落盘（store.projectToFile）不截——
    // render 必须与 parse 严格互逆，截一刀就漂一次
    const taskMemory = rawTask && rawTask.length > 2000
      ? `${rawTask.slice(0, 2000)}\n...（截断）`
      : rawTask;
    // 项目现状快照（`.flint/PROJECT.md`）：**每轮现读**。这里与 task/memory 两层的取法相反，
    // 理由是状态来源不同——那两层有内存真相源（store），回读文件会变成"两处判定"；现状快照
    // **没有 store**，文件就是唯一真相源，所以读的是同一处。附带好处是自愈：模型改完即生效。
    // 完整取舍见 src/project/snapshot.ts 文件头（它是 ROADMAP P10.12.5 的注入侧）。
    const projectSnapshot = readProjectSnapshot();
    // 项目命令表（10.6.1）：**不每轮现读 package.json** —— 启动时播种进 commandRegistry 后
    // 运行期不再回读（理由见 commands.ts 文件头「发现 ≠ 授权」：package.json 是模型可写文件）。
    // 每轮只做一次渲染（空表 → 空串 → 半段缺席，与现状快照缺席同一纪律）。
    const commandsSection = renderCommandsSection(commandRegistry.get());
    // 技术栈画像（10.1.1）：与命令表**完全同一手法** —— 播种时探测一次进注册表、
    // 运行期只渲染不回读（理由见 project/stack.ts 文件头：它喂给命令表的包管理器前缀，
    // 而命令表是"启动读一次"的，刷新率必须一致才不会出现两个口径）。
    // 空画像（一个模板文件都没命中）→ 空串 → 半段缺席，与其他各层同一纪律。
    const stackSection = renderStackSection(stackRegistry.get());
    // 项目记忆：读内存真相源（memoryStore），有条目才注入；截断同 task 层——注入可截，投影不截
    const rawMemory = memoryStore.isEmpty() ? undefined : memoryStore.render();
    const projectMemory = rawMemory && rawMemory.length > 2000
      ? `${rawMemory.slice(0, 2000)}\n...（截断）`
      : rawMemory;
    const { messages: systemMessages } = await this.systemPromptService.build({
      tools: toolDescriptions,
      skills: this.skills.getAll().map((s) => s.name),
      // 技能声明的依赖：给 skills-section 标注"依赖谁 / 缺了谁"用（与清单同一时刻现取，同样自愈）
      skillDeps: Object.fromEntries(this.skills.getAll().map((s) => [s.name, s.depends ?? []])),
      model: this.currentModel,
      summary: compacted.summary,
      project: projectSnapshot,
      stack: stackSection === '' ? undefined : stackSection,
      commands: commandsSection === '' ? undefined : commandsSection,
      task: taskMemory,
      memory: projectMemory,
      historyCount: history.length,
    });

    // thinking 自动判定（阶段 C2）先于历史组装（方案 B：历史形态跟着 thinking 走）：
    // 'on' 常开；'auto' 仅当有进行中任务（清单有未完成项）时开；'off' 常关。
    // 与注入共享同一信号：taskMemory 仅在 hasUnchecked 时非空，空清单/全完成不会污染 auto
    const thinkingOn = this.thinkingMode === 'on' || (this.thinkingMode === 'auto' && taskMemory !== undefined);

    // 历史组装按 thinking 分叉（2026-09-12 跨轮结构化接通，方案 B）：
    // - thinking **开** → 降级为纯文本。这道丢弃仍是**承重的**：getMessages() 会还原
    //   tool_calls / tool_call_id / name，但 thinkingBlocks 永不落盘；透传后历史里带 tool_calls
    //   的 assistant 轮没有配对的 thinking 块，anthropic.ts 的 resolveAnthropicThinking 安全阀
    //   会把 extended thinking 全程静默关掉。降级不是原样丢弃：tool 结果转 user 文本（信息保住）、
    //   纯工具调用的空 assistant 轮剔除（两条协议都不收空内容消息）。
    //   （本轮循环**内**仍是全结构化，不受影响。）
    // - thinking **关** → 全量结构化回传：上一轮真实调过什么工具、结果是什么，模型看得到。
    //   两条协议线路此时都合法：Anthropic 关 thinking 无块回放义务；OpenAI 无此约束。
    //   安全阀原样保留当兜底——任何漏网的无块结构化历史会被它拦下而不是 400。
    // 详见 Log/ARCHITECTURE.md 第四节第 9 条（已随本轮改写，verify-session.ts ⑨ 段断言同步）。
    const toolMessages: LLMMessage[] = [
      ...systemMessages.map(({ content }) => ({ role: 'system' as const, content })),
      ...(thinkingOn
        ? history.flatMap((m) => {
            // 降级视图（方案 B）：tool 结果转 user 文本（保住信息、shape 合法——孤儿 tool 消息
            // 丢了 tool_call_id 两条协议都不认）；纯工具调用轮（assistant 空文本）剔除——它的
            // 信息在 tool 结果里，空 assistant 消息两条协议都不收。
            if (m.role === 'tool') {
              return [{ role: 'user' as const, content: `[工具 ${m.name ?? ''} 结果] ${m.content}` }];
            }
            if (m.role === 'assistant' && !m.content.trim()) return [];
            return [{ role: m.role as LLMMessage['role'], content: m.content }];
          })
        : history.map((m) => ({
            role: m.role as LLMMessage['role'],
            content: m.content,
            ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id
              ? { tool_call_id: m.tool_call_id, ...(m.name ? { name: m.name } : {}) }
              : {}),
          }))),
      { role: 'user' as const, content: currentText },
    ];

    // ═══════════════════════════════════════════════════════════════════════════
    // ⑧: Agent Loop —— 委托给 AgentLoop 子系统（LLM 生成 + 工具执行循环）
    // ═══════════════════════════════════════════════════════════════════════════
    // 轮数预算：有进行中任务（taskStore 有未完成项）时放大轮数，否则用默认预算（防死循环）
    // （thinkingOn 已在上方组装前判定）
    const { finalText, usage, turnLog } = await this.agentLoop.run(toolMessages, onToken, {
      // 按次覆盖优先（RPC 大任务场景）；缺省回落"有清单放宽 / 无清单收紧"的自动口径
      maxTurns: turnOpts?.maxTurns ?? (taskMemory ? WITH_PLAN_MAX_TURNS : DEFAULT_MAX_TURNS),
      thinking: thinkingOn,
      model: this.currentModel,
      // 内层引导取件：让用户在工具执行期间插入的话进**本轮**上下文（AgentLoop ④ 段负责注入）。
      // 顺带发 thinking 事件——内层吸收同样是"模型要重新生成"的信号，UI 的封框/状态行
      // 已有现成分支，不需要为新机制加事件类型。
      takeSteer: () => {
        const steer = this.dequeueSteer();
        if (steer) {
          // 记入本轮缓冲：它已被内层吸收，属于**本轮**，落盘时要补在本轮 assistant 之前
          absorbedSteers.push(steer);
          this.events.emit({ type: 'thinking', phase: 'analyzing' });
        }
        return steer;
      },
    });
    this.events.emit({ type: 'message_end' });

    // 落盘（2026-09-12 接通写侧）：本轮中间消息（agent-loop 上交的 turnLog）带 extra 落盘，
    // 跨轮后模型（thinking 关时回传）与 /history 都看得到上一轮真实调过什么工具、结果是什么。
    // 顺序：user → steers → 中间消息（忠实于发生顺序）→ 最终回复。thinkingBlocks 不在 extra
    // 三字段内，自然不落盘——方案 B 的前提：thinking 开时历史本就回退纯文本，块无回放义务。
    await this.session?.appendMessage('user', currentText);
    // 被内层吸收的引导：作为独立 user 条目补在本轮 assistant **之前** —— 时序忠实，
    // 引导确实发生在「用户提问」与「助手回复」之间，而不是等回复完才冒出来。
    // 形状上会产出 user,user,assistant：由 anthropic.ts 的 toAnthropicMessages 做**同角色
    // 相邻归并**消化（Anthropic 线路）；OpenAI 兼容路径原样透传，标准语义容忍连续 user。
    // 内容带 STEER_PREFIX：三个存储后端都只保 role + content，前缀因此是唯一通用的标记通道。
    for (const steer of absorbedSteers) {
      await this.session?.appendMessage('user', STEER_PREFIX + steer);
    }
    // turnLog 逐条落盘：tool 结果带 tool_call_id + name，assistant 带 tool_calls。
    // 引导/收尾提示已被 agent-loop 原地追加进 tool 结果 content，落盘即模型实际所见（忠实回放）。
    // InMemory/Mock 不接第三个参数会静默丢 extra——可接受：它们是测试后端，Jsonl 是唯一真相后端。
    for (const m of turnLog) {
      if (m.role === 'tool') {
        await this.session?.appendMessage('tool', m.content, {
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.name ? { name: m.name } : {}),
        });
      } else {
        await this.session?.appendMessage(m.role, m.content, {
          ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
        });
      }
    }
    await this.session?.appendMessage('assistant', finalText);
    // 用量：优先 API 真值（Agent Loop 已合计各轮），缺失才回退估算——
    // 估算只算 user 输入 + 最终回复，多轮工具循环的中间 assistant/tool 消息、
    // system prompt、工具描述全没算，多轮任务下严重少报
    this.bumpUsage(usage ?? estimateTokenUsage(currentText, finalText));
    return finalText;
  }

  /**
   * 用量入账（唯一累加点）：并入 /usage 合计并广播 usage 事件。
   * 主轮（agent loop）、压缩摘要（maybeCompact / compactNow 的 LLM 调用）都走这里——
   * 压缩也是真金白银的 API 调用，过去不回流等于 /usage 少报（2026-09-12 回流）。
   */
  private bumpUsage(u: LLMUsage): void {
    this.totalUsage.promptTokens += u.promptTokens;
    this.totalUsage.completionTokens += u.completionTokens;
    this.totalUsage.totalTokens += u.totalTokens;
    // 缓存明细：有报就累加，全程无报字段保持缺省（不伪报 0）
    if (u.cacheReadTokens !== undefined) {
      this.totalUsage.cacheReadTokens = (this.totalUsage.cacheReadTokens ?? 0) + u.cacheReadTokens;
    }
    if (u.cacheCreationTokens !== undefined) {
      this.totalUsage.cacheCreationTokens = (this.totalUsage.cacheCreationTokens ?? 0) + u.cacheCreationTokens;
    }
    this.events.emit({ type: 'usage', current: u, total: { ...this.totalUsage } });
  }

  /* ── 内部方法 ── */

  /** 展开 /skill:名称 引用 —— 从 SkillLoader 查找并插入 */
  private expandSkill(text: string): string {
    if (!text.startsWith('/skill:')) return text;
    const spaceIndex = text.indexOf(' ');
    const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
    const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim();

    const skill = this.skills.get(skillName);
    if (!skill) return text;

    const skillBlock = `<skill name="${skill.name}" path="${skill.filePath}">\n${skill.body}\n</skill>`;
    return args ? `${skillBlock}\n\n${args}` : skillBlock;
  }

  /**
   * 工具权限确认（AgentLoop 的 onPermission 回调）—— 弹窗询问用户。
   * 返回 'allow' | 'deny' | 'always'。
   *
   * 弹窗走 runtime.select 而不是裸 selectFromList（2026-09-13）：
   * TTY 下 TreeUI 已注册钩子 → 弹窗进组件树，与 spinner/任务面板同布局互不覆盖
   * （旧实现裸写 stdout，"拒绝"那一行会被面板刷新盖掉）；管道模式回落 selectFromList，
   * 非 TTY 直接选第一项 = 允许一次（自动放行，无 stdout 噪音）。
   */
  private async askPermission(toolName: string, detail: string): Promise<'allow' | 'deny' | 'always'> {
    const choice = (await this.select(
      PERMISSION_OPTIONS,
      permissionTitle(toolName, detail, process.stdin.isTTY === true),
    )) ?? 'deny';   // Ctrl+C 取消 = 不做这件事，与"拒绝"同义
    return choice === 'always' ? 'always' : choice === 'deny' ? 'deny' : 'allow';
  }

  /**
   * LLM 调用失败的兜底处理 —— 询问用户是否切换到兜底模型（OpenCode Go）。
   * 只在 TTY 交互模式下触发。
   */
  private async tryFallbackOnError(error: unknown): Promise<boolean> {
    if (!process.stdin.isTTY) return false;

    const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.error(`\n  ❌ LLM 调用失败: ${msg}`);

    const { getConfigManager } = await import('../config/manager.js');
    const mgr = await getConfigManager();
    const fallback = mgr.getFallback();

    if (!fallback) return false;

    const fallbackLabel = `${fallback.provider.name} (${fallback.provider.getModels().find(m => m.id === fallback.modelId)?.label ?? fallback.modelId})`;
    const choice = await this.select(
      [
        { value: 'switch', label: `切换到 ${fallbackLabel}` },
        { value: 'no', label: '不切换，直接退出' },
      ],
      '❌ LLM 调用失败，是否切换兜底模型？',
    );

    if (choice === 'switch') {
      const p = fallback.provider;
      const newProvider = p.createLLM(fallback.modelId);
      this.setLLM(newProvider);
      this.currentProvider = p.type;
      this.currentBaseUrl = p.baseUrl;
      this.currentModel = fallback.modelId;
      console.error(`  ✅ 已切换到 ${fallbackLabel}，请重试。`);
      return true;
    }

    return false;
  }

  private async tryExecuteCommand(text: string): Promise<string | null> {
    return this.commandSystem.execute(text);
  }
}
