/**
 * 事件总线接口（core 层公共契约）。
 * 调用方：Runtime（emit 事件）、loop/（emit 工具/流事件）、UI（subscribe 展示）
 * 服务于：抽象事件订阅/发射，隔离具体实现（runtime/events.ts 的 PromptEventEmitter）
 *
 * 事件类型定义保留在 runtime/events.ts（RuntimeEvent），这里只定义总线行为契约。
 */

/** 事件总线接口 */
export interface EventBus {
  /** 注册通配监听 —— 收到所有事件，用于 UI 展示（只看不说） */
  subscribe(handler: (event: unknown) => void): () => void;
  /** 注册精确监听 —— 只收某类事件，可返回结果影响流程（看了还要改） */
  on(type: string, handler: (event: unknown) => unknown): () => void;
  /** 发射事件 —— 通知所有 subscribe 订阅者 */
  emit(event: unknown): void;
}
