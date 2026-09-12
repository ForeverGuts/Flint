/**
 * JSONL 会话仓库层 —— sessions/ 目录级管理（列表/打开/新建/删除）。
 * 调用方：main.ts（组装注入）、runtime.ts（会话管理命令委托）
 * 服务于：ROADMAP P6「会话仓库层」——从 JsonlSessionStorage（单会话存储）里抽出
 *         目录级操作，并补上此前完全缺失的**删除**能力。对标 Pi 的 jsonl-repo.ts。
 *
 * 职责边界：本类不碰单个会话文件内部（entry 树 / leaf / compaction 那套在
 * JsonlSessionStorage），只做"目录里有哪些文件、打开哪一个、删掉哪一个"。
 *
 * 删除的安全设计（两层）：
 *   ① repo 层：文件名白名单校验（isRemovableSessionName）——必须是 .jsonl 结尾、
 *      不含 _summary、不含路径分隔符与 ..，堵住路径穿越；
 *   ② Runtime 层：deleteSession 拒绝删除**当前活跃会话**（先切换再删），
 *      否则 this.session 指向一个已被 unlink 的文件，后续 append 全部静默丢失。
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { SessionStorage } from '../core/storage.js';
import type { SessionInfo, SessionRepo } from '../core/session-repo.js';
import { JsonlSessionStorage, SESSION_EXT } from './jsonl-storage.js';

/** 会话文件扩展名识别（从 jsonl-storage 的 listAll 搬来，repo 层唯一使用方） */
export function isSessionFileName(name: string): boolean {
  return name.endsWith(SESSION_EXT) && !name.includes('_summary');
}

/**
 * 可删除的会话文件名白名单（纯函数，verify-repo 逐形状喂）。
 * 比 isSessionFileName 更严：额外拒绝路径分隔符与 ..（路径穿越防护）。
 */
export function isRemovableSessionName(name: string): boolean {
  if (!isSessionFileName(name)) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('..')) return false;
  return true;
}

export class JsonlSessionRepo implements SessionRepo {
  private sessionsDir: string;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  getDir(): string {
    return this.sessionsDir;
  }

  /** 列出 sessions/ 下所有会话文件信息（原 JsonlSessionStorage.listAll 的逻辑整体搬入） */
  async list(): Promise<SessionInfo[]> {
    const results: SessionInfo[] = [];
    try {
      const files = await fs.readdir(this.sessionsDir);
      for (const name of files) {
        if (!isSessionFileName(name)) continue;
        const full = path.join(this.sessionsDir, name);
        try {
          const storage = await JsonlSessionStorage.open(full);
          const msgs = storage.getAllStored();
          const stat = fsSync.statSync(full);
          results.push({ fileName: name, msgCount: msgs.length, updatedAt: stat.mtimeMs });
        } catch {
          // 单个文件损坏/格式不符 → 跳过
        }
      }
    } catch {
      // sessions 目录不存在 → 空列表
    }
    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results;
  }

  async open(fileName: string): Promise<SessionStorage> {
    return JsonlSessionStorage.open(path.join(this.sessionsDir, fileName));
  }

  /**
   * 新建空会话。文件名规范化从 runtime.createSession 搬来（缺省名自动生成、
   * 缺 .jsonl 后缀自动补）；返回规范化后的文件名——此前 runtime 需要自己拼一遍
   * 才能拿到它，repo 层收拢后调用方不必重复推导。
   */
  async create(fileName?: string): Promise<{ fileName: string; storage: SessionStorage }> {
    const name = fileName
      ? (fileName.endsWith(SESSION_EXT) ? fileName : `${fileName}${SESSION_EXT}`)
      : `session-${Date.now().toString(36)}${SESSION_EXT}`;
    const storage = await JsonlSessionStorage.create(this.sessionsDir, name);
    return { fileName: name, storage };
  }

  async remove(fileName: string): Promise<boolean> {
    if (!isRemovableSessionName(fileName)) {
      throw new Error(`非法的会话文件名: ${fileName}`);
    }
    const full = path.join(this.sessionsDir, fileName);
    try {
      await fs.unlink(full);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      throw err;
    }
  }
}
