/**
 * 命令加载器 —— 自动扫描 commands/builtin/ 目录，动态 import 所有内置命令。
 *
 * 每个 .ts 文件只要导出 activate(runtime) 函数，就会被自动加载。
 * 新增命令不需要修改任何项目代码，只需在 commands/builtin/ 下新建文件。
 */
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Runtime } from '../runtime/runtime.js';
import { Loader } from '../runtime/loader.js';

interface ActivateModule {
  activate?: (runtime: Runtime) => void;
}

export class CommandLoader extends Loader<void> {
  constructor(private runtime: Runtime) {
    super(dirname(fileURLToPath(import.meta.url)));
  }

  async load(): Promise<void> {
    const files = this.scanFiles('builtin', '.ts');
    for (const file of files) {
      try {
        const mod: ActivateModule = await import(pathToFileURL(file).href);
        if (mod.activate) mod.activate(this.runtime);
      } catch {
        // 加载失败跳过
      }
    }
  }
}

/** 向下兼容的快捷函数 */
export async function registerBuiltinCommands(runtime: Runtime): Promise<void> {
  const loader = new CommandLoader(runtime);
  await loader.load();
}
