/**
 * 输入处理器 —— raw mode 逐键解析（自研，替代 pi-tui 的 Input）。
 * 调用方：TreeUI（TTY 模式）
 * 服务于：读取用户输入，区分 Enter（steer）/ Alt+Enter（followUp），
 *         支持退格、普通字符输入；方向键由 SelectList 处理
 *
 * 原理：
 *   - 进入 raw mode（process.stdin.setRawMode(true)），每个按键立即送达
 *   - 逐字节解析：普通字符追加到输入行，Enter 提交，\x1b[A/B 等转义交给方向键
 *   - Alt+Enter：\x1b\r（ESC 后跟回车）→ 标记为 followUp
 */
import { appendFileSync } from 'node:fs';
/** 提交回调：text = 输入文本, mode = 'enter' | 'alt-enter' */
export type SubmitCallback = (text: string, mode: 'enter' | 'alt-enter') => void;

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
    process.stdin.resume();
    process.stdin.on('data', (chunk: Buffer) => this.handleData(chunk));
  }

  /** 停止监听，恢复终端模式 */
  stop(): void {
    this.listening = false;
    process.stdin.removeAllListeners('data');
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

  /** 处理原始字节 */
  private handleData(chunk: Buffer): void {
    if (this.paused) return;
    let str = chunk.toString('utf-8');
    this.debugLog(`[handleData] raw=${JSON.stringify(str)} | onSelectKey=${this.onSelectKey !== null} | buffer="${this.buffer}"`);

    // ── 转义序列缓冲：累积 \x1b 开头的序列直到完整（CSI 序列以字母结尾） ──
    if (this.escapeBuf) {
      // 孤立 ESC：累积的是单个 \x1b 且新数据不是 CSI（[）→ 丢弃 ESC，只处理新数据
      // （防止 ESC 残留污染后续普通字符/Enter）
      if (this.escapeBuf === '\x1b' && !str.startsWith('[')) {
        this.escapeBuf = '';
      } else {
        this.escapeBuf += str;
        const complete = this.tryCompleteEscape();
        if (!complete) return; // 序列不完整，等下一个 chunk
        str = this.escapeBuf;
        this.escapeBuf = '';
      }
    } else if (str.startsWith('\x1b')) {
      // 新转义序列开始：可能是完整（\x1b[A）或拆包（\x1b + [A）
      this.escapeBuf = str;
      const complete = this.tryCompleteEscape();
      if (!complete) return;
      str = this.escapeBuf;
      this.escapeBuf = '';
    }

    // 选择器拦截：选择器激活时所有按键先给它，由它决定消费
    if (this.onSelectKey && this.onSelectKey(str)) {
      this.debugLog(`  → 被选择器消费 (${JSON.stringify(str)})`);
      return;
    }

    // Alt+Enter：\x1b\r（Windows 下可能带 \n，组合送达）
    if (str === '\x1b\r' || str === '\x1b\n' || str === '\x1b\r\n' || str === '\x1b\n\r') {
      this.debugLog('  → Alt+Enter 提交');
      this.submit('alt-enter');
      return;
    }

    // Enter：含 \r 或 \n 即视为提交（覆盖 \r、\n、\r\n、\n\r 及 Windows 下任意混合分片）
    if (/[\r\n]/.test(str)) {
      this.debugLog(`  → Enter 提交 (${JSON.stringify(str)})`);
      this.submit('enter');
      return;
    }

    // Ctrl+C
    if (str === '\x03') {
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
    if (str === '\x7f' || str === '\x08') {
      this.debugLog(`  → 退格`);
      this.buffer = this.buffer.slice(0, -1);
      this.onChange?.();
      return;
    }

    // 完整转义序列（\x1b[A 等）交给组件处理，不作为文本
    if (str.startsWith('\x1b')) {
      this.debugLog(`  → 未消费转义序列 (${JSON.stringify(str)})`);
      this.onEscapeSequence?.(str);
      return;
    }

    // 普通字符：追加到输入行（剔除残留的换行控制符，防止输入行翻行）
    this.debugLog(`  → 追加 "${str}"`);
    const safe = str.replace(/[\r\n]/g, '');
    if (safe) {
      this.buffer += safe;
      this.onChange?.();
    }
  }

  /**
   * 尝试完成当前转义缓冲序列。
   * CSI 序列：\x1b [ 参数? 最终字节，最终字节是 0x40-0x7e 的字母/符号。
   * 返回 true 表示序列完整。
   */
  private tryCompleteEscape(): boolean {
    const buf = this.escapeBuf;
    if (buf.length === 0) return false;
    if (buf === '\x1b') return false; // 单独的 ESC，等后续

    // 检查：\x1b 后是否已有完整 CSI（\x1b[ ... 最终字节）
    if (buf[1] === '[') {
      // 从第 3 个字符开始，找到非参数（非 0-9;?）的最终字节
      for (let i = 2; i < buf.length; i++) {
        const ch = buf[i];
        if (!/[0-9;?]/.test(ch)) {
          // 遇到最终字节（A/B/C/D 等）→ 序列完整
          return true;
        }
      }
      return false; // 还在参数中
    }

    // 非 CSI 的 ESC 序列（如 \x1b 单键）——完整
    return true;
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
   * TTY 模式读一行（表单输入用）——临时接管 onSubmit，返回一次 Enter 提交。
   * 调用方：runtime.readLineInput（命令的表单输入）
   * 服务于：绕过 readline 的 lineBuffer 污染（TTY 下 readline 会残留历史输入，readLine 会误返残留值）
   */
  readLineTTY(promptText?: string): Promise<string> {
    if (promptText !== undefined) process.stdout.write(promptText);
    return new Promise((resolve) => {
      const saved = this.onSubmit;
      this.onSubmit = (text, _mode) => {
        this.onSubmit = saved;
        resolve(text);
      };
    });
  }
}
