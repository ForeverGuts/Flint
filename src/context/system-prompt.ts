/**
 * 系统提示词子系统实现 —— 配置驱动 + 动态计算 + hook 改写。
 * 调用方：Runtime（runSingleTurn 发请求前 build）
 * 服务于：把系统提示词从硬编码字符串升级为"发请求时动态计算的函数结果"，
 *         段落可插拔（用户写 TS 模块扩展），hook 复用现有 EventBus。
 *
 * 接口/类型定义在 core/system-prompt.ts（SystemPromptService / SystemPromptContext / SystemPromptConfig / SectionFn）
 */
import type { EventBus } from '../core/events.js';
import type { SystemPromptService, SystemPromptContext, SystemPromptConfig } from '../core/system-prompt.js';

/** 系统提示词子系统实现 */
export class SystemPromptServiceImpl implements SystemPromptService {
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

/** re-export 类型（保持消费方兼容） */
export type { SystemPromptService, SystemPromptContext, SystemPromptConfig, SectionFn } from '../core/system-prompt.js';
