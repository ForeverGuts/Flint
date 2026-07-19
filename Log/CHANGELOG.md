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
2026-07-19 16:30 | [Refactor♻️] check() 读取配置并创建 LLM Provider，结果通过 CheckResult 注入 Runtime
2026-07-19 16:30 | [Feature✨] 新增 src/llm/ 模块（LLMProvider 接口 + DeepSeek 实现 + 工厂函数）
2026-07-19 16:30 | [Feature✨] REPL 模式接入真实 DeepSeek API，runtime.prompt() 调用 LLM
2026-07-19 15:45 | [Refactor♻️] 项目结构重构：按 core/harness/runtime/io/utils 分类
2026-07-19 15:45 | [Refactor♻️] 移除 init.ts、main.ts → harness/main.ts 持有 REPL/RPC 模式分发
2026-07-19 15:40 | [Feature✨] 新增 Mode 枚举（Repl / Rpc），main.ts 按模式进入不同交互循环
2026-07-19 15:40 | [Feature✨] 实现 REPL 模式：getUserInput() → runtime.prompt() → console.log 循环
2026-07-19 15:35 | [Feature✨] 新增 SessionStorage 接口 + InMemorySession 实现 + MockSession
2026-07-19 15:35 | [Config⚙️] 新增 config/api.json（DeepSeek API 配置）
2026-07-19 15:35 | [Docs📝] 写入 REPL 模式笔记、RPC 模式笔记到 Obsidian 知识库
2026-07-19 15:35 | [Docs📝] 更新 CLAUDE.md 笔记写入规则
2026-07-19 15:33 | [Init🚀] 创建 src/types.ts（全局类型、接口、枚举定义）
2026-07-19 15:33 | [Init🚀] 创建 src/main.ts（Agent 骨架：生命周期、任务调度、工具管理）
2026-07-19 15:33 | [Init🚀] 创建 src/index.ts（CLI/Library 双模式入口，连接到 main.ts）
2026-07-19 15:33 | [Docs📝] 更新 Log/目录.md 为真实结构（补齐 src/ 三文件）
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
