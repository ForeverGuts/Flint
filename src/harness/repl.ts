/**
 * REPL 模式 —— 交互式命令行界面（TTY 组件树 / 管道 TerminalUI）。
 * 调用方：main.ts（模式分发，FLINT_MODE 非 rpc 时进入）
 * 服务于：与 rpc.ts 对称——把 REPL 从 main.ts 抽离，main 只做组装 + 分发
 *
 * 两种 UI：
 *   - TTY：TreeUI（自研组件树 + Screen 差分渲染）
 *   - 非 TTY（管道）：TerminalUI（轻量文本顺序输出）
 */
import type { Runtime } from '../runtime/runtime.js';
import { closeTerminal, isClosed, readLine } from '../io/terminal.js';
import { TreeUI } from '../io/ui/tree-ui.js';
import { TerminalUI } from '../io/ui/index.js';

/** REPL UI 展示信息（banner + 状态行） */
export interface ReplInfo {
  model: string;
  baseUrl: string;
  sessionMsgs: number;
  toolCount: number;
  cmdCount: number;
  skillCount: number;
  /** 启动自检诊断（可靠性工程），banner 下方展示 */
  diagnostics: import('../types.js').Diagnostic[];
  /**
   * 通讯录准入提示（ROADMAP 10.11.6）—— 判成独立项目时为 null = **不显示**。
   * 只有"这个目录为什么没进通讯录"这类情形才有话说（嵌套子目录 / 候选 / 硬排除）；
   * 非 TTY（管道）模式**不展示**（与诊断同口径：管道输出要能直接被脚本消费）。
   */
  projectNote?: string | null;
}

/** 基于 runtime 组装 REPL 展示信息（单一信息源，main 不需重复取） */
async function buildReplInfo(
  runtime: Runtime,
  diagnostics: import('../types.js').Diagnostic[],
  projectNote?: string | null,
): Promise<ReplInfo> {
  return {
    model: runtime.currentModel,
    baseUrl: runtime.currentBaseUrl,
    sessionMsgs: await runtime.getSessionMsgCount(),
    toolCount: runtime.tools.getLLMTools().length,
    cmdCount: runtime.listCommands().length,
    skillCount: runtime.getSkillLoader().getAll().length,
    diagnostics,
    // exactOptionalPropertyTypes：无提示时**不传这个键**（而不是传 undefined）
    ...(projectNote ? { projectNote } : {}),
  };
}

/**
 * 运行 REPL 模式（TTY 组件树 UI 或管道 TerminalUI）。
 * @param probePromise 后台网络探测（启动提速第一档）：界面先行，结果到达后回填；
 *        TTY 由 TreeUI 在订阅完成后消费，管道模式不展示诊断（与历史行为一致）
 * @param projectNote 通讯录准入提示（ROADMAP 10.11.6）：null = 不显示；
 *        同样只在 TTY 下展示（管道模式连诊断都不展示，提示更不该混进可被脚本消费的输出）
 */
export async function runReplMode(
  runtime: Runtime,
  diagnostics: import('../types.js').Diagnostic[],
  probePromise?: Promise<import('../types.js').Diagnostic[]>,
  projectNote?: string | null,
): Promise<void> {
  const info = await buildReplInfo(runtime, diagnostics, projectNote);

  // TTY 模式：组件树 UI —— 接管终端，Input 组件接收输入
  if (process.stdin.isTTY) {
    const ui = new TreeUI(runtime, info, probePromise);
    ui.start();
    // TUI 启动后常驻，直到进程退出（Input.onSubmit 处理 /exit）
    await new Promise<void>(() => {}); // 挂起，等待 /exit 或 SIGINT
    ui.stop();
    closeTerminal();
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
  closeTerminal();
}
