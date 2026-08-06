/**
 * Harness 主类 —— 编排 Agent 的完整运行流程。
 * 调用方：index.ts（创建实例并调用 run）
 * 服务于：check() 返回结果 → 传入 main() 启动 Agent
 *
 * Harness 持有自己的事件发射器（harness 层事件：启动进度、检查结果等）。
 */
import { main } from './main.js';
import { check, CheckFailureError } from './check.js';
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
    // 发射 check 开始事件
    this.events.emit({ type: 'check_start' });

    let result: CheckResult;
    try {
      result = await check();
    } catch (err) {
      // 配置坏到无法创建 Provider → 打印红字诊断，优雅退出（fail 级阻断）
      if (err instanceof CheckFailureError) {
        for (const d of err.diagnostics) {
          const icon = d.level === 'fail' ? '❌' : d.level === 'warn' ? '⚠️' : '✅';
          console.error(`  ${icon} [${d.item}] ${d.message}`);
        }
        console.error('\n[FATAL] 启动检查失败，请修复配置后重试。');
        process.exit(1);
      }
      throw err;
    }

    // 发射 check 完成事件（携带诊断，供 UI/外部订阅者展示）
    this.events.emit({ type: 'check_done', diagnostics: result.diagnostics });
    await main(result);
  }
}

/** 导出诊断类型，方便外部订阅者引用 */
export type { Diagnostic } from '../types.js';
