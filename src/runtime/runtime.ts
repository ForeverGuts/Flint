/**
 * Runtime 运行时 —— Agent 运行时的上下文与全局状态管理。
 * 调用方：main.ts（初始化并启动）
 * 服务于：串联 LLM 调用、session 对话、命令注册、input 事件、skill 展开
 */
import type { LLMMessage } from '../llm/types.js';
import type { LLMProvider } from '../llm/types.js';
import type { Diagnostic, RuntimeOptions } from '../types.js';
import { appendFileSync } from 'node:fs';
import { SkillLoader } from './skill.js';
import { PromptEventEmitter } from './events.js';
import { JsonlSessionStorage } from './jsonl-storage.js';
import type { EventHandler, HookHandler } from './events.js';
import { ToolRegistry } from './tool.js';
import { estimateTokenUsage } from './utils.js';
import { PermissionManager } from './permission.js';
import { promptPermission } from '../io/ui/permission.js';
import { selectFromList } from '../io/ui/selector.js';
/* ── 类型定义 ── */

/** 命令处理函数签名 */
export type CommandHandler = (args: string) => string | Promise<string>;

/** 选择器条目（命令系统调 runtime.select 用） */
export type SelectItem = { value: string; label: string; description?: string; disabled?: boolean };

interface RegisteredCommand {
  description: string;
  handler: CommandHandler;
}

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
  private commands = new Map<string, RegisteredCommand>();
  private inputHandlers: InputHandler[] = [];
  private skills: SkillLoader;
  tools = new ToolRegistry();
  permission = new PermissionManager();
  /** 当前模型名（供 /model 命令读写） */
  currentModel: string = '';
  /** 当前 provider 类型（供 /model 命令读写） */
  currentProvider: string = 'deepseek';
  /** 当前 baseUrl（供 /model 命令读写） */
  currentBaseUrl: string = '';
  /** 选择器钩子（TTY 由 TreeUI 注册，管道用默认 selectFromList） */
  private selectHook: ((items: SelectItem[], title?: string) => Promise<string | undefined>) | null = null;
  /** 运行时诊断队列（错误/警告收集，/diagnostics 查询 + debug 落盘） */
  private diagnostics: import('../types.js').Diagnostic[] = [];
  /* ── 事件发射器（组合模式，Runtime 只持自己的事件） ── */

  /** Runtime 运行时事件（stream_text、message_end、agent_end 等） */
  private events = new PromptEventEmitter();

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
    this.llm = options.llm!;
    this.session = options.session;
    this.skills = new SkillLoader('skills');
    this.skills.load();
    if (options.model) this.currentModel = options.model;
    if (options.provider) this.currentProvider = options.provider;
    if (options.baseUrl) this.currentBaseUrl = options.baseUrl;
  }

  /* ── 命令注册 ── */

  registerCommand(name: string, description: string, handler: CommandHandler): void {
    this.commands.set(name, { description, handler });
  }

  listCommands(): Array<{ name: string; description: string }> {
    return [...this.commands.entries()].map(([name, cmd]) => ({ name, description: cmd.description }));
  }

  /** 注册选择器实现（TTY 由 TreeUI 提供组件树选择器，管道用默认） */
  registerSelect(fn: (items: SelectItem[], title?: string) => Promise<string | undefined>): void {
    this.selectHook = fn;
  }

  /** 运行选择器（命令系统调用；TTY 走 TreeUI 组件树，否则用默认 selectFromList） */
  select(items: SelectItem[], title?: string): Promise<string | undefined> {
    if (this.selectHook) return this.selectHook(items, title);
    // 未注册钩子（管道模式）→ 用默认选择器
    return selectFromList(items as any, title);
  }

  /* ── Input 事件 ── */

  onInput(handler: InputHandler): void {
    this.inputHandlers.push(handler);
  }

  /* ── 公开方法 ── */

  async clearSession(): Promise<void> {
    await this.session?.clear();
  }

  /**
   * 获取当前分支上的全部历史消息（含 msgId）。
   * 调用方：/history 命令
   * 服务于：展示会话历史、定位 fork 点
   */
  async getHistoryMessages(): Promise<Array<{ msgId: string; role: string; content: string }>> {
    if (this.session instanceof JsonlSessionStorage) {
      return this.session.getAllStored();
    }
    // 非 JSONL 存储（InMemory/Mock）：从 getMessages 拼装（无 msgId）
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
    if (!(this.session instanceof JsonlSessionStorage)) return '';
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
    if (this.session instanceof JsonlSessionStorage) {
      return this.session.getDir();
    }
    return './sessions';
  }

  /** 当前会话消息数（供 banner 展示，读取当前分支路径长度） */
  async getSessionMsgCount(): Promise<number> {
    if (this.session instanceof JsonlSessionStorage) return this.session.getAllStored().length;
    return (await this.session?.getMessages())?.length ?? 0;
  }

  getSkillLoader(): SkillLoader {
    return this.skills;
  }

  /** 获取历史诊断列表（供 /diagnostics 命令查看、外部导出） */
  getDiagnostics(): Diagnostic[] {
    return [...this.diagnostics];
  }

  /**
   * 记录一条运行时诊断：入队 + emit 事件 + 落盘（debug-runtime.log）。
   * 调用方：runtime 内部错误点（LLM/工具失败）
   * 服务于：结构化收集错误（复用启动检查的 Diagnostic），供查询/展示/回放
   */
  private recordDiagnostic(level: Diagnostic['level'], item: string, message: string): void {
    const diag: Diagnostic = { level, item, message };
    this.diagnostics.push(diag);
    this.events.emit({ type: 'error', level, item, message });
    // 落盘（env TS_AGENT_DEBUG_DIAG=1 时写入 debug-runtime.log，便于回放）
    if (process.env.TS_AGENT_DEBUG_DIAG === '1') {
      try {
        appendFileSync('debug-runtime.log', `${new Date().toISOString()} [${level}] [${item}] ${message}\n`);
      } catch { /* 落盘失败不阻塞 */ }
    }
  }

  /** 获取当前 LLM Provider（用于 /model 命令读取） */
  getLLM(): LLMProvider {
    return this.llm;
  }

  /** 运行时替换 LLM Provider（实现热切换模型） */
  setLLM(provider: LLMProvider): void {
    this.llm = provider;
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
    // ① 扩展命令检查
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

    // ② Input 事件
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

    // ③ Skill/模板展开
    if (currentText.startsWith('/')) {
      currentText = this.expandSkill(currentText);
    }

    // ④ 流式队列检查 —— 外层循环进行中，新消息按 streamingBehavior 分流
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
    // ⑤ 外层循环（仿 Pi runLoop 的 outer loop）：消费 followUp 队列
    //
    //   首条消息 = 用户当前输入；处理完后检查队列：
    //     - 有 followUp → 插入上下文继续处理（等当前回复完全结束后才轮到它）
    //     - 无 followUp → 退出外层循环
    //
    //   内层 = runSingleTurn()（单条消息的 LLM + 工具循环）。
    //   【预留】steering 打断需内层 stream 支持 AbortSignal，暂未接入。
    // ═══════════════════════════════════════════════════════════════════════════
    this.isStreaming = true;
    let finalResult = '';
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
    } finally {
      this.isStreaming = false;
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

    // ⑦: 上下文压缩 —— 历史超限时用 LLM 总结，压缩结果作为 compaction entry 入树
    let history = this.session ? await this.session.getMessages() : [];
    // 只有真正的 JSONL 树存储才有 compaction/getAllMsgIds（InMemory/Mock 走纯文本）
    const jsonlSession = this.session instanceof JsonlSessionStorage ? this.session : undefined;

    // 增量压缩判断：已压缩过的消息 id = 各 compaction entry 的 firstKeptId 之前（历史路径上的）
    // 简化：已压缩消息 = 所有 compaction 出现前的那批；这里用 getAllMsgIds 里在 firstKeptId 之前的消息
    let compressedSummary = '';
    if (jsonlSession) {
      const compactions = jsonlSession.getCompactions();
      if (compactions.length > 0) {
        // 取最后一个 compaction：它之前的消息已被摘要顶替
        const last = compactions[compactions.length - 1];
        compressedSummary = last.summary;
      }
    }

    if (history.length > 20) {
      const allIds: string[] = jsonlSession ? jsonlSession.getAllMsgIds() : [];
      // 已压缩消息 id = 被某个 compaction 覆盖的（firstKeptId 之前）；取最新的 firstKeptId 作为分界
      const compactions = jsonlSession ? jsonlSession.getCompactions() : [];
      // 只压缩尚未压缩过的早期消息（每个 compaction 的 firstKeptId 之前的都算已压缩）
      const summarizedIds = new Set<string>();
      for (const c of compactions) {
        // firstKeptId 之前的所有消息 id 都算已压缩
        const keptIdx = allIds.indexOf(c.firstKeptId);
        if (keptIdx !== -1) {
          for (let i = 0; i < keptIdx; i++) summarizedIds.add(allIds[i]);
        }
      }
      const uncompressedIds = allIds.slice(0, -10).filter((id: string) => !summarizedIds.has(id));
      if (uncompressedIds.length > 0) {
        this.events.emit({ type: 'thinking', phase: 'compressing' });
        const toSummarize = uncompressedIds.map((id: string) => {
          const msg = jsonlSession?.getMsgById(id);
          return msg ? `${msg.role}: ${msg.content.slice(0, 200)}` : '';
        }).filter(Boolean).join('\n');
        try {
          const result = await this.llm.chat([
            { role: 'system', content: '将以下对话压缩为一段摘要（50 字内），保留关键信息。只输出摘要。' },
            { role: 'user', content: toSummarize },
          ]);
          const summary = result.content;
          // 压缩结果作为 compaction entry 入树（firstKeptId = 第一条保留消息）
          const firstKeptId = allIds[allIds.length - 10] ?? allIds[allIds.length - 1] ?? '';
          await jsonlSession?.appendCompaction(summary, firstKeptId);
          compressedSummary = summary;
          history = history.slice(-10);
        } catch {
          history = history.slice(-10);
        }
      }
    }

    if (compressedSummary) {
      history.unshift({ role: 'system' as const, content: `[对话摘要] ${compressedSummary}` });
    }

    // 上下文准备完毕，更新 spinner
    this.events.emit({ type: 'thinking', phase: 'streaming' });

    // ⑧: Agent Loop —— LLM 调用 → Tool 执行 → 循环
    const toolDescriptions = this.tools.getLLMTools().map((t) =>
      `  - ${t.function.name}: ${t.function.description}（参数: ${JSON.stringify(t.function.parameters)}）`
    ).join('\n');

    const toolMessages: LLMMessage[] = [
      { role: 'system' as const, content: `你有以下工具：\n${toolDescriptions}\n\n规则：
【最优先】普通对话、闲聊、提问建议、讨论概念时，直接回答，绝不调用任何工具。
工具只在你明确需要操作文件、执行命令、搜索代码时才调用——用户没明确要求时，禁止调用。
- 需要工具时，通过 tool_calls 结构化调用（工具名 + JSON 参数会自动发给系统执行）
- 工具结果会以 tool 消息返回给你
- 如果任务还没完成（如刚创建完文件需要运行测试），继续调下一个工具
- 全部做完后再给用户最终回答
- ⚠️ 口述"我创建了文件"不等于真的创建了文件，必须调工具才算
- 不要在调工具之前就回复"已创建"——工具没执行，文件不存在` },
      ...history.map((m) => ({ role: m.role as LLMMessage['role'], content: m.content })),
      { role: 'user' as const, content: currentText },
    ];

    // ═══════════════════════════════════════════════════════════════════════════
    // ⑧: Agent Loop —— 单一 stream() 循环（合并文本生成 + 结构化工具调用）
    //
    // 升级说明（function calling）：
    //   旧版从回复文本里抠 <tool_call> 标签 → 脆、空参数、token 浪费。
    //   新版通过 API tools 参数，模型返回结构化 tool_calls（名称+参数由 API 保证）。
    //   stream() 事件：
    //     - token      → 纯文本，推给用户
    //     - tool_call  → 结构化调用，累积后执行
    //     - end        → 流结束（含完整文本）
    //
    //   每轮输出：
    //     ① 有 tool_call → 执行工具 → assistant 的 tool_calls + tool 结果塞回 toolMessages → 下一轮
    //     ② 只有文本     → turnText 就是最终答案，结束
    //     ③ 文本+工具并存 → 文本展示 + 工具执行，下一轮带上工具结果再生成最终答案
    // ═══════════════════════════════════════════════════════════════════════════

    let finalText = '';
    // 注：isStreaming 由外层循环（prompt）管理，这里不设置。
    // 单循环：最多 5 轮，每轮 stream() 一次
    const tools = this.tools.getLLMTools();
    for (let turn = 0; turn < 5; turn++) {
        // ── ① 唯一 LLM 调用：stream() 流式生成 + 收集结构化工具调用 ──
        let turnText = '';
        const turnCalls: import('../llm/types.js').LLMToolCall[] = [];
        try {
          const eventStream = this.llm.stream(toolMessages, tools);
          for await (const event of eventStream) {
            if (event.type === 'token') {
              turnText += event.text;
              onToken?.(event.text);
              this.events.emit({ type: 'stream_text', text: event.text });
            } else if (event.type === 'tool_call') {
              turnCalls.push(...event.toolCalls);
            } else if (event.type === 'end') {
              turnText = event.fullText;
            }
          }
        } catch (err) {
          // 流异常 → 记录诊断 + 询问是否切兜底
          const msg = err instanceof Error ? err.message : String(err);
          this.recordDiagnostic('fail', 'llm', msg.split('\n')[0]);
          const switched = await this.tryFallbackOnError(err);
          if (switched) {
            // 切换后重试本轮
            continue;
          } else {
            finalText = `❌ LLM 调用失败: ${msg}`;
            break;
          }
        }

        // ── ② 无工具调用 → 这就是最终答案 ──
        if (turnCalls.length === 0) {
          finalText = turnText;
          break;
        }

        // ── ③ 有工具调用 → 逐个执行，结果塞回 toolMessages ──
        //     先记录 assistant 的 tool_calls（保持对话一致性），再 push tool 结果
        toolMessages.push({
          role: 'assistant',
          content: turnText,
          tool_calls: turnCalls,
        });
        for (const tc of turnCalls) {
          // 解析结构化参数（API 返回的 JSON 字符串）
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            args = {};
          }
          this.events.emit({ type: 'tool_execution_start', name: tc.function.name, args });
          try {
            // 权限检查
            if (this.tools.requiresPermission(tc.function.name)) {
              const detail = JSON.stringify(args).slice(0, 80);
              if (!this.permission.isAutoAllowed(tc.function.name, detail)) {
                const choice = await promptPermission(tc.function.name, detail);
                if (choice === 'deny') {
                  toolMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: `[工具 ${tc.function.name} 被用户拒绝]` });
                  this.events.emit({ type: 'tool_execution_end', name: tc.function.name, result: '❌ 已拒绝' });
                  continue;
                }
                if (choice === 'always') {
                  this.permission.grantAutoAllow(tc.function.name, detail);
                }
              }
            }
            const result = await this.tools.execute(tc.function.name, args);
            toolMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result });
            this.events.emit({ type: 'tool_execution_end', name: tc.function.name, result });
          } catch (err) {
            toolMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: `[工具 ${tc.function.name} 执行失败]\n${err}` });
            this.recordDiagnostic('fail', 'tool', `工具 ${tc.function.name} 执行失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // ④ 工具执行完 → 进入下一轮 for，stream() 带着工具结果重新生成
      }

      // ⑤ 5 轮内没得到最终回复 → 用最后一次流式文本兜底
      if (!finalText) {
        const last = toolMessages[toolMessages.length - 1];
        finalText = typeof last?.content === 'string' ? last.content : '';
      }

      this.events.emit({ type: 'message_end' });

    await this.session?.appendMessage('user', currentText);
    await this.session?.appendMessage('assistant', finalText);
    // 计算token
    const u = estimateTokenUsage(currentText, finalText);
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
    const spaceIndex = text.indexOf(' ');
    const cmdName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1);
    const cmd = this.commands.get(cmdName);
    if (!cmd) return null;
    return await cmd.handler(args);
  }
}
