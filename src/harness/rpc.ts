/**
 * RPC 模式 —— JSON-RPC 2.0 over stdin/stdout。
 * 调用方：main.ts（检测到 Rpc 模式时进入 runRpcMode）
 * 服务于：让外部程序（编辑器插件/脚本/任意语言）通过标准输入输出调用 Agent，
 *         复用 Runtime 的公开方法（prompt/listCommands/getDiagnostics 等）
 *
 * 协议：
 *   - 每行一个 JSON 请求（\n 分帧），外部发 {jsonrpc,id,method,params}
 *   - 每行一个 JSON 响应（成功 {jsonrpc,id,result} / 错误 {jsonrpc,id,error}）
 *   - 流式：chat 期间另推 session/update 通知（JSON-RPC notification，**无 id**），
 *     形状对齐 ACP（Agent Client Protocol），见 rpc-events.ts
 *
 * stdout 纯净（本模式的生命线）：
 *   协议靠"一行一个 JSON"分帧，混进任何非 JSON 行，对端 JSON.parse 就抛异常、整条流废掉。
 *   所以本文件是**唯一**允许写 stdout 的地方；rpc 路径（harness/ runtime/ loop/ context/）
 *   禁用 console.log —— 调试请走 console.error（stderr）或 FLINT_DEBUG_* 写文件。
 *   这条规矩由 scripts/verify-rpc-stream.ts 的源码扫描断言机器守护，不靠人记。
 */
import type { Runtime } from '../runtime/runtime.js';
import type { RuntimeEvent } from '../runtime/events.js';
import { RpcEventMapper, toNotification } from './rpc-events.js';
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
  /** 自定义（服务端错误保留区间 -32000~-32099）：已有 chat 在跑 */
  CHAT_BUSY: -32000,
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

/** chat 期间与外界的三个交互点（由 runRpcMode 提供，本函数不碰 stdout） */
interface ChatSink {
  /** 抢占 chat；false = 已有 chat 在跑（本版不支持并发） */
  beginChat(): boolean;
  endChat(): void;
  /** 收到一个内核事件（负责映射 + 串行写出） */
  emit(event: RuntimeEvent): void;
  /** 会话切换后更新 sessionId */
  setSessionName(name: string): void;
}

/** 分发请求到 Runtime 方法处理器 */
async function handleRequest(
  runtime: Runtime,
  req: JsonRpcRequest,
  sink: ChatSink,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const params = req.params ?? {};
  switch (req.method) {
    case 'chat': {
      const message = params.message as string | undefined;
      if (typeof message !== 'string') {
        return { error: { code: ERR.INVALID_PARAMS, message: "params.message 必须是字符串" } };
      }
      // 并发会让通知无法归属（notification 没有 id 可配对），本版直接拒绝
      if (!sink.beginChat()) {
        return { error: { code: ERR.CHAT_BUSY, message: '已有 chat 在进行中，本版不支持并发' } };
      }
      try {
        // 订阅只活在这一轮 chat 内：finally 必退订，杜绝跨请求串台
        const off = runtime.subscribe((event) => sink.emit(event));
        try {
          const reply = await runtime.prompt(message);
          return { result: reply };
        } finally {
          off();
        }
      } finally {
        sink.endChat();
      }
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
      if (ok) sink.setSessionName(name);
      return { result: ok };
    }
    case 'create_session': {
      const name = params.name as string | undefined;
      const fileName = await runtime.createSession(name);
      sink.setSessionName(fileName);
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

  const mapper = new RpcEventMapper();
  let sessionId = 'sess_default';
  let chatBusy = false;

  /**
   * 串行写 stdout。
   * process.stdout.write 是异步的：高速推送时不排队就可能乱序，
   * 而"顺序"正是流式的全部意义（先到的片必须先到）。通知与响应共用一条队列，
   * 于是"最终响应"必定排在这一轮的所有通知之后。
   */
  let writeQueue: Promise<void> = Promise.resolve();
  const writeLine = (obj: unknown): void => {
    const line = JSON.stringify(obj) + '\n';
    writeQueue = writeQueue.then(
      () =>
        new Promise<void>((resolve) => {
          process.stdout.write(line, () => resolve());
        }),
    );
  };

  const sink: ChatSink = {
    beginChat: () => {
      if (chatBusy) return false;
      chatBusy = true;
      return true;
    },
    endChat: () => {
      chatBusy = false;
    },
    emit: (event) => {
      const update = mapper.update(event);
      if (update) writeLine(toNotification(sessionId, update));
    },
    setSessionName: (name) => {
      sessionId = `sess_${name}`;
    },
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const { request, error } = parseRequest(trimmed);
    if (error) {
      writeLine(error);
      return;
    }
    if (!request) return;

    // 处理请求（异步），完成后写响应
    void handleRequest(runtime, request, sink)
      .then(({ result, error: rpcError }) => {
        // JSON-RPC 通知（无 id）不返回响应
        if (request.id === undefined) return;
        const resp: JsonRpcResponse = rpcError
          ? { jsonrpc: '2.0', id: request.id, error: rpcError }
          : { jsonrpc: '2.0', id: request.id, result };
        writeLine(resp);
      })
      .catch((err) => {
        if (request.id === undefined) return;
        const resp: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: ERR.INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) },
        };
        writeLine(resp);
      });
  });

  // 等待 stdin 关闭（外部程序结束）后退出
  await new Promise<void>((resolve) => {
    rl.on('close', () => resolve());
  });
}
