/**
 * 终端 stdin/stdout 管理。
 * 调用方：index.ts（入口初始化）、main.ts（REPL 循环读输入）
 * 服务于：程序的键盘输入读取与标准输出
 */
import * as readline from 'node:readline';

let rl: readline.Interface;
let closed = false;

/** 初始化 readline 接口，接管终端输入 */
export function initTerminal(): void {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on('close', () => { closed = true; });
}

/**
 * 等待用户输入一行，按回车返回文本。
 * stdin 关闭（管道 EOF / Ctrl+D）时返回空字符串。
 */
export function readLine(prompt?: string): Promise<string> {
  return new Promise((resolve) => {
    if (closed) {
      resolve('');
      return;
    }
    rl.question(prompt ?? '', resolve);
  });
}

/** 关闭 readline 接口，清理终端资源 */
export function closeTerminal(): void {
  if (rl && !closed) {
    rl.close();
  }
}
