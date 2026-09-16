/**
 * 子进程**整树**终止 —— 策略部分（ROADMAP 10.6.6）。
 *
 * 本文件**零 import**：它只回答"该杀谁、怎么发这个命令"，真正起进程 / 发信号在
 *   process/runner.ts。这样两个平台的分支都能脱离终端验。
 *
 * ── 为什么要做这件事（2026-09-16 探针实测，本机 Windows）────────────────────────
 * `spawnSync` / `execSync` 的 `timeout` 只杀**直接子进程** —— 也就是那层 `cmd.exe`。
 * 真正干活的进程在它下面：`npm run x` 展开成 `node`，`node` 再 spawn 出 `tsc` 或测试
 * runner，这些全是 cmd 的孙子。杀掉 cmd 之后它们**继续跑完**（探针 A：超时 800ms，
 * 子脚本 3 秒后写的标记文件照样出现；三跳 `cmd → node → node` 同样逃逸，探针 D）。
 *
 * 两个后果，都不是洁癖问题：
 *   · `bash` 工具超时后命令其实还在改盘 —— 而我们已经在回执里告诉模型"超时了"；
 *   · 自检（10.6.2）是**自动**触发的，一次会话里写好几个文件就触发好几轮，残留叠加。
 *
 * ── 为什么必须换成异步 spawn ────────────────────────────────────────────────
 * 杀树必须**在 shell 还活着的时候**发出去。`spawnSync` 是同步阻塞的，它超时返回时
 * 那个 pid 已经死了，此时再补 `taskkill /pid X /T` 只会拿到"找不到该进程"
 * （探针 C：status=128）—— Windows 的 `/T` 是按**父子链**递归的，链头一断，孙子
 * 就再也找不回来了。所以执行器改成异步 `spawn`：先拿到 pid，超时那一刻由定时器
 * 调这里算出的计划，把整棵树端掉。
 *
 * ── 两个平台两种打法 ──────────────────────────────────────────────────────
 *   · Windows：`taskkill /pid <shell> /T /F`，顺着父子链递归（探针 B / E 实测：
 *     两跳与三跳都能连根拔起，marker 不再出现）。
 *   · POSIX：子进程以 `detached` 自成一个**进程组**，然后 `kill(-pid, SIGKILL)`
 *     端掉整组。detached 在这里是**必需的**而不是优化 —— 不脱离的话子进程与 flint
 *     同组，杀负 pid 会把 flint 自己一起带走。
 *
 * ⚠ **POSIX 分支未在本机实测**（开发机是 Windows）。它的期望值来自 POSIX 进程组语义
 *   与 Node 文档，不是实测结果。按项目纪律在这里明说，不假装验过 —— 将来在 Linux /
 *   macOS 上跑过 `verify-proctree.ts` 才算数（那套里有一条断言专门钉这件事）。
 */

/** 该按什么方式端掉一棵进程树。`pid` = **shell** 的 pid，不是孙子的。 */
export type TreeKillPlan =
  | { kind: 'taskkill'; argv: readonly string[] }
  | { kind: 'group'; pid: number; signal: 'SIGKILL' };

/**
 * 算出杀树计划。**pid 无效就返回 null**（进程压根没起来，无从杀）——
 * 调用方据此知道"这次没杀成"，而不是伪造一个杀过的假象。
 */
export function planTreeKill(pid: unknown, platform: string): TreeKillPlan | null {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    return { kind: 'taskkill', argv: ['/pid', String(pid), '/T', '/F'] };
  }
  return { kind: 'group', pid: -pid, signal: 'SIGKILL' };
}

/**
 * 起子进程时要不要 detached。**只有 POSIX 要**，理由见文件头：
 * 它决定了 `kill(-pid)` 端掉的是"整组"还是"连自己一起"。
 * Windows 上不需要（`/T` 认父子链，与进程组无关），而且 detached 会另开控制台。
 */
export function spawnDetached(platform: string): boolean {
  return platform !== 'win32';
}

/** 执行器观测到的三种"非正常结束"的原始事实 */
export interface ChildSignals {
  /** 到了上限还没结束，已按树终止 */
  timedOut: boolean;
  /** 输出超过 maxBuffer，已按树终止 */
  overflow: boolean;
  /** 进程根本起不来时的 error.code（起得来就是 null） */
  spawnErrorCode: string | null;
}

/**
 * 把观测折成 postcheck 契约里的那三种 errorCode（`project/postcheck.ts` 的 PostcheckRun）。
 * 返回 null = 正常结束，退出码才是唯一判据。
 *
 * 判据顺序 = 哪个先发生：根本起不来 > 超时 > 输出撑爆。
 * 保持这三个字符串不变是刻意的：它们已经写进 PostcheckRun 的注释与渲染分支，
 * 换执行机制（spawnSync → spawn）不应顺带改掉**对外可观测的契约**。
 */
export function classifyChildFailure(s: ChildSignals): 'ETIMEDOUT' | 'ENOBUFS' | 'SPAWN_FAILED' | null {
  if (s.spawnErrorCode !== null) return 'SPAWN_FAILED';
  if (s.timedOut) return 'ETIMEDOUT';
  if (s.overflow) return 'ENOBUFS';
  return null;
}

/**
 * 收尾用的那句话，说清"死的是整棵子树，不是只有外壳"。
 * 平台不同说法不同（一个是 taskkill、一个是进程组），所以它是一条纯函数而不是硬编码文案。
 */
export function describeTreeKill(plan: TreeKillPlan): string {
  return plan.kind === 'taskkill'
    ? `已按进程树终止（taskkill /T，pid ${plan.argv[1] ?? '?'}）`
    : `已终止整个进程组（SIGKILL，pgid ${Math.abs(plan.pid)}）`;
}

/**
 * 杀树之后等多久强制收尾。
 *
 * 为什么需要：正常路径靠子进程的 `close` 事件结算，而 `close` 要等**所有持有管道写端
 * 的进程**都退出。杀树是为了把它们都结束掉，理论上 close 随后就来 —— 但真出现
 * "某个后代没被 /T 认出来、仍攥着管道"的情况时，`close` 会一直不来，超时就从
 * "不再等它"退化成"永久卡住"，比不杀还糟。有这条兜底，最坏也只是慢 1.5 秒。
 */
export const TREE_KILL_GRACE_MS = 1500;
