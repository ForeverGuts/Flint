/**
 * ProjectRegistry —— 项目注册表（跨项目检索的"电话簿"）。
 * 调用方：harness/main.ts（启动时登记当前项目）、tools/builtin.ts（pull_events 解析目标项目）
 * 服务于：flint 面向编程 Agent 后的**跨项目经验拉取**——在项目 B 里翻项目 A 踩过的坑。
 *
 * ── 身份取舍（为什么没有项目 ID）──
 *   项目身份 = **cwd**（同目录 = 同项目 = 同一份 .flint/），零管理、无发号、无撞号。
 *   本注册表只做"路径 ↔ 名称"的本地映射，让模型用短名（目录名）指路，不必背绝对路径。
 *   **路径做本机身份，文件做可移植载体**：events.jsonl 条目自包含（不嵌路径），
 *   把叙事文件拷给别人 = 对方放进自己项目的 .flint/ 即完成导入；注册表是各人本机私物。
 *
 * ── 数据形状 ──
 *   ~/.flint/projects.jsonl，一行一条：{ path, name, firstSeen }
 *   path 归一成正斜杠绝对路径（Windows 反斜杠归一，与 permissionKey 同一手清）。
 *
 * ── 一致性口径 ──
 *   与 EventStore 同款：启动/首用时全量载入内存，运行期不回读；登记 = appendFileSync 追加，
 *   失败静默（登记是旁路便利，不该炸主流程）。重复登记（同 path）跳过——幂等。
 *
 * 零运行时依赖：只用 node:fs / node:path（内置）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { GLOBAL_DIR } from '../config/manager.js';

/**
 * 注册表落点（全局目录，跨项目共享）。
 *
 * 测试可用 `FLINT_PROJECTS_FILE` 指向临时文件 —— 与 `FLINT_TRACE_FILE` / `FLINT_CONFIG`
 * 同一手法：**用的时候现读环境变量**，于是脚本在 import 之后设置也来得及（ESM 的 import
 * 会被提升到文件顶部，写死在模块加载期的常量拿不到脚本里设的值）。
 * 这条不是可有可无的便利：验证套件要真跑一次"切到别的项目"（ROADMAP 10.11.1），
 * 而登记是切换流程里必然发生的一步——没有这个开关，每跑一次套件就会往**用户真实的**
 * `~/.flint/projects.jsonl` 里塞几个临时目录。
 */
export function projectsFilePath(): string {
  return process.env.FLINT_PROJECTS_FILE || path.join(GLOBAL_DIR, 'projects.jsonl');
}

export interface ProjectRecord {
  /** 归一化绝对路径（正斜杠）——本机身份 */
  path: string;
  /** 短名 = 目录 basename（模型指路用；重名时靠 path 区分） */
  name: string;
  firstSeen: string;
}

/**
 * 路径归一：绝对化 + 反斜杠转正斜杠 + 去尾斜杠（`C:/a/b/` 与 `C:/a/b` 同一项目）。
 *
 * **导出**是为了让 `/projects`（ROADMAP 10.11.1）能拿"当前 cwd"与注册表里的 path
 * 用**同一把尺子**比对（`process.cwd()` 自带反斜杠、可能带尾斜杠）；
 * 各写一份归一化，迟早出现"列表里同时存在当前项目和它的另一个写法"。
 */
export function normalizeProjectPath(p: string): string {
  const abs = path.resolve(p.trim());
  return abs.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

export class ProjectRegistry {
  private records: ProjectRecord[] = [];
  private loaded = false;

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(projectsFilePath())) return;
      for (const line of readFileSync(projectsFilePath(), 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as ProjectRecord;
          if (typeof raw?.path === 'string' && typeof raw?.name === 'string') {
            this.records.push(raw);
          }
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 读取失败 → 空注册表 */ }
  }

  /** 只读快照（防御性拷贝，登记顺序 = 首见顺序）。 */
  list(): ProjectRecord[] {
    this.load();
    return this.records.map((r) => ({ ...r }));
  }

  /**
   * 登记一个项目（幂等：已登记的 path 跳过）。落盘失败返回错误信息（成功 undefined）。
   * 调用点：main.ts 启动时登记 cwd——"用过 flint 的项目"就是值得列出的全集。
   */
  ensure(dir: string): string | undefined {
    this.load();
    const p = normalizeProjectPath(dir);
    if (this.records.some((r) => r.path === p)) return undefined;
    const record: ProjectRecord = {
      path: p,
      name: path.basename(p) || p,
      firstSeen: new Date().toISOString(),
    };
    this.records.push(record);
    try {
      mkdirSync(path.dirname(projectsFilePath()), { recursive: true });
      appendFileSync(projectsFilePath(), `${JSON.stringify(record)}\n`, 'utf-8');
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * 解析 pull_events 的 project 参数：绝对/相对路径 → 归一化；短名 → 注册表里按 name 匹配
   * （重名取**最先登记**的——确定性优先）。返回归一化路径，解析不到返回 undefined。
   */
  resolve(query: string): string | undefined {
    this.load();
    const q = query.trim();
    if (!q) return undefined;
    // 带路径分隔符或盘符的一律当路径（存在与否交给调用方检查——路径不强制已登记）
    if (/[\\/]/.test(q) || /^[a-zA-Z]:/.test(q)) return normalizeProjectPath(q);
    const hit = this.records.find((r) => r.name === q);
    return hit?.path;
  }
}

/** 进程级默认实例 —— 与 taskStore / memoryStore / eventStore 同一手法。 */
export const projectRegistry = new ProjectRegistry();
