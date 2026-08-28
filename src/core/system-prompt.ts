/**
 * 系统提示词子系统接口（core 层公共契约）。
 * 调用方：Runtime（发请求前 build）
 * 服务于：抽象系统提示词的动态构建，隔离具体实现（context/system-prompt.ts）
 *
 * 缓存友好设计：build 返回**分层 system 消息数组**，按稳定度排序
 * （core → tools → skills → summary），越稳定越靠前，越变化越靠后。
 * 这样某层变化（如摘要更新）只使该层之后的缓存失效，稳定前缀命中率高。
 */

/** 系统提示词层次名（用于分层缓存 + hook 定位，发送时仅 role/content 序列化） */
export type SystemPromptLayer = 'core' | 'tools' | 'skills' | 'summary' | 'custom';

/** 分层 system 消息（一层一条，顺序即发送顺序） */
export interface SystemPromptMessage {
  /** 层次：core 稳定人设 / tools 工具 / skills 技能 / summary 会话摘要 / custom hook 追加 */
  layer: SystemPromptLayer;
  /** 该层内容 */
  content: string;
}

/** 构建结果：分层 system 消息数组（稳定前缀在前，变化在后） */
export interface SystemPromptResult {
  messages: SystemPromptMessage[];
}

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

/** 配置（构造时接收）—— 段落按层次分组，稳定层在前 */
export interface SystemPromptConfig {
  /** 稳定层段落（人设/规则，用户扩展段落也归此层）—— 几乎不变，缓存前缀核心 */
  core: SectionFn[];
  /** 工具层段落（工具注册时变化） */
  tools: SectionFn[];
  /** 技能层段落（技能加载时变化） */
  skills: SectionFn[];
  /**
   * 兜底提示词（无段落/构建失败时用）。
   * TODO(长文档预留)：未来在 core 层之后、tools 层之前插入"稳定参考文档"层
   *（如项目 README/约定），它同样稳定，放进稳定前缀区不影响现有前缀。
   */
  fallback: string;
}

/** 系统提示词子系统接口（执行类 → Service 后缀） */
export interface SystemPromptService {
  /**
   * 构建系统提示词（发请求前调用）。
   * 流程：hook(before_build) → 分层计算段落 → 兜底 → hook(before_request) 可改写消息数组。
   * @returns 分层 system 消息数组（core → tools → skills → summary）
   */
  build(ctx: SystemPromptContext): Promise<SystemPromptResult>;
}
