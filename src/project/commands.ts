/**
 * 项目命令注册表（ROADMAP 10.6.1，**发现**半边）—— 把"这个项目有哪些命令"从"模型每轮现猜"
 * 变成"程序一次发现、每轮注入"。10.6.2 只给了登记表的**最小实现**（`.flint/postcheck.json`
 * 由用户手写整句命令），本条补的是另一半：**名字从哪来**。
 *
 * 为什么值得单做一条：模型第一次进陌生项目，跑测试要猜 `npm test` 还是 `pnpm test`、
 * `make check` 还是 `npm run verify` —— 猜错白烧一轮，且它不知道自己猜错了（命令不存在
 * 只是退出码非 0）。把 scripts 表摆进上下文，"有哪些命令、分别跑什么"变成**读**而不是**猜**。
 *
 * 【本条最重要的一条界线：发现 ≠ 授权】
 *   发现的命令**绝不自动执行**。`package.json` 是模型**可写**的文件，若把它当授权书，
 *   模型改一行 scripts 就能给自己开一条免弹窗执行的路 —— 与 postcheck.ts 文件头论证过的
 *   那条自我授权路径**同源**（登记表只在启动读一次，正是为了断这条路）。所以本模块只做两件事：
 *     ① **注入**：命令表摆进上下文，模型看得见（这是"减噪/省事"，不是门禁）；
 *     ② **被引用**：登记表可以写 `{"use":"test"}` 引用注册表里的名字 —— **授权仍来自人写的
 *        那份登记表**（声明即授权不变），命令**本体**由注册表解析（package.json 里改了实现，
 *        登记表不用跟着改）。引用不到的名字 = 没声明好 = 不启用。
 *   推论：**没有登记表就什么都不跑**，与本功能接入前逐字一致。
 *
 * 为什么注册表**只在启动读一次**（见 harness/main.ts）：同 postcheck 的那条理由，且这里更直接 ——
 *   运行期重读 `package.json`，等于让模型改 scripts 立刻改写注入内容、并让 `use` 指向另一条命令。
 *   读一次进内存，运行期改文件不生效。
 *
 * 【已知边界，不装糊涂】只发现 `package.json` 的 `scripts`，**不做 Makefile**。
 *   路线图原文写的是"package.json scripts / Makefile"，但 Makefile 的 target 语法（含变量展开、
 *   模式规则、`.PHONY`、条件指令）**本机没有 make 可对拍**（实测 `which make` 无命中），
 *   按本项目"语义类功能的期望值必须拿权威实现当 oracle、没实测到的那一半不许用推理补"的纪律
 *   （见 gitignore 那次 `git check-ignore` 对拍与 git 分隔符那个错），这一半**留着不做**，
 *   而不是写一个"看着对"的解析器。它随时可加：加一个 `parseMakefile()`，走同一套
 *   `ProjectCommand` 形状，注入端与引用端都不用动。
 *
 * 与 ROADMAP 10.1.1（技术栈探测）的**唯一接头**：`run` 串的包管理器前缀由调用方传入
 *   （`parsePackageScripts` 的第二参数）。本文件**不自己探测** —— 探测归 `project/stack.ts`；
 *   两半在**同一时刻**播种（`harness/project-context.ts` 播种画像 → `harness/main.ts` 用它读 scripts），
 *   刷新率一致，于是不可能出现"画像段说 pnpm、命令表写着 npm"。
 *
 * 本文件**零 import**（无 node:fs / node:child_process）：解析与渲染都是纯函数，可脱离终端验。
 *   读文件在 harness/main.ts（宽容读），注入在 src/context/system-prompt.ts 的 project 层。
 */

/** 命令来源：当前只有 package.json（Makefile 半边留待可实测时再加，见文件头） */
export const PACKAGE_JSON_FILE = 'package.json';

/** 注入时最多列几条命令。巨型 monorepo 的 scripts 能有上百条，全灌进上下文是灾难 */
export const COMMANDS_RENDER_MAX = 40;

/** 命令名（scripts 的键）的长度上限：超长的名字不是给人跑的（多半是生成物），丢掉 */
export const COMMAND_NAME_MAX = 60;

/** 注入时命令**内容**（scripts 的值）的预览长度上限：拿它看"这条大概干什么"，不是看全文 */
export const COMMAND_PREVIEW_MAX = 120;

/**
 * 包管理器判不出来时的缺省值 —— 与 10.1.1 落地前硬写的那个值**逐字相同**，
 * 于是"探测不到任何东西"的项目行为不回退（默认态零变化）。
 */
export const DEFAULT_MANAGER = 'npm';

/** 允许出现在 `run` 串前缀里的形状：小写字母开头、只含小写字母与连字符 */
const SAFE_MANAGER = /^[a-z][a-z0-9-]*$/;

/** 分类标签。这是**展示分组**，不参与任何判定 —— 见 classifyCommand 头注 */
export type CommandKind =
  | 'test'
  | 'typecheck'
  | 'lint'
  | 'build'
  | 'format'
  | 'dev'
  | 'other';

/** 分类的中文标签（注入时给人看；同一处定义，别处不要另抄一份） */
export const KIND_LABELS: Record<CommandKind, string> = {
  test: '测试',
  typecheck: '类型检查',
  lint: '静态检查',
  build: '构建',
  format: '格式化',
  dev: '开发服务',
  other: '其他',
};

/** 一条被发现的命令 */
export interface ProjectCommand {
  /** scripts 的键（引用的就是它，如 `test`） */
  name: string;
  /** 可执行的一整句（如 `npm run test`）—— 登记表 `{"use":"test"}` 最终解析成它 */
  run: string;
  /** scripts 的值（如 `tsc --noEmit`），只用于展示"这条到底跑什么" */
  script: string;
  kind: CommandKind;
}

/**
 * 分类启发式。**刻意只是展示分组，不参与任何判定** —— 不挑"该自动跑哪条"、
 * 不影响 `use` 能否解析（那看的是名字）。理由：哪个名字算测试是**项目约定**，
 * 属策略不是正确性；判错了的代价只是标签不好看（这是减噪，不是门禁，判据同 gitignore）。
 * 顺序即优先级：`typecheck` 排在 `test` 之前，因为 `test:ci` 这类名字会先命中 test。
 */
export function classifyCommand(name: string, script: string): CommandKind {
  const n = name.toLowerCase();
  if (/type|tsc/.test(n)) return 'typecheck';
  if (/test|spec|e2e|check/.test(n)) return 'test';
  if (/lint|eslint/.test(n)) return 'lint';
  if (/build|compile|bundle|dist/.test(n)) return 'build';
  if (/format|fmt|prettier/.test(n)) return 'format';
  if (/dev|serve|start|watch/.test(n)) return 'dev';
  if (/^tsc\b|\btsc\b/.test(script.toLowerCase())) return 'typecheck';
  return 'other';
}

/**
 * 从 `package.json` 的文本里抽出 scripts。**宽容**：读不懂就当没有（返回空表）——
 * 本功能只是"少猜一次"，读不出来退回现状即可，绝不该因此让启动失败。
 * 条目级过滤（空名、超长名、值不是非空字符串）也是同一个理由：脏条目丢掉比硬塞好。
 *
 * `run` 的**命令前缀**（`<manager> run <name>`）由第二参数给，缺省 `npm` —— 本条落地时
 * 硬写死 npm，自 ROADMAP **10.1.1**（技术栈探测）起改为**由画像派生**：探测到
 * `pnpm-lock.yaml` 就写 `pnpm run test`（`main.ts` 播种时把 `stackRegistry` 里的
 * `nodeManager` 传进来）。两半的刷新率必须一致，否则会出现"画像段说 pnpm、命令表写 npm"
 * ——所以两者都在**同一时刻**播种、运行期都不回读。
 *
 * 参数是 `string` 而**不是** `NodeManager`：本文件有"零 import"的源码守护
 * （`verify-commands.ts` 的 F1），引一个类型过去会把它顶掉。代价是这里得自己挡脏值 ——
 * 见下面那道 `SAFE_MANAGER` 正则：非字符串 / 空 / 含空格或重定向符号一律退回 `npm`，
 * 因为它要拼进一句**要被执行**的命令里（虽然本模块自己不执行）。
 */
export function parsePackageScripts(text: unknown, manager: string = DEFAULT_MANAGER): ProjectCommand[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const pm = typeof manager === 'string' && SAFE_MANAGER.test(manager.trim())
    ? manager.trim()
    : DEFAULT_MANAGER;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const scripts = (raw as Record<string, unknown>).scripts;
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return [];

  const out: ProjectCommand[] = [];
  for (const [key, value] of Object.entries(scripts as Record<string, unknown>)) {
    const name = key.trim();
    if (name === '' || name.length > COMMAND_NAME_MAX) continue;
    if (typeof value !== 'string' || value.trim() === '') continue;
    const script = value.trim();
    out.push({ name, run: `${pm} run ${name}`, script, kind: classifyCommand(name, script) });
  }
  return out;
}

/** 按名字查一条命令（给登记表 `use` 用）。**精确匹配**，与 PermissionManager 同一手法：不猜 */
export function findCommand(
  commands: readonly ProjectCommand[],
  name: unknown,
): ProjectCommand | undefined {
  if (typeof name !== 'string') return undefined;
  const want = name.trim();
  if (want === '') return undefined;
  return commands.find((c) => c.name === want);
}

/** 单行渲染：`- \`npm run verify\`〔验证〕—— node ...`；预览超长截断，不换行（一行一条才好扫） */
function renderLine(c: ProjectCommand): string {
  const label = KIND_LABELS[c.kind];
  const preview = c.script.length > COMMAND_PREVIEW_MAX
    ? `${c.script.slice(0, COMMAND_PREVIEW_MAX)}…`
    : c.script;
  return `- \`${c.run}\`〔${label}〕—— ${preview}`;
}

/**
 * 渲染注入用的【项目命令】段。**空表返回空串**（整段缺席）——
 * 与 project/memory/task 三层同一纪律：**没有就不注入**，别拿空壳占上下文。
 * 超出上限的部分只报条数：这儿是"有哪些命令"的地图，不是完整清单（要看全的去读 package.json）。
 */
export function renderCommandsSection(commands: readonly ProjectCommand[]): string {
  if (!Array.isArray(commands) || commands.length === 0) return '';
  const shown = commands.slice(0, COMMANDS_RENDER_MAX);
  const lines = shown.map(renderLine);
  if (commands.length > shown.length) {
    lines.push(`- ……另有 ${commands.length - shown.length} 条未列出（完整清单见 package.json）`);
  }
  return `## 项目命令（来自 package.json 的 scripts —— 跑之前不必再猜）\n${lines.join('\n')}`;
}

/**
 * 当前生效的命令表（内存单例）。**运行期唯一真相源**，与 postcheckRegistry 同一手法：
 * 启动时由 harness 播种一次，之后不再回读文件（理由见文件头"发现 ≠ 授权"）。
 * 刻意不做成 store 类：这份表启动后不变，没有增量变更，也就不需要变更通知。
 */
let current: ProjectCommand[] = [];

export const commandRegistry = {
  set(commands: readonly ProjectCommand[]): void {
    current = Array.isArray(commands) ? [...commands] : [];
  },
  get(): ProjectCommand[] {
    return current;
  },
  /** 复位（只给测试用：模块级单例会跨套件残留，验完必须清） */
  clear(): void {
    current = [];
  },
};
