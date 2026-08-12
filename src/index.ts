/**
 * 程序入口。
 * 调用方：终端用户（`tsx src/index.ts`）
 * 服务于：初始化终端环境 → 启动 Harness 进入常驻
 */
import { initTerminal } from './io/terminal.js';
import { Harness } from './harness/index.js';

// RPC 模式（管道 stdin）不初始化 readline 终端 —— initTerminal 的 readline 会干扰管道输入，
// 导致顶层 await 无法 settle（exit 13）。RPC 由 runRpcMode 自建 readline 读 stdin。
if (process.env.TS_AGENT_MODE !== 'rpc') {
  initTerminal();
}

// stdout 关闭时的错误静默处理（避免 Windows UV_HANDLE_CLOSING）
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

process.on('unhandledRejection', (err) => {
  console.error('[FATAL] unhandledRejection:', err);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
  process.exit(1);
});
process.on('exit', (code) => {
  console.error(`[INFO] process exit code=${code}`);
});

const harness = new Harness();
try {
  await harness.run();
} catch (err) {
  console.error('[FATAL]', err);
  process.exit(1);
}
