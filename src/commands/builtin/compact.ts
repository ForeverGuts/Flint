/**
 * /compact 命令 —— 手动压缩上下文（ROADMAP 10.8.4），压缩前自动把原文整份留档。
 *
 * 为什么压缩要能手动触发：自动压缩只在历史超 20 条时发生，而"我现在就想让上下文短一点"
 * 是另一回事 —— 比如刚结束一段调研、接下来要换话题，那 20 条里的内容对后面已经没用了。
 *
 * 为什么留档是这条命令的一部分而不是可选项：压缩**不可逆**（摘要是有损的、没有可回滚的
 * 基线）。留档写不进去时命令**拒绝压缩**并把原因念出来 —— 见 `compact-snapshot.ts` 文件头。
 *
 * 用法：
 *   /compact            —— 保留最近 10 条（与自动压缩同口径）
 *   /compact keep=5     —— 保留最近 5 条
 *   /compact 0          —— 全压（上下文里只剩摘要）
 */
import type { Runtime } from '../../runtime/runtime.js';
import { parseCompactArgs, renderCompactReceipt } from '../../context/compact-snapshot.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand(
    'compact',
    '手动压缩上下文（压缩前自动留档到 .flint/snapshots/，可用 keep=N 指定保留条数）',
    async (args) => {
      const parsed = parseCompactArgs(args);
      if (!parsed.ok) {
        return `用法：/compact [keep=N]（N = 压缩后保留最近几条，缺省 10；N=0 表示全压）\n`
          + `❌ ${parsed.error}`;
      }
      const r = await runtime.compactSession(
        parsed.keep === null ? {} : { keepRecent: parsed.keep },
      );
      return renderCompactReceipt(r);
    },
  );
}
