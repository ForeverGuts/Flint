/**
 * 系统提示词子系统实现 —— 配置驱动 + 动态计算 + hook 改写。
 * 调用方：Runtime（runSingleTurn 发请求前 build）
 * 服务于：把系统提示词从硬编码字符串升级为"发请求时动态计算的函数结果"，
 *         段落可插拔（用户写 TS 模块扩展），hook 复用现有 EventBus。
 *
 * 分层设计（缓存友好）：返回 core → tools → skills → summary 独立 system 消息，
 * 稳定前缀（core/tools/skills）与变化内容（summary）分离，某层变化不拖垮全部前缀。
 *
 * 接口/类型定义在 core/system-prompt.ts（SystemPromptService / SystemPromptContext /
 * SystemPromptConfig / SectionFn / SystemPromptMessage / SystemPromptLayer）
 */
import type { EventBus } from '../core/events.js';
import type {
  SystemPromptService,
  SystemPromptContext,
  SystemPromptConfig,
  SectionFn,
  SystemPromptMessage,
  SystemPromptLayer,
} from '../core/system-prompt.js';

/** 系统提示词子系统实现 */
export class SystemPromptServiceImpl implements SystemPromptService {
  constructor(
    private config: SystemPromptConfig,
    private events: EventBus,
  ) {}

  /**
   * 构建系统提示词（发请求前调用）。
   * 流程：hook(before_build) → 分层计算段落 → 兜底 → hook(before_request) 可改写消息数组。
   * 分层顺序（稳定→变化）：core → tools → skills → summary。
   */
  async build(ctx: SystemPromptContext): Promise<{ messages: SystemPromptMessage[] }> {
    // ① hook：构建前可改写 ctx
    await this.events.emitHook?.('before_build', { ctx } as unknown);

    // ② 分层计算段落（稳定层在前，变化层在后）
    const layers: Array<{ layer: SystemPromptLayer; sections: SectionFn[] }> = [
      { layer: 'core', sections: this.config.core },
      { layer: 'tools', sections: this.config.tools },
      { layer: 'skills', sections: this.config.skills },
    ];

    const messages: SystemPromptMessage[] = [];
    for (const { layer, sections } of layers) {
      const parts = sections.map((s) => s(ctx)).filter(Boolean) as string[];
      if (parts.length > 0) messages.push({ layer, content: parts.join('\n\n') });
    }

    // 兜底：无任何段落时（正常场景 core 段始终存在，此处仅防御）
    if (messages.length === 0) {
      messages.push({ layer: 'core', content: this.config.fallback });
    }

    // ③ 摘要层：有压缩摘要才加，放最末（变化最大，最不影响前缀）
    if (ctx.summary) {
      messages.push({ layer: 'summary', content: `[对话摘要] ${ctx.summary}` });
    }

    // ④ hook：发送前可改写分层消息数组（扩展可追加 custom 层到末尾）
    const result = await this.events.emitHook?.('before_request', { messages } as unknown);
    const override = (result as { messages?: SystemPromptMessage[] } | undefined)?.messages;
    if (override) return { messages: override };
    return { messages };
  }
}

/** re-export 类型（保持消费方兼容） */
export type {
  SystemPromptService,
  SystemPromptContext,
  SystemPromptConfig,
  SectionFn,
  SystemPromptMessage,
  SystemPromptLayer,
} from '../core/system-prompt.js';
