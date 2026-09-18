/**
 * /workspace 命令 —— 工作区边界的查看与**放行**（ROADMAP 10.9.3 + 10.9.1）。
 * 调用方：commands/loader.ts 自动扫描（本目录每个导出 activate 的文件都会被加载）
 * 服务于：给用户一个**显式的开门动作** —— write / edit 默认只能写工作区（cwd）之内，
 *         要写到项目外面必须先由用户在这里点名放行。模型自己开不了（见 permission/workspace.ts）。
 *
 * 参数（空格后第一个词）：
 *   /workspace                      看工作区根 + 本会话已放行的目录
 *   /workspace allow <目录>         放行该目录**及其子树**（**仅本会话**；路径可含空格）
 *   /workspace allow --save <目录>  同上，并**落盘长期有效**（ROADMAP 10.9.1）
 *   /workspace clear                收回全部放行（**含盘上本项目的长期条目**）
 *
 * ── 为什么 `--save` 要显式写出来，而不是让 `allow` 默认落盘 ──
 * 落盘把"这次我同意"变成"以后每次都同意"。默认落盘 = 每一次随手同意都静默长期化，
 * 而那正是 10.9.3 要防的静默失效，只是时间尺度从一次会话拉到了无限。
 * 宁可让用户多打一个词（而且只多打一次）。（完整理由与反例见 permission/grants.ts 同名一节。）
 *
 * ── 为什么 `clear` 必须**连盘一起清** ──
 * 只清内存的话，用户刚收回的授权会在下次启动时**自己回来** —— 一次跨重启的静默复活，
 * 比"没清干净"更坏，因为用户会以为已经撤掉了。所以这一条不是顺手补的：
 * 撤销要是不彻底，前面那些"默认不落盘"的克制全白做。
 *
 * ── 为什么放行不接权限弹窗 ──
 * 权限弹窗的语义是"这次调用要不要做"，而这里要回答的是"要不要放开这条边界"；
 * 合成一件事，非 TTY 下弹窗自动放行就会让边界**静默失效**（详见 permission/workspace.ts 文件头）。
 *
 * ── 为什么本文件可以碰 fs 而判据不能 ──
 * 判据要对"还不存在的目标文件"下结论（write 会创建它），所以它必须是纯路径代数；
 * 而这里只是给用户一句提醒（"这个目录现在还不存在"），读一次 fs 是安全的、也是值得的 ——
 * 静默的失败最坏。落盘那半边刻意**不在本文件里**（在 permission/grants.ts），
 * 于是"谁碰磁盘"在这条链上仍然是一个能数得清的数字。
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runtime } from '../../runtime/runtime.js';
import { isFilesystemRoot } from '../../permission/danger.js';
import { forgetGrants, permissionsFilePath, persistGrant, persistedGrants } from '../../permission/grants.js';
import { workspaceGrants } from '../../permission/workspace.js';

/** 用法 —— 三处回执共用，免得各写一遍走形 */
const USAGE = [
  '用法：',
  '  /workspace                       看工作区根 + 已放行的目录',
  '  /workspace allow <目录>           放行该目录及其子树（**仅本会话**）',
  '  /workspace allow --save <目录>    同上，并**落盘长期有效**（重启后仍生效）',
  '  /workspace clear                 收回全部放行（含盘上本项目的长期条目）',
].join('\n');

/**
 * 放行范围"大到等于把闸关掉"时的提醒。
 * 判据只有两条，都取"这道闸还拦不拦得住东西"这个角度：
 *   · 盘根 / 文件系统根 / UNC 共享根 → 整个盘都在里面，等于闸失效；
 *   · 家目录本身 → 用户日常文件的全部所在，实际效果同上。
 * **只提醒、不拒绝**：这是用户亲手敲的显式动作，该给的是一条看得见的信息，
 * 而不是替他做决定（同 10.11.6 里"候选转正由人拍板"的分工）。
 * `--save` 时这条提醒更要紧（范围会跟到以后每一次启动），但**仍然只是提醒** ——
 * 该不该长期放行一个盘根，是用户的判断，不是本命令的判断。
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
      let raw = trimmed.slice(first.length).trim();
      // `--save` **只认紧跟在 allow 后面的那一个位置**。写成 `allow <路径> --save` 时
      // 那个词是**路径的一部分** —— 否则带空格的路径会被从中间咬掉一截，
      // 而症状是"放行了一个不存在的目录"，比报错更难查。
      let save = false;
      if (raw === '--save' || raw.startsWith('--save ')) {
        save = true;
        raw = raw.slice('--save'.length).trim();
      }
      if (raw === '') return `没给目录。\n${USAGE}`;

      const abs = workspaceGrants.allow(raw);
      const notes = [`✅ 已放行（本会话有效）：${abs}`];
      const wide = wideWarning(abs);
      if (wide) notes.push(wide);
      if (!existsSync(abs)) {
        notes.push('（这个目录现在还不存在 —— 放行照样生效，稍后创建出来也算。）');
      }

      if (save) {
        const err = persistGrant(process.cwd(), abs);
        notes.push(err === undefined
          ? `✅ 已记入长期放行（重启后仍生效）：${permissionsFilePath()}`
          // 写盘失败**必须说出来**：不说的话用户会以为已经长期化了，
          // 而"以为存上了、其实没存"是最坏的一种静默（他不会再检查一遍）。
          : `⚠ 长期放行**没存上**，重启后不会生效：${err}`);
      }

      notes.push('write / edit 现在可以写这个目录及其子树里的文件了。');
      notes.push(USAGE);
      return notes.join('\n');
    }

    if (first === 'clear') {
      const had = workspaceGrants.list().length;
      workspaceGrants.clear();
      const { removed, error } = forgetGrants(process.cwd());
      const lines: string[] = [];
      if (had === 0 && removed.length === 0) {
        lines.push('放行表本来就是空的（本会话与盘上都没有本项目的条目）。');
      } else {
        const parts = [`本会话 ${had} 个目录`];
        if (removed.length > 0) parts.push(`盘上长期条目 ${removed.length} 个`);
        lines.push(`🔒 已收回全部放行：${parts.join(' + ')}。`);
      }
      lines.push('write / edit 回到"只能写工作区之内"。');
      if (error !== undefined) {
        lines.push(`⚠ 盘上的条目**没能清掉**：${error}`);
        lines.push('   也就是说下次启动它还会自己回来 —— 按上面的原因处理之后，再敲一次 /workspace clear。');
      }
      return lines.join('\n');
    }

    if (first !== '' && first !== 'show') {
      return `未知参数 "${first}"。${USAGE}`;
    }

    const cwd = process.cwd();
    const grants = workspaceGrants.list();
    // 标签要拿**盘上有没有**来判，不能用内存表自己的状态：内存表里两者长得一模一样，
    // 差别只在盘上那一份。两边都过一遍 `path.resolve` 再比 —— 免得大小写 / 分隔符写法
    // 不同时把一个**已经长期生效**的目录标成"[本会话]"（那会让人以为重启就没了，白重打一遍）。
    const saved = new Set(persistedGrants(cwd).map((d) => path.resolve(d)));
    return [
      '工作区边界（write / edit 默认只能写工作区之内）：',
      `  工作区 = ${cwd}`,
      ...(grants.length === 0
        ? ['  已放行：无 —— 只能写工作区内']
        : [
            '  已放行（含各自子树）：',
            ...grants.map((d) => `    · ${saved.has(path.resolve(d)) ? '[长期]' : '[本会话]'} ${d}`),
          ]),
      '',
      USAGE,
      '边界：这道闸只管 write / edit 的**目标路径参数**；bash 的目标藏在命令串里'
        + '（写和读长得一样）判不出来、刻意不判；符号链接不追。它不是沙箱。',
    ].join('\n');
  });
}
