# 🏗️ 架构决策记录

> 本项目在搭建过程中的关键架构决策与理由。
> 本文是**现状快照**（不是 append-only 日志），2026-09-03 逐条拿代码校准过一次；演进过程见 [ARCHITECTURE_LOG.md](./ARCHITECTURE_LOG.md)。

---

## 一、整体架构

### 分层结构

```
┌─ 入口 ────────────────────────────────────────────────────
│ index.ts          initTerminal() → Harness.run()
└───────────────────────────────────────────────────────────

┌─ 编排层 · harness/ ───────────────────────────────────────
│ check()           读配置 → createProvider()；全程本地，0 网络请求
│ main()            闭包工厂：组装 11 个必注入依赖 → 模式分发
│   ├─ repl.ts      REPL：TTY → TreeUI ／ 管道 → TerminalUI
│   └─ rpc.ts       RPC：JSON-RPC over stdin/stdout
└───────────────────────────────────────────────────────────

┌─ 运行时 · runtime/runtime.ts ─────────────────────────────
│ Runtime           只编排一次 prompt 的流程，自己不持有任何实现
│                   命令 / inputHandlers / skill 展开 → 压缩 → Agent Loop → 落盘
└───────────────────────────────────────────────────────────

┌─ 契约层 · core/（11 个文件）──────────────────────────────
│                   子系统之间只通过这里的接口说话，谁也不 import 谁的实现
│ 执行类 Service    loop · commands · compaction · diagnostics · system-prompt
│ 能力提供类        tools(ToolProvider) · permission(PermissionProvider)
│ 数据类            storage(SessionStorage) · compaction-store
│                   events(EventBus + Span 打卡契约 + SpanCollector 收段契约)
│ 扩展契约          extension（三类 ctx 各自能拿到什么，见下"扩展三口子"）
└───────────────────────────────────────────────────────────

┌─ 子系统实现（一目录一个，互不 import）────────────────────
│ loop/             AgentLoopServiceImpl —— LLM 流式 + 工具执行的循环
│ session/          JsonlSessionStorage（entry 树 + leaf 指针 + fork）· InMemory · Mock
│ tools/            ToolRegistry + 5 个内置工具（ls / read / write / grep / bash）
│ permission/       PermissionManager
│ context/          CompactionServiceImpl · SystemPromptService · 扩展装载器 · 内置段落
│ commands/         CommandServiceImpl + 9 个内置命令
│ diagnostics/      DiagnosticsServiceImpl
│ config/           ConfigManager（配置分层 + 供应商注册表 + 模型列表预热/新鲜期）
│ llm/              createProvider() 工厂 → AnthropicProvider（provider === 'anthropic'）
│                                          → DeepSeekProvider（其余一律，OpenAI 兼容）
│                   OllamaProvider 仍只是注释里的愿景，没有实现
└───────────────────────────────────────────────────────────

┌─ 交互层 · io/ ────────────────────────────────────────────
│ terminal.ts       stdin/stdout（readLine / initTerminal / readLineWithMode）
│ ui/tree-ui.ts     TreeUI：TTY 组件树（Container / Text / SelectList）
│ ui/screen.ts      Screen：行数组快照 + 差分渲染
│ ui/index.ts       TerminalUI：管道模式轻量文本
│ ui/input-handler.ts  InputHandler：raw mode 逐键解析
└───────────────────────────────────────────────────────────
```

### 两条横切旁路（不在调用链上，挂在 EventBus 上）

```
扩展三口子 · src/extensions/（context/extension-loader.ts 自动扫描装载）
  sections/   加系统提示词段落    export registerSections   ctx = { addSection }
  hooks/      可改写流程          export registerHooks      ctx = { on, events }
  watchers/   只旁观不改流程      export registerWatchers   ctx = { events }
                                  ↑ 拿不到 on 是类型层面的约束，verify-extensions 用探针法坐实

观测 · runtime/events.ts + runtime/span-collector.ts
  生产端（runtime / loop / context）
    ├─ events.emit(...)              → 离散事件（UI 的"画面"）
    └─ events.trace() / beginSpan()  → 成对 span（观测的"账本"，结构保证配对 + durationMs）
         ↓ PromptEventEmitter 统一盖 at / seq / turnId
  订阅者并列、互不干扰：
    ├─ TreeUI / TerminalUI                    ← 画面
    ├─ SpanCollector 实例一 → /traces 命令    ← 就地看最近段耗时/成败/正在跑
    └─ SpanCollector 实例二 → watchers/trace-log.ts → trace.jsonl（TS_AGENT_TRACE=1 开）
       两个实例共用 span-collector.ts 这一份配对代码：落盘的关掉不影响上屏的
```

### 为什么分层？

每层替换不影响其他层：

- 换交互方式（CLI → WebSocket → HTTP）只在 `harness/` 加一个模式文件，不动 Runtime
- 换 LLM 厂商只加一个新 Provider 实现 + `llm/index.ts` 工厂里一个分支，不动 Runtime
- 换存储后端只加一个新 `SessionStorage` 实现（**但注意下面"已知架构债"第 1 条**）
- 加观测消费者只多订阅一次 EventBus，生产端一行不改

---

## 二、核心决策

### 决策 1：Pi 模式（调用方持有循环）

**选择：** Runtime 不持有 `while(true)`，循环在调用方手里。

**现状：** 循环定义在 `harness/repl.ts` 的 `runReplMode()`（**不在 `main.ts`**——`main.ts` 只做模式分发与依赖组装）；RPC 模式的循环在 `harness/rpc.ts`，按请求驱动。

**理由：**
- 调用方控制节奏，Runtime 保持纯粹（只管 `prompt`）
- 可无缝切换 I/O 模式（REPL → RPC → WebSocket）
- 测试容易——单次 `runtime.prompt()` 调用不依赖循环上下文

**代价：** 每加一种交互模式就要再写一份循环样板（现在已有 repl / rpc 两份）。

参见：GLOSSARY [Pi 模式](./GLOSSARY.md#pi-模式)

### 决策 2：构造函数注入

**选择：** Runtime 的依赖通过构造函数传入，不内部读取文件。

**现状：** `RuntimeOptions` 有 **11 个必注入**（无默认值，全部由 `harness/main.ts` 显式组装）：`llm`、`session`、`tools`、`permission`、`skills`、`events`、`spanCollector`、`commandSystem`、`diagnosticsService`、`compaction`、`systemPromptService`。可选的是 `mode`、`model`/`provider`/`baseUrl`、`thinking`、`services`（仍是 `unknown`，标着 TODO）。

**理由：**
- 依赖来源清晰，不藏隐式文件读取
- 测试时直接注入替身，不需要 mock 文件系统

**代价：** 调用方需要先组装 11 个依赖再传进去，`main.ts` 的组装段落随子系统增加而变长。

### 决策 3：接口先行（SessionStorage / LLMProvider）

**选择：** 子系统之间一律先定接口再写实现，接口集中在 `src/core/`。

**现状：** `core/` 已有 11 个契约文件（见上图）。三类命名约定：执行类叫 `*Service`、能力提供类叫 `*Provider`、数据类叫 `*Storage` / `*Store` / `*Bus`。

**理由：**
- 替换实现不需要改调用代码（InMemorySession → JsonlSessionStorage）
- 测试可注入替身
- 预留多种接入方式（DeepSeek → Anthropic 已兑现）

**代价：** 初期多一批接口文件；**而且接口一旦重名就会出事**——见"已知架构债"第 1 条。

### 决策 4：check() 统一读取配置

**选择：** 所有配置读取和 Provider 创建集中在 `harness/check.ts` 中，结果通过 `CheckResult` 传给后续环节。

**现状：** 启动关键路径已做到 **0 网络请求**（2026-09-02 启动提速第二档）——模型列表改为界面渲染前 fire-and-forget 内存预热，`/model` 二级展开前才 `ensureModels`（5 分钟新鲜期内零等待，还在飞则复用在飞 promise）；网络连通探测本就在后台。实测 `check()` 从 760ms 降到 0.7ms。

**理由：**
- 配置错误在启动时即暴露，而非运行时才报错
- 单一配置入口，不散落 `readFileSync` 在各模块中
- 配置验证结果可被多个消费者复用

**代价：** check() 必须返回一个 Result 对象，调用链多一层。

### 决策 5：Streaming 以回调方式提供

**选择：** `prompt()` 保留返回完整文本的能力，同时通过可选 `onToken` 参数支持流式。

**现状（这条已被事件系统取代，签名保留）：** 真实签名是 `prompt(input, onToken?, streamingBehavior = 'followUp')`，但**三个调用点全都不传 `onToken`**——`repl.ts` 与 `rpc.ts` 只传 input，`tree-ui.ts` 甚至显式写 `undefined` 跳过它去传第三个参数。UI 联动实际全部走 EventBus 订阅。Runtime 内部个别分支仍会调它（插入 steer 消息时回一句提示），所以它没死，只是**没人从外面接**。

**理由（当初）：**
- 向后兼容——不传 `onToken` 时行为与旧版一致
- 调用方自由选择流式或非流式
- 简单场景（如 RPC 模式）不需要流式，可以不传

**代价：** 函数签名比纯事件模式更复杂，且现在多了一个没人用的可选参数——**新代码不应再用它，走事件订阅**。

### 决策 6：不做 DI 容器

**选择：** `main.ts` 显式手动组装依赖，不使用 IoC 容器。

**理由：**
- 项目规模小（<10 个模块），手动组装完全可控
- 没有"依赖链的依赖链"需要容器解决
- DI 容器增加隐式查找（"这个 Service 从哪来的？"）

**代价：** 模块数量增长到 20+ 时，可能需要重新评估。

**现状：重新评估的条件已经触发**——`src/` 下 14 个目录、70 个 `.ts` 文件，`main.ts` 要组装 11 个必注入依赖。但结论仍是**不做**：组装点只有一处、从上到下一屏能读完，比容器的隐式查找更好查错。真要减负，先做的是把组装段落抽成一个 `createRuntime()` 工厂函数（已经这么做了），而不是引容器。

---

## 三、对比参考

### 与 Pi Agent 架构的区别

| 维度 | Pi | 本项目（2026-09-03 现状） |
|------|----|--------|
| 循环所有权 | InteractiveMode 持有 | `harness/repl.ts` 的 `runReplMode()` 持有 |
| 事件系统 | subscribe/emit 全链路 | **已落地**：EventBus + 统一盖 `at`/`seq`/`turnId` + 骨架 span / 便签 span 双通道（`onToken` 签名保留但无人传） |
| 会话模型 | 树形分支（可 /fork） | **已落地**：`JsonlSessionStorage` entry 树（`id` + `parentId`）+ leaf 指针 + `/history` fork（复制前缀到新文件，原文件不动） |
| 扩展机制 | 完整的 Extension 插件体系 | **已落地三类口子**：sections / hooks / watchers，`extension-loader` 自动扫描装载 |
| 配置 | 分层 SettingsManager（全局/项目/会话） | **部分落地**：密钥分三层（环境变量 > 全局 `~/.ts-agent/config.json` > 项目 `config/provider-keys.json`），其余配置项还没分层（`config/manager.ts` 里标着 TODO） |
| 观测 | docs/observability.md | **已落地**：SpanCollector 公共配对件 + `/traces` 内置命令 + `trace.jsonl` 落盘；不引 LangSmith / LangFuse 这类外部服务 |
| 测试 | vitest 全套 | **路线不同、且已定调**：12 套零依赖验证脚本、359 项断言（`npm run verify` 串跑）+ 1 个真实链路冒烟；无框架、无覆盖率、无 CI。“引入 vitest”的待办已于 2026-09-03 关闭，取舍见 [DECISION_LOG.md](./DECISION_LOG.md) 与 [TESTING.md](./TESTING.md) |

---

## 四、已知架构债

> 2026-09-03 校准文档时查出 7 条，**同日下午已处理 4 条**（下面标 ✅，保留原描述以便回溯“当初为何算债”）；剩 3 条仍成立；另在修第 7 条时又查出 1 条（第 8 条）。

1. ✅ **两个同名 `SessionStorage` 接口，注释还互相矛盾**（已收敛）
   - 原状：`core/storage.ts` 版有三必需方法 + 三可选成员（`getAllStored?` / `forkTo?` / `getDir?`），注释说“这样 Runtime **无需 instanceof** 判断”，三个实现 implements 的是这一版；`types.ts` 版只有三必需方法，注释说“Runtime **通过 instanceof 分支调用**”，而 `RuntimeOptions.session` 声明的是这一版——于是可选成员在接口层面拿不到，`runtime.ts` 里只能写 `if (this.session instanceof JsonlSessionStorage)`。
   - 怎么修的：`types.ts` 改成只做转发（`export type { SessionStorage, StoredMessage } from './core/storage.js'`），`RuntimeOptions.session` 直指 core 版；`runtime.ts` 四处 instanceof 换成**能力探测**（`if (this.session?.getAllStored)`）。等价性的根据：那四处调的正好就是三个可选成员，而三个实现里只有 Jsonl 有这三个成员。“探测 ≡ instanceof”的 3×3 穷举对比已固化为断言（`verify-session.ts` ③ 段 9 项）。

2. ✅ **`AgentConfig` 是死类型**（已删）。原状：`types.ts` 里留着它（name / version）和一句“调用方：agent.ts”的注释，而该文件从未存在、全项目无人 import。删前核实过全库引用只有 1 处，就是它自己的定义。

3. **`Provider`（供应商元数据）与 `LLMProvider`（调用抽象）同名易混。** 前者在 `llm/provider.ts`（显示名 + 模型列表 + `getApiKey`/`fetchModels`，由 `ProviderRegistry` 持有），后者在 `llm/types.ts`（`chat()` / `stream()`）。真正的工厂是 `llm/index.ts` 的 `createProvider(config)`。

4. **压缩用量没回流。** `context/compaction.ts` 走非流式 `llm.chat()`，而 `ChatResult` 没有 usage 字段，全文件也没有 `usage` 字样 → 压缩消耗的 token 从未计入 `/usage` 的合计。**本轮判定不做**：要改就得改 `ChatResult` 的形状，牵连两个 provider 的非流式路径 + `stream-helper` + 多套 verify 脚本，是独立的一件事（已记在 ROADMAP P6 “可观测性增强”的剩余项里）。

5. ✅ **`package.json` 的工程化缺口**（已补）。原状：没有 verify / test 入口（10 套脚本只能手工循环跑）；`clean` 写的是 `rm -rf dist`，Windows 下根本跑不通。现有 `verify`（`run-verify.mjs` 串跑 12 套）/ `typecheck` / `clean`（`clean.mjs` 用 `fs.rmSync` 跨平台删 dist）三个入口，三个都实测跑通。

6. **`scripts/` 不受 tsc 检查。** `tsconfig.json` 的 `include` 只有 `["src/**/*.ts"]`。这是有意的取舍（脚本要造替身、塞假字段），代价是脚本必须真跑才算验过。

7. ✅ **演示文件与空目录**（部分处理）。`runtime/input-handler-demo.ts` **已删**（连同 `main.ts` 里的 import 与注册）——它会静默吞掉 `@@` 开头的输入、把 `/ask ` 转成加问号，属**未文档化的魔法行为却挂在生产路径上**；`runtime.onInput()` 这个能力本身保留，给 ROADMAP 里的 Hook 系统。`src/runtime/commands/` 空目录**仍在**：git 本来就不跟踪空目录，所以仓库里不存在它，只是本地残留。

8. **`InputHandler` 同名冲突**（修第 7 条时查出）。`runtime.ts` 导出的是**函数类型** `type InputHandler = (text: string) => InputEventResult | Promise<...>`（输入预处理器），`io/ui/input-handler.ts` 导出的是**类** `class InputHandler`（raw mode 逐键解析）。删掉 demo 前，`main.ts` 里两者相隔两行同时出现（一行用函数类型注册、下一行注释在说那个类），同一段代码里两个含义混用。这是项目里第三组同名混淆（前两组：两个 `SessionStorage`——本日已收敛；`Provider` vs `LLMProvider`——仍成立，见第 3 条）。未改，只在两处各加了注释互指。
