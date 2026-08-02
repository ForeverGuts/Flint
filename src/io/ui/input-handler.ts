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

  /** 处理原始字节 */
  private handleData(chunk: Buffer): void {
    if (this.paused) return;
    const str = chunk.toString('utf-8');

    // Alt+Enter：\x1b\r
    if (str === '\x1b\r' || str === '\x1b\n') {
      this.submit('alt-enter');
      return;
    }

    // Enter：\r 或 \n
    if (str === '\r' || str === '\n') {
      this.submit('enter');
      return;
    }

    // Ctrl+C
    if (str === '\x03') {
      process.exit(0);
      return;
    }

    // 退格：\x7f 或 \x08
    if (str === '\x7f' || str === '\x08') {
      this.buffer = this.buffer.slice(0, -1);
      this.onChange?.();
      return;
    }

    // 方向键等转义序列（\x1b[...）交给组件处理，不作为文本
    if (str.startsWith('\x1b')) {
      this.onEscapeSequence?.(str);
      return;
    }

    // 普通字符：追加到输入行
    this.buffer += str;
    this.onChange?.();
  }

  /** 提交当前输入 */
  private submit(mode: 'enter' | 'alt-enter'): void {
    const text = this.buffer.trim();
    this.buffer = '';
    this.onChange?.();
    if (text && this.onSubmit) {
      this.onSubmit(text, mode);
    }
  }
}
