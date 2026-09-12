/**
 * 加载器抽象 —— 统一目录扫描 + 文件加载的通用逻辑。
 * 子类只需实现 load()，具体处理每个文件的加载结果。
 *
 * 当前子类：
 *   - CommandLoader（commands.ts） — 扫描 .ts 文件，import + activate
 *   - SkillLoader（skill.ts）      — 扫描 .md 文件，解析 frontmatter
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export abstract class Loader<T> {
  constructor(protected baseDir: string) {}

  /** 子目录的完整路径 —— scanFiles 与子类的热重载 watcher 共用同一拼法（防两处拼法漂移） */
  protected dirFor(subDir: string): string {
    return join(this.baseDir, subDir);
  }

  /** 扫描目录中指定扩展名的文件 */
  protected scanFiles(subDir: string, ext: string): string[] {
    const dir = this.dirFor(subDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => join(dir, f));
  }

  /** 子类实现：处理扫描到的文件路径列表 */
  abstract load(): T | Promise<T>;
}
