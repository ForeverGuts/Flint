/**
 * Skill 接口与加载器 —— 管理 skills/ 目录下的技能文件。
 * 调用方：runtime.ts（expandSkill 时通过 SkillLoader 读取）
 * 服务于：提供 Skill 元数据、文件解析、热重载支持
 */
import { readFileSync } from 'node:fs';
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

  // TODO: 热重载 — startWatch / stopWatch
  // TODO: 依赖追踪 — addDependency / getDependents
}
