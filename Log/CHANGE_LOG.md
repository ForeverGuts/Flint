# 变更日志

> 格式：`YYYY-MM-DD HH:mm | [类型图标] 描述`
> 类型释义：
>   [Init🚀]    项目初始化 / 骨架搭建
>   [Feature✨] 新功能开发
>   [Fix🐛]     Bug 修复
>   [Refactor♻️] 重构 / 目录清理 / 代码重组
>   [Optimize⚡] 性能优化
>   [Config⚙️]  配置文件变更（package.json / tsconfig.json 等）
>   [Docs📝]    文档 / 注释 / 知识库
>   [Env📦]     环境 / 依赖安装与升级
>   [CI✅]      编译 / 构建 / 验证
字数限制：每段描述最多 1 行
不同日期的记录之间用空行隔开
2026-07-30 16:12 | [Feature✨] 新增 Provider 工厂路由：LLMConfig.provider 字段支持 deepseek/openai/anthropic/opencode-go
2026-07-30 16:12 | [Feature✨] 新增 AnthropicProvider：消息格式转换 + API 端点 + SSE 解析适配
2026-07-30 16:12 | [Refactor♻️] AnthropicAdapter → AnthropicProvider，统一 Provider 命名规范
2026-07-30 16:12 | [Config⚙️] config/api.json 切换为 OpenCode Go（opencode.ai/zen/go/v1 + deepseek-v4-flash）

2026-07-30 09:57 | [Feature✨] UI 全面升级：绿色启动 Banner 含版本/模型/后端/工具/skill/命令/会话/运行时信息
2026-07-30 09:57 | [Feature✨] 消息框统一样式：│ 前缀在流式换行时自动补齐，彻底解决框内错位
2026-07-30 09:57 | [Refactor♻️] TerminalUI 提取统一 top/mid/bot 框线函数，BOX_W=48 统一管理

2026-07-29 21:27 | [Fix🐛] fixJSON 负向后顾缺失破坏合法 JSON 导致 parseToolCalls 静默丢弃
2026-07-29 21:27 | [Fix🐛] fixJSON 排除列表放过 \t\n 导致路径含 \test/\new 被错误解析
2026-07-29 21:27 | [Fix🐛] permission.ts setRawMode 在非 TTY 下崩溃导致进程闪退
2026-07-29 21:27 | [Fix🐛] 权限弹窗 raw mode 残留 keypress 监听器干扰主 readline 导致工具不执行
2026-07-29 21:27 | [Refactor♻️] parseToolCalls 改为原生 JSON.parse 优先→fixJSON 兜底三段策略
2026-07-29 21:27 | [Refactor♻️] tools.ts 严格化：ToolInputError 校验 + requireString/optionalPositiveInt 统一参数提取
2026-07-29 21:27 | [Refactor♻️] 工具输出统一为 [STATUS_CODE] 格式（OK/NOT_FOUND/NO_MATCH/INVALID/ERROR）
2026-07-29 21:27 | [Refactor♻️] 工具参数 description 增加示例值，帮助 LLM 生成正确参数
2026-07-29 21:27 | [Refactor♻️] 移除 pick() 多别名宽松取参，只认规范参数名
2026-07-29 21:27 | [Docs📝] 完成全项目代码审计，识别 13 个潜在问题并归档至 DECISION_LOG

2026-07-27 18:47 | [Feature✨] 实现工具系统（Skill + Function Calling）：read/write/grep/bash 四个核心工具 + Agent Loop
2026-07-27 18:47 | [Feature✨] UI 拆分为独立组件（TerminalUI + StatusIndicator + spinner 动画）
2026-07-27 18:47 | [Refactor♻️] 工具调用逻辑从 runtime.ts 抽离到 utils.ts（parseToolCalls + estimateTokenUsage）
2026-07-27 18:47 | [Refactor♻️] prompt() 改为 chat() 检测工具 → stream() 最终输出双阶段模式
2026-07-27 18:47 | [Fix🐛] 工具调用 JSON 解析容错（多余引号/缺引号/单引号/尾随逗号）
2026-07-27 18:47 | [Config⚙️] 禁用 DeepSeek thinking 模式避免 tool loop 报错
2026-07-27 14:57 | [Docs📝] 同步 CLAUDE.md 规则到桌面元数据仓库
2026-07-27 14:57 | [Docs📝] 新增 Log/UPDATE_RECORD.md（更新追踪记录）
2026-07-27 14:30 | [Refactor♻️] 命令系统改为自动扫描模式（Loader 基类 + CommandLoader + SkillLoader）
2026-07-27 14:30 | [Refactor♻️] 事件系统改为组合模式（Runtime 持有 PromptEventEmitter 而非继承）
2026-07-27 14:30 | [Refactor♻️] 新增通用 EventStream 推拉通道，LLM 流式输出统一使用
2026-07-27 14:30 | [Feature✨] 新增 Token 用量统计与自动显示（本轮 + 累计）
2026-07-27 14:00 | [Config⚙️] CLAUDE.md 改为按需加载 Log 文件（节约 Token）
2026-07-27 14:00 | [Feature✨] UI 改为事件驱动模式（subscribe 替代 onToken 回调）
2026-07-24 10:20 | [Feature✨] prompt() 接入 session 记忆读写（历史消息拼入 LLM 请求 + 回复自动存入 JSONL）
2026-07-24 10:20 | [Fix🐛] readLine 管道模式下 ERR_USE_AFTER_CLOSE 修复（改用缓冲队列 + on('line') 提前收集）
2026-07-24 10:20 | [Feature✨] 程序重启后自动恢复持久化会话（JsonlSessionStorage.open 读取已有 .jsonl 文件）
2026-07-23 19:00 | [Feature✨] 新增 JsonlSessionStorage（JSONL 文件持久化，支持创建/加载/追加/清空）
2026-07-23 18:15 | [Docs📝] CLAUDE.md 接入元数据：新增阅读规则指向 GLOSSARY.md 和 ARCHITECTURE.md
2026-07-23 18:00 | [Docs📝] 新增 Log/GLOSSARY.md（项目术语表，统一术语解释）
2026-07-23 18:00 | [Docs📝] 新增 Log/ARCHITECTURE.md（架构决策记录，含 6 条核心决策）
2026-07-23 18:00 | [Docs📝] 新增 Log/DECISIONS.md（关键决策日志，二选一决策过程）
2026-07-23 18:00 | [Docs📝] 新增 Log/TESTING.md（测试策略：三层测试 + mock 方案）
2026-07-23 18:00 | [Docs📝] 导出项目元数据到桌面统一仓库（含归一化适配标记）
2026-07-23 17:35 | [Docs📝] 新增 Log/ROADMAP.md（开发路线图，按优先级排列待办模块）
2026-07-23 17:00 | [Refactor♻️] check() 读取配置并创建 LLM Provider，结果通过 CheckResult 注入 Runtime
2026-07-23 17:00 | [Feature✨] 新增 src/llm/ 模块（LLMProvider 接口 + DeepSeek 实现 + 工厂函数）
2026-07-23 17:00 | [Feature✨] REPL 模式接入真实 DeepSeek API，runtime.prompt() 调用 LLM
2026-07-23 16:15 | [Refactor♻️] 项目结构重构：按 core/harness/runtime/io/utils 分类
2026-07-23 16:15 | [Refactor♻️] 移除 init.ts、main.ts → harness/main.ts 持有 REPL/RPC 模式分发
2026-07-23 15:50 | [Feature✨] 新增 Mode 枚举（Repl / Rpc），main.ts 按模式进入不同交互循环
2026-07-23 15:50 | [Feature✨] 实现 REPL 模式：getUserInput() → runtime.prompt() → console.log 循环
2026-07-23 15:30 | [Feature✨] 新增 SessionStorage 接口 + InMemorySession 实现 + MockSession
2026-07-23 15:30 | [Config⚙️] 新增 config/api.json（DeepSeek API 配置）
2026-07-23 15:30 | [Docs📝] 写入 REPL 模式笔记、RPC 模式笔记到 Obsidian 知识库
2026-07-23 15:30 | [Docs📝] 更新 CLAUDE.md 笔记写入规则
2026-07-23 15:00 | [Init🚀] 创建 src/types.ts（全局类型、接口、枚举定义）
2026-07-23 15:00 | [Init🚀] 创建 src/main.ts（Agent 骨架：生命周期、任务调度、工具管理）
2026-07-23 15:00 | [Init🚀] 创建 src/index.ts（CLI/Library 双模式入口，连接到 main.ts）
2026-07-23 15:00 | [Docs📝] 更新 Log/目录.md 为真实结构（补齐 src/ 三文件）
2026-07-19 15:15 | [Docs📝] 新增 Pi Agent 参考规则，创建 Pi 目录索引
2026-07-19 15:15 | [Docs📝] CLAUDE.md 新增规则3：提及 Pi/Agent 对比时优先翻阅 Pi 的目录.md
2026-07-19 15:15 | [Docs📝] 为 pi-mono/packages/agent 创建 目录.md（完整架构索引）
2026-07-19 15:15 | [Refactor♻️] 分析 Pi Agent 全部 25 个源文件和 5 份设计文档
2026-07-19 15:15 | [Refactor♻️] 移除 src/ 和 dist/ 内所有文件，保留纯配置空壳
2026-07-19 15:15 | [Docs📝] 在 Obsidian 知识库创建 "TS 初始环境配置" 笔记组（5篇）
2026-07-19 15:15 | [Docs📝] 创建项目总览、package.json、tsconfig.json、.gitignore、CLAUDE.md 详解笔记
2026-07-19 15:15 | [Docs📝] 优化 CLAUDE.md 措辞，合并冗余规则，细化注释规范
2026-07-19 15:15 | [Docs📝] 补充 Log/目录.md 为完整项目结构索引
2026-07-19 15:08 | [Init🚀] 初始化 TypeScript + ESM 项目环境
2026-07-19 15:08 | [Config⚙️] 配置 package.json（type: module, ESM）
2026-07-19 15:08 | [Config⚙️] 配置 tsconfig.json（严格模式，NodeNext 模块解析）
2026-07-19 15:08 | [Init🚀] 搭建 src/ 目录结构（core/utils/types）
2026-07-19 15:08 | [Init🚀] 创建 CLI 入口、日志工具、类型定义、Agent 基类
2026-07-19 15:08 | [Env📦] 安装 TypeScript 5.7 / tsx / @types/node
2026-07-19 15:08 | [CI✅] 验证编译零错误，dev/build/start 均正常
