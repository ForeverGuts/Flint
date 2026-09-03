# 🧪 测试策略

> 现状：**不用任何测试框架**。12 套零依赖验证脚本、合计 **359 项**断言，`npm run verify` 一条命令串跑；另有 1 个真实链路冒烟脚本。
> 本文档描述"实际是怎么测的"，不是"打算怎么测"。（旧版写的"测试框架未选型"已过期多年。）

---

## 一、选型：为什么没有测试框架

`package.json` 里**没有 `dependencies` 字段**（零运行时依赖），`devDependencies` 只有三个：`@types/node` / `tsx` / `typescript`。

要验的东西大多不适合框架的抽象：起假 HTTP 服务器演协议、夹逼 TTY 宽度、手工喂事件看配对、计启动阻塞的毫秒数。这些用 `node:http`、`process.stdout.columns`、直接构造对象写出来更直白，加一层 Vitest / Jest 反而要多学一套 API 与配置。

这**不是待定项而是已定结论**：ROADMAP P6 曾挂着一条“引入 vitest”的待办（立项于 2026-08-14），与本文立场矛盾，已于 2026-09-03 勾选关闭；二选一的完整取舍（含“立项时写的痛点已消失”与“迁移期会出现两套测试体系”两条理由）记在 [DECISION_LOG.md](./DECISION_LOG.md)。

**换来的代价**（都是真缺口，见第七节）：没有覆盖率、没有 watch 模式、没有测试隔离机制（每个脚本自己管副作用与临时文件）。

## 二、验证脚本清单

全部在 `scripts/` 下，**项数合计 359**（其中 11 套是 `.ts` 走 tsx、`verify-docs.mjs` 一套直跑；末尾两套为 2026-09-03 新增）：

| 脚本 | 项数 | 验什么 | 手法 |
|------|-----:|--------|------|
| `verify-phase-ab.ts` | 13 | 阶段 A1/A2/A3 + B 计划驱动循环、重复失败保护、轮数耗尽优雅收尾 | 脚本化假 LLM |
| `verify-c1.ts` | 8 | thinking 三态是否下发到请求体、`reasoning_content` → `reasoning` 事件 | **本地假 OpenAI 兼容服务器**：捕获请求体 + 回放预制 SSE/JSON |
| `verify-c2.ts` | 16 | auto 判定按次下发、覆盖优先级（opts > config）、复选框检测、清单全勾选时清理 | 驱动 AgentLoop 与 stream-helper，用假 llm 断言下发参数 |
| `verify-c3.ts` | 17 | Anthropic thinking 参数消费、budget 约束、精确安全阀、多轮回放端到端 | 假 Anthropic 服务器 + **真实 AgentLoop** 驱动两轮 |
| `verify-input.ts` | 22 | 多行粘贴不被吞、控制键解析、缓冲区状态 | 造场景把 chunk 喂给 InputHandler |
| `verify-ui.ts` | 72 | 框宽随终端自适应、宽字符测宽、emoji 代理对不被劈开、流式渐进渲染、回合指示器 | 造 TreeUI + `setCols()` 改终端宽度 |
| `verify-usage.ts` | 22 | L3 真实 usage 两条协议路径、索取用量的兼容降级 | 一台假服务器**按 URL 分流演两种协议** |
| `verify-startup.ts` | 32 | 启动关键路径 0 次 fetch、模型列表预热 / inflight 去重 / 新鲜期 | 临时配置文件 + `TS_AGENT_CONFIG` 指过去，造多家供应商 |
| `verify-events.ts` | 76 | 总线盖戳、四组骨架段配对守恒、便签通道、落盘端到端、`/traces` 排版 | **手工构造事件对象喂给 SpanCollector** |
| `verify-extensions.ts` | 21 | 三类扩展各自装载、watcher 的 ctx 里确实没有 `on` | **探针法**（见第六节） |
| `verify-session.ts` | 47 | 会话存储契约收敛后的行为等价：三个实现的可选成员真值表、“能力探测 ≡ instanceof”穷举对比（3 实现 × 3 成员）、`msgId` 兜底链、fork 后**原文件一字未动** | 造真 `Runtime` 但只注入真 session（其余 10 个必注入用替身）+ `fs.mkdtempSync` 临时目录 |
| `verify-docs.mjs` | 13 | `Log/` 下全部 markdown 的**锚点死链**（同文件 + 跨文件）+ 入站锚点契约 | 按 GitHub slug 规则算标题锚点再比对引用 |

另有 `scripts/rpc-smoke.mjs`：起真子进程走 JSON-RPC、打**真实 API**，验"装配起来真能跑通一轮对话"。唯一会花钱的一项，不计入 359。

`verify-docs.mjs` **只查锚点、不查“文档里提到的文件路径是否存在”**：后者实测误报率过高（扫出 31 个候选，28 个是裸文件名、运行时产物、或“故意提到不存在的东西”的说明性引用），要压住得维护一张例外表，收益不抵成本；锚点检查则零误报。理由写在脚本头注释里。

另注，这套的项数**不固定**：①② 两段是“每份有引用的文档一条断言”，所以 Log/ 下新增文档、或给原本没外链的文档加一条引用，项数就会变（本轮就从 12 变成 13，因为本文加了指向 DECISION_LOG 的引用）。其余十一套的项数是固定的。

## 三、写法约定（现状，含不统一之处）

每个脚本**自带**断言函数，累计 `passed` / `failed`，末尾按 `failed` 决定退出码。

**断言函数名三种并存**（是债务不是设计）：

| 名字 | 签名 | 哪几套 |
|------|------|--------|
| `assert` | `(name, cond, detail = '')` | c1 / c2 / c3 / startup / usage（5 套） |
| `check` | `(name, cond, detail?)` | events / phase-ab / session / docs（4 套）；extensions 那套参数名不同，是 `(desc, ok, extra?)` |
| `ok` | `(name, cond)` | input / ui（2 套） |

**退出码行为一致、写法有四种变体**：`setTimeout(() => process.exit(failed > 0 ? 1 : 0), 100)`（5 套，留给异步句柄收尾）、`process.exit(failed === 0 ? 0 : 1)`（3 套）、`process.exit(failed > 0 ? 1 : 0)`（3 套：input / session / docs）、`if (failed > 0) process.exit(1)`（1 套）。**十二套都会在有断言失败时返回非零**，所以串跑靠退出码判定是安全的。

串跑入口 `run-verify.mjs` 自己还有第五种写法（`process.exit(bad > 0 || totalFail > 0 ? 1 : 0)`），它不算套件——名字不匹配 `^verify-`，所以不会把自己也跑一遍。

## 四、怎么跑

全量 12 套，一条命令：

```
npm run verify
```

末尾打一张逐套的通过 / 失败 / 退出码表，再给合计。哪套失败就把那套的原始输出打出来（否则只看到一行 ❌ 不知道错在哪）；结果行解析不出来的会把项数记为 `?` 并计入合计外提示，**不会静默当成通过**。

Windows PowerShell 下 `npm` 会被执行策略挡住（报 `无法加载文件 C:\Program Files\nodejs\npm.ps1，因为在此系统上禁止运行脚本`），改用 `npm.cmd run verify`，或直连 node：

```
node scripts/run-verify.mjs
```

单套。`.ts` 的十一套**必须**直连 node 走 tsx——`npx tsx` 同样被执行策略挡住：

```
node node_modules/tsx/dist/cli.mjs scripts/verify-events.ts
```

`.mjs` 的那套直接 `node scripts/verify-docs.mjs`。

路径别写成 `..\node_modules`——那指到项目外去了，全套 EXIT=1 且输出里看不出原因。

## 五、一条重要约束：scripts/ 不受 tsc 检查

`tsconfig.json` 的 `include` 只有 `["src/**/*.ts"]`、`rootDir` 是 `src`，所以**验证脚本没有类型检查保护**。

这是有意的取舍：脚本要造各种替身、塞假字段、探内部状态，受严格类型约束会写不动（`src` 那边开着 `strict` / `exactOptionalPropertyTypes` / `noUnusedLocals` / `noUnusedParameters` / `verbatimModuleSyntax`）。

代价是脚本里的类型错误只能在运行时暴露——**所以脚本必须真跑**，不能因为"编译没报错"就当验过了。

## 六、几种手法

**假服务器**（c1 / c3 / usage）：`http.createServer` 捕获请求体、回放预制响应。价值在于能断言"我们到底发了什么参数出去"（例如 `stream_options.include_usage` 有没有带上），且不消耗真实 API。

**探针法**（extensions）：往三类扩展目录各临时放一个探针文件，探针把**实际收到的 ctx 的键**记到 `globalThis`，再断言。为什么必须这么绕——"watcher 的 ctx 里没有 `on`"这条约束是**类型层面**的，类型在运行时被擦除，光读代码不算证据，只能让运行时自己报出它拿到了什么。这套断言做过反向验证：故意把 `on` 递给 watcher，探针立刻咬人。

**手工喂事件**（events）：直接构造事件对象喂给 `SpanCollector`，断言配对结果。好处是能验到真实链路里难复现的情形——例如精确验证"嵌套段不能相加"：喂 prompt 1000ms + 内嵌 llm_request 800ms，断言合计显示 `1.0s` 而不是 `1.8s`；还有孤儿 end 被忽略、未关门段进 `running()`、过滤词与"正在跑"块的交互。

**真实链路冒烟**（rpc-smoke.mjs）：起真子进程、真 API，验装配正确性与命令自动装载。它会写 `sessions/*.jsonl`，**跑完记得清掉**（该目录已 gitignore，但仍是残留）。

## 七、缺口（已知未做，别误以为已覆盖）

- **无覆盖率统计**：359 项覆盖了什么、漏了什么，只能人工判断。已知的漏：compaction / commands / rpc 三个子系统没有专套（只被其他脚本间接碰到）
- **无 CI**：仓库里没有 `.github/workflows`（也没任何其他 CI 配置）。`npm run verify` 的退出码已经能直接交给 CI，但**还没人接**，仍是手工跑，忘了跑就没有防线
- 断言函数名三种并存、退出码写法四种变体（见第三节）
- E2E 只有 RPC 冒烟一条，**REPL 交互没有端到端脚本**（输入处理只在单元层验）
- 集成层薄弱：多数脚本直接调子系统，**没有一套真起 `Harness.run()`**（最接近的是 `verify-session.ts`，它造了真 `Runtime`，但 11 个必注入里只有 session 是真的，其余用替身）
- **文档只查锚点不查路径**：`verify-docs.mjs` 管不到“文档里提到的文件是否存在”，而这类失真真发生过（上一轮就从 `目录.md` 里删了三个幽灵条目：`CLAUDE.init.md` / `src/utils/error-log.ts` / `src/persistence.ts`）。不查的理由见第二节

（2026-09-03 从本节划掉两条已修的：“`package.json` 里没有 verify / test 入口”→ 现有 `verify` / `typecheck` / `clean` 三个；“`clean` 是 `rm -rf dist` 在 Windows 跑不通”→ 改为 `node scripts/clean.mjs`，用 `fs.rmSync` 的 recursive + force。）
