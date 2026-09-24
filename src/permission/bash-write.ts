/**
 * bash 写纳管（ROADMAP 10.9.8）—— 把 bash / spawn 命令里的**重定向与复制目标**也送进
 * 工作区闸的那道边界检查。
 *
 * 调用方：harness/main.ts 的 before_tool_call 核心钩子（排在**工作区闸之后**——同族边界闸，
 *         先让判据更确定的 write/edit 闸说话）。
 * 服务于：堵"换个门绕过去"的洞 —— write 写到工作区外会被拒，但 `echo x > ~/Desktop/a.txt`
 *         走 bash 这扇门此前完全没人查。
 *
 * ── 为什么**不能把 bash 塞进工作区闸的受管名单** ──
 * `guardWorkspaceWrite` 的输入契约是"参数里有 path 字段"；bash 的参数是一整句命令，
 * 没有那一格。所以这里做的是**小翻译**：从命令串里把"它想写到哪"揪出来，展开成绝对路径，
 * 然后**喂给工作区闸同一个判定函数**（`isOutsideWorkspace`）——
 * 边界规则一份、改一处两边生效；本模块只新增"从命令串提取目标"这一段。
 *
 * ── 认哪几种形状（封闭枚举，刻意做窄）──
 *   · 重定向：`>` `>>` `2>` `2>>`（含紧贴写法 `>out.txt`；`&>` 形态被切段拆开后落在 `>` 分支）
 *   · 命令词：`tee`（每个非旗标参数都是目标）、`cp` / `mv`（最后一个非旗标参数是目的地）
 * 其余形态（`$VAR`、命令替换、写进脚本再触发、python -c 里的 open(...)）**判不出来，
 * 一律放行** —— 这是护栏不是沙箱，与危险闸 / 删除闸同一条界线，拒因里对模型明说。
 *
 * ── 与 expandTarget 平台语义的一处**刻意分歧** ──
 * flint 的 bash 工具走 `shell: true`，Windows 上真跑的是 **cmd.exe**（见 process/runner.ts）。
 * 于是 MSYS 写法 `/c/Users/...` 在 cmd 里字面落点是 `<盘>:\c\Users\...` —— **不做** danger.ts
 * 那套"MSYS → 盘符"映射：那边映射的代价是"多拦一条"（可接受），这边若映射，
 * 会把"实际落在盘外的写"判成"工作区内"——**假放行正是本闸要堵的那个洞**，方向不可接受。
 * `~` / `$HOME` / `%USERPROFILE%` 则**照常展开成家目录**（含 Windows）：cmd 里 `> ~/x` 本来
 * 就会失败（建不出 `~` 目录），而模型的意图毫无歧义是家目录——**看得见的拒绝**好过一条
 * 莫名其妙失败的命令。
 *
 * 零运行时依赖：只 import 类型、danger.ts 的**同一套词法**（切段 / 取命令词 / 展包装 /
 * 目标归一）与 workspace.ts 的**同一个边界判定**。两处复用都是刻意的：
 * "两道闸读同一串字符、判同一条边界的方式必须一致"，否则必然漂移且互相掩护。
 */
import type { HookDeny } from '../loop/tool-hooks.js';
import { SHELL_COMMAND_TOOLS, commandWord, expandTarget, splitSegments, unwrapShell } from './danger.js';
import { isOutsideWorkspace } from './workspace.js';

/**
 * 重定向符（封闭枚举）。按 token **整体或前缀**匹配：`> out.txt` 与 `>out.txt` 同判。
 * ⚠ 刻意**不含** `&>` / `&>>`：`&` 本身是切段分隔符（splitSegments），`cmd &> f` 到达本判据
 *    时早已被切成 `cmd` 与 `> f` —— 列了也是**永远命不中的死代码**，不如不列（落在 `>` 分支）。
 * ⚠ 刻意**不含** `<` / `<>`：那是**读**方向（输入重定向），本闸只管"写出去"。
 */
export const REDIRECT_OPS: readonly string[] = ['2>>', '>>', '2>', '>'];

/**
 * 会"把内容写进文件参数"的命令词（封闭枚举，段首命中）。`commandWord()` 已做基名 /
 * 去 .exe / 小写归一，这里写裸词即可。
 * ⚠ 刻意**不含** `dd`（裸设备写归危险闸）、`install` / `rsync`（少见，先不猜）、
 *   `rm` 一类（删除归删除闸，本闸命中会跟它抢理由）。
 */
export const WRITE_COMMANDS: ReadonlySet<string> = new Set(['tee', 'cp', 'mv']);

/**
 * 伪目标：形状上是"写到那"，实际不是文件（黑洞 / 已打开的流 / cmd 设备）。
 * 命中即**整条跳过** —— `echo x > /dev/null` 是最常用的静音写法，拦它纯属误伤。
 */
export const PSEUDO_TARGETS: ReadonlySet<string> = new Set([
  '/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', // POSIX 设备
  'nul', // cmd 设备
]);

/** 一次命中：`op` = 哪种写法（进拒因），`raw` = 写在命令里的原始目标（未展开） */
export interface BashWriteHit {
  op: string;
  raw: string;
}

/** token 是不是伪目标（剥引号后比对；`>&1` / `>&2` 这类"重定向到流"也算） */
export function isPseudoTarget(raw: string): boolean {
  const s = raw.replace(/^["'`]+/, '').replace(/["'`]+$/, '').toLowerCase();
  if (PSEUDO_TARGETS.has(s)) return true;
  return /^&[012]$/.test(s); // >&1 >&2 &1 &2 —— 重定向到已打开的流，不是文件
}

/** 从一个 token 里认出"紧贴写法"的重定向：`>out.txt` → op `>` + rest `out.txt`；认不出返回 null */
function matchInlineOp(token: string): { op: string; rest: string } | null {
  for (const op of REDIRECT_OPS) {
    if (token.startsWith(op)) return { op, rest: token.slice(op.length) };
  }
  return null;
}

/**
 * 找出命令里所有"写出去"的目标；没有返回空数组（fail-open，交回主流程）。
 *
 * 与 `findDangerousCommand` / `findDeleteCommand` 同形：**逐段**（`&&` `||` `;` `|` `&`
 * 与换行切段，复用 `splitSegments`）、按需展**一层** shell 包装（复用 `unwrapShell`）。
 * 每段两路收集：
 *   ① 任意位置的重定向符（`> x` 与 `>x` 两种写法）；目标缺失 / 目标又是重定向符 → 跳过（fail-open）；
 *   ② 段首命令词命中 `WRITE_COMMANDS`：`tee` 取全部非旗标参数；`cp` / `mv` 在**非旗标
 *      参数 ≥ 2** 时取**最后一个**（目的地）。GNU `mv -t 目标 源...` 的旗标吃参形态
 *      判不出来，刻意不猜（见"刻意不做"）。
 * 引号内的空格会把路径拆成几个 token —— 但拼出来的仍是"工作区内"的相对片段居多，
 * 真要写出去的命令几乎都写成无空格 / 带引号整段，误伤方向可控（详见套件 D 段对照组）。
 */
export function findBashWriteTargets(command: string, depth = 0): BashWriteHit[] {
  if (typeof command !== 'string' || command.trim() === '') return [];
  const hits: BashWriteHit[] = [];
  for (const segment of splitSegments(command)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      const inline = matchInlineOp(t);
      if (inline !== null) {
        // 紧贴写法 `>out.txt`：rest 非空即目标；rest 为空则看下一个 token（`> out.txt`）
        const raw = inline.rest !== '' ? inline.rest : tokens[i + 1];
        if (raw !== undefined && !REDIRECT_OPS.includes(raw) && !isPseudoTarget(raw)) {
          hits.push({ op: inline.op, raw });
        }
        continue;
      }
    }
    const word = commandWord(tokens[0]!);
    if (WRITE_COMMANDS.has(word)) {
      const rest = tokens.slice(1).filter((t) => !t.startsWith('-'));
      if (word === 'tee') {
        for (const t of rest) {
          if (!isPseudoTarget(t)) hits.push({ op: 'tee', raw: t });
        }
      } else if (rest.length >= 2 && !isPseudoTarget(rest[rest.length - 1]!)) {
        hits.push({ op: word, raw: rest[rest.length - 1]! });
      }
    }
  }
  if (depth === 0) {
    const inner = unwrapShell(command);
    if (inner !== null) hits.push(...findBashWriteTargets(inner, 1));
  }
  return hits;
}

/** 判据的注入上下文 —— 全是参数不直读模块状态（与 WorkspaceContext 同一立场） */
export interface BashWriteContext {
  /** 工作区根 */
  cwd: string;
  /** 家目录：`~` / `$HOME` / `%USERPROFILE%` 展开的归宿（含 Windows，理由见文件头） */
  home: string;
  /** 用户已显式放行的**绝对**目录（与工作区闸共用同一张表） */
  grants: readonly string[];
}

/**
 * 钩子形状的适配器（与 `guardWorkspaceWrite` / `guardDeleteRedirect` 同一位置关系）：
 * 只看会执行 shell 命令串的工具（复用 `SHELL_COMMAND_TOOLS`）；命中返回 deny 契约，
 * 其余一律 undefined（fail-open）。
 *
 * 判定链：提取目标（纯词法）→ `expandTarget` 归一成绝对路径（判不出 → 跳过）→
 * **`isOutsideWorkspace`（与 write / edit 同一个函数）** → 出界即拒，第一条出界的说话。
 * 刻意**不追符号链接真落点**（不注入 realpath）：bash 目标先过"字面"这一关，
 * 穿越那一步留给 write / edit（10.9.5），别让一道闸背上两套判据。
 */
export function guardBashWrite(
  toolName: string,
  args: unknown,
  ctx: BashWriteContext,
): HookDeny | undefined {
  if (!SHELL_COMMAND_TOOLS.has(toolName)) return undefined;
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== 'string' || command.trim() === '') return undefined;
  for (const hit of findBashWriteTargets(command)) {
    const abs = expandTarget(hit.raw, { cwd: ctx.cwd, home: ctx.home });
    if (abs === null) continue; // 变量 / 命令替换 / 通配：判不出来，放行
    if (!isOutsideWorkspace(abs, { cwd: ctx.cwd, grants: ctx.grants })) continue;
    return { action: 'deny', reason: renderBashWriteReason(command, hit, abs) };
  }
  return undefined;
}

/**
 * 拒因（教学文案）：说清**没跑**、为什么 bash 也要过这道边界、以及**出路是什么**。
 * 与工作区闸 / 删除闸的格式对齐（`[标记] 命令` + 没执行 + 出路 + 边界声明）。
 */
export function renderBashWriteReason(command: string, hit: BashWriteHit, abs: string): string {
  return `[bash 写纳管] 「${command.trim()}」想把文件写到工作区之外：${hit.op} 的目标 ${hit.raw} → ${abs}。\n`
    + '  这条命令**没有被执行**（判定发生在运行之前，目标文件一个字都没被碰过）。\n'
    + '  为什么：write / edit 写到工作区之外会被拦下，bash 换一种写法不该能绕过同一条边界 ——\n'
    + '  这两扇门现在用的是同一个判定函数。\n'
    + '  三条出路：\n'
    + '    · 要写进项目里 —— 把目标改到工作区内（本条重定向就不用改别的）；\n'
    + '    · 确实要写到外面 —— 请用户在 flint 里敲 `/workspace allow <目录>` 授权该目录，\n'
    + '      或改用 write 工具（走同一条边界，且对不存在路径更拿手）；\n'
    + '    · 用户自己要在**他自己的终端里**写 —— 不受影响，这道闸只在 flint 进程内生效。\n'
    + '  （说明：这是**护栏不是沙箱**。`$VAR` 指向哪、命令替换的值、写进脚本再触发的写，\n'
    + '   判据都认不出来、一律放行；它挡的只是"顺手直接写出去"的那一条命令。）';
}
