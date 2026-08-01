/**
 * Agent 启动逻辑。
 * 调用方：harness/index.ts（check 通过后由 Harness.run 调用）
 * 服务于：接收 check 结果 → 创建闭包工厂 → 注入 Runtime → 按模式交互
 */

import { Runtime } from '../runtime/runtime.js';
import { Mode } from '../types.js';
import type { CheckResult, SessionStorage } from '../types.js';
import { existsSync } from 'node:fs';
import { closeTerminal, isClosed, readLine, readLineWithMode, type InputSubmitMode } from '../io/terminal.js';
import { JsonlSessionStorage } from '../runtime/jsonl-storage.js';
import { registerBuiltinCommands } from '../runtime/commands.js';
import { registerBuiltinTools } from '../runtime/tools.js';
import { demoInputHandler } from '../runtime/commands-handle.js';
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

/** 待处理的用户输入队列（非阻塞 REPL 用） */
interface PendingInput {
  text: string;
  mode: InputSubmitMode;
}

/** 输入队列：键盘常驻监听写入，处理循环消费 */
const pendingInputs: PendingInput[] = [];

/**
 * 等待队列中有输入（避免竞态：先注册唤醒，再检查队列）。
 * 若队列已有数据立即返回；否则挂起等 listener 写入后唤醒。
 */
function waitForInput(): Promise<void> {
  if (pendingInputs.length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    // listener 写入后需要通知 —— 用一个轮询间隔兜底（简单可靠）
    const check = setInterval(() => {
      if (pendingInputs.length > 0 || isClosed()) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });
}

/**
 * 启动常驻键盘监听：任何时刻用户打字都立即入队。
 * 普通 Enter → mode='enter'（steer，插入打断）
 * Alt+Enter → mode='alt-enter'（followUp，排队）
 * 依赖 terminal.ts 的 lineBuffer：流式期间主循环不读 stdin 时，
 * 输入先进 lineBuffer，listener 的 readLineWithMode 读到后入队。
 */
async function startInputListener(): Promise<void> {
  while (true) {
    if (isClosed()) break;
    const { text, mode } = await readLineWithMode();
    if (isClosed()) break;
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (trimmed === '/exit') break;
    pendingInputs.push({ text: trimmed, mode });
  }
}

async function runReplMode(runtime: Runtime, info: ReplInfo): Promise<void> {
  const ui = new TerminalUI();

  ui.showBanner(info);
  ui.attach(runtime);

  // 非 TTY（管道模式）：走旧的顺序读取，一次处理一条输入
  if (!process.stdin.isTTY) {
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
    return;
  }
  // TTY：启动常驻键盘监听（后台运行），支持生成中打断（steer/followUp）
  const listenerPromise = startInputListener();

  // 处理循环：空闲时取队列处理
  while (true) {
    if (isClosed()) break;

    // 等待有输入可处理
    await waitForInput();
    const pending = pendingInputs.shift();
    if (!pending) {
      if (isClosed()) break;
      continue;
    }

    // 普通 Enter → steer（插入打断）；Alt+Enter → followUp（排队）
    const behavior = pending.mode === 'alt-enter' ? 'followUp' : 'steer';
    ui.showUserInput(pending.text);
    await runtime.prompt(pending.text, undefined, behavior);
  }

  ui.detach();
  await listenerPromise;
}
