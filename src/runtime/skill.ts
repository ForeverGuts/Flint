/**
 * Skill 接口与加载器 —— 管理 skills/ 目录下的技能文件。
 * 调用方：runtime.ts（expandSkill 时通过 SkillLoader 读取）
 * 服务于：提供 Skill 元数据、文件解析、热重载支持
 */
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { Loader } from './loader.js';

/* ── 类型定义 ── */

/** Skill YAML Frontmatter（用户可在 .md 文件顶部定义） */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  'disable-model-invocation'?: boolean;
  [key: string]: unknown;
}

/** Skill 对象 —— 单个技能的完整定义 */
export interface Skill {
  /** 技能名称（用于 /skill:名称 调用） */
  name: string;
  /** 技能描述 */
  description: string;
  /** 文件路径 */
  filePath: string;
  /** 所属目录 */
  baseDir: string;
  /** 是否禁止 LLM 调用（纯工具类 skill 可设为 true） */
  disableModelInvocation: boolean;
  /** 技能正文（不含 frontmatter） */
  body: string;
  /** 原始 frontmatter */
  frontmatter: SkillFrontmatter;
}

/** 加载结果 */
export interface LoadSkillsResult {
  skills: Skill[];
}

/** 热重载通知载荷：新清单 + 与上一份清单的增删差 */
export interface SkillChange {
  result: LoadSkillsResult;
  /** 新增的技能名 */
  added: string[];
  /** 消失的技能名 */
  removed: string[];
}

/* ── Frontmatter 解析 ── */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const frontmatter: SkillFrontmatter = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (value === 'true' || value === 'false') {
      frontmatter[key] = value === 'true';
    } else {
      frontmatter[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter, body: match[2].trim() };
}

/* ── SkillLoader（继承 Loader 基类） ── */

export class SkillLoader extends Loader<LoadSkillsResult> {
  private skills: Skill[] = [];
  /** 热重载观察者（TaskStore.onChange 同款零依赖回调集合，刻意不走事件总线） */
  private listeners = new Set<(change: SkillChange) => void>();
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseDir: string) {
    super(baseDir);
  }

  /** 加载 skills/ 目录下所有 .md 文件 */
  load(): LoadSkillsResult {
    this.skills = [];
    const files = this.scanFiles('skills', '.md');
    for (const filePath of files) {
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);
        const skillName = frontmatter.name ?? filePath.split(/[/\\]/).pop()?.replace('.md', '') ?? '';
        this.skills.push({
          name: skillName,
          description: frontmatter.description ?? '',
          filePath,
          baseDir: this.baseDir,
          disableModelInvocation: frontmatter['disable-model-invocation'] ?? false,
          body,
          frontmatter,
        });
      } catch {
        // 加载失败跳过
      }
    }
    return { skills: this.skills };
  }

  /** 按名称查找 skill */
  get(name: string): Skill | undefined {
    return this.skills.find((s) => s.name === name);
  }

  /** 获取所有 skills */
  getAll(): Skill[] {
    return [...this.skills];
  }

  /* ── 热重载 ── */

  /**
   * 订阅热重载通知，返回退订函数。
   * 谁通知 UI 的答案（2026-09-12 拍板）：提示词层**每轮 build 现取 getAll()**（runtime.ts），
   * 内存清单一刷新 LLM 侧自动生效——观察者只服务 UI 提示（TreeUI 挂一行提示），LLM 侧零接线。
   */
  onChange(listener: (change: SkillChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 重新加载并通知观察者（热重载路径专用；启动期 load() 不通知，见下） */
  reload(): SkillChange {
    const before = new Set(this.skills.map((s) => s.name));
    const result = this.load();
    const after = result.skills.map((s) => s.name);
    const change: SkillChange = {
      result,
      added: after.filter((n) => !before.has(n)),
      removed: [...before].filter((n) => !after.includes(n)),
    };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // 观察者异常不拖垮加载器（fail-open：钩子是基础设施不是策略，同 tool-hooks 一脉）
      }
    }
    return change;
  }

  /**
   * 开始监听 skills 目录（零依赖 fs.watch）。
   * persistent:false —— watcher 不独自撑住事件循环，进程退出不需要显式 stop；
   * 防抖 300ms —— 编辑器保存一次往往触发一串 change/rename 事件，只重载一次。
   */
  startWatch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.dirFor('skills'), { persistent: false }, () => this.scheduleReload());
      // 目录被删等错误：静默退场（内存清单保持旧值，LLM 继续用旧视图——fail-safe 优于崩溃）
      this.watcher.on('error', () => this.stopWatch());
    } catch {
      this.watcher = null; // 目录不存在：照旧用启动清单
    }
  }

  /** 停止监听（测试 / 优雅收尾用） */
  stopWatch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** 是否正在监听（验证套件用） */
  get watching(): boolean {
    return this.watcher !== null;
  }

  /** 防抖：窗口内最后一次事件触发一次 reload */
  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reload();
    }, 300);
  }

  // TODO: 依赖追踪 — addDependency / getDependents
}
