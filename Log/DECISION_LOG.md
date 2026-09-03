# ⏳ 关键决策日志

> 按时间倒序记录项目中遇到"二选一"或"新方案引入"时的决策过程和理由。

---

## 2026-09-03 — 回归防护走 vitest 还是零依赖自研脚本

**场景：** 上一轮改写 `TESTING.md` 时发现两处文档立场互相矛盾：TESTING 第一节写“**不用任何测试框架**，10 套零依赖验证脚本、299 项断言”，而 ROADMAP P6 挂着一条未勾选的 `- [ ] 正式测试套件 — 引入 vitest`（立项于 2026-08-14）。同一件事一处说“已经这么定了”、另一处说“还待做”，读的人会以为项目中途改过主意。本轮把这条待办补齐了执行手段（`run-verify.mjs` 串跑入口 + `npm run verify`，12 套 359 项一键跑完、EXIT=0），必须同时把立场定下来。用户拍板：**不引入 vitest**。

**方案 A（引入 vitest）：** 装依赖、写 `vitest.config.ts`，把 session / compaction / commands / rpc 四个子系统改写成 `describe` / `it` / `expect`。

**方案 B（零依赖自研脚本，并补齐入口）：** 不装任何测试依赖，给现有脚本加一个串跑入口与 `package.json` 命令，靠退出码当回归信号。

**选择：B**

**理由：**
- **立项时写的痛点已经消失了**：P6 那条的理由是“P5 大重构后零回归保护，改 bug 可能悄悄破坏别处”。而回归保护本身已经存在（2026-08-14 立项时只有零星几个脚本，现在 12 套 359 项），缺的只是“一条命令能跑完”——这个缺口用 73 行的 `run-verify.mjs` 就补上了，成本远低于迁框架
- **现有断言大多不适合框架的抽象**：起假 HTTP 服务器演两种流式协议（c1 / c3 / usage）、夹逼 TTY 宽度量框宽（ui）、手工造事件对象喂给 SpanCollector 看配对（events）、计启动关键路径的毫秒数（startup）、往扩展目录临时放探针文件再读 `globalThis`（extensions）。这些用 `node:http`、`process.stdout.columns`、直接构造对象写出来更直白，包上 `describe` / `it` 不会变短
- **依赖成本不是零**：`package.json` 至今**没有 `dependencies` 字段**（零运行时依赖），`devDependencies` 只有 `@types/node` / `tsx` / `typescript` 三个。加 vitest 意味着引入一整棵依赖树与一份配置，而这个项目的自定位就是“从零自研、看得懂每一行”
- **迁移期会出现两套测试体系**：359 项断言不可能一次改完，改一半的时间里“跑测试”变成两个命令、两套写法，比现在更糟

**代价：** 放弃的东西都是真的，已逐条记进 `TESTING.md` 第七节——**没有覆盖率**（359 项盖住了什么、漏了什么只能人工判断）、**没有 watch 模式**、**没有测试隔离机制**（每个脚本自己管临时目录与副作用）、**没有 `describe` 的组织力**（所以出现了断言函数名三种并存、退出码写法四种变体的债务——框架本来会强制统一这些）。另外 `scripts/` 不在 `tsconfig.json` 的 `include` 里（`include` 只有 `src/**/*.ts`），验证脚本没有类型检查保护，**必须真跑**才算验过。真到需要覆盖率数字或要接 CI 矩阵的那天，这个决策应当重开。

**参考：** [TESTING.md](./TESTING.md)（第一节选型理由、第七节缺口）· [ROADMAP.md](./ROADMAP.md)（P6 “正式测试套件”已勾选关闭）· `scripts/run-verify.mjs`

---

## 2026-09-03 — 六天未提交的改动怎么拆（每件事一个提交 vs 两个粗粒度提交 vs 逐 hunk 拆）

**场景：** 用户要求“挨个提交”。上一个提交是 `ee40eae`（2026-08-28 17:57），之后积压了 **83 条** CHANGE_LOG 记录、`git status` 里 **38 个已改文件 + 4 个未跟踪**（仅 src 就 29 个，+2195 行）。先查了每个改动文件在 CHANGE_LOG 里被哪几天的哪几件事提到：结果 **14 个文件是多件事交织的**——`llm/anthropic.ts` 一个文件里压着 4 件事（thinking C1/C3、L3 真实 usage、观测层、流式重构），`core/events.ts`、`core/loop.ts`、`harness/check.ts`、`harness/main.ts`、`loop/agent-loop.ts`、`runtime/events.ts`、`runtime/runtime.ts`、`llm/provider.ts` 各压 3 件；另有 7 个文件（包括 `tree-ui.ts` +466 行、`input-handler.ts` +251 行）在 CHANGE_LOG 里根本没按文件名出现过。而 `git add` 只能整文件加。

**方案 A（每件事一个提交）：** 按 83 条记录拆成几十个提交。

**方案 B（两个粗粒度提交）：** 一个装源码 + 验证脚本（feat），一个装 Log 文档同步（docs）。

**方案 C（逐 hunk 拆）：** 用 `git add -p` 把 14 个交织文件按块分开，做到真“每件事一个提交”。

**选择：B**（用户在三选中拍板）

**理由：**
- A 物理上做不到：14 个文件交织是**下限**（还有 7 个文件无法从日志反推归属），同一文件的同一区域被多件事反复重写过，无法按事切分
- C 的成本与出错率不可接受：2195 行插入逐 hunk 判定归属，一旦分错就会产生中间状态编译不过的提交，比粗粒度更危险
- B 的每个提交都是自洽的：提交 1 的状态 tsc 零错误、299/299 全绿；提交 2 纯文档，不影响可运行性
- 历史仍可追：83 条逐事明细本来就在 `CHANGE_LOG.md` 里（带时间戳），提交 message 指向它即可，不必用提交粒度重复表达一遍

**代价：** `git log` 只能看到两个大块，想用 `git bisect` 定位到具体哪件事引入的回归时，粒度不够——得配合 CHANGE_LOG 的时间戳手动缩小范围。以后要想避免，得改成**每完成一件事就提交**（而不是积压六天），而不是事后拆。

**参考：** [CHANGE_LOG.md](./CHANGE_LOG.md)（2026-09-03 14:22 提交历史整理条）

---

## 2026-09-02 — 模型列表怎么移出启动关键路径（内存预热 vs 纯懒加载 vs 落盘缓存+TTL）

**场景：** 启动提速第一档把网络探测后台化之后，界面渲染前还剩最后一批真实往返：`getConfigManager()` 会 `await init()`，为每个有 key 的供应商并行拉 `/models`，而 `check()` 又 await 它。实测这批请求冷连接 1998ms、连接池热时 278ms，网络差时每家最长卡 10s 超时——全程终端只有 banner 没有 UI（用户此前明确投诉过"UI 没在第一时间加载出来"）。ROADMAP 原案写的是"落本地缓存带时间戳（TTL 约 24h），启动只读缓存"。

**方案 A（内存预热 + 按需现拉）：** 启动路径 0 网络请求；main.ts 在界面渲染前 fire-and-forget 调 `warmModels()` 并行拉有 key 的几家，结果只写内存里的 Provider；`/model` 二级选择器展开前 `ensureModels()`——5 分钟新鲜期内零等待，还在飞就 await 同一个 promise（inflight 去重）。不落盘。

**方案 B（纯懒加载）：** 启动不拉也不预热，只有用户真开 `/model` 时才现拉那一家。

**方案 C（落盘缓存 + TTL，ROADMAP 原案）：** `/models` 结果写本地文件带时间戳（TTL 约 24h），启动只读缓存，`/model` 时才主动刷新。

**选择：A**

**理由：**
- 调研发现 `getModels()` 的 9 个调用点里**只有 `/model` 的二级选择器真需要远程列表**：其余要么只是说明文字，要么静态列表就满足（连 `getFallback()` 点名要的 `deepseek-v4-flash` 都在 opencode-go 的静态表里）。既然只有一个消费者，缓存就该服务于"打开它的那一刻别等"，而不是"跨进程复用"
- 方案 C 为一个内存里的数组配一整套机械：缓存文件、TTL 失效、baseUrl 变更失效、写盘失败处理、gitignore、旧缓存与新配置不一致……而它换来的只是"下次启动省一次后台请求"——可 A 已经让启动路径一次请求都不发了，那份收益是 0
- 方案 B 更省，但把 0.3~0.9s（实测单家 913ms / 552ms）原封不动搬到用户点开菜单那一刻，而用户对"点了没反应"的敏感度远高于启动多等半秒；A 用一次用户感知为零的后台预热把这段时间藏起来
- A 的代价可控且都在明处：进程重启即重新拉（模型列表的变化频率是"月"级，5 分钟新鲜期已远超需要）；断网时启动照样过——自检（`probeStartup`）本来就在后台，列表有静态兜底

**代价：** 活动供应商启动时会被拉两次（`warmModels` 一次 + `probeStartup` 一次）。**不合并是有意的**：probe 要靠 HTTP 状态码分档（401 → key 无效），而 `fetchRemoteModels` 把状态码吞了；为省一次**后台**请求（用户感知为零）把两者耦起来不划算。另外 `/model` 一级列表的"N 个模型可用"在预热完成前显示的是静态数（13 而非 33），只影响说明文字。

**参考：** `src/config/manager.ts` 的 `warmModels/ensureModels/isModelsFresh/startRefresh`、`src/llm/provider.ts` 的 `modelsFetchedAt`、`src/harness/main.ts` 的 TTY 分支、`scripts/verify-startup.ts` S1/S7/S9/S10

---

## 2026-09-02 — 流式用量怎么拿（显式索取 + 撞墙降级 vs 一律不索取继续估算）

**场景：** 可观测层落地后 `llm_request_end.usage` 恒为 null：OpenAI 兼容协议**默认不在流式响应里给用量**，必须靠 `stream_options.include_usage` 显式索取；Anthropic 则把用量拆在 `message_start`（输入）与 `message_delta`（输出累计值）两个事件里，不解析就永远拿不到。于是 token 数只能靠 `estimateTokenUsage` 本地估算，而它只算 user 输入 + 最终回复：多轮工具循环的中间消息、system prompt、5 个工具描述全没算。实测同一条冒烟：估算 {26,23,49} vs API 真值 {2834,71,2905}，输入侧少报约 109 倍。

**方案 A（显式索取 + 降级）：** 带上 `stream_options.include_usage`；若端点因这个参数报 400，则关掉进程级开关并在同一次调用内静默重试一次（不带该参数）。Anthropic 侧解析两个用量事件，输入把两个缓存字段加回来。

**方案 B（一律不索取）：** 保持现状，token 数永远靠本地估算，`usage` 槽位继续留空。

**选择：A**

**理由：**
- 估算与真值差两个数量级，`/usage` 与 `prompt_end.totalUsage` 一直在报一个口径完全不对的数——这不是"精度差一点"，是把 system prompt 与工具描述整体当成不存在
- 代价可控：降级后的行为与方案 B **完全一致**（usage 继续 null、上层回退估算），用户看不到失败，不会为了一个统计参数把对话搞挂
- 开关做成进程级而非每次探测：撞过一次就不再白跑一趟；只有错误文本里含 `stream_options` 才降级，其他 400（密钥无效、余额不足）原样抛出，不误吞真错误
- Anthropic 的 `input_tokens` 只统计"本次新读的非缓存部分"，而本项目在 system 分层与 tools 上都设了 `cache_control` 断点——命中时它只剩个位数，不把 `cache_creation` 与 `cache_read` 加回来，报出来的"真值"会比估算更离谱

**代价：** 首次撞上严格代理端时多一次失败往返；开关是进程级的，同进程内从不兼容端切到兼容端也不会再索取（重启才恢复）；缓存命中率这个最能省钱的信息被合并进 `promptTokens` 了（`LLMUsage` 只有三个槽）。

**参考：** `src/llm/stream-helper.ts` 降级段、`src/llm/anthropic.ts` `AnthropicStreamUsage`、`scripts/verify-usage.ts` U1/U5/U11/U12/U13

---

## 2026-09-02 — 多轮合计不完整时怎么报（整体 null vs 报部分合计）

**场景：** 一次 prompt 可能有多轮 LLM 往返（工具循环），而任一轮都可能拿不到用量：流中途异常、端点不支持索取、降级后重试的那轮。`AgentLoopResult` 只能交一个合计值出去。

**方案 A（整体 null）：** 任一轮缺失 → `usage: null`，Runtime 回退 `estimateTokenUsage`。

**方案 B（报部分合计）：** 把拿到的那几轮相加报出去，缺的当 0。

**选择：A**

**理由：**
- B 报出的是一个"看起来是真值"的少报数字，消费端无法区分"这就是全部"与"这只是其中几轮"——它比明确的估算值更误导，因为估算值大家都知道是估的
- null 与 0 在本项目里一直是两件事（0 = 真的收到 0 个字，null = 无从统计），`firstTokenMs`、`textLength` 等 span 结果字段全是这套语义，用量沿用同一套才不必教消费端两种读法
- 回退路径本来就存在（`usage ?? estimateTokenUsage(...)`），A 不新增分支，消费端一行未改

**代价：** 多轮任务里只要一轮缺失，整段真值全丢，退回精度差两个数量级的估算；实现上还得绕一个坑——TS 的控制流分析不追踪闭包内的赋值，用量必须经 `trace()` 回调的**返回值**上送，写成"回调内改外层 let"会被锁死成初始的 null（本次为此连撞两轮 `never` 报错）。

**参考：** `src/core/loop.ts` `AgentLoopResult.usage` 注释、`src/loop/agent-loop.ts` `usageComplete`、`scripts/verify-usage.ts` U8/U9/U10

---

## 2026-09-02 — 可观测性的落地路径（先补事件语义 vs 直接引 LangSmith）

**场景：** 用户提出"引入 LangSmith 帮助记录某个行为的结果和报错"。现状四层日志（启动自检 `Diagnostic[]`、运行时诊断队列、51 处裸 console、两个 env 调试日志）全部是**离散点**：无 traceId/spanId/parentId、无时间戳无耗时、不记输入输出、无树形结构。一次带 3 个工具调用的 prompt 实际发生 4 次 LLM 往返，对外却一个边界事件都没有。

**方案 A（先补事件语义）：** 自研 span 层——总线 emit() 盖 at/seq/turnId 公共头，四组强类型骨架 span 覆盖三重循环，消费者写成扩展 hook 落本机 JSONL。零运行时依赖不破。

**方案 B（直接引 LangSmith SDK）：** `optionalDependencies` + 动态 import 规避破零依赖，把现有事件流映射成 run tree 上报云端。

**选择：A**

**理由：**
- LangSmith 记的是"一次调用的树"，而现有事件是扁平的离散点——**没有边界（无成对 start/end）就没有树**，接进去也只能上报一堆无父子的孤点，等于把语义欠账搬到云端
- 实测 langsmith@0.10.1：直接依赖 p-queue、传递 4 包、解包 3.2MB，与 `package.json` 的 `dependencies` 为空这一立项目标冲突
- 数据出网：完整 messages / 工具参数 / 输出会上 api.smith.langchain.com
- 进程硬退出丢队列：`/exit`、SIGINT、SIGTERM 三条路径都走 `process.exit()`，未 flush 的上报直接消失
- 先定语义则后端可插拔（换 LangSmith / LangFuse 只是在 `hooks/` 再放一个文件），先选后端则被其私有 run 模型锁死

**代价：** 暂无跨会话聚合看板与云端 UI，只有本机 JSONL；日后若真要接 LangSmith，需再写一个 hook 做字段映射，且上述四条现实一个不少。

**参考：** `Log/ROADMAP.md` P6 "可观测性增强"（本次落地）；`Log/ARCHITECTURE_LOG.md` 2026-09-02 16:26

---

## 2026-09-02 — span 契约形态（强类型骨架 + 自由便签双通道 vs 单一自由通道）

**场景：** 新增一个观测点要不要每次改核心事件类型。用户拍板："路 A 身份证用于骨架的核心事件，路 B 作为便签用于记录扩展 hook 里的内容，想加就加"。

**方案 A（双通道）：** 骨架 span（prompt / llm_request / tool_call / compaction）事件类型即 `<name>_start`，载荷由 `SpanContracts` 的 interface 约束；便签 span 事件类型固定 `note_start` / `note_end`，段名降级成 `name` 字段、载荷是自由字典。

**方案 B（单一自由通道）：** 全部走 `note_*` + `attrs` 字典，核心永不为观测改动。

**选择：A**

**理由：**
- 骨架那四段是 **UI 要直接消费**的（判红绿、显示耗时与首字延迟），字段名打错必须编译期就炸；自由字典要到运行时才发现，而运行时发现的代价是 UI 静默显示错数
- 便签通道保留了方案 B 的全部好处：用户在 hook 里圈任意一段，核心零改动
- 双通道的分工正好对上两种不同的变更频率："系统必须观测的四处"（极少变）与"临时想看的任意一处"（随时变）

**代价：** 核心有两套发射路径（`openSpan` 的 note 分支）；加一个骨架段要改 `runtime/events.ts` 两处（interface + SpanContracts）；`beginSpan` 收到集合外的段名只能运行时 `console.warn` 一次兜底。

---

## 2026-09-02 — 出门载荷字段必填 vs 可缺（异常段不得伪报）

**场景：** `llm_request` / `tool_call` 段在流中途抛异常时，`firstTokenMs` / `textLength` / `resultLength` / `usage` 根本没有值可报——`span.set()` 那一行并未执行到。

**方案 A（可缺，缺失即"无从统计"）：** 结果字段全部可选，只有 `status` / `durationMs` 由总线算、永远在；`usage` 用 `null` 表示"Provider 没给"，与 0 区分。

**方案 B（必填，异常路径补 0 / 补空串）：** 类型上所有字段必填，异常时填默认值。

**选择：A**

**理由：**
- 填 0 等于伪报：0 个 token 与"没统计到"是两件事，消费端无法区分，画出图表就是假数据
- `verify-events.ts` 第一次跑就抓到这个契约谎言：异常段报 `resultLength 不存在`——**这是正确语义**（工具崩了就没有结果体量），是类型把它写成了必填
- `agent-loop` 事后拼的 `[工具 X 执行失败]` 文本是兜底话术，不是工具输出，不该算体量
- `usage` 槽位当前两个 Provider 的流式路径都还没填（`llm/types.ts` 的 end 事件已留位），写成必填就会逆逼真报 0；写成 `LLMUsage | null` 则填上之后自动变真值、消费端不必改

**代价：** 消费端每个字段都要判存在性（TreeUI 里 `typeof event.durationMs === 'number'` 这类守卫）；`exactOptionalPropertyTypes` 下生产端赋值必须用条件展开，写法啰嗦。

**参考：** `scripts/verify-events.ts` ⑥ 组（异常段不伪报）；`src/runtime/events.ts` 的 LLMRequestEndEvent / ToolCallEndEvent 注释

---

## 2026-09-02 — 歧义宽字符的测宽口径（显式窄区段表 vs 完整 wcwidth 表）

**场景：** `fit-width.ts` 的字符列宽判定。旧规则 `charCode > 0xff 即 2 列` 把制表画框字符 `─│┌┐└┘═` 也算成 2 列，76 字符的边框被测成 140 列，`Text.render` 的 `fitWidth(width-1)` 把它砍到 45 字符，右侧 `┐ ┘` 整段丢失——框是破的；而 `Screen` 的行宽告警排在截断之后，结构上永远报不出来（真机 `debug-screen.log` 里 `newLine宽度=78` 就是 48 字 `━` 分隔线被砍到 39 字的痕迹）。

**方案 A（显式窄区段表）：** 只把确定按 1 列绘制的非 ASCII 区段声明为窄（制表画框 U+2500–259F、箭头 U+2190–21FF、盲文 U+2800–28FF、`❯` U+276F），其余非 ASCII（汉字、全角标点、`— … “”`、emoji）维持 2 列。

**方案 B（完整 wcwidth 表）：** 按 Unicode East Asian Width 属性建全表，Ambiguous 一律按 1 列（wcwidth / xterm.js / Windows Terminal 的口径）。

**选择：A**

**理由：**
- 两种猜错的代价不对称：把窄字符测成宽 → 行提前折、提前截断，只浪费几列；把宽字符测成窄 → 行超出终端宽度触发软换行，而差分渲染按"一逻辑行 = 一终端行"记账，行数一错整屏错位
- 方案 A 修的正是必须修的那一类（UI 骨架字符：边框、分隔线、旋转帧、选择器光标），而这些字符在所有现代终端都由等宽西文字体绘制，1 列无争议
- `— … “” ①②③` 这类中文正文标点的真实宽度取决于终端字体回退（Consolas 有字形→ 1 列，回退到中文字体→ 2 列），无法离线判定；维持现状等于不引入新风险
- 方案 B 需约 90 个区段的静态表，且一旦用户终端把歧义字符画成宽（旧 conhost + 中文字体），全部中文正文行都会超宽错位

**代价：** 中文正文行会比实际显示宽度短若干列（每个 `— … “”` 少用 1 列），框内右侧略参差。

**参考：** `Log/CHANGE_LOG.md` 2026-09-02 12:33 [Fix🐛]；`scripts/verify-ui.ts` ⑥ 组

---

## 2026-09-02 — 进度指示器粒度与流式框收尾（回合级 + 就地封口 vs 事件驱动 + 整框重建）

**场景：** 用户反馈"回复中途会经历较长时间的等待，并没有状态栏提示，直到完全给出全部回复后上面的 UI 才会加上"。旧实现两处根因：① 指示器只消费 `thinking` 事件，而 `agent-loop` 内部一轮都不发该事件 → 工具执行期、工具结束到下一次 LLM 首字之间全程黑屏；② `agent_end` 时 `removeLiveBox()` 拆掉半成品框再用完整文本重建。

**方案 A（回合级指示器 + 就地封口）：** 指示器从 `onSubmit`（按下 Enter）点亮到 `agent_end` 才撤，位置随阶段迁移（等待期挂底部状态行，流式期挂回复框的开口底边）；收尾时只把开口底边那一行换成 `└──┘`，顶边框与正文原地不动。

**方案 B（事件驱动 + 整框重建，旧实现）：** 指示器只在收到 `thinking` 时显示、首片正文到达即撤；`agent_end` 拆框重建。

**选择：A**

**理由：**
- 差分渲染按行比较：重建让整框所有行同时变化 → 视觉上"闪一下重画"；就地封口只有底边一行变化
- 回合级指示器不依赖上游发不发事件，把"进度承诺"的缺口从根上堵住（事件驱动口径下，任何新增的不发事件的阶段都会重新出现黑屏）
- 流式期框已是完整形状（只差底边），开口底边常驻"正在输出… N 秒 · 已收 X 字"正好对应用户诉求"等输出完毕后再进行变化"
- 摘要行（💭 思考了 N 字 / ⏳ 用时 N 秒）可能在开框之后才凑齐（推理晚到、等待跨了工具轮），需往已成型的框中部插行 → 为此给 `Container` 补了 `insertChild(component, index)`

**代价：** `Container` 多一个 `insertChild` 接口；`liveBox` 生命周期内要额外维护 `liveFoot` / `liveBoxWidth` / `liveSummaryShown` 三个字段（宽度必须建框时锁定，否则窗口中途变化会让顶底边不同宽）；双时钟（首字前等待 `waitAccumMs` 与流式计时 `streamStartAt`）必须分开，否则两个秒数互相污染。

**参考：** `Log/CHANGE_LOG.md` 2026-09-02 12:33 [Feature✨] 回合级进度指示器

---

## 2026-07-23 — 选择 Pi 模式（调用方持有循环）

**场景：** 设计 Runtime 的交互循环归属。

**方案 A（Pi 模式）：** Runtime 不持有循环，`main.ts` 的 `runReplMode()` 持有 `while(true)`，`runtime.prompt()` 只处理单次输入。

**方案 B（CLI 模式）：** Runtime 内部持有循环，`runtime.start()` 启动后自动进入读→调→印的流水线。

**选择：A**

**理由：**
- I/O 切换成本低（CLI → WebSocket → HTTP 只改 main.ts）
- Runtime 的职责纯粹（处理输入，不关心输入来源）
- 测试简单——单次 `prompt()` 可独立验证

**参考：** [ARCHITECTURE.md](./ARCHITECTURE.md#决策-1pi-模式调用方持有循环)

---

## 2026-07-23 — 使用闭包工厂模式创建 Runtime

**场景：** main 中 `check()` 返回后需要将 `llm` 等依赖注入 Runtime。

**方案 A（直接 new）：** `const runtime = new Runtime({ llm })` 在 `main()` 中直接构造。

**方案 B（闭包工厂）：** 定义 `createRuntime` 闭包捕获 `llm`，通过工厂创建 Runtime。

**选择：B**

**理由：**
- 后续 `/new`、`/fork` 等会话切换可复用工厂，重新创建 Runtime
- 工厂内部可扩展更多组装逻辑（services、日志等）

**代价：** 当前只调用一次工厂，B 方案的收益未完全体现。但当会话管理需求出现时不必重构。

---

## 2026-07-23 — 流式输出采用回调方式

**场景：** `runtime.prompt()` 需要支持流式逐字显示。

**方案 A（事件订阅）：** `prompt()` 返回 `void`，回复通过 subscribe/emit 事件传递。

**方案 B（可选回调）：** `prompt(input, onToken?)`——传 `onToken` 走流式，不传走非流式，始终返回完整文本。

**选择：B**

**理由：**
- 向后兼容——原有调用 `reply = await prompt(input)` 不需要改代码
- 实现简单——不需要引入事件系统
- 流式和非流式共用同一入口

**参考：** [ARCHITECTURE.md](./ARCHITECTURE.md#决策-5streaming-以回调方式提供)

---

## 2026-07-23 — check() 返回 Result 而非 void

**场景：** check() 需要把配置信息传给 main() 和 Runtime。

**方案 A（check 内部全部消化）：** check() 读取配置后返回 `void`，Runtime 内部自己读文件。

**方案 B（返回 CheckResult）：** check() 读取配置并创建 Provider，通过 `CheckResult` 返回。

**选择：B**

**理由：**
- 配置错误在启动时暴露，而非运行时
- 减少隐式文件读取（Runtime 不自己读文件）
- 测试可注入 mock Provider，不需要 mock 文件系统

---

## 2026-07-19 — 项目初始化：TypeScript + ESM 严格模式

**场景：** 选择技术栈基准。

**方案 A（CommonJS）：** 传统的 `require` 模块系统，宽泛的 TS 配置。

**方案 B（ESM + 严格模式）：** `"type": "module"`，`tsconfig.json` 开启全部严格选项。

**选择：B**

**理由：**
- ESM 是 Node.js 生态的明确方向
- 严格模式在开发阶段捕获更多潜在错误
- `verbatimModuleSyntax` 确保 import 行为一致

**配置文件：** `package.json`、`tsconfig.json`

---

## 2026-07-29 — parseToolCalls 三段策略：原生优先，fixJSON 兜底

**场景：** fixJSON 在修复 JSON 格式错误时，过度处理合法 JSON 转义符（如 `\\`、`\n`），破坏原本合法的 JSON 导致解析失败。

**方案 A（一律先 fixJSON）：** 截取到 JSON 文本后立刻过 fixJSON 再 JSON.parse。

**方案 B（原生优先→fixJSON 兜底）：** 先尝试原生 JSON.parse，失败后再用 fixJSON 修复，再失败则跳过+日志。

**选择：B**

**理由：**
- 主流 LLM（DeepSeek V4 Flash）生成的 JSON 绝大多数是合法的，不需要修复
- fixJSON 的正则替换有副作用（破坏了 `\\U`、把 `\n` 变 `\\n`）
- 三段策略在不同场景各司其职：合法直通 / 格式错误修复 / 彻底非法跳过+日志

**代价：** 偶尔 LLM 生成不合法但 fixJSON 能修复的 JSON，需要多一次 try-catch。

---

## 2026-07-29 — 权限弹窗采用暂停/恢复 data 监听器策略

**场景：** 权限选择弹窗需要原始模式捕获 ↑↓ 方向键，但直接切换 raw mode 干扰主 readline 的 'data' 事件流。

**方案 A（emitKeypressEvents + setRawMode）：** 用 readline.emitKeypressEvents 激活键盘事件，切换 raw mode 后用 keypress 事件处理选择。

**方案 B（文本选择 1/2/3）：** 不使用 raw mode，用 readline.question() 展示 1/2/3 选项让用户输入数字选择。

**方案 C（暂停/恢复 data 监听器）：** 进入弹窗前保存并移除所有 'data' 监听器，弹窗结束后恢复。

**选择：C**

**理由：**
- 保留了方向键导航的交互体验（方案 B 是退化）
- 暂停/恢复 data 监听器比 emitKeypressEvents 更干净，不会残留监听器
- 非 TTY 环境单独处理自动允许，不碰 raw mode

**代价：** 代码复杂度高于方案 A 和 B。

---

## 2026-07-29 — 项目代码审计识别 13 个待修复问题

**场景：** 完成全项目代码阅读后，发现以下潜在风险和设计缺陷。

**待修复问题清单：**

| 优先级 | 问题 | 文件 | 影响 |
|--------|------|------|------|
| P0 | `\"` 转义引号导致 inString 大括号匹配错乱 | utils.ts:58 | 含嵌套 JSON 的参数工具调用不执行 |
| P0 | chat() + stream() 两阶段 API 调用，双倍 Token | runtime.ts:239-270 | 每次回复翻倍 token 消耗 |
| P0 | followUpQueue 只进不出 | runtime.ts:79-81 | 排队消息永远丢失 |
| P1 | 工具无超时机制 | tool.ts:56-59 | 大文件读取阻塞线程 |
| P1 | 5 轮 tool loop 硬上限无感知截断 | runtime.ts:240 | 用户收到不完整回复 |
| P1 | catch {} 大量静默无日志 | 多处 | 调试困难 |
| P1 | grep 命令注入风险 | tools.ts:192 | 安全问题 |
| P2 | 上下文压缩递归调用 LLM 无限流 | runtime.ts:199 | 潜在无限循环 |
| P2 | API Key 明文 | config/api.json | 泄露风险 |
| P2 | Date.now() ID 生成冲突 | jsonl-storage.ts:33 | 极短时间内重复 |
| P2 | 历史消息全量传入无窗口限制 | runtime.ts:233 | token 浪费 |
| P3 | 主函数 isClosed 导入未使用 | main.ts:11 | IDE 警告 |
| P3 | session 模块未处理的空状态 | session.ts | 边界情况 |
