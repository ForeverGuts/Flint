# 🧪 测试策略

> 现状：**不用任何测试框架**。10 套零依赖验证脚本、合计 **299 项**断言，可串跑；另有 1 个真实链路冒烟脚本。
> 本文档描述"实际是怎么测的"，不是"打算怎么测"。（旧版写的"测试框架未选型"已过期多年。）

---

## 一、选型：为什么没有测试框架

`package.json` 里**没有 `dependencies` 字段**（零运行时依赖），`devDependencies` 只有三个：`@types/node` / `tsx` / `typescript`。

要验的东西大多不适合框架的抽象：起假 HTTP 服务器演协议、夹逼 TTY 宽度、手工喂事件看配对、计启动阻塞的毫秒数。这些用 `node:http`、`process.stdout.columns`、直接构造对象写出来更直白，加一层 Vitest / Jest 反而要多学一套 API 与配置。

**换来的代价**（都是真缺口，见第七节）：没有覆盖率、没有 watch 模式、没有测试隔离机制（每个脚本自己管副作用与临时文件）。

## 二、验证脚本清单

全部在 `scripts/` 下，**项数合计 299**：

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

另有 `scripts/rpc-smoke.mjs`：起真子进程走 JSON-RPC、打**真实 API**，验"装配起来真能跑通一轮对话"。唯一会花钱的一项，不计入 299。

## 三、写法约定（现状，含不统一之处）

每个脚本**自带**断言函数，累计 `passed` / `failed`，末尾按 `failed` 决定退出码。

**断言函数名三种并存**（是债务不是设计）：

| 名字 | 签名 | 哪几套 |
|------|------|--------|
| `assert` | `(name, cond, detail?)` | c1 / c2 / c3 / startup / usage（5 套） |
| `check` | `(name, cond)` | events / extensions / phase-ab（3 套） |
| `ok` | `(name, cond)` | input / ui（2 套） |

**退出码行为一致、写法有四种变体**：`setTimeout(() => process.exit(failed > 0 ? 1 : 0), 100)`（5 套，留给异步句柄收尾）、`process.exit(failed === 0 ? 0 : 1)`（3 套）、`process.exit(failed > 0 ? 1 : 0)`（1 套）、`if (failed > 0) process.exit(1)`（1 套）。**十套都会在有断言失败时返回非零**，所以串跑靠退出码判断是安全的。

## 四、怎么跑

单套。Windows 下**必须**直连 node——`npx tsx` 会被 PowerShell 执行策略挡住：

```
node node_modules/tsx/dist/cli.mjs scripts/verify-events.ts
```

全量 10 套（PowerShell）：

```powershell
$x = '.\node_modules\tsx\dist\cli.mjs'
Get-ChildItem scripts\verify-*.ts | ForEach-Object {
  node $x $_.FullName | Select-String -Pattern '通过|失败'
  "$($_.Name) EXIT=$LASTEXITCODE"
}
```

路径别写成 `..\node_modules`——那指到项目外去了，10 套全 EXIT=1 且输出里看不出原因。

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

- **无覆盖率统计**：299 项覆盖了什么、漏了什么，只能人工判断
- **无 CI**：全靠手工跑，忘了跑就没有防线
- **`package.json` 里没有 verify / test 入口**：10 套只能手工循环跑（见第四节）
- 断言函数名三种并存、退出码写法四种变体
- **`clean` 脚本是 `rm -rf dist`，Windows 下根本跑不通**
- E2E 只有 RPC 冒烟一条，**REPL 交互没有端到端脚本**（输入处理只在单元层验）
- 集成层薄弱：多数脚本直接调子系统，很少真起 `Harness.run()`
