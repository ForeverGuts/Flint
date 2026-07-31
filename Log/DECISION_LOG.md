# ⏳ 关键决策日志

> 按时间倒序记录项目中遇到"二选一"或"新方案引入"时的决策过程和理由。

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
