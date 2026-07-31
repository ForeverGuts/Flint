/**
 * MockStdout —— 模拟终端标准输出，捕获所有写入内容。
 * 调用方：测试脚本（_test_*.ts）通过 mock/terminal.ts 的 installTerminalMocks 注入
 * 服务于：捕获交互组件（选择器 / UI / 权限弹窗）写出的终端内容，供断言验证
 *
 * 用法（配合 installTerminalMocks）：
 *   const { stdout } = installTerminalMocks();
 *   // ... 驱动交互 ...
 *   stdout.getVisibleText();   // 获取剥掉 ANSI 码后的可见文本
 *   stdout.getOutput();        // 获取含 ANSI 控制序列的原始输出
 */
export class MockStdout {
  /** 模拟终端宽度（列数），可调整来测试窄终端下的 wrap 行为 */
  columns = 80;
  /** 捕获的原始输出缓冲区 */
  private buffer = '';

  /** 模拟 write —— 所有 process.stdout.write 调用都汇入这里 */
  write(chunk: string): boolean {
    this.buffer += chunk;
    return true;
  }

  /** 获取全部原始输出（含 ANSI 颜色码 / 控制序列） */
  getOutput(): string {
    return this.buffer;
  }

  /** 获取剥掉 ANSI 颜色码后的可见文本（不含 \x1b[36m 之类的序列） */
  getVisibleText(): string {
    return this.buffer
      .replace(/\x1b\[[0-9;]*m/g, '')     // 颜色/样式序列（\x1b[36m 等）
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); // 其他控制序列（\x1b[u \x1b[0J \x1b[A 等）
  }

  /** 清空捕获缓冲（每段测试之间调用） */
  clear(): void {
    this.buffer = '';
  }

  /** 检查可见文本是否包含某子串 */
  contains(text: string): boolean {
    return this.getVisibleText().includes(text);
  }

  /** 检查原始输出是否包含某控制序列（如 '\x1b[u'） */
  containsRaw(seq: string): boolean {
    return this.buffer.includes(seq);
  }
}
