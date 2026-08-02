/**
 * Screen —— 轻量差分渲染器（自研，方案 2 核心）。
 * 调用方：TreeUI（TTY 模式）
 * 服务于：把组件树渲染出的行数组差分写入终端，根除空白/错位
 *
 * 设计原则（避开 pi-tui 在 Windows 的兼容坑）：
 *   - 不用同步输出（\x1b[?2026h）：Windows 老终端不支持
 *   - 不用全屏清屏（\x1b[2J）：会闪烁 + 依赖终端宽度
 *   - 不用 cellSize 查询（\x1b[16t）：会触发 DA1 响应乱码
 *   - 只用：清行（\x1b[2K）+ 光标相对移动（\x1b[{n}A/B）→ Windows 可靠支持
 *
 * 原理：
 *   ① 保存上次渲染的行数组快照 previousLines
 *   ② 新渲染时对比新旧行数组，找第一个变化行
 *   ③ 光标回退到变化行，逐行重写（每行先 \x1b[2K 清空）
 *   ④ 若新内容比旧内容短，清掉多余行
 *   ⑤ 更新快照
 *
 * 前提：调用方保证每行宽度不超过终端（fitWidth），
 *       且行数变化是"追加"（消息区增长），不会从中间删行。
 */
export class Screen {
  /** 上次渲染的行数组快照 */
  private previousLines: string[] = [];
  /** 光标当前所在的行（0 基，相对内容顶部） */
  private cursorLine = 0;

  /**
   * 渲染新行数组（差分更新）。
   * @param newLines 组件树渲染出的完整行数组
   */
  render(newLines: string[]): void {
    // ── ① 找第一个变化行 ──
    let firstDiff = -1;
    const maxLen = Math.max(this.previousLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (this.previousLines[i] !== newLines[i]) {
        firstDiff = i;
        break;
      }
    }

    // 完全一致 → 无需重绘
    if (firstDiff === -1) {
      this.cursorLine = Math.max(0, newLines.length - 1);
      return;
    }

    // ── ② 定位到变化行 ──
    // 光标当前在 cursorLine，目标是 firstDiff
    const diff = firstDiff - this.cursorLine;
    let out = '';
    if (diff > 0) {
      out += `\x1b[${diff}B`; // 下移
    } else if (diff < 0) {
      out += `\x1b[${-diff}A`; // 上移
    }

    // ── ③ 重写从 firstDiff 到末尾的所有行 ──
    for (let i = firstDiff; i < maxLen; i++) {
      if (i > firstDiff) {
        // 后续行：换行到下一行
        out += '\r\n';
      } else {
        // 首个变化行：回到行首（不换行）
        out += '\r';
      }
      // 清行 + 写内容（旧内容较长时清行覆盖）
      if (i < newLines.length) {
        out += '\x1b[2K' + newLines[i];
      } else {
        // 新内容没有这一行（旧内容多余）→ 只清行
        out += '\x1b[2K';
      }
    }

    // ── ④ 写回终端 ──
    process.stdout.write(out);

    // ── ⑤ 更新状态 ──
    this.previousLines = [...newLines];
    this.cursorLine = Math.max(0, newLines.length - 1);
  }

  /**
   * 清空整个已渲染区域（退出时调用）。
   * 逐行清空，从内容末尾回退到顶部。
   */
  clear(): void {
    if (this.previousLines.length === 0) return;
    // 光标已停在最后一行，回退到顶部逐行清空
    process.stdout.write(`\x1b[${this.previousLines.length - 1}A`);
    for (let i = 0; i < this.previousLines.length; i++) {
      process.stdout.write('\r\x1b[2K');
      if (i < this.previousLines.length - 1) process.stdout.write('\n');
    }
    this.previousLines = [];
    this.cursorLine = 0;
  }

  /** 获取当前渲染的行数（供调试/测试） */
  getLineCount(): number {
    return this.previousLines.length;
  }
}
