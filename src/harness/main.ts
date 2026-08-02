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

  // 初始化持久化会话
  const sessionDir = './sessions';
  const sessionPath = `${sessionDir}/default.jsonl`;
  const session: SessionStorage = existsSync(sessionPath)
    ? await JsonlSessionStorage.open(sessionPath)
    : await JsonlSessionStorage.create(sessionDir, 'default');

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

  process.on('SIGINT', () => { closeTerminal(); runtime.stop().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { closeTerminal(); runtime.stop().then(() => process.exit(0)); });

  // 收集启动信息传入 UI
  const msgs = await session.getMessages();
  await runReplMode(runtime, {
    // ui页面展示的信息
    model: modelName,
    baseUrl,
    sessionMsgs: msgs.length,
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
