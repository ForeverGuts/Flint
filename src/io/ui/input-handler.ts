/**
 * 输入处理器 —— raw mode 逐键解析（自研，替代 pi-tui 的 Input）。
 * 调用方：TreeUI（TTY 模式）
 * 服务于：读取用户输入，区分 Enter（steer）/ Alt+Enter（followUp），
 *         支持退格、普通字符输入；方向键由 SelectList 处理
 *
 * 原理：
 *   - 进入 raw mode（process.stdin.setRawMode(true)），每个按键立即送达
 *   - 逐段解析：普通字符追加到输入行，Enter 提交，\x1b[A/B 等转义交给方向键
 *   - Alt+Enter：\x1b\r（ESC 后跟回车）→ 标记为 followUp
 *   - 括号粘贴（bracketed paste，mode 2004）：终端把粘贴内容包在 \x1b[200~...\x1b[201~ 里，
 *     与 Enter 键明确区分——多行粘贴入缓冲区（换行转空格）而不触发提交，用户按 Enter 才提交；
 *     不支持 2004 的终端降级：含换行的 chunk 内文本先入 buffer 再提交（旧实现会整块丢弃）
 */
import { appendFileSync } from 'node:fs';
/** 提交回调：text = 输入文本, mode = 'enter' | 'alt-enter' */
export type SubmitCallback = (text: string, mode: 'enter' | 'alt-enter') => void;

/** 括号粘贴标记（mode 2004 启用后终端用它包裹粘贴内容） */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export class InputHandler {
  /** 当前输入缓冲区 */
  private buffer = '';
  /** 暂停状态（选择器等组件接管输入时） */
  private paused = false;
  /** 是否已开始监听 */
  private listening = false;
  /** 提交回调（Enter/Alt+Enter 时触发） */
  onSubmit: SubmitCallback | null = null;
  /** 输入变化回调（更新 UI） */
  onChange: (() => void) | null = null;
  /** 转义序列回调（方向键等，由选择器消费） */
  onEscapeSequence: ((seq: string) => void) | null = null;

  /** 获取当前输入文本（供渲染） */
  getText(): string {
    return this.buffer;
  }

  /** 设置输入文本（外部清空/预填） */
  setText(text: string): void {
    this.buffer = text;
  }

  /** 清空转义缓冲（选择器激活前调用，防止 init 期间的残留按键误触发选择器） */
  resetInput(): void {
    this.escapeBuf = '';
  }

  /** 暂停输入（选择器接管时调用，停止消费按键） */
  pause(): void {
    this.paused = true;
  }

  /** 恢复输入 */
  resume(): void {
    this.paused = false;
  }

  /** 开始监听 stdin */
  start(): void {
    if (this.listening) return;
    this.listening = true;
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    // 启用括号粘贴（mode 2004）：Windows Terminal/conpty 支持；
    // 启用后多行粘贴不再与 Enter 键混淆（粘贴内容被 \x1b[200~...\x1b[201~ 包裹）
    process.stdout.write('\x1b[?2004h');
    process.stdin.resume();
    process.stdin.on('data', (chunk: Buffer) => this.handleData(chunk));
  }

  /** 停止监听，恢复终端模式 */
  stop(): void {
    this.listening = false;
    process.stdin.removeAllListeners('data');
    // 关闭括号粘贴（退出后终端恢复常规粘贴行为）
    process.stdout.write('\x1b[?2004l');
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
  }

  /** 选择器按键拦截回调（返回 true 表示消费，不再走内置处理） */
  onSelectKey: ((data: string) => boolean) | null = null;
  /** 退出前清理回调（恢复终端等） */
  onExit: (() => void) | null = null;

  /** 转义序列缓冲（raw mode 下 ↑ 可能是 \x1b + [A 拆包到达） */
  private escapeBuf = '';
  /** 括号粘贴缓冲（粘贴内容跨 chunk 时累积，直到 \x1b[201~ 到达） */
  private pasteBuf: string | null = null;

  /** 调试日志（env TS_AGENT_DEBUG_INPUT=1 时开启，写入 debug-input.log，避免污染 stdout） */
  static debug = !!process.env.TS_AGENT_DEBUG_INPUT;
  private debugLog(msg: string): void {
    if (!InputHandler.debug) return;
    try {
      appendFileSync('debug-input.log', msg + '\n');
    } catch {
      /* ignore */
    }
  }

  /** 处理原始字节（try/catch 包裹：stdin data 回调里的异常 = uncaught = 进程崩溃 UI 僵死，必须就地吃掉） */
  private handleData(chunk: Buffer): void {
    if (this.paused) return;
    let str = chunk.toString('utf-8');
    try {
      // ── 括号粘贴状态机：粘贴内容可能跨 chunk，累积到 \x1b[201~ 出现 ──
      if (this.pasteBuf !== null) {
        const end = str.indexOf(PASTE_END);
        if (end === -1) { this.pasteBuf += str; return; }
        this.pasteBuf += str.slice(0, end);
        this.appendPaste(this.pasteBuf);
        this.pasteBuf = null;
        str = str.slice(end + PASTE_END.length);
        if (!str) return;
      }

      // ── 转义序列缓冲：序列可能拆包到达（\x1b + [A） ──
      if (this.escapeBuf) {
        // 孤立 ESC：累积的是单个 \x1b 且新数据不是 CSI（[）→ 丢弃 ESC，只处理新数据
        // （防止 ESC 残留污染后续普通字符/Enter）
        if (this.escapeBuf === '\x1b' && !str.startsWith('[')) {
          this.escapeBuf = '';
        } else {
          str = this.escapeBuf + str;
          this.escapeBuf = '';
        }
      }

      this.debugLog(`[handleData] raw=${JSON.stringify(str)} | onSelectKey=${this.onSelectKey !== null} | buffer="${this.buffer}"`);

      // 选择器拦截：选择器激活时所有按键先给它，由它决定消费
      if (this.onSelectKey && this.onSelectKey(str)) {
        this.debugLog(`  → 被选择器消费 (${JSON.stringify(str)})`);
        return;
      }

      this.processInput(str);
    } catch (e) {
      // 解析异常只记日志不上抛（防一个怪异字节序列杀死整个进程）
      this.debugLog(`[handleData] 异常已忽略: ${e instanceof Error ? e.stack : String(e)}`);
    }
  }

  /**
   * 解析普通输入（逐段循环）：粘贴标记 / 焦点事件 / Alt+Enter / 转义序列 / 换行 / Ctrl+C / 退格 / 文本。
   * 换行语义（修复旧版"含 \r\n 的 chunk 整块当 Enter、文本被丢弃"的缺陷）：
   *   - 换行前的同 chunk 文本先入 buffer 再提交（文本不再丢）
   *   - 多行内容（无 bracketed 支持终端的粘贴）以空格合并为同一条消息
   *   - 仅当 chunk 以换行结尾才提交（换行在中间且尾部还有文本 → 可能是未完成的粘贴，
   *     留在 buffer 等用户明确按 Enter，宁可不自动提交也不丢/误发内容）
   */
  private processInput(str: string): void {
    const parts: string[] = [];
    let sawNewline = false;
    let altEnter = false;
    // 提交判定：chunk 以换行结尾才是明确的提交信号（尾部还有文本 → 留在 buffer 等 Enter）
    const endsWithNewline = /[\r\n]$/.test(str) || /\x1b[\r\n]+$/.test(str);

    /** 已收集文本段入 buffer：首段直连（快速打字不被空格拆散），后续段以空格分隔（多行粘贴合并） */
    const flushParts = (): void => {
      let first = true;
      for (const p of parts) {
        if (!p) continue;
        if (!first && this.buffer && !this.buffer.endsWith(' ')) this.buffer += ' ';
        this.buffer += p;
        first = false;
      }
      parts.length = 0;
    };

    while (str.length > 0) {
      // 括号粘贴开始：内容作为文本累积，不触发提交（用户按 Enter 明确提交）
      if (str.startsWith(PASTE_START)) {
        const end = str.indexOf(PASTE_END, PASTE_START.length);
        if (end === -1) { flushParts(); this.pasteBuf = str.slice(PASTE_START.length); return; }
        this.appendPaste(str.slice(PASTE_START.length, end));
        str = str.slice(end + PASTE_END.length);
        continue;
      }
      // 焦点事件（终端聚焦/失焦）：静默丢弃，不当作输入
      if (str.startsWith('\x1b[I') || str.startsWith('\x1b[O')) { str = str.slice(3); continue; }
      // Alt+Enter：\x1b\r / \x1b\n（followUp）
      if (str.startsWith('\x1b\r') || str.startsWith('\x1b\n')) {
        str = str.replace(/^\x1b[\r\n]+/, '');
        sawNewline = true;
        altEnter = true;
        continue;
      }
      // 其他转义序列（方向键等）：只消费序列本身，剩余字节继续解析（旧实现会整 chunk 吞掉）
      if (str.startsWith('\x1b')) {
        const seq = this.takeEscapeSeq(str);
        if (seq === null) { flushParts(); this.escapeBuf = str; return; } // 不完整，等下一 chunk
        str = str.slice(seq.length);
        this.debugLog(`  → 转义序列 ${JSON.stringify(seq)}`);
        this.onEscapeSequence?.(seq);
        continue;
      }
      // 换行：提交信号——同 chunk 中换行前的文本先入 buffer（不再丢弃）
      const m = /[\r\n]/.exec(str);
      if (m) {
        if (m.index > 0) parts.push(str.slice(0, m.index));
        sawNewline = true;
        str = str.slice(m.index).replace(/^[\r\n]+/, '');
        continue;
      }
      // Ctrl+C
      if (str[0] === '\x03') {
        this.debugLog('  → Ctrl+C，退出');
        // 先恢复终端（raw mode → 正常模式 + 显示光标），再退出
        if (this.onExit) {
          this.onExit();
        } else {
          if (process.stdin.setRawMode) process.stdin.setRawMode(false);
          process.stdout.write('\x1b[?25h');
        }
        process.exit(0);
        return;
      }
      // 退格：\x7f 或 \x08
      if (str[0] === '\x7f' || str[0] === '\x08') {
        this.debugLog('  → 退格');
        flushParts();
        this.buffer = this.buffer.slice(0, -1);
        this.onChange?.();
        str = str.slice(1);
        continue;
      }
      // 普通文本：整段吃到下一个控制符为止
      const next = /[\r\n\x1b\x03\x7f\x08]/.exec(str);
      parts.push(next ? str.slice(0, next.index) : str);
      str = next ? str.slice(next.index) : '';
    }

    const before = this.buffer;
    flushParts();
    if (sawNewline && (endsWithNewline || altEnter)) {
      this.debugLog(`  → ${altEnter ? 'Alt+Enter' : 'Enter'} 提交 (${JSON.stringify(this.buffer)})`);
      this.submit(altEnter ? 'alt-enter' : 'enter');
    } else if (this.buffer !== before) {
      this.onChange?.();
    }
  }

  /** 括号粘贴内容入 buffer：换行转空格（输入行保持单行渲染），不自动提交 */
  private appendPaste(content: string): void {
    const cleaned = content.replace(/[\r\n]+/g, ' ').trim();
    this.debugLog(`  → 括号粘贴 ${content.length} 字符（换行已转空格）`);
    if (!cleaned) return;
    this.buffer += (this.buffer ? ' ' : '') + cleaned;
    this.onChange?.();
  }

  /**
   * 从 chunk 头部取出一个完整转义序列前缀。
   * CSI 序列：\x1b [ 参数(0-9;?) 最终字节（0x40-0x7e）；非 CSI：\x1b + 单字符。
   * 返回 null = 序列不完整（需等下一 chunk）。
   */
  private takeEscapeSeq(str: string): string | null {
    if (str.length < 2) return null; // 单独的 ESC，等后续
    if (str[1] !== '[') return str.slice(0, 2); // ESC+单字符（如 Alt 组合）
    for (let i = 2; i < str.length; i++) {
      if (!/[0-9;?]/.test(str[i])) return str.slice(0, i + 1); // 遇到最终字节（A/B/C/D/~ 等）
    }
    return null; // 还在参数中
  }

  /** 提交当前输入（空 buffer 的 Enter 完全 no-op，不触发渲染——避免 Windows 一次 Enter 发多个 \r 导致多余重绘） */
  private submit(mode: 'enter' | 'alt-enter'): void {
    const text = this.buffer.trim();
    this.buffer = '';
    if (text) {
      this.onChange?.();
      this.onSubmit?.(text, mode);
    }
  }

  /**
   * TTY 模式读一行（表单输入用）——临时接管 onSubmit/onChange，返回一次 Enter 提交。
   * 调用方：runtime.readLineInput（命令的表单输入）
   * 服务于：绕过 readline 的 lineBuffer 污染（TTY 下 readline 会残留历史输入，readLine 会误返残留值）；
   *         并在表单标签旁的 `> ` 后实时回显输入内容（而非渲染到屏幕底部输入行）
   */
  readLineTTY(promptText?: string): Promise<string> {
    if (promptText !== undefined) process.stdout.write(promptText);
    return new Promise((resolve) => {
      const savedSubmit = this.onSubmit;
      const savedChange = this.onChange;
      this.buffer = '';
      // 表单期间：输入内容回显到 `> ` 提示符后（\r 回行首 + 清行 + 重写）
      this.onChange = () => {
        process.stdout.write(`\r\x1b[2K  > ${this.buffer}`);
      };
      this.onSubmit = (text, _mode) => {
        // 提交：打印完整一行（含输入值）+ 换行
        process.stdout.write(`\r\x1b[2K  > ${text}\n`);
        this.onSubmit = savedSubmit;
        this.onChange = savedChange;
        resolve(text);
      };
    });
  }
}
