/**
 * Runtime 运行时 —— Agent 运行时的上下文与全局状态管理。
 * 调用方：main.ts（初始化并启动）
 * 服务于：串联 LLM 调用、session 对话、命令注册、input 事件、skill 展开
 */
import type { LLMMessage } from '../llm/types.js';
import type { LLMProvider } from '../llm/types.js';
import type { Diagnostic, RuntimeOptions } from '../types.js';
import { SkillLoader } from './skill.js';
import { PromptEventEmitter } from './events.js';
import { JsonlSessionStorage } from '../session/jsonl-storage.js';
import type { EventHandler, HookHandler, SpanAttrs, SpanResult } from './events.js';
import type { CollectedSpan, SpanCollector } from '../core/events.js';
import { AgentLoopServiceImpl, DEFAULT_MAX_TURNS, WITH_PLAN_MAX_TURNS } from '../loop/agent-loop.js';
import { estimateTokenUsage } from './utils.js';
import { promptPermission } from '../io/ui/permission-prompt.js';
import { selectFromList } from '../io/ui/selector.js';
import { readLine } from '../io/terminal.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { hasUncheckedTask } from '../context/system-prompt.js';

/**
 * 读工作记忆 TASK.md 并善后（阶段 C2 工程侧清理）。
 * 调用方：Runtime.runSingleTurn（每次请求注入 task 层）
 * 服务于：compaction 只压缩对话历史 jsonl，TASK.md 在文件系统不受影响，每次请求重新读取注入。
 *   清理语义：清单全勾选（任务已完成）→ 删除文件并返回 undefined——
 *   遗留的已完成计划不再放大轮数预算、不再触发 auto thinking/续传提示（不依赖模型自觉）。
 */
export function loadTaskMemory(taskPath = 'TASK.md'): string | undefined {
  try {
    if (!existsSync(taskPath)) return undefined;
    const content = readFileSync(taskPath, 'utf-8').trim();
    if (!content) return undefined;
    if (!hasUncheckedTask(content)) {
      try { unlinkSync(taskPath); } catch { /* 清理失败不阻塞请求（下次请求会重试） */ }
      return undefined;
    }
    // 截断防膨胀（TASK.md 由模型用 write 维护，应保持精简）
    return content.length > 2000 ? content.slice(0, 2000) + '\n...（截断）' : content;
  } catch {
    return undefined; // 读取失败不影响请求（无工作记忆）
  }
}

/* ── 类型定义 ── */

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
   * steering 队列（预留）：立即打断当前流并处理的消息。
   * 需 llm.stream() 支持 AbortSignal 才能中断进行中的流 —— 暂未接入。
   */
  private steerQueue: string[] = [];

  /** 累计 token 用量 */
  totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  /** 发送一条 followUp 消息到队列中（等当前回复结束后处理） */
  private queueFollowUp(text: string): void {
    this.followUpQueue.push(text);
  }

  /** 取出下一条待处理的 followUp 消息（无则返回 null） */
  private dequeueFollowUp(): string | null {
    return this.followUpQueue.shift() ?? null;
  }

  /**
   * 发送一条 steering 消息（仿 Pi：不 abort 当前流，当前轮结束后优先处理）。
   * 与 followUp 的区别：steering 在"本轮完成后、外层循环查 followUp 之前"先被处理。
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
   * 注册输入预处理器（在命令分发前改写 / 吞掉用户输入）。
   * 注：这里的 InputHandler 是**函数类型**（见本文件上方定义），与 io/ui/input-handler.ts
   *     那个逐键解析的 InputHandler **类**同名不同物。
   * 当前无注册者：原先挂的 demoInputHandler 会静默吞掉 "@@" 开头的输入，属未文档化的
   * 演示行为，已摘除；能力本身保留给 ROADMAP 里的 Hook 系统。
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
  async getHistoryMessages(): Promise<Array<{ msgId: string; role: string; content: string }>> {
    // 能力探测代替 instanceof：契约里 getAllStored 是可选成员，实现了就是 entry 树存储
    if (this.session?.getAllStored) {
      // StoredMessage 的 id/msgId 都可选（兼容 JSONL 用 id、对外 API 用 msgId），这里显式兜底
      return this.session.getAllStored().map((m) => ({
        msgId: m.msgId ?? m.id ?? '',
        role: m.role,
        content: m.content,
      }));
    }
    // 非 entry 树存储（InMemory/Mock）：从 getMessages 拼装（无 msgId）
    const msgs = (await this.session?.getMessages()) ?? [];
    return msgs.map((m, i) => ({ msgId: `m${i}`, role: m.role, content: m.content }));
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
    if (!this.session?.forkTo) return '';
    const { fileName, storage } = await this.session.forkTo(msgId);
    this.session = storage;
    return fileName;
  }

  /**
   * 列出 sessions/ 下所有会话文件。
   * 调用方：/sessions 命令
   */
  async listSessions(): Promise<Array<{ fileName: string; msgCount: number; updatedAt: number }>> {
    return JsonlSessionStorage.listAll(this.sessionDir());
  }

  /**
   * 切换到指定会话文件。
   * 调用方：/sessions 命令
   */
  async switchSession(fileName: string): Promise<boolean> {
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
    const dir = this.sessionDir();
    const fileName = name?.endsWith('.jsonl') ? name : `${name ?? `session-${Date.now().toString(36)}`}.jsonl`;
    const storage = await JsonlSessionStorage.create(dir, fileName);
    this.session = storage;
    return fileName;
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
    //   - 'steer'：当前轮跑完后优先处理（仿 Pi，不 abort 当前流）
    if (this.isStreaming) {
      if (streamingBehavior === 'steer') {
        this.queueSteer(currentText);
        if (onToken) onToken('（消息已插入，当前回复完成后立即处理）');
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
    //   【预留】steering 打断需内层 stream 支持 AbortSignal，暂未接入。
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
        // ── ① steering 检查（优先于 followUp，仿 Pi：不 abort 当前流） ──
        //   用户等待时输入的新消息进入 steerQueue，当前轮跑完后立即处理它。
        //   优先级：steering > followUp（先打断，再排队）。
        const steer = this.dequeueSteer();
        if (steer) {
          turnText = steer;
          this.events.emit({ type: 'thinking', phase: 'analyzing' });
          continue;
        }

        // ── ② 处理一条消息（内层单循环） ──
        const result = await this.runSingleTurn(turnText, onToken);
        finalResult = result;
        turnCount++;

        // ── ③ 本轮结束后，先看有没有新 steering（可能在上轮处理期间入队） ──
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
  ): Promise<string> {
    // 发射 thinking 事件（告诉 UI 开始旋转）
    this.events.emit({ type: 'thinking', phase: 'analyzing' });

    // ⑦: 上下文压缩 —— 委托给 CompactionService（历史超限时 LLM 摘要 + 入树）
    let history = this.session ? await this.session.getMessages() : [];
    const compacted = await this.compaction.maybeCompact(history);
    history = compacted.history;
    this.events.emit({ type: 'thinking', phase: 'streaming' });

    // ⑧: Agent Loop —— LLM 调用 → Tool 执行 → 循环
    const toolDescriptions = this.tools.getLLMTools().map((t) =>
      `  - ${t.function.name}: ${t.function.description}（参数: ${JSON.stringify(t.function.parameters)}）`
    ).join('\n');

    // 系统提示词：分层构建（稳定前缀缓存友好：core → tools → skills → task → summary）
    // 每层独立 system 消息，越稳定越靠前；摘要来自 compaction 独立返回（不混入 history）
    // 工作记忆（TASK.md）独立于对话历史持久化，压缩不触碰，每次请求重新注入
    const taskMemory = loadTaskMemory();
    const { messages: systemMessages } = await this.systemPromptService.build({
      tools: toolDescriptions,
      skills: this.skills.getAll().map((s) => s.name),
      model: this.currentModel,
      summary: compacted.summary,
      task: taskMemory,
      historyCount: history.length,
    });

    // 历史只映射 role + content —— 这道丢弃是**承重的**，不要“顺手补全”：
    // getMessages() 其实会还原 tool_calls / tool_call_id / name（虽然当前也没人写入，见下方 appendMessage），
    // 但 thinkingBlocks 永不落盘；一旦透传，历史里带 tool_calls 的 assistant 轮就没有配对的 thinking 块，
    // anthropic.ts 的 resolveAnthropicThinking 安全阀会因此把 extended thinking 全程静默关掉。
    // 详见 Log/ARCHITECTURE.md 第四节第 9 条（已固化为 verify-session.ts ⑨ 段断言）。
    const toolMessages: LLMMessage[] = [
      ...systemMessages.map(({ content }) => ({ role: 'system' as const, content })),
      ...history.map((m) => ({ role: m.role as LLMMessage['role'], content: m.content })),
      { role: 'user' as const, content: currentText },
    ];

    // ═══════════════════════════════════════════════════════════════════════════
    // ⑧: Agent Loop —— 委托给 AgentLoop 子系统（LLM 生成 + 工具执行循环）
    // ═══════════════════════════════════════════════════════════════════════════
    // 轮数预算：TASK.md 存在（带计划的复杂任务）时放大轮数，否则用默认预算（防死循环）
    // thinking 自动判定（阶段 C2）：'on' 常开；'auto' 仅当有进行中任务（TASK.md 有未勾选项）时开；'off' 常关。
    // 与清理共享同一信号：loadTaskMemory 对全勾选文件已删除并返回 undefined，僵尸计划不会污染 auto
    const thinkingOn = this.thinkingMode === 'on' || (this.thinkingMode === 'auto' && taskMemory !== undefined);
    const { finalText, usage } = await this.agentLoop.run(toolMessages, onToken, {
      maxTurns: taskMemory ? WITH_PLAN_MAX_TURNS : DEFAULT_MAX_TURNS,
      thinking: thinkingOn,
      model: this.currentModel,
    });
    this.events.emit({ type: 'message_end' });

    // 只传 role + content，不传第三个参数 extra：tool_calls / tool_call_id / name 从未被写进会话文件。
    // 于是 MessageEntry 的结构化字段是“格式支持、入口未接线”，与上面那道丢弃合起来构成双向死路。
    await this.session?.appendMessage('user', currentText);
    await this.session?.appendMessage('assistant', finalText);
    // 用量：优先 API 真值（Agent Loop 已合计各轮），缺失才回退估算——
    // 估算只算 user 输入 + 最终回复，多轮工具循环的中间 assistant/tool 消息、
    // system prompt、工具描述全没算，多轮任务下严重少报
    const u = usage ?? estimateTokenUsage(currentText, finalText);
    this.totalUsage.promptTokens += u.promptTokens;
    this.totalUsage.completionTokens += u.completionTokens;
    this.totalUsage.totalTokens += u.totalTokens;
    this.events.emit({ type: 'usage', current: u, total: { ...this.totalUsage } });
    return finalText;
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
   */
  private async askPermission(toolName: string, detail: string): Promise<'allow' | 'deny' | 'always'> {
    const choice = await promptPermission(toolName, detail);
    // promptPermission 返回 'deny' | 'always' | undefined（undefined=允许本次）
    return choice === 'deny' ? 'deny' : choice === 'always' ? 'always' : 'allow';
  }

  /**
   * LLM 调用失败的兜底处理 —— 询问用户是否切换到兜底模型（OpenCode Go）。
   * 只在 TTY 交互模式下触发。
   */
  private async tryFallbackOnError(error: unknown): Promise<boolean> {
    if (!process.stdin.isTTY) return false;

    const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(`\n  ❌ LLM 调用失败: ${msg}`);

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
      console.log(`  ✅ 已切换到 ${fallbackLabel}，请重试。`);
      return true;
    }

    return false;
  }

  private async tryExecuteCommand(text: string): Promise<string | null> {
    return this.commandSystem.execute(text);
  }
}
