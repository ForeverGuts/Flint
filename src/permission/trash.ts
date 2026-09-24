/**
 * 删除回收站化（ROADMAP 10.9.6）—— 把"删除"从**不可逆**改道成**可撤销**的那道闸。
 *
 * 调用方：harness/main.ts 的 before_tool_call 核心钩子（排在危险闸**之后**、工作区闸**之前**）、
 *         tools/builtin.ts（trash 工具是改道的**出路**，本模块只负责指出它）、
 *         commands/builtin/undo.ts（还原最近一笔）
 * 服务于：让"模型顺手敲一条 rm"这条不可逆路径，落到"移到 .flint/trash/ + 记一笔"这条
 *         可撤销路径上。
 *
 * ── 它补的是危险闸当年认下的那个缺口 ──
 * 危险闸（10.9.2）的文件头写着一句判决：**"删除不可逆，所以本条只能有 L1、没有 L2"** ——
 * L2 是"事后拿得出去比对、回滚得回来的基线"，而删除一旦发生，没有任何东西留下来可比。
 * 于是那道闸只能"宁可少拦，不可误拦"，判据窄到只认"一棵树的根"这种灾难形态，
 * `rm foo.txt`、`rm -rf dist` 这类**照样不可逆、却完全正当**的删除它一个都不管。
 * 本条就是给删除补上 L2：**回收站 = 那个事后可比对、可回滚的基线**。有了基线，
 * 判据才敢从"只认灾难形态"放宽到"认一切删除"。
 *
 * ── 为什么**新开一道闸**，而不是把危险闸的判据放宽 ──
 * 两条判据的形状完全不是一回事，混在一条里两头都坏：
 *   · 危险闸看**目标**（是不是一棵树的根），判据刻意窄 —— 窄是它"宁可少拦"的**前提**；
 *   · 本闸看**命令词**（段首那一个词是不是删除），**根本不看目标** —— 因为目标是啥都不重要了，
 *     反正进了回收站都撤得回来。
 * 把"一切删除"塞进危险闸，等于让那条窄判据失去意义，也会让 verify-danger 那一整套断言的
 * 前提（"这些形态放行"）集体变掉。所以这里是**加一步，不换判据**（与 10.9.5 补第二步同一个手法）。
 *
 * ── 为什么"拦一切删除"不违反"宁可少拦不可误拦" ──
 * 那条纪律防的是"把一条正常命令堵死、且给不出出路"。本闸**出路始终存在且等价**：
 * `trash` 工具照样能达到删除的目的（目标不再在原处），只是可逆。
 * 被拦下的那条命令**没有被执行**，模型拿到的是一句指明出路的回执，不是死路。
 *
 * ── 这是**护栏，不是沙箱**（与危险闸同一条界线）──
 * 判据只看命令串的字面形态：`rm -rf $DIR`、写进脚本里再由 `npm run clean` 触发、
 * 换一种语言写一遍 —— 一律绕得过去。本模块不声称挡得住绕过。
 *
 * 零运行时依赖：只 import 类型与 danger.ts 的**词法层**（切段 / 取命令词 / 展包装）。
 * 那三个函数是危险闸已经在用的同一批 —— "两道闸读同一串字符的方式必须一致"，
 * 否则会出现"危险闸认为这是个命令、本闸认为不是"的分裂。
 */
import type { HookDeny } from '../loop/tool-hooks.js';
import { SHELL_COMMAND_TOOLS, commandWord, splitSegments, unwrapShell } from './danger.js';

/**
 * 删除类命令词（封闭枚举，段首命中即改道）。
 *
 * POSIX 三个 + cmd 三个 + PowerShell 一个。`commandWord()` 已经做过"取基名 + 去 .exe 后缀
 * + 转小写"，所以这里只需写**裸词**：`/bin/rm`、`RM.EXE`、`Remove-Item` 都归到同一格。
 *
 * ⚠ 刻意**不含** `git rm` / `npm uninstall` 这类"包在别的命令里"的形态：段首是 `git` / `npm`，
 *    删的是"别的系统自己管着的东西"（git 有对象库、npm 有 lock 文件），它们本就各自可逆。
 * ⚠ 加词前先问：它是不是**只**做删除？`mv` 会被判成删除就误伤了（它是移动，不是删）。
 */
export const DELETE_WORDS: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'unlink', // POSIX
  'del', 'rd', 'erase', // cmd
  'remove-item', // PowerShell
]);

/**
 * 找第一个删除类命令词；没有返回 null（fail-open，交回主流程）。
 *
 * 与 `findDangerousCommand` 同形：**逐段看段首命令词**（`grep x rm` 里的 `rm` 是数据不是命令），
 * 再按 `unwrapShell` 展开**一层**包装（`bash -c "rm -rf dist"` 里的真命令藏在字符串里）。
 * 展开只做一层，理由同危险闸：不递归就没有收敛问题，"转两层包装"已不是顺手写出来的形态。
 */
export function findDeleteCommand(command: string, depth = 0): string | null {
  if (typeof command !== 'string' || command.trim() === '') return null;
  for (const segment of splitSegments(command)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const word = commandWord(tokens[0]!);
    if (DELETE_WORDS.has(word)) return word;
  }
  if (depth === 0) {
    const inner = unwrapShell(command);
    if (inner !== null) return findDeleteCommand(inner, 1);
  }
  return null;
}

/**
 * 钩子形状的适配器（与 `guardDangerousCommand` / `guardContractWrite` 同一位置关系）：
 * 只看**会执行 shell 命令串**的工具（复用 `SHELL_COMMAND_TOOLS`，加同形工具时那边的注释会
 * 提醒回来补名字）；命中返回 deny 契约，其余一律 undefined（fail-open）。
 */
export function guardDeleteRedirect(
  toolName: string,
  args: unknown,
): HookDeny | undefined {
  if (!SHELL_COMMAND_TOOLS.has(toolName)) return undefined;
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== 'string' || command.trim() === '') return undefined;
  const word = findDeleteCommand(command);
  if (word === null) return undefined;
  return { action: 'deny', reason: renderTrashReason(command, word) };
}

/**
 * 拒因（教学文案）：说清**没跑**、为什么删也要走闸、以及**出路是什么**。
 *
 * 与危险闸那条的格式对齐（`[标记] 命令命中…` + 没执行 + 出路 + 边界声明），
 * 差别只在出路那一节：这边给的是**等价且可逆**的替代动作，不是"请你缩小目标"。
 */
export function renderTrashReason(command: string, word: string): string {
  return `[删除回收站化] 「${command.trim()}」命中删除类命令（${word}）：flint 里的删除一律先入回收站。\n`
    + '  这条命令**没有被执行**（程序闸排在权限弹窗之前，所以用户也没被打扰）。\n'
    + '  为什么：删除一旦发生就没有任何东西可以比对、可以还原 —— 回收站就是那个还原的凭据。\n'
    + '  三条出路：\n'
    + '    · 要删文件或目录 —— 用 **trash 工具**（`path` 传目标路径）。它把目标移到 `.flint/trash/` '
    + '并记一笔，效果同样是"不在原处了"，但撤得回来；\n'
    + '    · 删错了 —— 请用户在 flint 里敲 `/undo` 还原最近一笔（`/undo list` 看清单）；\n'
    + '    · 用户自己要在**他自己的终端里**删 —— 不受影响。这道闸只在 flint 进程内生效，进程外它管不着。\n'
    + '  （说明：这是**护栏不是沙箱**。命令串拼装、变量替换、写进脚本里再触发都能绕过，'
    + '本判据只挡顺手直接写出来的那一条命令。）';
}
