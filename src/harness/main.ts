/**
 * Agent 启动逻辑。
 * 调用方：harness/index.ts（check 通过后由 Harness.run 调用）
 * 服务于：接收 check 结果 → 注入 Runtime → 按模式进入不同交互方式
 */
import { Runtime } from '../runtime/runtime.js';
import type { RuntimeOptions } from '../types.js';
import { Mode } from '../types.js';
import { closeTerminal, readLine } from '../io/terminal.js';
import type { LLMProvider } from '../llm/types.js';

export async function main(llm: LLMProvider): Promise<void> {
  const options: RuntimeOptions = { mode: Mode.Repl, llm };
  const runtime = new Runtime(options);

  process.on('SIGINT', () => { closeTerminal(); runtime.stop().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { closeTerminal(); runtime.stop().then(() => process.exit(0)); });

  switch (options.mode) {
    case Mode.Repl:
      await runReplMode(runtime);
      break;
    case Mode.Rpc:
      await runRpcMode(runtime);
      break;
  }

  closeTerminal();
  process.exit(0);
}

/* ── 通用：读取用户输入，跳过空行，检测退出 ── */

/** 返回用户输入文本，返回 null 表示用户请求退出（/exit） */
async function getUserInput(): Promise<string | null> {
  const input = await readLine('> ');
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (trimmed === '/exit') return null;
  return trimmed;
}

/* ── REPL 模式：持有 while(true)，循环读 → 调 → 印 ── */

async function runReplMode(runtime: Runtime): Promise<void> {
  console.log('REPL mode — type /exit to quit');
  while (true) {
    const input = await getUserInput();
    if (input === null) break;
    if (!input) continue;

    const reply = await runtime.prompt(input);
    console.log(`🤖 ${reply}`);
  }
}

/* ── RPC 模式：事件驱动，无循环 ── */

async function runRpcMode(runtime: Runtime): Promise<void> {
  // TODO: stdin JSON-RPC 监听 → runtime.prompt() → stdout 回复
  void runtime;
  await new Promise(() => {});
}
