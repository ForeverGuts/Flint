/**
 * /memory 命令 —— 回看项目长期记忆（.flint/memory.md 的内存真相源）。
 *
 * 调用方：commands/loader.ts 自动扫描（本目录每个导出 activate 的文件都会被加载）
 *
 * 与 /tasks 同一分工：命令读**内存真相源**（运行期文件只是投影 + 跨重启存档），
 * 所以看到的就是模型每次请求注入 memory 层的同一份内容（截断除外——注入侧 2000 字符截断）。
 * 支持可选参数：`/memory <关键词>` 按子串过滤（不分大小写），条目多时快速定位。
 */
import type { Runtime } from '../../runtime/runtime.js';
import { memoryStore } from '../../memory/store.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('memory', '查看项目长期记忆（跨会话持久的约定/决策/坑）', (args: string) => {
    const items = memoryStore.list();
    if (items.length === 0) {
      return `项目记忆为空（${'.flint/memory.md'} 不存在或无条目）。用 memory 工具 op:"add" 沉淀项目约定/决策/坑。`;
    }
    const kw = args.trim().toLowerCase();
    const hits = kw
      ? items.map((t, i) => ({ t, i: i + 1 })).filter(({ t }) => t.toLowerCase().includes(kw))
      : items.map((t, i) => ({ t, i: i + 1 }));
    if (hits.length === 0) return `项目记忆共 ${items.length} 条，无含"${args.trim()}"的条目。`;
    const head = kw
      ? `项目记忆匹配 ${hits.length}/${items.length} 条（关键词"${args.trim()}"）：`
      : `项目记忆（${items.length} 条，跨会话持久，每次请求注入）：`;
    return [head, ...hits.map(({ t, i }) => `${i}. ${t}`)].join('\n');
  });
}
