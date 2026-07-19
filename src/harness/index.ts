/**
 * Harness 主类 —— 编排 Agent 的完整运行流程。
 * 调用方：index.ts（创建实例并调用 run）
 * 服务于：check() 返回结果 → 传入 main() 启动 Agent
 */
import { main } from './main.js';
import { check } from './check.js';
import type { CheckResult } from '../types.js';

export class Harness {
  async run(): Promise<void> {
    const result: CheckResult = await check();
    await main(result);
  }
}
