/**
 * bash 里的 git 只读命令 → `git` 工具的**确定性路由**（ROADMAP 10.5.6）。
 * 调用方：harness/main.ts 的 before_tool_call 核心钩子（排在契约闸**之后**）。
 * 服务于：让"看一眼仓库状态"这类只读查询走**零弹窗**的结构化通道，而不是 bash 的授权通道。
 *         模型光看描述不足以稳定地选对通道（描述是软约束，强度等于模型听不听话），
 *         所以这条线由**程序**在工具调用处判定，不依赖模型自觉。
 *
 * ── 这是**路由器**，不是闸 ──（与契约锁的分工，见 DECISION_LOG log-2026-09-15-bash-git-router）
 * 闸的判据必须**完备**：漏一条就是漏洞。路由器的判据可以**刻意窄**：漏掉的只是"照旧走 bash"，
 * 代价为零。所以下面每一条"不路由"都是安全的兜底，而不是待补的缺口——这也正是本机制
 * 与"假门禁"的区别：它不声称自己不可绕过，因此不完整不构成失败。
 *
 * ── 判据窄到什么程度 ──
 * 只认**裸形式**（`git status` 这一档）。任何附加参数、任何 shell 元字符（管道 / 重定向 /
 * 复合 / 引号 / 转义）一律放过，留给 bash，也就留给用户看得见的那次授权。
 * 附带的收获：**写类形式自动落在窄判据之外**——`git tag v1` 是三个 token、`git branch -d x`
 * 是四个、`git commit -m x` 落在 SHELL_META 之外但 token 数不对——不必再单独维护一张
 * "哪些算写操作"的黑名单（那张表迟早与 GIT_OPS 分家）。
 *
 * ── 为什么"带参数就放行"是有意留的逃生口 ──
 * 结构化返回是**摘要**，不是无损原文；总有需要原始文本的场合（排查特殊状态）。留给模型的
 * 显式出口就是"加一个参数"（`git status --short`），于是"要原文"变成一次**有意识的选择**，
 * 而不是默认行为。拒绝文案里会把这个出口写出来。
 *
 * 零 I/O：不碰 fs、不起进程。只 import 一个**编译期擦除**的类型 + git.ts 的 op 枚举
 * （枚举只有一份，是"封闭枚举别存两处"那条纪律的落地）。
 */
import { GIT_OPS, type GitOp } from './git.js';
import type { HookDeny } from '../loop/tool-hooks.js';

/** 路由目标：告诉调用方"该改用哪一条 git 工具调用" */
export interface GitRedirect {
  op: GitOp;
  /** 仅 blame 会带（它必须指定一个文件） */
  path?: string;
}

/**
 * 出现任意一个就**不路由**。覆盖两类：
 *   · shell 语法：管道 / 重定向 / 顺序 / 逻辑 / 子命令 / 分组；
 *   · 引号与反斜杠：说明这串命令经过拼装，字面 token 已不代表真实参数（Windows 路径的反斜杠也在此列）。
 * 宁可漏（照旧走 bash）也不误判——"路由器可以窄"的具体体现。
 */
const SHELL_META = /[&|;<>()$`"'\\\n\r]/;

/**
 * 纯函数：bash 命令串 → 该走哪条 git 工具调用；不是"裸的 git 只读查询"就返回 null。
 * 不开进程、不碰总线，verify-git.ts ⑯ 段逐形状喂假值断言。
 */
export function routeGitRead(command: string): GitRedirect | null {
  if (typeof command !== 'string') return null;
  const raw = command.trim();
  if (raw === '') return null;
  if (SHELL_META.test(raw)) return null;
  const tokens = raw.split(/\s+/);
  if (tokens[0] !== 'git') return null;
  const sub = tokens[1];
  if (sub === undefined || !GIT_OPS.includes(sub as GitOp)) return null;
  // blame 必须带路径（裸 blame 不是合法 git 命令）
  if (sub === 'blame') {
    const p = tokens[2];
    if (tokens.length !== 3 || p === undefined || p.startsWith('-')) return null;
    return { op: 'blame', path: p };
  }
  // 其余只认裸形式：多一个 token 就不路由
  if (tokens.length !== 2) return null;
  return { op: sub as GitOp };
}

/**
 * 钩子形状的适配器（与 charter.ts 的 guardContractWrite 同一位置关系）：
 * 只看 `bash` 工具；命中返回 deny 契约，其余一律 undefined（fail-open，交回主流程）。
 * reason 是**教学文案**：说清命令没跑、为什么、改成什么、以及"要原文"的显式出口。
 */
export function routeBashGitRead(toolName: string, args: unknown): HookDeny | undefined {
  if (toolName !== 'bash') return undefined;
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== 'string') return undefined;
  const redirect = routeGitRead(command);
  if (redirect === null) return undefined;
  const call = redirect.path === undefined
    ? `git(op="${redirect.op}")`
    : `git(op="${redirect.op}", path="${redirect.path}")`;
  return {
    action: 'deny',
    reason:
      `「${command.trim()}」是 git 的只读查询，走 bash 有两个代价：会弹权限窗打扰用户，且只拿回原始文本。`
      + `请改用本仓零弹窗的结构化 git 工具重发同一件事：${call}\n`
      + `你刚才这条命令没有被执行，用户也没有被打扰。`
      + `（若确实需要原始文本——例如排查特殊的仓库状态——给它加一个显式参数再走 bash 即可，如 git status --short。）`,
  };
}
