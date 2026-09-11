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

/**
 * 检测任务清单文本是否含**未完成项**（"- [ ]" 未开始 / "* [ ]"，或 "- [>]" 进行中）。
 * 调用方：本文件（续传提示判定，作用于 TaskStore 渲染出的投影文本）
 * 服务于：给"渲染后的清单"一个纯文本判定，语义须与 `TaskStore.hasUnchecked()` 完全一致 ——
 *   两者的一致性由 `verify-todo.ts` ③段（对若干代表性状态断言二者恒等）钉死，防两处判定漂移。
 * 注：`[x]` 视为完成、不计入；`[>]`（进行中）算未完成。
 */
export function hasUncheckedTask(content: string): boolean {
  return /(?:^|\n)\s*[-*]\s*\[[ >]\]/.test(content);
}

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

    // ③ 工作记忆层：任务清单（渲染自内存真相源 TaskStore；独立于对话历史，压缩碰不到）。
    //   runtime 只在 hasUnchecked 时才把它传进来，所以这一层出现 = 必有未完成项。
    // 计划驱动：追加续传提示——系统发信号，core-section【工作记忆】教模型用 todo 响应，两边对暗号
    if (ctx.task) {
      const hasUnchecked = hasUncheckedTask(ctx.task);
      const resumeHint = hasUnchecked
        ? '\n\n[续传提示] 上方任务清单存在未完成项：从第一个未完成项继续执行，不要从头重做；完成一步后用 todo op:"done" 标记它。'
        : '';
      messages.push({ layer: 'task', content: `## 当前任务（工作记忆）\n${ctx.task}${resumeHint}` });
    }

    // ④ 摘要层：有压缩摘要才加，放最末（变化最大，最不影响前缀）
    if (ctx.summary) {
      messages.push({ layer: 'summary', content: `[对话摘要] ${ctx.summary}` });
    }

    // ⑤ hook：发送前可改写分层消息数组（扩展可追加 custom 层到末尾）
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
