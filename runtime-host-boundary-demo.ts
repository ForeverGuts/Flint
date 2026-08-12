/**
 * 边界抽象演示：RuntimeHost —— 三宿主复用同一份 ClineCore
 *
 * 代码结构（从上到下 = 依赖方向）：
 *   接口(边界) → 三种实现(适配传输) → ClineCore(只认接口) → 工厂 → 演示
 *
 * 运行：npx tsx runtime-host-boundary-demo.ts
 */

// ============================================================
// 1. 边界本身：RuntimeHost 接口（契约）
//    ClineCore 只认识它，不关心背后是进程内 / daemon / 远程
// ============================================================

/** 启动会话的输入 */
interface StartSessionInput {
  /** 会话初始提示词 */
  prompt: string;
}

/** 启动会话的结果 */
interface StartSessionResult {
  /** 新会话的唯一 ID */
  sessionId: string;
}

/** 一次对话回合的输入 */
interface RunTurnInput {
  /** 目标会话 ID */
  sessionId: string;
  /** 用户本轮文本 */
  text: string;
}

/** 回合输出 */
interface AgentResult {
  /** 助手回复文本 */
  text: string;
  /** 是否已结束 */
  done: boolean;
}

/**
 * core 对外唯一的执行边界 —— 所有宿主实现同一份契约。
 * 被 ClineCore 调用，服务于"同一种核心逻辑跑三种部署形态"。
 */
interface RuntimeHost {
  /** 启动一个新会话 */
  startSession(input: StartSessionInput): Promise<StartSessionResult>;
  /** 执行一轮对话 */
  runTurn(input: RunTurnInput): Promise<AgentResult | undefined>;
  /** 停止并清理一个会话 */
  stopSession(sessionId: string): Promise<void>;
}

// ============================================================
// 2. 实现一：进程内执行（传输层 = 无，直接兑现契约）
// ============================================================

/** 本地宿主：在同一个进程直接执行 Agent 循环，无任何传输开销 */
class LocalRuntimeHost implements RuntimeHost {
  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    console.log(`  [local]  会话已创建，初始提示: "${input.prompt}"`);
    return { sessionId: crypto.randomUUID() };
  }

  async runTurn(input: RunTurnInput): Promise<AgentResult> {
    // 真实场景这里直接调用 Agent 循环；此处简化为回显
    return { text: `[local]  处理「${input.text}」→ 结果 A`, done: true };
  }

  async stopSession(sessionId: string): Promise<void> {
    console.log(`  [local]  会话 ${sessionId} 已清理`);
  }
}

// ============================================================
// 3. 实现二/三：Hub daemon 与远程端点（传输层 = JSON-RPC / HTTP）
//    契约没变，变的是"方法调用怎么传过去"
// ============================================================

/** 模拟一次进程间/网络调用：参数序列化 → 远端执行 → 回包 */
async function fakeTransport(mode: string, method: string, params: unknown): Promise<AgentResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      // 真实场景：JSON-RPC 是写 stdout 读 stdin；远程是发 HTTP 请求
      resolve({ text: `[${mode}] 通过 ${method} 在远端执行 ${JSON.stringify(params)}`, done: true });
    }, 10);
  });
}

/** Hub 宿主：连接本地 Hub daemon，方法调用变成进程间 JSON-RPC 消息 */
class HubRuntimeHost implements RuntimeHost {
  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    // 发起 startSession 的 RPC，再自己补一个 sessionId 字段
    await fakeTransport('hub', 'startSession', input);
    return { sessionId: crypto.randomUUID() };
  }

  async runTurn(input: RunTurnInput): Promise<AgentResult> {
    return fakeTransport('hub', 'runTurn', input);
  }

  async stopSession(sessionId: string): Promise<void> {
    await fakeTransport('hub', 'stopSession', { sessionId });
  }
}

/** 远程宿主：连接远程 Hub 端点，方法调用变成 HTTP 请求 */
class RemoteRuntimeHost implements RuntimeHost {
  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    await fakeTransport('remote', 'startSession', input);
    return { sessionId: crypto.randomUUID() };
  }

  async runTurn(input: RunTurnInput): Promise<AgentResult> {
    return fakeTransport('remote', 'runTurn', input);
  }

  async stopSession(sessionId: string): Promise<void> {
    await fakeTransport('remote', 'stopSession', { sessionId });
  }
}

// ============================================================
// 4. 调用方：ClineCore —— 业务逻辑只依赖接口，零 if/else 分支
// ============================================================

/**
 * 核心引擎：通过构造函数注入边界（RuntimeHost），
 * 自身不写任何 "if (mode === ...)" —— 传输差异在 core 之外。
 */
class ClineCore {
  constructor(private readonly host: RuntimeHost) {}

  /** 一轮对话：core 只管编排，具体执行交给注入的宿主 */
  async chat(sessionId: string, text: string): Promise<string> {
    const result = await this.host.runTurn({ sessionId, text });
    return result?.text ?? '(无输出)';
  }
}

// ============================================================
// 5. 工厂：传输差异集中在"创建时刻"，之后 core 零感知
// ============================================================

/** 宿主运行模式 */
type HostMode = 'local' | 'hub' | 'remote' | 'auto';

/** 创建宿主：switch 只出现这一次，不在 core 里 */
function createRuntimeHost(mode: HostMode): RuntimeHost {
  switch (mode) {
    case 'local':  return new LocalRuntimeHost();
    case 'hub':    return new HubRuntimeHost();
    case 'remote': return new RemoteRuntimeHost();
    case 'auto':
      // 优先连本地 daemon，连不上就回退进程内 —— 调用方甚至不需要知道自己用哪个
      try {
        return new HubRuntimeHost();
      } catch {
        return new LocalRuntimeHost();
      }
  }
}

// ============================================================
// 6. 演示：同一份 ClineCore，三种形态随便换，一行不改
// ============================================================

async function demo(): Promise<void> {
  const modes: HostMode[] = ['local', 'hub', 'remote'];

  for (const mode of modes) {
    // 切换部署形态 = 换工厂参数，ClineCore 完全无感知
    const host = createRuntimeHost(mode);
    const core = new ClineCore(host);
    const { sessionId } = await host.startSession({ prompt: '你好' });

    console.log(`\n[模式=${mode}] 同一份 ClineCore 运行：`);
    const answer = await core.chat(sessionId, '帮我写个 Hello World');
    console.log(`  ${answer}`);
  }

  console.log(`\n[模式=auto] 调用方不需要知道用哪个实现`);
  const autoCore = new ClineCore(createRuntimeHost('auto'));
  console.log(`  ${await autoCore.chat('sid-auto', '你是谁？')}`);
}

demo();
