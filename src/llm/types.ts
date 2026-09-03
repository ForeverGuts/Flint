/**
 * LLM Provider 抽象 —— 屏蔽不同 API 厂商的差异。
 * 调用方：runtime.ts（通过 LLMProvider 接口调用，不依赖具体实现）
 * 服务于：定义 LLM 调用的契约，后续可接入 Anthropic / Ollama / 自定义协议
 */

/**
 * Anthropic extended thinking 块（阶段 C3 问题3）：推理文本 + signature（Anthropic 对块内容的加密签名）。
 * 多轮请求必须原样回放（一字不改），否则签名验证失败 400——属协议数据而非展示内容。
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/** 单条对话消息 */
export interface LLMMessage {
  /** 消息角色：系统 / 用户 / 助手 / 工具结果 */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 消息文本内容 */
  content: string;
  /** 工具调用信息（仅 assistant 角色携带） */
  tool_calls?: LLMToolCall[];
  /**
   * 本轮产出的 thinking 块（仅 assistant 角色、仅 Anthropic 路径；阶段 C3 问题3）。
   * 作用域：单次 run() 内的内存消息链（会话存储只存纯文本，跨轮次无回放义务）。
   */
  thinkingBlocks?: ThinkingBlock[];
  /** 工具调用结果名称（仅 tool 角色携带） */
  name?: string;
  /** 工具调用结果 ID（仅 tool 角色携带） */
  tool_call_id?: string;
}

/** Tool Calling 工具定义（LLM 可见） */
export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 按次请求选项（阶段 C2：调用方可覆盖配置级行为，优先级高于 config） */
export interface LLMRequestOptions {
  /** thinking 按次覆盖：显式布尔优先于 config.thinking；缺省跟配置走 */
  thinking?: boolean;
}

/** LLM 返回的工具调用 */
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** LLM Provider 配置（读取自 config/active-config.json，当前激活配置） */
export interface LLMConfig {
  /** 厂商标识：deepseek / openai / anthropic / ollama */
  provider?: string;
  /** API 地址（如 https://api.deepseek.com） */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 模型名（如 deepseek-v4-flash） */
  model: string;
  /**
   * 思维链（thinking）开关（来自 active-config.json）：
   *   'on'  → 请求开启隐式思维链（模型先推理再作答）
   *   'off' → 强制关闭（原始行为）
   *   'auto'/缺省 → 阶段 C1 在 Provider 侧按关闭处理；
   *                 C2 由 Runtime 按任务复杂度判定后下发（当前唯一挂点）
   */
  thinking?: 'auto' | 'on' | 'off';
}

/** Token 用量统计（来自 API 响应） */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 非流式 chat() 的返回结果（可能是纯文本，也可能含结构化工具调用） */
export interface ChatResult {
  /** 助手文本回复（调工具时可能为空字符串） */
  content: string;
  /** 结构化工具调用（纯文本回复时为空） */
  tool_calls?: LLMToolCall[];
}

/** LLM 事件流中的事件类型 */
export type LLMStreamEvent =
  | { type: 'token'; text: string }
  /** 思维链推理片段（thinking 开启时先于正文到达；不进 fullText/历史，仅供展示） */
  | { type: 'reasoning'; text: string }
  /** 完整 thinking 块拼装完成（阶段 C3 问题3）：Agent Loop 收集后挂到本轮 assistant 消息供下一轮回放 */
  | { type: 'thinking_block'; block: ThinkingBlock }
  | { type: 'tool_call'; toolCalls: LLMToolCall[] }
  | { type: 'end'; fullText: string; usage?: LLMUsage };

/**
 * LLM Provider 接口。
 * 每种接入方式（DeepSeek / Anthropic / Ollama / 自定义）实现此接口。
 */
export interface LLMProvider {
  /** 发送消息列表，返回完整回复（非流式，可带工具定义；含结构化工具调用） */
  chat(messages: LLMMessage[], tools?: LLMTool[], opts?: LLMRequestOptions): Promise<ChatResult>;

  /** 流式调用，返回 EventStream 推拉通道（文本 token + 结构化 tool_call 事件） */
  stream(messages: LLMMessage[], tools?: LLMTool[], opts?: LLMRequestOptions): import('../runtime/event-stream.js').EventStream<LLMStreamEvent>;
}
