/**
 * /charter 命令 —— 项目生命周期三件套的状态查看与**契约解锁**。
 * 调用方：commands/loader.ts 自动扫描（本目录每个导出 activate 的文件都会被加载）
 * 服务于：给用户一个**显式的开门动作** —— 目标文档（.flint/CHARTER.md）立项后冻结，
 *         模型改不动它（见 project/charter.ts 的程序闸），只有这里的 unlock 能解。
 *
 * 参数（空格后第一个词）：
 *   /charter           看三件套现状 + 当前锁状态
 *   /charter unlock    解锁目标文档（**本会话**有效；进程结束自动回锁）
 *   /charter lock      立即回锁
 *
 * 为什么解锁不接权限弹窗：权限弹窗的语义是"这次调用要不要做"，而契约要回答的是
 * "要不要解这把锁"。合成一件事，一次"本次全部允许"就会把锁静默打开（决策 C11）。
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Runtime } from '../../runtime/runtime.js';
import { CHARTER_FILE, DEVLOG_FILE, PROJECT_FILE, charterLock } from '../../project/charter.js';

/** 数开发文件里已归档多少个坐标（`## ` 小节数）。文件不存在或读不动 → -1。 */
function devlogSections(): number {
  if (!existsSync(DEVLOG_FILE)) return -1;
  try {
    return (readFileSync(DEVLOG_FILE, 'utf8').match(/^## /gm) ?? []).length;
  } catch {
    return -1;
  }
}

export function activate(runtime: Runtime): void {
  runtime.registerCommand('charter', '项目生命周期：三件套状态 + 目标文档解锁', (args: string) => {
    const cmd = (args.trim().split(/\s+/)[0] ?? '').toLowerCase();

    if (cmd === 'unlock') {
      charterLock.unlock();
      return `🔓 已解锁 ${CHARTER_FILE}（本会话有效）。现在可以改目标文档了；改完建议 /charter lock 立即回锁。`;
    }
    if (cmd === 'lock') {
      charterLock.lock();
      return `🔒 已回锁 ${CHARTER_FILE}。`;
    }
    if (cmd !== '' && cmd !== 'show') {
      return `未知参数 "${cmd}"。用法：/charter ｜ /charter unlock ｜ /charter lock`;
    }

    const charterExists = existsSync(CHARTER_FILE);
    const projectExists = existsSync(PROJECT_FILE);
    const sections = devlogSections();
    const lockState = charterLock.isUnlocked() ? '🔓 已解锁（本会话）' : '🔒 已锁';
    const devlogNote = sections >= 0 ? ` · ${sections} 个坐标` : '';

    return [
      '项目生命周期（.flint/ 下，中大型项目才走这套）：',
      `  ${charterExists ? '✅' : '⬜'} ${CHARTER_FILE}  目标策划案（契约）${charterExists ? '' : ' · 未立项'}`,
      `  ${projectExists ? '✅' : '⬜'} ${PROJECT_FILE}  现状文档（快照）`,
      `  ${sections >= 0 ? '✅' : '⬜'} ${DEVLOG_FILE}  开发记录（追加）${devlogNote}`,
      '',
      `契约锁：${lockState}（改 CHARTER.md 会被程序拒绝，直到 /charter unlock）`,
      '分工：目标 = 契约（改需解锁）· 现状 = 快照（随代码改）· 开发 = 追加（只增不改）',
      '用法：/charter unlock 解锁目标文档（本会话有效）｜/charter lock 立即回锁',
      ...(charterExists || projectExists || sections >= 0
        ? []
        : ['', '三件套都还没有：立项时先写 CHARTER.md（目标/范围/验收标准/明确不做什么）与 PROJECT.md（当前系统构成）。']),
    ].join('\n');
  });
}
