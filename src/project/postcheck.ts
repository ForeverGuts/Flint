/**
 * 改完自检（ROADMAP 10.6.2）—— 把「项目自己声明的自检命令」接到写类工具的结果上。
 * 调用方：tools/builtin.ts 的 write / edit handler（成功落盘后）；harness/main.ts（启动时播种配置）
 * 服务于：模型改完文件后**当场**在工具结果里看到「这项目还过得去吗」，而不是等它自己想起来
 *         跑一遍（路线图原话：闭环全靠提示词）。
 *
 * 为什么落点在**工具 handler** 而不是 after_tool_call 钩子：
 *   after_tool_call 的返回值**不被消费**（只读观察，见 loop/tool-hooks.ts 与 DECISION_LOG
 *   锚点 log-2026-09-11-tool-hooks）。要往工具结果里追加东西，唯一能生效的位置就是产出
 *   那个结果的地方 —— handler 自己。
 *
 * 权限（路线图约束 C5，选项 A）：**只跑登记过的命令**。登记表 = cwd 下的 .flint/postcheck.json，
 *   由用户手写。**声明即授权** —— 项目自己写下的命令不必再过权限弹窗（否则每写一个文件都弹
 *   一次，没人受得了）；反过来，**没登记 = 没授权 = 什么都不跑**（本模块的默认态，零行为变化）。
 *   这条只约束「自动跑什么」，不约束模型的自主行为：模型想跑没登记的命令，照旧走 bash + 弹窗。
 *
 * 为什么超时是配置项：自检与 bash 一样是**同步**跑的，会占住轮次；没有上限时一条卡住的命令
 *   能把整个会话顶死。超时不算配置错误，是最坏情况的兜底。
 *
 * 为什么配置**只在启动时读一次**（见 main.ts）：假想一条自我授权的路 —— 模型写一份
 *   .flint/postcheck.json 把 command 改成任意命令，运行期立刻生效，就等于把「免弹窗执行」
 *   这把钥匙递给了它（写该文件本身要过 write 的权限弹窗，但弹窗是**人**看的，同会话内立刻
 *   生效就让那一次弹窗失去意义）。读一次、进内存，运行期改文件不生效，这条路就断了。
 *   跨会话的残留由「写它必须过权限弹窗」兜着（写在已知边界里，不假装没有）。
 *
 * 【登记表可以**引用**命令名（10.6.1）】`{"use":"test"}` 与 `{"command":"npm run test"}` 二选一：
 *   前者按名字去**项目命令注册表**（`src/project/commands.ts`，从 package.json 的 scripts 发现）
 *   里查，查到后解析成那条命令的 `run`。**授权来源不变** —— 仍然是人手写的这份文件（声明即授权），
 *   变的只是命令**本体**不用抄一遍：package.json 里改了实现，登记表不必跟着改。
 *   两个都写 / 都没写 / 引用了注册表里没有的名字 → **一律 null**（含糊 = 没声明好 = 不启用，
 *   与下面 parsePostcheckConfig 的严格判据同一条理由）。
 *   反向的那条不成立：**只发现、没登记 = 什么都不跑**（发现 ≠ 授权，见 commands.ts 文件头）。
 *
 * 本文件**零 import**（无 node:fs / node:child_process）：解析与渲染是纯函数，可脱离终端验。
 *   读配置在 harness/main.ts（宽容读，读失败一律不启用），起进程在 tools/builtin.ts。
 *
 * 【已知边界，不装糊涂】超时只保证「**不再等它**」，不保证「**杀干净**」。
 *   2026-09-15 探针实测（WorkBuddy_Test/probe-treekill.mjs）：让子脚本 2 秒后写一个标记文件、
 *   超时给 800ms，返回后 3 秒再看 —— 标记文件照样出现了。也就是说 Windows 上被杀的是 shell
 *   （cmd.exe），真正的孙进程照跑不误。**这不是本功能新开的洞**：bash 工具用的是同一个机制
 *   （execSync + timeout），边界同源。区别在于自检是**自动**触发的，反复触发时残留进程更容易
 *   叠加，所以它更值得记一笔（已作为候选登记进 ROADMAP 10.6.6）。
 *   真咬人时的修法是超时后按**进程树**终止（Windows 走 taskkill /T，POSIX 走进程组），
 *   那是一次横跨 bash 与自检的改动，不该塞进本条里顺手做。
 */

/** 登记表位置：项目自己声明「改完跑什么」的唯一落点 */
export const POSTCHECK_FILE = '.flint/postcheck.json';

/** 单条自检命令没有被限速时的默认上限（毫秒） */
export const DEFAULT_POSTCHECK_TIMEOUT_MS = 60_000;

/** timeoutMs 的合法区间：下界防「写个 1ms 等于永远超时」，上界防「配成一天等于没配」 */
export const POSTCHECK_TIMEOUT_MIN_MS = 1_000;
export const POSTCHECK_TIMEOUT_MAX_MS = 600_000;

/** 摘要在工具结果里最多占几行（含尾部的省略行）。自检输出上不封顶，必须硬截 */
export const POSTCHECK_MAX_LINES = 30;

/** 截断时额外保留下来的**末尾**行数：多数构建器把「共 N 个错误」这类结论放在最后 */
export const POSTCHECK_TAIL_LINES = 3;

/**
 * 追加段的开头标记。用中文方括号与工具状态前缀（[OK] / [ERROR] / [VERIFY_FAILED] …）
 * 显式区分：这一段不是工具本身的成败，是**关于这次改动的附加情报**。
 */
export const POSTCHECK_TAG = '[项目自检]';

/** 登记表解析后的形状 */
export interface PostcheckConfig {
  /** 要执行的命令（走 shell 的一整句，如 `npm run typecheck`） */
  command: string;
  /** 同步执行的上限（毫秒） */
  timeoutMs: number;
}

/**
 * 解析登记表。**严格**：任何一处读不懂就不启用（返回 null）。
 * 判据的理由 —— 这张表是用户手写的白名单，而「声明即授权」的另一面就是
 * **没声明好 = 没授权**：猜一半去跑，比干脆不跑危险得多。
 * 宽容之处只有两处：允许 command 前后有空白（trim 掉）、允许带额外字段（忽略）。
 *
 * 第二参数 = 项目命令注册表（`{"use":"名字"}` 的查找范围，由 harness 启动时播种）。
 *   刻意不 import commands.ts 的类型：本文件保持零 import，这里只要求"有 name 与 run 两个字段"。
 *   不传（或传空表）时 `use` 一律解析失败 —— 没有注册表就无所谓引用。
 */
export function parsePostcheckConfig(
  text: unknown,
  commands: readonly { name: string; run: string }[] = [],
): PostcheckConfig | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // command 与 use **二选一**：都写 = 不知道该听谁的（含糊即不启用），都不写 = 没声明
  const rawCommand = obj.command;
  const rawUse = obj.use;
  if (rawCommand !== undefined && rawUse !== undefined) return null;

  let command: string;
  if (rawUse !== undefined) {
    if (typeof rawUse !== 'string' || rawUse.trim() === '') return null;
    const name = rawUse.trim();
    const hit = commands.find((c) => c.name === name);
    if (!hit || typeof hit.run !== 'string' || hit.run.trim() === '') return null;
    command = hit.run.trim();
  } else {
    if (typeof rawCommand !== 'string' || rawCommand.trim() === '') return null;
    command = rawCommand.trim();
  }

  let timeoutMs = DEFAULT_POSTCHECK_TIMEOUT_MS;
  if (obj.timeoutMs !== undefined) {
    const t = obj.timeoutMs;
    if (typeof t !== 'number' || !Number.isInteger(t)) return null;
    if (t < POSTCHECK_TIMEOUT_MIN_MS || t > POSTCHECK_TIMEOUT_MAX_MS) return null;
    timeoutMs = t;
  }

  return { command, timeoutMs };
}

/** 一次自检执行的观测量 —— 由工具层（builtin.ts）从 spawnSync 结果投影出来 */
export interface PostcheckRun {
  command: string;
  timeoutMs: number;
  /** 退出码；null = 没正常退出（超时 / 被信号中止） */
  status: number | null;
  /** 中止信号名（如 SIGTERM）；正常结束为 null */
  signal: string | null;
  stdout: string;
  stderr: string;
  /**
   * spawnSync 自身报错的 code。实测三种（2026-09-15 探针）：
   *   'ETIMEDOUT' = 超时被判死、'ENOBUFS' = 输出超 maxBuffer、其余 = 根本起不来。
   * 刻意不传 Error 对象：本文件零 import，也避免消费方误把 error.message 当正文。
   */
  errorCode?: string;
  /** 起不来时的原始信息（仅 errorCode 非空时有意义） */
  errorMessage?: string;
}

/**
 * 把命令输出压成一段能塞进工具结果的摘要。**纯函数**，不看退出码。
 * 顺序是 stdout 在前、stderr 在后：构建器（tsc / pytest 等）通常把错误写 stdout，
 * 而 npm 把脚本正文透传到 stdout、只在 stderr 上加自己的包装行 —— 关键内容因此落在前面，
 * 正好配合「掐头留尾」的截断策略。
 * 连续空行会被丢掉（编译器输出里常夹大段空行，留着纯占额度）。
 */
export function summarizePostcheckOutput(
  stdout: unknown,
  stderr: unknown,
  maxLines: number = POSTCHECK_MAX_LINES,
): string {
  const norm = (v: unknown): string =>
    typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : '';
  const lines = `${norm(stdout)}\n${norm(stderr)}`
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');

  if (lines.length === 0) return '（命令没有任何输出）';

  // 保证「省一行」这件事不会把上限算崩：头尾都要有位置，至少留一行
  const cap = maxLines > POSTCHECK_TAIL_LINES ? maxLines : POSTCHECK_TAIL_LINES + 1;
  if (lines.length <= cap) return lines.join('\n');

  const head = lines.slice(0, cap - POSTCHECK_TAIL_LINES);
  const tail = lines.slice(-POSTCHECK_TAIL_LINES);
  return [...head, `……（中间省略 ${lines.length - cap} 行）`, ...tail].join('\n');
}

/**
 * 渲染要追加到工具结果末尾的那一段。四种结局各有一句，措辞都点明「改动已落盘」——
 * 这条信息很关键：若不写，模型看到自检失败容易以为**这次写入没成功**，于是原样重写一遍。
 * 判据顺序即优先级：先认 spawnSync 的 errorCode（超时 / 超缓冲 / 起不来），再认退出码。
 */
export function describePostcheck(run: PostcheckRun): string {
  const { command, timeoutMs, status, signal, stdout, stderr, errorCode, errorMessage } = run;

  if (errorCode === 'ETIMEDOUT') {
    return `${POSTCHECK_TAG} 超时未完成（${command}，上限 ${timeoutMs}ms）——`
      + '改动已落盘，但没能确认它是否还可用。';
  }
  if (errorCode === 'ENOBUFS') {
    return `${POSTCHECK_TAG} 输出超过缓冲上限（${command}），只看到开头：\n`
      + summarizePostcheckOutput(stdout, stderr);
  }
  if (typeof errorCode === 'string' && errorCode !== '') {
    return `${POSTCHECK_TAG} 没能执行（${command}）：${errorMessage ?? errorCode}`;
  }
  if (status === null) {
    return `${POSTCHECK_TAG} 没跑完（${command}${signal ? `，被 ${signal} 中止` : ''}）——`
      + '改动已落盘，但没能确认它是否还可用。';
  }
  if (status === 0) return `${POSTCHECK_TAG} 通过（${command}）`;

  return `${POSTCHECK_TAG} 未通过（${command}，退出码 ${status}）：\n`
    + summarizePostcheckOutput(stdout, stderr) + '\n'
    + '改动已落盘；先处理这些，再往下加新的改动（下一次写文件会自动重跑）。';
}

/**
 * 当前生效的登记表（内存单例）。**运行期唯一真相源** —— 与 taskStore / memoryStore 同一手法：
 * 启动时由 harness 播种一次，之后不再回读文件（理由见文件头注）。
 * 刻意不做成 store 类：这里只有「一份配置」要存，没有增量变更，也就不需要变更通知。
 */
let current: PostcheckConfig | null = null;

export const postcheckRegistry = {
  set(config: PostcheckConfig | null): void {
    current = config;
  },
  get(): PostcheckConfig | null {
    return current;
  },
  /** 复位（只给测试用：模块级单例会跨套件残留，验完必须清） */
  clear(): void {
    current = null;
  },
};
