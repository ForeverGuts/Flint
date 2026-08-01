/**
 * MockStdin —— 模拟 TTY 标准输入。
 * 调用方：测试脚本（_test_*.ts）通过 mock/terminal.ts 的 installTerminalMocks 注入
 * 服务于：在非 TTY 环境下模拟键盘输入，驱动选择器 / readline / 权限弹窗等交互逻辑
 *
 * 用法（配合 installTerminalMocks）：
 *   const { stdin } = installTerminalMocks();
 *   stdin.emitKey('down');        // 模拟按 ↓
 *   stdin.emitLine('你好');       // 模拟输入一行并回车
 *   stdin.emitRaw('\x1b[B');      // 模拟任意原始按键序列
 */
export class MockStdin {
  /** 模拟 isTTY —— 让交互组件认为自己在真终端里 */
  isTTY = true;
  /** 当前是否处于原始模式（setRawMode 切换） */
  isRaw = false;
  /** 已注册的 data 事件监听器 */
  private dataHandlers = new Set<(chunk: Buffer) => void>();
  /** 已注册的 keypress 事件监听器 */
  private keypressHandlers = new Set<(str: string, key: unknown) => void>();

  /** 模拟 setRawMode —— 记录原始模式状态，供断言验证切换逻辑 */
  setRawMode(raw: boolean): void {
    this.isRaw = raw;
  }

  /** 模拟 resume —— 无操作（mock 不真的暂停/恢复） */
  resume(): void {}

  /** 模拟 on —— 注册 data / keypress 监听器 */
  on(event: string, fn: (chunk: Buffer) => void): void {
    if (event === 'data') this.dataHandlers.add(fn);
    if (event === 'keypress') this.keypressHandlers.add(fn);
  }

  /** 模拟 emit —— 触发任意事件（测试用） */
  emit(event: string, ...args: unknown[]): boolean {
    if (event === 'data') {
      const buf = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(String(args[0] ?? ''), 'utf-8');
      this.emitRaw(buf);
    } else if (event === 'keypress') {
      for (const h of this.keypressHandlers) {
        (h as (...a: unknown[]) => void)(...args);
      }
    }
    return true;
  }

  /** 模拟 removeListener —— 移除 data / keypress 监听器 */
  removeListener(event: string, fn: (chunk: Buffer) => void): void {
    if (event === 'data') this.dataHandlers.delete(fn);
    if (event === 'keypress') this.keypressHandlers.delete(fn);
  }

  /** 模拟 removeAllListeners —— 清空监听器 */
  removeAllListeners(event?: string): void {
    if (!event || event === 'data') this.dataHandlers.clear();
    if (!event || event === 'keypress') this.keypressHandlers.clear();
  }

  /** 模拟 listeners / rawListeners —— 交互组件保存/恢复监听器用，返回空列表 */
  listeners(): Array<(...args: unknown[]) => void> {
    return [];
  }
  rawListeners(): Array<(...args: unknown[]) => void> {
    return [];
  }

  /* ── 注入方法（测试用） ── */

  /** 注入一行文本 + 回车（模拟用户打字后按 Enter） */
  emitLine(text: string): void {
    this.emitRaw(text + '\r');
  }

  /** 注入方向键 / 功能键序列 */
  emitKey(
    key: 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'ctrl-c',
  ): void {
    const map: Record<string, string> = {
      up: '\x1b[A',
      down: '\x1b[B',
      left: '\x1b[D',
      right: '\x1b[C',
      enter: '\r',
      escape: '\x1b',
      'ctrl-c': '\x03',
    };
    this.emitRaw(map[key]);
  }

  /** 注入任意原始字节序列（Buffer 或字符串） */
  emitRaw(bytes: string | Buffer): void {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf-8');
    for (const handler of this.dataHandlers) {
      handler(buf);
    }
  }
}
