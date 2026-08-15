/**
 * 系统提示词子系统接口（core 层公共契约）。
 * 调用方：Runtime（发请求前 build）
 * 服务于：抽象系统提示词的动态构建，隔离具体实现（context/system-prompt.ts）
 */

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

/** 系统提示词子系统接口（执行类 → Service 后缀） */
export interface SystemPromptService {
  /**
   * 构建系统提示词（发请求前调用）。
   * 流程：hook(before_build) → 计算段落 → 兜底 → hook(before_request) 可改写。
   */
  build(ctx: SystemPromptContext): Promise<string>;
}
