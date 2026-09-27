/**
 * 系统提示词子系统接口（core 层公共契约）。
 * 调用方：Runtime（发请求前 build）
 * 服务于：抽象系统提示词的动态构建，隔离具体实现（context/system-prompt.ts）
 *
 * 缓存友好设计：build 返回**分层 system 消息数组**，按稳定度排序
 * （core → tools → skills → project → memory → task → summary），越稳定越靠前，越变化越靠后。
 * 这样某层变化（如摘要更新）只使该层之后的缓存失效，稳定前缀命中率高。
 */

/**
 * 系统提示词层次名（用于分层缓存 + hook 定位，发送时仅 role/content 序列化）
 * 注：`memory` 层内含**两节** —— 项目规约（人写的，在前）+ 项目记忆（模型攒的，在后），
 *     两者权威来源不同故分节而不合并（见 SystemPromptContext.rules）。
 */
export type SystemPromptLayer = 'core' | 'tools' | 'skills' | 'project' | 'memory' | 'task' | 'summary' | 'custom';

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
  /** 技能声明的依赖（名字 → frontmatter `depends` 解析结果；可选——缺省时段落跳过依赖标注） */
  skillDeps?: Record<string, string[]>;
  /** 当前模型名 */
  model: string;
  /** 会话摘要（compaction 结果，可选） */
  summary?: string | undefined;
  /**
   * 项目现状快照（`.flint/PROJECT.md` 内容，可选）—— "当前系统由哪些模块 / 技术点构成"。
   * 随代码漂移（每完成一个坐标同步一次），故比 core 易变、比 task 稳定；
   * 没有文件时不注入该层（模型照旧自己 ls/read，不是错误状态）。
   */
  project?: string | undefined;
  /**
   * 项目技术栈画像（存在性探测的语言 / 包管理器，渲染结果，可选）—— ROADMAP 10.1.1。
   * 与 project 快照 / commands **同一层**（都是"这个项目长什么样"），排在两者之间：
   * 现状快照答"系统由什么构成"→ 画像答"在哪个生态、用哪个包管理器"→ 命令表答"能跑什么"，
   * 而命令表里的包管理器**正是由画像派生**，所以画像必须排在它前面读起来才顺。
   * 没有则不注入该半段（模板文件一个都没命中 = 不是错误状态）。
   */
  stack?: string | undefined;
  /**
   * 项目命令表（package.json 的 scripts 渲染结果，可选）—— "这个项目有哪些命令"。
   * 与 project 快照**同一层**（都答"这个项目长什么样"），没有则不注入。
   * 它是**展示**不是门禁：只回答"跑什么"，不授权自动执行（授权只来自 .flint/postcheck.json）。
   */
  commands?: string | undefined;
  /**
   * 仓库状态（git 当前分支 / 领先落后 / 工作区脏净，渲染结果，可选）—— ROADMAP 10.5.5。
   * **与 project 快照 / 画像 / 命令表同一层**（都答"这个项目长什么样"），没有则不注入。
   * 它是**会话起点快照**（播种时探一次），实时状态靠 `git` 工具自查；非 git 仓库 → 整段缺席。
   * 位置排在命令表之后：先知道"在哪、用什么、能跑什么"，再知道"git 当前在哪"。
   */
  repo?: string | undefined;
  /**
   * 项目规约（`AGENTS.md` / `CLAUDE.md` 的首命中，渲染结果，可选）—— ROADMAP 10.2.1。
   * **与 memory 同一层**（`layer: 'memory'`），但在同一条消息里**排在项目记忆之前**：
   * 两者权威来源不同 —— 这份是**人写下的规矩**、那份是**模型自己攒的结论**，冲突时以人为准，
   * 位置在前 + 节首明说"以这里为准"是同一件事的两半。
   * 没有命中（或命中但正文为空）则不注入该节；没有它时 memory 层逐字与接入前相同。
   */
  rules?: string | undefined;
  /**
   * 项目记忆（MemoryStore 渲染结果，可选）—— 跨会话持久的项目约定/决策/坑。
   * 独立于对话历史，压缩碰不到；只在有记忆条目时注入。
   */
  memory?: string | undefined;
  /**
   * 工作记忆（TASK.md 内容，可选）—— 独立于对话历史的持久任务状态。
   * 压缩只压缩对话历史，不触碰 TASK.md；每次请求重新注入，压缩后任务状态仍在。
   */
  task?: string | undefined;
  /**
   * 计划模式横幅（渲染结果，可选）—— ROADMAP 10.4.1。模式开启时非空，关闭时是 undefined。
   *
   * **与 task 同一层**（`layer: 'task'`），且排在同一条消息里**任务清单之后**：两者都是
   * "此刻该干什么"的运行状态（清单说"有哪些活儿"，横幅说"现在只许出方案不许动手"），
   * 而横幅是**每轮现取**的即时状态，压在后面正好落在易变的那一端。
   * 为什么折进 task 层而不新开一层：同 10.1.1 / 10.2.1 —— 分层序那条串是承重的，
   * 改它要同步动 union 与两套逐字断言，而收益只是多一条消息。
   */
  plan?: string | undefined;
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
   * 注：曾在此预留一个 TODO（"未来插入稳定参考文档层，如项目 README/约定"）——
   * 2026-09-14 已落地为 **project 层**（`.flint/PROJECT.md` 现状快照，见 SystemPromptContext.project），
   * 位置在 skills 之后、memory 之前：它随代码漂移（每坐标一次），比 memory 易变、比 task 稳定。
   */
  fallback: string;
}

/** 系统提示词子系统接口（执行类 → Service 后缀） */
export interface SystemPromptService {
  /**
   * 构建系统提示词（发请求前调用）。
   * 流程：hook(before_build) → 分层计算段落 → 兜底 → hook(before_request) 可改写消息数组。
   * @returns 分层 system 消息数组（顺序见文件头注释）
   */
  build(ctx: SystemPromptContext): Promise<SystemPromptResult>;
}
