/**
 * TreeUI —— 自研组件树 UI（方案 2 重构产物）。
 * 调用方：main.ts（TTY 模式）
 * 服务于：用自研组件树 + Screen 差分渲染替代"事件广播 + 硬编码 print"
 *
 * 组件树：
 *   root（Container，整屏）
 *     ├─ header（状态栏：backend/model/mode/session/runtime）
 *     ├─ chat（消息区：用户输入 / AI 回复 / 工具执行）
 *     └─ inputLine（输入行文本）
 *
 * 渲染原理：
 *   - 所有内容声明成树，递归 render(width) → 完整行数组
 *   - Screen.render() 差分写入（只重画变化行，不用同步输出/全屏清屏）
 *   - 事件 handler 不碰 stdout，只更新组件数据 + requestRender()
 *
 * 输入：InputHandler raw mode 逐键解析，Enter → steer，Alt+Enter → followUp
 */
import { Container, Text, SelectList } from './components.js';
import { Screen } from './screen.js';
import { InputHandler } from './input-handler.js';
import { fitWidth, visibleWidth, wrapText } from './fit-width.js';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  brightWhite: '\x1b[97m',
  bgGreen: '\x1b[42m',
};

/** header 标签列固定宽度（保证各行对齐） */
const pad = (s: string) => s.padEnd(14);

/**
 * 消息框（YOU / TS AGENT）边框总宽（列）。
 * 顶行 = 2空格 + ┌──(3) + 标签 + ─×N + ┐(1) → N = BOX_WIDTH - 6 - 标签长
 * 底行 = 2空格 + └(1) + ─×M + ┘(1)          → M = BOX_WIDTH - 4
 */
const BOX_WIDTH = 50;
/** 框内每行文本最大可见宽度（= 边框宽 - 4 空格缩进 - 1 安全边距，防顶到边框） */
const BOX_INNER_WIDTH = BOX_WIDTH - 4 - 1;

/** 由 baseUrl 推断供应商显示名（header Backend 行用） */
function backendName(baseUrl: string): string {
  return baseUrl.includes('opencode') ? 'OpenCode Go'
    : baseUrl.includes('deepseek') ? 'DeepSeek'
    : baseUrl.includes('127.0.0.1') ? 'CC Switch'
    : baseUrl || 'local';
}

/** 界面信息 */
export interface TreeUIInfo {
  model: string;
  baseUrl: string;
  sessionMsgs: number;
  toolCount: number;
  cmdCount: number;
  skillCount: number;
  /** 启动自检诊断（可靠性工程），有 warn/fail 时在 banner 下方展示 */
  diagnostics?: import('../../types.js').Diagnostic[];
}

export class TreeUI {
  private screen = new Screen();
  private input = new InputHandler();
  /** 心跳定时器（保持事件循环活跃） */
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** 组件树：根容器 */
  private root = new Container();
  /** 消息区容器（追加文本） */
  private chat = new Container();
  /** 选择器容器（激活时注入组件树，结束后移除） */
  private selectBox = new Container();
  /** 输入行文本组件 */
  private inputLine: Text;
  /** header 中 Backend 行（切换供应商后实时刷新，buildHeader 中赋值） */
  private headerBackend!: Text;
  /** header 中 Model 行（切换模型后实时刷新，buildHeader 中赋值） */
  private headerModel!: Text;

  constructor(
    private runtime: import('../../runtime/runtime.js').Runtime,
    private info: TreeUIInfo,
  ) {
    // ── 组件树组装 ──
    this.inputLine = new Text('');
    this.root.addChild(this.buildHeader());
    this.root.addChild(this.chat);
    this.root.addChild(this.selectBox);   // 选择器容器常驻（空时不渲染）
    this.root.addChild(this.inputLine);
  }

  /**
   * 运行选择器（组件树集成）。
   * 调用方：runtime.select（由命令系统经 registerSelect 调用）
   * 原理：
   *   ① SelectList 加入 selectBox（常驻组件树，空时不渲染）
   *   ② 暂停输入，转发所有按键给 SelectList
   *   ③ Enter 确认 / Ctrl+C 取消 → 清空 selectBox，恢复输入，resolve
   *   finally 确保即使异常也恢复输入，不残留 onSelectKey
   */
  showSelect(
    items: Array<{ value: string; label: string; description?: string; disabled?: boolean }>,
    title?: string,
  ): Promise<string | undefined> {
    // 创建选择器组件
    const list = new SelectList(items, title, 8);
    this.selectBox.clear();
    this.selectBox.addChild(list);

    // 注意：不调用 input.pause()！onSelectKey 拦截已足够（返回 true 消费所有按键）。
    // 若 pause，handleData 开头 return，onSelectKey 收不到按键。
    this.input.onSelectKey = null;

    return new Promise((resolve) => {
      // 转发按键给选择器
      this.input.onSelectKey = (data) => {
        const result = list.handleInput(data);
        if (result.changed) {
          this.requestRender();
        }
        if (result.done !== undefined) {
          // 选择完成：清理 + 恢复输入 + resolve（单选模式 done 只可能是 string）
          this.finishSelect(resolve, result.done === 'cancel' || Array.isArray(result.done) ? undefined : result.done);
        }
        // 消费所有按键（方向键/Enter/Ctrl+C 都不走普通输入）
        return true;
      };

      // 立即渲染（显示选择器）
      this.requestRender();
    });
  }

  /**
   * 多选选择器（Space 勾选，Enter 确认返回勾选集）。
   * 调用方：runtime.selectMulti（命令系统）
   * 服务于：批量选择场景（如多选会话删除）
   */
  showMultiSelect(
    items: Array<{ value: string; label: string; description?: string; disabled?: boolean; selected?: boolean; group?: string }>,
    title?: string,
  ): Promise<string[] | undefined> {
    // 创建多选选择器
    const list = new SelectList(items, title, 8, true);
    this.selectBox.clear();
    this.selectBox.addChild(list);
    this.input.onSelectKey = null;

    return new Promise((resolve) => {
      this.input.onSelectKey = (data) => {
        const result = list.handleInput(data);
        if (result.changed) {
          this.requestRender();
        }
        if (result.done !== undefined) {
          this.input.onSelectKey = null;
          this.selectBox.clear();
          process.stdin.resume();
          this.requestRender();
          resolve(result.done === 'cancel' ? undefined : (result.done as string[]));
        }
        return true;
      };
      this.requestRender();
    });
  }

  /** 结束选择器：清理拦截、清空 selectBox */
  private finishSelect(resolve: (v: string | undefined) => void, result: string | undefined): void {
    this.input.onSelectKey = null;
    this.selectBox.clear();
    // 防御：选择器期间 readline 可能因 Ctrl+C 暂停过 stdin，恢复流动
    process.stdin.resume();
    this.requestRender();
    resolve(result);
  }

  /** 构建 header 组件（Backend/Model 行存引用，切换后由 refreshHeader 更新） */
  private buildHeader(): Container {
    const box = new Container();
    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
    const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : 'macOS';
    const cwd = process.cwd().split(/[/\\]/).pop() || '';

    this.headerBackend = new Text('');
    this.headerModel = new Text('');
    box.addChild(new Text(`  ${C.bgGreen}${C.bold}   ◆  Ts Agent v0.1.0  ◆   ${C.reset}`));
    box.addChild(this.headerBackend);
    box.addChild(this.headerModel);
    box.addChild(new Text(`  ${C.dim}${pad('Mode')}${C.reset}   ${C.bold}REPL${C.reset}  │  ${C.dim}tools${C.reset} ${this.info.toolCount}  ${C.dim}skills${C.reset} ${this.info.skillCount}  ${C.dim}cmds${C.reset} ${this.info.cmdCount}`));
    box.addChild(new Text(`  ${C.dim}${pad('Session')}${C.reset}   ${C.bold}${this.info.sessionMsgs}${C.reset} msgs  │  ${C.dim}${dateStr} ${timeStr}${C.reset}`));
    box.addChild(new Text(`  ${C.dim}${pad('Runtime')}${C.reset}   Node${process.version}  ·  ${platform}  ·  ${C.dim}${cwd}${C.reset}`));
    box.addChild(new Text(`  ${C.green}${'─'.repeat(48)}${C.reset}`));
    // 启动自检诊断：有 warn/fail 才展示（全 pass 不打扰）
    const warns = this.info.diagnostics?.filter((d) => d.level !== 'pass') ?? [];
    for (const d of warns) {
      const icon = d.level === 'fail' ? C.red + '❌' : C.yellow + '⚠️';
      box.addChild(new Text(`  ${icon}${C.reset} ${C.dim}[${d.item}]${C.reset} ${d.message}`));
    }
    box.addChild(new Text(`  ${C.dim}${C.italic}  /help  ·  /exit  ·  /clear  ·  /model  ·  /usage${C.reset}`));
    box.addChild(new Text(`  ${C.green}${'─'.repeat(48)}${C.reset}`));
    this.refreshHeader();
    return box;
  }

  /**
   * 刷新 header 的 Backend/Model 行（每次渲染前调用）。
   * 切换供应商/模型后，runtime.currentProvider/currentModel 已更新，
   * 这里从 runtime 读实时值，让 banner 与真实加载的模型保持一致。
   */
  private refreshHeader(): void {
    const baseUrl = this.runtime.currentBaseUrl || this.info.baseUrl;
    this.headerBackend.setText(`  ${C.dim}${pad('Backend')}${C.reset}   ${backendName(baseUrl)}`);
    const model = this.runtime.currentModel || this.info.model;
    this.headerModel.setText(`  ${C.dim}${pad('Model')}${C.reset}   ${C.bold}${model}${C.reset}`);
  }

  /** 启动 UI */
  start(): void {
    // 注册选择器钩子（命令系统调 runtime.select 时走组件树选择器）
    this.runtime.registerSelect((items, title) => this.showSelect(items, title));
    // 注册多选选择器钩子
    this.runtime.registerMultiSelect((items, title) => this.showMultiSelect(items, title));

    // 首次渲染
    this.requestRender();

    // 输入处理
    this.input.onChange = () => this.requestRender();
    this.input.onSubmit = (text: string, mode: 'enter' | 'alt-enter') => this.onSubmit(text, mode);
    this.input.onExit = () => this.stop();  // Ctrl+C 退出前恢复终端
    this.input.start();

    // 保持事件循环活跃（防止 Windows 下取消选择后事件循环空导致退出）
    this.heartbeat = setInterval(() => {}, 1000);

    // 订阅 runtime 事件
    this.runtime.subscribe((event: any) => {
      this.handleEvent(event);
    });
  }

  /** 停止 UI，恢复终端 */
  stop(): void {
    this.input.stop();
    this.screen.clear();
    process.stdout.write('\x1b[?25h');
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** 请求重绘 */
  private requestRender(): void {
    // 实时刷新 header（切换供应商/模型后 banner 保持一致）
    this.refreshHeader();
    // 更新输入行显示
    const inputText = this.input.getText();
    const promptStr = `  > ${inputText}${C.reset}`;
    this.inputLine.setText(promptStr);
    const width = process.stdout.columns ?? 80;
    const lines = this.root.render(width);
    // 输入行是最后一行：光标定位到输入文本末尾（按可见宽度，跳过 ANSI/中文按2列）
    // 让用户输入时字符落在提示符之后，而不是行首
    const maxLineWidth = Math.max(1, width - 1);
    const shown = fitWidth(promptStr, maxLineWidth);
    const cursorCol = visibleWidth(shown);
    this.screen.render(lines, cursorCol);
  }

  /** 输入提交 */
  private onSubmit(text: string, mode: 'enter' | 'alt-enter'): void {
    if (text === '/exit') {
      this.stop();
      process.exit(0);
    }
    // 追加用户消息框
    this.appendUserBox(text);
    this.requestRender();
    // 普通 Enter → steer，Alt+Enter → followUp
    void this.runtime.prompt(text, undefined, mode === 'alt-enter' ? 'followUp' : 'steer').then(() => {
      this.requestRender();
    }).catch((err) => {
      // 命令/对话异常不应导致进程退出，展示错误后继续
      this.currentReply = `❌ ${err instanceof Error ? err.message : String(err)}`;
      this.endReply();
      this.requestRender();
    });
  }

  /** 追加用户消息框 */
  private appendUserBox(text: string): void {
    const label = ' YOU ';
    const box = new Container();
    box.addChild(new Text(`  ${C.blue}┌──${C.reset}${C.bold}${C.blue}${label}${C.reset}${C.blue}${'─'.repeat(BOX_WIDTH - 6 - label.length)}┐${C.reset}`));
    // 长输入按框内宽折行，每行统一 4 空格缩进，保证都在边框内
    for (const line of wrapText(text, BOX_INNER_WIDTH)) {
      box.addChild(new Text(`    ${C.brightWhite}${line}${C.reset}`));
    }
    box.addChild(new Text(`  ${C.blue}└${'─'.repeat(BOX_WIDTH - 4)}┘${C.reset}`));
    this.chat.addChild(box);
  }

  /** 处理 runtime 事件 */
  private handleEvent(event: any): void {
    switch (event.type) {
      case 'stream_text': {
        // 累积到回复文本（后续在 agent_end 统一渲染）
        this.currentReply += event.text;
        break;
      }

      case 'tool_execution_start': {
        const argsStr = event.args ? JSON.stringify(event.args) : '';
        const box = new Container();
        // 顶部框线与正常回复框同一 BOX_WIDTH 对齐
        box.addChild(new Text(`  ${C.yellow}┌──${C.reset}${C.bold}${C.yellow}${event.name.toUpperCase()}${C.reset}${C.yellow}${'─'.repeat(BOX_WIDTH - 6 - event.name.length)}┐${C.reset}`));
        if (argsStr) {
          // 参数按框内宽折行 + 统一 4 空格缩进（最多 3 行）
          for (const line of wrapText(argsStr, BOX_INNER_WIDTH).slice(0, 3)) {
            box.addChild(new Text(`    ${C.dim}${line}${C.reset}`));
          }
        }
        this.chat.addChild(box);
        break;
      }

      case 'tool_execution_end': {
        const resultStr = typeof event.result === 'string' ? event.result : String(event.result);
        const isOk = resultStr.includes('✅') || resultStr.includes('[OK]');
        const isErr = resultStr.includes('❌') || resultStr.includes('失败') || resultStr.includes('[ERROR]');
        const color = isErr ? C.red : isOk ? C.green : C.dim;
        const box = new Container();
        // 结果按框内宽折行 + 统一 4 空格缩进（最多 8 行，超长提示截断）
        const resultLines = wrapText(resultStr, BOX_INNER_WIDTH);
        const MAX_LINES = 8;
        for (const line of resultLines.slice(0, MAX_LINES)) {
          box.addChild(new Text(`    ${color}${line}${C.reset}`));
        }
        if (resultLines.length > MAX_LINES) {
          box.addChild(new Text(`    ${C.dim}… 输出过长，已截断（共 ${resultLines.length} 行）${C.reset}`));
        }
        box.addChild(new Text(`  ${C.yellow}└${'─'.repeat(BOX_WIDTH - 4)}┘${C.reset}`));
        this.chat.addChild(box);
        break;
      }

      case 'agent_end': {
        // 渲染累积的回复文本 + usage
        this.endReply();
        this.requestRender();
        break;
      }

      case 'usage': {
        this.lastUsage = `⚡ ${event.current.totalTokens} tokens  · 累计 ${event.total.totalTokens}`;
        break;
      }

      case 'error': {
        // 按级别着色：fail 红 / warn 黄（默认红）
        const isWarn = event.level === 'warn';
        const icon = isWarn ? '⚠️' : '❌';
        const color = isWarn ? C.yellow : C.red;
        const tag = event.item ? ` [${event.item}]` : '';
        const box = new Container();
        box.addChild(new Text(`  ${color}${icon}${tag} ${event.message}${C.reset}`));
        this.chat.addChild(box);
        break;
      }
    }
    this.requestRender();
  }

  /** 当前回复累积文本 */
  private currentReply = '';
  /** 待展示 usage */
  private lastUsage: string | null = null;

  /** 结束回复，追加回复框 + usage */
  private endReply(): void {
    if (!this.currentReply && !this.lastUsage) return;
    const label = ' TS AGENT ';
    const box = new Container();
    box.addChild(new Text(`  ${C.green}┌──${C.reset}${C.bold}${C.green}${label}${C.reset}${C.green}${'─'.repeat(BOX_WIDTH - 6 - label.length)}┐${C.reset}`));
    if (this.currentReply) {
      // 长回复按框内宽折行，每行统一 4 空格缩进，保证都在边框内
      for (const line of wrapText(this.currentReply, BOX_INNER_WIDTH)) {
        box.addChild(new Text(`    ${line}${C.reset}`));
      }
    }
    box.addChild(new Text(`  ${C.green}└${'─'.repeat(BOX_WIDTH - 4)}┘${C.reset}`));
    if (this.lastUsage) {
      box.addChild(new Text(`    ${C.dim}${this.lastUsage}${C.reset}`));
      this.lastUsage = null;
    }
    this.chat.addChild(box);
    this.currentReply = '';
  }
}
