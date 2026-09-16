/**
 * `/projects` 命令 —— 多项目列表与切换（ROADMAP 10.11.1）。
 *
 * 调用方：commands/loader.ts 自动扫描（本目录每个导出 activate 的文件都会被加载）
 * 服务于：把 flint 从"一个项目"抬到"多个项目的平台"——
 *   ① **列表**：注册表 `~/.flint/projects.jsonl` 此前只在写（启动时登记 cwd），
 *      没有任何"看"的入口；名字/路径/最近活动一屏看完。
 *   ② **切换**：换 cwd + 重载注入上下文 + 换到那个项目的主会话，**不必重启 flint**。
 *
 * ── 切换为什么能成立（承重点）──
 * 全项目的项目级读写都用**相对路径**（`.flint/*`、`TASK.md`、`sessions/`、
 * `config/provider-keys.json`，以及 bash/git 工具的 `process.cwd()`），
 * 它们在**调用时**才解析，所以 `process.chdir()` 之后会自动指向新项目 ——
 * 这一半是"免费自愈"的。真正需要显式处理的只有**进程级单例的内存状态**：
 * taskStore / memoryStore / eventStore / charterLock，加上会话与技能清单。
 * 那几步收在 `harness/project-context.ts` 的 `seedProjectContext()` 里，
 * 与启动共用同一份实现（切换 = 对着新目录再走一遍启动那几步）。
 *
 * ── 两个不回滚/不重读的决定（边界，不装糊涂）──
 *   · **授权类配置清空而不重读**（package.json / .flint/postcheck.json）：理由是
 *     "运行期不回读"本身就是那条防线的一部分，多一个运行期读取点就把判据从"不许回读"
 *     退化成"谁触发的可以回读"。故切换后新项目的【项目命令】与改完自检**要重启才生效**，
 *     回执里明说。完整判据见 `harness/project-context.ts` 头部 ①。
 *   · **配置不动**（ConfigManager 是启动时构造的单例）：新项目若在
 *     `config/provider-keys.json` 里另配了密钥，本会话读不到，同样在回执里点明。
 */
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { Runtime } from '../../runtime/runtime.js';
import { normalizeProjectPath, projectRegistry } from '../../eventlog/registry.js';
import { seedProjectContext } from '../../harness/project-context.js';
import { commandRegistry } from '../../project/commands.js';
import { postcheckBaseline, postcheckRegistry } from '../../project/postcheck.js';
import {
  PROJECTS_USAGE,
  nameFromPath,
  parseProjectsArgs,
  pickProject,
  renderProjectList,
  renderSwitchReceipt,
  type ProjectRow,
} from '../../project/projects.js';

/** 切换后打开的主会话名（与 main.ts 启动时用的是同一个） */
const DEFAULT_SESSION = 'default.jsonl';

/**
 * 最近活动探测：只看几个**固定落点**，不递归整个项目目录
 * （递归 = 大项目上 `/projects` 会明显卡一下，而它只是个列表命令）。
 * 全都不存在 → null（列表里显示 `—`），不是 0 —— `0` 会被渲染成 1970。
 */
function lastActivityOf(dir: string): number | null {
  const probes = ['.flint/events.jsonl', '.flint/memory.md', 'TASK.md', '.flint', 'sessions'];
  let max: number | null = null;
  for (const rel of probes) {
    try {
      const m = statSync(path.join(dir, rel)).mtimeMs;
      if (max === null || m > max) max = m;
    } catch { /* 不存在 / 无权限 → 跳过（这是探测，不是断言） */ }
  }
  return max;
}

/** 把注册表 + 磁盘现状拼成列表行（注册表只记"用过"，目录可能在不在要现探） */
function buildRows(): ProjectRow[] {
  const current = normalizeProjectPath(process.cwd());
  return projectRegistry.list().map((r) => ({
    name: r.name,
    path: r.path,
    firstSeen: r.firstSeen,
    lastActivityMs: lastActivityOf(r.path),
    current: r.path === current,
    exists: existsSync(r.path),
  }));
}

type Target =
  | { kind: 'row'; row: ProjectRow }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; matches: ProjectRow[] };

/**
 * 把用户写的目标解析成一行。**名字**必须在注册表里（列表就是"你用过哪些项目"）；
 * **路径**写法不要求已登记 —— 项目身份本来就是 cwd，没登记过的目录切过去会由
 * `seedProjectContext()` 顺手登记上，没有理由拦。
 */
function resolveTarget(rows: readonly ProjectRow[], query: string): Target {
  const q = query.trim();
  if (/[\\/]/.test(q) || /^[a-zA-Z]:/.test(q)) {
    const p = normalizeProjectPath(q);
    const hit = rows.find((r) => r.path === p);
    if (hit) return { kind: 'row', row: hit };
    return {
      kind: 'row',
      row: {
        name: nameFromPath(p),
        path: p,
        firstSeen: '',
        lastActivityMs: lastActivityOf(p),
        current: p === normalizeProjectPath(process.cwd()),
        exists: existsSync(p),
      },
    };
  }
  const picked = pickProject(rows, q);
  if (picked.ok) return { kind: 'row', row: picked.row };
  return picked.reason === 'ambiguous'
    ? { kind: 'ambiguous', matches: picked.matches }
    : { kind: 'missing' };
}

/**
 * 换到新项目的主会话。**必须成功**（失败会抛，由调用方回滚 cwd）——
 * 半个状态下最坏的事是：session 对象里存的是**相对**路径 `./sessions/default.jsonl`，
 * chdir 之后它指向新项目，于是**上一个项目的对话会被续写进这个项目的会话文件**。
 * 故这里不"尽力而为"：要么换成新项目的会话，要么整个切换放弃。
 */
async function openProjectSession(runtime: Runtime): Promise<string> {
  if (await runtime.switchSession(DEFAULT_SESSION)) {
    const n = await runtime.getSessionMsgCount();
    return `${DEFAULT_SESSION}（${n} 条消息 · 该项目原有的主会话）`;
  }
  const created = await runtime.createSession('default');
  return `${created}（新建 · 该项目此前没有会话）`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function doSwitch(runtime: Runtime, rows: readonly ProjectRow[], query: string): Promise<string> {
  const target = resolveTarget(rows, query);

  if (target.kind === 'ambiguous') {
    return [
      `❌ 「${query}」匹配到 ${target.matches.length} 个同名项目，请用路径点名：`,
      ...target.matches.map((r) => `  ${r.path}`),
    ].join('\n');
  }
  if (target.kind === 'missing') {
    return `❌ 没有叫「${query}」的已登记项目。先 /projects 看列表，或直接给路径。`;
  }

  const row = target.row;
  if (row.current) return `ℹ️ 当前就在项目「${row.name}」里（${row.path}），未做任何改动。`;
  if (!row.exists) {
    return `❌ 项目「${row.name}」的目录已经不存在了（${row.path}）——注册表只是记账，不会替你把目录找回来。`;
  }

  const from = process.cwd();
  let sessionNote: string;
  try {
    process.chdir(row.path);
    try {
      sessionNote = await openProjectSession(runtime);
    } catch (e) {
      // 会话这步失败 → **回滚 cwd**。此刻 session 对象仍持有相对路径，回滚后它重新指回
      // 原项目，一切照旧；不回滚就落到上面 44 行注释里那个最坏状态。
      process.chdir(from);
      return `❌ 切换失败（已回滚到 ${from}）：打不开新项目的会话 —— ${errText(e)}`;
    }
  } catch (e) {
    return `❌ 切换失败（目录没进去）：${errText(e)}`;
  }

  const context = seedProjectContext();

  // 授权类配置：**清空，不重读**（判据见文件头）。不清的后果很具体 ——
  // 注入了 A 的项目命令、却在 B 的目录里跑 A 的 tsc，而且回执看不出来。
  commandRegistry.clear();
  postcheckRegistry.set(null);
  postcheckBaseline.set(null);

  return renderSwitchReceipt({ from, row, sessionNote, context });
}

export function activate(runtime: Runtime): void {
  runtime.registerCommand('projects', '多项目列表与切换（换 cwd + 重载上下文 + 换会话）', async (args: string) => {
    const parsed = parseProjectsArgs(args);
    if (parsed.action === 'help') return PROJECTS_USAGE;
    if (parsed.action === 'error') return `❌ ${parsed.message}`;

    const rows = buildRows();
    // 不带参数 = **只列不改**（理由见 project/projects.ts 头部：非 TTY 下交互选择器
    // 会自动返回第一项，而切换项目是最不该被"默认"的一步）。
    if (parsed.action === 'list') return renderProjectList(rows);
    return doSwitch(runtime, rows, parsed.query);
  });
}
