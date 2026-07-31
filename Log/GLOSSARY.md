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

## G

### Generator（生成器）
`function*` + `yield` 构成的函数。详见 [TS/生成器与异步生成器](../TS/生成器与异步生成器.md)。

## H

### Harness
启动编排类，位于 `src/harness/index.ts`。执行 `check()` → `main()` 的完整启动流程。Harness 不持有循环，只做编排。

参见：[Agent](#agent)、[Runtime](#runtime)

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
