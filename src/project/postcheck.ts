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
 * 【2026-09-16 三项增强 —— 它们共用一个新东西：**诊断条目解析器**】
 *   原先自检只做一件事：跑命令 → 看退出码 → 把输出掐头留尾贴回来。三个短板都出在
 *   「把输出当**一坨文本**」这件事上：
 *     ① **只报新增**（基线对比）：全项目 `tsc` 会把历史遗留的旧错一起报出来，模型分不清
 *        哪个是自己刚写坏的 —— 要么跑去改不该改的旧错（扩大改动面），要么一看「反正一直有错」
 *        连自己那个也漏掉。启动时先跑一次存成基线，之后只报相对基线**新增**的。
 *     ② **多命令槽位**：原先只有一个位子，想检查两样得手工写 `npm run a && npm run b`，
 *        而那样两条共享一个退出码、一个超时，报不出来是谁挂的。改成数组，各跑各的。
 *     ③ **按条目摘要**：原先按**行**截断（尾 3 行），报错一多真正的错误就被尾部那句
 *        「Found 42 errors」挤没了。改成先认出「哪些行是诊断」，按**条目**取舍。
 *   三者共用 `parseDiagnosticLine` —— 这正是把它们放在同一批做的原因：切三次不如切一次。
 *
 * 本文件**不 import 任何碰 fs / 子进程的东西**（无 node:fs / node:child_process）：解析与渲染是
 *   纯函数，可脱离终端验。唯一的 import 是同层的纯函数模块 `test-report.ts`（10.6.3，认测试器
 *   输出）—— 它同样零副作用，不破坏"可脱离终端验"。读配置在 harness/main.ts（宽容读，
 *   读失败一律不启用），起进程在 tools/builtin.ts。
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

import {
  collectTestFailureKeys,
  parseTestCounts,
  parseTestFailures,
  summarizeTestFailures,
  testFailureKey,
  TEST_MAX_FAILURES,
  type TestCounts,
  type TestFailure,
} from './test-report.js';

/** 登记表位置：项目自己声明「改完跑什么」的唯一落点 */
export const POSTCHECK_FILE = '.flint/postcheck.json';

/** 单条自检命令没有被限速时的默认上限（毫秒） */
export const DEFAULT_POSTCHECK_TIMEOUT_MS = 60_000;

/** timeoutMs 的合法区间：下界防「写个 1ms 等于永远超时」，上界防「配成一天等于没配」 */
export const POSTCHECK_TIMEOUT_MIN_MS = 1_000;
export const POSTCHECK_TIMEOUT_MAX_MS = 600_000;

/** 一次自检（可能多条命令）的**总**时长上限：防「登记 5 条 × 60s = 每次写文件等 5 分钟」 */
export const POSTCHECK_TOTAL_TIMEOUT_MAX_MS = 600_000;

/** 登记表里最多几条命令。再多就不是自检了，那是把 CI 搬进每一轮对话 */
export const POSTCHECK_MAX_COMMANDS = 5;

/** 摘要在工具结果里最多占几行（含尾部的省略行）。自检输出上不封顶，必须硬截 */
export const POSTCHECK_MAX_LINES = 30;

/** 截断时额外保留下来的**末尾**行数：多数构建器把「共 N 个错误」这类结论放在最后 */
export const POSTCHECK_TAIL_LINES = 3;

/** 按条目摘要时最多列几条诊断（超出就写「还有 N 条」） */
export const POSTCHECK_MAX_DIAGNOSTICS = 20;

/**
 * 追加段的开头标记。用中文方括号与工具状态前缀（[OK] / [ERROR] / [VERIFY_FAILED] …）
 * 显式区分：这一段不是工具本身的成败，是**关于这次改动的附加情报**。
 */
export const POSTCHECK_TAG = '[项目自检]';

/** 登记表解析后的形状 */
export interface PostcheckConfig {
  /**
   * 要执行的命令们（每条都是走 shell 的一整句，如 `npm run typecheck`）。
   * **始终是数组** —— 单条时长度为 1。内部统一成数组，避免「有时是串有时是数组」的两态。
   */
  commands: string[];
  /** **每条**命令同步执行的上限（毫秒） */
  timeoutMs: number;
  /** 一轮自检（所有命令加起来）的总时长上限（毫秒） */
  totalTimeoutMs: number;
}

/**
 * 一条诊断 —— 从命令输出里认出来的「一个具体的错」。
 *
 * 为什么要有它：按**行**处理输出时，「一行文本」不等于「一个错」。tsc 的 pretty 模式一个错
 * 要占四行（诊断行 + 空行 + 源码行 + 波浪线）；而非 pretty 模式一行就是一个错。
 * 要数清「有几个错、哪些是新的」，必须先把它切成条目。
 */
export interface Diagnostic {
  /** 文件路径（原样保留）；认不出时为 '' */
  file: string;
  /** 错误码（如 `TS2322`）；认不出时为 '' */
  code: string;
  /** 消息正文（去掉了行列与码之后剩下的那句话） */
  message: string;
  /** 原始整行，用于原样回显 */
  raw: string;
}

/**
 * 认出一行是不是**诊断行**。认不出返回 null（那就是噪音行：npm 的横幅、源码回显、波浪线）。
 *
 * 两种实测过的形态（2026-09-16 探针，同一份坏文件分别用默认与 --pretty 跑）：
 *   默认（非 TTY）：`src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.`
 *   --pretty     ：`src/a.ts:1:14 - error TS2322: Type 'string' is not assignable to type 'number'.`
 * 只认这两种，**不认别的** —— 按本项目纪律，没实测到的格式不许用推理补；认不出即丢弃，
 * 后果是退回「按行摘要 + 不过滤」，而不是认错。
 *
 * 只认 `error` 不认 `warning`：自检关心的是「过不过得去」，警告不该让它变红。
 */
export function parseDiagnosticLine(line: string): Diagnostic | null {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (trimmed === '') return null;

  // 去掉 pretty 模式可能夹带的 ANSI 颜色转义（即便不是 TTY，用户也可能显式开 --pretty）
  // 只处理最简单的 SGR 序列，够用即可；认不出的原样进正则，正则不匹配就是 null。
  const plain = trimmed.replace(/\u001b\[[0-9;]*m/g, '');

  const paren = /^(.+?)\((\d+),(\d+)\):\s+error\s+([A-Za-z]+\d+):\s*(.*)$/.exec(plain);
  if (paren) {
    return { file: paren[1], code: paren[4], message: paren[5], raw: trimmed };
  }

  const pretty = /^(.+?):(\d+):(\d+)\s+-\s+error\s+([A-Za-z]+\d+):\s*(.*)$/.exec(plain);
  if (pretty) {
    return { file: pretty[1], code: pretty[4], message: pretty[5], raw: trimmed };
  }

  return null;
}

/**
 * 从一段输出里抽诊断（stdout 在前、stderr 在后，与 summarize 的拼接顺序一致）。
 * 顺序**保持原文顺序**，不去重 —— 去重会丢「同一个错出现两次」的信息。
 */
export function parseDiagnostics(
  stdout: unknown,
  stderr: unknown,
): Diagnostic[] {
  const norm = (v: unknown): string =>
    typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : '';
  const out: Diagnostic[] = [];
  for (const line of `${norm(stdout)}\n${norm(stderr)}`.split('\n')) {
    const d = parseDiagnosticLine(line);
    if (d) out.push(d);
  }
  return out;
}

/**
 * 诊断的**身份** —— 用于判断「这个错是不是新的」。
 *
 * 刻意**不含行列号**：在文件中间插一行，下面所有报错的行号全变，但错误本身没变。
 * 若把行列算进键里，每插一行所有旧错都会伪装成新错冒出来，基线对比直接失效。
 * 只认 error 的副作用是：同一个文件同一行两个不同的错，键不同，各自算新错 —— 这是对的。
 *
 * 另一个好处：pretty 与非 pretty 两种写法会得到**同一个键**，切换 TTY 状态不会造成误判。
 */
export function diagnosticKey(d: Diagnostic): string {
  return `${d.file}|${d.code}|${d.message}`;
}

/** 抽出一个诊断集合的身份集合（去重，保持首次出现顺序） */
export function collectDiagnosticKeys(diagnostics: readonly Diagnostic[]): string[] {
  const seen = new Set<string>();
  for (const d of diagnostics) {
    const k = diagnosticKey(d);
    if (!seen.has(k)) seen.add(k);
  }
  return [...seen];
}

/**
 * 一段输出里认出来的「结构化的错」—— **两路并列**（10.6.3）：
 *   `diagnostics` = 编译器诊断（tsc 那两种形态，见 parseDiagnosticLine）；
 *   `failures`    = 测试器失败用例（`node --test` 的 TAP，见 test-report.ts）。
 * 两路都认不出时两者皆空，调用方退回按行摘要（fail-safe 朝"多给噪音"倒）。
 */
export interface StructuredOutput {
  diagnostics: Diagnostic[];
  failures: TestFailure[];
  /** 测试器自报的 counts（`counts` 只在认得出 `node --test` 统计行时非 null） */
  counts: TestCounts | null;
}

/** 诊断键的命名空间前缀：防止测试失败的键（`文件|用例名`）与诊断键（`文件|码|消息`）撞车 */
export const TEST_KEY_PREFIX = 'test|';

/** 认一段输出里的全部结构化条目 */
export function parseStructured(stdout: unknown, stderr: unknown): StructuredOutput {
  return {
    diagnostics: parseDiagnostics(stdout, stderr),
    failures: parseTestFailures(stdout, stderr),
    counts: parseTestCounts(stdout, stderr),
  };
}

/** 结构化的条目总数（两类加起来） */
export function countStructured(s: StructuredOutput): number {
  return s.diagnostics.length + s.failures.length;
}

/** 按基线过滤掉「启动前就有」的那些。基线为 null（没采过）时原样返回 */
export function filterStructured(
  s: StructuredOutput,
  baseline: readonly string[] | null,
): StructuredOutput {
  if (baseline === null) return s;
  return {
    diagnostics: s.diagnostics.filter((d) => !baseline.includes(diagnosticKey(d))),
    failures: s.failures.filter(
      (f) => !baseline.includes(TEST_KEY_PREFIX + testFailureKey(f)),
    ),
    counts: s.counts,
  };
}

/** 渲染结构化条目：**测试失败优先**（理由见 summarizePostcheckOutput 上方那条注） */
export function summarizeStructured(
  s: StructuredOutput,
  maxDiagnostics: number = POSTCHECK_MAX_DIAGNOSTICS,
  maxFailures: number = TEST_MAX_FAILURES,
): string {
  const byTest = summarizeTestFailures(s.failures, s.counts, maxFailures);
  if (byTest !== '') return byTest;
  if (s.diagnostics.length > 0) return summarizeByDiagnostics(s.diagnostics, maxDiagnostics);
  return '';
}

/**
 * 解析登记表。**严格**：任何一处读不懂就不启用（返回 null）。
 * 判据的理由 —— 这张表是用户手写的白名单，而「声明即授权」的另一面就是
 * **没声明好 = 没授权**：猜一半去跑，比干脆不跑危险得多。
 * 宽容之处只有两处：允许命令前后有空白（trim 掉）、允许带额外字段（忽略）。
 *
 * 三种声明方式**互斥**（`command` / `commands` / `use`），写两个以上 = 含糊 = null：
 *   `{"command":"npm run typecheck"}`                 单条，写全
 *   `{"commands":["npm run typecheck","npm run lint"]}` 多条，各跑各的
 *   `{"use":"typecheck"}` / `{"use":["a","b"]}`       按名字引用项目命令注册表
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

  // 三种声明方式互斥：写了两种以上就不知道该听谁的（含糊即不启用）
  const declared = ['command', 'commands', 'use'].filter((k) => obj[k] !== undefined);
  if (declared.length !== 1) return null;

  const resolved = declared[0] === 'use'
    ? resolveUse(obj.use, commands)
    : resolveCommands(obj[declared[0]]);
  if (resolved === null) return null;

  let timeoutMs = DEFAULT_POSTCHECK_TIMEOUT_MS;
  if (obj.timeoutMs !== undefined) {
    const t = obj.timeoutMs;
    if (typeof t !== 'number' || !Number.isInteger(t)) return null;
    if (t < POSTCHECK_TIMEOUT_MIN_MS || t > POSTCHECK_TIMEOUT_MAX_MS) return null;
    timeoutMs = t;
  }

  // 总闸默认 = 条数 × 单条上限（单条时正好等于单条上限），但不超过总上限。
  // 没这个闸的话「5 条 × 60s」意味着每写一个文件等 5 分钟，比不自检还糟。
  let totalTimeoutMs = Math.min(
    resolved.length * timeoutMs,
    POSTCHECK_TOTAL_TIMEOUT_MAX_MS,
  );
  if (obj.totalTimeoutMs !== undefined) {
    const t = obj.totalTimeoutMs;
    if (typeof t !== 'number' || !Number.isInteger(t)) return null;
    if (t < POSTCHECK_TIMEOUT_MIN_MS || t > POSTCHECK_TOTAL_TIMEOUT_MAX_MS) return null;
    // 总闸小于单条上限 = 第一条都跑不完，配置自相矛盾 → 不当它是配好了
    if (t < timeoutMs) return null;
    totalTimeoutMs = t;
  }

  return { commands: resolved, timeoutMs, totalTimeoutMs };
}

/** `{"use":"名字"}` / `{"use":["名字",…]}` —— 去注册表里按名字查，查不到即失败 */
function resolveUse(
  value: unknown,
  registry: readonly { name: string; run: string }[],
): string[] | null {
  const names: unknown[] = Array.isArray(value) ? value : [value];
  if (names.length === 0 || names.length > POSTCHECK_MAX_COMMANDS) return null;

  const out: string[] = [];
  for (const n of names) {
    if (typeof n !== 'string' || n.trim() === '') return null;
    const hit = registry.find((c) => c.name === n.trim());
    if (!hit || typeof hit.run !== 'string' || hit.run.trim() === '') return null;
    out.push(hit.run.trim());
  }
  return out;
}

/** `{"command":"一句"}` / `{"commands":["一句",…]}` —— 归一化成数组 */
function resolveCommands(value: unknown): string[] | null {
  const list: unknown[] = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.length > POSTCHECK_MAX_COMMANDS) return null;

  const out: string[] = [];
  for (const c of list) {
    if (typeof c !== 'string' || c.trim() === '') return null;
    out.push(c.trim());
  }
  return out;
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
  /** 总闸用尽导致**根本没跑**（区别于超时：它压根没启动） */
  skipped?: boolean;
}

/**
 * 把命令输出压成一段能塞进工具结果的摘要。**纯函数**，不看退出码。
 *
 * 三条路径，**次序即优先级**（10.6.3 加的第 ⓪ 条）：
 *   ⓪ **认得出失败用例** → 按**用例**取舍。`node --test` 一类测试器的输出里，失败信息散在
 *      TAP 的长篇块里（用例名在一行、位置在下面好几行），按行截断会把它们一起切掉；
 *      而「哪个用例挂了」恰恰是模型下一步最需要的那句话。
 *      它排在诊断**之前**，理由：测试失败是**结论**、编译器诊断是**原因** ——
 *      一段输出里两者都有时（先 tsc 再跑测试的那种登记表），先答"哪个用例挂了"，
 *      模型才会去看那个用例，而不是先去啃一串类型错。
 *   ① **认得出诊断** → 按**条目**取舍（这是 2026-09-16 加的）。按行截断时，报错一多
 *      真正的错误会被尾部「Found 42 errors」那类结论行挤掉 —— 而结论行数自己就能报。
 *   ② **两者都认不出** → 退回原来的按行掐头留尾。这是 fail-safe 的方向：
 *      宁可多给噪音，也不能让一段看不懂的输出被结构化的尝试啃掉内容。
 *
 * stdout 在前、stderr 在后：构建器（tsc / pytest 等）通常把错误写 stdout，
 * 而 npm 把脚本正文透传到 stdout、只在 stderr 上加自己的包装行。
 */
export function summarizePostcheckOutput(
  stdout: unknown,
  stderr: unknown,
  maxLines: number = POSTCHECK_MAX_LINES,
  maxDiagnostics: number = POSTCHECK_MAX_DIAGNOSTICS,
  maxFailures: number = TEST_MAX_FAILURES,
): string {
  const structured = summarizeStructured(
    parseStructured(stdout, stderr),
    maxDiagnostics,
    maxFailures,
  );
  if (structured !== '') return structured;

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

  // 减 1 是给省略行本身留位：否则 head + 省略 + tail = cap + 1 行，上限被悄悄突破 1 行。
  // （这条是 2026-09-16 加 H6 断言时实测出来的：80 行输入产出 31 行摘要。）
  const head = lines.slice(0, Math.max(0, cap - POSTCHECK_TAIL_LINES - 1));
  const tail = lines.slice(-POSTCHECK_TAIL_LINES);
  const omitted = lines.length - head.length - tail.length;
  return [...head, `……（中间省略 ${omitted} 行）`, ...tail].join('\n');
}

/** 按诊断条目回显。一行一个错，超出上限就数清楚还差几条（不静默吞掉） */
export function summarizeByDiagnostics(
  diagnostics: readonly Diagnostic[],
  maxDiagnostics: number = POSTCHECK_MAX_DIAGNOSTICS,
): string {
  if (diagnostics.length === 0) return '（命令没有任何输出）';
  const cap = maxDiagnostics > 0 ? maxDiagnostics : 1;
  const shown = diagnostics.slice(0, cap).map((d) => d.raw);
  const rest = diagnostics.length - shown.length;
  if (rest > 0) shown.push(`……（还有 ${rest} 条未列出）`);
  return shown.join('\n');
}

/**
 * 渲染要追加到工具结果末尾的那一段（**单条**命令）。四种结局各有一句，措辞都点明
 * 「改动已落盘」—— 这条信息很关键：若不写，模型看到自检失败容易以为**这次写入没成功**，
 * 于是原样重写一遍。
 * 判据顺序即优先级：先认 spawnSync 的 errorCode（超时 / 超缓冲 / 起不来），再认退出码。
 *
 * 第二参数 = 基线（启动时那次自检的诊断身份集合）。给了就**只报新增的**：
 *   过滤后一条不剩 = 这次改动没捅新娄子（旧错还在，但不刷屏）。
 *   认不出诊断时**不过滤**（见 summarizePostcheckOutput 的 fail-safe 方向）。
 *
 * 第三参数 tail（默认 true）= 要不要在结尾附那句「改动已落盘…」。
 * **它是整轮自检的结论，不是单条命令的结论** —— 多条命令时若每条都附，
 * 同一句话会重复 N 遍；故多命令路径由 describePostcheckAll 传 false，
 * 改在整轮末尾说一次。
 */
export function describePostcheck(
  run: PostcheckRun,
  baseline: readonly string[] | null = null,
  tail = true,
): string {
  const { command, timeoutMs, status, signal, stdout, stderr, errorCode, errorMessage } = run;

  if (run.skipped === true) {
    return `${POSTCHECK_TAG} 未执行（${command}）—— 本轮总时长已用尽，没轮到它。`
      + (tail ? '改动已落盘。' : '');
  }
  if (errorCode === 'ETIMEDOUT') {
    return `${POSTCHECK_TAG} 超时未完成（${command}，上限 ${timeoutMs}ms）——`
      + (tail ? '改动已落盘，但' : '') + '没能确认它是否还可用。';
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
      + (tail ? '改动已落盘，但' : '') + '没能确认它是否还可用。';
  }
  if (status === 0) return `${POSTCHECK_TAG} 通过（${command}）`;

  // 只在「认得出结构化条目」且「有基线」时过滤；否则全量报（旧行为）。
  // 结构化 = 编译器诊断 ∪ 测试器失败用例（10.6.3）—— 两者都可能「启动前就挂着」，
  // 都该被基线挡掉，否则模型会去改一个它没碰过的失败用例。
  const all = parseStructured(stdout, stderr);
  const allCount = countStructured(all);
  const filtered = filterStructured(all, baseline);
  const newCount = countStructured(filtered);

  if (baseline !== null && allCount > 0 && newCount === 0) {
    return `${POSTCHECK_TAG} 未通过（${command}，退出码 ${status}），但没有新增问题`
      + ` —— 报出来的还是启动前就有的那 ${allCount} 条。`
      + (tail ? '改动已落盘；' : '')
      + '这些旧问题不归本次改动管，别顺手去改它们。';
  }

  const body = newCount > 0 && newCount !== allCount
    ? summarizeStructured(filtered)
    : summarizePostcheckOutput(stdout, stderr);

  const newNote = baseline !== null && allCount > 0 && newCount > 0
    && newCount !== allCount
    ? `（共 ${allCount} 条，其中 ${newCount} 条是本次新增）`
    : '';

  return `${POSTCHECK_TAG} 未通过（${command}，退出码 ${status}）${newNote}：\n`
    + body
    + (tail ? '\n改动已落盘；先处理这些，再往下加新的改动（下一次写文件会自动重跑）。' : '');
}

/**
 * 渲染**一轮**自检（可能多条命令）的结论。
 * 单条时逐字等价于 describePostcheck —— 这样登记表只写一条的用户，看到的和以前一模一样。
 */
export function describePostcheckAll(
  runs: readonly PostcheckRun[],
  baseline: readonly string[] | null = null,
): string {
  if (runs.length === 0) return '';
  if (runs.length === 1) return describePostcheck(runs[0], baseline);

  const failed = runs.filter((r) => !isRunPassed(r));
  if (failed.length === 0) {
    return `${POSTCHECK_TAG} 全部通过（${runs.length} 条：${runs.map((r) => r.command).join('；')}）`;
  }

  // 每条都传 tail=false：那句「改动已落盘…」改由下面统一说一次。否则两条命令失败时
  // 同一句话会跟着两条正文各出现一遍（曾经的真 bug）。
  const parts = failed.map((r) => describePostcheck(r, baseline, false));
  return `${POSTCHECK_TAG} ${runs.length} 条中 ${failed.length} 条未通过：\n`
    + parts.join('\n\n')
    + '\n改动已落盘；先处理这些，再往下加新的改动（下一次写文件会自动重跑）。';
}

/** 一条自检算不算过：只有「正常退出且退出码 0」才算过，其余（超时 / 起不来 / 未执行）都不算 */
export function isRunPassed(run: PostcheckRun): boolean {
  return run.skipped !== true
    && run.status === 0
    && typeof run.errorCode !== 'string';
}

/**
 * 从一轮自检结果里收集**全部**结构化身份（用于播种基线 / 比对）。
 * 两类键共用一个集合，靠命名空间前缀区分（`test|` vs 诊断的 `文件|码|消息`）——
 * 基线只是一条"启动前就有这些"的清单，它不需要知道每一条是哪个测试器报的。
 */
export function collectRunKeys(runs: readonly PostcheckRun[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (k: string): void => {
    if (seen.has(k)) return;
    seen.add(k);
    keys.push(k);
  };
  for (const r of runs) {
    for (const d of parseDiagnostics(r.stdout, r.stderr)) push(diagnosticKey(d));
    for (const k of collectTestFailureKeys(parseTestFailures(r.stdout, r.stderr))) {
      push(TEST_KEY_PREFIX + k);
    }
  }
  return keys;
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

/**
 * 基线 —— 启动时那次自检的诊断身份集合。**同样是内存单例、同样只在启动播种一次**，
 * 理由与登记表同一条：运行期重跑基线等于让模型「把当前的错洗白成基线」，
 * 那这条防线就自己把自己拆了。
 *
 * `null` = 还没采（或没登记表，不启用）；`[]` = 采过了，启动前项目是干净的。
 * 这个区分是承重的：空数组表示「基线是零」，不是「没有基线」。
 */
let baseline: string[] | null = null;

export const postcheckBaseline = {
  set(keys: string[] | null): void {
    baseline = keys;
  },
  get(): string[] | null {
    return baseline;
  },
  /** 复位（只给测试用） */
  clear(): void {
    baseline = null;
  },
};
