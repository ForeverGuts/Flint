/**
 * Agent 配置。
 * 调用方：agent.ts、harness/index.ts
 * 服务于：定义 Agent 启动所需的静态信息
 */
export interface AgentConfig {
  name: string;
  version: string;
}

/**
 * Session 存储接口。
 * 调用方：session.ts（InMemorySession 实现此接口）
 * 服务于：定义消息存取的契约，方便后续替换为 JSONL / mock 存储
 */
export interface SessionStorage {
  /** 追加一条消息 */
  appendMessage(role: string, content: string): Promise<void>;
  /** 读取全部消息 */
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
  llm: import('./llm/types.js').LLMProvider;
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
}
