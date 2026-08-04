/**
 * JSONL 文件存储 —— 基于 JSON Lines 格式的 Session 持久化实现。
 * 每条消息有唯一 ID，支持压缩后追溯原始内容。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionStorage } from '../types.js';

interface SessionHeader {
  type: 'session';
  version: number;
  id: string;
  createdAt: string;
}

interface MessageLine {
  type: 'message';
  msgId: string;
  role: string;
  content: string;
  timestamp: number;
}

interface StoredMessage {
  msgId: string;
  role: string;
  content: string;
}

let sessionCounter = 0;

function nextSessionId(): string {
  sessionCounter++;
  return `session_${Date.now()}_${sessionCounter}`;
}

/** 生成短消息 ID：时间戳后缀 + 递增序号 */
let msgCounter = 0;
function nextMsgId(): string {
  msgCounter++;
  return `m${Date.now().toString(36).slice(-6)}_${msgCounter}`;
}

export class JsonlSessionStorage implements SessionStorage {
  private filePath: string;
  private stored: StoredMessage[] = [];
  private header: SessionHeader;

  private constructor(filePath: string, header: SessionHeader, stored: StoredMessage[]) {
    this.filePath = filePath;
    this.header = header;
    this.stored = stored;
  }

  /** 获取文件路径（供外部读取压缩摘要等） */
  getFilePath(): string {
    return this.filePath;
  }

  /** 获取所有消息的 ID 列表 */
  getAllMsgIds(): string[] {
    return this.stored.map((m) => m.msgId);
  }

  /** 获取全部存储消息（含 msgId）—— 供 /history 命令展示与回溯 */
  getAllStored(): Array<{ msgId: string; role: string; content: string }> {
    return [...this.stored];
  }

  /**
   * 删除某条之后的所有消息（不含该条本身）。
   * 调用方：/history 命令（"从此继续"回溯）
   * 服务于：回到历史某点，删除之后的对话，让 LLM 从该点重新生成
   */
  async truncateAfter(msgId: string): Promise<void> {
    const idx = this.stored.findIndex((m) => m.msgId === msgId);
    if (idx === -1) return;
    this.stored = this.stored.slice(0, idx + 1);
    await this.rewriteFile();
  }

  /**
   * 替换某条消息的内容。
   * 调用方：/history 命令（"编辑"）
   * 服务于：修正历史中的某条消息，配合 truncateAfter 让后续对话作废重来
   */
  async updateMessage(msgId: string, content: string): Promise<void> {
    const m = this.stored.find((x) => x.msgId === msgId);
    if (!m) return;
    m.content = content;
    await this.rewriteFile();
  }

  /** 按 ID 查找原始消息 */
  getMsgById(msgId: string): StoredMessage | undefined {
    return this.stored.find((m) => m.msgId === msgId);
  }

  static async create(sessionsDir: string, fileName?: string): Promise<JsonlSessionStorage> {
    await fs.mkdir(sessionsDir, { recursive: true });
    const id = nextSessionId();
    const name = fileName ? (fileName.endsWith('.jsonl') ? fileName : `${fileName}.jsonl`) : `${id}.jsonl`;
    const filePath = path.join(sessionsDir, name);
    const header: SessionHeader = {
      type: 'session',
      version: 1,
      id: fileName ?? id,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(filePath, JSON.stringify(header) + '\n', 'utf-8');
    return new JsonlSessionStorage(filePath, header, []);
  }

  static async open(filePath: string): Promise<JsonlSessionStorage> {
    const raw = await fs.readFile(filePath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length === 0) throw new Error(`Empty session file: ${filePath}`);

    const header = JSON.parse(lines[0]) as SessionHeader;
    if (header.type !== 'session') throw new Error(`Invalid session file: ${filePath}`);

    const stored: StoredMessage[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = JSON.parse(lines[i]) as MessageLine;
      if (line.type === 'message') {
        stored.push({ msgId: line.msgId ?? `m_legacy_${i}`, role: line.role, content: line.content });
      }
    }

    return new JsonlSessionStorage(filePath, header, stored);
  }

  async appendMessage(role: string, content: string): Promise<void> {
    const msgId = nextMsgId();
    const line: MessageLine = {
      type: 'message',
      msgId,
      role,
      content,
      timestamp: Date.now(),
    };
    await fs.appendFile(this.filePath, JSON.stringify(line) + '\n', 'utf-8');
    this.stored.push({ msgId, role, content });
  }

  async getMessages(): Promise<Array<{ role: string; content: string }>> {
    return this.stored.map((m) => ({ role: m.role, content: m.content }));
  }

  async clear(): Promise<void> {
    const headerLine = JSON.stringify(this.header) + '\n';
    await fs.writeFile(this.filePath, headerLine, 'utf-8');
    this.stored = [];
  }

  /** 重写整个文件（header + 当前全部消息）—— truncateAfter / updateMessage 用 */
  private async rewriteFile(): Promise<void> {
    const headerLine = JSON.stringify(this.header) + '\n';
    const msgLines = this.stored.map((m) =>
      JSON.stringify({ type: 'message', msgId: m.msgId, role: m.role, content: m.content }) + '\n',
    );
    await fs.writeFile(this.filePath, headerLine + msgLines.join(''), 'utf-8');
  }
}
