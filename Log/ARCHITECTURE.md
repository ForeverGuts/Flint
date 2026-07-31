# 🏗️ 架构决策记录

> 本项目在搭建过程中的关键架构决策与理由。

---

## 一、整体架构

### 分层结构

```
┌─────────────────────────────────────────┐
│              index.ts                   │  ← 入口
├─────────────────────────────────────────┤
│  Harness                                │  ← 编排层
│  ├─ check()   → 环境验证 + Provider 创建 │
│  └─ main()    → 模式分发               │
├─────────────────────────────────────────┤
│  Runtime                                │  ← 运行时
│  ├─ prompt()  → 处理单次用户输入         │
│  ├─ session   → 对话管理               │
│  └─ llm       → 模型调用                │
├─────────────────────────────────────────┤
│  LLM Provider                           │  ← 抽象层
│  ├─ DeepSeekProvider                    │
│  ├─ (AnthropicProvider) [TODO]          │
│  └─ (OllamaProvider) [TODO]             │
├─────────────────────────────────────────┤
│  I/O                                     │  ← 交互层
│  ├─ terminal.ts → stdin/stdout          │
│  └─ ui.ts       → 展示层 [TODO]         │
└─────────────────────────────────────────┘
```

### 为什么分层？

每层替换不影响其他层：

- 换交互方式（CLI → WebSocket → HTTP）只改 `main.ts`，不动 Runtime
- 换 LLM 厂商（DeepSeek → Anthropic）只加一个新 Provider，不动 Runtime
- 换存储后端（内存 → JSONL → SQLite）只加一个新 SessionStorage 实现

---

## 二、核心决策

### 决策 1：Pi 模式（调用方持有循环）

**选择：** Runtime 不持有 `while(true)`，循环在 `main.ts` 的 `runReplMode()` 中。

**理由：**
- 调用方控制节奏，Runtime 保持纯粹（只管 `prompt`）
- 可无缝切换 I/O 模式（REPL → RPC → WebSocket）
- 测试容易——单次 `runtime.prompt()` 调用不依赖循环上下文

**代价：** `main.ts` 多了一些模式分发的样板代码。

参见：[REPL模式.md](https://gitee.com/LittleLittleRed/first_-ts_-agent)、GLOSSARY [Pi 模式](#pi-模式)

### 决策 2：构造函数注入

**选择：** Runtime 的依赖（LLMProvider、SessionStorage 等）通过构造函数传入，不内部读取文件。

**理由：**
- 依赖来源清晰，不藏隐式文件读取
- 测试时直接注入 mock 对象，不需要 mock 文件系统

**代价：** 调用方需要先组装依赖再传进去。

### 决策 3：接口先行（SessionStorage / LLMProvider）

**选择：** SessionStorage 和 LLMProvider 都定义为接口，而不是直接使用具体类。

**理由：**
- 替换实现不需要改调用代码（InMemorySession → JsonlSession）
- 测试可 mock
- 预留多种接入方式（DeepSeek → Anthropic）

**代价：** 初期多一个接口文件，但后续扩展成本为零。

### 决策 4：check() 统一读取配置

**选择：** 所有配置读取和 Provider 创建集中在 `harness/check.ts` 中，结果通过 `CheckResult` 传给后续环节。

**理由：**
- 配置错误在启动时即暴露，而非运行时才报错
- 单一配置入口，不散落 `readFileSync` 在各模块中
- 配置验证结果可被多个消费者复用

**代价：** check() 必须返回一个 Result 对象，调用链多一层。

### 决策 5：Streaming 以回调方式提供

**选择：** `prompt()` 保留返回完整文本的能力，同时通过可选 `onToken` 参数支持流式。

**理由：**
- 向后兼容——不传 `onToken` 时行为与旧版一致
- 调用方自由选择流式或非流式
- 简单场景（如 RPC 模式）不需要流式，可以不传

**代价：** 函数签名比纯事件模式更复杂。

### 决策 6：不做 DI 容器

**选择：** `main.ts` 显式手动组装依赖，不使用 IoC 容器。

**理由：**
- 项目规模小（<10 个模块），手动组装完全可控
- 没有"依赖链的依赖链"需要容器解决
- DI 容器增加隐式查找（"这个 Service 从哪来的？"）

**代价：** 模块数量增长到 20+ 时，可能需要重新评估。

---

## 三、对比参考

### 与 Pi Agent 架构的区别

| 维度 | Pi | 本项目 |
|------|----|--------|
| 循环所有权 | InteractiveMode 持有 | main.ts 持有 |
| 事件系统 | subscribe/emit 全链路 | 当前用 onToken 回调 |
| 会话模型 | 树形分支（可 /fork） | 线性（计划中支持） |
| 扩展机制 | 完整的 Extension 插件体系 | 待开发 |
| 配置 | 分层 SettingsManager（全局/项目/会话） | 单文件 config/api.json |
