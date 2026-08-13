/**
 * Agent 启动逻辑。
 * 调用方：harness/index.ts（check 通过后由 Harness.run 调用）
 * 服务于：接收 check 结果 → 创建闭包工厂 → 注入 Runtime → 按模式分发（REPL / RPC）
 *
 * 模式：REPL（交互界面，见 repl.ts）/ RPC（外部程序 JSON-RPC，见 rpc.ts）
 */
import { Runtime } from '../runtime/runtime.js';
import { Mode } from '../types.js';
import type { CheckResult, SessionStorage } from '../types.js';
import { existsSync } from 'node:fs';
import { closeTerminal } from '../io/terminal.js';
import { JsonlSessionStorage } from '../session/jsonl-storage.js';
import { registerBuiltinCommands } from '../commands/loader.js';
import { registerBuiltinTools } from '../tools/builtin.js';
import { demoInputHandler } from '../runtime/input-handler-demo.js';
import { ToolRegistry } from '../tools/registry.js';
import { PermissionManager } from '../permission/manager.js';
import { SkillLoader } from '../runtime/skill.js';
import { PromptEventEmitter } from '../runtime/events.js';
import { CommandServiceImpl } from '../commands/system.js';
import { DiagnosticsServiceImpl } from '../diagnostics/service.js';
import { CompactionServiceImpl } from '../context/compaction.js';
import { runReplMode } from './repl.js';
import { runRpcMode } from './rpc.js';

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

  // 显式组装子系统（多系统分离：Runtime 不创建任何子系统，全部注入）
  const tools = new ToolRegistry();
  const permission = new PermissionManager();
  const skills = new SkillLoader('skills');
  const events = new PromptEventEmitter();
  const commandSystem = new CommandServiceImpl();
  const diagnosticsService = new DiagnosticsServiceImpl({ events });

  const createRuntime = async (options: CreateRuntimeOptions): Promise<CreateRuntimeResult> => {
    const actualSession = options.session ?? session;
    // 压缩子系统：仅当 session 支持压缩（Jsonl 实现 CompactionStore）时启用
    const compactionStore = actualSession instanceof JsonlSessionStorage ? actualSession : undefined;
    const compaction = new CompactionServiceImpl({ llm, storage: compactionStore, events });

    const runtime = new Runtime({
      mode: Mode.Repl,
      llm,
      session: actualSession,
      tools,
      permission,
      skills,
      events,
      commandSystem,
      diagnosticsService,
      compaction,
      model: modelName,
      provider: checkResult.config?.provider ?? '',
      baseUrl,
    });
    return { runtime };
  };

  const { runtime } = await createRuntime({});

  // 构造后统一注册能力（命令 + 工具 + 输入处理）——时序一致
  await registerBuiltinCommands(runtime);   // 装命令（动态 import 需 await）
  registerBuiltinTools(tools);               // 装工具（直接用本地变量，不绕 runtime.tools）
  runtime.onInput(demoInputHandler);         // 装输入处理器

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

  // 模式分发：RPC（外部程序调用）或 REPL（交互界面）
  if (process.env.TS_AGENT_MODE === 'rpc') {
    await runRpcMode(runtime);
    closeTerminal();
    return;
  }

  await runReplMode(runtime, {
    model: modelName,
    baseUrl,
    sessionMsgs: await runtime.getSessionMsgCount(),
    toolCount: runtime.tools.getLLMTools().length,
    cmdCount: runtime.listCommands().length,
    skillCount: runtime.getSkillLoader().getAll().length,
    diagnostics: checkResult.diagnostics ?? [],
  });
}
