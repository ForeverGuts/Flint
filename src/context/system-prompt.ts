/**
 * 系统提示词子系统 —— 配置驱动 + 动态计算 + hook 改写。
 * 调用方：Runtime（runSingleTurn 发请求前 build）
 * 服务于：把系统提示词从硬编码字符串升级为"发请求时动态计算的函数结果"，
 *         段落可插拔（用户写 TS 模块扩展），hook 复用现有 EventBus。
 *
 * 设计（对齐 Pi 的 systemPrompt 机制）：
 *   - 构造时接收配置（sections + fallback）
 *   - 发请求时计算（build 拿到当前完整状态：工具/技能/模型/摘要）
 *   - 计算函数独立（段落 SectionFn，用户可自定义）
 *   - 兜底提示词（无段落/构建失败）
 *   - hook 改写（复用 EventBus.on/emitHook：before_build / before_request）
 */
import type { EventBus } from '../core/events.js';

/** 构建上下文（发请求时传入，含当前完整状态） */
export interface SystemPromptContext {
  /** 工具描述（ToolProvider 格式化后） */
  tools: string;
  /** 技能名称列表（SkillLoader 提供） */
  skills: string[];
  /** 当前模型名 */
  model: string;
  /** 会话摘要（compaction 结果，可选） */
  summary?: string | undefined;
  /** 历史条数 */
  historyCount: number;
}

/** 段落函数（用户可自定义扩展）—— 返回提示词片段，undefined 表示本段不参与 */
export type SectionFn = (ctx: SystemPromptContext) => string | undefined;

/** 配置（构造时接收） */
export interface SystemPromptConfig {
  /** 段落函数列表（按顺序组装） */
  sections: SectionFn[];
  /** 兜底提示词（无段落/构建失败时用） */
  fallback: string;
}

/** 系统提示词 hook 事件 */
export type SystemPromptHook =
  | { type: 'before_build'; ctx: SystemPromptContext }
  | { type: 'before_request'; systemPrompt: string };

/** 系统提示词子系统 */
export class SystemPromptService {
  constructor(
    private config: SystemPromptConfig,
    private events: EventBus,
  ) {}

  /**
   * 构建系统提示词（发请求前调用）。
   * 流程：hook(before_build) → 计算段落 → 兜底 → hook(before_request) 可改写。
   */
  async build(ctx: SystemPromptContext): Promise<string> {
    // ① hook：构建前可改写 ctx
    await this.events.emitHook?.('before_build', { ctx } as unknown);

    // ② 计算段落（无段落用兜底）
    const parts = this.config.sections.map((s) => s(ctx)).filter(Boolean) as string[];
    let prompt = parts.length > 0 ? parts.join('\n\n') : this.config.fallback;

    // ③ hook：发送前可改写 prompt
    const result = await this.events.emitHook?.('before_request', { systemPrompt: prompt });
    const override = (result as { systemPrompt?: string } | undefined)?.systemPrompt;
    return override ?? prompt;
  }
}
