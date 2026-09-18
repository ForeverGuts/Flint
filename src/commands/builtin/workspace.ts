/**
 * /workspace 命令 —— 工作区边界的查看与**放行**（ROADMAP 10.9.3）。
 * 调用方：commands/loader.ts 自动扫描（本目录每个导出 activate 的文件都会被加载）
 * 服务于：给用户一个**显式的开门动作** —— write / edit 默认只能写工作区（cwd）之内，
 *         要写到项目外面必须先由用户在这里点名放行。模型自己开不了（见 permission/workspace.ts）。
 *
 * 参数（空格后第一个词）：
 *   /workspace                看工作区根 + 本会话已放行的目录
 *   /workspace allow <目录>   放行该目录**及其子树**（本会话有效；路径可含空格）
 *   /workspace clear          收回全部放行
 *
 * 为什么放行不接权限弹窗：权限弹窗的语义是"这次调用要不要做"，而这里要回答的是
 * "要不要放开这条边界"；合成一件事，非 TTY 下弹窗自动放行就会让边界**静默失效**
 * （详见 permission/workspace.ts 文件头）。
 *
 * 为什么本文件可以碰 fs 而判据不能：判据要对"还不存在的目标文件"下结论（write 会创建它），
 * 所以它必须是纯路径代数；而这里只是给用户一句提醒（"这个目录现在还不存在"），
 * 读一次 fs 是安全的、也是值得的 —— 静默的失败最坏。
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runtime } from '../../runtime/runtime.js';
import { isFilesystemRoot } from '../../permission/danger.js';
import { workspaceGrants } from '../../permission/workspace.js';

/** 用法一行 —— 三处回执共用，免得各写一遍走形 */
const USAGE = '用法：/workspace ｜ /workspace allow <目录>（本会话放行，含子树）｜ /workspace clear';

/**
 * 放行范围"大到等于把闸关掉"时的提醒。
 * 判据只有两条，都取"这道闸还拦不拦得住东西"这个角度：
 *   · 盘根 / 文件系统根 / UNC 共享根 → 整个盘都在里面，等于闸失效；
 *   · 家目录本身 → 用户日常文件的全部所在，实际效果同上。
 * **只提醒、不拒绝**：这是用户亲手敲的显式动作，该给的是一条看得见的信息，
 * 而不是替他做决定（同 10.11.6 里"候选转正由人拍板"的分工）。
 */
function wideWarning(abs: string): string | null {
  if (isFilesystemRoot(abs)) return '⚠ 这是盘根 / 文件系统根：等于本会话内这道闸不再拦任何写操作。';
  if (abs === path.resolve(os.homedir())) return '⚠ 这是家目录本身：等于本会话内这道闸不再拦你家目录下的任何写操作。';
  return null;
}

export function activate(runtime: Runtime): void {
  runtime.registerCommand('workspace', '工作区边界：查看 + 放行项目外的写目录', (args: string) => {
    const trimmed = args.trim();
    const first = (trimmed.split(/\s+/)[0] ?? '').toLowerCase();

    if (first === 'allow') {
      // 路径可能含空格，故不吃第一个词之后就不管了：把剩下的**原样**拼回去
      const raw = trimmed.slice(first.length).trim();
      if (raw === '') return `没给目录。${USAGE}`;
      const abs = workspaceGrants.allow(raw);
      const notes = [
        `✅ 已放行（本会话有效）：${abs}`,
        'write / edit 现在可以写这个目录及其子树里的文件了。',
      ];
      const wide = wideWarning(abs);
      if (wide) notes.push(wide);
      if (!existsSync(abs)) {
        notes.push('（这个目录现在还不存在 —— 放行照样生效，稍后创建出来也算。）');
      }
      notes.push(USAGE);
      return notes.join('\n');
    }

    if (first === 'clear') {
      const had = workspaceGrants.list().length;
      workspaceGrants.clear();
      return had === 0
        ? `放行表本来就是空的。write / edit 只能写工作区之内。`
        : `🔒 已收回全部放行（${had} 个目录）。write / edit 回到"只能写工作区之内"。`;
    }

    if (first !== '' && first !== 'show') {
      return `未知参数 "${first}"。${USAGE}`;
    }

    const cwd = process.cwd();
    const grants = workspaceGrants.list();
    return [
      '工作区边界（write / edit 默认只能写工作区之内）：',
      `  工作区 = ${cwd}`,
      ...(grants.length === 0
        ? ['  已放行：无 —— 只能写工作区内']
        : ['  已放行（含各自子树，本会话有效）：', ...grants.map((d) => `    · ${d}`)]),
      '',
      USAGE,
      '边界：这道闸只管 write / edit 的**目标路径参数**；bash 的目标藏在命令串里'
        + '（写和读长得一样）判不出来、刻意不判；符号链接不追。它不是沙箱。',
    ].join('\n');
  });
}
