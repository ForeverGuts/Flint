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
import { renderTaskPanel } from './task-panel.js';
import { taskStore } from '../../todo/store.js';

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

/** header 命令提示清单（按框内宽折行成多行，见 buildHeader） */
const CMD_HINTS = [
  '/help', '/exit', '/clear', '/model', '/edit_model',
  '/usage', '/history', '/sessions', '/diagnostics', '/tasks',
];

/**
 * 消息框（YOU / FLINT）边框总宽（列）——随终端宽度自适应。
 * 顶行 = 2空格 + ┌──(3) + 标签 + ─×N + ┐(1) → N = 宽 - 6 - 标签长
 * 底行 = 2空格 + └(1) + ─×M + ┘(1)          → M = 宽 - 4
 *
 * 夹逼区间：窄终端保底 50 列（不塌成窄条），宽终端封顶 110 列
 * （行长超过 ~110 列后眼球回扫成本陡增，“占满屏幕”反而难读）。
 */
const BOX_MIN_WIDTH = 50;
const BOX_MAX_WIDTH = 110;
/** 框体左右留白（2 空格缩进 + 2 列安全边距） */
const BOX_MARGIN = 4;

/** 当前终端下消息框应使用的总宽（建框时取，窗口变化后新建的框自动跟随） */
function boxWidth(): number {
  const cols = process.stdout.columns ?? 80;
  const want = Math.max(BOX_MIN_WIDTH, Math.min(BOX_MAX_WIDTH, cols - BOX_MARGIN));
  return Math.min(want, cols); // 极窄终端：不让框超出可见列
}

/** 框内每行文本最大可见宽度（= 边框宽 - 4 空格缩进 - 1 安全边距，防顶到边框） */
function boxInnerWidth(w: number): number {
  return w - 4 - 1;
}

/** 由 baseUrl 推断供应商显示名（header Backend 行用） */
function backendName(baseUrl: string): string {
  return baseUrl.includes('opencode') ? 'OpenCode Go'
    : baseUrl.includes('deepseek') ? 'DeepSeek'
    : baseUrl.includes('127.0.0.1') ? 'CC Switch'
    : baseUrl || 'local';
}

/** thinking 事件的阶段名 → 用户可读的等待提示（回答前静默期的进度信号） */
function phaseHint(phase: string): string {
  switch (phase) {
    case 'analyzing': return '⏳ 分析中…';
    case 'compressing': return '⏳ 压缩历史上下文…';
    case 'calling_tools': return '🔧 执行工具中…';
    case 'streaming': return '⏳ 等待模型响应…';
    default: return '⏳ 处理中…';
  }
}

/** 思考动画帧（盲文点阵旋转，经典终端 spinner） */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** 动态安抚文案（每 3 秒轮换一条，让等待期"看起来有事在发生"） */
const THINK_COMFORTS = ['正在梳理思路', '正在整理上下文', '正在推演步骤', '正在考虑多种可能', '正在组织表达', '正在复核细节'];

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
  /**
   * 常驻任务面板（输入框正上方）。**空清单时不渲染任何行**——容器没子组件就不占地方，
   * 这是"全部完成后立即收起"的实现方式。内容由 `refreshTaskPanel()` 每帧重建。
   */
  private taskBox = new Container();
  /** 任务面板的退订函数（stop 时调用，防监听器泄漏） */
  private unsubscribeTask: (() => void) | null = null;
  /** 技能热重载的退订函数（stop 时调用，防监听器泄漏） */
  private unsubscribeSkills: (() => void) | null = null;
  /** 等待状态行（回答前的阶段提示：分析/压缩/等待响应/推理中；空文本时不占行） */
  private statusHint = new Text('');
  /** banner 诊断区（可回填：后台网络探测完成后追加结果，启动提速第一档） */
  private diagBox = new Container();
  /** 网络探测占位行（探测中显示，结果到达后移除） */
  private probeHint: Text | null = null;

  /* ── 回合指示器：从按下 Enter 到 agent_end 全程不黑屏（等待期 + 流式期都有进度信号） ── */
  /** 动画定时器（250ms 一跳：旋转帧 + 秒数 + 安抚文案轮换） */
  private animTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前等待段起点（流式进行中为 null——此时指示器挂在回复框开口底边上） */
  private waitStartAt: number | null = null;
  /** 本回合累计等待时长（工具轮多段累加，endReply 后清零） */
  private waitAccumMs = 0;
  /** 最近一次结算的等待秒数（供💭/⏳摘要展示） */
  private lastWaitSeconds = 0;
  /** 当前等待标签（阶段名或"推理中"，动画帧拼接用） */
  private thinkLabel = '';
  /** 动画帧计数器 */
  private spinTick = 0;
  /** 最近一次动画帧（updateLiveTail 刷新底边时复用，不让帧跳变） */
  private spinFrame = SPINNER_FRAMES[0];
  /** 当前流式框的首字时刻（"正在输出… N 秒" 的计时起点；无流式框时为 null） */
  private streamStartAt: number | null = null;
  /** header 中 Backend 行（切换供应商后实时刷新，buildHeader 中赋值） */
  private headerBackend!: Text;
  /** header 中 Model 行（切换模型后实时刷新，buildHeader 中赋值） */
  private headerModel!: Text;

  constructor(
    private runtime: import('../../runtime/runtime.js').Runtime,
    private info: TreeUIInfo,
    /** 后台网络探测（启动提速第一档）：界面先行，结果回填 diagBox */
    private probePromise?: Promise<import('../../types.js').Diagnostic[]>,
  ) {
    // ── 组件树组装 ──
    this.inputLine = new Text('');
    this.root.addChild(this.buildHeader());
    this.root.addChild(this.chat);
    this.root.addChild(this.selectBox);   // 选择器容器常驻（空时不渲染）
    this.root.addChild(this.statusHint);  // 等待状态行（常驻，空文本不渲染）
    this.root.addChild(this.taskBox);     // 任务面板（常驻，空清单不渲染）
    this.root.addChild(this.inputLine);
  }

  /**
   * 重建任务面板内容（每帧调用，见 requestRender）。
   *
   * 为什么每次**清空重建**而不是复用 Text 组件逐行 setText：项数会变（add/clear），
   * 复用就得自己管"多出来的行删掉、少的补上"，容易残留脏行。整框重建则天然对齐当前状态，
   * 而屏幕差分由 `Screen.render()` 兜着——只有真的变了的行才会被重写。
   */
  private refreshTaskPanel(): void {
    this.taskBox.clear();
    const width = process.stdout.columns ?? 80;
    for (const line of renderTaskPanel(taskStore.list(), width)) {
      this.taskBox.addChild(new Text(line));
    }
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

    // 清残留转义缓冲：防止 init 耗时期间用户按的键在选择器激活后误触发
    this.input.resetInput();
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
    // 清残留转义缓冲（同上）
    this.input.resetInput();
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
    box.addChild(new Text(`  ${C.bgGreen}${C.bold}   ◆  Flint v0.1.0  ◆   ${C.reset}`));
    box.addChild(this.headerBackend);
    box.addChild(this.headerModel);
    box.addChild(new Text(`  ${C.dim}${pad('Mode')}${C.reset}   ${C.bold}REPL${C.reset}  │  ${C.dim}tools${C.reset} ${this.info.toolCount}  ${C.dim}skills${C.reset} ${this.info.skillCount}  ${C.dim}cmds${C.reset} ${this.info.cmdCount}`));
    box.addChild(new Text(`  ${C.dim}${pad('Session')}${C.reset}   ${C.bold}${this.info.sessionMsgs}${C.reset} msgs  │  ${C.dim}${dateStr} ${timeStr}${C.reset}`));
    box.addChild(new Text(`  ${C.dim}${pad('Runtime')}${C.reset}   Node${process.version}  ·  ${platform}  ·  ${C.dim}${cwd}${C.reset}`));
    box.addChild(new Text(`  ${C.green}${'─'.repeat(boxWidth() - 2)}${C.reset}`));
    // 启动自检诊断：诊断区用常驻容器（本地检查结果立即填入；后台网络探测完成后回填，见 start）
    box.addChild(this.diagBox);
    const diags = this.info.diagnostics ?? [];
    for (const d of diags) {
      this.diagBox.addChild(this.diagLine(d));
    }
    if (this.probePromise) {
      // 网络探测后台化：先占位一行，结果到达后替换（界面先行，检查后台化）
      this.probeHint = new Text(`  ${C.dim}⏳ 网络自检进行中…${C.reset}`);
      this.diagBox.addChild(this.probeHint);
    }
    // 命令提示按分隔符贪心折行：旧实现拼成单行共 110 列，80 列终端下被 fitWidth
    // 静默截到 /history 为止，/sessions 与 /diagnostics 用户根本看不到
    const hintRoom = boxInnerWidth(boxWidth()) - 2; // 再减行首 2 空格缩进
    let hintLine = '';
    for (const cmd of CMD_HINTS) {
      const next = hintLine ? `${hintLine}  ·  ${cmd}` : cmd;
      if (hintLine && visibleWidth(next) > hintRoom) {
        box.addChild(new Text(`  ${C.dim}${C.italic}  ${hintLine}${C.reset}`));
        hintLine = cmd;
      } else {
        hintLine = next;
      }
    }
    if (hintLine) box.addChild(new Text(`  ${C.dim}${C.italic}  ${hintLine}${C.reset}`));
    box.addChild(new Text(`  ${C.green}${'─'.repeat(boxWidth() - 2)}${C.reset}`));
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
    // 注册 TTY 读行钩子（表单输入走 InputHandler，绕过 readline 的 lineBuffer 污染）
    this.runtime.registerReadLine((promptText) => this.input.readLineTTY(promptText));

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

    // 订阅任务清单变更 —— 这根线是任务面板存在的理由：
    // `todo` 工具改的是内存里的 TaskStore，它不经过事件总线（也没有事件可发），
    // 没有这个订阅，模型勾完一项屏幕上是不会动的。
    this.unsubscribeTask = taskStore.onChange(() => this.requestRender());

    // 订阅技能热重载 —— 与任务面板同一根通知线范式：文件变了 → SkillLoader 内存清单刷新，
    // 提示词层下一轮自愈（每轮 build 现取 getAll()），这根线只负责"让你看见它变了"。
    this.unsubscribeSkills = this.runtime.getSkillLoader().onChange((change) => {
      this.diagBox.addChild(this.skillChangeLine(change));
      this.requestRender();
    });

    // 后台网络探测（启动提速第一档）：订阅完成后才挂 then——
    // 结果永远不会早于订阅到达（时序上杜绝竞态）；异常静默（占位行由 catch 分支清理）
    if (this.probePromise) {
      void this.probePromise
        .then((diags) => this.applyProbeResult(diags))
        .catch(() => this.applyProbeResult([]));
    }
  }

  /** 单条诊断渲染（✅ pass / ⚠️ warn / ❌ fail） */
  private diagLine(d: import('../../types.js').Diagnostic): Text {
    const icon = d.level === 'fail' ? C.red + '❌' : d.level === 'warn' ? C.yellow + '⚠️' : C.green + '✅';
    return new Text(`  ${icon}${C.reset} ${C.dim}[${d.item}]${C.reset} ${d.message}`);
  }

  /** 技能热更新提示行（🔄 + 增删差 + 当前总数；纯增删都无时是"内容更新"；有技能失去依赖时追加 ⚠ 提示） */
  private skillChangeLine(change: import('../../runtime/skill.js').SkillChange): Text {
    const parts: string[] = [];
    if (change.added.length > 0) parts.push(`+${change.added.join(' +')}`);
    if (change.removed.length > 0) parts.push(`-${change.removed.join(' -')}`);
    const diff = parts.length > 0 ? `（${parts.join(' ')}）` : '（内容更新）';
    const broken = change.broken.length > 0 ? `，⚠ ${change.broken.join('、')} 失去依赖` : '';
    return new Text(`  ${C.dim}🔄 技能已热更新${diff}，当前 ${change.result.skills.length} 个${broken}${C.reset}`);
  }

  /** 后台探测结果回填：移除占位行，追加结果行（失败/断网时是 warn 行，同样如实展示） */
  private applyProbeResult(diags: import('../../types.js').Diagnostic[]): void {
    if (this.probeHint) {
      this.diagBox.removeChild(this.probeHint);
      this.probeHint = null;
    }
    for (const d of diags) {
      this.diagBox.addChild(this.diagLine(d));
    }
    this.requestRender();
  }

  /** 停止 UI，恢复终端 */
  stop(): void {
    this.input.stop();
    if (this.animTimer) { clearInterval(this.animTimer); this.animTimer = null; }
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; }
    this.screen.clear();
    process.stdout.write('\x1b[?25h');
    if (this.unsubscribeTask) { this.unsubscribeTask(); this.unsubscribeTask = null; }
    if (this.unsubscribeSkills) { this.unsubscribeSkills(); this.unsubscribeSkills = null; }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /* ── 回合指示器（等待计时 + 动态安抚 + 流式进度） ── */

  /**
   * 点亮等待指示器（幂等：已在等待则只由调用方换标签）。
   * 调用方：onSubmit（按下 Enter 即点亮）、thinking / stream_reasoning / 工具事件
   */
  private startWaitClock(): void {
    if (this.waitStartAt === null) this.waitStartAt = Date.now();
    if (!this.animTimer) {
      this.animTimer = setInterval(() => this.animTick(), 250);
    }
    this.animTick();
  }

  /**
   * 动画一跳（4 次/秒重绘，差分渲染代价可控）。指示器位置随阶段迁移：
   *   等待期 → 底部状态行（首字前静默 / 工具执行 / 工具后的下一次 LLM 调用）
   *   流式期 → 回复框的开口底边（“正在输出”，回答还在长）
   */
  private animTick(): void {
    const frame = SPINNER_FRAMES[this.spinTick++ % SPINNER_FRAMES.length];
    this.spinFrame = frame;
    if (this.liveBox && this.liveFoot) {
      this.liveFoot.setText(this.liveFootText(frame));
    } else {
      const secs = Math.floor(this.waitElapsedMs() / 1000);
      const comfort = THINK_COMFORTS[Math.floor(secs / 3) % THINK_COMFORTS.length];
      this.statusHint.setText(`    ${C.dim}${frame} ${this.thinkLabel} ${secs} 秒 · ${comfort}${C.reset}`);
    }
    this.requestRender();
  }

  /** 开口底边文案（animTick 与 updateLiveTail 共用） */
  private liveFootText(frame: string): string {
    const secs = this.streamStartAt !== null ? Math.floor((Date.now() - this.streamStartAt) / 1000) : 0;
    return `  ${C.dim}${frame} 正在输出… ${secs} 秒 · 已收 ${this.currentReply.length} 字${C.reset}`;
  }

  /** 结算当前等待段（并入累计 + 存秒数供摘要），不停表——回合还没结束 */
  private settleWait(): void {
    if (this.waitStartAt !== null) {
      this.waitAccumMs += Date.now() - this.waitStartAt;
      this.waitStartAt = null;
    }
    this.lastWaitSeconds = Math.round(this.waitAccumMs / 1000);
  }

  /** 等待已流逝毫秒（累计段 + 进行中的段） */
  private waitElapsedMs(): number {
    return this.waitAccumMs + (this.waitStartAt !== null ? Date.now() - this.waitStartAt : 0);
  }

  /** 回合收尾：结算 + 停表 + 清状态行（幂等，重复调用安全） */
  private stopTurnClock(): void {
    this.settleWait();
    if (this.animTimer) { clearInterval(this.animTimer); this.animTimer = null; }
    this.statusHint.setText('');
    this.streamStartAt = null;
  }

  /** 请求重绘 */
  private requestRender(): void {
    // 实时刷新 header（切换供应商/模型后 banner 保持一致）
    this.refreshHeader();
    // 任务面板每帧从 taskStore 重建（不依赖通知也能自愈；onChange 只负责"变了立刻画一次"）
    this.refreshTaskPanel();
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
    // 回合指示器立刻点亮（不等 thinking 事件）：从按下 Enter 到回复结束，等待期全程有进度信号
    this.waitAccumMs = 0;
    this.lastWaitSeconds = 0;
    this.thinkLabel = '⏳ 已发送，等待模型响应…';
    this.startWaitClock();
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
    const w = boxWidth();
    const box = new Container();
    box.addChild(new Text(`  ${C.blue}┌──${C.reset}${C.bold}${C.blue}${label}${C.reset}${C.blue}${'─'.repeat(w - 6 - label.length)}┐${C.reset}`));
    // 长输入按框内宽折行，每行统一 4 空格缩进，保证都在边框内
    for (const line of wrapText(text, boxInnerWidth(w))) {
      box.addChild(new Text(`    ${C.brightWhite}${line}${C.reset}`));
    }
    box.addChild(new Text(`  ${C.blue}└${'─'.repeat(w - 4)}┘${C.reset}`));
    this.chat.addChild(box);
  }

  /** 处理 runtime 事件 */
  private handleEvent(event: any): void {
    switch (event.type) {
      case 'thinking': {
        // 阶段状态行（等待可视化 + 动态安抚）：计时已由 onSubmit 点亮，这里只换文案。
        // 若上一段正文已成型（steering / followUp 插入新回合），先封口再回到等待指示——
        // 否则开口底边会一直显示"正在输出"，而实际上模型正在重新思考
        this.thinkLabel = phaseHint(event.phase);
        this.finalizeLiveBox();
        this.startWaitClock();
        break;
      }

      case 'stream_text': {
        // 渐进流式（杠杆①体验配套）：首片懒创建"半成品回复框"（顶边框 + 开口底边"正在输出…"），
        // 后续按 80ms 节流刷新尾部文本；agent_end 时就地封口成完整框。
        // Screen 差分渲染 + 节流 → 既有打字机观感又不刷屏。
        this.currentReply += event.text;
        if (!this.liveBox) {
          // 首字到达：结算"首字前等待"（供💭/⏳摘要），指示器从底部状态行移交回复框开口底边
          this.settleWait();
          this.statusHint.setText('');
          this.openLiveBox();
        }
        this.updateLiveTail();
        this.scheduleLiveRender();
        break;
      }

      case 'stream_reasoning': {
        // 推理分片到达：标签升级为"推理中"（比阶段名更具体），计时继续（不重启）
        this.thinkLabel = '🧠 推理中…';
        if (!this.liveBox) this.startWaitClock();
        // 思维链推理片段（阶段 C1）：只累计字数，不存内容——
        // 摘要以一行灰色呈现（展示不持久，避免几千 token 灌屏）
        this.reasoningLength += event.text.length;
        break;
      }

      case 'tool_execution_start': {
        // 工具轮：先给流式中的半成品框封口（防孤儿框挂在消息区末尾）——
        // 本轮回复仍会随 agent_end 走 endReply 出完整框（历史行为不变）
        this.finalizeLiveBox();
        // 工具执行期同样点亮指示器：长耗时工具（读大文件/网络）不再是一段黑屏
        this.thinkLabel = `🔧 执行 ${event.name} 中…`;
        this.startWaitClock();
        const argsStr = event.args ? JSON.stringify(event.args) : '';
        const w = boxWidth();
        this.toolBoxWidth = w;  // 顶边在此画、底边在 tool_execution_end 画，必须同宽
        const box = new Container();
        // 顶部框线与正常回复框同宽对齐
        box.addChild(new Text(`  ${C.yellow}┌──${C.reset}${C.bold}${C.yellow}${event.name.toUpperCase()}${C.reset}${C.yellow}${'─'.repeat(w - 6 - event.name.length)}┐${C.reset}`));
        if (argsStr) {
          // 参数按框内宽折行 + 统一 4 空格缩进（最多 3 行）
          for (const line of wrapText(argsStr, boxInnerWidth(w)).slice(0, 3)) {
            box.addChild(new Text(`    ${C.dim}${line}${C.reset}`));
          }
        }
        this.chat.addChild(box);
        break;
      }

      case 'tool_execution_end': {
        const resultStr = typeof event.result === 'string' ? event.result : String(event.result);
        // 成败由生产端直接给（ok 字段）：过去只能拿结果文本做子串猜测
        // （includes('✅') / includes('失败')）——工具正常输出里出现"失败"两个字就会被误判成红框
        const color = event.ok ? C.green : C.red;
        const w = this.toolBoxWidth;
        const box = new Container();
        // 结果按框内宽折行 + 统一 4 空格缩进（最多 8 行，超长提示截断）
        const resultLines = wrapText(resultStr, boxInnerWidth(w));
        const MAX_LINES = 8;
        for (const line of resultLines.slice(0, MAX_LINES)) {
          box.addChild(new Text(`    ${color}${line}${C.reset}`));
        }
        if (resultLines.length > MAX_LINES) {
          box.addChild(new Text(`    ${C.dim}… 输出过长，已截断（共 ${resultLines.length} 行）${C.reset}`));
        }
        box.addChild(new Text(`  ${C.yellow}└${'─'.repeat(w - 4)}┘${C.reset}`));
        this.chat.addChild(box);
        // 工具结束 → 下一次 LLM 调用的等待期（这段过去完全无提示，是"中途长时间黑屏"的主因）
        this.thinkLabel = '⏳ 等待模型响应…';
        this.startWaitClock();
        break;
      }

      case 'agent_end': {
        // 回合收尾：停表清状态行 + 流式框就地封口（无正文时也要收，防定时器泄漏）
        this.stopTurnClock();
        this.endReply();
        this.requestRender();
        break;
      }

      case 'usage': {
        this.lastUsage = `⚡ ${event.current.totalTokens} tokens  · 累计 ${event.total.totalTokens}`;
        break;
      }

      /* ── 骨架 span：实测账（耗时/首字延迟/调用次数由生产端算好再报） ──
       * UI 过去只能自己掐表估等待时长，而那四个秒表字段量的是"用户感知的等待"，
       * 与这里的"一次请求到底花了多久"是两回事：前者靠本地定时器逐秒跳（事件给不了），
       * 后者只能在段收束那一刻结算。两者共存，各管一段。 */

      case 'prompt_start': {
        // 新一条请求：清上一回合的统计（否则次数与耗时会跳回合累加）
        this.llmCalls = 0;
        this.llmMsTotal = 0;
        this.firstTokenMs = null;
        this.lastLLMStat = null;
        break;
      }

      case 'llm_request_end': {
        this.llmCalls++;
        this.llmMsTotal += typeof event.durationMs === 'number' ? event.durationMs : 0;
        // 首字延迟只取本回合第一次调用的（那才是用户真正等的第一下）
        if (this.firstTokenMs === null && typeof event.firstTokenMs === 'number') {
          this.firstTokenMs = event.firstTokenMs;
        }
        break;
      }

      case 'prompt_end': {
        // 全程耗时：含模型往返 + 工具执行 + 压缩，是用户真正等了的那段
        const parts = [`⏱ 全程 ${(Number(event.durationMs ?? 0) / 1000).toFixed(1)}s`];
        if (this.llmCalls > 0) parts.push(`模型 ${this.llmCalls} 次/${(this.llmMsTotal / 1000).toFixed(1)}s`);
        if (this.firstTokenMs !== null) parts.push(`首字 ${(this.firstTokenMs / 1000).toFixed(1)}s`);
        this.lastLLMStat = parts.join(' · ');
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
  /** 本轮思维链推理累计字数（阶段 C1，仅计数不存内容；endReply 后清零） */
  private reasoningLength = 0;
  /** 待展示 usage */
  private lastUsage: string | null = null;
  /** 待展示的实测账（prompt_end 结算；与 lastUsage 同时挂到框底下方） */
  private lastLLMStat: string | null = null;
  /** 本回合模型往返次数（llm_request_end 累计） */
  private llmCalls = 0;
  /** 本回合模型往返耗时总和（毫秒；不含工具与压缩） */
  private llmMsTotal = 0;
  /** 本回合首次调用的首字延迟（TTFT，毫秒） */
  private firstTokenMs: number | null = null;

  /* ── 渐进流式（流式回复框）：组件常驻 chat 尾部，随 token 可变；封口后字段置空 ── */
  /** 流式中的半成品回复框（顶边框 + 正文 + 开口底边） */
  private liveBox: Container | null = null;
  /** liveBox 的尾部文本组件（随累积文本整段重写） */
  private liveTail: Text | null = null;
  /** liveBox 的开口底边（流式中显示"正在输出…"，封口时整行换成 └──┘） */
  private liveFoot: Text | null = null;
  /** liveBox 建框时的总宽（跨渲染保持一致，窗口中途变化也不错位） */
  private liveBoxWidth = BOX_MIN_WIDTH;
  /** liveBox 是否已展示过摘要行（💭/⏳，防封口时重复） */
  private liveSummaryShown = false;
  /** 工具框建框时的总宽（start 画顶边、end 画底边，必须同宽） */
  private toolBoxWidth = BOX_MIN_WIDTH;
  /** 流式渲染节流定时器（80ms，防每 token 全屏重绘） */
  private liveTimer: ReturnType<typeof setTimeout> | null = null;

  /** 打开流式回复框：顶边框 + 摘要行（若已可结算）+ 可变正文 + 开口底边，挂入 chat */
  private openLiveBox(): void {
    const label = ' FLINT ';
    const w = boxWidth();
    const box = new Container();
    box.addChild(new Text(`  ${C.green}┌──${C.reset}${C.bold}${C.green}${label}${C.reset}${C.green}${'─'.repeat(w - 6 - label.length)}┐${C.reset}`));
    this.liveSummaryShown = false;
    if (this.reasoningLength > 0) {
      // 推理摘要随流式框提前亮相（首片正文到达时思考已结束，等待秒数已结算可一并展示）
      box.addChild(this.summaryLine(this.reasoningLength, this.lastWaitSeconds));
      this.liveSummaryShown = true;
    } else if (this.lastWaitSeconds >= 3) {
      // 无推理分片但等待较久（网络延迟主导）：也给出耗时，让长等待可感知而非黑箱
      box.addChild(new Text(`    ${C.dim}⏳ 用时 ${this.lastWaitSeconds} 秒${C.reset}`));
      this.liveSummaryShown = true;
    }
    this.liveTail = new Text('');
    box.addChild(this.liveTail);
    // 开口底边：流式期间一直显示"正在输出"，回复结束才换成 └──┘（进度承诺可见）
    this.liveFoot = new Text('');
    box.addChild(this.liveFoot);
    this.liveBox = box;
    this.liveBoxWidth = w;
    this.streamStartAt = Date.now();
    this.chat.addChild(box);
    this.animTick(); // 立即填一次底边文案，不等 250ms 首跳
  }

  /** 💭 思维链摘要行（思考字数 + 首字前等待秒数） */
  private summaryLine(reasoningLen: number, waitSecs: number): Text {
    return new Text(`    ${C.dim}💭 思考了 ${reasoningLen} 字${waitSecs > 0 ? ` · 用时 ${waitSecs} 秒` : ''}${C.reset}`);
  }

  /** 刷新尾部文本：已完成行 + 进行中的半行（字级推进观感），折行与最终框一致 */
  private updateLiveTail(): void {
    if (!this.liveTail) return;
    const lines = wrapText(this.currentReply, boxInnerWidth(this.liveBoxWidth));
    this.liveTail.setText(lines.map((l) => `    ${l}${C.reset}`).join('\n'));
    // 字数跟着 token 走，不等 250ms 动画跳——否则底边报的字数会落后于可见正文
    if (this.liveFoot) this.liveFoot.setText(this.liveFootText(this.spinFrame));
  }

  /** 节流重绘：80ms 内多个 token 合并成一次渲染 */
  private scheduleLiveRender(): void {
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      if (this.liveBox) {
        this.updateLiveTail();
        this.requestRender();
      }
    }, 80);
  }

  /** 封口流式框（工具/新回合打断）：取消节流定时器，开口底边换成 └──┘，置空字段；
   *  已封文本同步从累积器截断——后续轮次的新文本另起新框，同轮内容不重复 */
  private finalizeLiveBox(): void {
    if (!this.liveBox) return;
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; }
    this.updateLiveTail();
    this.sealLiveBox();
    this.currentReply = '';
  }

  /** 就地封口：开口底边整行换成 └──┘，再挂 usage——框"长成"完整框，不重建（无整框跳变） */
  private sealLiveBox(): void {
    const box = this.liveBox;
    if (!box) return;
    if (this.liveFoot) {
      box.removeChild(this.liveFoot);
      this.liveFoot = null;
    }
    box.addChild(new Text(`  ${C.green}└${'─'.repeat(this.liveBoxWidth - 4)}┘${C.reset}`));
    if (this.lastUsage) {
      box.addChild(new Text(`    ${C.dim}${this.lastUsage}${C.reset}`));
      this.lastUsage = null;
    }
    if (this.lastLLMStat) {
      box.addChild(new Text(`    ${C.dim}${this.lastLLMStat}${C.reset}`));
      this.lastLLMStat = null;
    }
    this.liveBox = null;
    this.liveTail = null;
    this.streamStartAt = null;
  }

  /** 结束回复：流式框就地封口（无框时补建完整框）+ usage */
  private endReply(): void {
    const reasoningLen = this.reasoningLength;
    this.reasoningLength = 0;
    // 回合计时消费后清零（下一轮重新累计）
    this.stopTurnClock();
    const waitSecs = this.lastWaitSeconds;
    this.lastWaitSeconds = 0;
    this.waitAccumMs = 0;

    // ── ① 已有流式框：就地封口（顶边框/正文原地保留，开口底边换成 └──┘）──
    if (this.liveBox) {
      if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; }
      this.updateLiveTail();
      if (!this.liveSummaryShown) {
        // 摘要在开框后才凑齐（推理晚到 / 等待跨了工具轮）：补挂到正文之前，
        // 保持"先思考后回答"的阅读顺序
        if (reasoningLen > 0) {
          this.liveBox.insertChild(this.summaryLine(reasoningLen, waitSecs), 1);
        } else if (waitSecs >= 3) {
          this.liveBox.insertChild(new Text(`    ${C.dim}⏳ 用时 ${waitSecs} 秒${C.reset}`), 1);
        }
      }
      this.sealLiveBox();
      this.currentReply = '';
      return;
    }

    // ── ② 无流式框（命令输出 / 兜底错误 / 无正文）：补建完整框 ──
    if (!this.currentReply && !this.lastUsage && !this.lastLLMStat) {
      this.lastUsage = null;
      return;
    }
    const label = ' FLINT ';
    const w = boxWidth();
    const box = new Container();
    box.addChild(new Text(`  ${C.green}┌──${C.reset}${C.bold}${C.green}${label}${C.reset}${C.green}${'─'.repeat(w - 6 - label.length)}┐${C.reset}`));
    if (reasoningLen > 0) {
      // 思维链摘要：只告诉用户"想过多久"，不倾倒推理全文（全文已由 stream 层丢弃）
      box.addChild(this.summaryLine(reasoningLen, waitSecs));
    } else if (waitSecs >= 3) {
      // 无推理分片但等待较久（网络延迟主导）：也给出耗时，让长等待可感知而非黑箱
      box.addChild(new Text(`    ${C.dim}⏳ 用时 ${waitSecs} 秒${C.reset}`));
    }
    if (this.currentReply) {
      // 长回复按框内宽折行，每行统一 4 空格缩进，保证都在边框内
      for (const line of wrapText(this.currentReply, boxInnerWidth(w))) {
        box.addChild(new Text(`    ${line}${C.reset}`));
      }
    }
    box.addChild(new Text(`  ${C.green}└${'─'.repeat(w - 4)}┘${C.reset}`));
    if (this.lastUsage) {
      box.addChild(new Text(`    ${C.dim}${this.lastUsage}${C.reset}`));
      this.lastUsage = null;
    }
    if (this.lastLLMStat) {
      box.addChild(new Text(`    ${C.dim}${this.lastLLMStat}${C.reset}`));
      this.lastLLMStat = null;
    }
    this.chat.addChild(box);
    this.currentReply = '';
  }
}
