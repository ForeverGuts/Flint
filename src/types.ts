/**
 * Agent 配置。
 * 调用方：agent.ts、harness/index.ts
 * 服务于：定义 Agent 启动所需的静态信息
 */
export interface AgentConfig {
  /** Agent 名称 */
  name: string;
  /** 版本号（语义化） */
  version: string;
}

/**
 * Session 存储接口（最小契约）。
 * 调用方：session.ts（InMemorySession 实现此接口）、runtime.ts（通过接口调用）
 * 服务于：定义消息存取的通用契约。
 * 注意：entry 树能力（leaf/fork/compaction）属于 JsonlSessionStorage 的具体方法，
 *       不在此接口内，Runtime 通过 instanceof 分支调用，避免污染 InMemory/Mock。
 */
export interface SessionStorage {
  /** 追加一条消息 */
  appendMessage(role: string, content: string): Promise<void>;
  /** 读取当前会话全部消息（JSONL 实现=当前分支路径） */
  getMessages(): Promise<Array<{ role: string; content: string }>>;
  /** 清空会话 */
  clear(): Promise<void>;
}

/**
 * Agent 运行模式。
 * 调用方：main.ts（选择进入哪种交互方式）
 * 服务于：区分 REPL 循环与 RPC 事件驱动两种模式
 */
export enum Mode {
  Repl = 'repl',
  Rpc = 'rpc',
}

/** Check 检查结果，由 check() 返回，供 main() 注入 Runtime */
export interface CheckResult {
  /** 已初始化的 LLM Provider */
  llm: import('./llm/types.js').LLMProvider;
  /** LLM 配置信息（模型名等，用于 UI 展示） */
  config?: import('./llm/types.js').LLMConfig;
}

/**
 * Runtime 构造选项。
 * 调用方：main.ts（初始化时传入）
 * 服务于：将 LLM Provider、session 等运行时依赖注入 Runtime
 */
export interface RuntimeOptions {
  /** 运行模式，默认 repl */
  mode?: Mode;
  /** LLM 模型调用 */
  llm?: import('./llm/types.js').LLMProvider;
  /** LLM 对话管理 */
  session?: SessionStorage;
  /** TODO: 配置 / 扩展 / 资源管理 */
  services?: unknown;
  /** 当前模型名（供 /model 命令查看和切换） */
  model?: string;
  /** 当前 provider 类型 */
  provider?: string;
  /** 当前 baseUrl */
  baseUrl?: string;
}
