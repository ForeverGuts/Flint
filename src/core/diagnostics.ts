/**
 * 诊断子系统接口（core 层公共契约）。
 * 调用方：Runtime（recordDiagnostic 委托）、/diagnostics 命令（查询）
 * 服务于：抽象诊断收集/查询，隔离具体实现（diagnostics/service.ts）
 */
import type { Diagnostic } from '../types.js';

/** 诊断子系统接口 */
export interface DiagnosticsProvider {
  /** 记录一条运行时诊断（入队 + emit 事件 + 落盘） */
  record(level: Diagnostic['level'], item: string, message: string): void;
  /** 获取历史诊断列表 */
  getAll(): Diagnostic[];
}
