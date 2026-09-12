/**
 * JSONL 文件存储 —— 基于 JSON Lines 格式的 Session 持久化实现（会话树模型）。
 * 调用方：main.ts（TTY 会话初始化）、runtime.ts（历史/摘要/分叉/切换）
 * 服务于：把会话历史组织成 append-only 的 entry 树（对齐 Pi）：
 *
 *   - 每条消息是树里的一个 entry（id + parentId），文件顺序 ≠ 对话顺序
 *   - leaf 指针标记"当前在哪条线上"，持久化靠 leaf entry，内存靠 currentLeafId
 *   - compaction entry 承载上下文压缩摘要（旧机制曾有独立的摘要文件，已废弃并入树）
 *   - fork 复制根→leaf 前缀到新文件，原文件不动（审计性）
 *
 * 文件行格式（version 2）：
 *   {"type":"session","version":2,"id":"default","createdAt":"..."}
 *   {"type":"message","id":"m1","parentId":null,"role":"user","content":"...","timestamp":1}
 *   {"type":"message","id":"m2","parentId":"m1","role":"assistant","content":"...","timestamp":2}
 *   {"type":"compaction","id":"c1","parentId":"m4","summary":"...","firstKeptId":"m5","timestamp":3}
 *   {"type":"message","id":"m5","parentId":"c1","role":"user","content":"...","timestamp":4}
 *   {"type":"leaf","id":"lf1","parentId":"m5","targetId":"m5","timestamp":5}
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionStorage } from '../core/storage.js';
import type { CompactionStore } from '../core/compaction-store.js';
import type { LLMMessage, LLMToolCall } from '../llm/types.js';

interface SessionHeader {
  type: 'session';
  version: number;
  id: string;
  createdAt: string;
}

/** 树中的消息节点 */
export interface MessageEntry {
  type: 'message';
  id: string;
  parentId: string | null;
  role: string;
  content: string;
  timestamp: number;
  /** 结构化工具调用（仅 assistant 角色，function calling 时携带） */
  tool_calls?: LLMToolCall[];
  /** 工具调用结果 ID（仅 tool 角色，关联 LLMToolCall.id） */
  tool_call_id?: string;
  /** 工具调用结果对应的工具名（仅 tool 角色） */
  name?: string;
}

/** 上下文压缩节点：承载摘要，替代独立 summary 文件 */
export interface CompactionEntry {
  type: 'compaction';
  id: string;
  parentId: string | null;
  summary: string;
  /** 压缩后保留的第一条消息 id（firstKeptId 之前的内容被摘要顶替） */
  firstKeptId: string;
  timestamp: number;
}

/** 持久化 leaf 指针的节点（open 时重放恢复 currentLeafId） */
interface LeafEntry {
  type: 'leaf';
  id: string;
  parentId: string | null;
  targetId: string;
  timestamp: number;
}

type SessionTreeEntry = MessageEntry | CompactionEntry | LeafEntry;

let sessionCounter = 0;

function nextSessionId(): string {
  sessionCounter++;
  return `session_${Date.now()}_${sessionCounter}`;
}

/** 生成短 entry ID：时间戳后缀 + 递增序号 */
let entryCounter = 0;
function nextEntryId(): string {
  entryCounter++;
  return `e${Date.now().toString(36).slice(-6)}_${entryCounter}`;
}

/** 会话文件扩展名（fork 命名用；目录级识别/校验已搬去 session/jsonl-repo.ts） */
export const SESSION_EXT = '.jsonl';

export class JsonlSessionStorage implements SessionStorage, CompactionStore {
  private filePath: string;
  private header: SessionHeader;
  /** 全部 entry（按追加顺序） */
  private entries: SessionTreeEntry[] = [];
  /** id → entry 索引（回溯用） */
  private byId = new Map<string, SessionTreeEntry>();
  /** 当前分支指针（leaf） */
  private currentLeafId: string | null = null;

  private constructor(filePath: string, header: SessionHeader, entries: SessionTreeEntry[]) {
    this.filePath = filePath;
    this.header = header;
    let lastMessageId: string | null = null;
    for (const e of entries) {
      this.entries.push(e);
      this.byId.set(e.id, e);
      // 重放 leaf entry 恢复当前分支指针（leaf 是最后写入的分支标记）
      if (e.type === 'leaf') this.currentLeafId = e.targetId;
      // 兜底：记录最后一条 message（无 leaf entry 时用最后消息作 leaf）
      if (e.type === 'message') lastMessageId = e.id;
    }
    // 若文件里从未写过 leaf entry（纯 append 线性场景），用最后一条消息作 leaf
    if (this.currentLeafId === null) this.currentLeafId = lastMessageId;
  }

  /** 获取文件路径（供外部读取） */
  getFilePath(): string {
    return this.filePath;
  }

  /** 获取会话目录（供 /sessions 列表/切换/新建复用） */
  getDir(): string {
    return path.dirname(this.filePath);
  }

  /* ════════════════════════════════════════════════════════════════════════════
     树访问核心
     ════════════════════════════════════════════════════════════════════════════ */

  /** 获取当前 leaf 的 entry ID（无消息时 null） */
  getLeafId(): string | null {
    return this.currentLeafId;
  }

  /**
   * 从某 entry 沿 parentId 回溯到根（返回根→该点的路径）。
   * 调用方：getMessages / getHistoryMessages / fork
   */
  getPathToRoot(fromId: string | null): SessionTreeEntry[] {
    if (fromId === null) return [];
    const path: SessionTreeEntry[] = [];
    let current = this.byId.get(fromId);
    if (!current) return [];
    while (current) {
      path.unshift(current);
      if (!current.parentId) break;
      const parent = this.byId.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return path;
  }

  /** 设置当前分支指针（追加 leaf entry 持久化 + 更新内存） */
  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.byId.has(leafId)) return;
    const entry: LeafEntry = {
      type: 'leaf',
      id: nextEntryId(),
      parentId: this.currentLeafId,
      targetId: leafId as string,
      timestamp: Date.now(),
    };
    // 直写落盘（不走 appendLine：appendLine 现在会为实体 entry 自动补 leaf，
    // 而 leaf entry 本身就是分支标记，不能再被补一层）
    await fs.appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.currentLeafId = leafId;
  }

  /** 按 id 查找 entry */
  getEntry(id: string): SessionTreeEntry | undefined {
    return this.byId.get(id);
  }

  /* ════════════════════════════════════════════════════════════════════════════
     消息读写
     ════════════════════════════════════════════════════════════════════════════ */

  /**
   * 追加一条消息到当前分支。
   * 调用方：runtime.ts（用户/助手消息，两处均**不传 extra**）。
   * ⚠ “Agent 循环（tool 结果消息）”这一路**从未接线**：agent-loop.ts 里一处 appendMessage 都没有。
   * 支持 function calling：可传结构化工具调用（tool_calls）或 tool 结果（tool_call_id/name）
   * ——但这条能力至今无人使用，详见 Log/ARCHITECTURE.md 第四节第 9 条。
   */
  async appendMessage(
    role: string,
    content: string,
    extra?: { tool_calls?: LLMToolCall[]; tool_call_id?: string; name?: string },
  ): Promise<void> {
    const entry: MessageEntry = {
      type: 'message',
      id: nextEntryId(),
      parentId: this.currentLeafId,
      role,
      content,
      timestamp: Date.now(),
      ...(extra?.tool_calls ? { tool_calls: extra.tool_calls } : {}),
      ...(extra?.tool_call_id ? { tool_call_id: extra.tool_call_id } : {}),
      ...(extra?.name ? { name: extra.name } : {}),
    };
    await this.appendLine(entry);
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.currentLeafId = entry.id;
  }

  /**
   * 读取当前分支的对话消息（遇 compaction 转成摘要 system 消息）。
   * 调用方：runtime.ts（LLM 上下文）
   * 服务于：让 LLM 看到"当前路径上的历史"，含压缩摘要、结构化工具调用（function calling）
   *
   * **视图裁剪（2026-09-12 修复）**：最后一个 compaction 的 firstKeptId 之前的消息已被摘要
   * 顶替，不再进入 LLM 视图——此前缺这刀，压缩省下的 token 只活一轮（当轮 maybeCompact
   * 裁剪返回，下一轮起这里把全量历史原样端出，旧消息与摘要双份都在）。只认最后一个
   * compaction（与 SystemPromptService 摘要层"取最后一个"同一口径），更早的 compaction
   * entry 被最后一个覆盖、一并出视图；摘要 system 消息提到裁剪窗口开头。
   * ⚠ 其中 tool_calls / tool_call_id / name 的还原在 LLM 路径上**无人消费**：runtime.ts 组装请求时
   * 只取 role + content（那道丢弃是承重的，理由见 Log/ARCHITECTURE.md 第四节第 9 条）。
   */
  async getMessages(): Promise<LLMMessage[]> {
    const pathEntries = this.getPathToRoot(this.currentLeafId).filter((e) => e.type !== 'leaf');

    // 视图裁剪：找最后一个 compaction，从它的 firstKeptId 起保留
    let lastCompIdx = -1;
    for (let i = pathEntries.length - 1; i >= 0; i--) {
      if (pathEntries[i].type === 'compaction') {
        lastCompIdx = i;
        break;
      }
    }
    let render = pathEntries;
    if (lastCompIdx !== -1) {
      const comp = pathEntries[lastCompIdx] as CompactionEntry;
      const keptIdx = pathEntries.findIndex((e) => e.type === 'message' && e.id === comp.firstKeptId);
      if (keptIdx !== -1) {
        // 摘要在前 + 保留窗口（窗口内只留真实消息，更早的 compaction 一并出视图）
        render = [pathEntries[lastCompIdx], ...pathEntries.slice(keptIdx).filter((e) => e.type === 'message')];
      }
      // firstKeptId 指向的消息不在路径上（损坏文件）→ 不裁剪，全量渲染兜底
    }

    return render.map((e): LLMMessage => {
      if (e.type === 'compaction') {
        return { role: 'system', content: `[对话摘要] ${e.summary}` };
      }
      const base: LLMMessage = { role: e.role as LLMMessage['role'], content: e.content };
      if (e.tool_calls) base.tool_calls = e.tool_calls;
      if (e.tool_call_id) base.tool_call_id = e.tool_call_id;
      if (e.name) base.name = e.name;
      return base;
    });
  }

  /** 获取当前分支上的全部真实消息（不含 compaction / leaf）—— 供 /history 展示 */
  getAllStored(): Array<{ msgId: string; role: string; content: string }> {
    return this.getPathToRoot(this.currentLeafId)
      .filter((e): e is MessageEntry => e.type === 'message')
      .map((e) => ({ msgId: e.id, role: e.role, content: e.content }));
  }

  /** 获取当前分支上的全部消息 ID（含 compaction 前的路径）—— 供压缩增量判断 */
  getAllMsgIds(): string[] {
    return this.getPathToRoot(this.currentLeafId)
      .filter((e) => e.type === 'message')
      .map((e) => e.id);
  }

  /** 按 ID 查找原始消息 */
  getMsgById(msgId: string): MessageEntry | undefined {
    const e = this.byId.get(msgId);
    return e?.type === 'message' ? e : undefined;
  }

  /** 追加一个 compaction entry（上下文压缩摘要入树） */
  async appendCompaction(summary: string, firstKeptId: string): Promise<void> {
    const entry: CompactionEntry = {
      type: 'compaction',
      id: nextEntryId(),
      parentId: this.currentLeafId,
      summary,
      firstKeptId,
      timestamp: Date.now(),
    };
    await this.appendLine(entry);
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.currentLeafId = entry.id;
  }

  /** 获取当前分支路径上的全部 compaction entry（供 fork 继承摘要判断） */
  getCompactions(): CompactionEntry[] {
    return this.getPathToRoot(this.currentLeafId)
      .filter((e): e is CompactionEntry => e.type === 'compaction');
  }

  async clear(): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(this.header) + '\n', 'utf-8');
    this.entries = [];
    this.byId.clear();
    this.currentLeafId = null;
  }

  /* ════════════════════════════════════════════════════════════════════════════
     fork
     ════════════════════════════════════════════════════════════════════════════ */

  /**
   * fork：复制"根 → 某 entry"的路径到新会话文件。
   * 调用方：/history 命令（"从此继续"）
   * 服务于：不破坏原历史，长出新分支；新文件含前缀（含 compaction，摘要自动继承）
   *
   * @param forkEntryId 分叉点 entry id（新分支复制到它为止）
   * @returns 新会话的文件名（不含目录）
   */
  async forkTo(forkEntryId: string): Promise<{ fileName: string; storage: JsonlSessionStorage }> {
    const pathEntries = this.getPathToRoot(forkEntryId);
    if (pathEntries.length === 0) throw new Error(`Entry ${forkEntryId} not found`);

    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath, SESSION_EXT);
    const newName = `${base}-fork-${Date.now().toString(36).slice(-5)}${SESSION_EXT}`;
    const newPath = path.join(dir, newName);

    // 新 header
    const header: SessionHeader = {
      type: 'session',
      version: 2,
      id: newName,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(newPath, JSON.stringify(header) + '\n', 'utf-8');

    // 复制前缀路径（保持 id/parentId，追加进新文件）
    for (const e of pathEntries) {
      if (e.type === 'leaf') continue; // 前缀不含 leaf（leaf 是当前线标记，不复制）
      await fs.appendFile(newPath, JSON.stringify(e) + '\n', 'utf-8');
    }
    // 新分支的 leaf 指向最后复制的 entry
    const last = pathEntries[pathEntries.length - 1];
    if (last.type !== 'leaf') {
      const leaf: LeafEntry = {
        type: 'leaf',
        id: nextEntryId(),
        parentId: last.id,
        targetId: last.id,
        timestamp: Date.now(),
      };
      await fs.appendFile(newPath, JSON.stringify(leaf) + '\n', 'utf-8');
    }

    return { fileName: newName, storage: await JsonlSessionStorage.open(newPath) };
  }

  /* ════════════════════════════════════════════════════════════════════════════
     静态工厂 + 会话目录管理
     ════════════════════════════════════════════════════════════════════════════ */

  static async create(sessionsDir: string, fileName?: string): Promise<JsonlSessionStorage> {
    await fs.mkdir(sessionsDir, { recursive: true });
    const id = nextSessionId();
    const name = fileName
      ? (fileName.endsWith(SESSION_EXT) ? fileName : `${fileName}${SESSION_EXT}`)
      : `${id}${SESSION_EXT}`;
    const filePath = path.join(sessionsDir, name);
    const header: SessionHeader = {
      type: 'session',
      version: 2,
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
    if (header.version !== 2) throw new Error(`不支持的会话格式 version=${header.version}（v1 线性格式已废弃，请删除旧文件后重试）`);

    const entries: SessionTreeEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = JSON.parse(lines[i]) as SessionTreeEntry;
      entries.push(line);
    }
    return new JsonlSessionStorage(filePath, header, entries);
  }

  /* ── 私有 ── */

  private async appendLine(entry: SessionTreeEntry): Promise<void> {
    await fs.appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    // 当前分支指针随追加落盘（2026-09-12 修复）：此前只有 forkTo 写过一次 leaf，
    // appendMessage/appendCompaction 只追加实体行——fork 文件里那条 leaf 从此永远是旧的，
    // 重开后 currentLeafId 回退到 fork 点，fork 之后聊的消息与压缩摘要**全部从视图里消失**
    //（create 出来的文件无 leaf、走"最后一条消息"兜底，所以既有测试没抓到）。
    // 现在文件最后一行永远是 leaf 标记，重开重放即恢复到最新位置。
    const leaf: LeafEntry = {
      type: 'leaf',
      id: nextEntryId(),
      parentId: entry.id,
      targetId: entry.id,
      timestamp: Date.now(),
    };
    await fs.appendFile(this.filePath, JSON.stringify(leaf) + '\n', 'utf-8');
  }
}
