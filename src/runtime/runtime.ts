/**
 * Runtime 运行时 —— Agent 运行时的上下文与全局状态管理。
 * 调用方：main.ts（初始化并启动）
 * 服务于：串联 LLM 调用、session 对话、命令注册、input 事件、skill 展开
 */
import type { LLMMessage } from '../llm/types.js';
import type { LLMProvider } from '../llm/types.js';
import type { RuntimeOptions } from '../types.js';
import { SkillLoader } from './skill.js';
import { PromptEventEmitter } from './events.js';
import { JsonlSessionStorage } from './jsonl-storage.js';
import type { EventHandler, HookHandler } from './events.js';
import { ToolRegistry } from './tool.js';
import { parseToolCalls, estimateTokenUsage } from './utils.js';
import { PermissionManager } from './permission.js';
import { promptPermission } from '../io/ui/permission.js';
import { selectFromList } from '../io/ui/selector.js';
/* ── 类型定义 ── */

/** 命令处理函数签名 */
export type CommandHandler = (args: string) => string | Promise<string>;

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

  /* ── 流式队列 ── */

  /** 当前是否正在生成回复 */
  private isStreaming = false;

  /** 待处理的 followUp 队列（当前 LLM 输出完成后逐个处理） */
  private followUpQueue: string[] = [];

  /** 累计 token 用量 */
  totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  // TODO: steer 队列 + AbortSignal 打断
  //   steer 需要中断正在进行的 LLM 流：
  //   1. llm.stream() 接受 AbortSignal
  //   2. queueSteer 时触发 abort，停止当前流
  //   3. 立即用新消息重新进入 prompt 循环
  //   private steerQueue: string[] = [];

  /** 发送一条 followUp 消息到队列中 */
  private queueFollowUp(text: string): void {
    this.followUpQueue.push(text);
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

  /* ── Input 事件 ── */

  onInput(handler: InputHandler): void {
    this.inputHandlers.push(handler);
  }

  /* ── 公开方法 ── */

  async clearSession(): Promise<void> {
    await this.session?.clear();
  }

  getSkillLoader(): SkillLoader {
    return this.skills;
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

  async prompt(input: string, onToken?: (chunk: string) => void): Promise<string> {
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

    // ④ 流式队列检查
    if (this.isStreaming) {
      this.queueFollowUp(currentText);
      if (onToken) onToken('（消息已排队，等当前回复完成后处理）');
      return '（已排队）';
    }

    // ⑤ 发射 thinking 事件（告诉 UI 开始旋转）
    this.events.emit({ type: 'thinking', phase: 'analyzing' });

    // ⑥ TODO: 刷新待处理消息
    // ⑥ TODO: 模型 + Auth 验证
    // ⑦: 上下文压缩 —— 历史超限时用 LLM 总结，记录被压缩的消息 ID
    let history = this.session ? await this.session.getMessages() : [];
    let compressedSummary = '';
    let summaryIds: string[] = [];
    const jsonlSession = this.session as JsonlSessionStorage | undefined;
    const summaryPath = jsonlSession?.getFilePath()?.replace('.jsonl', '_summary.jsonl');

    if (summaryPath) {
      const { readFileSync, existsSync } = await import('node:fs');
      if (existsSync(summaryPath)) {
        try {
          const data = JSON.parse(readFileSync(summaryPath, 'utf-8'));
          compressedSummary = data.text;
          summaryIds = data.ids ?? [];
        } catch { /* 摘要文件损坏忽略 */ }
      }
    }

    if (history.length > 20) {
      const allIds: string[] = jsonlSession?.getAllMsgIds() ?? [];
      // 只压缩尚未压缩过的消息（增量压缩）
      const uncompressedIds = allIds.slice(0, -10).filter((id: string) => !summaryIds.includes(id));
      if (uncompressedIds.length > 0) {
        this.events.emit({ type: 'thinking', phase: 'compressing' });
        const toSummarize = uncompressedIds.map((id: string) => {
          const msg = jsonlSession?.getMsgById(id);
          return msg ? `${msg.role}: ${msg.content.slice(0, 200)}` : '';
        }).filter(Boolean).join('\n');
        try {
          const summary = await this.llm.chat([
            { role: 'system', content: '将以下对话压缩为一段摘要（50 字内），保留关键信息。只输出摘要。' },
            { role: 'user', content: toSummarize },
          ]);
          const { writeFileSync } = await import('node:fs');
          // 合并新旧 ID，写入摘要文件
          const mergedIds = [...summaryIds, ...uncompressedIds];
          writeFileSync(summaryPath!, JSON.stringify({ ids: mergedIds, text: summary }), 'utf-8');
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

    // ⑧: Agent Loop —— 用 chat 检测工具调用，循环执行，全部完成后流式输出
    let finalText = '';
    const toolMessages: LLMMessage[] = [
      { role: 'system' as const, content: `你有以下工具：\n${toolDescriptions}\n\n规则：
- 需要操作文件/执行命令时，用 <tool_call>{"name":"工具名","arguments":{...}}</tool_call>
- 工具结果会返回给你
- 如果任务还没完成（如刚创建完文件需要运行测试），继续调下一个工具
- 全部做完后再给用户最终回答
- 普通对话不需要调工具
- ⚠️ 口述"我创建了文件"不等于真的创建了文件，必须调工具才算
- 不要在调工具之前就回复"已创建"——工具没执行，文件不存在` },
      ...history.map((m) => ({ role: m.role as LLMMessage['role'], content: m.content })),
      { role: 'user' as const, content: currentText },
    ];

    // 工具循环：允许 LLM 连续操作（写文件 → 编译 → 运行等），不超过 5 轮
    for (let turn = 0; turn < 5; turn++) {
      // LLM 调用 + 兜底：失败时询问是否切换
      let reply: string;
      try {
        reply = await this.llm.chat(toolMessages);
      } catch (err) {
        this.events.emit({ type: 'error', message: String(err) });
        const switched = await this.tryFallbackOnError(err);
        if (switched) {
          reply = await this.llm.chat(toolMessages);
        } else {
          finalText = `❌ LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
      }
      const tcs = parseToolCalls(reply);
      if (tcs.length === 0) { finalText = reply; break; }
      for (const tc of tcs) {
        this.events.emit({ type: 'tool_execution_start', name: tc.name, args: tc.args });
        try {
          // 权限检查：根据工具定义的 requirePermission 决定是否需要确认
          if (this.tools.requiresPermission(tc.name)) {         
            const detail = JSON.stringify(tc.args).slice(0, 80);
            if (!this.permission.isAutoAllowed(tc.name, detail)) {
              const choice = await promptPermission(tc.name, detail);
              if (choice === 'deny') {
                toolMessages.push({ role: 'user', content: `[工具 ${tc.name} 被用户拒绝]` });
                this.events.emit({ type: 'tool_execution_end', name: tc.name, result: '❌ 已拒绝' });
                continue;
              }
              if (choice === 'always') {
                this.permission.grantAutoAllow(tc.name, detail);
              }
            }
          }
          const result = await this.tools.execute(tc.name, tc.args);
          toolMessages.push({ role: 'user', content: `[工具 ${tc.name} 执行结果]\n${result}\n（工具已完成，请直接回复用户，不要再调用工具）` });
          this.events.emit({ type: 'tool_execution_end', name: tc.name, result });
        } catch (err) {
          toolMessages.push({ role: 'user', content: `[工具 ${tc.name} 执行失败]\n${err}` });
          this.events.emit({ type: 'error', message: String(err) });
        }
      }
    }
    // 最终回复：先流式输出，结束后再检查新的工具调用
    this.isStreaming = true;
    try {
      // 收集流式文本
      const eventStream = this.llm.stream(toolMessages);
      let full = '';
      for await (const event of eventStream) {
        if (event.type === 'token') {
          full += event.text;
          onToken?.(event.text);
          this.events.emit({ type: 'stream_text', text: event.text });
        } else if (event.type === 'end') {
          full = event.fullText;
        }
      }
      // 流式结束后检查是否有工具调用（LLM 可能在回复中要求继续操作）
      const moreCalls = parseToolCalls(full);
      if (moreCalls.length > 0) {
        // 有工具调用，追加到 toolMessages 并重新进入工具循环
        for (const tc of moreCalls) {
          this.events.emit({ type: 'tool_execution_start', name: tc.name, args: tc.args });
          if (this.tools.requiresPermission(tc.name)) {
            const detail = JSON.stringify(tc.args).slice(0, 80);
            if (!this.permission.isAutoAllowed(tc.name, detail)) {
              const choice = await promptPermission(tc.name, detail);
              if (choice === 'deny') {
                toolMessages.push({ role: 'user', content: `[工具 ${tc.name} 被用户拒绝]` });
                this.events.emit({ type: 'tool_execution_end', name: tc.name, result: '❌ 拒绝' });
                continue;
              }
              if (choice === 'always') this.permission.grantAutoAllow(tc.name, detail);
            }
          }
          try {
            const result = await this.tools.execute(tc.name, tc.args);
            toolMessages.push({ role: 'user', content: `[工具 ${tc.name} 执行结果]\n${result}` });
            this.events.emit({ type: 'tool_execution_end', name: tc.name, result });
          } catch (err) {
            toolMessages.push({ role: 'user', content: `[工具 ${tc.name} 执行失败]\n${err}` });
            this.events.emit({ type: 'error', message: String(err) });
          }
        }
        // 工具执行完后，再调一次 LLM 生成最终回答
        let followUp: string;
        try {
          followUp = await this.llm.chat(toolMessages);
        } catch (err) {
          const switched = await this.tryFallbackOnError(err);
          followUp = switched ? await this.llm.chat(toolMessages) : '';
        }
        full = followUp || full;
        if (onToken) { for (const c of full) { onToken(c); this.events.emit({ type: 'stream_text', text: c }); } }
        else { this.events.emit({ type: 'stream_text', text: full }); }
      }
      finalText = full;
      this.events.emit({ type: 'message_end' });
    } finally {
      this.isStreaming = false;
      this.events.emit({ type: 'agent_end' });
    }
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

    const { getProviderRegistry } = await import('../runtime/provider-registry.js');
    const { createProvider } = await import('../llm/index.js');
    const registry = await getProviderRegistry();
    const fallback = registry.getFallback();

    if (!fallback) return false;

    const fallbackLabel = `${fallback.provider.name} (${fallback.provider.models.find(m => m.id === fallback.modelId)?.label ?? fallback.modelId})`;
    const choice = await selectFromList(
      [
        { value: 'switch', label: `切换到 ${fallbackLabel}` },
        { value: 'no', label: '不切换，直接退出' },
      ],
      '❌ LLM 调用失败，是否切换兜底模型？',
    );

    if (choice === 'switch') {
      const p = fallback.provider;
      const newProvider = createProvider({
        provider: p.type,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: fallback.modelId,
      });
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
