# 📖 项目术语表

> 统一解释项目中出现的技术术语，供人和 AI 共同参考。

## A

### Agent
Agent 的运行实体，包含 `start()` / `stop()` / `prompt()` 三个核心方法。Agent 不持有循环，只处理单次输入。

参见：[Harness](#harness)、[Runtime](#runtime)

### Async Generator（异步生成器）
`async function*` + `yield` 构成的函数，每次 `yield` 暂停执行，等待消费者调用 `next()` 后继续。用于本项目中的 LLM 流式输出。

## B

### Backpressure（背压）
消费者处理速度慢于生产者时，生产速度自然受抑制的机制。在 `for await...of` 中，循环体执行完才调 `next()` 取下一个值，天然实现背压。

## C

### Check
启动前检查阶段，位于 `harness/check.ts`。读取配置、创建 LLM Provider、验证环境。结果通过 `CheckResult` 注入 Runtime。

参见：[Harness](#harness)、[RuntimeOptions](#runtimeoptions)

### CheckResult
`check()` 的返回值类型，包含已初始化的 `LLMProvider`。由 `harness/index.ts` 接收后传入 `main()`。

### CLI 模式
Agent 内部持有 `while(true)` 循环，自驱动运行的交互方式。循环在 `Runtime.start()` 内部。

对比：[Pi 模式](#pi-模式)

### CollectedSpan
消费端拿到手的**成品段**：一段已经结束、字段齐全、只读的行为记录（`name` / `spanId` / `turnId` / `seq` / `startedAt` / `durationMs` / `status` / `input` / `output`，异常时多一个 `error`）。契约在 `core/events.ts`，由 [SpanCollector](#spancollector段收集器) 配对产出。

`status` 四种：`ok` / `error` / `unclosed`（退出时仍未关门）/ `running`（还没出门，仅 `running()` 里出现）。

对比：[Span](#span行为段)（生产端手里那个还在跑的句柄）

### Config（配置）
项目的运行参数文件，如 `package.json`、`tsconfig.json`、`config/api.json`。属于[项目元数据](#项目元数据)的一类。

## D

### DI 容器（Dependency Injection Container）
自动组装依赖的工具。向容器声明"我要一个 Runtime"，容器自动查找 Runtime 的依赖（LLMProvider、SessionStorage）以及这些依赖的依赖，全部创建好后返回。在本项目中未使用——手动组装完全可控，DI 容器的隐式查找反而增加理解成本。

参见：[ARCHITECTURE.md](./ARCHITECTURE.md#决策-6不做-di-容器)

### DeepSeek Provider
`LLMProvider` 接口的 DeepSeek 实现，位于 `src/llm/deepseek.ts`。支持 `chat()`（非流式）和 `stream()`（流式）两种模式。

参见：[LLMProvider](#llmprovider)

### Document（文档）
记录项目状态和历史的信息文件，如 `CHANGELOG.md`、`ROADMAP.md`。属于[项目元数据](#项目元数据)的一类。

## E

### Event Subscription（事件订阅）
通过 `subscribe(handler)` 注册事件处理器，`emit(event)` 触发通知的模式。Pi 的 `prompt()` 返回 `void`，回复通过事件流传递。

对比：[OnToken Callback](#ontoken-callback)

### EventBus（事件总线）
`core/events.ts` 的契约，实现在 `runtime/events.ts` 的 `PromptEventEmitter`。`emit()` 只做两件事：给事件盖上公共头（`at` / `seq` / `turnId`），再**同步**广播给订阅者。它自己不配对、不落盘、不上屏——那些全是订阅者的事。

两把钥匙，区别很大：

- `subscribe(handler)`：通配收**全量**事件，返回值没人收——**只看**
- `on(type, handler)`：精确监听某一类事件，返回值经 `emitHook` 收回——**能改写流程**

本条取代下方的 `PromptEvent（计划中）`：事件系统早已落地，现有十余种事件类型与四组骨架段。

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
`function*` + `yield` 构成的函数。详见 [TS/生成器与异步生成器](../TS/生成器与异步生成器.md)。

## H

### Harness
启动编排类，位于 `src/harness/index.ts`。执行 `check()` → `main()` 的完整启动流程。Harness 不持有循环，只做编排。

参见：[Agent](#agent)、[Runtime](#runtime)

### Hook（钩子扩展）
这个词在项目里有**两个意思**，混了就会误读：

1. **装载口子意义的 hook**：住在 `src/extensions/hooks/`、export `registerHooks` 的扩展文件。目录名是按“怎么装进来”命名的。
2. **总线 API 意义的 hook**：`events.on(type, handler)`——精确监听，返回值经 `emitHook` 收回，因此**能改写流程**。

全项目只有两个发射点，都在 `context/system-prompt.ts`：`before_build` 与 `before_request`。

**住在 `hooks/` 目录 ≠ 用了 `on`**。`trace-log` 就曾住在这个目录却只用 `subscribe`，因此被误读为“trace 与钩子机制有关”，现已搬到 `watchers/`。

对比：[Watcher](#watcher旁观扩展)

## I

### InMemorySession
`SessionStorage` 接口的内存实现，位于 `src/runtime/session.ts`。数据存储在内存数组中，进程重启后丢失。

参见：[SessionStorage](#sessionstorage)

## L

### LLMConfig
LLM Provider 配置类型，对应 `config/api.json` 的结构：`baseUrl`、`apiKey`、`model`。

### LLMMessage
一条对话消息：`{ role: 'system' | 'user' | 'assistant', content: string }`。

### LLMProvider
LLM 调用抽象接口，位于 `src/llm/types.ts`。定义 `chat()` 和 `stream()` 两个方法。每种接入方式（DeepSeek / Anthropic / Ollama）实现此接口。

参见：[DeepSeek Provider](#deepseek-provider)

## M

### Mode（运行模式）
`enum Mode { Repl, Rpc }`，用于切换交互模式。当前默认 `Repl`，未来支持 `Rpc`。

### MockSession
`SessionStorage` 的测试替身，位于 `src/runtime/session.mock.ts`。字段公开，测试中可直接断言内容。

参见：[SessionStorage](#sessionstorage)

## O

### OnToken Callback
`prompt(input, onToken)` 的回调参数，每收到一个流式 chunk 时调用。当前 UI 联动方式。

对比：[Event Subscription](#event-subscription)

## P

### Pi 模式
Agent 不持有循环，调用方持有 `while(true)` 负责驱动。Runtime 只提供 `prompt()` 方法，循环在 `main.ts` 里。

对比：[CLI 模式](#cli-模式)

### Project Metadata（项目元数据）
不产生功能但定义项目如何被理解的所有文件。分为四类：Rule、Document、Config、Skill。

参见：[[项目元数据（Project Metadata）]]

### PromptEvent（计划中）
未来事件订阅模式中的事件类型。计划定义为 `{ type: 'stream_token' | 'stream_end' | 'tool_call' | 'error', ... }`。

## R

### REPL 模式
`Read → Eval → Print → Loop` 的交互循环。用户打字 → Agent 回复 → 等下一次输入。循环在 `main.ts` 的 `runReplMode()` 中。

### Rule（规则）
约束 AI 或开发者行为的文件，如 `CLAUDE.md`、`CLAUDE.init.md`。属于[项目元数据](#项目元数据)的一类。

### Runtime
运行时上下文类，位于 `src/runtime/runtime.ts`。持有 `LLMProvider`，提供 `prompt()` 方法。通过 `RuntimeOptions` 构造函数注入依赖。

### RuntimeOptions
Runtime 构造选项，包含 `mode`、`llm`(LLMProvider)、`session`(SessionStorage)、`services`。

## S

### SessionStorage
会话存储接口，定义 `appendMessage`、`getMessages`、`clear` 三个方法。`InMemorySession` 是默认实现，`MockSession` 是测试替身。

### SSE（Server-Sent Events）
HTTP 流式传输协议，服务端持续发送 `data: {...}\n` 格式的事件。DeepSeek 和 OpenAI 的流式 API 都基于 SSE。

### Skill（技能）
Agent 可调用的能力模块（计划中）。不属于[项目元数据](#项目元数据)——Skill 是可执行的，元数据是声明式的。

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

## W

### Watcher（旁观扩展）
住在 `src/extensions/watchers/`、export `registerWatchers` 的扩展。它用 `ctx.events.subscribe(handler)` 通配收全量事件、返回值没人收——**只看只录，拦不住任何人**。

与 [Hook](#hook钩子扩展) 的唯一区别就是 ctx 里少了 `on`：拿不到 `on` 就改不了流程。这条约束由类型系统兜住，不靠使用自觉；`scripts/verify-extensions.ts` 还用**探针法**断言了“watcher 实际收到的 ctx 键里确实没有 `on`”（类型在运行时被擦除，只能这样验）。

现住民：`trace-log.ts`（成段落 `trace.jsonl`）。

对比：[Hook](#hook钩子扩展)
