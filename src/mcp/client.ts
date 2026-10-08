/**
 * MCP client —— flint 作为 MCP 客户端调用外部 MCP server 的最小实现。
 * 调用方：src/tools/builtin.ts 的 note_search（首个接入方）
 * 服务于：RAG 侧车经 MCP 协议暴露检索工具——长驻连接代替一把一 spawn，
 *         握手一次、多次调用分摊连接成本；也是 flint 接入其他 MCP server 的样板。
 *
 * 协议：MCP stdio 传输 = newline-delimited JSON-RPC 2.0（与 sidecar/rag/mcp_server.py 成对实现）。
 * 零依赖：只动 node:child_process / node:readline，不引 SDK——保持本体零运行时依赖。
 * 存活策略：进程退出后置空连接，下一次 ensureReady 重新 spawn + 握手（自愈，不需要探活）。
 */
import type { ChildProcess } from 'node:child_process';

/** 单次工具调用的结果（协议层归一化后的形状） */
export interface McpToolResult {
  /** 工具执行是否成功：false = JSON-RPC 错误，或 MCP result.isError=true */
  ok: boolean;
  /** result.content[0].text —— 成功时是工具产出（本项目中为结果 JSON 串），失败时是错误描述 */
  text: string;
}

/** MCP server 的 spawn 参数 */
export interface McpServerSpec {
  /** 可执行文件（本项目中为 sidecar venv 的 python.exe） */
  command: string;
  /** argv 数组，不经 shell 拼接 */
  args: string[];
  /** 子进程工作目录 */
  cwd: string;
  /** 额外环境变量（叠在 process.env 上；本项目传 PYTHONUTF8=1 防 GBK 编码坑） */
  env?: Record<string, string>;
}

/** in-flight 请求表的一行：id → 等待者 + 超时计时器 */
interface PendingRequest {
  resolve: (value: { result?: unknown; error?: { message?: string } }) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private initialized = false;
  private pending = new Map<number, PendingRequest>();
  private stderrTail = '';

  constructor(private readonly spec: McpServerSpec) {}

  /** 连接是否就绪（子进程存活且完成过 initialize 握手） */
  get ready(): boolean {
    return this.child != null && this.child.exitCode == null && this.initialized;
  }

  /** 诊断现场：server 的 stderr 尾部（协议流只走 stdout，stderr 全是日志） */
  get diagnostics(): string {
    return this.stderrTail.trim();
  }

  /**
   * 确保连接就绪：未就绪则 spawn + 挂逐行分发器 + initialize 握手（幂等）。
   * 握手失败按异常抛出——协议异常比干等更值得暴露，由调用方决定是否降级。
   */
  async ensureReady(timeoutMs: number): Promise<void> {
    if (this.ready) return;
    this.kill();
    const { spawn } = await import('node:child_process');
    const { createInterface } = await import('node:readline');
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.spec.env },
    });
    this.child = child;
    this.initialized = false;
    child.stderr?.on('data', (chunk: Buffer) => {
      // 只留尾部做诊断现场，不无限增长
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    child.on('exit', () => {
      const dead = [...this.pending.values()];
      this.pending.clear();
      for (const p of dead) {
        clearTimeout(p.timer);
        // 生命周期事件里不能 reject（调用方没注册 catch 的场合会 unhandled），
        // 统一转 error 形状 resolve，由 request 的调用方分类处理
        p.resolve({ error: { message: 'MCP server 进程退出' } });
      }
      if (this.child === child) this.child = null;
    });

    // 先挂逐行分发器，再握手——顺序反了 initialize 的响应没人认领，必死锁
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => this.dispatch(line));

    const resp = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'flint', version: '1.0.0' },
    }, timeoutMs);
    if (resp.error != null) {
      throw new Error(`MCP initialize 失败: ${resp.error.message ?? '未知错误'}`);
    }
    this.notify('notifications/initialized');
    this.initialized = true;
  }

  /** 调用远端工具；ok=false 时 text 为错误描述（MCP isError 与协议错误两种来源合一） */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpToolResult> {
    const resp = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (resp.error != null) {
      return { ok: false, text: resp.error.message ?? 'MCP 协议错误' };
    }
    const result = resp.result as { content?: { type: string; text: string }[]; isError?: boolean } | undefined;
    const text = result?.content?.find((c) => c.type === 'text')?.text ?? '';
    return { ok: result?.isError !== true, text };
  }

  /** 显式关闭（note_search 长驻复用，一般只在热切换时被间接触发） */
  kill(): void {
    const child = this.child;
    this.child = null;
    this.initialized = false;
    if (child != null && child.exitCode == null) child.kill();
  }

  /** 一行协议消息 → 按 id 配对唤醒等待者；通知与畸形行静默丢弃 */
  private dispatch(line: string): void {
    let msg: { id?: number | null; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（理论上 server 不会发）忽略
    }
    if (msg.id == null) return;
    const p = this.pending.get(msg.id);
    if (p == null) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    // exactOptionalPropertyTypes：error 字段只在真有错误时才上，绝不显式传 undefined
    p.resolve(msg.error != null
      ? { error: msg.error }
      : { result: msg.result });
  }

  /** 发请求 + 按 id 等响应；超时杀连接（迟到的响应会让 id 配对错位，连接不可复用） */
  private request(method: string, params: unknown, timeoutMs: number): Promise<{ result?: unknown; error?: { message?: string } }> {
    if (!this.ready && method !== 'initialize') {
      return Promise.resolve({ error: { message: 'MCP server 未连接' } });
    }
    const id = ++this.nextId;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<{ result?: unknown; error?: { message?: string } }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        resolve({ error: { message: `MCP ${method} 超时（${timeoutMs}ms，连接已重置）` } });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child!.stdin!.write(payload);
    });
  }

  /** 发通知：无 id、不期待响应 */
  private notify(method: string): void {
    if (this.child?.stdin == null) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }
}

/** 进程内共享连接池：key → client，同一 server 全项目只 spawn 一次 */
const shared = new Map<string, McpClient>();

/** 取（或建）共享 MCP 连接。调用方：note_search 等 MCP 接入工具 */
export function sharedMcpClient(key: string, create: () => McpClient): McpClient {
  let c = shared.get(key);
  if (c == null) {
    c = create();
    shared.set(key, c);
  }
  return c;
}
