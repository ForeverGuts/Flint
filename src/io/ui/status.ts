/**
 * 状态指示器 —— 用于等待时的动画效果（spinner、进度提示等）。
 * 调用方：ui/index.ts（在 LLM 响应期间使用）
 * 服务于：提升用户体验，避免"卡住了"的错觉
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL = 120;

export class StatusIndicator {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;

  /** 启动旋转指示器 */
  start(text: string): void {
    this.stop();
    process.stdout.write(`  ${SPINNER_FRAMES[0]} ${text}`);
    this.interval = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      process.stdout.write(`\r  ${SPINNER_FRAMES[this.frameIndex]} ${text}`);
    }, SPINNER_INTERVAL);
  }

  /** 更新旋转时的文本 */
  update(text: string): void {
    if (this.interval) {
      process.stdout.write(`\r  ${SPINNER_FRAMES[this.frameIndex]} ${text}`);
    }
  }

  /** 停止旋转，清除 spinner 行 */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stdout.write('\r\x1b[K'); // 清除当前行
    }
  }
}
