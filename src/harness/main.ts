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
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { closeTerminal } from '../io/terminal.js';
import { JsonlSessionStorage } from '../session/jsonl-storage.js';
import { JsonlSessionRepo } from '../session/jsonl-repo.js';
import { registerBuiltinCommands } from '../commands/loader.js';
import { registerBuiltinTools, seedPostcheckBaseline } from '../tools/builtin.js';
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
import { memoryStore } from '../memory/store.js';
import { CALLS_FILE, eventStore } from '../eventlog/store.js';
import { seedProjectContext } from './project-context.js';
import { atFileInputHandler } from '../input/probe.js';import { renderRegistrationNote } from '../project/projects.js';
import { charterLock, guardContractWrite } from '../project/charter.js';
import { guardDangerousCommand } from '../permission/danger.js';
import { guardDeleteRedirect } from '../permission/trash.js';
import { guardWorkspaceWrite, workspaceGrants } from '../permission/workspace.js';
import { guardBashWrite } from '../permission/bash-write.js';
import { realPathOf } from '../tools/paths.js';
import { recordGateDeny } from '../permission/audit.js';
import { routeBashGitRead } from '../git/route.js';
import { guardPlanMode, planMode } from '../loop/plan-mode.js';
import type { HookDeny } from '../loop/tool-hooks.js';
import {
  POSTCHECK_FILE,
  parsePostcheckConfig,
  postcheckBaseline,
  postcheckRegistry,
} from '../project/postcheck.js';
import {
  DEFAULT_MANAGER,
  PACKAGE_JSON_FILE,
  commandRegistry,
  parsePackageScripts,
} from '../project/commands.js';
import { stackRegistry } from '../project/stack.js';
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

/**
 * 核心钩子链（`before_tool_call`）的**唯一实现**。
 *
 * 为什么抽成独立函数：它此前只活在 `main()` 的闭包里，于是"七道闸的实际次序""是谁拒的"
 * "审计记了什么"这三件事**只能靠读 main.ts 的源码文本**来钉（文本断言既不懂语义、又容易
 * 被重排骗过）。抽出来之后套件能拿真事件喂它、逐条打靶，而**行为一字未变**：判据全是纯函数，
 * `charterUnlocked` 由参数注入（原来读 `charterLock` 单例），这里没有进程级状态，可以反复调用。
 *
 * ⚠ 七道闸的**书写顺序 = 执行顺序**（命中即返回），这个顺序本身就是设计 ——
 *   但**两条排序理由不同，别用一条去推另一条**：
 *     · 模式闸（计划模式）排最前，理由不是"判据更窄"（它的判据其实**最宽**：按工具名一票拦），
 *       而是**其余各闸的出路在计划模式下都不成立** —— 模型若拿到"请让用户 /charter unlock"
 *       或"请让用户 /workspace allow"，用户照做之后它**照样被计划模式拦着**，那就是把模型
 *       与用户一起引向一条走不通的路（"方向给错比不给更坏"，同 10.9.5 的拒因分工）。
 *     · 其余六道照旧按"判据更窄更确定的排前面"，先让它们给出更具体的理由。
 *   既有套件（verify-danger G3）钉着契约 → 危险 → 路由三者的相对次序 ——
 *   重排之前先想清楚为什么这么排。
 *
 * 审计落点就在这里（ROADMAP 10.9.4）：**命中即记一条再原样返回**。落点选在链上而不是
 * `agent-loop`，是因为只有这里知道"是哪一道闸拒的"（loop 那边只拿到一句 reason 文本）。
 */
export function coreBeforeToolCall(
  event: unknown,
  charterUnlocked: boolean,
  /**
   * 计划模式是否开启（ROADMAP 10.4.1）。
   *
   * **缺省 `false`** —— 与 10.9.5 的 `ctx.realpath` 同一个手法："加一步"而不"换判据"，
   * 既有调用点（含各套件里按老签名调的两参版本）因此**零扰动**，行为逐字退回改动前。
   * 真实取值由装配处传 `planMode.isOn()`，本函数**不直读单例** —— 理由同 `charterUnlocked`：
   * 状态是参数，这个函数才没有进程级状态、能反复喂假值打靶。
   */
  planEnabled: boolean = false,
): HookDeny | undefined {
  const e = event as { name?: unknown; args?: unknown };
  // 空串直接传给闸（fail-open 口径各自负责）；"显示成 (未知工具)" 是审计侧的事，
  // 不许反过来改判据看到的值 —— 两件事各归各。
  const toolName = typeof e.name === 'string' ? e.name : '';

  /** 命中即记审计、再原样返回拒绝结果（记什么 / 为什么这么记，见 permission/audit.ts 头注） */
  const deny = (source: string, tag: string, d: HookDeny): HookDeny => {
    recordGateDeny({ source, tag, toolName, args: e.args, reason: d.reason });
    return d;
  };

  // ⓪ 模式闸：计划模式（ROADMAP 10.4.1）。判据只有两问 —— 模式开着吗、工具名在名单里吗 ——
  //    **刻意不看参数**（"能不能改用户文件"由工具身份决定，不由这次的参数决定），
  //    所以它没有其余各闸那些"形状判不出来"的余地，也不存在 fail-open 分支。
  //    排最前：见上方头注 —— 其余闸的出路在计划模式下**都不成立**，先说话的那个必须能给出
  //    真正走得通的出路。C8 担忧的"RPC 下形同虚设"在这里不成立：本闸**没有人工确认环节**，
  //    非 TTY 下没有任何东西可被自动放行（完整论证见 loop/plan-mode.ts 文件头）。
  const plan = guardPlanMode(toolName, planEnabled);
  if (plan) return deny('计划模式', 'plan', plan);

  // ① 安全闸：契约锁。完备性要求高（漏一次 = 目标被偷改），故排在前面、命中即返回。
  const contract = guardContractWrite(toolName, e.args, charterUnlocked);
  if (contract) return deny('契约锁', 'charter', contract);
  // ② 安全闸：危险命令（ROADMAP 10.9.2）。**只有 L1、没有 L2** ——
  //    删除不可逆，事后没有东西可以比对、可以回滚（对照①有两层）。判据窄、边界写在 danger.ts 头注。
  //    排在①之后：契约闸的判据更窄更确定（字面文件名），先让它给出更具体的解锁指引。
  const danger = guardDangerousCommand(toolName, e.args);
  if (danger) return deny('危险命令', 'danger', danger);
  // ②b 改道闸：删除回收站化（ROADMAP 10.9.6）。bash / spawn 里的**删除类命令**一律拒，
  //    出路是 `trash` 工具 —— 它同样让目标离开原处，但落进 `.flint/trash/` 且记一笔，
  //    于是删除从"不可逆"变成"可撤销"（危险闸当年那句"删除没有 L2"的缺口由它补上）。
  //    排在②之后：危险闸的判据**更窄**（只认"一棵树的根"这种灾难形态），先让它给出更
  //    具体的理由；本闸判据更宽（只认段首命令词、不看目标），理由也更泛。
  //    管的是 bash / spawn，与③的 write / edit 工具集不重叠，两者谁先谁后不影响结论。
  const del = guardDeleteRedirect(toolName, e.args);
  if (del) return deny('删除改道回收站', 'trash', del);
  // ③ 边界闸：工作区外写保护（ROADMAP 10.9.3）。write / edit 的**目标路径**落在 cwd
  //    之外 → 拒。只有 L1（外写是效果、事后没有基线可比对，同②）。放行只能由用户敲
  //    `/workspace allow <目录>`——刻意不接权限子系统：非 TTY 下弹窗自动放行会让边界静默失效。
  //    排在②之后：前两道判据更窄更确定（字面文件名 / 灾难形态），先让它们给出更具体的理由。
  //    只认 write/edit：bash 的目标路径与读写语义判不出来，刻意不进（边界写在 workspace.ts 头注）。
  //    **两步判**（第二步 = ROADMAP 10.9.5 路径穿越）：① 声明的路径在外 → 拒；② 声明在内、
  //    但追出来的**真落点**在外（符号链接 / junction）→ 拒。解析器在**这里**注入 ——
  //    判据本身不碰 fs（所以能喂假目录打靶），碰 fs 的那一半在 tools/paths.ts。
  //    cwd 与放行表**每次调用现取**：`/projects --switch` 改了 cwd、`/workspace allow` 改了
  //    放行表之后，下一次工具调用立刻按新边界判，不需要重装钩子。
  const workspace = guardWorkspaceWrite(toolName, e.args, {
    cwd: process.cwd(),
    grants: workspaceGrants.list(),
    realpath: realPathOf,
  });
  if (workspace) return deny('工作区外写', 'workspace', workspace);
  // ③b 边界闸：bash 写纳管（ROADMAP 10.9.8）。③ 只认 write / edit 的 path 参数，而 bash /
  //    spawn 的重定向目标藏在**命令串**里 —— 本闸在这里做小翻译：认出 `>` `>>` `2>` 与
  //    `tee` / `cp` / `mv` 的目标，展开成绝对路径（~ / $HOME，含 Windows —— cmd 里 `> ~/x`
  //    本来就会失败，意图却毫无歧义；MSYS `/c/...` **刻意不映射**，理由写在 bash-write.ts
  //    文件头），然后喂给 **③ 同一个判定函数** `isOutsideWorkspace` —— 两扇门一个规矩，
  //    改一处两边生效。判不出的形态（变量 / 命令替换 / 换语言）一律放行 —— 护栏不是沙箱，
  //    拒因里对模型明说。cwd / 放行表 / 家目录**每次调用现取**，与③同一条纪律。
  const bashWrite = guardBashWrite(toolName, e.args, {
    cwd: process.cwd(),
    home: homedir(),
    grants: workspaceGrants.list(),
  });
  if (bashWrite) return deny('bash 写出工作区', 'bash-write', bashWrite);
  // ④ 引导闸（**路由器**，不是闸）：bash 里的裸 git 只读命令 → 零弹窗的结构化 git 工具。
  //    判据刻意窄（只认裸形式），漏掉只是"照旧走 bash"，因此没有完备性负担，可与①②③同栖一个钩子。
  //    三/四个闸共用"拦在权限弹窗之前"这个位置：被路由的调用不会让用户看到弹窗（ROADMAP 10.5.6）。
  //    为什么不靠描述文字引导：模型选通道看的是描述，而描述是**软约束**（强度 = 模型听不听话），
  //    这条线由程序在工具调用处判定，不依赖模型自觉。详见 src/git/route.ts 头注。
  //    它同样记一条审计：语义上不是"拒绝"而是"改道"，但"这次调用没有按原样执行"这个事实
  //    恰恰是查账时要看的（tag=route 与三道闸区分得开）。
  const route = routeBashGitRead(toolName, e.args);
  if (route) return deny('改道 git 工具', 'route', route);
  return undefined;
}

export async function main(checkResult: CheckResult): Promise<void> {
  const { llm } = checkResult;
  const modelName = checkResult.config?.model ?? 'unknown';
  const baseUrl = checkResult.config?.baseUrl ?? '';

  // 项目上下文播种：工作记忆（TASK.md）/ 项目记忆（.flint/memory.md）/ 事件库
  // （.flint/events.jsonl + tool-calls.jsonl）/ 契约锁复位 / 通讯录登记 ——
  // **唯一实现**在 harness/project-context.ts，启动与 `/projects --switch` 共用同一份
  // （切换只是对着新目录再走一遍）。各条"只在启动读一次、运行期不回读"的理由都在那个文件里。
  // 清单若无未完成项（空文件 / 全勾选），loadFromFile 会删掉文件并保持空清单。
  //
  // 通讯录登记**不再是无条件的**（ROADMAP 10.11.6）：判据判成"独立项目"才写，
  // 判成"仓库子目录"就归并到仓库根，判不出来（家目录 / 临时目录 / 无证据）就**不写盘**、
  // 只在 banner 里问一句。那个 verdict 就是下面给 repl 的那句提示（独立项目 → null = 不提示）。
  const seed = seedProjectContext();

  // 改完自检（ROADMAP 10.6.2）：登记表**只在启动时读这一次**，运行期以内存为准、不再回读。
  // 「只读一次」是承重的，不是顺手：否则模型写一份 .flint/postcheck.json 把 command 换成
  // 任意命令，同会话内立刻生效 = 一条免弹窗执行的路（写这文件要走 write 的权限弹窗，但
  // 立即生效就等于把那次弹窗变成摆设）。读一次进内存，这条路就断了。
  // 宽容读：不存在 / 读失败 / 内容不合法 → 一律不启用（与 .flint/PROJECT.md 同一口径）。
  try {
    // 命令表先播种：登记表里的 {"use":"名字"} 要在它里面查（10.6.1 的发现半边）。
    // 同样**只在启动读一次** —— package.json 是模型可写文件，运行期重读等于让它改一行
    // scripts 就改写注入内容、并让 use 指向另一条命令（自我授权路径的同源论证）。
    // **包管理器前缀由技术栈画像给**（10.1.1）：`seedProjectContext()` 刚在上面播过种，
    // 两半读取发生在**同一时刻**、刷新率一致，所以不会出现"画像说 pnpm、命令表写 npm"。
    // 画像判不出来（无 Node 生态 / 无锁文件无字段）→ 退回 DEFAULT_MANAGER，
    // 也就是 10.1.1 之前硬写的那个值：**探测不到任何东西的项目，行为逐字不变**。
    const manager = stackRegistry.get().nodeManager ?? DEFAULT_MANAGER;
    const commands = existsSync(PACKAGE_JSON_FILE)
      ? parsePackageScripts(readFileSync(PACKAGE_JSON_FILE, 'utf-8'), manager)
      : [];
    commandRegistry.set(commands);
    postcheckRegistry.set(existsSync(POSTCHECK_FILE)
      ? parsePostcheckConfig(readFileSync(POSTCHECK_FILE, 'utf-8'), commands)
      : null);
  } catch {
    commandRegistry.clear();
    postcheckRegistry.set(null);
  }

  // 自检基线（2026-09-16）：登记了就**现在**跑一遍，把「项目原本就有的错」记下来，
  // 之后每次自检只报相对基线**新增**的 —— 否则全项目 tsc 会把历史遗留的旧错一起倒给
  // 模型，它分不清哪个是自己刚写坏的。
  // 同样只在启动这一次：运行期重采等于让模型「把当前的错洗白成基线」，防线自己拆自己。
  // 代价是启动多等一轮命令（上限 = 登记表里的 timeoutMs），慢项目可把 timeoutMs 调小。
  // 采基线失败不影响启动（它是附加情报，不是启动的前置条件）。
  try {
    await seedPostcheckBaseline();
  } catch {
    postcheckBaseline.set(null);
  }

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
  // 链的本体在文件上方（coreBeforeToolCall）——抽出去**只为让验证套件能真跑它**：
  // 装配后的实际次序、是谁拒的、审计记了什么都能逐条打靶，而不是只能对本文件做文本断言。
  // 注册时机（装载扩展之前）与"核心钩子先入列、扩展返回 undefined 不覆盖 deny"两条不变。
  // `planMode.isOn()` **每次调用现取**（与工作区闸现取 cwd 同一个理由）：`/plan on|off`
  // 改了模式之后，下一次工具调用立刻按新模式判，不需要重装钩子。
  events.on('before_tool_call', (event) =>
    coreBeforeToolCall(event, charterLock.isUnlocked(), planMode.isOn()));

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
  // 输入预处理器（runtime.onInput，ROADMAP 10.8.1）：`@path` 输入引用。
  // 落点说明：这个钩子在 runtime.prompt() 里、**命令分发之后、skill 展开之前**被消费，
  // 能改写文本 —— 正是"输入层解析"要的位置（路线图 R4 早就点名了它）。
  // 挂在这里而不是 REPL 里：RPC 模式同样走 prompt()，编辑器和终端应当一个口径。
  // 传回调而不是 cwd 字符串：项目切换会 chdir，必须在调用时现取。
  // 它**只在输入里真的出现 `@` 时才干活**（内部有短路），不含任何启动期成本。
  runtime.onInput(atFileInputHandler(() => process.cwd()));

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

  await runReplMode(runtime, checkResult.diagnostics ?? [], probePromise,
    renderRegistrationNote(seed.verdict));
}
