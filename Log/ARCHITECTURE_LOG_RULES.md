# ARCHITECTURE_LOG_RULES — 架构演进日志书写规则

> 本文件是架构演进日志的**格式规则书**，不包含实际记录。
> AI 在每次**系统架构设计 / 升级 / 改良 / 重构**后，**必须**按此规则将记录写入 `Log/ARCHITECTURE_LOG.md`。

---

## 用途

与 CHANGE_LOG（一行一条的全量变更）互补：

| 文件 | 记录范围 | 粒度 |
|------|---------|------|
| `Log/CHANGE_LOG.md` | 所有改动（功能/修复/重构/配置） | 一行一条 |
| `Log/ARCHITECTURE_LOG.md` | **架构层面**的演进（设计新系统 / 升级 / 改良 / 重构） | 一**块**一次 |

## 记录范围

- **记录**：设计新系统架构、对现有架构升级/改良/重构
- **不记录**：新增功能、Bug 修复本身（除非该改良同时解决了其中的部分问题，此时应在"面向的问题"中点明）

## 格式

每次变更写成一**块**，包含 6 个要素：

```
<a id="log-YYYY-MM-DD-短名"></a>
## YYYY-MM-DD HH:mm | 主题（一句话概括）

**牵连系统 / 层次**：涉及哪些子系统 / 目录 / 层次

**面向的问题**：
- 这个改动针对什么痛点（可多条）

**做出的改动**：
- 具体改了什么（可多条）

**解决的问题**：
- 效果，解决了哪些问题（可多条）

**未来可优化**：
- 留下的演进空间（可多条）

---
```

规则：

- 块之间用 `---` 分隔
- 新记录追加在文件顶部（与 CHANGE_LOG 一致，时间倒序）
- 时间通过 `date` 命令获取系统当前时间，禁止估计
- 可把散落的细粒度 Refactor 归并到所属大主题，不单独成块
- **每条新记录必须在 `##` 标题上方加一行 `<a id="log-YYYY-MM-DD-短名"></a>`（2026-09-11 起）**。这是**稳定锚点**：本文件是 append-only，条目只追加不改写，所以 id 写一次就永不改；别的文档引用它时用 `[说明](./ARCHITECTURE_LOG.md#log-…)`，短、纯 ASCII、且不随你日后如何重述标题而断。不用显式 id 的话，锚点由标题文字算出（`f(标题文字)`），"链接不断"就只能靠"标题文字不许改"——为了让机器能链接，人类散文被冻住。约定与检查见 [ARCHITECTURE_LOG.md](./ARCHITECTURE_LOG.md#log-2026-09-11-doc-number-check) 与 `scripts/verify-docs.mjs` 第 ③ 段
- **旧条目不要补 id**。给历史条目补 id 性质上是"改写历史条目"，与本文件的 append-only 纪律冲突；纯增量，从新条目开始带即可

## 示例

```
## 2026-08-28 16:40 | 提示词缓存优化：分层 system 消息 + Anthropic 缓存断点

**牵连系统 / 层次**：SystemPromptService（context/ + core/）· CompactionService（context/ + core/）· Runtime 编排层（runtime/）· Provider 转换层（llm/anthropic.ts）

**面向的问题**：
- 系统提示词单条动态混合（工具/技能/规则/摘要一次 build），任一动态部分变化即整条缓存失效
- 会话摘要被 unshift 进 history[0] 污染历史前缀，且被二次发送

**做出的改动**：
- SystemPromptService.build 改返回分层 system 消息数组（core→tools→skills→summary，稳定前缀在前）
- CompactionService.maybeCompact 改返回 { history, summary }，摘要独立交付不再混入历史
- Anthropic 转换层：稳定段各设 cache_control 断点、摘要段不设；tools 改 {name, input_schema} 格式

**解决的问题**：
- 稳定前缀缓存命中率提升：工具/技能/摘要各自变化只作废对应层及之后的缓存
- 消除摘要污染历史前缀 + 二次发送；Anthropic 从"分层即坏"到"带缓存断点可用"

**未来可优化**：
- 长文档/参考文档层预留位（core 之后、tools 之前）
- Anthropic 流式 message_delta 的 stop_reason 未利用

---
```

## 输出路径

```
Log/ARCHITECTURE_LOG.md
```
