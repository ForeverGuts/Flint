# 📐 架构演进日志

> 记录每次**系统架构设计 / 升级 / 改良 / 重构**的变更。
> 与 CHANGE_LOG（一行一条的全量变更）互补：本文件专门沉淀"架构层面的演进"，每次变更写成一**块**。
>
> **记录范围**：设计新系统架构、对现有架构升级/改良/重构。不记录新增功能或 Bug 修复本身，
> 除非该改良同时解决了其中的部分问题（此时应在"面向的问题"中点明）。
>
> **格式**：每块含标题（时间 + 主题）、牵连系统/层次、面向的问题、做出的改动、解决的问题、未来可优化。
> 时间通过 `date` 命令获取系统当前时间，禁止估计。

---

## 2026-09-04 15:30 | 更正一条贯穿五处的错误前提“会话存储只存纯文本”，并查出被它掩盖的承重结构（runtime 的历史丢弃 ↔ Anthropic 安全阀）

**牵连系统 / 层次**：LLM 协议层（llm/types.ts 的 thinkingBlocks 注释、llm/anthropic.ts 的 resolveAnthropicThinking 注释）· 运行时编排层（runtime.ts 的 toolMessages 组装点与两处 appendMessage 调用点，各加承重警告注释）· 会话存储层（session/jsonl-storage.ts 的 appendMessage / getMessages 两处注释）· 文档层（GLOSSARY 两个词条、ARCHITECTURE.md 第四节新增第 9 条、本文件 2026-08-31 那块的两处行内更正标注）· 验证层（verify-session.ts 新增 ⑨ 段）。注：**运行时行为一行未改**，本轮全部是注释、文档与断言

**面向的问题**：
- 2026-08-31 定义 C3 回放作用域时依据的事实是错的：那块写着“已查证只存纯文本”“会话存储只存纯文本（tool_calls 都不存）”。而 jsonl-storage.ts 自 version 2 起 MessageEntry 就带 tool_calls / tool_call_id / name，appendMessage 的 extra 能写、getMessages() 会还原。错的前提复制进了 llm/types.ts 与 anthropic.ts 的注释、GLOSSARY 的两个词条，共五处，彼此互相印证，读代码的人无从怀疑
- 错前提掩盖了一处真正的架构事实：跨用户轮历史之所以是纯文本，成因不在存储层而在 runtime.ts 的 `history.map((m) => ({ role, content }))`。这道丢弃此前无任何注释，看上去像遗漏，实际是承重的——一旦“顺手补全”成透传，历史里带 tool_calls 的 assistant 轮就没有配对的 thinkingBlocks（块永不落盘），resolveAnthropicThinking 的第一条分支会把 extended thinking 静默全程关闭
- 同一次核对还查出 GLOSSARY 的 JsonlSessionStorage 词条写着“压缩摘要另存在 sessions/*_summary.jsonl”，而全 src/ 无一行代码写该文件：摘要自 v2 起入树为 compaction entry，isSessionFileName() 还专门把含 _summary 的文件排除在 /sessions 列表外。照文档去找摘要文件必然找不到
- 结构化字段的入口同样是断的：runtime.ts 两处 appendMessage 都不传 extra，agent-loop.ts 里一处 appendMessage 都没有，而 jsonl-storage.ts 的头注释声称调用方含“Agent 循环（tool 结果消息）”。于是 tool_calls 持久化是双向死路——没人写、写了也没人读

**做出的改动**：
- 五处错误措辞全部改正，并统一改为“结论不变、换掉理由”：跨用户轮无回放义务这个结论成立，但依据从“存储不存结构化信息”改成“thinkingBlocks 不落盘 + runtime 组装时丢弃 role/content 之外的字段”
- 在三处承重位置加警告注释（runtime.ts 的组装点与写入点、anthropic.ts 的安全阀），写明“这道丢弃不能直接修好，要接通必须先解决历史 thinking 块的回放”，并互相指回 ARCHITECTURE.md 第四节第 9 条
- ARCHITECTURE.md 第四节 8 条 → 9 条，第 9 条按“格式支持 / 入口未接线 / 出口被堵 / 为何不能直接修 / 本轮处理”五段记全，并标明这是项目里第二处“支持但未接线”（第一处 runtime.onInput()，见第 7 条）
- 本文件 2026-08-31 那块的两处错话**不改写原文**（append-only），只在句末加 ⚠ 行内更正标注指向本块——沿用 ARCHITECTURE.md 第四节“保留原状描述以便回溯”的既有惯例
- verify-session.ts 新增 ⑨ 段把事实钉死：真往返（写 tool_calls → 落盘含该键 → getMessages 还原 → reopen 后仍在）证明存储不是纯文本；源码文本断言证明 runtime 两处 appendMessage 不传 extra、组装点只映射 role+content、全 src/ 无 _summary 写入。下次谁想“顺手补全”，先撞上测试

**解决的问题**：
- 错误前提不再自我印证：五处措辞统一到同一个正确成因，且每处都指向 ARCHITECTURE.md 第 9 条这个单一权威叙述
- 承重结构从“隐形”变“显形”：runtime.ts 的丢弃点此前无一句注释，现在任何人改它都会先读到“这会让 extended thinking 全程关闭”
- 文档可信度：GLOSSARY 的 _summary.jsonl 是会导致读者去文件系统里找不到东西的硬错，已消除
- 事实有了防线：⑨ 段断言使“存储只存纯文本”这个说法再也无法被当成事实写回代码或文档而不被测试反驳

**未来可优化**：
- 真要接通历史结构化数据，得先定 thinking 块的持久化策略（落盘 signature 涉及体积与敏感数据，折叠成文本会丢工具调用语义），这是独立的一件事，已记入 ROADMAP 的剩余项
- jsonl-storage.ts 的头注释“调用方”一栏与真实调用点长期不一致（本次是第二处：先前 Agent 循环、这次 _summary），可考虑给“调用方”注释加一条 verify 断言，或干脆改用工具生成
- ARCHITECTURE_LOG 的行内 ⚠ 标注是本次新引入的手法，若后续更正频繁，需要一条规则说明“历史块可以加标注、不可以改原文”

---

## 2026-09-03 10:44 | 把 span 配对从可选扩展抽成公共件 SpanCollector，观测的消费端从此有两个互不依赖的出口（落盘 / 上屏）

**牵连系统 / 层次**：契约层（core/events.ts 加 CollectedSpan + SpanCollector，与已有的 Span/SpanRecorder 并列）· 运行时层（新增 runtime/span-collector.ts；runtime.ts 加两个只读 getter；types.ts 的 RuntimeOptions 加一个必注入项）· 装配层（harness/main.ts 在 createRuntime 闭包外建实例并 attach）· 扩展层（extensions/watchers/trace-log.ts 134 → 78 行）· 命令层（新增 commands/builtin/traces.ts）· 验证层（verify-events ⑨ 段 21 项）。注：事件契约的生产端（三处 trace/beginSpan 调用点）、总线的盖戳与广播逻辑、落盘格式与两个开关全部零改动

**面向的问题**：
- "start 与 end 靠 spanId 认亲"这份配对逻辑只有一份实现，但它住在可选扩展 trace-log 里：核心命令想拿成段的观测数据，就得反过来依赖一个可以被删掉的扩展——依赖方向是错的
- 想看某段花了多久，唯一路径是先设 TS_AGENT_TRACE=1 落盘、再去翻 trace.jsonl；观测结果没有"随手看一眼"的出口
- 配对逻辑一旦被第二个消费者需要，摆在面前的三条路里两条都要付代价：只读 jsonl 等于默认没数据，命令自带一份配对等于同一规则两处实现、将来必然漂移
- 段是嵌套的（prompt 包着 llm_request，llm_request 又包着 tool_call），"合计耗时"若把所有 durationMs 相加会把同一段时间重复计好几遍——这个语义陷阱此前没有任何地方写着

**做出的改动**：
- 契约与实现分开放，沿用项目既有分层惯例：CollectedSpan（一段完整行为的形状）与 SpanCollector（feed / attach / recent / running / drainUnclosed）进 core/events.ts，实现 SpanCollectorImpl 进 runtime/span-collector.ts。它与生产端的 SpanRecorder 恰好对称——一个帮生产端打卡，一个帮消费端收段
- 配对规则从 trace-log 原样迁来而不重写（只认带 spanId 的事件 / _start 进门登记 / _end 出门合并 / 孤儿 end 忽略 / 信封字段剥掉 / 便签段载荷走 attrs）。原样迁来的好处是：迁完跑 verify-events 全绿，就等于证明了落盘行为一字未变
- 两个消费者各持独立实例而不共享：watcher 建 capacity:0 的实例（落盘型只用 feed 的返回值，不必在内存里再留一份历史），main.ts 建缺省 capacity 200 的实例供 /traces 读。理由是总线的意义就是消费者互不知情，落盘的关掉不该影响上屏的；更重要的是依赖方向——核心命令不能反过来依赖一个可选扩展
- collector 建在 main.ts 的 createRuntime 闭包外、与 events 同生命周期：闭包会因热切换重建 Runtime，建在里面的话已收的段会跟着丢
- /traces 走 /diagnostics 的同一范式：Runtime 只读委托（getTraces / getRunningSpans），命令只负责排版。参数纯数字=条数、其他=段名关键字过滤；合计只算 prompt 段（最外层且彼此不重叠，它的和才等于用户真正等掉的墙钟时间），并把这条理由写成命令里的注释
- 未关门的段单独列进"正在跑"块而不混在已收束的段里：这类段的 durationMs 是实时算的，与已收束的段语义不同；关键字过滤对两个块同时生效（初版漏了这一点，已修并补上断言）

**解决的问题**：
- 配对逻辑仍只有一份，但现在住在核心层，两个消费者都能拿到；trace-log 从"配对 + 落盘"瘦成"开关判定 + 落盘格式 + 退出补记"三件事，职责与它的目录名（watchers/：只看只录）终于对得上
- 观测结果有了开箱即用的上屏出口，不必先落盘再翻文件；同时保留落盘作为可选的深度明细（含对话正文片段，属隐私，仍由开关控制）
- 换成 LangSmith / LangFuse 的成本进一步降低：新消费者只需拿 CollectedSpan，不必再自己实现一遍配对
- "嵌套段不能相加"这个陷阱从隐性变成显性：命令里有注释说明，verify-events 里有一条精确断言（手工喂 prompt 1000ms + 内嵌 llm_request 800ms，断言合计是 1.0s 而不是 1.8s）
- 真实链路已实测：一轮真实对话后 /traces 列出 prompt 1.3s + llm_request 1.3s（含真实模型名、首字延迟与用量），list_commands 里自动出现 traces

**未来可优化**：
- SpanCollector 只有环形队列，没有按 turnId 分组或树形展示；显式 parentId 仍是 ROADMAP 里未立项的一项，所以 /traces 的"正在跑"块也只能平铺
- /traces 的排版是纯文本，没走 TreeUI 的框宽夹逼，段名或细节过长时会超出终端宽度（现有 fit-width 可复用）
- watcher 与 /traces 各持一个实例，意味着同一批事件被配对两遍。开销极小（一次 Map 存取），但如果将来消费者继续增加，可考虑由总线侧提供共享的成段流
- runtime.getTraces() 返回的是 recent() 的副本，每次调用都复制整个队列（最多 200 条）；/traces 是人工敲的低频命令，暂不值得为它做增量读

---

## 2026-09-03 09:52 | 用探针法把"扩展 ctx 的能力边界"变成可执行断言，并用反向验证证明它真会报警

**牵连系统 / 层次**：验证层（scripts/verify-extensions.ts 新增 21 项）· 装配层（harness/main.ts:77 注释补漏，仍写"段落 + hook"）。注：三类口子的 ctx 形状、extension-loader 的装载逻辑、trace-log 的落盘格式与两个开关全部零改动——本次只加守卫，不改被守卫的东西

**面向的问题**：
- 上一块立下的"watcher 拿不到 on"这条边界只存在于类型声明里，而类型声明本身是可以被改的：接口加一个 on + 调用处跟着递 on，两行一起改，tsc 仍 0 错误（本次已实测确认）
- "装载器扫不扫得到扩展目录"此前无任何断言覆盖：verify-events 的 ⑧ 是直接 import trace-log 模块再手工调 registerWatchers，走的是另一条路，而搬目录这类改动最大的风险点恰在盲区里
- TypeScript 的类型在运行时被擦除，无法直接断言"某个接口的 ctx 类型里没有 on"
- 一条永远绿的断言与没有断言等价：不先证明它会在边界被拆时变红，就无法判断它究竟守住了什么

**做出的改动**：
- 探针法：往 sections/ hooks/ watchers/ 各临时写一个探针文件，探针把实际收到的 ctx 的键记到 globalThis，跑真实 loadExtensions 后断言键集合。这是绕开类型擦除的办法——不看声明，看运行时实际递出了什么
- 断言分五组：三类口子都能装载 / ctx 键恰好（watcher 只有 events、hook 有 on+events、sections 只有 addSection）/ 边界的行为证据（不开开关时通配订阅表 size 为 0、精确监听表只有 example-hook 的 before_request 一条）/ 走装载器路径的 trace-log 端到端落盘 / 坏扩展抛异常不连坐同目录排在它后面的扩展
- 坏扩展探针 __bad-ext.ts 的字母序刻意排在 __probe-ext.ts 与 trace-log.ts 之前（下划线的 ASCII 小于 t），于是它先抛错，正好验证"前面的坏了不牵连后面的"
- 探针写在 src/ 下会被 tsc 检查（include 覆盖 src/**/*.ts），所以探针形参写 unknown 保证能过类型检查，并靠 finally 删除——残留在扩展目录会被每次真实启动装载；脚本自己再断言一次"三个目录无 __ 开头的残留"
- 反向验证：故意把 WatcherModule 接口加上 on、调用处跟着递 on，结果是 tsc 0 错误而 verify-extensions 红 3 条并打印实际键 [events,on]、EXIT=1；确认断言会咬人后复原，全量 10 套 278/278 绿

**解决的问题**：
- "能力边界"从只有类型声明一道防线变成两道：类型防手滑（在调用处偷塞 on 会被对象字面量多余属性检查当场拦住），断言防改规矩（把声明与调用处一起改，编译能过但断言红）
- 上一块"未来可优化"里记的装载验证盲区已堵上，且是以常驻断言的形式而非一次性手工验证
- "不开开关时零开销"从注释里的说法变成可执行证据
- loadDir 的静默 catch 此前无从判断会不会连坐，现在有断言把"不连坐"这个行为固定住

**未来可优化**：
- 探针法需要在生产扩展目录里临时写文件，finally 能保证正常与异常两条路径都删除，但进程被强杀时仍可能留下残留；更稳的做法是让 loadExtensions 支持传入扫描根路径，把探针写到临时目录
- core/extension.ts 的三个 Ctx 接口仍无人 import，extension-loader 里是内联重复定义——契约与实现两处写，将来可能漂移（上一块已记，本次仍未做）
- loadDir 的 catch 依旧静默吞错：断言只证明了"不连坐"，没解决"扩展写错时报错无处可看"（可接到 Diagnostic）
- 反向验证是手工做过的一次性动作，没有沉淀成"断言自身有效性"的自动检查；这类元测试通常成本高于收益，此处只留记录

---

## 2026-09-03 00:12 | 扩展目录按职责拆分：watchers/ 与 hooks/ 分家，"旁观者不改流程"从注释约定升级成类型约束

**牵连系统 / 层次**：扩展契约层（core/extension.ts 新增 WatcherRegistrationCtx）· 装载层（context/extension-loader.ts 新增 WatcherModule + 第三条 loadDir 扫描）· 扩展实现（extensions/watchers/trace-log.ts 由 extensions/hooks/ 迁入，导出名 registerHooks → registerWatchers）· 示例扩展（extensions/hooks/example-hook.ts 头注释加判据指路）· 验证（scripts/verify-events.ts ⑧ 段改指新路径）。注：事件契约层（core/events.ts + runtime/events.ts）、生产端三处 trace 调用点、落盘格式与两个开关（TS_AGENT_TRACE / TS_AGENT_TRACE_FILE）零改动——搬的只是"谁装载它、从哪个目录装载"

**面向的问题**：
- `extensions/hooks/` 里住着两类性质相反的扩展：example-hook 用 `ctx.on` 改写流程（before_request 追加 system 层），trace-log 用 `ctx.events.subscribe` 通配收事件、返回值没人收（只看只录）
- 目录名是按"怎么装进来"命名的（两者都走 registerHooks 这一个口子），而不是按"是否真的钩流程"命名，于是 trace-log 被误读为"trace 与钩子机制有关"（本次对话里实际发生了这个误解）
- 装载口子只有一个、ctx 一律同时给 `{ on, events }` 两把钥匙：一个纯消费型扩展拿到了改写流程的能力，只能靠自觉不用
- 没有任何断言覆盖"装载器扫不扫得到扩展目录"：verify-events 的 ⑧ 是直接 import 模块 + 手工调注册函数，而搬目录这类改动最大的风险点恰好在盲区里

**做出的改动**：
- 扩展目录从两类拆成三类，各自一条口子、各自一份 ctx：sections/（`{ addSection }`）· hooks/（`{ on, events }`，可改写流程）· watchers/（`{ events }`，只订阅）
- trace-log 迁入 `extensions/watchers/`、导出名改 `registerWatchers`；**新口子的 ctx 里刻意不给 `on`**——"旁观者改流程"从"注释提醒 + 使用自觉"升级成"编译不过"
- core/extension.ts 补对称契约 `WatcherRegistrationCtx`（与 HookRegistrationCtx 的唯一区别就是没有 on）；example-hook.ts 头注释写清"该放 hooks/ 还是 watchers/"的判据：要不要改写流程
- 落盘逻辑一行未动：配对表、信封剥离、便签段 attrs 特例、孤儿 end 忽略、退出补记 unclosed 全部原样迁移
- 临时脚本走真实 `loadExtensions` 补上装载验证（sections 装载 1 个 / watcher 自动装载并落盘 / hook 仍改写 before_request），验完即删

**解决的问题**：
- 目录名与扩展性质对齐，"hook"一词不再同时指"装载口子"和"能改流程的订阅"两个东西
- 纯消费型扩展拿不到 `on`，误改流程在类型层面就不可能（日后新增 watcher 不必再叮嘱）
- 换 LangSmith / LangFuse 的落点更明确：它们是消费者，放 watchers/，核心与 UI 一行不改
- 装载路径首次被真实验证（此前只有"手工注册"被验证，等于只测了扩展本身、没测装载器）；全量 9 套 257/257 绿、tsc 零错误，verify-events 55/55 证明落盘行为一字未变

**未来可优化**：
- core/extension.ts 的三个 Ctx 接口目前无人 import（extension-loader 里是内联重复定义），契约与实现两处定义将来可能漂移——可让 loader 直接 implements 这三个接口
- 装载验证只在本次以临时脚本形式跑过，未沉淀成断言；可考虑加一套 verify-extensions（三类口子各一条 + ctx 能力边界）
- 扩展只按职责分类，尚无启用/禁用开关与加载顺序约定（多个 watcher 同时落盘时顺序不确定）
- loadDir 的 catch 是静默跳过（`/* 单个扩展失败跳过 */`），扩展写错时报错无处可看，可考虑接到 Diagnostic

---

## 2026-09-02 19:42 | 启动提速第二档：启动关键路径彻底断网，模型列表从"启动时拉"改成"后台预热 + 按需现拉"

**牵连系统 / 层次**：配置层（config/manager.ts 删 init() + 新增 warmModels/ensureModels/isModelsFresh/startRefresh）· 协议层抽象（llm/provider.ts 的 Provider 加 modelsFetchedAt）· Harness 启动编排（harness/check.ts 注释同步、harness/main.ts 后台预热）· 命令层（commands/builtin/model.ts 二级选择器前按需现拉）· 验证（scripts/verify-startup.ts 新增）。注：check() 的返回契约（CheckResult）与诊断分档语义零改动——省掉的只是它内部的等待；/model 的交互流程也零改动（只在二级展开前多一步 ensureModels）

**面向的问题**：
- 第一档只把 probeStartup 挪到了后台，界面渲染前还剩最后一批真实往返：`getConfigManager()` 会 `await init()`，为每个有 key 的供应商并行拉 `/models`，而 `check()` 又 await 它
- 实测这批请求冷连接 1998ms、连接池热时 278ms；网络差时每家最长卡 10s 超时（AbortSignal.timeout(10000)），全程终端只有 banner 没有 UI（用户已就此投诉过）
- 每次启动都在为用户可能永远不会打开的菜单提前付钱：`getModels()` 的 9 个调用点里只有 `/model` 的二级选择器真需要远程列表
- 旧代码里"拉取失败"与"拉到空列表"无从区分，也没有任何"这份列表还算不算新鲜"的概念，只能要么每次现拉、要么永远不拉

**做出的改动**：
- manager.ts：删掉 `init()`，`getConfigManager()` 变成 `Promise.resolve(new ConfigManager())`（保留 Promise 签名：调用方已全面 await，日后加异步初始化不必改调用点）
- manager.ts：`warmModels()` 并行预热有 key 的几家，失败不抛（fetchRemoteModels 内部已 swallow）；`ensureModels(id)` 新鲜期内直接返回、否则现拉；`isModelsFresh(id)` 供调用方决定要不要先提示"正在拉取"
- manager.ts：`inflight` Map 去重——预热与用户开 /model 撞在同一家时，第二个调用方复用在飞的 promise；`refreshModels(id)` 走同一个入口但无视新鲜期（输入新 key 后必须现拉）
- provider.ts：Provider 加 `modelsFetchedAt`（null = 本进程还没成功拉过）；`refreshModels` 只在 `remote.length > 0` 时盖戳，否则断网那一次会被误记成"已新鲜"、之后整个进程周期再也不重试
- main.ts：预热放在 RPC 早退分支之后（外部程序用不到选择器），且只在 `process.stdin.isTTY` 下发起（非 TTY 时选择器直接返回第一项、列表根本不会被展示；管道模式跑完就退，在飞的 fetch 反会把进程拖到超时）
- model.ts：二级选择器展开前先 `isModelsFresh` 判一下，不新鲜就打印"正在拉取模型列表…"再 `ensureModels`——现拉要 0.3~0.9s，没提示看着像卡死
- scripts/verify-startup.ts：临时配置造三家供应商（有 key / 没 key / 坏地址）+ 假服务器按路径计数 + fetch 探针，32 项

**解决的问题**：
- 启动关键路径 0 网络请求：check() 全链路 760ms → 0.7ms（new ConfigManager() 0.6ms，只读 3 个本地文件）
- 被移出去的两项都在后台：warmModels 1041ms（3 家并行）+ probeStartup 285ms，界面渲染不等它们
- 用户开 /model 的体感反而更好：新鲜期内 0.0ms（旧实现每次开都要重拉一遍），过期现拉一家 552ms 且有明确提示
- 断网启动不再退化：列表有静态兜底、自检本来就在后台，"拉取失败"与"列表已新鲜"两个状态被 modelsFetchedAt 分开了
- 重复请求有了收口：并发打同一家只发一次

**未来可优化**：
- 活动供应商启动时被拉两次（warmModels + probeStartup）。合并需要 fetchRemoteModels 交出 HTTP 状态码（probe 靠它分档 401），为省一次后台请求改契约不划算，先记着
- 新鲜期是写死的 5 分钟常量，没做成配置项；模型列表的变化频率是"月"级，真要调也是调大而不是调小
- 一级列表的"N 个模型可用"在预热完成前显示静态数（13 而非 33），要修得让 UI 订阅一个"列表已更新"事件——为一行说明文字加一条事件不划算
- 第三档（预编译发行）仍在 ROADMAP：node 冷启动 + tsx 即时转译是剩下的固定底噪（本次实测两个模块的 import 链路 19ms）
- 落盘缓存这条路被明确否掉了（见 DECISION_LOG 同日条目），若将来出现"跨进程复用列表"的真实需求再重开

---

## 2026-09-02 19:09 | L3 打通流式真实 usage：Provider 层填上观测链最后一个空槽，token 数从本地估算变 API 真值

**牵连系统 / 层次**：Provider 层（llm/stream-helper.ts 的 OpenAI 兼容路径 + llm/anthropic.ts）· Agent Loop 契约与实现（core/loop.ts 的 AgentLoopResult 扩字段 + loop/agent-loop.ts 逐轮合计）· Runtime 编排层（runtime/runtime.ts 真值优先、缺失回退）· 事件契约注释（runtime/events.ts）· 验证（scripts/verify-usage.ts 新增）。注：流事件契约（llm/types.ts 的 end 事件）与**全部消费端**（TreeUI / trace-log hook / RPC）零改动——usage 走的是上一块就留好的槽位，填上即自动生效

**面向的问题**：
- 上一块（16:26）留下的唯一空槽：`llm_request_end.usage` 恒为 null。两条协议都得主动去拿——OpenAI 兼容端**默认不在流式响应里给用量**，必须显式索取；Anthropic 把用量拆在 `message_start`（输入）与 `message_delta`（输出累计值）两个事件里
- token 数只能靠 `estimateTokenUsage` 估算，而它只算 user 输入 + 最终回复：多轮工具循环的中间 assistant/tool 消息、system prompt、5 个工具描述全没算。实测同一条冒烟：估算 {26,23,49} vs API 真值 {2834,71,2905}，输入侧少报约 109 倍
- Anthropic 的缓存语义会诱发伪报：本项目在 system 分层与 tools 上都设了 `cache_control` 断点，命中时 `input_tokens` 只剩个位数（它只统计"本次新读的非缓存部分"），照字面填就等于报"这次几乎没发输入"
- 索取用量本身有兼容风险：严格校验未知字段的代理端会直接 400，为一个统计参数把用户的对话搞挂不值得
- 多轮合计的完整性无从表达：任一轮拿不到用量时，"把拿到的几轮相加"会报出一个看起来是真值的少报数字

**做出的改动**：
- `stream-helper.ts`：请求体加 `stream_options.include_usage`；解析 `[DONE]` 之前那个 `choices=[]` 的专用 chunk；`total_tokens` 缺省时自加；`toLLMUsage()` 收口字段映射
- `stream-helper.ts` 降级机制：400 且错误文本含 `stream_options` → 进程级开关 `streamUsageSupported` 永久关闭 + 同一次调用内静默重试一次；其他 400 原样抛出（不误吞密钥无效/余额不足）
- `anthropic.ts`：`AnthropicStreamUsage` 接口含两个缓存字段；`message_start` 填输入（三项相加）、`message_delta` 填输出（累计值 → 覆盖不累加）；`sawUsage` 标志区分"没见到用量事件"与"见到了 0"
- 两条路径统一不伪报：没拿到用量就不在 end 事件上带 `usage` 键（而非填 0），上层因此能把 null 与 0 分开
- `core/loop.ts`：`AgentLoopResult` 从 `{finalText}` 扩成 `{finalText, usage: LLMUsage | null}`（契约层，实现与调用方共用）；顺带删掉 `agent-loop.ts` 里的重复定义
- `agent-loop.ts`：`usageTotal` 累加器与 `usageComplete` 可信标志分开两件事；任一轮 null 或流异常 → 整体 null；用量经 `trace()` 回调的**返回值**上送进 `llm_request_end` 载荷（TS 的控制流不追踪闭包内赋值，写成回调内改外层 let 会被锁死成初始的 null）
- `runtime.ts`：`usage ?? estimateTokenUsage(...)` —— 真值优先、缺失才回退，累计与 `usage` 事件随之变准
- `runtime/events.ts`：`LLMRequestEndEvent.usage` 的注释从"两个 Provider 都还没填这个槽"改成两条协议各自的实际取法
- `scripts/verify-usage.ts`：一台假服务器按 URL 分流演两种协议、两个队列各自回放预制 SSE，22 项覆盖两条协议路径 + 合计 + 降级 + 上送

**解决的问题**：
- 观测链最后一个空槽填上：`llm_request_end.usage` 与 `prompt_end.totalUsage` 从估算变 API 真值，而消费端一行未改（真值走的是早已存在的字段）
- `/usage` 的口径终于对得上账单：多轮任务下的 system prompt、工具描述、中间消息全都算进去了
- Anthropic 缓存命中不再少报：三项相加后，命中缓存的请求报出的是真实计费量
- 不兼容端点不会因统计参数挂掉对话：降级后行为与改造前完全一致，用户看不到失败
- "少报的真值"这个新型误导被堵住：任一轮缺失即整体 null，消费端不必猜合计是否完整

**未来可优化**：
- 非流式 `chat()` 路径仍无用量：`ChatResult` 没有 usage 字段，compaction 的摘要调用（走 `chat`）消耗的 token 从未计入 `totalUsage`——需新增一条"旁支用量回流"通道，属独立议题
- 缓存明细未单列：`LLMUsage` 只有三个槽，命中率（cache_read / 总输入）这个最能省钱的信息被合并掉了，要报得先扩契约
- 降级开关是进程级：同进程内从严格代理切到兼容端点也不会再索取，重启才恢复；可改成按 baseUrl 记忆
- 估算回退的精度未改：`estimateTokenUsage` 仍只算 user 输入 + 最终回复，缺失时的数字依旧偏小（可考虑把 toolMessages 全量算进去）
- 本次踩的 TS 闭包 CFA 坑只写在了 `agent-loop.ts` 的行内注释里，未沉淀成可检索的规则（它为本次贡献了两轮无效的 never 排查）

---

## 2026-09-02 16:26 | 可观测层落地：总线盖戳 + 打卡机（span）+ 双通道契约（骨架/便签），三重循环首次有边界

**牵连系统 / 层次**：事件契约层（core/events.ts + runtime/events.ts）· Agent Loop（loop/agent-loop.ts）· Runtime 编排层（runtime/runtime.ts）· CompactionService（context/compaction.ts）· UI 消费层（io/ui/tree-ui.ts）· 扩展层（extensions/hooks/trace-log.ts 新增）· 验证（scripts/verify-events.ts 新增）。注：会话存储（session/jsonl-storage.ts）与 Provider 层（llm/）零改动——usage 槽位早已在 `LLMStreamEvent` 的 end 事件上留好，填上即自动生效

**面向的问题**：
- 11 种事件全是**离散点**：无时间戳、无序号、无分组 ID、无成对边界。一次带 3 个工具的 prompt 实际发生 4 次 LLM 往返，对外一个边界事件都没有——"单次 LLM 多久""首字多慢""压缩占了多少时间"永久无法回答
- 唯一的 EventStream→EventBus 翻译点（agent-loop 的 `for await`）把 provider 的 `end{fullText, usage}` 整个丢掉：完整回复、真实用量、"LLM 调用结束"的边界全部丢失
- 信息只能在源头采集，不能在下游重建：TTFT 只在收到第一个 token 的那一刻可量，出了作用域永久丢失；而成败、耗时这些只有生产端知道的事实，过去迫使消费端去猜（TreeUI 拿 `result.includes('失败')` 判红绿）
- 配对靠自觉必漏：工具抛异常时 catch 分支只记诊断不发 `tool_execution_end`，任何按 start/end 计数的消费者会永远认为它还在执行
- 观测后端选型被语义欠账锁死：没有边界就没有树，接 LangSmith 也只能上报一堆无父子的孤点

**做出的改动**：
- 公共头下沉到总线：`EventMeta{at, seq, turnId}` 由 `emit()` 统一盖上（唯一必经之路，生产端零改动全量生效）；`beginTurn()` 在 `Runtime.prompt` 入口换发分组，`isStreaming` 时不换发（排队输入不能掀翻在飞回合）
- 生产/消费类型分离：`RuntimeEventIn`（草稿）与 `RuntimeEvent = RuntimeEventIn & EventMeta`（完整事件）；`EventBus<TIn, TOut>` 改双类型参数，默认 TOut=TIn 保证旧写法行为不变
- 打卡机（`SpanRecorder`）：`trace()` 自动配对（try/finally 结构保证，抛异常/提前 return/continue 都漏不掉，不吞异常只重抛）、`beginSpan()` 手动版供跨 finally 场景；`Span` 句柄带 spanId/set/end/fail/closed（防重复打卡）
- 退化路径：`NOOP_SPAN_RECORDER` + `spanRecorderOf()`——测试替身（noopEvents）与未接观测的旧总线拿到的永远是可调用的打卡器，业务代码不为"有没有观测"写两套分支
- 双通道契约：路 A 骨架四段（prompt/llm_request/tool_call/compaction）强类型，`SpanContracts` 做段名→载荷映射，`SpanAttrs<K>` / `SpanResult<K>` 用 Omit 剔掉总线负责的字段；路 B 便签（`note_start`/`note_end`）段名降级成 `name`、载荷自由字典，扩展加观测点核心零改动
- 三重循环挂段：外层 while → `beginSpan('prompt')`（finally 里关门，catch 里 `root.fail`）；中层 for turn → `trace('llm_request')`（首个 token 到达时算 TTFT，空流标 `status='empty'`）；内层 for tc → `trace('tool_call')`（权限弹窗刻意放在段外：等人点按钮的时间不算工具耗时）；旁支 → `trace('compaction')`
- L0 配对漏洞：`tool_execution_end` 改为成功/软失败/异常/用户拒绝四条路径统一发射，新增 `ok: boolean` 由生产端直说成败
- 消费层：TreeUI 删掉三行子串猜测改吃 `ok`；新增 `prompt_start`（清上回合统计）/`llm_request_end`（累计次数与耗时、取首次 TTFT）/`prompt_end`（结算实测账）三个 case
- 旁路消费者：`trace-log.ts` hook（`TS_AGENT_TRACE=1`）把成对 span 落成"一行一段完整行为"的 JSONL，进程退出时未关门的段补记 `status='unclosed'`

**解决的问题**：
- 四个原本答不上来的问题现在能答：单次 LLM 往返多久、首字多慢、压缩占了多少时间、工具到底成没成（实测一次 RPC 管道：llm_request 1688ms / 首字 1365ms / prompt 全程 1692ms）
- 配对从"靠自觉"变成"靠结构"：异常、提前退出、continue 都关得了门，同类 bug（工具期黑屏、UI 卡在下边框）从根上消除
- 观测后端变成可插拔：落盘、`/traces` 命令、TreeUI、LangSmith/LangFuse 全是 `subscribe()` 的并列订阅者，互不干扰
- 顺手带出两个真 bug：TreeUI 子串猜测误判红绿、`setLLM` 热切换后 AgentLoop 仍持旧 Provider（兜底切换形同虚设）
- 零依赖不破：全部自研，`package.json` 的 `dependencies` 仍为空

**未来可优化**：
- L3：两个 Provider 的流式路径都还没填 `end{usage}` 槽（stream-helper 缺 `stream_options.include_usage`、anthropic 未解析 `message_start`/`message_delta`），当前 `usage` 恒为 `null`，填上后消费端不必改
- 无 parentId：四段靠 turnId + 时间区间包含关系可重建层次，但未显式给出树形（若接 LangSmith 需消费者自行推导）
- 缺一个 `/traces` 内置命令（目前只能看 JSONL 文件）
- 51 处裸 console 仍未收编：它们不进总线，因此既无时间戳也不参与配对
- 启动期与运行期仍是两个独立发射器（main.ts 的 events 与 Harness.events），check_start/check_done 的 turnId 为空串

---

## 2026-08-31 18:11 | 阶段C3（问题3）多轮回放三管道落地（收集→挂载→回放）+ 安全阀精确化，工具循环每轮皆可思考

**牵连系统 / 层次**：LLM 协议层（llm/types.ts + anthropic.ts）· Agent Loop（loop/agent-loop.ts）· 验证脚本（scripts/verify-c3.ts）。注：会话存储（session/jsonl-storage.ts）零改动——已查证只存纯文本，回放义务天然限于单次 run() 内存消息链；问题4（原则边界修订）已随本次一并定调：推理文本展示不持久不变，thinking 块属协议数据例外保留（内存内）

> ⚠ **2026-09-04 行内更正（原文不改）**：上句“已查证只存纯文本”是**错的**。`MessageEntry` 自 version 2 起就带 `tool_calls` / `tool_call_id` / `name`，`appendMessage` 的 `extra` 能写、`getMessages()` 会还原。**本块的结论不受影响**（回放义务确实限于单次 run()），但成因不是存储层：`thinkingBlocks` 不落盘，且 `runtime.ts` 组装请求时只映射 `role` + `content`。详见本文件顶部 2026-09-04 那块与 [ARCHITECTURE.md](./ARCHITECTURE.md#四已知架构债) 第四节第 9 条。

**面向的问题**：
- 问题1+2 留下的临时安全阀是粗粒度关闭（有 assistant 历史就不开）：工具循环从第 2 轮起永久裸答，六杠杆①在 Anthropic 路径实际只覆盖首轮——根因不是规则太严，而是没有"还债能力"（上一轮带签名的 thinking 块无处可寄）
- Anthropic 协议硬约束：开 thinking 的请求里，带 tool_use 的历史 assistant 轮必须原样回放其 thinking 块（一字不改，验 signature），否则 400——需要一条贯穿流解析、循环状态、请求构造三处的数据管道，而三处分属两个文件，缺任何一环都是断头路
- 回放作用域必须先定界：会话存储只存纯文本（tool_calls 都不存），若误把回放义务扩到跨用户轮，会去设计根本不需要的持久化格式——先查证事实再定边界，把问题空间收敛到单次 run()
  - ⚠ **2026-09-04 行内更正（原文不改）**：括号里“tool_calls 都不存”**是错的**——格式支持往返，只是入口无人写（`appendMessage` 不传 `extra`）、出口被 `runtime.ts` 丢弃。“把问题空间收敛到单次 run()”这个结论仍成立，因为 `thinkingBlocks` 确实不落盘。见 [ARCHITECTURE.md](./ARCHITECTURE.md#四已知架构债) 第四节第 9 条。

**做出的改动**：
- 数据模型（types.ts）：ThinkingBlock 接口（推理文本+signature）；LLMMessage 加可选 thinkingBlocks（注释点明作用域：仅内存消息链，存储不碰）；LLMStreamEvent 加 thinking_block 变体（成品事件，与 reasoning 原料分片分工明确）
- 收集管（anthropic.ts 流解析）：thinking_delta 双通道（推 reasoning 展示事件 + 按 index 累积入块）、signature_delta 只累积（不展示），content_block_stop 时拼装完整块推 thinking_block 事件；流中断未收到 stop 的残块丢弃（签名不完整不可回放，宁弃不假）
- 挂载管（agent-loop.ts）：每轮声明 turnThinking 收集器，事件循环加 thinking_block 分支；工具轮 push assistant 消息时条件展开挂块（无块不传键，兼容 exactOptionalPropertyTypes）；最终答案轮直接 break 不落消息（无后续轮，无回放义务）
- 回放管（anthropic.ts toAnthropicMessages）：assistant 分支把块置于 content 数组最前（还原产出顺序：先思考后工具），一字不改原样寄回；非流式 chat 不回放（单次调用无后续轮，阅后即焚合理）
- 安全阀精确化（resolveAnthropicThinking）：关闭条件收窄为"存在带 tool_calls 但无 thinkingBlocks 的 assistant"——纯文本历史（跨用户轮）与带块历史（回放有保障）都不拦截；未来压缩若截断带块消息，此阀自动降级兜底（鲁棒性副产品）
- verify-c3.ts 重构为脚本队列（流式请求按序回放三套预制流，避免计数被 chat 请求污染），新增真实 AgentLoop 驱动的两轮端到端断言共 9 项（块/签名/位置原样、精确阀两侧、挂载语义）
- 编译验证：tsc 零错误（含修一处 TS6196：未使用导入改为拼装处显式标注 ThinkingBlock）；全量回归 A/B 13 + C1 8 + C2 16 + C3 17 = 54 项全绿

**解决的问题**：
- 工具循环每轮皆可思考：安全阀从"防 400 的粗闸"变成"按实际欠债状态精确判定"，六杠杆①在 Anthropic 路径覆盖全部工具轮（问题3 核心交付；问题1+2 块里承诺的"问题3 落地后移除临时阀"兑现——不是删除而是精确化）
- 三管道分工清晰且各自可独立验证：收集管归协议层（只懂 SSE）、挂载管归循环层（只懂轮次）、回放管归请求构造（只懂形状）——未来接其他需要回放协议的供应商时管道形状可直接复用（问题5 通道复用方向的地基）
- "展示不持久"原则边界修订落地（问题4）：推理文本仍只展示；thinking 块被明确定性为协议数据在内存链内保留——原则从一刀切变为按数据性质分层，注释中写死边界防止后人误清理（防篡改章丢一个字符就是 400）
- 验证边界：本地假服务器两轮回放端到端全绿，但真实 Anthropic API 未实测（无 key/余额）——真实签名校验严格度、多块场景（一轮多个 thinking 块）待有条件时实测（诚实标注）

**未来可优化**：
- budget_tokens 仍是固定常量 2048，可按任务复杂度分级（问题1+2 遗留项）；真实 Anthropic 实测；若未来引入消息压缩，需保证带块 assistant 消息不被截断（当前安全阀会自动降级兜底，但会损失思考能力，届时应改为"压缩时连带删工具轮"保持配对完整）

---

## 2026-08-30 11:23 | 阶段C3（问题1+2）Anthropic thinking 参数消费 + 推理分流（判定链路覆盖第二条供应商路径）

**牵连系统 / 层次**：LLM 协议层（llm/anthropic.ts + stream-helper.ts）· 验证脚本（scripts/）。注：本块仅含 C3 的问题1（判定失效）与问题2（请求形状适配），问题3（多轮回放/数据模型）与问题4（原则边界修订）未启动（用户拆分推进）

**面向的问题**：
- 判定链路在 Anthropic 路径上是断头路：C2 把判定结果（opts.thinking）送到 anthropic.ts 门口，但 chat/stream 两处 void opts 直接丢弃——用户切到 anthropic 后 thinking 配置静默失效（比报错更糟：无任何提示），六杠杆①只覆盖一半供应商（直接原因其实是两处代码未接线，字段形状不一致只是表象，本次一并修）
- 两家协议形状不同：OpenAI 兼容用 thinking:{type:'enabled'|'disabled'}，Anthropic 用 thinking:{type:'enabled',budget_tokens}——且 budget_tokens 必须严格小于 max_tokens（违反即 400），原代码两处写死 max_tokens:4096，存在隐性耦合（数字陷阱）
- 推理文本到达形状也不同：Anthropic 走 thinking 内容块的 thinking_delta 分片（而非 OpenAI 的 delta.reasoning_content），不识别则静默丢弃；若混入正文则污染 fullText——而 C1 已建好 reasoning 展示通道，此处只需接线不需新架构（复用 > 新建）
- 多轮回放未落地前的回归风险：thinking 开启后响应带 thinking 块（带 signature），下一轮不回放会 400，而回放是问题3（数据模型改造）——本次若只开不防，会把新回归引入工具循环（分段推进的代价必须被显式管控）

**做出的改动**：
- stream-helper 导出 resolveThinkingEnabled（原私有），成为两条供应商路径共用的判定单一真相源（按次覆盖 > 配置，优先级逻辑不再写第二份）；顺手修两处 body 构造的缩进回归（此前编辑工具副作用）
- anthropic.ts 新增 resolveAnthropicThinking（config + opts + messages 三参）：判定通过后额外过一道临时安全阀——历史含 assistant 消息时强制不开（回放能力未落地，防 400；问题3 落地后移除）；两处写死的 4096 提为 ANTHROPIC_MAX_TOKENS 常量，与 THINKING_BUDGET_TOKENS（2048）显式联动满足 budget < max_tokens 硬约束
- AnthropicRequest 类型加 thinking 字段（与 OpenAI 形状差异用注释点明）；chat/stream 两处 body 按判定结果条件携带（关闭时不发该键，而非发 disabled——Anthropic 无此状态）
- 流解析新增两个分支：content_block_start type:'thinking' 置块内标记（content_block_stop 复位）；thinking_delta 分片推 reasoning 展示事件（不进 full 累积，展示不持久同 C1）——两套 UI 的“🧠 推理中”/“💭 思考了 N 字”零改动直接生效（C1 事件链设计的复用红利）
- scripts/verify-c3.ts：假 Anthropic 服务器（chat 返 JSON / stream 回放预制 thinking+text 双块 SSE）8 项：参数消费、budget 约束、安全阀、覆盖优先、配置兜底、推理分流；沿用延迟退出规避 libuv 断言
- 编译验证：tsc --noEmit 零错误；全量回归 A/B 13/13、C1 8/8、C2 16/16 全绿（安全阀未破坏既有链路）
- 日志事故自纠：CHANGE_LOG 插入新条目时误将 C2 首条覆盖丢失，发现后立即补回（插入类编辑必须把保留行写进 new_text 的教训再次验证）

**解决的问题**：
- 两条供应商路径的 thinking 判定从此共用同一优先级逻辑：切到 anthropic 后配置/按次判定同样生效，静默失效消除（问题1）；协议形状差异被适配器层吸收，上层（Runtime/Loop）对两家无感知（问题2）
- 安全阀把“分段推进”的回归风险显式圈住：回放未落地前，Anthropic 路径只在无历史轮开推理（行为等同“首轮思考”），不产生 400，也不冒充完整能力（能力边界诚实）
- 验证边界：本地假服务器全绿，但真实 Anthropic API 未实测（无 key/余额）；真实服务的 signature 校验严格度、thinking_delta 实际分片行为待有条件时实测——未验证项如实标注（验证边界诚实）
- 复选框约定同前：本次无新增提示词/配置约定（纯协议层适配，对提示词与用户透明）

**未来可优化**：
- C3 问题3：多轮回放（LLMMessage 加 thinkingBlocks 字段 + signature 收集，移除安全阀）；问题4：“展示不持久”原则需为协议数据修订边界；budget 目前是固定常量，可升级为按任务复杂度分级；真实 Anthropic 实测待具备条件——下一轮从问题3 开始（用户拆分推进节奏）

---

## 2026-08-30 11:09 | 阶段C2 thinking auto 判定（Runtime 按次下发）+ TASK.md 工程侧清理（生命周期闭环）

**牵连系统 / 层次**：Runtime 编排层（runtime/runtime.ts）· Agent Loop（loop/agent-loop.ts + core/loop.ts）· LLM 协议层（llm/types.ts + stream-helper.ts + deepseek/anthropic）· 提示词/上下文层（context/system-prompt.ts）· 启动链（harness/main.ts + types.ts）· 验证脚本（scripts/）

**面向的问题**：
- C1 留下的 'auto' 是空语义：Provider 侧按关闭处理，无 Runtime 判定则配置写了也不生效（开关三态只落地了两态）
- TASK.md 无任何清理机制（代码全量搜索零匹配）：文件一旦创建永久留盘，而轮数预算判定只看“文件是否存在”——全勾选的遗留计划会造成三重误发：闲聊也被放大到 15 轮预算、C2 上线后简单对话被开推理、续传提示反复注入（用户拍板：清理放工程侧，不依赖模型自觉）
- 检测标准漂移风险：提示词层续传提示与工程侧清理都需要检测“未勾选项”，若各写一份正则将来必然漂移（约定与实现脱节）
- thinking 必须按轮判定而非会话级固定：同一会话会交替简单/复杂轮次，而 provider 在构造时拿的是静态配置——需要一条“按次覆盖”通道穿过 Loop 到达请求层（优先级高于配置）
- Anthropic 的 thinking 协议（budget_tokens + thinking 块多轮回放）水最深，C2 不应碰，但接口签名需先对齐（避免 C3 再改一遍接口面）

**做出的改动**：
- 接口层：新增 LLMRequestOptions（按次请求选项，thinking?: boolean）；LLMProvider.chat/stream 加可选第三参；AgentLoopOptions 加 thinking；RuntimeOptions/types.ts 加 thinking 模式；main.ts 用条件展开透传（适配 exactOptionalPropertyTypes）
- 判定与下发：Runtime.runSingleTurn 按模式求值（'on' 常开；'off' 常关；'auto' 仅当 taskMemory 非空时开），与 maxTurns 一起按次传入 agentLoop.run；agent-loop 把 opts.thinking 透传给 llm.stream；stream-helper 的 resolveThinkingEnabled 从“只看配置”改为“按次覆盖 > 配置”优先级解析（两处 body 构造未动，C1 单挂点设计验证有效）
- 工程侧清理：runtime.ts 新增模块级导出 loadTaskMemory（读 + 截断 + 全勾选即删，删除失败静默不阻塞请求）；旧 readTaskMemory 实例方法删除（无调用方）——清理与判定共享同一信号：全勾选文件读时已删，后续判定自然拿到 undefined（僵尸计划不污染 auto，也不需要额外的定时清理/启动清理机制）
- 单一真相源：复选框检测抽为 context/system-prompt.ts 导出的 hasUncheckedTask（兼容 "- [ ]" 与 "* [ ]"、缩进变体）；提示词层续传判定与工程侧清理共用，避免两处正则漂移；Anthropic provider 仅对齐签名不消费 opts（C3 再实现，边界显式标注）
- scripts/verify-c2.ts：假 SSE 服务器 + 假 LLM + 临时文件，验证覆盖优先级三态、Loop 透传（含缺省不下发的向后兼容）、检测标准五个变体、清理语义六种情形共 16 项；退出沿用 C1 的延迟 100ms 规避 libuv 断言；修掉初稿中 ESM 下误用 require 的一处（改导入的 unlinkSync）
- 编译验证：tsc --noEmit 零错误（修掉旧方法成壳的 TS6133）；阶段 A/B 回归 13/13、C1 回归 8/8 全绿（判定链路未破坏既有防护）

**解决的问题**：
- 'auto' 从配置摆设变为真实语义：有进行中任务自动开推理、闲聊自动关——成本/延迟的取舍由工程侧按任务状态自动裁决，不靠用户手动切换（六杠杆①的智能化落地，与⑥工作记忆信号合流：同一份 TASK.md 同时驱动轮数预算、续传、推理开关三个决策）
- TASK.md 生命周期首次闭环（创建→更新→清理全部工程侧可预期）：遗留已完成计划不再造成轮数预算/推理/续传三重误发；清理不依赖模型自觉（用户方案），也不需要新机制（借用每次请求的读路径顺带善后）
- 判定与清理共享同一信号源，行为不会互相矛盾；按次覆盖通道为后续更细粒度的判定（如按任务类型分级推理预算）预留了同一条路（接口不再改）
- 验证边界：真实供应商对 thinking:enabled 的支持仍未实测（同 C1 标注）；Anthropic 路径 opts 已接收但未消费（待 C3）——未验证项如实标注，不冒充已验证（验证边界诚实）
- 复选框约定同前：本次无新增提示词约定；清理是纯工程行为，模型无需知道文件何时被删（对提示词透明）

**未来可优化**：
- Anthropic thinking（C3，budget_tokens + thinking 块回放，协议水最深单独一轮）；auto 判定目前仅 TASK.md 单一信号，可补充启发式（用户输入长度/关键词）作无计划时的辅助判定；unlinkSync 失败静默吞，可接诊断记录（warn:runtime）；验证脚本可并入统一回归入口（目前三个脚本手动依次跑）——C3 路线明确，本次不启动（阶段隔离）

---

## 2026-08-30 10:38 | 阶段C1 thinking 开关（配置→请求→流解析→展示 四段链路打通）

**牵连系统 / 层次**：LLM 协议层（llm/types.ts + stream-helper.ts）· 配置子系统（config/）· Agent Loop（loop/）· 事件层（runtime/events.ts）· 两套 UI（io/ui/）· 验证脚本（scripts/）

**面向的问题**：
- 模型推理能力被物理关闭：stream-helper 两处写死 thinking:disabled（当初为 tool loop 稳定），复杂任务模型"裸答"，无推理缓冲——思维链六杠杆中见效最快的单一开关被一行代码锁死（上轮断链诊断结论）
- 开关若做成硬编码切换，简单任务也被迫等推理（延迟/成本双输）——需要三态配置而非布尔开关；'auto' 预留但 C1 不实现判定（避免一次改动跨 Runtime/Provider 两层，风险隔离）
- 开启后推理内容会先于正文流式到达，若不识别会被静默丢弃（浪费），若混入正文则污染 finalText/会话历史/兜底回溯——需要专用事件通道分流（展示不持久）
- 推理文本可能几千 token，直接灌屏噪音大；完全不展示则用户只见长时间无输出（体验断链）——展示策略需要分层：轻量指示而非全文倾倒
- 缺省行为必须与改动前完全一致（向后兼容）：未配置时等同关闭，存量行为零变化；验证需覆盖三态+缺省而不只是开启态（避免回归盲区）
- Windows 上验证脚本 server.close 后立即 process.exit 触发 libuv 断言（崩溃非业务错误），验证基础设施需要可靠的退出路径（后续脚本可复用）

**做出的改动**：
- LLMConfig 新增 thinking 可选字段（'auto'|'on'|'off'）；config/manager 从 active-config 透传（不写时缺省，不引入新必填项）
- stream-helper 新增 resolveThinkingEnabled 单一挂点：'on'→enabled，其余（含 'auto'）→disabled；两处请求构造改按它求值——C2 的 Runtime 判定只需改这一个函数，不再碰两处 body 构造（挂点收敛）
- 流式解析新增 delta.reasoning_content 分支：推独立 {type:'reasoning'} 事件，不进 full 累积——finalText/历史/兜底回溯只拿正式答案，推理仅供展示（展示不持久，会话存储零膨胀）
- 事件链：LLMStreamEvent 加 reasoning 变体 → agent-loop 透传为 stream_reasoning（不进 turnText/不走 onToken，与 stream_text 同构）→ 两套 UI 各自适配：TerminalUI 首片切 spinner 为"🧠 推理中"（零噪音指示）；TreeUI 只累计字数，收尾在回复框顶部一行灰色摘要"💭 思考了 N 字"（告诉用户想过多久，不倾倒全文）——展示粒度按 UI 形态各自最小化，不引入新组件（改动面收敛）
- scripts/verify-c1.ts：本地假 OpenAI 兼容 SSE 服务器（捕获请求体 + 回放预制流），验证三态+缺省请求参数、reasoning/正文分流、非流式不污染共 8 项；退出用延迟 100ms 规避 Windows libuv 断言（后续脚本可复用）
- 编译验证：tsc --noEmit 零错误；阶段 A/B 回归 13/13 全绿（reasoning 分支未破坏既有防护）
- 配置文件：active-config.json 与 example 加 thinking: 'auto'（缺省安全：行为与改动前完全一致，手动改 'on' 即启用）

**解决的问题**：
- 阶段 C1 把"被一行代码关着的推理能力"变成三态可配：'on' 即开，缺省零回归；推理与正文分流保证思维链增强不污染答案链路（六杠杆①落地，与②③⑥ 已落地的杠杆叠加而非互斥——提示词教方法、计划给结构、记忆保不丢、thinking 给深度，四层同向）
- 展示策略按 UI 形态各自最小化（不引入新组件），验证脚本可重复（回归秒级）；'auto' 判定挂点收敛在单一函数，C2 改动面预先最小化（为下一阶段铺路）
- 复选框约定同前：本次无新增约定；thinking 配置项是配置层约定（写入 active-config，不进入提示词层——模型无需知道开关状态，推理与否对提示词透明）
- 验证边界：本次未验证真实供应商对 thinking:enabled 的支持（代理层行为未知），待用户手动改 'on' 后实测（若代理不支持会报错而非静默降级，错误已由阶段 B 的 catch 暴露机制可见）——未验证项如实标注，不冒充已验证（验证边界诚实）

**未来可优化**：
- 'auto' 判定（C2，复用 TASK.md 存在信号）；Anthropic 路径 thinking（C3，budget_tokens + thinking 块回放，协议水最深单独一轮）；推理展示可升级为可折叠区域（需要新 UI 组件）；非流式 chat 的 reasoning_content 目前忽略（若 compaction 需要再补）；推理延迟可配合 UI 的 thinking 阶段指示细化（预估剩余时间）——C2/C3 路线明确，本次不启动（阶段隔离）

---

## 2026-08-30 10:19 | 阶段B 计划驱动循环（TASK.md 复选框清单 + 续传提示）+ 空流区分兜底 + 验证脚本化

**牵连系统 / 层次**：提示词 core 层（context/sections/core-section.ts）· SystemPromptService（context/system-prompt.ts）· Agent Loop（loop/agent-loop.ts）· Provider 层（llm/）· 验证脚本（scripts/）

**面向的问题**：
- 规划只是口头描述：模型"给出方案"后执行中易跑偏，断点续传无结构化依据（阶段 A 给了地图的位置，本次把地图实体化）
- 冒烟实测发现新误报：流被异常中断（401 余额不足）时空流静默走完循环，兜底文案误报"达到最大轮数"
- provider 的 catch {} 吞错，上层只见空流，真实错误无定位线索（排查靠猜）
- RPC 协议并发处理请求行，外部脚本无法串行化 create→switch→chat（验证基础设施缺失）

**做出的改动**：
- core-section 规划步从"给出方案与步骤清单"升级为"必须用 write 把复选框（- [ ]）步骤清单写入 TASK.md"；【工作记忆】段写明复选框约定（- [ ] → - [x]）与续传提示的响应方式（提示词层教模型）
- SystemPromptService.build 检测 task 清单是否有未勾选项（正则），有则 task 层追加 [续传提示]（从第一个未勾选项继续）——系统发信号、提示词教响应，两边对暗号；全勾选/无 TASK.md 时不注入，零噪音（工程层发信号）
- Agent Loop 增加 finishedEarly 标记区分退出原因：空流提前退出 → 空内容提示 + warn:llm 诊断；真轮数耗尽 → 结构化进展总结；两类兜底各自精准，不再互相冒充（阶段 A 兜底的补丁）
- 两个 provider 的静默 catch 改为 console.error 暴露真实错误（阶段 B 冒烟直接靠它定位到 401 CreditsError）
- scripts/verify-phase-ab.ts：脚本化假 LLM/假工具验证 A1/A2/A3/B1 共 13 项（不消耗真实 API，秒级可重复）；scripts/rpc-smoke.mjs：RPC 串行喂料器（等上一条响应再发下一条，规避协议并发竞态）
- 编译验证：tsc --noEmit 零错误；真实链路冒烟初次受阻（OpenCode Go 余额不足 401），更换 API key 后重跑通过（2.8s 真实响应）

**解决的问题**：
- 计划从"口头表述"变为"持久化复选框清单"：压缩碰不到、断链后可从第一个未勾选项续传（②③⑥ 组合拳的最后一环落地）
- 空流误报消除：余额不足/密钥无效等场景用户看到准确原因指引，真实错误在终端与诊断可见（从"猜"到"读一行"）
- 阶段 A/B 全部防护逻辑有可重复的自动化验证，回归成本秒级；临时会话文件已清理不污染默认会话（RPC 支持临时会话验证是意外收益）
- 复选框约定（- [ ]）同时是给人看的进度和给系统检测的协议，一份载体两个用途；提示词（约定）与工程（检测）分属两层，互不侵入（续传检测在分层架构的 task 层，不碰稳定前缀）

**未来可优化**：
- 续传提示只认 "- [ ]" 格式，模型若用中文复选框（□/☑）会漏检（正则可放宽或提示词强化约定）；可统计 TASK.md 复选框推进率作为效果度量；rpc-smoke 可并入验证流程（需有余额的供应商）；阶段 C（thinking 开关）的多轮回放设计待启动

---

## 2026-08-30 10:00 | Agent Loop 可靠性防护：重复失败检测 + 轮数耗尽收尾 + 轮数预算分级

**牵连系统 / 层次**：Agent Loop（loop/ + core/loop.ts）· Runtime 编排层（runtime/）· 提示词 core 层（context/sections/core-section.ts）

**面向的问题**：
- 重复失败断链：模型可用相同参数反复调同一工具烧完全部轮次，无任何防护提示（上一轮"断链诊断"识别的高频断链模式）
- 轮数耗尽断链：MAX_TURNS=5 用尽后把最后一条消息原始内容（可能是工具 JSON 输出）直接抛给用户当最终回复，最暴力的断链点
- 轮数预算一刀切：带计划的复杂任务也只有 5 轮，常中途断掉；无计划的闲聊却不需要更多轮次
- 失败判定若一刀切会把 NOT_FOUND/NO_MATCH 类"有效否定"误判为失败，干扰模型正常的探索行为（如换关键词重搜）

**做出的改动**：
- 重复失败追踪器：调用 key = 工具名 + 规范化参数（顶层 key 排序），同 key 连续失败 2 次追加"换策略"提示、3+ 次追加"弃路径"提示；换了调用或同调用成功即重置；仅建议不硬阻断（避免误伤合理重试）
- 失败三分类：硬失败（异常/[ERROR]/[VERIFY_FAILED]）才计；有效否定（NOT_FOUND/NO_MATCH/EMPTY）不计；用户拒绝提前 continue 不进检测（用户意志不是模型的错）
- 提示注入点选在"追加进失败工具结果的 content"而非新增消息：新增 user 消息经 Anthropic 转换后与前一条（也是 user）连续，违反 user/assistant 交替约束直接 400；追加进 tool 结果对两种协议都是自由文本，协议安全（与既有的连续 tool_result 合并同一设计模式）
- 轮数耗尽收尾：最后一轮前注入收尾提示（停止新步骤 + write 进度入 TASK.md + 返回总结）；耗尽后兜底从"抛原始内容"改回溯最后 assistant 进展说明 + warn 诊断；配套 core-section 铁律"断点纪律"教模型如何响应信号（工程发信号 + 提示词教响应，两边对暗号）
- run() 增加按次 opts.maxTurns；core/loop.ts 新增 AgentLoopOptions；Runtime 检测 TASK.md 存在时从 DEFAULT_MAX_TURNS(5) 放大到 WITH_PLAN_MAX_TURNS(15)——计划给了循环"地图"，配断点续传允许更长推进；向后兼容（缺省参数不变行为）
- core-section 铁律新增两条：收尾必验证（写/改代码必跑测试/编译再汇报）——验证闭环的提示词层最小落地；断点纪律——与收尾信号配套；重复失败提示与既有【工具增强推理】段形成呼应（失败后先查再换路）
- 编译验证：tsc --noEmit 零错误（修复一处 TS 控制流窄化：三元赋值中读写同一变量导致 else 分支 never）

**解决的问题**：
- 同一路径反复失败被及时提醒换策略，不再无声烧完轮次；失败分类不误伤探索行为与用户拒绝
- 轮数耗尽时用户看到的是结构化进展总结（完成了什么/没完成什么/可说"继续"），而非工具原始输出；进展落盘 TASK.md 支持断点续传，轮数上限从"硬断链"变"软断点"
- 复杂任务轮数预算 3 倍（5→15）且由"有无计划"自动区分，简单任务不受影响、防死循环底线不变；注入方式对 OpenAI/Anthropic 双协议安全，无转换层改动；全部防护是建议性引导，模型自主权保留；提示词（铁律）与工程（信号/检测）两层配套，不是单侧改动；向后兼容：缺省不传 opts 时行为与之前完全一致，仅兜底质量提升

**未来可优化**：
- NOT_FOUND/NO_MATCH 类"空结果"连续重复时可另给换路径/关键词的差异化提示
- 轮数预算可移入 active-config 做用户级配置
- 提示词层引导可升级为"收尾前主动检查 TASK.md 未勾选项"（阶段 B 计划驱动循环的入口）
- 重复失败追踪目前仅看连续同 key，跨轮的"变参反复失败同目标"（如路径猜错三次）暂未识别，可升级为按工具+目标相似度聚类

---

## 2026-08-28 19:18 | 工作记忆层（TASK.md 独立持久通道，压缩不触碰）

**牵连系统 / 层次**：SystemPromptService（context/ + core/）· Runtime 编排层（runtime/，注入）· 提示词 core 层（context/sections/core-section.ts）

**面向的问题**：
- 任务计划/进度只存在于对话历史里：不结构化、随历史漂移、被压缩后"失忆"（断链根因）
- 需要独立于对话历史的"工作记忆"通道——压缩只压缩 jsonl 历史，工作记忆必须不被触碰

**做出的改动**：
- SystemPromptContext 新增 `task?` 字段；SystemPromptLayer 新增 `task` 层；build 在 skills 后、summary 前插入 task 层（`## 当前任务（工作记忆）`）
- Runtime 新增 `readTaskMemory()`：每次请求读工作目录 `TASK.md`（存在才注入，截断 2000 字符防膨胀，读失败静默跳过）
- core-section 新增【工作记忆】引导段：复杂任务开始用 write 建 TASK.md（目标/计划/进度/经验），每完成一步 write 更新

**解决的问题**：
- 压缩保留的本质解耦：TASK.md 在文件系统，compaction 只操作 jsonl 消息数组 → 压缩**物理上碰不到工作记忆**
- 注入与压缩解耦：每次请求重新读文件注入，历史裁掉多少都不影响 task 层
- 任务状态从"埋在长对话里"变为"结构化可查"，模型随时知道做到哪、下一步做什么

**未来可优化**：
- 压缩摘要结构化（提取任务状态字段作兜底，即使模型漏建 TASK.md 也保真）
- 多会话隔离（当前 TASK.md 在工作目录全局共享；可迁会话目录）
- TASK.md 与 compaction 的联动：压缩发生时提示模型刷新 TASK.md

---

## 2026-08-28 18:25 | 思维链强化·阶段1：任务方法论提示词 + 工具增强推理（ls 工具）

**牵连系统 / 层次**：SystemPromptService core 层（context/sections/core-section.ts）· 工具子系统（tools/builtin.ts）· Agent Loop（loop/agent-loop.ts，接住工具结果）

**面向的问题**：
- core-section 只是"别乱调工具"的约束型提示词，模型接到复杂任务不会"按章法办事"（先理解→规划→分步→验证）
- 推理受阻时模型靠脑补而非用工具确认事实/计算结果，思维链质量低（杠杆⑤缺失）
- 缺 ls 工具，模型无法先看清项目结构再动手（read/grep 需要已知路径，没有"看结构"的入口）

**做出的改动**：
- core-section 升级为任务方法论（杠杆②）：场景判断（普通对话直答 / 实际任务主动用工具）→ 任务执行流程（先理解→规划→分步→验证→总结）→ 工具增强推理引导（不确定就查、算不清就跑）→ 铁律
- 新增 ls 工具（杠杆⑤）：node:fs 递归列目录，目录带 / 后缀，跳过 .git/node_modules/dist 噪音，默认 depth 1、上限 200 项，统一 [OK]/[NOT_FOUND]/[EMPTY] 格式

**解决的问题**：
- 模型接到实际任务有明确流程可循，不再是"直接甩代码"
- 工具增强推理有落点：结构不确定用 ls/read/grep、计算用 bash 验证，基于真实结果继续推理
- 工具从 4 个扩到 5 个，llm 的 tools 参数自动带上 ls（ToolRegistry.getLLMTools）

**未来可优化**：
- 新增 fetch（网页抓取）/ 并行 read（批量读多文件），见 ROADMAP P7 实用工具补全
- 任务分解（Orchestrator-Workers） + TASK.md 工作记忆（杠杆③⑥，下一阶段）
- 验证修正闭环（Evaluator-Optimizer）+ 模型推理模式开关（杠杆④①）

---

## 2026-08-28 16:40 | 提示词缓存优化：分层 system 消息 + Anthropic 缓存断点

**牵连系统 / 层次**：SystemPromptService（context/ + core/）· CompactionService（context/ + core/）· Runtime 编排层（runtime/）· Provider 转换层（llm/anthropic.ts）

**面向的问题**：
- 系统提示词是单条动态混合体（工具/技能/规则/摘要一次 build），任一动态部分变化即整条缓存失效，命中率低
- 会话摘要被 unshift 进 `history[0]` 污染历史前缀；runtime 又从 `history[0]` 提取摘要，历史中的摘要消息被二次发送
- Anthropic 接入时：分层 system 消息互相覆盖（只留最后一条）；无 `cache_control` 断点则缓存不生效；tools 参数误传 OpenAI 格式会 400；并行工具调用产生连续 user 消息违反交替约束

**做出的改动**：
- SystemPromptService.build 改返回**分层 system 消息数组**（core → tools → skills → summary，稳定前缀在前）；Config 段落按 core/tools/skills 三组配置；`before_request` hook 从改写单字符串升级为改写消息数组
- CompactionService.maybeCompact 改返回 `{ history, summary }`，摘要独立交付，不再混入历史；runtime 按分层展开 + 干净历史拼装
- Anthropic 转换层：system 改文本块数组逐条保留；稳定段（core/tools/skills）各设一个 `cache_control` 断点、摘要段不设，tools 参数末工具设第 4 个断点（达官方推荐上限）；tools 改 `{name, input_schema}` 格式；连续 tool_result 合并进单条 user 消息；`is_error` 按 `[工具` 前缀判断

**解决的问题**：
- 稳定前缀缓存命中率提升：工具/技能/摘要各自变化只作废对应层及之后的缓存，人设层照常命中
- 消除摘要污染历史前缀 + 二次发送；OpenAI 兼容层（自动缓存前缀）与 Anthropic（显式断点）两条路径在分层设计下自洽
- Anthropic 从"分层即坏"到"带缓存断点可用"

**未来可优化**：
- 长文档/参考文档层预留位（TODO 已标在 core 之后、tools 之前，可插入稳定参考不破坏现有前缀）
- OpenAI 兼容层若遇到严格要求单条 system 的服务，需在 stream-helper 合并连续 system
- Anthropic 流式 `message_delta` 的 `stop_reason` 未利用，工具断点/截断语义待接入 Agent Loop
- `tool_result.is_error` 依赖 `[工具` 前缀启发式判断，工具结果结构化后可精确化

---

## 2026-08-15 | 系统提示词子系统化 + 扩展系统自动装载

**牵连系统 / 层次**：SystemPromptService（context/ + core/）· EventBus（runtime/ + core/）· extension-loader（context/）· extensions/ · Runtime

**面向的问题**：
- 系统提示词硬编码在 runtime.ts 的字符串里，不可扩展、不可配置
- 出现 hook 需求，但不应另起炉灶新建 HookBus，需复用现有 EventBus
- 扩展段落/钩子要自动装载——从层次1（改 main）演进到层次3（用户改代码即生效）

**做出的改动**：
- SystemPromptService 子系统（core 接口 + Impl）：配置驱动（段落列表）+ 发请求时动态计算 + hook 改写（before_build / before_request）
- 段落可插拔：core/tools/skills 三内置段落 + 兜底提示词，用户写 TS 模块即扩展
- 扩展系统自动装载：extension-loader 扫描 extensions/sections/ + extensions/hooks/，export registerSections / registerHooks 即生效
- EventBus 泛型化（EventBus<T>，默认 unknown），PromptEventEmitter implements EventBus<RuntimeEvent>；emitHook 开放 public
- 补漏接口：SystemPromptService 建 core 接口、PermissionManager implements PermissionProvider

**解决的问题**：
- 系统提示词从"改代码"变为"配置 + 扩展"，可插拔可改写
- hook 复用 EventBus.on，不引入重复机制
- 扩展系统用户零侵入：新建文件即装载

**未来可优化**：
- 段落分层声明（当前用户扩展段落固定并入 core 稳定层，见 8-28 缓存优化）
- hook 生命周期细化（工具调用钩子 beforeToolCall/afterToolCall，ROADMAP P6）

---

## 2026-08-12 ~ 08-13 | P5 多系统分离（全对称子系统化 + 命名规范）

**牵连系统 / 层次**：core/ 接口层（9 接口）· session/ · tools/ · context/ · loop/ · commands/ · diagnostics/ · runtime/ · harness/

**面向的问题**：
- Runtime 既创建子系统又负责编排，职责膨胀
- 子系统实现与接口耦合，instanceof 判断破坏抽象（如压缩强 cast 到 JsonlSession）
- 命名混乱（Adapter/Manager/Storage 混用），无法从名字判断角色

**做出的改动**：
- 多系统全对称：core/ 补 4 接口（compaction/loop/commands/diagnostics），8 子系统全部 implements core 接口
- Runtime 构造注入所有子系统（不再 new），prompt 只剩编排；main 显式组装注入
- 命名规范统一：执行类 Service + Impl（CompactionService/AgentLoopService/CommandService/DiagnosticsService）、能力提供 Provider、数据类 Storage/Store/Bus
- CompactionStore 接口独立（压缩存储能力），jsonl 双实现，InMemory/Mock 明确不支持
- REPL 抽离 harness/repl.ts 与 rpc.ts 对称；PermissionManager 迁 permission/manager.ts 修实现错位

**解决的问题**：
- 系统边界清晰、可独立替换、测试友好
- 抽象不被 instanceof 破坏，注入即依赖声明
- 命名即角色，代码可读性提升

**未来可优化**：
- 正式测试套件（vitest）建立子系统单测回归（ROADMAP P6）
- 结构化 trace/span 可观测层（ROADMAP P6）
- 模块数 20+ 后评估 DI 容器（ARCHITECTURE.md 决策6 预留）

---

## 2026-08-06 ~ 08-07 | 配置系统重构 + 协议层抽象 + 可靠性工程

**牵连系统 / 层次**：config/（manager）· llm/（provider.ts）· harness/（check）· commands/（/model）· diagnostics/

**面向的问题**：
- 配置散落多文件、无分层，provider-registry 冗余
- 启动无自检，配置坏了才在运行时暴露；错误不可追踪
- /provider 与 /model 两命令职责重叠

**做出的改动**：
- 删 provider-registry，新建 config/manager：配置分层（环境变量 > 全局 ~/.ts-agent > 项目 keys > 项目 active），active-config 不再含 apiKey
- 协议层抽象：Provider 对象（数据 + 行为自包含）+ ProviderRegistry + createProviderFromConfig；createProvider 去 switch
- 命令合并：/provider + /model → 单一 /model（一级供应商、二级模型）
- 可靠性工程：Diagnostic 公共类型 + check 逐项启动自检（配置/API key/连通性/模型列表）+ 严重度分级 + 运行时诊断队列 + debug-runtime.log 落盘 + /diagnostics 命令

**解决的问题**：
- 配置单一真相源、分层可覆盖；Provider 对象化让"换供应商"变成"换对象"
- 错误启动即暴露；运行时错误可追溯可查看

**未来可优化**：
- 会话级配置层（config/manager 顶部 TODO 已标注）
- 诊断可视化 / 结构化上报

---

## 2026-08-05 | 工具调用升级 function calling + 会话存储重构为 entry 树

**牵连系统 / 层次**：tools/ · llm/（协议层）· session/（jsonl-storage）· commands/（/history）

**面向的问题**：
- `<tool_call>` 标签解析脆弱，依赖 fixJSON 文本补丁，非结构化
- 会话线性存储不可分叉，历史回溯/多分支能力弱

**做出的改动**：
- 工具调用升级 function calling：API tools 参数 + tool_calls 结构化事件，废弃标签解析；删除 parseToolCalls / createToolCallFilter / fixJSON；系统提示词移除标签引导
- 会话存储重构为 entry 树 + leaf + fork（对齐 Pi）：消息带 parentId、leaf 指针持久化、摘要入树为 compaction entry；/history 改分叉（fork 复制前缀，原历史保留）

**解决的问题**：
- 工具调用结构化稳定，无需文本补丁
- 会话可分叉回溯，支持多分支探索

**未来可优化**：
- 旧 v1 线性格式已归档（sessions/archive-v1/），迁移工具
- 分支摘要：fork 后旧分支上下文摘要回填新分支（ROADMAP P6）

---

## 2026-08-02 | UI 自研组件树（替代 pi-tui）

**牵连系统 / 层次**：io/ui/（components/screen/input-handler）· io/terminal.ts

**面向的问题**：
- pi-tui 在 Windows 终端同步输出协议不兼容（乱码/空行/闪退）
- 第三方 UI 框架不可控，无法精细处理中文与差分布局

**做出的改动**：
- 卸载 pi-tui，自研组件树（Container/Text/SelectList）+ Screen 差分渲染（行数组快照 + 只清行/光标移动，避开同步输出坑）+ InputHandler（raw mode 逐键解析）
- 配套：wrapText 按可见宽度折行 + 中文标点禁排；fitWidth 防终端 wrap

**解决的问题**：
- 终端渲染稳定可控，中文对齐正确
- 差分渲染避免整屏重绘闪烁

**未来可优化**：
- 虚拟滚动（长对话渲染）
- 选择器固定行数回退方案（FIXED_LINES）在极端窄终端下的边界

---

## 2026-07-30 | LLM Provider 工厂路由（多协议接入）

**牵连系统 / 层次**：llm/（index/deepseek/anthropic/provider）

**面向的问题**：
- 只支持 deepseek 单一协议，接入新厂商需改代码

**做出的改动**：
- LLMConfig.provider 字段路由 deepseek/openai/anthropic/opencode-go
- 新增 AnthropicProvider（消息格式转换 + API 端点 + SSE 解析适配）；AnthropicAdapter 统一改名 Provider
- 供应商定义迁 config/providers.json 运行时载入；API Key 支持环境变量（apiKeyEnv）；模型列表启动远程拉取失败兜底 staticModels

**解决的问题**：
- 多厂商可插拔，新增供应商不动核心
- 供应商配置与密钥分离，密钥可走环境变量

**未来可优化**：
- Ollama 等更多协议接入（ROADMAP TODO）
- 后续 8-28 已补充 Anthropic 缓存断点 + 工具格式修正

---

## 2026-07-27 | 工具系统 + 命令自动扫描 + 事件组合模式 + EventStream

**牵连系统 / 层次**：tools/（registry+builtin）· commands/（loader）· runtime/（events/event-stream）· io/ui/

**面向的问题**：
- 工具调用逻辑内嵌 runtime.ts，无法扩展新工具
- 命令硬编码，新命令需改 main
- 事件系统用继承耦合（Runtime 继承 emitter），扩展受限于单继承

**做出的改动**：
- 工具系统：ToolRegistry + read/write/grep/bash 四核心工具 + Agent Loop（chat 检测 → stream 输出双阶段）
- 命令系统自动扫描：Loader 基类 + CommandLoader + SkillLoader（scanFiles 扫描约定目录）
- 事件系统改组合模式（Runtime 持有 PromptEventEmitter 而非继承）；新增 EventStream 推拉通道统一 LLM 流式输出
- 工具调用逻辑抽离 utils.ts；工具输出统一 `[STATUS_CODE]` 格式

**解决的问题**：
- 工具/命令/技能可扩展，新增即放文件
- 事件低耦合，流式统一通道

**未来可优化**：
- 工具参数 schema 自动校验（ROADMAP P6，替代手动 requireString）
- 工具调用钩子 before/afterToolCall（ROADMAP P6）

---

## 2026-07-23 | 项目结构分层（core/harness/runtime/io/utils）

**牵连系统 / 层次**：整体目录结构 · src/

**面向的问题**：
- 扁平结构（main.ts/types.ts/init.ts 平铺），职责不清、依赖混乱

**做出的改动**：
- 按 core（接口/类型）/ harness（编排启动）/ runtime（运行时编排）/ io（终端 I/O）/ utils（工具）分类
- 移除 init.ts，main.ts 迁 harness/main.ts 持有 REPL/RPC 模式分发；Mode 枚举（Repl/Rpc）
- SessionStorage 接口 + InMemory/Mock 实现

**解决的问题**：
- 目录即架构，职责边界可见
- 为后续多系统拆分（P5）铺路

**未来可优化**：
- 后续演进见 P5 多系统分离（2026-08-12 已实现）

---
