/**
 * Session 会话管理 —— LLM 对话消息的存取。
 * 调用方：runtime.ts（通过 SessionStorage 接口调用）
 * 服务于：提供 InMemorySession 作为默认实现，预留 mock 空间
 */
import type { SessionStorage } from '../core/storage.js';

export class InMemorySession implements SessionStorage {
  private messages: Array<{ role: string; content: string }> = [];

  async appendMessage(role: string, content: string): Promise<void> {
    this.messages.push({ role, content });
  }

  async getMessages(): Promise<Array<{ role: string; content: string }>> {
    return [...this.messages];
  }

  async clear(): Promise<void> {
    this.messages = [];
  }
}
