/**
 * 内置工具注册 —— Read / Write / Grep / Bash 四个核心工具。
 * 调用方：main.ts（Runtime 创建后立即调用）
 * 服务于：为 LLM 提供读文件、写文件、搜索内容、执行命令的能力
 *
 * 设计原则：
 * 1. 参数名只认规范名，不搞多别名（结构化 function calling 由 API 保证参数格式）
 * 2. 每个参数有明确的类型约束和示例值
 * 3. 输出格式统一为 `[状态标识] 描述\n详情`
 * 4. 输入参数做运行时校验，非法参数不执行
 */
import type { Runtime } from './runtime.js';

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

/* ═══════════════════════════════════════════════════════════════════════════════
   工具注册
   ═══════════════════════════════════════════════════════════════════════════════ */

export function registerBuiltinTools(runtime: Runtime): void {
  /* ── Read：读文件 ── */
  runtime.tools.register({
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
  runtime.tools.register({
    name: 'write',
    description: '创建新文件或覆盖已有文件的内容。自动创建不存在的父目录。路径用 / 或 \\\\。',
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

  /* ── Grep：搜索文件内容 ── */
  runtime.tools.register({
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
  runtime.tools.register({
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
