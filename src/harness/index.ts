/**
 * Harness 主类 —— 编排 Agent 的完整运行流程。
 * 调用方：index.ts（创建实例并调用 run）
 * 服务于：check() 返回结果 → 传入 main() 启动 Agent
 *
 * Harness 持有自己的事件发射器（harness 层事件：启动进度、检查结果等）。
 */
import { main } from './main.js';
import { check } from './check.js';
import type { CheckResult } from '../types.js';
import { PromptEventEmitter } from '../runtime/events.js';
import type { EventHandler } from '../runtime/events.js';

export class Harness {
  /** Harness 层事件（启动进度、检查结果、生命周期等） */
  events = new PromptEventEmitter();

  /** 订阅 Harness 层事件 */
  subscribe(handler: EventHandler): () => void {
    return this.events.subscribe(handler);
  }

  async run(): Promise<void> {
    // TODO: 发射 HarnessEvent（check 开始/完成、启动进度等）
    // this.events.emit({ type: 'check_start' });
    const result: CheckResult = await check();
    await main(result);
  }
}
