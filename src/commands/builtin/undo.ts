/**
 * /undo 命令 —— 还原被 `trash` 删掉的东西（ROADMAP 10.9.6）。
 *
 * 为什么删除需要一条还原命令：危险闸（10.9.2）当年的判决书是"**删除不可逆，所以只能有 L1、
 * 没有 L2**"。回收站把这句话翻过来 —— 删除照旧发生，但留下一份**可以比对、可以回滚的基线**
 * （`.flint/trash/` 里的实体 + manifest 里的一笔）。`/undo` 就是那个回滚动作。
 *
 * 用法：
 *   /undo        还原最近一笔（栈式：后删的先还原）
 *   /undo list   列出待还原的清单（最近 10 笔）
 *
 * 顺带做的唯一一件事：**清理超期的**（超过 `PRUNE_AFTER_DAYS` 天还没还原的）。
 * 放在这里而不是每次 trash 都跑，是因为清理要遍历整个 manifest —— 删东西是高频动作、
 * 翻清单是低频动作，跟着低频那次跑不碍事。
 */
import type { Runtime } from '../../runtime/runtime.js';
import {
  PRUNE_AFTER_DAYS, TRASH_DIR, pendingRecords, pruneTrash, undoLast,
} from '../../tools/trash-bin.js';

/** 清单最多列几笔（多了没人看，且真正的出口是 /undo 本身） */
const LIST_MAX = 10;

export function activate(runtime: Runtime): void {
  runtime.registerCommand(
    'undo',
    '还原被 trash 删掉的东西（/undo = 还原最近一笔，/undo list = 看清单）',
    async (args) => {
      const arg = args.trim();
      if (arg === 'list') {
        const pruned = pruneTrash(process.cwd());
        const lines = pendingRecords(process.cwd())
          .slice(-LIST_MAX)
          .reverse()
          .map((r, i) => `  ${i + 1}. ${r.time.slice(0, 19).replace('T', ' ')}  ${r.from}`
            + `${r.isDir ? '（目录）' : `（${r.bytes} 字节）`}`);
        const head = lines.length === 0
          ? `回收站是空的（${TRASH_DIR}/）—— 没有待还原的东西。`
          : `待还原 ${pendingRecords(process.cwd()).length} 笔，最近 ${lines.length} 笔：`;
        const tail = pruned > 0
          ? `\n  （顺带清掉了 ${pruned} 笔超过 ${PRUNE_AFTER_DAYS} 天未还原的。）`
          : '';
        return [head, ...lines].join('\n') + tail;
      }
      if (arg !== '') {
        return `用法：/undo 或 /undo list\n❌ 不认识的参数「${arg}」`;
      }

      const pruned = pruneTrash(process.cwd());
      const r = undoLast(process.cwd());
      const tail = pruned > 0
        ? `\n  （顺带清掉了 ${pruned} 笔超过 ${PRUNE_AFTER_DAYS} 天未还原的。）`
        : '';
      if (!r.ok) {
        // EMPTY 是常态、不是错误 —— 别报成失败吓人一跳
        return r.code === 'EMPTY'
          ? `回收站是空的（${TRASH_DIR}/）—— 没有可还原的东西。` + tail
          : `❌ 还原失败：${r.message}` + tail;
      }
      return `✅ 已还原: ${r.record.from}\n`
        + `  从 ${r.record.to} 取回（回收于 ${r.record.time.slice(0, 19).replace('T', ' ')}）` + tail;
    },
  );
}
