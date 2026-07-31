/**
 * 程序入口。
 * 调用方：终端用户（`tsx src/index.ts`）
 * 服务于：初始化终端环境 → 启动 Harness 进入常驻
 */
import { initTerminal } from './io/terminal.js';
import { Harness } from './harness/index.js';

initTerminal();

// stdout 关闭时的错误静默处理（避免 Windows UV_HANDLE_CLOSING）
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

process.on('unhandledRejection', (err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});

const harness = new Harness();
await harness.run().then(() => process.exit(0)).catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
