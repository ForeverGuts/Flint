# 🧪 测试策略

> 现状：**不用任何测试框架**。<!-- BEGIN AUTOGEN:test-summary -->19 套零依赖验证脚本、合计 **791 项**断言<!-- END AUTOGEN:test-summary -->，`npm run verify` 一条命令串跑；另有 1 个真实链路冒烟脚本。
> 本文档描述"实际是怎么测的"，不是"打算怎么测"。（旧版写的"测试框架未选型"已过期多年。）

---

## 一、选型：为什么没有测试框架

`package.json` 里**没有 `dependencies` 字段**（零运行时依赖），`devDependencies` 只有三个：`@types/node` / `tsx` / `typescript`。

要验的东西大多不适合框架的抽象：起假 HTTP 服务器演协议、夹逼 TTY 宽度、手工喂事件看配对、计启动阻塞的毫秒数。这些用 `node:http`、`process.stdout.columns`、直接构造对象写出来更直白，加一层 Vitest / Jest 反而要多学一套 API 与配置。

这**不是待定项而是已定结论**：ROADMAP P6 曾挂着一条“引入 vitest”的待办（立项于 2026-08-14），与本文立场矛盾，已于 2026-09-03 勾选关闭；二选一的完整取舍（含“立项时写的痛点已消失”与“迁移期会出现两套测试体系”两条理由）记在 [DECISION_LOG.md](./DECISION_LOG.md)。

**换来的代价**（都是真缺口，见第七节）：没有覆盖率、没有 watch 模式、没有测试隔离机制（每个脚本自己管副作用与临时文件）。

## 二、验证脚本清单

全部在 `scripts/` 下，<!-- BEGIN AUTOGEN:test-counts -->**项数合计 791**（其中 18 套是 `.ts` 走 tsx、1 套 `.mjs` 直跑）<!-- END AUTOGEN:test-counts -->。其中 `verify-edit.ts`、`verify-permission.ts` 与 `verify-tools.ts` 均为 2026-09-04 新增，`verify-spec.ts` 为 2026-09-06 新增，`verify-steering.ts` 为 2026-09-10 新增，`verify-doc-numbers.ts` 为 2026-09-11 新增，`verify-todo.ts` 为 2026-09-11 新增：

| 脚本 | 项数 | 验什么 | 手法 |
|------|-----:|--------|------|
| `verify-phase-ab.ts` | 17 | 阶段 A1/A2/A3/A4/A5 + B 计划驱动循环、重复失败保护（A4 钉“参数无效 `[INVALID]` 也计入失败”、A5 是它的**对照组**“有效否定 `[NO_MATCH]` 不计”）、轮数耗尽优雅收尾 | 脚本化假 LLM |
| `verify-c1.ts` | 8 | thinking 三态是否下发到请求体、`reasoning_content` → `reasoning` 事件 | **本地假 OpenAI 兼容服务器**：捕获请求体 + 回放预制 SSE/JSON |
| `verify-c2.ts` | 14 | auto 判定按次下发、覆盖优先级（opts > config）、复选框检测（含 `[>]` 进行中；"全勾选即删"的清理语义已随 C 方案迁至 `verify-todo.ts`） | 驱动 AgentLoop 与 stream-helper，用假 llm 断言下发参数 |
| `verify-c3.ts` | 17 | Anthropic thinking 参数消费、budget 约束、精确安全阀、多轮回放端到端 | 假 Anthropic 服务器 + **真实 AgentLoop** 驱动两轮 |
| `verify-input.ts` | 22 | 多行粘贴不被吞、控制键解析、缓冲区状态 | 造场景把 chunk 喂给 InputHandler |
| `verify-ui.ts` | 86 | 框宽随终端自适应、宽字符测宽、emoji 代理对不被劈开、流式渐进渲染、回合指示器、**常驻任务面板**（完成 ✓ / 进行中 ▶ / 待办 ☐；空清单零行即收起；面板画在输入框上方） | 造 TreeUI + `setCols()` 改终端宽度；面板⑧ 段**真走一遍 `start()`**（订阅挂在那里），先把 `process.stdin` 换成哑对象——否则 `resume()` 会让测试进程退不出去 |
| `verify-usage.ts` | 22 | L3 真实 usage 两条协议路径、索取用量的兼容降级 | 一台假服务器**按 URL 分流演两种协议** |
| `verify-startup.ts` | 32 | 启动关键路径 0 次 fetch、模型列表预热 / inflight 去重 / 新鲜期 | 临时配置文件 + `FLINT_CONFIG` 指过去，造多家供应商 |
| `verify-events.ts` | 76 | 总线盖戳、四组骨架段配对守恒、便签通道、落盘端到端、`/traces` 排版 | **手工构造事件对象喂给 SpanCollector** |
| `verify-extensions.ts` | 21 | 三类扩展各自装载、watcher 的 ctx 里确实没有 `on` | **探针法**（见第六节） |
| `verify-session.ts` | 66 | 会话存储契约收敛后的行为等价：三个实现的可选成员真值表、“能力探测 ≡ instanceof”穷举对比（3 实现 × 3 成员）、`msgId` 兜底链、fork 后**原文件一字未动**；⑨ 段（2026-09-04 新增 19 项）钉死 `tool_calls` 持久化的三层真相——真往返证明存储**不是**纯文本、`thinkingBlocks` 无处可存、入口未接线、出口那道丢弃是承重的 | 造真 `Runtime` 但只注入真 session（其余 10 个必注入用替身）+ `fs.mkdtempSync` 临时目录 |
| `verify-edit.ts` | 41 | `edit` 工具的“肯拒绝”性质与字节级保真：唯一命中才改、0 命中与多命中都拒绝且文件**逐字节一字不动**、多命中回报正确的候选行号、`replaceAll` 才全改、纯 CRLF / BOM / 混合行尾、参数边界（newText 空串=删除、缺参不静默删光）、权限弹窗文案的单行契约 | 真 `ToolRegistry` + `registerBuiltinTools`（不打桩），`fs.mkdtempSync` 临时目录里造各种行尾/BOM 的文件，按**字节**比对（不去断言 Node 编码读会不会剥 BOM 这类行为细节） |
| `verify-permission.ts` | 62 | 授权键的边界与匹配规则：`write` / `edit` 的键是路径、`bash` 的键是完整命令且**一字不截**；`PermissionManager` 精确匹配（截断级与前缀级授权都已消失，含“改前确实会放行”的**对照组**）；文件级放宽是刻意的；`clear()` 接线的**行为证明** | 真 `ToolRegistry` + 真 `PermissionManager`（不打桩）；⑦ 段造真 `Runtime`，只把 permission 与 session 换成会计数的替身 |
| `verify-tools.ts` | 74 | `grep` 与 `bash` 两个工具的**功能**面。grep：真遍历 / 真行号 / 递归 / 跳过噪音目录与二进制与超大文件 / include glob / JS 正则能力 / 50 命中上限，以及“跑不起来 ≠ 没有匹配 ≠ 我正则写错了”三者必须分开。bash：子进程输出解码（外部程序 UTF-8 vs cmd.exe 内建命令走代码页）、三条返回前缀与 agent-loop 成败判定的**双向**契约、stderr 回传、cwd 继承、maxBuffer 超限、截断前后的行数与字符数一致 | 真 `ToolRegistry`（不打桩），`fs.mkdtempSync` 临时目录里造一棵带 node_modules / .git / 二进制 / 2MB 超大文件的目录树；bash 用临时目录里的 `emit.js` 当被测子进程，**不靠 shell 引号传代码**（避开 cmd.exe 与 sh 的引号规则差异）；⑦ 段是源码文本断言，且**先切出 grep 那一段再断言**——裸扫全文件会被解释性注释误伤（本轮实踩过两次） |
| `verify-spec.ts` | 46 | 工具**参数规格**框架（`src/tools/spec.ts`）：一份 spec 派生三样（发给 LLM 的 Schema / 运行时 `parse` / handler 入参类型）是不是**真的同源**（含对照组：只改 spec 里一个键，两个派生物必须同时跟着变）、`String(val)` 那个“永远通过的校验”留下的四个类型盲区是不是全堵（数字 / 对象 / 数组 / 布尔）、错误文案逐字不变、7 个工具的 Schema（6 个旧工具与改造前**逐字相同**，外加新增的 todo）、4 个校验件与手写 boolean 强转的消失、以及 `execute` 真的会跑 `parse`（接线证明） | 真 `ToolRegistry` + `registerBuiltinTools`（不打桩）；样本规格用构造器**现搭**、不从生产源码导（顺带把构造器本身也测了）；④ 段比 `scripts/fixtures/tool-schemas-baseline.json`（改造前**机器导出**的快照，不是手打的）；⑤ 段是源码文本断言，且**先切段再断言**（edit 段按第一个 `handler:` 分界）——整行剥注释剥不掉块注释里折行的续行，本轮实踩过 |
| `verify-steering.ts` | 48 | 内层引导（steering）：工具跑完、下一次 LLM 调用前取件注入**最后一条 tool 结果**（不是新开 user 消息——tool 结果在 Anthropic 下已是 user 角色）、当轮可见、逐条消费不堆叠、缺省不传时向后兼容；两条**不吞消息**的护栏（本轮无工具调用→不取件、已是最后一轮→不取件）；**落盘**为 assistant **之前**的独立 user 条目（带标记前缀，含"无引导时形状不变"的对照组）；**适配器同角色归并**（抓真实请求体：三条并两条、正文不丢不粘、序列严格交替，含"无相邻同角色时不合并"与"连续 tool 结果仍合并"两条对照组）；OpenAI 兼容路径原样透传的**不对称登记** | 脚本化假 LLM；S6/S7/S8 造**真 `Runtime`**（只注入真 llm/session，其余 10 个必注入用替身）端到端验证接线与落盘；S9/S10 起本地 `http` 假服务器抓**真实请求体**（不走打桩）；S4 与 S8/S9 的四处护栏/接线各经**变异测试**验证承重 |
| `verify-doc-numbers.ts` | 43 | **文档数字一致性校验**（`scripts/check-doc-numbers.mjs`）的判定逻辑：**白名单 11 处散句**各有一条"改错→红"的用例、**生成区 4 条**（改错→红）外加 D9 段的渲染器输出钉死 / 结构错误 / 幂等 / 非贪婪不吞相邻段、**对照组**（历史数字与引用式文档里的假数字都不被查、ROADMAP 整表不查）、第三节写法分布、逐套项数的漏 / 多 / 不符、缺文件，以及对真 `Log/` 验"白名单里每一处**还找得到**" | 纯函数喂**合成文档**——用例全在内存里造红，一个字节都不碰真仓库的文档；只有 D7 读真 `Log/` |
| `verify-todo.ts` | 75 | 任务清单 C 方案（`todo` 工具 + `TaskStore`）：store 操作与"唯一进行中"不变量、**render/parse 严格互逆**（40 组随机状态的属性测试）、`hasUnchecked()` 与 `hasUncheckedTask(render())` 两处判定恒等、投影（有未完成→写盘 / 全完成→删文件）与种子（吸收 / 全勾选即删 / 旧格式兼容 / 跨"重启"往返）、`todo` 工具端到端（各 `[INVALID]` 路径 / 默认 index / 投影生效）、"runtime 运行期不回读文件"的源码接线断言，以及⑦ 段**跑真 `Runtime` 的行为证明**（空清单不注入 / 有未完成项注入 `taskStore.render()` / 全完成又撤掉） | 真 `ToolRegistry` + `registerBuiltinTools`（不打桩），`fs.mkdtempSync` 临时目录里 `process.chdir` 造 TASK.md；纯函数部分用 `new TaskStore()` 隔离、不碰单例；⑦ 段跑真 `Runtime`，LLM / session 等依赖用假替身，但 `systemPromptService` 是个**探针**——把收到的 `ctx` 记下来断言 `ctx.task`；⑧ 段钉展示层的两根支柱——`onChange` 通知（含"被拒绝的操作不通知"的对照组）与"最近一份已完成"快照，`/tasks` 命令用**假 runtime 截获注册动作**后直接调 handler |
| `verify-docs.mjs` | 21 | `Log/` 下全部 markdown 的**锚点死链**（同文件 + 跨文件）+ **显式锚点卫生**（同一文件内不重复 / 命名守 `log-<日期>-<短名>` / 非空）+ 入站锚点契约 | 按 GitHub slug 规则算标题锚点，并收集 `<a id="…"></a>` 显式锚点，两者都认再比对引用 |

另有 `scripts/rpc-smoke.mjs`：起真子进程走 JSON-RPC、打**真实 API**，验"装配起来真能跑通一轮对话"。唯一会花钱的一项，**不计入上面的项数合计**。

另有 `scripts/check-doc-numbers.mjs`（**文档数字一致性校验**）：它**不算一套套件、也不计入项数** —— 名字用 `check-` 前缀、不匹配串跑入口的 `^verify-.+\.(ts|mjs)$`，且由 `run-verify.mjs` 在汇总之后调用、独立汇报一行（`文档数字：N 处一致。`）。为什么这样切（自指问题）与它的白名单怎么划，见 [ARCHITECTURE_LOG.md 2026-09-11 13:19 那块](./ARCHITECTURE_LOG.md#log-2026-09-11-doc-number-check)。

**生成区（AUTOGEN 区块）**：本文开头那对 `<!-- BEGIN AUTOGEN:… -->` 之间的内容**不是手写的** —— 它由 `npm run docs:sync`（`scripts/docs-sync.mjs`）跑完全套验证后按实测真值写入，人一个字不碰；`npm run verify` 对它是**只读**的，内容对不上就报红、绝不顺手改文件（`gofmt -l` 的范式）。于是本文的纪律三分：**算得出来的**（套数 / 项数）→ 生成区；**判断性的**（为什么这样测、取舍是什么）→ 手写；**历史数字**（追加日志里"当时全量 556 项"）→ 冻结。这一轮把白名单从 23 处收到 **11 处**。机制与三条设计约束见 [GLOSSARY.md](./GLOSSARY.md) 的「生成区」词条与 [DECISION_LOG.md 2026-09-11 14:14 那块](./DECISION_LOG.md#log-2026-09-11-autogen)。

`verify-docs.mjs` **只查锚点、不查“文档里提到的文件路径是否存在”**：后者实测误报率过高（扫出 31 个候选，28 个是裸文件名、运行时产物、或“故意提到不存在的东西”的说明性引用），要压住得维护一张例外表，收益不抵成本；锚点检查则零误报。理由写在脚本头注释里。

另注，这套的项数**不固定**：①② 两段是“每份有引用的文档一条断言”，所以 Log/ 下新增文档、或给原本没外链的文档加一条引用，项数就会变（2026-09-03 从 12 变 13，因为本文加了指向 DECISION_LOG 的引用；2026-09-04 从 13 变 14，因为 ARCHITECTURE_LOG 的行内 ⚠ 更正标注加了指向 ARCHITECTURE.md 的外链；2026-09-11 从 14 变 **19**，其中 +3 是新增第 ③ 段「显式锚点卫生」——那一节固定 3 条、不随引用数浮动，另 +2 是 `Log/` 文档间新增引用让 ①② 统计的文档数从 6 涨到 8，当前 **① 1 份 + ② 7 份**）。同一份文档里再加几条引用不会变（每份只算一条），本日新增 `edit` 与权限相关的那两批链接就没动过这个数。其余十八套的项数是固定的。

## 三、写法约定（现状，含不统一之处）

每个脚本**自带**断言函数，累计 `passed` / `failed`，末尾按 `failed` 决定退出码。

**断言函数名三种并存**（是债务不是设计）：

| 名字 | 签名 | 哪几套 |
|------|------|--------|
| `assert` | `(name, cond, detail = '')` | c1 / c2 / c3 / startup / usage（5 套） |
| `check` | `(name, cond, detail?)` | events / phase-ab / session / docs / edit / permission / tools / spec / steering / doc-numbers / extensions / todo（12 套）——extensions 那套参数名不同，是 `(desc, ok, extra?)` |
| `ok` | `(name, cond)` | input / ui（2 套） |

**退出码行为一致、写法有四种变体**：`setTimeout(() => process.exit(failed > 0 ? 1 : 0), 100)`（5 套，留给异步句柄收尾）、`process.exit(failed === 0 ? 0 : 1)`（3 套）、`process.exit(failed > 0 ? 1 : 0)`（8 套：input / session / docs / edit / permission / tools / spec / todo）、`if (failed > 0) process.exit(1)`（3 套：phase-ab / steering / doc-numbers）。**19 套都会在有断言失败时返回非零**，所以串跑靠退出码判定是安全的。

> 上表这两个分布（函数名 5/12/2、退出码 5/3/8/3，且四者之和 = 套件总数）**现在由机器核对**——`scripts/check-doc-numbers.mjs` 第四节会扫 `scripts/` 数出真值再比。加这条的起因就是本轮在这里**查出两处既有错数**：`check` 写 8 实际 10（2026-09-10 新增 `verify-steering.ts` 时漏了更新这一行）、`if (failed > 0) process.exit(1)` 写 1 实际 2；而四个变体之和 5+3+7+1=16 恰好等于当时的 `.ts` 套件数，于是两处错得很安静。

串跑入口 `run-verify.mjs` 自己还有第五种写法（`process.exit(bad > 0 || totalFail > 0 ? 1 : 0)`），它不算套件——名字不匹配 `^verify-`，所以不会把自己也跑一遍。

**断言红了怎么办**（2026-09-05 补，起因是“代码改了断言要不要跟着改”这个追问）：

红了有四种原因，处理方式互相矛盾。先分辨**这条断言谈的是行为还是手段**：

- **行为**：判定式调真件、看返回值（`!m3.isAutoAllowed('bash', 'cd src/ && rm -rf .')`）。换一种实现这句话仍成立
- **手段**：判定式读源码文本做正则匹配（`/autoAllowed\.has\(/.test(managerSrc)`）、或看内部字段。换成等价实现这句话就不成立

| 情况 | 现象 | 正确动作 |
|------|------|----------|
| 改了实现，要求没变 | 行为断言红 | **改代码**，断言一个字不动。2026-09-05 实测：`Set.has()` 换成 `some(startsWith)`，`verify-permission.ts` 红 6 条（C4/C7/C8/C10/C11/C13） |
| 需求真的变了 | 行为断言红，而新要求是对的 | **先记 DECISION_LOG → 再改断言 → 再改代码**。顺序不能反：先改代码再改断言等于让断言追认既成事实，它就再也不拦人了 |
| 断言钉的是手段，换了等价实现 | 只有手段断言红，行为断言全绿 | **改断言**，并把“钉的是手段”写进名字。同日实测：`Set.has()` 换成遍历全等、语义不变，只有 C13 红、C10 是 ✅ |
| 加新功能 | — | 断言是**新增**，不是修改（2026-09-04 修 grep 与 bash 时新建 `verify-tools.ts` 74 项，没改任何现有一套） |

**顺序**：先把新要求写成断言 → 跑它、确认它**红** → 确认红的原因正是你要改的东西（红错了说明判定式钉歪了，先修断言：`verify-tools.ts` 的 G1 第一版用裸标识符 `/execSync/`，被注释散文里的“Windows 上 execSync 走 cmd.exe”误伤而红，代码当时已经对了）→ 改代码 → 跑这一套绿 → **跑全量 + `tsc --noEmit`**（防止修好 A 弄坏 B）→ 同步四份文档里的项数。

先行的断言**必须先红**：一写出来就绿，要么是代码本来就满足（不用改），要么是断言写空了（什么都没验）。反过来先改代码再补断言，会不自觉地照着代码的返回值填期望，断言于是退化成“对现状的记录”。

**铁律：改断言必须连名字一起改。** 2026-09-05 实测过一次反向操作——坏代码留着，只删掉 C10 判定式里的一个 `!`：项数不变（62）、名字不变、失败数从 6 **降到 5**（数字上像“修好了一个”）、C10 显示 ✅。**没有任何自动机制能发现**，唯一的破绽是那个 ✅ 与它自己的名字自相矛盾。约束力来自读的人，不来自机器。

**手段断言该不该留**：会误报（上表第三行），但它让“全部改绿”变贵——C 段用 18 条钉“授权匹配必须精确”一件事，要全改绿得把 18 条理由逐条读一遍、想清楚凭什么推翻。所以不删，但**名字里必须自己承认钉的是手段**：C13 与 `verify-tools.ts` 的 G1 已按此改名。引用编号时注意：**两套脚本的字母编号各自独立**，`verify-permission.ts` 也有一条 G1（“clearSession 真的调了 permission.clear()”），与 `verify-tools.ts` 的 G1 含义完全不同，必须带文件名。

**源码文本断言的口径得自己划**（2026-09-06 第三次踩同一个坑）：`verify-spec.ts` 的 5-5 数 `String(args.replaceAll)` 出现几次，期望 1（permissionDetail 那处拿的是未经校验的原始 args，消不掉），实测数到 2——多出的那处是 `builtin.ts` 顶部注释里**逐字引用这句代码**的散文（而它引用的目的正是解释“这处为什么消不掉”）。先加的“剔掉整行注释”只解决了一半：块注释里**折行的续行**既不以 `*` 也不以 `//` 开头（那句引用从上一行折到行首），照样漏网。最终解法与 `verify-tools.ts` ⑦ 段同一手法——**先切段再断言**：切出 edit 那一段、再按第一个 `handler:` 分界，于是断言能分开说“handler 区 0 处 / permissionDetail 区 1 处”，比“全文数到 1”更贴名字，也把顶部注释天然排除在段外。同轮还把 5-1~5-4 的名字从“调用为 0”改成“**整体消失**”：那四条的正则连函数定义行一起匹配（`function requireString(args...` 也算一处），期望 0 的真含义是“四个校验件从 `builtin.ts` 整体删掉”，留着不用的定义就是死代码。

## 四、怎么跑

全量 19 套，一条命令：

```
npm run verify
```

末尾打一张逐套的通过 / 失败 / 退出码表，再给合计。哪套失败就把那套的原始输出打出来（否则只看到一行 ❌ 不知道错在哪）；结果行解析不出来的会把项数记为 `?` 并计入合计外提示，**不会静默当成通过**。

Windows PowerShell 下 `npm` 会被执行策略挡住（报 `无法加载文件 C:\Program Files\nodejs\npm.ps1，因为在此系统上禁止运行脚本`），改用 `npm.cmd run verify`，或直连 node：

```
node scripts/run-verify.mjs
```

单套。`.ts` 的 18 套**必须**直连 node 走 tsx——`npx tsx` 同样被执行策略挡住：

```
node node_modules/tsx/dist/cli.mjs scripts/verify-events.ts
```

`.mjs` 的那套直接 `node scripts/verify-docs.mjs`。

路径别写成 `..\node_modules`——那指到项目外去了，全套 EXIT=1 且输出里看不出原因。

## 五、一条重要约束：scripts/ 不受 tsc 检查

`tsconfig.json` 的 `include` 只有 `["src/**/*.ts"]`、`rootDir` 是 `src`，所以**验证脚本没有类型检查保护**。

这是有意的取舍：脚本要造各种替身、塞假字段、探内部状态，受严格类型约束会写不动（`src` 那边开着 `strict` / `exactOptionalPropertyTypes` / `noUnusedLocals` / `noUnusedParameters` / `verbatimModuleSyntax`）。

代价是脚本里的类型错误只能在运行时暴露——**所以脚本必须真跑**，不能因为"编译没报错"就当验过了。

2026-09-06 又实测到这条约束的一个后果：把 `ToolDefinition.parse` 从可选改成**必需**，`tsc --noEmit` 仍 0 错误——`scripts/` 里 9 处 `ToolProvider` 替身一处也不会红（其中 5 处还用了 `as never` / `: any`，但按上面那条，就算全去掉也一样不红）。所以**“加必需成员会打坏 N 处替身”这类说法在本仓库无法用 tsc 验证**，只能逐处数；本轮数过：9 处（比 2026-09-04 记的 7 处多 2，多的是 09-05 为 A4/A5 新加的 `invalidTools` / `noMatchTools`），且这 9 处实现的是 `ToolProvider`、不构造 `ToolDefinition`，所以 `parse` 必需不必需与它们本来就无关。

## 六、几种手法

**假服务器**（c1 / c3 / usage）：`http.createServer` 捕获请求体、回放预制响应。价值在于能断言"我们到底发了什么参数出去"（例如 `stream_options.include_usage` 有没有带上），且不消耗真实 API。

**探针法**（extensions）：往三类扩展目录各临时放一个探针文件，探针把**实际收到的 ctx 的键**记到 `globalThis`，再断言。为什么必须这么绕——"watcher 的 ctx 里没有 `on`"这条约束是**类型层面**的，类型在运行时被擦除，光读代码不算证据，只能让运行时自己报出它拿到了什么。这套断言做过反向验证：故意把 `on` 递给 watcher，探针立刻咬人。

**手工喂事件**（events）：直接构造事件对象喂给 `SpanCollector`，断言配对结果。好处是能验到真实链路里难复现的情形——例如精确验证"嵌套段不能相加"：喂 prompt 1000ms + 内嵌 llm_request 800ms，断言合计显示 `1.0s` 而不是 `1.8s`；还有孤儿 end 被忽略、未关门段进 `running()`、过滤词与"正在跑"块的交互。

**真实链路冒烟**（rpc-smoke.mjs）：起真子进程、真 API，验装配正确性与命令自动装载。它会写 `sessions/*.jsonl`，**跑完记得清掉**（该目录已 gitignore，但仍是残留）。

## 七、缺口（已知未做，别误以为已覆盖）

- **无覆盖率统计**：791 项覆盖了什么、漏了什么，只能人工判断。已知的漏：compaction / commands / rpc 三个子系统没有专套（只被其他脚本间接碰到）；tools 子系统自 2026-09-04 起有四个工具有**功能**专套（`verify-edit.ts` 覆盖 edit，`verify-tools.ts` 覆盖 grep 与 bash，2026-09-11 新增 `verify-todo.ts` 覆盖 todo），**ls / read / write 三个仍无功能断言**（2026-09-06 新增的 `verify-spec.ts` 不算：它④ 段钉的是六个工具**发给模型的 Schema 逐字未变**、⑥ 段只借 grep 验 `parse` 的接线，两者都不问 ls / read / write 干活干得对不对）；permission 子系统同日起也有专套（`verify-permission.ts`），但它验的是**授权面**（键的边界、匹配规则、`clear()` 接线），write / edit / bash 在那套里只被问到“键是什么、文案是什么”，不问它们干活干得对不对——那一面由 `verify-edit.ts` 与 `verify-tools.ts` 补
- **`bash` 的 30 秒超时路径无断言**：`timeout: 30000` 是硬编码的，触发一次就得真等 30 秒，串跑里塞不下。`verify-tools.ts` ⑦ 段只钉住这个值还在（G9），不验超时行为本身。为一项断言把 timeout 改成可注入，收益不抵改生产代码形状的风险（2026-09-04 定为不做）
- **无 CI**：仓库里没有任何 CI 配置。`npm run verify` 的退出码已经能直接交给 CI，但**还没人接**，仍是手工跑，忘了跑就没有防线。2026-09-04 查到一条会**改变方案**的事实：远端 `origin` 是 **Gitee**（`gitee.com/LittleLittleRed/first_-ts_-agent`），而 Gitee 不执行 `.github/workflows`——所以“加个 GitHub Actions 工作流”这个最省事的方案在本仓库会产出一份**永不执行的死配置**；Gitee 自家的 Gitee Go 配置在 `.workflow/` 且需单独开通，账号是否已开通无法从仓库内核实
- 断言函数名三种并存、退出码写法四种变体（见第三节）
- E2E 只有 RPC 冒烟一条，**REPL 交互没有端到端脚本**（输入处理只在单元层验）
- 集成层薄弱：多数脚本直接调子系统，**没有一套真起 `Harness.run()`**（最接近的是 `verify-session.ts`，它造了真 `Runtime`，但 11 个必注入里只有 session 是真的，其余用替身；`verify-permission.ts` ⑦ 段也造真 `Runtime`，且注入的是**真 `PermissionManager`**，其余 10 个仍是替身）
- **文档检查的三条界线**：锚点死链由 `verify-docs.mjs` 查（标题 slug 与显式 id 都认）、**数字一致性**由 `scripts/check-doc-numbers.mjs` 查（2026-09-11 起），但**"文档里提到的文件是否存在"仍不查**——这类失真真发生过（上一轮就从 `目录.md` 里删了三个幽灵条目：`CLAUDE.init.md` / `src/utils/error-log.ts` / `src/persistence.ts`），不查的理由见第二节。同类里还有一处**尚无机器覆盖**：文档里"TESTING 第 X 节"这种**章节号引用**（本轮查出三处写着"第八节"，而 TESTING.md 只有一至七节、断言纪律实际在第三节）。它和锚点一样会断，但历史日志里也有两处（append-only、改不得），所以真要查得先解决白名单问题

（2026-09-03 从本节划掉两条已修的：“`package.json` 里没有 verify / test 入口”→ 现有 `verify` / `typecheck` / `clean` 三个；“`clean` 是 `rm -rf dist` 在 Windows 跑不通”→ 改为 `node scripts/clean.mjs`，用 `fs.rmSync` 的 recursive + force。）
