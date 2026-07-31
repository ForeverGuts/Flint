# DIRECTORY_RULES — 目录结构书写规则

> 本文件是 `Log/目录.md` 的**格式规则书**。
> 每次文件/目录有新增、删除或职责变化时，AI **必须**按此规则更新 `Log/目录.md`。

---

## 内容要求

`Log/目录.md` 包含三部分：

### 1. 树状目录结构

使用 `` ``` `` 包裹，展示完整的项目目录树。每个文件末尾标注 `# 职责说明`。

### 2. 文件调用关系

使用 `` ``` `` 包裹，展示关键的调用链路：

```
index.ts → harness/index.ts → check.ts → main.ts → runtime.ts
```

### 3. 目录职责表

| 目录/文件 | 职责 | 是否提交 |
|-----------|------|---------|

- `✅ 是` = 提交到 git
- `❌` = 被 .gitignore 排除
- `⚠️` = 部分排除

## 示例

```
src/
├── index.ts            # 程序入口
├── harness/
│   └── index.ts        # Harness 编排类
└── runtime/
    └── runtime.ts      # Runtime 类
```

## 输出路径

```
Log/目录.md
```
