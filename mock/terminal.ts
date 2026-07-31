/**
 * 终端 Mock 安装器 —— 把 MockStdin / MockStdout 注入到全局 process。
 * 调用方：测试脚本（_test_*.ts）开头调用 installTerminalMocks()
 * 服务于：让交互组件（选择器 / readline / 权限弹窗）以为自己运行在真实 TTY 中，
 *         从而可以在测试里注入按键、捕获输出、断言交互行为
 *
 * 用法：
 *   const mocks = installTerminalMocks();
 *   const { stdin, stdout } = mocks;
 *   stdin.emitKey('down');         // 模拟按 ↓
 *   stdout.contains('第 2/3 页');  // 断言输出
 *   mocks.restore();               // 测试结束恢复真实 process
 */
import { MockStdin } from './stdin.js';
import { MockStdout } from './stdout.js';

/** 安装结果：两个 mock + restore 恢复函数 */
export interface TerminalMocks {
  /** 模拟输入源（注入按键 / 文本） */
  stdin: MockStdin;
  /** 模拟输出捕获（断言终端内容） */
  stdout: MockStdout;
  /** 恢复真实的 process.stdin / process.stdout */
  restore(): void;
}

/** 保存的原始对象（restore 时放回） */
interface SavedOriginals {
  stdin: NodeJS.ReadStream;
  stdoutWrite: (chunk: unknown) => boolean;
}

/**
 * 安装终端 mock，返回可注入按键、捕获输出、恢复原状的控制对象。
 * 注意：process.stdin 是只读 getter，需用 defineProperty 替换；恢复时同样用 defineProperty 还原。
 */
export function installTerminalMocks(): TerminalMocks {
  const stdin = new MockStdin();
  const stdout = new MockStdout();

  // 保存原始引用
  const saved: SavedOriginals = {
    stdin: process.stdin,
    stdoutWrite: process.stdout.write.bind(process.stdout),
  };

  // 替换全局 stdin（只读 getter → defineProperty）
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  // 替换全局 stdout.write（拦截所有输出到 MockStdout）
  (process.stdout as { write: (s: string) => boolean }).write = (s: string) =>
    stdout.write(s);
  // 让 stdout.columns 指向 mock 的 columns（交互组件读取终端宽度用）
  Object.defineProperty(process.stdout, 'columns', {
    get: () => stdout.columns,
    configurable: true,
  });

  return {
    stdin,
    stdout,
    restore() {
      Object.defineProperty(process, 'stdin', { value: saved.stdin, configurable: true });
      (process.stdout as { write: (chunk: unknown) => boolean }).write = saved.stdoutWrite;
      delete (process.stdout as { columns?: unknown }).columns;
    },
  };
}
