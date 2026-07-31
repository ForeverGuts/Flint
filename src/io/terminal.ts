/**
 * 终端 stdin/stdout 管理。
 * 调用方：index.ts（入口初始化）、main.ts（REPL 循环读输入）
 * 服务于：程序的键盘输入读取与标准输出
 *
 * 使用 readline on('line') 提前收集所有行到缓冲区，
 * 避免 question() 在管道模式下因 'close' 提前触发而抛出 ERR_USE_AFTER_CLOSE。
 *
 * ── 与 permission.ts 的交互 ──
 *
 * 权限弹窗（promptPermission）需要捕获 ↑↓ 方向键来切换选项，
 * 因此必须将 stdin 切换为原始模式（raw mode）。
 *
 * 冲突根源：
 *   readline 正常工作依赖行模式（cooked mode）：
 *     行模式下，终端驱动缓存整行 → 用户按回车 → readline 收到一行数据
 *     原始模式下，每个按键立即送达 → readline 收到散碎的单字节（如 ↑ 是 \x1b[A 三个字节）
 *   如果原始模式下让 readline 继续接收 stdin 数据，它会解析错乱。
 *
 * 解决方案（在 permission.ts 中实现）：
 *   ① 通过 rawListeners('data') 保存本模块在 stdin 上注册的所有 'data' 监听器
 *   ② removeAllListeners('data') → readline 暂时"休眠"
 *   ③ setRawMode(true) → 进入原始模式
 *   ④ 添加临时 'data' 监听器，逐字节解析 ↑↓ Enter
 *   ⑤ 用户选择 → 移除临时监听器 → setRawMode(false)
 *   ⑥ 恢复所有 'data' 监听器 → readline 无缝恢复工作
 *
 * 整个过程 readline 感知不到中间发生了什么——仅是"短暂暂停"。
 */
import * as readline from 'node:readline';

let rl: readline.Interface;
/** stdin 是否已关闭（管道 EOF / Ctrl+D / rl.close() 后为 true） */
let closed = false;
/**
 * 缓冲区：readline 的 'line' 事件触发时，如果没人等输入，行数据暂存到这里。
 * 后续 readLine() 被调用时，优先从缓冲区取数据，取到就直接返回。
 */
const lineBuffer: string[] = [];
/**
 * 等待中的 Promise resolve 函数（"电话号码"）。
 *
 * 当 readLine() 被调用时：
 *   1. 缓冲区有数据 → 直接取，不设 pendingResolver
 *   2. 缓冲区为空且未关闭 → 把 resolve 存到 pendingResolver，等 'line' 事件来调用它
 *   3. 已关闭 → 返回 ''，不设 pendingResolver
 *
 * 当 'line' 事件触发时：
 *   1. pendingResolver 有值 → 调用它（resolve 用户输入），清空
 *   2. pendingResolver 无值 → 推入 lineBuffer
 *
 * 当 'close' 事件触发时：
 *   pendingResolver 有值 → 用 '' 调用它（让 await readLine 的人拿到空字符串，结束等待）
 *
 * permission.ts 交互说明（参见文件顶部注释）：
 *   权限弹窗通过移除/恢复 readline 在 stdin 上的 'data' 监听器来暂停/恢复此模块，
 *   在此期间 pendingResolver 不会被触发——因为 'line' 事件依赖 'data' 事件。
 */
let pendingResolver: ((line: string) => void) | null = null;

/** 初始化 readline 接口，接管终端输入 */
export function initTerminal(): void {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on('line', (line: string) => {
    if (pendingResolver) {
      // 有人在等输入(比如readline)，直接 resolve
      const r = pendingResolver;
      pendingResolver = null;
      r(line);
    } else {
      // 没人等输入(比如管道模式 非readline生产了lineBuffer)，先放缓冲区
      lineBuffer.push(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    if (pendingResolver) {
      const r = pendingResolver;
      pendingResolver = null;
      r('');
    }
  });
}

/**
 * 等待用户输入一行，按回车返回文本。
 * stdin 关闭时返回空字符串。
 */
export function readLine(prompt?: string): Promise<string> {
  if (prompt !== undefined) process.stdout.write(prompt);

  return new Promise((resolve) => {
    if (lineBuffer.length > 0) {
      // 缓冲区有数据，直接返回
      resolve(lineBuffer.shift()!);
      return;
    } 
    if (closed) {
      // stdin 已关闭，直接返回空字符串
      resolve('');
      return;
    }
    // 缓冲区空且 stdin 未关闭，等待 'line' 事件触发
    pendingResolver = resolve;
  });
}

/** 检查终端是否已关闭（管道 EOF / Ctrl+D 后为 true） */
export function isClosed(): boolean {
  return closed;
}

/** 关闭 readline 接口，清理终端资源 */
export function closeTerminal(): void {
  if (rl && !closed) {
    rl.close();
  }
}
