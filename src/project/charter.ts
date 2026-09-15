/**
 * 项目契约（CHARTER）与生命周期三件套 —— ROADMAP P10.12「项目生命周期协议」的程序侧。
 * 调用方：harness/main.ts（注册 before_tool_call 核心钩子 = L1 事前闸）、
 *         tools/builtin.ts 的 bash 工具（L2 事后效果闸）、commands/builtin/charter.ts（/charter）
 * 服务于：把"目标文档立项后冻结"从提示词自律升级为**程序闸**——
 *         改 .flint/CHARTER.md 必须用户显式解锁，模型不能自己把目标改掉。
 *
 * ── 为什么走独立通道，而不是接进权限子系统（决策 C11）──
 * 权限子系统的语义是"**弹窗放行** + 进 allowlist"，回答的是"这次调用要不要做"；
 * 契约需要的是"**默认拒写**"，回答的是"要不要解这把锁"。两者不是一回事。
 * 若把 CHARTER 塞进同一个授权键空间，用户对 write 点过一次"本次全部允许"，
 * 这把锁就会被**那一次授权静默打开**——而且是"静默失效"（最难查的那类）。
 * 故本闸只认自己的状态位，与 PermissionManager 无任何交集。
 *
 * ── 会话级，不落盘 ──
 * 解锁是**会话级位**（用户批准 → 本会话内可改 → 进程结束自动回锁）。
 * 刻意不持久化：契约这把锁要能每次都拦得住；落盘等于把一次批准放大成长期有效，
 * 与它要防的 goal drift 同源（见 DECISION_LOG 锚点 log-2026-09-14-charter-lock）。
 *
 * ── 为什么拦在钩子而不是拦在工具里 ──
 * `before_tool_call`（agent-loop.ts 的唯一 execute 点）是现成的程序闸落点，
 * 且"程序闸先于人闸"是既有语义——拦下后权限弹窗根本不弹，用户不会被
 * "要不要允许 write"的弹窗误导成"允许了就能改目标"。工具层各自加判断会把
 * 这条规矩散成多份实现（write 一份、edit 一份），钩子让它只有一份。
 *
 * 零运行时依赖：只用 node:path（内置）+ 纯函数。
 */
import path from 'node:path';
import type { HookDeny } from '../loop/tool-hooks.js';

/** 生命周期三件套的落点 —— cwd 下的项目级目录（与 memory.md / events.jsonl 同处） */
export const CHARTER_FILE = '.flint/CHARTER.md';
export const PROJECT_FILE = '.flint/PROJECT.md';
export const DEVLOG_FILE = '.flint/DEVLOG.md';

/**
 * 回滚旁挂文件 —— **不是三件套之一**，只在"锁定期间契约被改动、已回滚"时出现。
 *
 * 为什么需要它：回滚是**破坏性**动作。绝大多数情形下被回滚的是模型偷偷写的违规内容，
 * 丢了活该；但极少数情形下可能是**用户本人**正在编辑器里改（时间窗口 = 一条 bash 命令
 * 的执行时长）——那种情况下丢的就是用户的东西。先把被顶掉的那一版原样存下来，
 * 回滚就从"不可逆"变成"可逆"，代价只是一个罕见的旁挂文件。
 * 事件库（events.jsonl）里也记一条，但那条的字段有 400 字上限，指望它存全文不可靠。
 */
export const CHARTER_REJECTED_FILE = '.flint/CHARTER.rejected.md';

/* ═══════════════════════════════════════════════════════════════════════════════
   契约锁的第二处入口：bash（2026-09-14 补，ROADMAP 10.9.2 的第一步）

   此前这里写着"bash 里用重定向/脚本也能改这个文件，本闸不拦它"——**那是登记在案的洞**，
   于是"契约锁"只锁住了 write/edit 两扇门，第三扇（bash）敞着。补它要分两层，
   因为 bash 的命令串**没有**"目标路径"这个可以精确比对的东西：

   · **L1 事前（本文件）**——命令串里**字面提到** CHARTER.md 就拒，拦在权限弹窗之前。
     判据刻意粗（不分读还是写）：分读写要解析 shell 语义，而引号、转义、变量、通配符、
     子命令都能重构出同一个路径，靠正则会演成"看着拦住了、实则漏一片"。代价是
     `cat .flint/CHARTER.md` 这类只读用法也被拒——它有干净的替代（read 工具），可以接受。
   · **L2 事后（builtin.ts 的 bash handler）**——命令跑完比对**文件内容**，锁定期间变了就回滚。
     它的判据是**效果**而不是**字面**，所以"把目录写成通配符的 cat"、"node build.js（脚本里
     写这个文件）"这类绕法一概覆盖。**这一层才是"真正堵上"的那一半**；L1 只是让常见情形在
     弹窗之前就停下。

   两层都**只在锁着的时候**生效（unlock 之后一切照旧）。L2 要碰 fs，所以 I/O 留在工具层，
   本文件只出纯函数（`mentionsContract` / `contractDrifted`），照旧可以脱离终端验。
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 事前闸（L1）覆盖的工具 = 写类里能改文件的那两个：`write`（整篇覆盖）与 `edit`（片段替换）。
 * 它们的参数里有**明确的目标路径**，所以按路径精确比对（`isContractTarget`）。
 */
const GUARDED_TOOLS = new Set(['write', 'edit']);

/** 契约文件名（小写）。判据是这个名字**出现在命令串里**，与 shell 会怎么解释它无关 */
export const CONTRACT_BASENAME = 'charter.md';

/**
 * 目标路径是否**就是**契约文件。
 * 精确到"cwd 下的那一个文件"（不是"任何叫 CHARTER.md 的文件"）：
 * 子目录里的同名文件不该被误伤，而 `.flint/../.flint/CHARTER.md` 这类绕法要被认出来。
 * 归一化统一小写 —— Windows 与 macOS 默认大小写不敏感，统一口径比按平台分叉好测。
 */
export function isContractTarget(target: string, cwd: string = process.cwd()): boolean {
  if (!target) return false;
  const hit = path.resolve(cwd, target).replace(/\\/g, '/').toLowerCase();
  const want = path.resolve(cwd, CHARTER_FILE).replace(/\\/g, '/').toLowerCase();
  return hit === want;
}

/**
 * bash 命令串里是否**字面提到**契约文件（L1 的判据）。
 *
 * 归一化三步：全小写 → 反斜杠转正斜杠（Windows 写法）→ 抹掉引号（`"` `'` `` ` ``）。
 * **刻意不看 shell 语义**：`$(echo CHARTER).md`、`CHAR$X.md` 这类拼出来的写法会漏，
 * 那是 L2 的活（见本节头注）——L1 只负责让常见写法在权限弹窗前就停下。
 */
export function mentionsContract(command: string): boolean {
  if (command === '') return false;
  const flat = command.toLowerCase().replace(/\\/g, '/').replace(/["'`]/g, '');
  return flat.includes(CONTRACT_BASENAME);
}

/**
 * L2 的判据（纯函数）：契约文件的内容有没有变。
 * `null` = "当时这个文件不存在"。不存在→存在、存在→不存在、存在→内容不同，都算变。
 * 单独起个名字而不是直接写 `!==`：`null` 那层语义（"文件不在"）值得有个地方说清。
 */
export function contractDrifted(before: string | null, after: string | null): boolean {
  return before !== after;
}

/**
 * 写保护判定 —— **纯函数**（cwd 是参数、锁状态是参数），verify 逐形状喂假值即可断言。
 *
 * fail-open 的边界与钩子契约一致：工具名不认识、参数形状不对、路径不是字符串，
 * 一律**放行**（钩子是基础设施不是策略，写错了不能让所有文件写入集体瘫痪）。
 * 真正会 deny 的只有两种情形：
 *   · **write / edit + 命中契约文件 + 未解锁**（按路径精确比对）
 *   · **bash + 命令串里出现契约文件名 + 未解锁**（按字面比对，L1）
 */
export function guardContractWrite(
  toolName: string,
  args: unknown,
  unlocked: boolean,
  cwd: string = process.cwd(),
): HookDeny | undefined {
  if (unlocked) return undefined;
  if (typeof args !== 'object' || args === null) return undefined;

  // L1：bash 只按**字面文件名**拦 —— 分读写要解析 shell 语义，那是假安全感（见本节头注）
  if (toolName === 'bash') {
    const command = (args as { command?: unknown }).command;
    if (typeof command !== 'string' || !mentionsContract(command)) return undefined;
    return {
      action: 'deny',
      reason:
        `${CHARTER_FILE} 是立项后冻结的目标文档（契约），bash 命令里一律不许出现它的名字`
        + '（不分读还是写）。要看它的内容请用 read 工具；'
        + '若确实需要修订目标/范围/验收标准，先向用户说明改什么、为什么，'
        + '征得同意后由用户执行 /charter unlock 解锁（本会话有效），再改。',
    };
  }

  if (!GUARDED_TOOLS.has(toolName)) return undefined;
  const target = (args as { path?: unknown }).path;
  if (typeof target !== 'string' || target.trim() === '') return undefined;
  if (!isContractTarget(target, cwd)) return undefined;
  return {
    action: 'deny',
    reason:
      `${CHARTER_FILE} 是立项后冻结的目标文档（契约），不能直接改。`
      + '若确实需要修订目标/范围/验收标准，先向用户说明改什么、为什么，'
      + '征得同意后由用户执行 /charter unlock 解锁（本会话有效），再改。',
  };
}

/**
 * 契约写锁 —— 会话级单例（进程内）。
 * 刻意不做持久化：一次批准不该放大成长期有效（本文件头部有完整理由）。
 */
export const charterLock = {
  unlocked: false,
  /** 解锁（由 /charter unlock 调用；这是**唯一**的开门动作） */
  unlock(): void {
    this.unlocked = true;
  },
  /** 立即回锁 */
  lock(): void {
    this.unlocked = false;
  },
  isUnlocked(): boolean {
    return this.unlocked;
  },
  /** 复位 —— 仅供验证脚本在用例之间擦干净单例状态（与 TaskStore.reset 同一用途） */
  reset(): void {
    this.unlocked = false;
  },
};
