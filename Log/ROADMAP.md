   # 🗺️ 项目开发路线图

> 按**底层依赖 → 重要程度**排序。下层模块完成后才能支撑上层功能。

## ✅ 已完成

| 模块 | 说明 |
|------|------|
| 项目骨架搭建 | ESM + TypeScript 严格模式，core/harness/runtime/io/utils/llm 分层 |
| Harness 启动编排 | check() → main() 模式，闭包工厂创建 Runtime |
| REPL 交互循环 | getUserInput() → runtime.prompt() → onToken 流式输出 |
| LLM Provider 抽象 | LLMProvider 接口 + DeepSeek 实现（chat + stream） |
| Session 存储接口 | SessionStorage 接口 + InMemorySession + MockSession |
| 配置检查 | config/api.json 读取 → createProvider → CheckResult 注入 Runtime |
| 流式输出 | SSE 解析 + async generator + onToken 回调逐字显示 |

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

- [ ] **命令系统** — 支持可扩展的 `/` 命令（`/help`, `/clear`, `/model`, `/sys` 等）
  - 依赖：无（`/exit` 已有，只需抽成注册表）
- [ ] **模型选择与切换** — 运行时切换模型/Provider，不再写死在 JSON 里
  - 依赖：LLM Provider 抽象已就绪，只需加 CLI 参数或 `/model` 命令
- [ ] **对话历史管理** — 展示历史消息，支持回溯、编辑

### P2 — Agent 能力扩展

- [ ] **工具系统（Tool System）** — Agent 调用外部工具的能力（文件读写、bash、搜索等）
  - 依赖：上下文管理、命令系统
  - 影响：没有工具，Agent 只能聊天不能操作
- [ ] **技能系统（Skill System）** — 可加载的技能模板（`.pi/skills/*.md`）
  - 依赖：命令系统、工具系统

### P3 — 高级交互

- [ ] **事件订阅模式** — 用 subscribe/emit 替代 onToken 回调，支持 stream_token / tool_call / error 等细粒度事件
  - 依赖：无（可与当前回调模式并行）
  - 驱动因素：UI 需要区分"正在输出"、"正在调工具"、"出错了"等状态
- [ ] **多会话管理** — `/new`（新会话）、`/fork`（分叉）、`/switch`（切换）
  - 依赖：持久化存储、命令系统
- [ ] **RPC 模式** — JSON-RPC over stdin/stdout，供编辑器插件调用
  - 依赖：命令系统、事件订阅

### P4 — 生产化

- [ ] **配置系统增强** — 从 `config/api.json` 扩展到分层配置（全局/项目/会话级）
- [ ] **错误日志与诊断** — 结构化的错误收集、诊断报告
- [ ] **启动自检增强** — 网络连通检测、API key 有效性验证、模型列表拉取

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
