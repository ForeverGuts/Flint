# flint

**零运行时依赖、秒级启动的命令行 AI Agent。** TypeScript 写的，跑在你自己的终端里。

一句话概括它的取向：**能用最少的东西干最多的活，同时在你会后悔的地方提前把路堵上。**

---

## 这是什么

一个 Agent 的"壳"：接上大模型，给它一堆工具（读文件、改文件、跑命令、查 git……），让它在你的项目里干活。

flint 关心的不是"模型能调多少工具"，而是**另外两件事**：

1. **启动要快** —— `dependencies` 里一个包都没有，装完就能跑，冷启动不靠缓存预热。
2. **出格的地方要有闸** —— 写工作区外的文件、删整棵树、改你没让它改的目标，都在工具执行之前被拦掉，而不是事后回滚。

---

## 快速开始

```bash
npm install
```

**配一个模型**（flint 自己不带任何 key）：

```bash
cp config/active-config.example.json config/active-config.json
```

然后填进去：

```json
{
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "sk-你的key",
  "model": "deepseek-v4-flash",
  "provider": "deepseek",
  "thinking": "auto"
}
```

密钥也可以不写进文件——优先级是 **环境变量 > 全局 `~/.flint/config.json` > 项目 `config/provider-keys.json`**，后两个都不会进版本库。

**跑起来：**

```bash
npm run dev          # 开发模式（tsx watch）
npm run build && npm start   # 编译后跑
```

Windows 下也可以直接双击 `start.bat`。

---

## 它能做什么

**20 个内置工具**，分成三组：

| 组 | 工具 |
|---|---|
| 看 | `ls` `read` `grep` `symbols` `refs` `git` |
| 改 | `write` `edit` `git_write` `trash` |
| 干 | `bash` `spawn` `task` `ask` `archive` |
| 记 | `todo` `memory` `record_event` `search_events` `pull_events` |

**18 个内置命令**（`/` 开头，在输入框里打）：`/plan` `/workspace` `/projects` `/charter` `/compact` `/memory` `/events` `/traces` `/history` `/undo` `/tasks` `/sessions` `/usage` `/model` `/help` `/clear` `/diagnostics` `/edit-model`。

几个值得单独说的：

- **`@文件`** —— 输入里写 `@src/foo.ts`，内容会被读进来放进末尾附件区，不用先手动复制。
- **改完自检** —— 项目根放一份 `.flint/postcheck.json` 写上要跑的命令，之后每次写文件都会自动跑一遍，结论直接跟在回执后面（只报这次新增的问题，启动前就有的旧错不刷屏）。
- **删除可逆** —— 所有删除都进 `.flint/trash/`，`/undo` 能还原。
- **计划模式** —— `/plan on` 之后写类工具一律被拒，只有你自己打得出 `/plan off`。

---

## 三条设计取舍

这三条是 flint 的骨头，改动它们等于换了个项目：

**① 零依赖 + 秒级启动，这本身就是护栏。**
不是"顺手做到的洁癖"——一个依赖少的 Agent，攻击面小、冷启动快、行为可预测。往 `dependencies` 里加东西，等于用这三样去换一点开发方便。

**② 护栏不是沙箱。**
flint **不隔离执行**，它只在工具执行之前按**字面形态**拦一道。这不是"弱版沙箱、以后升级"，是**另一种做法**：沙箱要把命令关进隔离环境里跑，成本与"零依赖 + 秒级启动"直接冲突。代价要认：**同一个意思换个写法（变量、命令替换、塞进脚本）就绕得过去**，而且 `bash` 里的写操作不受工作区闸管（只管 `write` / `edit`）。

**③ 不用测试框架。**
没有 vitest / jest，是 **65 套零依赖验证脚本、4233 项断言**，`npm run verify` 一条命令串跑。每套脚本末尾打印 `结果：N 通过 / M 失败`，串跑靠退出码判定。代价：**没有覆盖率统计**——覆盖了什么、漏了什么，只能靠人判断；所以每加一条判据都要做"故意改坏"的验证，改坏了却全绿 = 这条断言没承重。

---

## 目录结构

```
src/
├── core/          契约层（11 个文件，子系统之间只通过这里的接口说话）
├── runtime/       Runtime：只编排一次 prompt 的流程，不持有实现
├── harness/       编排层：组装依赖 + 模式分发（REPL / RPC）
├── loop/          Agent 循环 + 计划模式
├── tools/         工具注册表 + 20 个内置工具 + 路径解析
├── permission/    四道闸：危险命令 / 工作区外写 / 删除改道 / bash 写纳管 + 审计留痕
├── process/       子进程整树终止（bash 与改完自检共用）
├── project/       项目生命周期协议、改完自检、技术栈画像、仓库状态
├── git/           git 只读结构化 + 写侧判据 + bash 裸 git 路由
├── todo/ memory/ eventlog/   三个内存真相源（文件只是投影）
├── search/        内容扫描（grep / symbols / ls 共用一套遍历与跳过表）
├── context/       压缩与系统提示词
├── commands/      18 个内置命令
├── io/            终端 UI（TTY 组件树 / 管道模式）
└── llm/           Provider 工厂（DeepSeek / Anthropic）

Log/               项目文档（15 份，下面有地图）
scripts/           65 套验证脚本 + 文档同步工具
```

`Log/` 里最值得看的四份：

| 文件 | 是什么 |
|---|---|
| `ARCHITECTURE.md` | 分层结构 + 11 条已知架构债（哪些修了、哪些刻意不修） |
| `DECISION_LOG.md` | 每条设计决策的**岔路与理由**（不是结论清单，是"当时为什么这么选"） |
| `TESTING.md` | 65 套脚本的清单与统计口径 |
| `ROADMAP.md` | 做了什么、没做什么、为什么不做 |

---

## 开发

```bash
npm run typecheck   # TypeScript 类型检查
npm run verify      # 串跑 65 套验证脚本
npm run docs:sync   # 把实测真值写回 Log/ 的生成区（数字不靠人记）
```

**注意**：`tsconfig.json` 的 `include` 只有 `src/**/*.ts`，所以 **`scripts/` 不受类型检查**——改了脚本必须真跑才算验过。

---

## 已知边界（不装糊涂）

- **护栏不是沙箱**（见上），绕过方式真实存在。
- **`scripts/` 不进类型检查**（有意为之：脚本要造替身、塞假字段）。
- **无覆盖率统计**，靠变异测试补。
- **Windows 是主战场**：子进程按树终止在 POSIX 上走进程组，路径未在本机实测过。
- **路线图还有 26 项候选没做** —— 它们都在 `ROADMAP.md` 里躺着，看得到、也看得出为什么暂时不做。

---

## 许可证

[MIT](./LICENSE)
