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
