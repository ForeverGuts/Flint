/**
 * RPC 模式 —— JSON-RPC 2.0 over stdin/stdout。
 * 调用方：main.ts（检测到 Rpc 模式时进入 runRpcMode）
 * 服务于：让外部程序（编辑器插件/脚本/任意语言）通过标准输入输出调用 Agent，
 *         复用 Runtime 的公开方法（prompt/listCommands/getDiagnostics 等）
 *
 * 协议：
 *   - 每行一个 JSON 请求（\n 分帧），外部发 {jsonrpc,id,method,params}
 *   - 每行一个 JSON 响应（成功 {jsonrpc,id,result} / 错误 {jsonrpc,id,error}）
 *   - 非流式：chat 一次性返回完整文本
 *
 * TODO（Pi 式流式）：chat 请求期间推送 text_delta 通知（JSON-RPC notification，无 id），
 *   结束时返回 result —— 类似 Pi 的 subscribe 事件流。
 */
import type { Runtime } from '../runtime/runtime.js';
import * as readline from 'node:readline';

/** JSON-RPC 请求 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 响应（成功或错误） */
type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: number | string | null; result: unknown }
  | { jsonrpc: '2.0'; id: number | string | null; error: { code: number; message: string } };

/** JSON-RPC 错误码 */
const ERR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

/** 解析请求：返回请求对象或错误响应（解析失败时） */
function parseRequest(line: string): { request?: JsonRpcRequest; error?: JsonRpcResponse } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { error: { jsonrpc: '2.0', id: null, error: { code: ERR.PARSE_ERROR, message: 'Parse error' } } };
  }
  const req = raw as JsonRpcRequest;
  if (req?.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return { error: { jsonrpc: '2.0', id: (req as JsonRpcRequest)?.id ?? null, error: { code: ERR.INVALID_REQUEST, message: 'Invalid Request' } } };
  }
  return { request: req };
}

/** 分发请求到 Runtime 方法处理器 */
async function handleRequest(
  runtime: Runtime,
  req: JsonRpcRequest,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const params = req.params ?? {};
  switch (req.method) {
    case 'chat': {
      const message = params.message as string | undefined;
      if (typeof message !== 'string') {
        return { error: { code: ERR.INVALID_PARAMS, message: "params.message 必须是字符串" } };
      }
      const reply = await runtime.prompt(message);
      return { result: reply };
    }
    case 'ping':
      return { result: 'pong' };
    case 'list_commands':
      return { result: runtime.listCommands() };
    case 'get_diagnostics':
      return { result: runtime.getDiagnostics() };
    case 'list_sessions':
      return { result: await runtime.listSessions() };
    case 'switch_session': {
      const name = params.name as string | undefined;
      if (typeof name !== 'string') {
        return { error: { code: ERR.INVALID_PARAMS, message: "params.name 必须是字符串" } };
      }
      const ok = await runtime.switchSession(name);
      return { result: ok };
    }
    case 'create_session': {
      const name = params.name as string | undefined;
      const fileName = await runtime.createSession(name);
      return { result: fileName };
    }
    case 'clear':
      await runtime.clearSession();
      return { result: 'ok' };
    case 'get_session_info':
      return {
        result: {
          model: runtime.currentModel,
          provider: runtime.currentProvider,
          baseUrl: runtime.currentBaseUrl,
          msgCount: await runtime.getSessionMsgCount(),
        },
      };
    default:
      return { error: { code: ERR.METHOD_NOT_FOUND, message: `未知方法: ${req.method}` } };
  }
}

/**
 * RPC 主循环 —— 逐行读 stdin，处理请求，写 stdout。
 * 调用方：main.ts（Rpc 模式）
 */
export async function runRpcMode(runtime: Runtime): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const { request, error } = parseRequest(trimmed);
    if (error) {
      process.stdout.write(JSON.stringify(error) + '\n');
      return;
    }
    if (!request) return;

    // 处理请求（异步），完成后写响应
    void handleRequest(runtime, request)
      .then(({ result, error: rpcError }) => {
        // JSON-RPC 通知（无 id）不返回响应
        if (request.id === undefined) return;
        const resp: JsonRpcResponse = rpcError
          ? { jsonrpc: '2.0', id: request.id, error: rpcError }
          : { jsonrpc: '2.0', id: request.id, result };
        process.stdout.write(JSON.stringify(resp) + '\n');
      })
      .catch((err) => {
        if (request.id === undefined) return;
        const resp: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: ERR.INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) },
        };
        process.stdout.write(JSON.stringify(resp) + '\n');
      });
  });

  // 等待 stdin 关闭（外部程序结束）后退出
  await new Promise<void>((resolve) => {
    rl.on('close', () => resolve());
  });
}
