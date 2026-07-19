/**
 * 程序入口。
 * 调用方：终端用户（`tsx src/index.ts`）
 * 服务于：初始化终端环境 → 启动 Harness 进入常驻
 */
import { initTerminal } from './io/terminal.js';
import { Harness } from './harness/index.js';

initTerminal();

const harness = new Harness();
harness.run();
