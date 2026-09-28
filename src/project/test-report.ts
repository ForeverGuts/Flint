/**
 * 验证结果结构化 —— **测试器**那一半（ROADMAP 10.6.3）。
 * 调用方：project/postcheck.ts（自检回执）；服务于「改完一个文件，当场知道哪个用例挂了、挂在哪」。
 *
 * 与 postcheck 里那套 `parseDiagnosticLine` 的关系：**两路并列，不是替换**。
 *   诊断路（已落地）认的是**编译器**：`src/a.ts(1,14): error TS2322: …`；
 *   本文件认的是**测试器**：`not ok 1 - 用例名` + `location: '文件:行:列'`。
 * 两条路输出的东西不一样：诊断给「哪行代码写错了」，测试给「哪个用例挂了」。模型下一步的动作
 *   也不同（前者去改那行，后者去读那个用例、判断是断言过时还是代码写坏）。
 *
 * 【只认实测过的形态 —— 本项目纪律：没实测到的格式不许用推理补】
 *   唯一被认的测试器是 **Node 内置测试器**（`node --test`，零依赖项目最常用的那种，也是本机
 *   唯一能真跑出样本的）。2026-09-28 探针实测（WorkBuddy_Test/probe-test*.mjs）四条形态：
 *     ① 非 TTY 下输出 **TAP**，`not ok 1 - should fail on purpose`，位置在随后的 YAML 块里：
 *        `  location: 'C:\…\probe-test.mjs:3:1'`（**带单引号、Windows 绝对路径**）；
 *     ② **嵌套子测试**缩进四空格，且父测试**也**会报一条 `not ok`（`failureType: 'subtestsFailed'`）；
 *     ③ **`# TODO` 指令**的 `not ok` 不进 `# fail` 计数（已登记为"知道它会挂"，不算本次事故）；
 *     ④ `npm test` 包装只加两行 `> …` 横幅，TAP 正文原样透传。
 *   由此得出两条判据（都有实测支撑，不是推理）：
 *     · **父测试的 `subtestsFailed` 保留、不丢弃** —— 官方 `# fail N` 把它算进去了，丢掉就会
 *       出现「统计说 2 个、我只列 1 个」的自相矛盾；而它那行（外层用例名 + 外层位置）也确实
 *       比只报内层更有用。代价是父子各占一行，可接受。
 *     · **带 `# TODO` / `# SKIP` 指令的 `not ok` 一律不算失败** —— 否则条数会对不上官方统计。
 *   **刻意不支持（未实测，不许猜）**：vitest / jest / mocha / pytest 的输出形态。它们没装在本机，
 *     拿不到样本；按 gitignore 那次「语义类功能的期望值必须拿权威实现当 oracle」的纪律，
 *     宁可只做一种也不凭印象写正则。认不出的后果是**退回原来的按行摘要**，不是认错。
 *
 * 本文件**零 import**（同 postcheck / gitignore / commands 的纯函数形态），可脱离终端验。
 */

/** 一条失败用例 —— 「哪个用例挂了、挂在哪」的最小充分信息 */
export interface TestFailure {
  /** 用例名（TAP 里 `-` 之后那一段；已去掉 `# TODO` 一类的指令） */
  name: string;
  /** 文件路径（原样，认不出时为 ''）。**刻意不做相对化**：回执里的路径要能直接喂给 read */
  file: string;
  /** 行号（认不出时为 0） */
  line: number;
  /** 原始整行（去首尾空白），用于原样回显 */
  raw: string;
}

/** 测试器自报的数量统计（TAP 尾部那几行 `# tests` / `# pass` / `# fail`） */
export interface TestCounts {
  total: number;
  pass: number;
  fail: number;
}

/** 摘要里最多列几条失败用例（超出就写「还有 N 条」）。回执不封顶会把工具结果撑爆 */
export const TEST_MAX_FAILURES = 20;

/** `not ok 1 - 用例名`（允许缩进：嵌套子测试是四空格） */
const NOT_OK_RE = /^\s*not ok\s+\d+\s*-\s*(.*)$/;

/** 正常的 `ok 3 - 名字`：只用于**收束**上一条没等到 `...` 的失败块，本身不是失败 */
const OK_RE = /^\s*ok\s+\d+\s*-\s*(.*)$/;

/** TAP 指令：`# TODO`（已知会挂）/ `# SKIP`（跳过）。带它的 `not ok` 不计入失败 */
const DIRECTIVE_RE = /#\s*(?:TODO|SKIP)\b/;

/** 块内的位置行：`  location: 'C:\…\x.mjs:3:1'` */
const LOCATION_RE = /^\s*location:\s*(.*?)\s*$/;

/** YAML 块结束标记：`  ...` */
const BLOCK_END_RE = /^\s*\.\.\.\s*$/;

/** 尾部统计：`# tests 3` / `# pass 1` / `# fail 2` */
const COUNT_TESTS_RE = /^\s*#\s*tests\s+(\d+)\s*$/;
const COUNT_PASS_RE = /^\s*#\s*pass\s+(\d+)\s*$/;
const COUNT_FAIL_RE = /^\s*#\s*fail\s+(\d+)\s*$/;

/**
 * 从「文件:行:列」里拆出文件与行号。**从末尾往回切** —— Windows 绝对路径自带盘符冒号
 * （`C:\…\x.mjs:3:1`），从前面切会把 `C` 当成文件名。贪婪的 `.*` 正好取到最后两组数字。
 */
const PATH_LINE_RE = /^(.*):(\d+):(\d+)$/;

/** 把 stdout + stderr 合成行数组（顺序：stdout 在前，与 postcheck 的拼接顺序一致） */
function splitLines(stdout: unknown, stderr: unknown): string[] {
  const norm = (v: unknown): string =>
    typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : '';
  return `${norm(stdout)}\n${norm(stderr)}`.split('\n');
}

/**
 * 认一段输出里有哪些**失败用例**。认不出任何一条时返回空数组（调用方据此退回按行摘要）。
 *
 * 为什么是**状态机**而不是「每行一条正则」：TAP 里「一行」不等于「一个用例」——
 * 用例名在 `not ok` 行，位置在它下面好几行的 `location:` 里，中间夹着 duration / error / stack。
 * 要同时拿到两者就必须跨行。
 */
export function parseTestFailures(
  stdout: unknown,
  stderr: unknown,
): TestFailure[] {
  const out: TestFailure[] = [];
  let pending: TestFailure | null = null;

  const flush = (): void => {
    if (pending) out.push(pending);
    pending = null;
  };

  for (const line of splitLines(stdout, stderr)) {
    if (NOT_OK_RE.test(line)) {
      flush();
      // 带 TODO / SKIP 指令的不算失败（实测：它们不进 `# fail` 计数）
      if (!DIRECTIVE_RE.test(line)) {
        const m = NOT_OK_RE.exec(line);
        const name = m ? stripDirective(m[1]) : '';
        pending = { name, file: '', line: 0, raw: line.trim() };
      }
      continue;
    }
    if (OK_RE.test(line)) {
      flush();
      continue;
    }
    if (!pending) continue;

    // 位置只在还没填过时取（块内后面还有 stack 行，别让它覆盖）
    if (pending.file === '') {
      const m = LOCATION_RE.exec(line);
      if (m) {
        const at = parsePathLine(m[1]);
        if (at) {
          pending.file = at.file;
          pending.line = at.line;
        }
      }
    }
    if (BLOCK_END_RE.test(line)) flush();
  }
  flush();
  return out;
}

/** 去掉 TAP 指令尾巴：`inner broken # TODO 等 X 修` → `inner broken` */
function stripDirective(text: string): string {
  return text.replace(/\s*#\s*(?:TODO|SKIP)\b.*$/, '').trim();
}

/** 解析 `location:` 的值：先剥成对引号、把 YAML 写两遍的反斜杠折回一遍，再按 `文件:行:列` 拆 */
function parsePathLine(value: string): { file: string; line: number } | null {
  let v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    if ((first === "'" || first === '"') && v.endsWith(first)) v = v.slice(1, -1);
  }
  // 2026-09-28 实测（Windows）：`node --test` 把 location 写成一个 YAML 字符串，路径里
  // **每个反斜杠都写了两遍** —— 真机上拿到的原文是 `location: 'C:\\Users\\…\\a.test.mjs:3:1'`。
  // 按「`\\` 表示一个 `\`」折回去，理由只有一句：**回执里的路径要长得跟真路径一样**。
  // 双反斜杠在 Windows 上侥幸也能用（系统会把连续分隔符折叠掉，`existsSync` 照样 true），
  // 但模型把它原样带进 shell 参数或 git 命令时会被**再解释一次** —— 那种错不会报错，
  // 只会静默指向另一个地方。只处理成对的反斜杠，`\n` / `\t` 之类一概不动（没实测过）。
  v = v.replace(/\\\\/g, '\\');
  const m = PATH_LINE_RE.exec(v);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]) };
}

/**
 * 读测试器自报的数量统计。**三个数缺一个就返回 null** —— 只认得一半的统计比不给更坏
 * （「3 个用例中 ? 个失败」这种半句话会让人自己脑补）。给了就用在摘要开头。
 */
export function parseTestCounts(
  stdout: unknown,
  stderr: unknown,
): TestCounts | null {
  let total = -1;
  let pass = -1;
  let fail = -1;
  for (const line of splitLines(stdout, stderr)) {
    const t = COUNT_TESTS_RE.exec(line);
    if (t) total = Number(t[1]);
    const p = COUNT_PASS_RE.exec(line);
    if (p) pass = Number(p[1]);
    const f = COUNT_FAIL_RE.exec(line);
    if (f) fail = Number(f[1]);
  }
  if (total < 0 || pass < 0 || fail < 0) return null;
  return { total, pass, fail };
}

/**
 * 失败用例的**身份**（用于基线比对「这条是不是启动前就挂着的」）。
 * 与诊断键同理**不含行号**：往测试文件里插一行，下面所有用例的行号全变，但它们还是那几个。
 */
export function testFailureKey(f: TestFailure): string {
  return `${f.file}|${f.name}`;
}

/** 抽出一个失败集合的身份集合（去重，保持首次出现顺序） */
export function collectTestFailureKeys(
  failures: readonly TestFailure[],
): string[] {
  const seen = new Set<string>();
  for (const f of failures) {
    const k = testFailureKey(f);
    if (!seen.has(k)) seen.add(k);
  }
  return [...seen];
}

/** 单条失败的回显：`✗ 用例名（文件:行）`。认不出位置时只有名字 —— 名字本身已经能定位 */
export function renderTestFailure(f: TestFailure): string {
  const where = f.file !== '' && f.line > 0 ? `（${f.file}:${f.line}）` : '';
  return `✗ ${f.name}${where}`;
}

/**
 * 渲染失败用例摘要。
 *
 * 条数以**实际认出来的条数**为准，不自报的 `counts.fail` 顶替：输出被截断（如 ENOBUFS）时
 * 统计行可能还在、而条目已经不全了 —— 那种情况下说「自报 2 个失败」却不列出它们，比少报更坏。
 * `counts` 只用来提供**分母**（一共几个用例）。
 */
export function summarizeTestFailures(
  failures: readonly TestFailure[],
  counts: TestCounts | null = null,
  maxFailures: number = TEST_MAX_FAILURES,
): string {
  if (failures.length === 0) return '';
  const cap = maxFailures > 0 ? maxFailures : 1;
  const shown = failures.slice(0, cap).map(renderTestFailure);
  const rest = failures.length - shown.length;
  if (rest > 0) shown.push(`……（还有 ${rest} 条未列出）`);

  const head = counts !== null && counts.total > 0
    ? `${counts.total} 个用例中 ${failures.length} 个失败：`
    : `${failures.length} 个失败用例：`;
  return `${head}\n${shown.join('\n')}`;
}
