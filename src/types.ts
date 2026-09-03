/**
 * 全局类型定义 —— 跨模块共享的运行期类型。
 * 调用方：main.ts（组装依赖）、runtime.ts（RuntimeOptions）、harness/check.ts（CheckResult）
 * 服务于：把“不属于任何单个子系统”的类型集中一处
 *
 * 注：SessionStorage 的唯一真身在 core/storage.ts（含 entry 树的三个可选成员），
 *     本文件只做转发。曾经这里另有一个三方法版，与 core 版同名不同体，
 *     导致 Runtime 只能靠 instanceof 缩窄到具体类才能调可选成员（已收敛）。
 *     AgentConfig（name/version）已删——注释声称调用方是 agent.ts，而该文件从未存在、全项目无人 import。
 */
export type { SessionStorage, StoredMessage } from './core/storage.js';

/**
 * Agent 运行模式。
 * 调用方：main.ts（选择进入哪种交互方式）
 * 服务于：区分 REPL 循环与 RPC 事件驱动两种模式
 */
export enum Mode {
  Repl = 'repl',
  Rpc = 'rpc',
}

/**
 * 诊断级别。
 * 调用方：check.ts（启动检查）、runtime.ts（运行时错误）、UI（展示）
 * 服务于：统一"启动检查结果"与"运行时错误"的结构，UI 一套渲染
 */
export type DiagnosticLevel = 'pass' | 'warn' | 'fail';

/**
 * 通用诊断条目 —— 启动自检与运行时错误共用。
 * 调用方：check() 生成启动诊断；runtime 错误事件复用同一结构
 * 服务于：结构化的错误/检查结果，供 banner 展示、debug 落盘、后续导出报告
 */
export interface Diagnostic {
  /** 级别：pass=通过 / warn=警告（可继续，明示）/ fail=失败（阻断） */
  level: DiagnosticLevel;
  /** 来源标识：config / apikey / network / models / model / tool / llm */
  item: string;
  /** 人类可读说明 */
  message: string;
}

/** Check 检查结果，由 check() 返回，供 main() 注入 Runtime */
export interface CheckResult {
  /** 已初始化的 LLM Provider */
  llm: import('./llm/types.js').LLMProvider;
  /** LLM 配置信息（模型名等，用于 UI 展示） */
  config?: import('./llm/types.js').LLMConfig;
  /** 启动自检诊断列表（逐项检查结果） */
  diagnostics: Diagnostic[];
  /** 激活供应商的显示名（供后台网络探测的诊断文案使用） */
  providerName: string;
}

/**
 * Runtime 构造选项。
 * 调用方：main.ts（初始化时传入）
 * 服务于：将 LLM Provider、session 等运行时依赖注入 Runtime
 */
export interface RuntimeOptions {
  /** 运行模式，默认 repl */
  mode?: Mode;
  /** LLM 模型调用（必注入） */
  llm: import('./llm/types.js').LLMProvider;
  /** 会话存储（必注入）——契约在 core/storage.ts，含 entry 树的三个可选成员 */
  session: import('./core/storage.js').SessionStorage;
  /** 工具子系统（必注入） */
  tools: import('./core/tools.js').ToolProvider;
  /** 权限子系统（必注入） */
  permission: import('./core/permission.js').PermissionProvider;
  /** 技能加载器（必注入） */
  skills: import('./runtime/skill.js').SkillLoader;
  /** 事件总线（必注入） */
  events: import('./runtime/events.js').PromptEventEmitter;
  /** 段收集器（必注入，接口）—— 把成对 span 合成一段完整行为，供 /traces 只读展示 */
  spanCollector: import('./core/events.js').SpanCollector;
  /** 命令子系统（必注入，接口） */
  commandSystem: import('./core/commands.js').CommandService;
  /** 诊断子系统（必注入，接口） */
  diagnosticsService: import('./core/diagnostics.js').DiagnosticsService;
  /** 上下文管理子系统（必注入，接口） */
  compaction: import('./core/compaction.js').CompactionService;
  /** 系统提示词子系统（必注入，接口） */
  systemPromptService: import('./core/system-prompt.js').SystemPromptService;
  /** TODO: 配置 / 扩展 / 资源管理 */
  services?: unknown;
  /** 当前模型名（供 /model 命令查看和切换） */
  model?: string;
  /** 当前 provider 类型 */
  provider?: string;
  /** 当前 baseUrl */
  baseUrl?: string;
  /** thinking 配置模式（阶段 C2：'on' 常开 / 'off' 常关 / 'auto' 按有无进行中任务判定） */
  thinking?: 'auto' | 'on' | 'off';
}
