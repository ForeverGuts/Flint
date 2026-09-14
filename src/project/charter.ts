/**
 * 项目契约（CHARTER）与生命周期三件套 —— ROADMAP P10.12「项目生命周期协议」的程序侧。
 * 调用方：harness/main.ts（注册 before_tool_call 核心钩子）、commands/builtin/charter.ts（/charter）
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
 * 受这道闸保护的工具。
 * 只收写类工具里能改文件的那两个：`write`（整篇覆盖）与 `edit`（片段替换）。
 * **已知边界**：`bash` 里用重定向/脚本也能改这个文件，本闸不拦它
 * ——bash 命令串的语义解析是另一件事（ROADMAP 10.9.2 危险命令拦截），
 * 硬凑一个正则只会给出"看着拦住了"的假安全感。
 */
const GUARDED_TOOLS = new Set(['write', 'edit']);

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
 * 写保护判定 —— **纯函数**（cwd 是参数、锁状态是参数），verify 逐形状喂假值即可断言。
 *
 * fail-open 的边界与钩子契约一致：工具名不认识、参数形状不对、路径不是字符串，
 * 一律**放行**（钩子是基础设施不是策略，写错了不能让所有文件写入集体瘫痪）。
 * 真正会 deny 的只有一种情形：**写类工具 + 命中契约文件 + 未解锁**。
 */
export function guardContractWrite(
  toolName: string,
  args: unknown,
  unlocked: boolean,
  cwd: string = process.cwd(),
): HookDeny | undefined {
  if (!GUARDED_TOOLS.has(toolName)) return undefined;
  if (unlocked) return undefined;
  if (typeof args !== 'object' || args === null) return undefined;
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
