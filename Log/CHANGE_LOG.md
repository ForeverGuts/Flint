# 变更日志

> 格式：`YYYY-MM-DD HH:mm | [类型图标] 描述`
> 类型释义：
>   [Init🚀]    项目初始化 / 骨架搭建
>   [Feature✨] 新功能开发
>   [Fix🐛]     Bug 修复
>   [Refactor♻️] 重构 / 目录清理 / 代码重组
>   [Optimize⚡] 性能优化
>   [Config⚙️]  配置文件变更（package.json / tsconfig.json 等）
>   [Docs📝]    文档 / 注释 / 知识库
>   [Env📦]     环境 / 依赖安装与升级
>   [CI✅]      编译 / 构建 / 验证
字数限制：每段描述最多 1 行
不同日期的记录之间用空行隔开

2026-09-03 15:11 | [CI✅] 全量回归：tsc --noEmit 零错误；12 套 verify 全绿 359/359（8+16+17+13+76+21+22+13+47+32+72+22），退出码全 0；三个 npm 入口（verify / typecheck / clean）均实测跑通——PowerShell 下 `npm` 被执行策略挡住（报“无法加载文件 npm.ps1，因为在此系统上禁止运行脚本”），须用 `npm.cmd` 或直连 node
2026-09-03 15:11 | [Docs📝] 现状文档跟着本轮代码改动同步：TESTING.md 299 → 359 项 / 10 → 12 套（清单表补 verify-session 与 verify-docs、断言函数名 check 从 3 套变 5 套、退出码第三种变体从 1 套变 3 套、第四节改写成 `npm run verify`、第七节划掉两条已修的缺口并补“文档只查锚点不查路径”）；ARCHITECTURE.md 第四节 7 条 → 8 条（1/2/5/7 标 ✅ 已处理并保留原状描述以便回溯、新增第 8 条 InputHandler 同名冲突）、对比表测试行改 12 套 359 项、决策 6 的 .ts 计数 71 → 70（删了 demo 文件）；目录.md 删 input-handler-demo 条目、types.ts 的两处 ⚠ 改为收敛说明、scripts/ 补 4 个新文件、职责表 10 套 299 → 12 套 359；GLOSSARY 的 SessionStorage 词条整段重写（不再是“两个同名接口互相矛盾”）、Agent 词条的 AgentConfig 改为已删
2026-09-03 15:11 | [Docs📝] 不引入 vitest 落地（用户拍板）：ROADMAP P6“正式测试套件”勾选关闭并写明原案与关闭理由、DECISION_LOG 顶部追加一块二选一决策（含“立项时写的痛点已消失”与“迁移期会出现两套测试体系”两条理由、以及放弃覆盖率/watch/隔离/describe 组织力的代价）、TESTING.md 第一节补一句消除与 ROADMAP 的立场冲突
2026-09-03 15:11 | [Config⚙️] package.json 补 verify（node scripts/run-verify.mjs）/ typecheck（tsc --noEmit）两个入口，clean 从 `rm -rf dist`（POSIX 命令，在本项目的主力开发环境 Windows 上一直是坏的）改为 `node scripts/clean.mjs`；新增 clean.mjs 用 fs.rmSync 的 recursive + force 跨平台删 dist（目录不存在也不报错）
2026-09-03 15:11 | [Feature✨] 新增 scripts/run-verify.mjs 串跑入口（73 行）：扫 `^verify-*` 逐个跑（.ts 走 tsx、.mjs 直跑），末尾打逐套通过/失败/退出码表 + 合计；结果行正则兼容四种写法变体，解析不到就把项数记 `?` 并单独提示、不静默当成通过，成败一律以退出码判定；自身名字不匹配 `^verify-` 所以不会把自己也跑一遍
2026-09-03 15:11 | [Feature✨] 新增 scripts/verify-docs.mjs（13 项、4 段）：按 GitHub slug 规则（转小写 → 删非字母数字空格连字符、CJK 保留 → 空格换连字符）算标题锚点，查 Log/ 下 14 份 markdown 的同文件与跨文件死链；第三段是“入站锚点契约”6 条，把被 DECISION_LOG 与 GLOSSARY 引用的标题文字钉死（DECISION_LOG 是 append-only，断链没法在源头修，只能不让标题变）；故意不查“文档提到的文件路径是否存在”——实测误报 28/31，理由写在脚本头注释
2026-09-03 15:11 | [Fix🐛] GLOSSARY.md 5 处同文件锚点死链（2 个目标）：`#项目元数据` ×4 与 `#event-subscription` ×1，按该文件其余 30+ 处已用的“全 slug 含中文后缀”约定改为 `#project-metadata项目元数据` 与 `#event-subscription事件订阅`；自写 PowerShell slug 校验器交叉验证死链合计为 0
2026-09-03 15:11 | [Feature✨] 新增 scripts/verify-session.ts（205 行、47 项、8 段）：把接口收敛钉死——契约形状（源码文本断言 types.ts 不再自定义、runtime.ts 无 `this.session instanceof`）、三个实现的可选成员真值表、“能力探测 ≡ instanceof”的 3×3 穷举对比（重构行为等价的根据）、getHistoryMessages 两条分支、msgId 兜底链、getSessionMsgCount 四例、forkSessionAt（Jsonl 真 fork：新文件存在 + 原文件一字未动 + 新分支只含前缀）、sessionDir 经 listSessions 间接验（不串到项目真实 ./sessions）；Runtime 的 11 个必注入只有 session 是真的，其余用替身
2026-09-03 15:11 | [Refactor♻️] 删掉 AgentConfig 死类型（全库引用只有 1 处 = 它自己的定义，注释声称的调用方 agent.ts 从未存在）与 runtime/input-handler-demo.ts（连同 main.ts 的 import 与 runtime.onInput 注册）——删前查出它会静默吞掉 `@@` 开头的输入、把 `/ask ` 转成加问号，属未文档化的魔法行为却挂在生产路径上；顺带查出 InputHandler 同名冲突（runtime.ts 的函数类型 vs io/ui/input-handler.ts 的逐键解析类），未改名、只在两处各加注释互指
2026-09-03 15:11 | [Refactor♻️] 收敛两个同名 SessionStorage 接口：types.ts 改为只转发 core/storage.ts 那版（`export type { SessionStorage, StoredMessage } from './core/storage.js'`）、RuntimeOptions.session 用内联 import 直指 core 版，于是三个可选成员（getAllStored / forkTo / getDir）在接口层面就能拿到；runtime.ts 四处 `instanceof JsonlSessionStorage` 换成能力探测（那四处调的正好就是这三个可选成员，行为等价），getAllStored 走接口后 msgId 变可选故显式兜底 `m.msgId ?? m.id ?? ''`；JsonlSessionStorage 的 import 保留（listAll / open / create 三个静态方法仍在用）
2026-09-03 14:22 | [Docs📝] 目录.md 跟着校准一轮（超出原案范围）：删掉三个幽灵条目（CLAUDE.init.md、src/utils/error-log.ts、src/persistence.ts 均不存在）、io/ui/permission.ts 更正为 permission-prompt.ts、core 契约 9 → 11（补 extension.ts / system-prompt.ts）、runtime/ 补 loader.ts / utils.ts / input-handler-demo.ts 与空目录 commands/、内置工具 4 → 5（漏了 ls）、config/ 补 global-config.example.json、树里补 skills/ 与 sessions/、根目录补 package-lock.json 与三个已 gitignore 的调试残留；types.ts 一行标出两处⚠（AgentConfig 死类型、与 core/storage.ts 同名不同体的 SessionStorage）
2026-09-03 14:22 | [Docs📝] ARCHITECTURE.md 重画（127 → 209 行）：分层图从 5 格扩成 6 层 + 两条横切旁路（补 core 契约层 11 文件、9 个子系统实现、扩展三口子、观测旁路的两个 SpanCollector 实例），(AnthropicProvider) [TODO] 与 ui.ts [TODO] 改为已落地、OllamaProvider 保留为愿景并写明工厂路由规则（anthropic → AnthropicProvider，其余一律 DeepSeekProvider）；决策 1 更正循环位置（harness/repl.ts 而非 main.ts）、决策 2 补 11 个必注入清单、决策 4 补启动 0 网络请求与 760ms→0.7ms、决策 5 标注已被事件系统取代（三个调用点全不传 onToken）、决策 6 记下“20+ 模块重新评估”条件已触发（现 14 目录 / 71 个 .ts）但结论仍是不做；对比参考表 5 行里 4 行已反转，全部重写并加观测 / 测试两行；新增第四节“已知架构债”7 条。三条入站锚点（决策 1/5/6 标题）原文保留，DECISION_LOG 与 GLOSSARY 的链接不断；顺手修好本文里指向 GLOSSARY 的死链（#pi-模式 → ./GLOSSARY.md#pi-模式）
2026-09-03 14:22 | [Docs📝] TESTING.md 整份改写（114 → 96 行，7 节）：旧版“测试框架未选型 / Agent 类的 start()、stop() / src/runtime/session.mock.ts”全部与代码矛盾，且 line 55-65 的示例代码照抄编译不过（chat 应返回 ChatResult、stream 应返回 EventStream<LLMStreamEvent>、new Runtime 缺 11 个必注入），故不逐条修而是按实际体系重写：10 套 verify 清单表格（逐套项数经真跑核对，合计 299）+ 断言函数名三种并存与退出码四种变体（记为债务不是设计）+ 怎么跑（含 ..\node_modules 陷阱与 npx 被执行策略挡住）+ scripts/ 不受 tsc 检查的取舍 + 四种手法（假服务器 / 探针法 / 手工喂事件 / 真实链路冒烟）+ 7 条缺口
2026-09-03 14:22 | [Docs📝] GLOSSARY.md 41 条逐条拿代码验证，查出 23 条失真并修正 + 新增 8 条（→ 49 条，新建 J、U 两节）：修正 Agent（本项目没有 Agent 类）/ Async Generator / Check / CheckResult / CLI 模式 / Config / DeepSeek Provider / Event Subscription / Generator / Harness / InMemorySession / LLMConfig / LLMMessage / LLMProvider / Mode / MockSession / OnToken / PromptEvent / REPL / Rule / Runtime / RuntimeOptions / Skill / EventBus / Pi 模式；新增 Agent Loop / Compaction / Diagnostic / EventStream / JsonlSessionStorage / Provider（供应商）/ thinking / Usage。SessionStorage 条写明两个同名接口注释互相矛盾而 instanceof 才是现状，OnToken 条写明三个调用点全不传（没死，只是没人从外面接），Document 条区分 append-only 日志与现状快照
2026-09-03 14:22 | [CI✅] 文档校准前后各跑一次全量回归：10 套 verify 全绿 299/299（8+16+17+76+21+22+13+32+72+22），退出码全 0；逐套项数与 TESTING.md 表格核对一致（verify-extensions 静态 check( 调用点 24 处但运行时 21 项，表格记运行时真值）
2026-09-03 14:22 | [Docs📝] 提交历史整理：基线 ee40eae 之后 83 条变更记录落成两个提交——860a1fe（源码 + 10 套验证脚本，47 files / +5039 / −349）与 54fd5d0（Log 六份文档同步，6 files / +865 / −11）；提交前补修 .gitignore 里漏改的注释（trace-log “hook” → “watcher”），并核实 staged 清单不含 Log/、不含临时 commit message 文件、不含 config/active-config.json 与 provider-keys.json 两个密钥文件
2026-09-03 13:13 | [Docs📝] GLOSSARY.md 新增 11 条观测层与扩展机制词条（CollectedSpan / EventBus / Extension / Hook / Span / SpanCollector / SpanRecorder / trace.jsonl / TTFT / turnId / Watcher），新建 T、W 两个字母节，词条总数 30 → 41；Hook 与 Watcher 两条专门写清“住在 hooks/ 目录 ≠ 用了 on”这个已被实际误读过的区分，Span 条写明段是嵌套的所以合计耗时不能相加，SpanRecorder 条写明 NOOP 不是跳过代码而是跳过打卡；本次只加不改既有条目，与新词条直接矛盾的 PromptEvent（计划中）用“本条取代下方…”指路而不是改写，避免文档处在半新半旧状态
2026-09-03 13:13 | [Docs📝] 查出三份“现状类”文档已系统性过期（不是缺观测层，是整份停在项目早期），本次未改、只在 ROADMAP 立项：ARCHITECTURE.md 的分层图仍写 (AnthropicProvider) [TODO] 与 ui.ts → 展示层 [TODO]（两者早已落地），Runtime 只画 prompt/session/llm 三格而实际注入 7+ 个子系统；TESTING.md 的“可测模块”列 Agent 类的 start()/stop()（项目里没有 Agent 类，Pi 模式循环在 main.ts），且完全没提 scripts/ 下 10 套 verify、299 项断言；GLOSSARY.md 有 3 条标“计划中”但已落地（PromptEvent / Mode 的 Rpc / Skill），2 条指向不存在的文件（src/runtime/session.ts、src/runtime/session.mock.ts，实际在 src/session/）。根因：append-only 的日志天生不会烂，会烂的是现状快照——目录.md 每轮都同步所以准，这三份没进这个习惯
2026-09-03 10:44 | [Refactor♻️] 抽出 SpanCollector 公共配对件：core/events.ts 加 CollectedSpan + SpanCollector 契约（与生产端的 SpanRecorder 对称：一个帮打卡、一个帮收段），实现落 runtime/span-collector.ts（配对规则从 trace-log 原样迁来，以便用回归全绿证明行为一字未变）；trace-log watcher 134 → 78 行，只剩开关判定 / 落盘格式 / 退出补记，并以 capacity:0 表示落盘型消费者不必在内存里再留一份历史
2026-09-03 10:44 | [Feature✨] /traces 内置命令（commands/builtin/traces.ts）：就地看最近段的耗时/成败/此刻在跑的是哪段，参数纯数字=条数、其他=段名关键字过滤；合计只算 prompt 段——段是嵌套的（prompt 包着 llm_request，llm_request 又包着 tool_call），把所有 durationMs 相加会把同一段时间重复计好几遍；开箱即用不需环境变量，数据经 runtime.getTraces()/getRunningSpans() 只读委托（与 /diagnostics 同一范式：Runtime 收集、命令只读展示）
2026-09-03 10:44 | [Feature✨] 装配：SpanCollectorImpl 建在 main.ts 的 createRuntime 闭包外、与 events 同生命周期（热切换重建 Runtime 时不丢已收的段），经 RuntimeOptions 必注入（与既有 7 个子系统一致，全项目只有 main.ts:94 一处真实构造）；watcher 与 /traces 各持独立实例——总线的意义就是消费者互不知情，且核心命令不能反过来依赖一个可选扩展
2026-09-03 10:44 | [Fix🐛] /traces 的关键字过滤漏掉了“正在跑”块（说只看 llm 却顺手带出一段没关门的 tool_call），根因是过滤只作用于已收束的段；修成一个 match 判定同时作用于两边，空态判定与提示语跟着改一致；verify-events 补 2 条断言钉住这条路径——原有的过滤断言用的是无正在跑段的收集器，所以当时测不到
2026-09-03 10:44 | [CI✅] 验证：tsc 零错误；verify-events ⑨ 段 21 项（含一条精确验证嵌套不重复计：手工喂 prompt 1000ms + 内嵌 llm_request 800ms，断言合计是 1.0s 而不是 1.8s）；全量 10 套 299/299（278 + 21）；RPC 真实链路实跑 /traces——对话前是空态提示，一轮真实对话后列出 prompt 1.3s + llm_request 1.3s（deepseek-v4-flash · 首字 1.2s · 2858 tok），list_commands 里自动出现 traces（证明 builtin 目录扫描生效）；临时预览脚本与它产生的会话文件验完即删
2026-09-03 10:44 | [Docs📝] 目录.md 同步七处（core/events.ts 契约描述、runtime 树加 span-collector、builtin 命令列表加 /traces、trace-log 描述改为“配对交给 SpanCollector”、verify-events 55 → 76 项、职责表 278 → 299 项、事件流图补两个 SpanCollector 实例）；ROADMAP 从“剩余（未立项）”里划掉 /traces 并补一条已完成条目；09-02 的历史条目按 append-only 一律未改写（仍写“trace-log hook”，那是当时的真实称呼），只改了已完成表格里那一行无日期的现状汇总（hook → watcher）
2026-09-03 09:52 | [CI✅] scripts/verify-extensions.ts 新增 21 项（探针法）：往三类扩展目录各临时放一个探针文件，探针把实际收到的 ctx 的键记到 globalThis，跑真实 loadExtensions 后断言键集合——类型在运行时被擦除，“watcher 拿不到 on”这条边界只能这样验；覆盖三类口子装载 / ctx 键恰好 / 边界的行为证据（不开开关时通配订阅表为空，零开销从注释变成实证）/ 走装载器路径的 trace-log 端到端落盘（verify-events 只测了手工注册那条路）/ 坏扩展抛异常不连坐同目录排在它后面的扩展 / 探针清理干净
2026-09-03 09:52 | [CI✅] 反向验证证明这套断言会咬人：故意把 WatcherModule 接口加上 on、调用处跟着递 on —— tsc 仍 0 错误（实证了“改声明 + 改调用处两行一起改，编译全过、没人报警”），而 verify-extensions 立刻红 3 条并打印实际键 [events,on]、EXIT=1；验完复原，全量 10 套 278/278 绿（257 + 21）、tsc 零错误，三个扩展目录无 __ 探针残留
2026-09-03 09:52 | [Docs📝] main.ts:77 补上漏改的注释（仍写“段落 + hook”→“段落 + hook + watcher”，上一轮改名时漏了这处）；目录.md 的 scripts 树加 verify-extensions、职责表 9 套 257 项 → 10 套 278 项；探针文件写在 src/ 下会被 tsc 扫描到（include src/**/*.ts），故探针内容必须能过类型检查且靠 finally 保证删除
2026-09-03 00:12 | [Refactor♻️] 扩展目录按“能不能改流程”拆开：trace-log 从 extensions/hooks/ 搬到 extensions/watchers/，导出名 registerHooks → registerWatchers；它用的是 ctx.events.subscribe（通配收全量事件、返回值没人收，只看只录），而非 ctx.on（返回值经 emitHook 收回、能改写流程），住在 hooks/ 里名不副实——实际已被误读为“trace 与钩子机制有关”
2026-09-03 00:12 | [Feature✨] extension-loader 开第三条装载口子（WatcherModule + 扫描 watchers/），ctx 只给 events、刻意不给 on——“旁观者改流程”在类型层面就不可能，不靠注释提醒也不靠使用自觉；core/extension.ts 补对称契约 WatcherRegistrationCtx；example-hook.ts 头注释加“该放 hooks/ 还是 watchers/”的判据指路
2026-09-03 00:12 | [CI✅] verify-events ⑧ 段改指新路径与新导出名，55/55 全绿证明落盘行为一字未变；另用临时脚本走真实 loadExtensions 补上装载验证（该项原本无任何断言覆盖：verify-events 是直接 import 模块手工注册，而搬家最大的风险点恰是“loader 还找不找得到”）——三条全绿：sections 装载 1 个 / watcher 自动装载并落盘 name=llm_request status=ok / hook 仍改写 before_request，验完即删；全量 9 套 257/257 + tsc 零错误
2026-09-03 00:12 | [Docs📝] 目录.md 现状同步（目录树三类口子及各自 ctx / 职责表 src/extensions/ 与 trace.jsonl 描述 / 事件流图订阅者名）；CHANGE_LOG 与 ARCHITECTURE_LOG 旧条目里的“trace-log hook”字样按 append-only 保持原样——那是当时的真实称呼与真实位置，改名只追加新条目、不回改历史

2026-09-02 19:42 | [Optimize⚡] 启动提速第二档·启动关键路径彻底断网（config/manager.ts）：删掉 getConfigManager() 里的 init()——它原先为每个有 key 的供应商并行拉 /models，而 check() 又 await 它，于是这批网络往返全压在界面渲染之前（实测冷连接 1998ms、连接池热时 278ms，网络差时每家最长卡 10s 超时，全程终端只有 banner 没有 UI）；换成 Promise.resolve(new ConfigManager()) 纯本地构造，实测 check() 全链路 760ms → 0.7ms
2026-09-02 19:42 | [Feature✨] 模型列表改后台预热 + 按需现拉（manager.ts 新增 warmModels/ensureModels/isModelsFresh，MODELS_FRESH_MS=5min）：main.ts 在界面渲染前 fire-and-forget 预热，结果只写内存里的 Provider；/model 二级选择器展开前 ensureModels——预热已完成则零等待（实测 0.0ms），还在飞则 await 同一个 promise。调研发现 getModels() 的 9 个调用点里只有二级选择器真需要远程列表（其余要么只是说明文字，要么静态列表就满足，连 getFallback 点名要的 deepseek-v4-flash 都在静态表里）
2026-09-02 19:42 | [Feature✨] Provider 加 modelsFetchedAt（llm/provider.ts）：只有真拿到远程列表（remote.length > 0）才盖新鲜戳——失败也盖戳的话，断网那一次会被误记成"列表已新鲜"，之后整个进程周期再也不重试，用户只能一直看静态列表；预热失败即静态兜底、不向界面抛（锦上添花不该变成报错）
2026-09-02 19:42 | [Feature✨] inflight 去重（manager.ts）：后台预热与用户手快开 /model 会同时打同一家，用 Map<id, Promise> 让第二个调用方复用在飞的那份而不是重发（否则明明另一份马上就回来，自己还得再等一遍）；refreshModels(id)（输入新 key 后调）走同一个入口但无视新鲜期——新 key 可能解锁不同模型
2026-09-02 19:42 | [Docs📝] 就地注明两处取舍免得后人当 bug：①/model 一级列表的"N 个模型可用"在预热完成前显示静态数（13 而非 33），只影响这行说明文字；②warmModels 只在 TTY 下发起——非 TTY 时选择器直接返回第一项、列表根本不会被展示，且管道模式跑完就退，在飞的 fetch 反会把进程拖到超时才结束；check.ts/main.ts 的"第一档"注释同步成两档
2026-09-02 19:42 | [CI✅] scripts/verify-startup.ts 新增 32 项：临时配置造三家供应商（有 key / 没 key / 坏地址）+ 假服务器按路径计数 + fetch 探针（getConfigManager 读的是仓库真实 providers.json，baseUrl 指向真互联网，光数假服务器证明不了它没联网）；覆盖启动 0 fetch/只拉有 key 的/远程并入与盖戳/失败与 200 空列表都不盖戳/新鲜期内不重发与过期重拉/并发去重只发一次/refreshModels 无视新鲜期；全量回归 9 套 A/B 13 + C1 8 + C2 16 + C3 17 + input 22 + ui 72 + events 55 + usage 22 + startup 32 = 257/257 绿，tsc 零错误
2026-09-02 19:42 | [CI✅] 复测启动阻塞：UI 出现前的全部阻塞 check() 0.7ms、new ConfigManager() 0.6ms（读 3 个本地文件）；被移到后台的两项各花 warmModels 1041ms（3 家并行，opencode-go 33 个模型 / deepseek 4 个）+ probeStartup 285ms，用户开 /model 时新鲜期内 0.0ms、过期现拉一家 552ms
2026-09-02 19:09 | [Feature✨] L3 打通流式真实 usage·OpenAI 兼容路径（stream-helper.ts）：请求体加 stream_options.include_usage 显式索取（该协议默认不在流式响应里给用量），解析 [DONE] 之前那个 choices=[] 的专用 chunk → 随 end 事件交出；total_tokens 缺省时自加（部分代理端只给前两个）
2026-09-02 19:09 | [Feature✨] L3 打通流式真实 usage·Anthropic 路径（anthropic.ts）：message_start 取输入、message_delta 取输出（协议给的是累计值，覆盖而非累加）、total 自加；promptTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens——本项目在 system 分层与 tools 上都设了 cache_control 断点，命中时 input_tokens 只剩个位数（它只统计本次新读的非缓存部分），只填它等于伪报"这次几乎没发输入"
2026-09-02 19:09 | [Feature✨] 索取用量的兼容保护（stream-helper.ts）：stream_options 撞上 400 且错误文本含该参数名 → 进程级开关永久关闭 + 同一次调用内静默重试一次（用户看不到失败，只是 usage 继续为 null）；与该参数无关的 400 原样抛出，不误吞密钥无效/余额不足这类真错误
2026-09-02 19:09 | [Feature✨] AgentLoopResult 契约扩出 usage 字段（core/loop.ts）：各轮真值逐轮相加，任一轮缺失即整体报 null——少报的"真值"比估算值更误导（消费端分不清"这就是全部"与"只是其中几轮"）；agent-loop.ts 删掉本地重复定义，用量经 trace 回调返回值上送进 llm_request_end 载荷（TS 的控制流不追踪闭包内赋值，写成回调内改外层 let 会被锁死成初始的 null，为此连撞两轮 never 报错）；runtime.ts 改 usage ?? estimateTokenUsage，真值优先、缺失才回退，消费端一行未改
2026-09-02 19:09 | [CI✅] scripts/verify-usage.ts 新增 22 项：一台假服务器按 URL 分流演两种协议 + 队列回放预制 SSE，覆盖索取参数/末尾 chunk 解析/total 自加/无用量不带键/缓存三项相加/累计值覆盖不累加/多轮合计/一轮缺失整体 null/usage 进 llm_request_end/400 降级与其边界（降级会永久关掉进程级开关，断言顺序必须把它排最后，否则前面的用量断言全成假绿）；全量回归 A/B 13 + C1 8 + C2 16 + C3 17 + input 22 + ui 72 + events 55 + usage 22 = 225/225 绿，tsc 零错误
2026-09-02 19:09 | [CI✅] 真 LLM 管道实测 usage 从 null 变真值：带 TS_AGENT_TRACE=1 跑 rpc-smoke（2.9s，exit 0），llm_request 落 usage={promptTokens:2834, completionTokens:71, totalTokens:2905}，prompt 段 totalUsage 同值（说明 Runtime 吃的是 API 真值而非估算）；对照改造前同一条冒烟的估算值 {26,23,49}——估算只算 user 输入 + 最终回复，system prompt 与 5 个工具描述全没算，输入侧少报约 109 倍
2026-09-02 19:09 | [Docs📝] runtime/events.ts 的 LLMRequestEndEvent.usage 注释同步（原文"两个 Provider 都还没填这个槽"已过期，改成两条协议各自的取法与 null 的语义），顺带修一处错别字（"逆逼真报 0"→"逼出伪报的 0"）
2026-09-02 16:26 | [Feature✨] 可观测性增强·事件语义层（ROADMAP P6 立项落地）：总线 emit() 统一盖 at/seq/turnId 公共头（盖戳只放总线这一处：46 个 catch、39 处 console 散落各文件，靠自觉必然漏，而总线是唯一必经之路）+ beginTurn() 换发分组 ID（Runtime.prompt 入口调，isStreaming 时不换发——排队中的输入不能掀翻在飞回合的分组）；类型分成 RuntimeEventIn（生产端草稿）与 RuntimeEvent（消费端完整事件 = 草稿 & EventMeta），生产端只管说"发生了什么"，时间戳/序号归总线
2026-09-02 16:26 | [Feature✨] 打卡机 SpanRecorder（core/events.ts 契约 + runtime/events.ts 实现）：trace() 包住异步段自动配对进门出门（try/finally 结构保证，抛异常、提前 return、continue 都漏不掉）、beginSpan() 手动版供跨 finally 的场景；Span 句柄 set/end/fail + spanId 配对（消费端靠它配对，不靠段名猜）+ closed 防重复打卡；NOOP_SPAN_RECORDER 与 spanRecorderOf() 让测试替身（noopEvents）和未接观测的旧总线不必判空，业务代码不为"有没有观测"写两套分支
2026-09-02 16:26 | [Feature✨] 路A 四组强类型骨架 span 覆盖三重循环：prompt（外层 while，runtime.ts）/ llm_request（中层 for turn，含 TTFT 首字延迟、真实 usage 槽位、empty 空流状态）/ tool_call（内层 for tc，权限弹窗的等人时刻意排除在段外）/ compaction（旁支摘要调用，十几秒的黑箱首次可量）；SpanContracts 段名→载荷契约，写错段名或字段编译不过；过去一次带 3 个工具的 prompt 实际发生 4 次 LLM 往返，对外却一个边界事件都没有
2026-09-02 16:26 | [Feature✨] 路B 便签通道 note_start/note_end：事件类型固定、段名降级成 name 字段、载荷是自由字典——扩展 hook 里想圈什么就圈什么，核心类型零改动（骨架管"系统必须观测的四处"，便签管"临时想看的任意一处"；代价是编译器不查字段名，换来加观测点不必回头改核心）
2026-09-02 16:26 | [Feature✨] trace-log hook（src/extensions/hooks/，TS_AGENT_TRACE=1 开、TS_AGENT_TRACE_FILE 改路径）：把成对 span 落成"一行一段完整行为"的 JSONL（name/spanId/turnId/startedAt/durationMs/status/input/output 齐全），进程退出时仍未关门的段补记 status='unclosed'（这类漏关门过去是静默的，消费者永远以为它还在跑）；只认带 spanId 的事件，tool_execution_* 这类 UI 事件不参与配对；写成 hook 而非核心代码——换 LangSmith/LangFuse 只是本目录再放一个文件
2026-09-02 16:26 | [Fix🐛] tool_execution_end 在工具抛异常时漏发（配对永久断裂）：catch 分支只记诊断不发事件，任何按 start/end 计数的消费者会永远认为该工具还在执行（UI 卡在下边框不画，与"工具期黑屏"同源）；改为成功/软失败/异常/用户拒绝四条路径统一发射，并新增 ok 字段由生产端直说成败
2026-09-02 16:26 | [Fix🐛] TreeUI 工具框判色靠子串猜测（includes('✅')/includes('失败')/includes('[ERROR]')）：工具正常输出里出现"失败"二字即被误判红框、含 [OK] 的真失败被判绿；改吃 ok 字段，三行猜测删除
2026-09-02 16:26 | [Fix🐛] setLLM 热切换后 AgentLoop 仍持构造期注入的旧 Provider：抽出 buildAgentLoop() 并在 setLLM 里重建（否则兜底切换形同虚设——用户点了"切换到兜底模型"，下一轮仍打向刚刚失败的那只）；模型名改为 run() 按次下发（AgentLoopOptions.model）而非构造期快照（构造快照会在 /model 与兜底切换后永久陈旧，把耗时归到错误的模型头上）
2026-09-02 16:26 | [Optimize⚡] TreeUI 实测账上屏：prompt_end 结算"⏱ 全程 Xs · 模型 N 次/Ys · 首字 Zs"（首字延迟只取本回合第一次调用的，那才是用户真正等的第一下）；与原有四个秒表字段共存各管一段——本地定时器量的是"用户感知的等待"、要靠动画逐秒跳（事件给不了），span 量的是"一次请求到底花了多久"、只能在段收束那一刻结算
2026-09-02 16:26 | [CI✅] scripts/verify-events.ts 新增 55 项 + verify-ui.ts 增至 72 项（+6 span 消费断言）：盖戳/配对守恒/spanId 全局唯一/seq 同回合无跳号/无孤儿 end/TTFT≤段耗时/工具轮 TTFT 为 null 而非 0/异常段不伪报 resultLength/便签通道/compaction 段/hook 端到端落盘；全量回归 A/B 13 + C1 8 + C2 16 + C3 17 + input 22 + ui 72 + events 55 = 203/203 绿，tsc 零错误，RPC 真 LLM 冒烟 exit 0（2.0s）；带 TS_AGENT_TRACE=1 真跑一次管道实测落 2 段（llm_request 1688ms/首字 1365ms/usage=null——Provider 尚未填槽，不伪报 0；prompt 1692ms/turns=1）
2026-09-02 16:26 | [Config⚙️] .gitignore 加 trace.jsonl / trace-*.jsonl（观测落盘含对话正文片段，属运行时产物，不随仓库共享）
2026-09-02 12:33 | [Feature✨] TreeUI 消息框随终端自适应加宽（用户反馈"每行能写的文本有点少，窄窄的不好看"）：BOX_WIDTH 写死 50 改为 boxWidth() 夹逼 50~110（cols-4，极窄终端不撑破屏幕），80 列终端下框内文本宽 45→71 列；四处建框（流式/完整/用户/工具）与 header 分隔线统一取宽，工具框顶底边跨事件存 toolBoxWidth 保证同宽，窗口变化后新建的框自动跟随
2026-09-02 12:33 | [Feature✨] TreeUI 回合级进度指示器（用户反馈"回复中途长时间等待没有任何提示，直到完全给出全部回复后上面的 UI 才会加上"）：指示器从按下 Enter 即点亮、到 agent_end 才撤，位置随阶段迁移——等待期挂底部状态行（⏳已发送/🧠推理中/🔧执行工具/⏳等待响应 + 实时秒数 + 安抚文案），首字到达后移交回复框的开口底边"⠋ 正在输出… N 秒 · 已收 X 字"，输出完毕才整行换成 └──┘（sealLiveBox 就地封口：顶边框与正文原地不动，消除旧实现 removeLiveBox+重建带来的整框跳变）；顺手堵住两个历史黑屏窗口（agent-loop 内部不发 thinking 事件 → 工具执行期、工具结束到下一次 LLM 首字之间原本全程无提示）；steering/followUp 插入新回合时先封口再回到等待指示，不让开口底边谎报"正在输出"
2026-09-02 12:33 | [Fix🐛] 制表画框字符被当全角测宽→边框静默截断：fit-width 旧规则 charCode>0xff 即 2 列，但 ─│┌┐└┘═↑↓❯⠋ 属 East Asian Ambiguous、等宽西文字体一律画成 1 列，于是 76 字边框被测成 140 列 → Text.render 的 fitWidth(79) 砍到 45 字，右侧 ┐ ┘ 整段丢失（真机 debug-screen.log 里 newLine宽度=78 就是 48 字 ━ 分隔线被砍到 39 字的痕迹；Screen 的行宽告警排在截断之后，结构上永远报不出来）；改为显式 NARROW_NON_ASCII 区段表，其余非 ASCII（汉字/全角标点/— … “”/emoji）仍按 2 列：宁可少写几列，也不能让行超宽触发终端软换行、打乱差分渲染"一逻辑行=一终端行"的记账
2026-09-02 12:33 | [Fix🐛] wrapText 按 UTF-16 code unit 切字符会劈开 emoji 代理对：tokenize 改用 codePointAt 按码点推进，既修正 emoji 测宽翻倍（4 列→2 列），也避免折行点落在代理对中间而在屏幕上渲染成乱码方块
2026-09-02 12:33 | [CI✅] scripts/verify-ui.ts 新增 66 项（回填：原条目记为 60 项，交付时实为 66 项）：框宽夹逼（80→76 / 200→110 / 40 不超屏 / 300 字折行字数守恒）、等待期与流式期指示器、就地封口顶边框前后完全一致、工具轮不黑屏、宽度测量与代理对完整性；全量回归 A/B 13 + C1 8 + C2 16 + C3 17 + input 22 = 76/76 绿，tsc 零错误，管道模式（/help）冒烟边框完整且 exit 0
2026-09-02 10:46 | [Fix🐛] 多行粘贴提问被静默吞掉修复：旧 InputHandler 把任何含 \r\n 的 chunk 整块当 Enter 提交且丢弃块内文本（粘贴多行复杂问题→空 buffer 提交 no-op，无回复无反馈）；重写为逐段解析状态机 + 启用括号粘贴（mode 2004，粘贴内容换行转空格入 buffer 等 Enter 明确提交），降级路径文本永不丢弃、仅 chunk 以换行结尾才提交，焦点事件丢弃、转义序列只消费自身；handleData try/catch 包裹防怪异字节杀进程；新增 verify-input 专项 22 项（含用户现场复刻），全量回归 76/76 绿
2026-09-02 10:46 | [Optimize⚡] 启动提速第二波：ts-agent-run.bat 从 npx tsx 改为 node 直连 node_modules/tsx/dist/cli.mjs（实测 Windows 上 npx 解析开销 ~1.1s：2.4s→1.43s）+ 启动即时 echo 反馈 + node_modules 缺失友好报错；代码层面核实第一档（探测后台化）已在位，剩余启动耗时为 wt 窗口 + tsx 转译冷启动（第三档预编译已入 ROADMAP）

2026-09-01 20:49 | [Feature✨] TreeUI 思考期动态安抚 + 计时：等待状态行升级为"旋转帧 + 阶段标签 + 实时秒数 + 每 3 秒轮换安抚文案"（250ms 动画跳）；思考计时器支持工具轮多段累加，正文到达结算，💭摘要展示"思考了 N 字 · 用时 X 秒"；无推理但等待≥3秒也显示"⏳ 用时 X 秒"；退出/异常路径定时器均有清理防泄漏；回归 54/54 绿 + tsc 零错误
2026-09-01 20:37 | [Optimize⚡] 启动提速第一档·网络探测后台化（补记：原条目在 CHANGE_LOG 锚点覆盖事故中丢失，git 与全部会话记录均无法找回原文，此处据 check.ts 现存注释与 ROADMAP P6 交叉引用复原）：check() 只做本地检查即刻返回，/models 的真实网络往返（启动大头）改由 main.ts 后台发起 probeStartup，结果经 check_done 事件回填 banner（界面先行、检查后台化）
2026-09-01 20:13 | [Optimize⚡] 启动提速 + 等待可视化：check 阶段原先对同一 /models 端点串行两次请求（连通性探测+列表拉取）合并为单次带 key 探测（probeStartup，失败分档语义不变）；TreeUI 新增等待状态行（消费既有 thinking 阶段事件：分析中/压缩历史/等待响应/执行工具/推理中，首片正文到达自动撤，此前该事件只有 TerminalUI 消费）
2026-09-01 20:13 | [Feature✨] TreeUI 渐进流式渲染：回复从"攒完整再画框"改为流式半成品框（首片懒创建顶边框→80ms 节流逐行推进→agent_end 替换完整框），工具事件打断时封底防孤儿框且同轮内容不重复；用户反馈"回复不流式"经 git 查证为既有设计而非 C 阶段回归
2026-08-31 18:26 | [Fix🐛] start.bat 双击闪退修复：双重根因——①旧脚本把 .bat 路径直接传给 wt.exe（CreateProcess 不认 .bat，新标签页启动即崩），改为 wt.exe -- cmd.exe /k 包裹（失败也留窗显示错误）；②上次修复时写入的中文注释遇 bat 编码问题被 cmd 解析成乱码命令（实测抓到 'nning 报错），改回纯 ASCII 注释；回归实测启动链路无报错
2026-08-31 18:11 | [Feature✨] 阶段C3（问题3）多轮回放数据模型：types.ts 新增 ThinkingBlock（推理文本+signature）、LLMMessage.thinkingBlocks（仅内存消息链，会话存储不碰）、thinking_block 流事件
2026-08-31 18:11 | [Feature✨] anthropic.ts 收集管+回放管：thinking_delta 展示兼累积、signature_delta 只累积，content_block_stop 拼装推 thinking_block 事件；toAnthropicMessages 把块原样置回 assistant content 最前（验章防篡改）
2026-08-31 18:11 | [Feature✨] 安全阀精确化：从"有 assistant 历史就关"改为"带 tool_calls 但无 thinkingBlocks 才关"——纯文本历史与带块历史都不拦截开启；agent-loop 挂载管：按轮收集块、随工具轮 assistant 消息挂回（条件展开兼容 exactOptionalPropertyTypes）
2026-08-31 18:11 | [CI✅] verify-c3.ts 扩充至 17 项：真实 AgentLoop 驱动两轮回放端到端（收集→挂载→回放，断言块/签名/位置原样）；回归 A/B 13 + C1 8 + C2 16 全绿；tsc 零错误（顺手修 TS6196 未使用导入，改为显式标注 ThinkingBlock）

2026-08-30 11:23 | [Feature✨] 阶段C3（问题1+2）Anthropic thinking 参数消费：anthropic.ts 的 chat/stream 消费 opts 判定（复用 stream-helper 导出的 resolveThinkingEnabled，两条供应商路径同一优先级逻辑），按 Anthropic 形状下发 thinking:{type:'enabled',budget_tokens}（budget 2048 严格小于 max_tokens 4096）
2026-08-30 11:23 | [Feature✨] Anthropic thinking 流解析：thinking_delta 分片 → 复用 C1 的 reasoning 展示事件（不进 fullText，展示不持久；两套 UI 零改动直接生效）
2026-08-30 11:23 | [Fix🐛] Anthropic 临时安全阀：历史含 assistant 消息时强制不开 thinking——回放上一轮 thinking 块（带 signature）的能力未落地（C3 问题3），多轮开启会 400，先用安全阀兜住（问题3 落地后移除）
2026-08-30 11:23 | [CI✅] scripts/verify-c3.ts：假 Anthropic 服务器（chat JSON + 预制 thinking/text 双块 SSE）验证参数消费/安全阀/覆盖优先级/配置兜底/推理分流 8 项全绿；A/B 13/13、C1 8/8、C2 16/16 回归；tsc 零错误
2026-08-30 11:09 | [Feature✨] 阶段C2 thinking auto 判定：Runtime 按三态模式判定（on 常开/off 常关/auto 仅当 TASK.md 有未勾选项时开），结果按次下发 Agent Loop → provider（按次覆盖优先级高于配置）
2026-08-30 11:09 | [Feature✨] TASK.md 工程侧清理：清单全勾选时 loadTaskMemory 读时删除（不依赖模型自觉），遗留已完成计划不再放大轮数预算/触发 auto thinking/续传提示（用户拍板方案：清理放工程侧）
2026-08-30 11:09 | [Refactor♻️] 复选框检测 hasUncheckedTask 抽出共享导出（提示词层续传判定与工程侧清理同一标准，单一真相源）；LLMProvider.chat/stream 加按次选项（Anthropic 仅对齐签名，C3 再消费）；删除成壳的 readTaskMemory 实例方法（tsc 零错误回归）
2026-08-30 11:09 | [CI✅] scripts/verify-c2.ts：判定下发/覆盖优先级/复选框检测/清理语义 16 项全绿；阶段 A/B 回归 13/13、C1 回归 8/8；tsc 零错误（修 ESM 下误用 require 一处）
2026-08-30 10:38 | [Feature✨] 阶段C1 thinking 开关：active-config 新增 thinking 键（auto|on|off）；stream-helper 两处写死 disabled 改按配置求值（auto/缺省在 C1 按关闭处理，C2 由 Runtime 判定）
2026-08-30 10:38 | [Feature✨] 思维链流解析：delta.reasoning_content → 新增 reasoning 流事件（不进 fullText/会话历史，展示不持久）；agent-loop 透传为 stream_reasoning 事件
2026-08-30 10:38 | [Feature✨] 推理展示：TerminalUI 首片切 spinner 为"推理中"；TreeUI 只累计字数，收尾摘要"💭 思考了 N 字"（不倾倒推理全文）
2026-08-30 10:38 | [Config⚙️] LLMConfig 新增 thinking 可选字段（config/manager 透传）；active-config.json 与 example 加 thinking: auto；runtime/events 新增 StreamReasoningEvent
2026-08-30 10:38 | [CI✅] scripts/verify-c1.ts：本地假 OpenAI 兼容 SSE 服务器验证三态+缺省请求参数、reasoning/正文分流、非流式共 8 项全绿；阶段 A/B 回归 13/13；tsc 零错误；修 Windows server.close 后立即 exit 的 libuv 断言（延迟退出）
2026-08-30 10:28 | [Config⚙️] 更换 opencode-go API key（原 key 余额不足 401）；真实链路冒烟重跑通过（create→switch→chat 串行喂料，2.8s 真实响应，临时会话已清理）
2026-08-30 10:19 | [Feature✨] 阶段B 计划驱动循环：core-section 规划步升级为"复杂任务必须把复选框(- [ ])清单写入 TASK.md"；task 层检测未勾选项追加 [续传提示]（从第一个未勾选项继续）
2026-08-30 10:19 | [Fix🐛] 空流区分：流被异常中断（余额不足/密钥无效）不再误报"达到最大轮数"，改空内容提示 + warn:llm 诊断（finishedEarly 标记区分退出原因）
2026-08-30 10:19 | [Fix🐛] provider 静默错误暴露：SSEStream/AnthropicStream 的 catch 打印真实错误（原吞错只剩空流；冒烟实测 401 CreditsError 发现）
2026-08-30 10:19 | [CI✅] 新增 scripts/verify-phase-ab.ts（脚本化假 LLM 验证 A1/A2/A3/B1 共 13 项全绿）+ scripts/rpc-smoke.mjs（RPC 串行冒烟喂料器，等上一条响应再发下一条）
2026-08-30 10:19 | [Config⚙️] .qoder/settings.local.json 启用 auto 权限模式（含密钥配置 soft_deny）；gitignore 覆盖 .qoder/.claude 本机个人配置
2026-08-30 10:00 | [Feature✨] Agent Loop 重复失败保护：同一调用（工具名+规范化参数）连续失败 2 次追加换策略提示、3+ 次追加弃路径提示；硬失败才计（[ERROR]/[VERIFY_FAILED]/异常），NOT_FOUND/NO_MATCH 有效否定与用户拒绝不计；提示追加进工具结果不新增消息（避 Anthropic 交替约束 400）
2026-08-30 10:00 | [Feature✨] Agent Loop 轮数耗尽优雅收尾：最后一轮前注入收尾提示（写进度入 TASK.md + 返回总结）；耗尽兜底从"抛最后一条原始消息"改回溯最后 assistant 进展说明 + warn 诊断；maxTurns 可按次传入（有 TASK.md 时 5→15）
2026-08-30 10:00 | [Feature✨] core-section 铁律新增两条：收尾必验证（写/改代码必跑测试/编译，无测试入口至少语法检查）+ 断点纪律（收到轮次耗尽提示必写 TASK.md 并如实汇报）
2026-08-30 10:00 | [Config⚙️] core/loop.ts 接口新增 AgentLoopOptions（maxTurns 可选参数），run 签名扩展保持向后兼容
2026-08-28 19:18 | [Feature✨] 工作记忆层：TASK.md 独立持久通道（压缩不触碰），分层 system 新增 task 层（skills 后 summary 前），runtime 每次请求注入
2026-08-28 19:18 | [Refactor♻️] SystemPromptContext 新增 task 字段 + SystemPromptLayer 新增 task 层；core-section 新增【工作记忆】引导（复杂任务维护 TASK.md）
2026-08-28 18:25 | [Feature✨] 新增 ls 工具（递归列目录，跳过噪音，统一状态码格式）——工具增强推理的"看清结构再动手"入口
2026-08-28 18:25 | [Optimize⚡] core-section 升级为任务方法论：场景判断 + 执行流程（先理解→规划→分步→验证→总结）+ 工具增强推理引导（不确定就查/算不清就跑）
2026-08-28 17:56 | [Docs📝] 新增 Log/ARCHITECTURE_LOG_RULES.md（架构日志格式规则书）+ CLAUDE.md 文档同步规则纳入架构日志自动追加（项目 + 元数据仓库同步）
2026-08-28 16:47 | [Docs📝] ARCHITECTURE_LOG 补录 8 个历史架构演进主题（系统提示词子系统/多系统分离/配置重构/function calling/UI 组件树/协议路由/工具系统/结构分层）
2026-08-28 16:40 | [Docs📝] 新增 Log/ARCHITECTURE_LOG.md（架构演进日志：重构/改良逐块记录，含问题/改动/解决/可优化 + 首条缓存优化记录）
2026-08-28 15:21 | [Optimize⚡] Anthropic 提示词缓存断点：system 分层稳定段（core/tools/skills）手动加 cache_control，摘要段不设；tools 参数末工具设断点（共 4 个，达官方推荐上限）
2026-08-28 15:21 | [Fix🐛] Anthropic 接入修正：system 分层消息改文本块数组（不再互相覆盖）；tools 参数改 name+input_schema 格式（原 OpenAI 格式会 400）；连续 tool_result 合并进单条 user 消息（符合交替约束）；is_error 按 [工具 前缀判断
2026-08-28 15:11 | [Optimize⚡] 提示词缓存优化：SystemPromptService 分层返回（core→tools→skills→summary 独立 system 消息，稳定前缀在前）
2026-08-28 15:11 | [Refactor♻️] CompactionService 摘要独立返回（{history, summary}），不再 unshift 进历史污染缓存前缀；runtime 拼装分层消息
2026-08-28 15:11 | [Config⚙️] SystemPromptConfig 段落分组（core/tools/skills 三层）；用户扩展段落并入 core 稳定层；before_request hook 改改写消息数组
2026-08-15 16:22 | [Feature✨] 扩展系统（层次3）：自动装载 extensions/ 段落+hook 扩展，用户 export 注册函数即生效
2026-08-15 16:22 | [Feature✨] core/extension.ts 接口（SectionRegistrationCtx/HookRegistrationCtx）+ extension-loader + 示例扩展
2026-08-15 15:15 | [Refactor♻️] 补漏接口：SystemPromptService 建 core 接口 + 实现改 Impl；PermissionManager implements PermissionProvider
2026-08-15 14:59 | [Refactor♻️] EventBus 泛型化（EventBus<T>，默认 unknown）；PromptEventEmitter implements EventBus<RuntimeEvent>
2026-08-15 00:30 | [Feature✨] 系统提示词子系统：SystemPromptService（配置驱动 + 动态计算 + hook 改写复用 EventBus）
2026-08-15 00:30 | [Feature✨] 段落可插拔：core/tools/skills 三段落（用户 TS 模块扩展）+ 兜底提示词
2026-08-15 00:30 | [Refactor♻️] emitHook 开放 public；Runtime 硬编码系统提示词替换为 SystemPromptService.build
2026-08-14 15:47 | [Docs📝] ROADMAP 新增 P7 业务能力强化：系统提示词强化/精准编辑工具/测试验证闭环/实用工具补全
2026-08-14 15:29 | [Docs📝] ROADMAP 新增 P6 成熟度补齐（对标 Cline/Pi）：测试套件/提示词模板/分支摘要/Hook/会话仓库等 8 项
2026-08-14 14:54 | [Refactor♻️] runReplMode 不再重复传 runtime 已知信息：main 只传 diagnostics，ReplInfo 由 repl.ts 基于 runtime 组装
2026-08-13 20:25 | [Refactor♻️] 命名规范统一：执行类接口改 Service（CompactionService/AgentLoopService/CommandService/DiagnosticsService），实现改 Impl
2026-08-13 20:25 | [Refactor♻️] 命令实现迁到 commands/builtin/，loader 迁 commands/loader.ts，edit_model → edit-model
2026-08-13 20:25 | [Refactor♻️] io/ui/permission.ts → permission-prompt.ts（避免与 permission/ 重名）；commands-handle → input-handler-demo
2026-08-13 20:25 | [Refactor♻️] 删除 TODO 空壳 persistence.ts / error-log.ts
2026-08-13 17:55 | [Refactor♻️] Compaction 独立：抽 CompactionStore 接口（压缩存储 4 方法），jsonl 双实现，InMemory/Mock 明确不支持
2026-08-13 17:55 | [Refactor♻️] compaction 从 SessionStorage 可选成员改依赖 CompactionStore；SessionStorage 去 4 个压缩方法
2026-08-13 17:55 | [Refactor♻️] main 组装 compaction（instanceof 判断 session 是否支持压缩）注入 Runtime，Runtime 不再内部 new
2026-08-13 16:11 | [Refactor♻️] 多系统全对称：core/ 补 4 接口（compaction/loop/commands/diagnostics），8 子系统全部 implements core 接口
2026-08-13 16:11 | [Refactor♻️] 迁移 PermissionManager 到 permission/manager.ts（修实现错位）；events 保留 runtime（类型+实现一体，评估后接受）
2026-08-13 16:11 | [Refactor♻️] Runtime 字段改接口类型持有（compaction/agentLoop/commandSystem/diagnosticsService）
2026-08-13 15:13 | [Refactor♻️] 新建 commands/ 命令子系统（CommandSystem：register/list/execute）+ diagnostics/ 诊断子系统（DiagnosticsService）
2026-08-13 15:13 | [Refactor♻️] Runtime 命令/诊断委托给子系统，prompt 简化；main 注入 commandSystem/diagnosticsService
2026-08-13 14:40 | [Refactor♻️] main 注册能力用本地 tools 变量（不绕 runtime.tools），命令/工具/输入处理时序统一为构造后
2026-08-12 17:07 | [Refactor♻️] 子系统全部必注入：RuntimeOptions tools/permission/skills/events/llm/session 必填，Runtime 无默认值
2026-08-12 17:07 | [Refactor♻️] main.ts 显式组装所有子系统（ToolRegistry/PermissionManager/SkillLoader/PromptEventEmitter）注入 Runtime
2026-08-12 16:07 | [Docs📝] 完整同步：目录.md 更新职责表+调用关系（反映 P5 子系统结构），核对 CHANGE_LOG 与 commit 无遗漏
2026-08-12 15:54 | [Refactor♻️] P5 多系统分离：新建 core/（接口层）+ session/（存储）+ tools/（工具）+ context/（压缩）+ loop/（Agent Loop）
2026-08-12 15:54 | [Refactor♻️] Runtime 构造注入所有子系统（不再 new），prompt 只剩编排；修复 instanceof 抽象破坏
2026-08-12 14:15 | [Refactor♻️] REPL 从 main.ts 抽离为 harness/repl.ts（与 rpc.ts 对称），main 只做组装+分发
2026-08-12 14:00 | [Feature✨] RPC 模式（P3）：JSON-RPC 2.0 over stdin/stdout，chat/ping/list_commands/get_diagnostics/list_sessions/switch_session/create_session/clear/get_session_info
2026-08-12 14:00 | [Config⚙️] RPC 模式跳过 initTerminal（readline 干扰管道 stdin）+ check 跳过耗时网络检查，快速启动
2026-08-12 14:00 | [Docs📝] RPC 流式（Pi 式 text_delta 通知）留 TODO
2026-08-12 12:54 | [Fix🐛] 启动自检诊断信息更详细：所有检查项标注具体供应商名（如"供应商「test」无法连接..."）
2026-08-07 20:34 | [Fix🐛] 创建自定义供应商后不再自动激活/切换（保持当前供应商不变，用户可 /model 手动选）
2026-08-07 20:34 | [Fix🐛] 启动自检 banner 显示全部诊断项（含 pass ✅，不再只显示 warn/fail）
2026-08-07 20:12 | [Fix🐛] 表单输入回显：TTY 下 readLineTTY 在 `> ` 提示符后实时回显输入内容，提交打印完整行
2026-08-07 20:12 | [Feature✨] 协议选择器选完后打印确认（如"协议类型: OpenAI 兼容协议"）
2026-08-07 19:59 | [Fix🐛] 表单输入污染根治：TTY 下表单走 InputHandler.readLineTTY，绕过 readline 的 lineBuffer 残留
2026-08-07 19:59 | [Fix🐛] 清理 providers.json 残留的坏 custom 供应商（被污染写入的 custom-vcq6k）
2026-08-07 19:26 | [Fix🐛] 选择器防竞态：激活前清残留转义缓冲（getConfigManager init 耗时期间按键不再误触发选择器）
2026-08-07 18:49 | [Feature✨] 新增 /edit_model 命令（修改已有供应商配置）+ 抽 promptProviderForm 公共表单
2026-08-07 18:49 | [Feature✨] 自定义供应商注册后远程拉取模型列表（失败/不兼容自动兜底静态模型）
2026-08-07 18:49 | [Feature✨] SelectList 增强：分组显示（group header）+ 搜索过滤（input）+ 多选（Space 勾选）
2026-08-07 18:08 | [Fix🐛] /model 自定义供应商的"协议类型"从手输改选择器（↑↓ 选 openai/anthropic，避免打错）
2026-08-07 17:59 | [Refactor♻️] 协议层抽象：Provider 对象集合（数据+行为自包含）+ ProviderRegistry + createProviderFromConfig
2026-08-07 17:59 | [Feature✨] /model 加"自定义供应商"入口：填 baseUrl+type+key+模型，运行时注册 + 持久化到 providers.json
2026-08-07 17:59 | [Refactor♻️] createProvider 去 switch（两协议直接判断）；config/manager 存 Provider 对象而非数据
2026-08-07 00:34 | [Docs📝] config/manager 顶部注释加 TODO：不同存在域的配置设置（供应商定义/baseUrl 也支持分层）
2026-08-06 20:17 | [Refactor♻️] 配置系统重构：删 provider-registry，新建 config/manager（配置分层 + 供应商管理）
2026-08-06 20:17 | [Refactor♻️] 命令合并：/provider + /model → 单一 /model（一级供应商、二级模型）
2026-08-06 20:17 | [Feature✨] 配置分层：环境变量 > 全局 ~/.ts-agent > 项目 keys > 项目 active；active-config 不再含 apiKey
2026-08-06 20:17 | [Config⚙️] 新增 config/global-config.example.json（全局配置模板）
2026-08-06 17:37 | [Feature✨] 错误日志与诊断（可靠性工程）：ErrorEvent 结构化（level/item）+ runtime 诊断队列 + getDiagnostics
2026-08-06 17:37 | [Feature✨] 诊断落盘 debug-runtime.log（TS_AGENT_DEBUG_DIAG 开关）+ 新增 /diagnostics 命令查看历史
2026-08-06 17:37 | [Fix🐛] 上下文压缩的 jsonlSession 从 cast 改为 instanceof 判断，InMemory/Mock session 不再崩溃
2026-08-06 17:03 | [Feature✨] 启动自检增强（可靠性工程）：Diagnostic 公共类型 + check 逐项检查（配置/API key/连通性/模型列表）+ 严重度分级
2026-08-06 17:03 | [Feature✨] Harness 发射 check_start/check_done 事件；CheckFailureError 配置坏时红字诊断优雅退出
2026-08-06 17:03 | [Docs📝] ROADMAP P4 命名"生产化"→"可靠性工程"
2026-08-06 16:42 | [Docs📝] ROADMAP 更新：P1-P3 已完成项打勾，新增 P5 架构演进（多系统拆分）

2026-08-05 20:26 | [Fix🐛] 输入按 Enter 翻行（根治）：Windows 一次 Enter 发 7 个 \r，空 buffer 的 \r 不再触发渲染/提交
2026-08-05 18:47 | [Fix🐛] 输入按 Enter 翻行：Windows raw mode 下 \r\n 整块送达被当文本追加，现已识别为提交 + 防御剔除换行控制符
2026-08-05 18:37 | [Fix🐛] SelectList 翻页：↑ 从首项 wrap 到末项时确保翻到其所在页，箭头不再消失/循环错乱
2026-08-05 18:25 | [Fix🐛] bash 工具描述补 Windows 环境提示（勿用 pwd/ls/cat，用 cd/dir/type）
2026-08-05 18:25 | [Fix🐛] 工具执行框美化：参数/结果改用 wrapText 折行 + 统一 4 空格缩进 + BOX_WIDTH 对齐，替代 80 字符硬截断
2026-08-05 17:45 | [Refactor♻️] 工具调用升级为 function calling（结构化）：API tools 参数 + tool_calls 事件，废弃 <tool_call> 标签解析
2026-08-05 17:45 | [Feature✨] stream/chat 支持结构化工具调用（分片累积、ChatResult 返回）；存储消息支持 tool_calls 往返
2026-08-05 17:45 | [Refactor♻️] 删除 parseToolCalls/createToolCallFilter/fixJSON；系统提示词移除标签引导；修复纯 append 场景 leaf 恢复
2026-08-05 15:35 | [Fix🐛] 普通对话误调 bash：系统提示词强化"闲聊/建议直接回答不调工具"，bash 工具描述收窄为仅明确要求时用
2026-08-05 15:17 | [Refactor♻️] 会话存储重构为 entry 树 + leaf + fork（对齐 Pi）：消息带 parentId、leaf 指针持久化、摘要入树为 compaction entry
2026-08-05 15:17 | [Feature✨] /history 改为分叉（fork 复制前缀，原历史保留）+ 移除编辑；新增 /sessions（切换/新建会话）
2026-08-05 15:17 | [Config⚙️] 旧 v1 线性会话格式废弃（open 拒绝），旧文件归档到 sessions/archive-v1/

2026-08-04 16:40 | [Feature✨] 新增 /history 命令（查看/回溯/编辑对话历史）+ 存储层 truncateAfter/updateMessage
2026-08-04 16:31 | [Fix🐛] wrapText 中文标点禁排：折行时行首不出现标点（标点吸附行尾）
2026-08-04 16:19 | [Fix🐛] 回复/用户框内容统一 4 空格缩进 + 新增 wrapText 按可见宽度折行，避免长回复顶格/串行
2026-08-04 16:05 | [Fix🐛] 输入行光标定位到文本末尾（Screen 差分渲染支持 cursorCol）+ 切换模型后 header 实时刷新
2026-08-04 15:40 | [Feature✨] 选择器接入组件树（runtime.select 抽象）+ 转义序列缓冲 + Ctrl+C/readline 冲突修复

2026-08-02 18:36 | [Refactor♻️] UI 重构为自研组件树 + Screen 差分渲染（方案2），替代 pi-tui
2026-08-02 18:36 | [Feature✨] 自研 Screen：行数组快照 + 差分写入，只用清行/光标移动，避开同步输出坑
2026-08-02 18:36 | [Feature✨] 自研组件树：Container/Text/SelectList，递归 render(width) 返回行数组
2026-08-02 18:36 | [Feature✨] 自研 InputHandler：raw mode 逐键解析，Enter→steer / Alt+Enter→followUp
2026-08-02 18:36 | [Refactor♻️] 卸载 pi-tui（Windows 终端同步输出协议不兼容，乱码/空行/闪退）
2026-08-02 18:36 | [Fix🐛] start.bat 中文注释 GBK 乱码：改为纯英文，解决乱码命令报错
2026-08-02 18:36 | [Env📦] 新增 ts-agent-run.bat（wt 启动实际执行脚本，避免嵌套引号）

2026-08-02 14:54 | [Fix🐛] 选择器首次渲染覆盖 banner：render 首次不回退，仅后续重绘回退 FIXED_LINES-1
2026-08-02 14:54 | [Refactor♻️] 删除 mock/ 目录（无存活消费者，测不出真实终端行为，改真实 TTY 验证）

2026-08-02 14:41 | [Fix🐛] 选择器重复打印：弃用 \x1b[s/\x1b[u/\x1b[0J 锚点方案（真实终端不可靠），改固定行数+回退清行
2026-08-02 14:41 | [Refactor♻️] 选择器渲染统一 FIXED_LINES 恒定行数，不足空行填充，配合 fitWidth 保证回退精确

2026-08-01 19:24 | [Refactor♻️] MockStdin 瘦身：删除 emitLine（管道可覆盖），保留 emitKey/emitRaw（方向键导航必需）
2026-08-01 19:24 | [Fix🐛] 选择器翻页 bug：pageOffset 上限误用 options.length-pageSize，导致无法翻到后续页
2026-08-01 19:24 | [Fix🐛] 选择器 ↑↓←→ 统一用"selected 所在页页首"语义翻页

2026-08-01 19:02 | [Feature✨] REPL 非阻塞输入：常驻监听 + 队列消费，生成中可立即打断
2026-08-01 19:02 | [Feature✨] 按键分流：普通 Enter → steer（插入打断），Alt+Enter → followUp（排队），对齐 Pi
2026-08-01 19:02 | [Fix🐛] 管道模式丢弃最后一行输入：先处理缓冲数据再判断 isClosed 退出
2026-08-01 19:02 | [Refactor♻️] terminal.ts 新增 readLineWithMode + Alt+Enter 检测，mock/stdin.ts 支持 keypress 事件

2026-08-01 16:34 | [CI✅] steering/followUp/外层循环测试：9 项断言全通过（优先级 steer>followUp，队列正确消费）
2026-08-01 16:34 | [CI✅] createToolCallFilter 过滤测试：6 项断言全通过（跨片/未闭合/前缀误判）

2026-08-01 16:02 | [Feature✨] 实现 steering 中间插入（方案1：不 abort 当前流，当前轮结束后优先处理）
2026-08-01 16:02 | [Feature✨] prompt 增加 streamingBehavior 参数（'steer'/'followUp'），生成中消息可分流
2026-08-01 16:02 | [Feature✨] 外层循环 steering 优先于 followUp 消费（仿 Pi 语义，优先级：steer > followUp）

2026-08-01 15:34 | [Feature✨] prompt 改双层循环（仿 Pi runLoop）：外层消费 followUp 队列，内层 runSingleTurn 单条处理
2026-08-01 15:34 | [Feature✨] 新增 followUp 队列消费（dequeueFollowUp）+ steering 队列预留点
2026-08-01 15:34 | [Fix🐛] UI 流式输出跨片换行缩进修复（atLineStart 状态），消除顶格/空段错位

2026-08-01 15:07 | [Refactor♻️] prompt ⑧ 段合并为单一 stream 循环：一次调用完成工具检测+流式输出，消除 token 双倍
2026-08-01 15:07 | [Feature✨] 新增 createToolCallFilter 流式过滤状态机，剔除 <tool_call> 标签只展示纯文本
2026-08-01 15:07 | [Optimize⚡] 移除 chat()+stream() 双阶段重复调用，工具检测改为基于 stream 完整输出

2026-07-31 21:45 | [Feature✨] 新增 mock/ 测试模块：MockStdin/MockStdout/installTerminalMocks，测试可注入按键捕获输出
2026-07-31 21:45 | [CI✅] 键盘驱动测试：模拟方向键/翻页/全局序号/锚点机制/窄终端裁剪，14 项断言全通过
2026-07-31 21:45 | [Docs📝] 更新 Log/目录.md 反映当前结构（mock/ 目录 + config 新文件布局）

2026-07-31 17:09 | [Fix🐛] 选择器改锚点+清屏重绘（\x1b[s / \x1b[u / \x1b[0J），彻底消除方向键漂移
2026-07-31 17:09 | [Refactor♻️] 移除选择器行数回退计数（FIXED_LINES/RESERVED_EXTRA），改为绝对锚点定位
2026-07-31 17:09 | [Fix🐛] fitWidth 按可见宽度裁剪每行，杜绝终端 wrap 导致内容错乱

2026-07-31 16:30 | [Refactor♻️] config/api.json → config/active-config.json，名称直观表达"当前激活配置"
2026-07-31 16:30 | [Refactor♻️] config/api.example.json → config/active-config.example.json 同步改名

2026-07-31 16:17 | [Refactor♻️] 消除激活状态双写：删除 provider-active.json，api.json 成为唯一真相源
2026-07-31 16:17 | [Refactor♻️] activate/getActive/getActiveModel 统一读写 config/api.json，删除命令中重复写入逻辑
2026-07-31 16:17 | [Refactor♻️] 删除 ProviderActive 接口 + loadProviderActive/saveProviderActive 方法

2026-07-31 14:55 | [Refactor♻️] 供应商定义迁至 config/providers.json，运行时载入，无需改代码新增供应商
2026-07-31 14:55 | [Feature✨] API Key 优先从环境变量解析（apiKeyEnv 字段），provider-store 兜底
2026-07-31 14:55 | [Feature✨] 模型列表启动时从 {baseUrl}/models 远程拉取，失败回退 staticModels
2026-07-31 14:55 | [Feature✨] /provider 无 API Key 时交互式输入密钥并持久化
2026-07-31 14:55 | [Refactor♻️] getProviderRegistry() 改为 promise 单例，支持 async 初始化

2026-07-30 16:12 | [Feature✨] 新增 Provider 工厂路由：LLMConfig.provider 字段支持 deepseek/openai/anthropic/opencode-go
2026-07-30 16:12 | [Feature✨] 新增 AnthropicProvider：消息格式转换 + API 端点 + SSE 解析适配
2026-07-30 16:12 | [Refactor♻️] AnthropicAdapter → AnthropicProvider，统一 Provider 命名规范
2026-07-30 16:12 | [Config⚙️] config/api.json 切换为 OpenCode Go（opencode.ai/zen/go/v1 + deepseek-v4-flash）

2026-07-30 09:57 | [Feature✨] UI 全面升级：绿色启动 Banner 含版本/模型/后端/工具/skill/命令/会话/运行时信息
2026-07-30 09:57 | [Feature✨] 消息框统一样式：│ 前缀在流式换行时自动补齐，彻底解决框内错位
2026-07-30 09:57 | [Refactor♻️] TerminalUI 提取统一 top/mid/bot 框线函数，BOX_W=48 统一管理

2026-07-29 21:27 | [Fix🐛] fixJSON 负向后顾缺失破坏合法 JSON 导致 parseToolCalls 静默丢弃
2026-07-29 21:27 | [Fix🐛] fixJSON 排除列表放过 \t\n 导致路径含 \test/\new 被错误解析
2026-07-29 21:27 | [Fix🐛] permission.ts setRawMode 在非 TTY 下崩溃导致进程闪退
2026-07-29 21:27 | [Fix🐛] 权限弹窗 raw mode 残留 keypress 监听器干扰主 readline 导致工具不执行
2026-07-29 21:27 | [Refactor♻️] parseToolCalls 改为原生 JSON.parse 优先→fixJSON 兜底三段策略
2026-07-29 21:27 | [Refactor♻️] tools.ts 严格化：ToolInputError 校验 + requireString/optionalPositiveInt 统一参数提取
2026-07-29 21:27 | [Refactor♻️] 工具输出统一为 [STATUS_CODE] 格式（OK/NOT_FOUND/NO_MATCH/INVALID/ERROR）
2026-07-29 21:27 | [Refactor♻️] 工具参数 description 增加示例值，帮助 LLM 生成正确参数
2026-07-29 21:27 | [Refactor♻️] 移除 pick() 多别名宽松取参，只认规范参数名
2026-07-29 21:27 | [Docs📝] 完成全项目代码审计，识别 13 个潜在问题并归档至 DECISION_LOG

2026-07-27 18:47 | [Feature✨] 实现工具系统（Skill + Function Calling）：read/write/grep/bash 四个核心工具 + Agent Loop
2026-07-27 18:47 | [Feature✨] UI 拆分为独立组件（TerminalUI + StatusIndicator + spinner 动画）
2026-07-27 18:47 | [Refactor♻️] 工具调用逻辑从 runtime.ts 抽离到 utils.ts（parseToolCalls + estimateTokenUsage）
2026-07-27 18:47 | [Refactor♻️] prompt() 改为 chat() 检测工具 → stream() 最终输出双阶段模式
2026-07-27 18:47 | [Fix🐛] 工具调用 JSON 解析容错（多余引号/缺引号/单引号/尾随逗号）
2026-07-27 18:47 | [Config⚙️] 禁用 DeepSeek thinking 模式避免 tool loop 报错
2026-07-27 14:57 | [Docs📝] 同步 CLAUDE.md 规则到桌面元数据仓库
2026-07-27 14:57 | [Docs📝] 新增 Log/UPDATE_RECORD.md（更新追踪记录）
2026-07-27 14:30 | [Refactor♻️] 命令系统改为自动扫描模式（Loader 基类 + CommandLoader + SkillLoader）
2026-07-27 14:30 | [Refactor♻️] 事件系统改为组合模式（Runtime 持有 PromptEventEmitter 而非继承）
2026-07-27 14:30 | [Refactor♻️] 新增通用 EventStream 推拉通道，LLM 流式输出统一使用
2026-07-27 14:30 | [Feature✨] 新增 Token 用量统计与自动显示（本轮 + 累计）
2026-07-27 14:00 | [Config⚙️] CLAUDE.md 改为按需加载 Log 文件（节约 Token）
2026-07-27 14:00 | [Feature✨] UI 改为事件驱动模式（subscribe 替代 onToken 回调）
2026-07-24 10:20 | [Feature✨] prompt() 接入 session 记忆读写（历史消息拼入 LLM 请求 + 回复自动存入 JSONL）
2026-07-24 10:20 | [Fix🐛] readLine 管道模式下 ERR_USE_AFTER_CLOSE 修复（改用缓冲队列 + on('line') 提前收集）
2026-07-24 10:20 | [Feature✨] 程序重启后自动恢复持久化会话（JsonlSessionStorage.open 读取已有 .jsonl 文件）
2026-07-23 19:00 | [Feature✨] 新增 JsonlSessionStorage（JSONL 文件持久化，支持创建/加载/追加/清空）
2026-07-23 18:15 | [Docs📝] CLAUDE.md 接入元数据：新增阅读规则指向 GLOSSARY.md 和 ARCHITECTURE.md
2026-07-23 18:00 | [Docs📝] 新增 Log/GLOSSARY.md（项目术语表，统一术语解释）
2026-07-23 18:00 | [Docs📝] 新增 Log/ARCHITECTURE.md（架构决策记录，含 6 条核心决策）
2026-07-23 18:00 | [Docs📝] 新增 Log/DECISIONS.md（关键决策日志，二选一决策过程）
2026-07-23 18:00 | [Docs📝] 新增 Log/TESTING.md（测试策略：三层测试 + mock 方案）
2026-07-23 18:00 | [Docs📝] 导出项目元数据到桌面统一仓库（含归一化适配标记）
2026-07-23 17:35 | [Docs📝] 新增 Log/ROADMAP.md（开发路线图，按优先级排列待办模块）
2026-07-23 17:00 | [Refactor♻️] check() 读取配置并创建 LLM Provider，结果通过 CheckResult 注入 Runtime
2026-07-23 17:00 | [Feature✨] 新增 src/llm/ 模块（LLMProvider 接口 + DeepSeek 实现 + 工厂函数）
2026-07-23 17:00 | [Feature✨] REPL 模式接入真实 DeepSeek API，runtime.prompt() 调用 LLM
2026-07-23 16:15 | [Refactor♻️] 项目结构重构：按 core/harness/runtime/io/utils 分类
2026-07-23 16:15 | [Refactor♻️] 移除 init.ts、main.ts → harness/main.ts 持有 REPL/RPC 模式分发
2026-07-23 15:50 | [Feature✨] 新增 Mode 枚举（Repl / Rpc），main.ts 按模式进入不同交互循环
2026-07-23 15:50 | [Feature✨] 实现 REPL 模式：getUserInput() → runtime.prompt() → console.log 循环
2026-07-23 15:30 | [Feature✨] 新增 SessionStorage 接口 + InMemorySession 实现 + MockSession
2026-07-23 15:30 | [Config⚙️] 新增 config/api.json（DeepSeek API 配置）
2026-07-23 15:30 | [Docs📝] 写入 REPL 模式笔记、RPC 模式笔记到 Obsidian 知识库
2026-07-23 15:30 | [Docs📝] 更新 CLAUDE.md 笔记写入规则
2026-07-23 15:00 | [Init🚀] 创建 src/types.ts（全局类型、接口、枚举定义）
2026-07-23 15:00 | [Init🚀] 创建 src/main.ts（Agent 骨架：生命周期、任务调度、工具管理）
2026-07-23 15:00 | [Init🚀] 创建 src/index.ts（CLI/Library 双模式入口，连接到 main.ts）
2026-07-23 15:00 | [Docs📝] 更新 Log/目录.md 为真实结构（补齐 src/ 三文件）
2026-07-19 15:15 | [Docs📝] 新增 Pi Agent 参考规则，创建 Pi 目录索引
2026-07-19 15:15 | [Docs📝] CLAUDE.md 新增规则3：提及 Pi/Agent 对比时优先翻阅 Pi 的目录.md
2026-07-19 15:15 | [Docs📝] 为 pi-mono/packages/agent 创建 目录.md（完整架构索引）
2026-07-19 15:15 | [Refactor♻️] 分析 Pi Agent 全部 25 个源文件和 5 份设计文档
2026-07-19 15:15 | [Refactor♻️] 移除 src/ 和 dist/ 内所有文件，保留纯配置空壳
2026-07-19 15:15 | [Docs📝] 在 Obsidian 知识库创建 "TS 初始环境配置" 笔记组（5篇）
2026-07-19 15:15 | [Docs📝] 创建项目总览、package.json、tsconfig.json、.gitignore、CLAUDE.md 详解笔记
2026-07-19 15:15 | [Docs📝] 优化 CLAUDE.md 措辞，合并冗余规则，细化注释规范
2026-07-19 15:15 | [Docs📝] 补充 Log/目录.md 为完整项目结构索引
2026-07-19 15:08 | [Init🚀] 初始化 TypeScript + ESM 项目环境
2026-07-19 15:08 | [Config⚙️] 配置 package.json（type: module, ESM）
2026-07-19 15:08 | [Config⚙️] 配置 tsconfig.json（严格模式，NodeNext 模块解析）
2026-07-19 15:08 | [Init🚀] 搭建 src/ 目录结构（core/utils/types）
2026-07-19 15:08 | [Init🚀] 创建 CLI 入口、日志工具、类型定义、Agent 基类
2026-07-19 15:08 | [Env📦] 安装 TypeScript 5.7 / tsx / @types/node
2026-07-19 15:08 | [CI✅] 验证编译零错误，dev/build/start 均正常
