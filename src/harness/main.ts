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
import { JsonlSessionRepo } from '../session/jsonl-repo.js';
import { registerBuiltinCommands } from '../commands/loader.js';
import { registerBuiltinTools } from '../tools/builtin.js';
import { ToolRegistry } from '../tools/registry.js';
import { PermissionManager } from '../permission/manager.js';
import { SkillLoader } from '../runtime/skill.js';
import { PromptEventEmitter } from '../runtime/events.js';
import { CommandServiceImpl } from '../commands/system.js';
import { DiagnosticsServiceImpl } from '../diagnostics/service.js';
import { CompactionServiceImpl } from '../context/compaction.js';
import { SystemPromptServiceImpl } from '../context/system-prompt.js';
import { coreSection } from '../context/sections/core-section.js';
import { toolsSection } from '../context/sections/tools-section.js';
import { skillsSection } from '../context/sections/skills-section.js';
import { loadExtensions } from '../context/extension-loader.js';
import { taskStore } from '../todo/store.js';
import { MEMORY_FILE, memoryStore } from '../memory/store.js';
import { CALLS_FILE, EVENTS_FILE, eventStore } from '../eventlog/store.js';
import { projectRegistry } from '../eventlog/registry.js';
import { charterLock, guardContractWrite } from '../project/charter.js';
import { createForkAsker } from '../io/ui/fork-prompt.js';
import type { CollectedSpan } from '../core/events.js';
import { SpanCollectorImpl } from '../runtime/span-collector.js';
import { runReplMode } from './repl.js';
import { runRpcMode } from './rpc.js';
import { probeStartup } from './check.js';
import { getConfigManager } from '../config/manager.js';
import type { Diagnostic } from '../types.js';

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

  // 工作记忆种子：把 TASK.md（上一进程留下的投影）吸收进内存真相源，**只此一次**。
  // 之后运行期一律以 taskStore 为准、不再回读文件 —— 否则就出现"两处判定"（store 与文件），
  // 迟早漂移。清单若无未完成项（空文件 / 全勾选），loadFromFile 会删掉文件并保持空清单。
  taskStore.loadFromFile('TASK.md');

  // 项目记忆 / 历史事件库种子：同 TASK.md 的"只此一次"——启动吸收，运行期以内存为准不回读。
  // events.jsonl 只存叙事+system；tool_call 流水在 tool-calls.jsonl（2026-09-13 拆分）。
  // 旧 events.jsonl 里残留的 tool_call 行由 loadFromFile 按 kind 路由进流水索引，不回写。
  memoryStore.loadFromFile(MEMORY_FILE);
  eventStore.loadFromFile(EVENTS_FILE);
  eventStore.loadCallsFile(CALLS_FILE);

  // 项目登记（跨项目检索的电话簿）：用过 flint 的项目自动进 ~/.flint/projects.jsonl。
  // 登记失败静默——它是旁路便利，不该挡住启动。
  projectRegistry.ensure(process.cwd());

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
  // 会话仓库层：目录级管理（列表/打开/新建/删除），与单会话存储分家（P6）
  const sessionRepo = new JsonlSessionRepo(sessionDir);
  const permission = new PermissionManager();
  // ⚠ 传 '.'：Loader 内部再拼一级 'skills'（此前传 'skills' 拼成 skills/skills，
  //   运行期技能数恒为 0——review.md 从未进过 LLM 视野，2026-09-12 探针实锤后修复）
  const skills = new SkillLoader('.');
  // 技能热重载：文件变更 → 重新 load 内存清单；提示词层每轮 build 现取 getAll() 自动生效，
  // 无需任何"通知 runtime"的线；观察者只服务 UI 提示（TreeUI 订阅）
  skills.startWatch();
  const events = new PromptEventEmitter();
  const commandSystem = new CommandServiceImpl();
  const diagnosticsService = new DiagnosticsServiceImpl({ events });
  // 段收集器：订阅同一条总线，把成对的 span 事件合成"一段完整行为"，供 /traces 只读展示。
  // 建在 createRuntime 闭包外——热切换重建 Runtime 时，已收的历史不会跟着丢。
  // 与 trace-log watcher 各持独立实例：共用的是 SpanCollector 这份配对代码，不是实例
  // （总线的意义就是消费者互不知情，核心命令也不该反过来依赖一个可选扩展）。
  const spanCollector = new SpanCollectorImpl();
  spanCollector.attach(events);
  // 事件库自动捕获：复用同一份 span-collector 配对代码（capacity 0 落盘型用法，与 trace-log
  // watcher 相同——只吃 feed 返回值、不在内存留历史），把每次工具调用沉淀成 kind=tool_call 的事件。
  // 打卡机记"过程"（trace.jsonl 全量流水），事件库记"结论与来龙去脉"；turnId 把两者关联起来。
  // 只订阅不改流程：与 trace-log 同为旁观者，落盘失败也不反噬主流程（store 内部吞掉）。
  const eventCollector = new SpanCollectorImpl({ capacity: 0 });
  events.subscribe((raw) => {
    const span: CollectedSpan | null = eventCollector.feed(raw);
    if (span && span.name === 'tool_call') eventStore.recordToolCall(span, CALLS_FILE);
  });
  // 项目契约闸（ROADMAP P10.12）：目标文档 .flint/CHARTER.md 立项后冻结，改它必须用户显式解锁。
  // 刻意**不**接权限子系统（决策 C11）：权限的语义是"弹窗放行 + 进 allowlist"，契约要的是
  // "默认拒写"——若塞进同一个授权键空间，用户对 write 点一次"本次全部允许"就把锁静默打开了。
  // 故本闸只认 charterLock 自己的状态位（唯一开门动作是 /charter unlock）。
  // 覆盖三层调用：write/edit 按**目标路径**精确比对；bash 按**命令串里的字面文件名**拦
  // （2026-09-14 补，ROADMAP 10.9.2 第一步）——bash 的**效果侧**兜底在 bash 工具自己身上，
  // 因为钩子的 after_tool_call 是只读观察、改不了工具结果（见 charter.ts 的「第二处入口」）。
  // 注册时机在装载扩展**之前**：emitHook 取"最后一个非 undefined"结果，核心钩子先入列，
  // 扩展返回 undefined 时不会覆盖它的 deny。
  events.on('before_tool_call', (event) => {
    const e = event as { name?: unknown; args?: unknown };
    return guardContractWrite(
      typeof e.name === 'string' ? e.name : '',
      e.args,
      charterLock.isUnlocked(),
    );
  });

  // 装载用户扩展（段落 + hook + watcher）—— 自动扫描 src/extensions/ 下三类目录
  const ext = await loadExtensions(events);
  // 系统提示词子系统（配置驱动 + 分层缓存友好：核心稳定层在前，工具/技能层独立）
  // 用户扩展段落并入 core 稳定层（人设/规则补充，属稳定前缀）
  const systemPromptService = new SystemPromptServiceImpl({
    core: [coreSection, ...ext.sections],
    tools: [toolsSection],
    skills: [skillsSection],
    fallback: 'You are a helpful assistant.',
  }, events);

  const createRuntime = async (options: CreateRuntimeOptions): Promise<CreateRuntimeResult> => {
    const actualSession = options.session ?? session;
    // 压缩子系统（无状态）：storage 由 Runtime 在每次调用时传当前会话——
    // 此前绑死启动时的 session，切会话/fork 后摘要会写进旧文件（2026-09-12 修复）
    const compaction = new CompactionServiceImpl({ llm, events });

    const runtime = new Runtime({
      mode: Mode.Repl,
      llm,
      session: actualSession,
      sessionRepo,
      tools,
      permission,
      skills,
      events,
      spanCollector,
      commandSystem,
      diagnosticsService,
      compaction,
      systemPromptService,
      model: modelName,
      provider: checkResult.config?.provider ?? '',
      baseUrl,
      // exactOptionalPropertyTypes 严格模式：无配置时不传该键（而非传 undefined）
      ...(checkResult.config?.thinking ? { thinking: checkResult.config.thinking } : {}),
    });
    return { runtime };
  };

  const { runtime } = await createRuntime({});

  // 构造后统一注册能力（命令 + 工具）——时序一致
  await registerBuiltinCommands(runtime);   // 装命令（动态 import 需 await）
  // 装工具（直接用本地变量，不绕 runtime.tools）。第 5 个参数是**分叉点提问**的实现：
  // 工具层刻意不 import io 模块（会把 UI 层拖进 RPC 启动路径），故由这里注入。
  // 传 runtime.select 而不是裸 selectFromList：TTY 下它走 TreeUI 的组件树，与 spinner /
  // 任务面板同一套布局，不会被面板刷新盖掉（同 2026-09-13 权限弹窗那次修复的判据）。
  // 非 TTY 时 createForkAsker 自己会先拦下（fail-closed），不会落到 selectFromList 的
  // "返回第一项"上——那等于替用户选了技术方案。
  registerBuiltinTools(tools, taskStore, memoryStore, eventStore,
    createForkAsker((items, title) => runtime.select(items, title)));
  // 输入预处理器（runtime.onInput）当前不挂任何实现：原先挂的 demoInputHandler 会静默
  // 吞掉 "@@" 开头的输入，属未文档化的演示行为；能力保留给 Hook 系统

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
  if (process.env.FLINT_MODE === 'rpc') {
    await runRpcMode(runtime);
    closeTerminal();
    return;
  }

  // ── 两档后台网络：都不挡界面渲染，区别只在"结果要不要回填" ──
  // 第一档 · 网络探测（probeStartup）：结果要回填 banner，所以把 promise 交给 repl，
  //   由它在 UI 订阅完成后 await 完再发 check_done（时序上杜绝"结果早于订阅"的竞态）。
  const probePromise: Promise<Diagnostic[]> = checkResult.config
    ? probeStartup(checkResult.config, checkResult.providerName)
    : Promise.resolve([]);

  // 第二档 · 模型列表预热（warmModels）：结果只写内存里的 Provider，没有任何要回填的界面，
  //   因此连 promise 都不必交出去 —— 用户开 /model 时若还没拉完，那边 await 的是同一个在飞
  //   promise（inflight 去重），不会重发请求。
  //   两个前置条件让它只在 TTY 下发起：① 非 TTY 时选择器直接返回第一项，模型列表根本不会
  //   被展示，拉了也白拉；② 非 TTY 的管道模式跑完就退，在飞的 fetch 反而会把进程拖到超时才结束。
  if (process.stdin.isTTY) {
    getConfigManager()
      .then((mgr) => mgr.warmModels())
      .catch(() => { /* 预热失败即静态兜底（warmModels 内部已吞异常），不打扰界面 */ });
  }

  await runReplMode(runtime, checkResult.diagnostics ?? [], probePromise);
}
