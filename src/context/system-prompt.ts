/**
 * 系统提示词子系统实现 —— 配置驱动 + 动态计算 + hook 改写。
 * 调用方：Runtime（runSingleTurn 发请求前 build）
 * 服务于：把系统提示词从硬编码字符串升级为"发请求时动态计算的函数结果"，
 *         段落可插拔（用户写 TS 模块扩展），hook 复用现有 EventBus。
 *
 * 分层设计（缓存友好）：返回各层独立 system 消息，顺序
 * core → tools → skills → project → memory → task → summary，
 * 稳定前缀在前、变化内容在后，某层变化不拖垮全部前缀。
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
   * 分层顺序（稳定→变化）：core → tools → skills → project → memory → task → summary。
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

    // ③ 项目现状层（`.flint/PROJECT.md` 快照）："当前系统由哪些模块 / 技术点构成"。
    //   内容由 runtime **每轮现读文件**填进来——唯一真相源就是那个文件，不存在第二份状态，
    //   所以模型一改它就立刻生效（自愈），不需要任何"谁通知 runtime"的线。
    //   没有这个文件则整层缺席（模型照旧用 ls/read 自己看，不是错误状态）。
    //   位置：比 memory 易变（随代码漂移，每坐标一次）、比 task 稳定，故夹在 skills 与 memory 之间。
    //    同层的另外两半：**技术栈画像**（10.1.1，存在性探测的语言 / 包管理器）与
    //    **项目命令表**（10.6.1，package.json 的 scripts 发现而来）。三半合在同一条消息里 ——
    //    都是"这个项目长什么样"，且**都没有内存真相源**（现状快照每轮现读文件、画像与命令表
    //    播种时各读一次进注册表），分开成三条只会多两条消息、层序不变。
    //    内部顺序是**承重的**：现状 → 画像 → 命令表 → 仓库状态。命令表的包管理器前缀由画像派生，
    //    先看到"用 pnpm"再看到 `pnpm run test`，读起来才是一件事而不是两处口径；
    //    仓库状态（10.5.5）压在最后——它答"git 当前在哪"，是"这个项目长什么样"的最后一格，
    //    且它只在会话起点探一次（实时性交给 git 工具），排在易变末端恰如其分。
    //    任一半缺席就只出另一半；四半都无 → 整层缺席（维持"没有就不注入"的纪律）。
    if (ctx.project || ctx.stack || ctx.commands || ctx.repo) {
      const parts: string[] = [];
      if (ctx.project) {
        parts.push(`[项目现状]（.flint/PROJECT.md —— 当前系统由哪些模块 / 技术点构成；随代码漂移，过时就更新它）\n${ctx.project}`);
      }
      if (ctx.stack) parts.push(ctx.stack);
      if (ctx.commands) parts.push(ctx.commands);
      if (ctx.repo) parts.push(ctx.repo);
      messages.push({ layer: 'project', content: parts.join('\n\n') });
    }

    // ④ memory 层：**两节**，规约在前、记忆在后（ROADMAP 10.2.1）。
    //   · 【项目规约】来自 AGENTS.md / CLAUDE.md —— **人写下的规矩**（播种时找一次，运行期不回读）；
    //   · 【项目记忆】来自 MemoryStore —— **模型自己攒的结论**（压缩碰不到）。
    //   两节同层（都是"本项目的约定"，且都在会话内基本不变，故都排在 task 之前、保持
    //   "越稳定越靠前"）但**不合并**：权威来源不同，冲突时以人为准 —— 位置在前 + 节首明说，
    //   是同一件事的两半。分开成两条消息只会多一条消息、且把一个稳定源挪出它该在的带宽。
    //   任一节缺席就只出另一节；两节都无 → 整层缺席（维持"没有就不注入"的纪律）。
    if (ctx.rules || ctx.memory) {
      const parts: string[] = [];
      if (ctx.rules) parts.push(ctx.rules);
      if (ctx.memory) parts.push(`[项目记忆]（跨会话持久，适用于本项目的所有任务）\n${ctx.memory}`);
      messages.push({ layer: 'memory', content: parts.join('\n\n') });
    }

    // ⑤ 工作记忆层：**两节**，任务清单在前、计划模式横幅在后（ROADMAP 10.4.1）。
    //   · 【当前任务】渲染自内存真相源 TaskStore（独立于对话历史，压缩碰不到），
    //     由 runtime 在 hasUnchecked 时才传进来；计划驱动：追加续传提示 —— 系统发信号，
    //     core-section【工作记忆】教模型用 todo 响应，两边对暗号；
    //   · 【计划模式横幅】由 runtime 在模式开启时传进来（**与任务清单无关** ——
    //     清单空着也照样在计划模式里）。⚠ 因此这一层**出现 ≠ 必有未完成项**了，
    //     旧注释那句"这一层出现 = 必有未完成项"随之作废：判"有没有未完成项"要问
    //     `hasUnchecked()` / `hasUncheckedTask(render())`，**不许拿"task 层在不在"当代理**
    //     （那样会在"计划模式 + 空清单"时判反）。
    //   两节同层（都是"此刻该干什么"的运行状态）但**不合并**：来源与刷新率都不同 ——
    //   清单随工具变更、横幅随模式开关，任一缺席就只出另一节；两节都无 → 整层缺席
    //   （维持"没有就不注入"的纪律）。
    if (ctx.task || ctx.plan) {
      const parts: string[] = [];
      if (ctx.task) {
        const hasUnchecked = hasUncheckedTask(ctx.task);
        const resumeHint = hasUnchecked
          ? '\n\n[续传提示] 上方任务清单存在未完成项：从第一个未完成项继续执行，不要从头重做；完成一步后用 todo op:"done" 标记它。'
          : '';
        parts.push(`## 当前任务（工作记忆）\n${ctx.task}${resumeHint}`);
      }
      if (ctx.plan) parts.push(ctx.plan);
      messages.push({ layer: 'task', content: parts.join('\n\n') });
    }

    // ⑥ 摘要层：有压缩摘要才加，放最末（变化最大，最不影响前缀）
    if (ctx.summary) {
      messages.push({ layer: 'summary', content: `[对话摘要] ${ctx.summary}` });
    }

    // ⑦ hook：发送前可改写分层消息数组（扩展可追加 custom 层到末尾）
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
