/**
 * Agent 启动逻辑。
 * 调用方：harness/index.ts（check 通过后由 Harness.run 调用）
 * 服务于：接收 check 结果 → 创建闭包工厂 → 注入 Runtime → 按模式交互
 */

import { Runtime } from '../runtime/runtime.js';
import { Mode } from '../types.js';
import type { CheckResult, SessionStorage } from '../types.js';
import { existsSync } from 'node:fs';
import { closeTerminal, isClosed, readLine } from '../io/terminal.js';
import { JsonlSessionStorage } from '../runtime/jsonl-storage.js';
import { registerBuiltinCommands } from '../runtime/commands.js';
import { registerBuiltinTools } from '../runtime/tools.js';
import { demoInputHandler } from '../runtime/commands-handle.js';
import { TreeUI } from '../io/ui/tree-ui.js';
import { TerminalUI } from '../io/ui/index.js';

interface CreateRuntimeOptions {
  session?: SessionStorage | undefined;
  services?: unknown;
  cwd?: string;
  model?: string;
}

interface CreateRuntimeResult {
  runtime: Runtime;
}

export async function main(checkResult: CheckResult): Promise<void> {
  const { llm } = checkResult;
  const modelName = checkResult.config?.model ?? 'unknown';
  const baseUrl = checkResult.config?.baseUrl ?? '';

  // 初始化持久化会话（v2 会话树格式）
  const sessionDir = './sessions';
  const sessionPath = `${sessionDir}/default.jsonl`;
  let session: SessionStorage;
  try {
    session = existsSync(sessionPath)
      ? await JsonlSessionStorage.open(sessionPath)
      : await JsonlSessionStorage.create(sessionDir, 'default');
  } catch (err) {
    // 旧 v1 线性格式已废弃：不迁移，提示后建新文件
    if (existsSync(sessionPath)) {
      console.warn(`[会话] 检测到旧版会话文件（v1 线性格式已废弃），新建空会话。旧文件可手动删除。`);
      console.warn(`[会话] 详情: ${err instanceof Error ? err.message : String(err)}`);
      session = await JsonlSessionStorage.create(sessionDir, 'default');
    } else {
      throw err;
    }
  }

  const createRuntime = async (options: CreateRuntimeOptions): Promise<CreateRuntimeResult> => {
    const runtime = new Runtime({
      mode: Mode.Repl,
      llm,
      session: options.session ?? session,
      model: modelName,
      provider: checkResult.config?.provider ?? '',
      baseUrl,
    });
    return { runtime };
  };

  const { runtime } = await createRuntime({});

  // 注册命令 + 工具 + 事件处理器
  await registerBuiltinCommands(runtime);
  registerBuiltinTools(runtime);
  runtime.onInput(demoInputHandler);

  // SIGINT/Ctrl+C：raw mode 下由 InputHandler 处理（选择器取消/输入），
  // 这里只作兜底（非 TTY 或 InputHandler 未捕获时），优雅退出
  process.on('SIGINT', () => {
    if (!process.stdin.isTTY) {
      closeTerminal();
      runtime.stop().then(() => process.exit(0));
    }
    // TTY 下：Ctrl+C 交给 InputHandler（onSelectKey 消费），此处不退出
  });
  process.on('SIGTERM', () => { closeTerminal(); runtime.stop().then(() => process.exit(0)); });

  // 收集启动信息传入 UI
  await runReplMode(runtime, {
    // ui页面展示的信息
    model: modelName,
    baseUrl,
    sessionMsgs: await runtime.getSessionMsgCount(),
    toolCount: runtime.tools.getLLMTools().length,
    cmdCount: runtime.listCommands().length,
    skillCount: runtime.getSkillLoader().getAll().length,
  });

  closeTerminal();
}

/* ── REPL 模式 ── */

interface ReplInfo {
  model: string;
  baseUrl: string;
  sessionMsgs: number;
  toolCount: number;
  cmdCount: number;
  skillCount: number;
}

async function runReplMode(runtime: Runtime, info: ReplInfo): Promise<void> {
  // TTY 模式：组件树 UI（方案 C）—— pi-tui 接管终端，Input 组件接收输入
  if (process.stdin.isTTY) {
    const ui = new TreeUI(runtime, info);
    ui.start();
    // TUI 启动后常驻，直到进程退出（Input.onSubmit 处理 /exit）
    await new Promise<void>(() => {}); // 挂起，等待 /exit 或 SIGINT
    ui.stop();
    return;
  }

  // 非 TTY（管道模式）：用轻量文本 UI（TerminalUI）顺序输出，一次处理一条输入
  const ui = new TerminalUI();
  ui.showBanner(info);
  ui.attach(runtime);
  while (true) {
    const input = await readLine();
    const trimmed = input.trim();
    // 注意：管道模式下 stdin 关闭后 readLine 仍能返回缓冲中的最后一行，
    // 此时 isClosed() 为 true 但数据有效 —— 先处理数据，再判断是否退出。
    if (trimmed && trimmed !== '/exit') {
      ui.showUserInput(trimmed);
      await runtime.prompt(trimmed);
    }
    if (isClosed()) break;
    if (!trimmed) continue;
    if (trimmed === '/exit') break;
  }
  ui.detach();
}
