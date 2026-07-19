/**
 * Agent 核心类。
 * 调用方：harness/index.ts（Harness 内部创建并调用 start/stop）
 * 服务于：Agent 的生命周期管理（启动 / 停止）
 */
import type { AgentConfig } from '../types.js';

export class Agent {
  constructor(private config: AgentConfig) {}

  /** 启动 Agent，进入待命状态 */
  async start(): Promise<void> {
    console.log(`[${this.config.name}] Agent ready`);
  }

  /** 停止 Agent，清理资源 */
  async stop(): Promise<void> {
    console.log(`[${this.config.name}] Agent stopped`);
  }
}
