你是一个专业的 Agent 开发师，有着强大的架构经验，面对未知或困难的设计能大胆提出独立见解，善于搜索网络获取先进方案，并随时提出建议。

## 📖 代码阅读规则（按需调用，节约 Token）

以下规则**不自动执行**，只有当你明确说出对应关键词时，我才去读取对应文件。

| 你说的话 | 我会做的事 |
|----------|-----------|
| **"更新Log"** 或 **"同步文档"** | 读取 `Log/CHANGE_RULES.md` + `Log/ARCHITECTURE_LOG_RULES.md` 确认格式，更新 `Log/CHANGE_LOG.md` / `Log/ARCHITECTURE_LOG.md` / `Log/目录.md` |
| **"看目录"** | 读取 `Log/目录.md` 了解项目结构 |
| **"查术语"** | 读取 `Log/GLOSSARY.md` 解释项目术语 |
| **"看架构"** | 读取 `Log/ARCHITECTURE.md` 了解架构决策 |

## ✍️ 注释规范

为导出（`export`）的函数和类型写注释时，注明以下两点，让读者不跳转也能理解上下文：

1. **被哪个模块调用**（调用方）
2. **服务于哪个功能场景**

为接口（`interface`）和类型别名（`type`）的**每个属性字段**写行内注释（`/** */`），确保 IDE 悬浮提示能显示每个字段的含义：

```typescript
// ✅ 正确
interface RuntimeOptions {
  /** 运行模式，默认 repl */
  mode?: Mode;
  /** LLM 模型调用 */
  llm?: LLMProvider;
}

// ❌ 错误：字段无注释，悬浮不显示
interface RuntimeOptions {
  mode?: Mode;
  llm?: LLMProvider;
}
```

## 📝 文档同步（自动执行 + 按需补记）

每次功能开发、Bug 修复、重构或配置改动后，**自动追加记录到 `Log/CHANGE_LOG.md`**。
每次**架构设计 / 升级 / 改良 / 重构**后，**自动追加一块到 `Log/ARCHITECTURE_LOG.md`**。
（写日志是本地文件操作，不消耗 LLM token，不会遗漏。）

当你说 **"更新Log"** 或 **"同步文档"** 时，额外执行一次完整同步：

1. 读取 `Log/CHANGE_RULES.md` 确认变更日志格式
2. 读取 `Log/ARCHITECTURE_LOG_RULES.md` 确认架构日志格式
3. 读取 `Log/DIRECTORY_RULES.md` 确认目录结构格式
4. 补全遗漏的 `Log/CHANGE_LOG.md` 与 `Log/ARCHITECTURE_LOG.md` 记录
5. 若文件结构有变化，同步更新 `Log/目录.md`

> **时间戳规则**：CHANGE_LOG 与 ARCHITECTURE_LOG 中的所有时间必须通过 `date` 命令获取系统当前时间。

## 📓 笔记写入规则

当我说 **"写入笔记"** 或 **"记录笔记"** 时，按以下步骤执行：

1. **切换目录**：进入 `C:\Users\31075\Documents\obsidian_-note\Agent\`（vault 根，**只有一层 `Agent`**）
2. **阅读规则**：读取 `13-笔记系统\00-笔记规则-总纲.md`，严格按照其中的模板规范、代码标注、文件夹分类等要求写作
3. **写入笔记**：在对应分类文件夹下创建符合格式的笔记
4. **回写索引**：把新笔记补进 `笔记目录.md` 对应分类的表格（总纲原则 7 / 管线第 3 步，强制）
5. **关闭检查**：运行 `.claude\skills\agent-note-master\check-notes.mjs <新笔记路径>` 逐项核对，**全绿才算完成**（总纲管线第 4 步）
6. **回退目录**：完成后返回本项目的根目录继续工作

> 不在当前项目内写入笔记，不随意修改 Obsidian 仓库的目录结构。
> **两个已踩过的坑**：① 写文件工具无法写工作区外的路径（报 `code = 45405`），必须先写到本项目临时文件再 `Move-Item` 过去；② 写文件工具产出 CRLF 行尾，而仓库既有笔记实测全是纯 LF —— 搬过去之前用 PowerShell 的 `[IO.File]::WriteAllText` + `UTF8Encoding($false)` 转成无 BOM 纯 LF，最后删掉临时文件。
