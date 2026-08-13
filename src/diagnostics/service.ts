/**
 * 诊断子系统 —— 运行时错误/警告的结构化收集、查询、落盘。
 * 调用方：Runtime（recordDiagnostic 委托）、/diagnostics 命令（查询）、RPC get_diagnostics
 * 服务于：统一错误收集（复用 Diagnostic 类型），供查询/展示/回放
 *
 * 消费者：/diagnostics 命令、RPC get_diagnostics 方法（两个消费者，独立系统）
 */
import { appendFileSync } from 'node:fs';
import type { Diagnostic } from '../types.js';
import type { DiagnosticsService } from '../core/diagnostics.js';

/** DiagnosticsService 构造依赖 */
export interface DiagnosticsDeps {
  /** 事件总线（发射 error 事件，供 UI 展示） */
  events: { emit(event: unknown): void };
}

/** 诊断子系统实现 */
export class DiagnosticsServiceImpl implements DiagnosticsService {
  /** 诊断队列 */
  private diagnostics: Diagnostic[] = [];

  constructor(private deps: DiagnosticsDeps) {}

  /** 获取历史诊断列表（供 /diagnostics 命令查看、外部导出） */
  getAll(): Diagnostic[] {
    return [...this.diagnostics];
  }

  /**
   * 记录一条运行时诊断：入队 + emit 事件 + 落盘（debug-runtime.log）。
   * 调用方：Runtime（LLM/工具失败时委托）
   */
  record(level: Diagnostic['level'], item: string, message: string): void {
    const diag: Diagnostic = { level, item, message };
    this.diagnostics.push(diag);
    this.deps.events.emit({ type: 'error', level, item, message });
    // 落盘（env TS_AGENT_DEBUG_DIAG=1 时写入 debug-runtime.log，便于回放）
    if (process.env.TS_AGENT_DEBUG_DIAG === '1') {
      try {
        appendFileSync('debug-runtime.log', `${new Date().toISOString()} [${level}] [${item}] ${message}\n`);
      } catch { /* 落盘失败不阻塞 */ }
    }
  }
}
