/**
 * Mock Session 存储 —— 测试专用，不依赖真实存储逻辑。
 * 调用方：测试文件
 * 服务于：替换 InMemorySession，隔离业务逻辑与存储实现
 */
import type { SessionStorage } from '../core/storage.js';

export class MockSession implements SessionStorage {
  public messages: Array<{ role: string; content: string }> = [];

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
