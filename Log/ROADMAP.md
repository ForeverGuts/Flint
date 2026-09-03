   # 🗺️ 项目开发路线图

> 按**底层依赖 → 重要程度**排序。下层模块完成后才能支撑上层功能。

## ✅ 已完成

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
| **工具系统（P2）** | read/write/grep/bash 四工具 + function calling（结构化 tool_calls） |
| **技能系统（P2）** | SkillLoader 加载 .pi/skills/*.md 模板 |
| **事件订阅（P3）** | PromptEventEmitter subscribe/emit，stream_text/tool_call/error 等事件 |
| **多会话管理（P3）** | /sessions 切换/新建，/history 分叉出多分支 |
| **配置系统增强（P4）** | config/manager 配置分层（环境变量>全局>项目）+ Provider 对象抽象 + /model 自定义供应商 |
| **错误日志与诊断（P4）** | Diagnostic 公共类型 + runtime 诊断队列 + /diagnostics 查看 + debug-runtime.log 落盘 |
| **启动自检增强（P4）** | check() 逐项检查（配置/API key/连通性/模型列表）+ 严重度分级 + check 事件 |
| **可观测性增强（P6）** | 事件语义层：总线盖 at/seq/turnId + 打卡机 trace()/beginSpan() + 四组骨架 span + 便签通道 + trace-log watcher 落 JSONL + L3 两条流式协议的真实 usage + SpanCollector 公共配对件与 /traces 内置命令 |
| **启动提速（P6）** | 第一档网络探测后台化 + 第二档启动关键路径 0 网络请求（模型列表内存预热 + /model 按需现拉） |

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
- [ ] **系统提示词模板层** — 从 runtime.ts 硬编码字符串抽为模板（system-prompt.ts），支持按场景选择
  - 理由：硬编码不可扩展，影响 Agent 能力演进
  - 对标：Pi 的 prompt-templates.ts / system-prompt.ts
- [ ] **分支摘要** — fork 后把旧分支摘要塞回新分支上下文
  - 理由：当前 fork 只复制前缀，新分支 LLM 不知道旧线聊过什么
  - 对标：Pi 的 branch-summarization.ts
- [ ] **Hook 系统** — 工具调用/消息生命周期钩子（beforeToolCall/afterToolCall 等）
  - 理由：扩展 Agent 行为（拦截/转换/记录），当前仅 inputHandlers 简单预处理
  - 对标：Pi 的 hooks.md / Cline 任务生命周期钩子
- [ ] **会话仓库层** — 从 jsonl-storage 抽出 repo 层（会话列表/管理/删除）
  - 理由：区分"单会话存储"与"会话管理"，支持多会话完整操作
  - 对标：Pi 的 jsonl-repo.ts
- [ ] **技能系统补全** — SkillLoader 热重载 + 依赖追踪（当前 TODO）
  - 对标：Pi 的 skills.ts
- [ ] **工具参数校验框架** — 从手动 requireString 升级为 schema 自动校验
  - 理由：工具参数校验标准化
  - 对标：Cline 工具参数 schema 校验
- [x] **可观测性增强** — 结构化 trace/span 观测层（2026-09-02 落地：总线 emit() 盖 at/seq/turnId 公共头 + SpanRecorder 打卡机（trace 自动配对 / beginSpan 手动）+ 四组骨架 span 覆盖三重循环（prompt/llm_request/tool_call/compaction）+ note_start/note_end 便签通道 + trace-log hook 落 trace.jsonl，verify-events 55 项）
  - L3 真实 usage 同日补齐：两条流式协议各自取用量（OpenAI 兼容靠 stream_options.include_usage 显式索取 + 撞 400 自动降级，Anthropic 靠 message_start 输入三项相加 + message_delta 输出累计值），AgentLoopResult 逐轮合计、任一轮缺失即整体 null，verify-usage 22 项；实测同一条冒烟的 promptTokens 从估算 26 变真值 2834（估算没算 system prompt 与 5 个工具描述）
  - 对标：Pi 的 docs/observability.md
  - 剩余（未立项，按需再做）：非流式 chat() 的用量回流（ChatResult 无 usage 字段，compaction 摘要调用消耗的 token 从未计入 totalUsage）· 缓存命中率明细（现被合并进 promptTokens，LLMUsage 只有三个槽）· 显式 parentId 树形（现靠 turnId + 时间区间包含关系重建）· 51 处裸 console 收编进总线
- [x] **/traces 内置命令 + SpanCollector 公共配对件** —（2026-09-03 落地）把 trace-log watcher 里的 span 配对逻辑抽成 runtime/span-collector.ts（契约 SpanCollector / CollectedSpan 进 core/events.ts，与生产端的 SpanRecorder 对称：一个帮打卡、一个帮收段），watcher 从 134 行瘦到 78 行、只剩"开关判定 + 落盘格式 + 退出补记"；新增 /traces 命令就地看最近段的耗时/成败/此刻在跑的是哪段，支持条数与段名过滤；两个消费者各持独立实例（核心命令不反过来依赖可选扩展）；verify-events ⑨ 段 21 项，全量 299 项
  - 理由：看一段耗时不该先开 TS_AGENT_TRACE 落盘、再翻 jsonl 文件；而配对逻辑虽然只有一份，却住在可选扩展里，核心命令拿不到
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

### P7 — 业务能力强化（让 Agent 真正解决实际问题）

> 工具/架构已齐，以下为提升 Agent"解决真实编码任务"能力，按见效速度排序。

- [ ] **系统提示词强化** — 从"别乱调工具"升级为"教 Agent 解决任务的流程"：
  - 拆解问题 → 分步执行 → 验证 → 迭代
  - 如何用工具组合完成多步任务（先理解再动手）
  - 遇到错误如何排查重试（读错误 → 定位 → 修复）
  - 写完代码跑测试验证
  - 理由：同样工具，提示词决定 Agent 是"会说话"还是"会干活"，成本最低见效最快
- [ ] **精准编辑工具** — 新增 apply_patch / editor（diff 式精准修改，不整体覆盖文件）
  - 理由：当前只有 write（整体覆盖），改大文件一小段会破坏内容；真实编码任务必需
  - 对标：Cline 的 apply_patch / editor
- [ ] **测试验证闭环** — 提示词 + 工具引导 Agent"改代码 → 跑测试 → 看结果 → 再改"
  - 理由：Agent 能写代码但不会自证正确；真实修 bug/写功能需要验证迭代
- [ ] **实用工具补全** — 列表目录（ls）、网页抓取（fetch）、读取多文件（并行 read）
  - 理由：扩展可处理的任务类型（查项目结构/查网页/批量读）
  - 对标：Cline 的 fetch_web_content / pi 的 ls
  - 进度（2026-09-03）：**ls 已落地**（`tools/builtin.ts`，内置工具现为 5 个：ls / read / write / grep / bash），本条只剩 fetch 与并行 read 两项未做，故仍留 `- [ ]`。上一轮文档校准查出的“该划掉一半”即指此处

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
