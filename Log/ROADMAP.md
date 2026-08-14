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

- [ ] **正式测试套件** — 引入 vitest，为 session/compaction/commands/rpc 等子系统建立正式单测（当前仅临时脚本）
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
- [ ] **可观测性增强** — 结构化 trace/span 观测层（当前仅 Diagnostic + debug log）
  - 对标：Pi 的 docs/observability.md

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
