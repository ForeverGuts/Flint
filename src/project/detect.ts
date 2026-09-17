/**
 * 项目准入判据 —— 「这个目录算不算一个独立项目」。
 *
 * 调用方：project/probe.ts（`classifyProject()` 探完硬信息后交给本模块判）
 * 服务于：ROADMAP 10.11.6（通讯录保守准入 + 候选兜底）
 *
 * ── 为什么要有判据 ──
 * 在此之前，"进通讯录"的唯一条件是"你在那儿启动过一次 flint"（`ensure()` 无条件写）。
 * 于是家目录、盘根、node_modules 里的某个包、随手 cd 进去的临时目录，全都进簿子。
 * 这不只是列表难看 —— 通讯录有**两个读者，要的东西不一样**：
 *   · `/projects`（人读）要"值得回来看的项目"；
 *   · `pull_events`（模型跨项目拉经验）按**短名**找项目，重名时取**最先登记**那条，
 *     而且是**静默**取 —— 多登记一条 = 提高"拉到别人档案"的概率，且无人察觉。
 * 故判据的方向**偏保守**：宁可漏登记（代价 = 手输一次路径，或用 `/projects --add`），
 * 也不写垃圾条目（代价 = 静默拉错档案，用户和模型都发现不了）。
 * 与 `.gitignore` 那条"认不出即丢弃"是同一个判据 —— 看**哪种错更难发现**，
 * 只是这里站在写入侧（那边是展示侧）。
 *
 * ── 判据的层次（顺序是承重的，不是风格）──
 *   ① **硬排除**（家目录 / 临时目录 / 盘根 / node_modules）：不看证据，一票否决。
 *      理由是家目录：`~/.flint/` 是 flint 的**全局配置目录**（GLOBAL_DIR），不是项目档案 ——
 *      若把"有 .flint/"当证据、又排在排除之前，家目录就会凭这个必然命中。
 *   ② **实物档案**（`.flint/` 或 `TASK.md`）：最硬。它证明 flint 真在这儿工作过、自成一户。
 *      这条**可以推翻位置**：git 仓库子目录里若真有档案，那就是用户在把它当项目用。
 *   ③ **git 仓库**：在仓库里时，"独立单元是谁"交给 git 说。判据是
 *      `rev-parse --show-toplevel` **等于不等于** cwd —— 不是"有没有 `.git`"：
 *      后者会把仓库里每个子目录都当成新项目。
 *   ④ **清单文件**（package.json / pyproject.toml / …）：**只在不在任何仓库里时**才算证据。
 *      否则 monorepo 的每个子包都有 package.json，全会进簿子。
 *   ⑤ 都没命中 → **候选**：不写盘，回执里问一句。
 *
 * ── "候选"不是通讯录里的一种状态 ──
 * 候选**不进** projects.jsonl。簿子里要么是完整的一条，要么没有这一条 ——
 * 不引入"待确认"这种半成品状态（它会让两个读者都得各自过滤一遍）。
 *
 * ── 为什么不让模型判"这算不算项目" ──
 * 这个判断的直接后果是**写一个跨会话的持久文件**，而模型的答案是**不确定**的
 * （同一个目录两次可能答得不一样）。要机器判、输入明确；模型能参与的是"候选转正"
 * 那一步（用户点头），不是当判据本身 —— 与 `ask` 工具的分工同源（fail-closed）。
 *
 * 零运行时依赖（本文件连 node: 都不 import）：磁盘与 git 的探测由调用方做完喂进来。
 */

/**
 * 清单文件名 —— "这个目录是一个项目的根"的最弱证据。
 * 克制到五个：`requirements.txt` / `Makefile` 之类在子目录里遍地都是，会把这条判据打穿。
 *
 * ⚠ 这份清单同时也是 ROADMAP 10.1.1（技术栈自动探测）要用的**同一批原料** ——
 * 那个条目落地时**接这里**，别另开一份（两份清单迟早对不上，且症状是"探测到的技术栈"
 * 与"认成项目的理由"打架）。
 */
export const MANIFEST_FILES: readonly string[] = [
  'package.json', // Node / 前端
  'pyproject.toml', // Python（PEP 518）
  'go.mod', // Go
  'Cargo.toml', // Rust
  'pom.xml', // Java / Maven
];

/** 判成独立项目的理由（回执用；`explicit` 不是判据产物，是用户点名） */
export type ProjectVia = 'archive' | 'git-root' | 'manifest' | 'explicit';

/** 落进"候选"（不登记）的理由 */
export type CandidateReason = 'home' | 'tmp' | 'fs-root' | 'node_modules' | 'no-evidence';

export type ProjectVerdict =
  | { kind: 'independent'; path: string; via: ProjectVia }
  /** 是某个 git 仓库的子目录（且自己没有档案）→ 归并到仓库根，不新登记 */
  | { kind: 'nested'; path: string; root: string }
  /** 判不出来 → **不写盘**，回执里问一句 */
  | { kind: 'candidate'; path: string; reason: CandidateReason };

export interface ProjectProbes {
  /** 归一化绝对路径（正斜杠）—— 待判的目录 */
  cwd: string;
  /** 家目录（归一化）；取不到传 null */
  home: string | null;
  /** 临时目录（归一化）；取不到传 null */
  tmp: string | null;
  /** cwd 自己有 `.flint/` 或 `TASK.md` */
  hasArchive: boolean;
  /** cwd 命中的清单文件名（MANIFEST_FILES 之一）；没命中传 null */
  manifest: string | null;
  /**
   * git 仓库根（归一化）；不在仓库里 / git 不可用 → null。
   *
   * **是惰性回调而不是值**：判据走到 ③ 才需要它，而 ①②（家目录、盘根、node_modules、
   * 已有档案的项目）在**绝大多数启动**里就定案了 —— 那时为一个子进程付 15ms（冷启动可达
   * 数百 ms）是白花。做成回调后，"要不要付这个代价"由判据自己决定，
   * 且测试可以传一个"被调用就抛"的实现来钉住"这条分支不该探 git"。
   */
  gitRoot: () => string | null;
}

/* ── 路径比较：判据要**完备**，不能把"调用方已经归一化过了"当前提 ── */

/**
 * 折大小写 + 反斜杠转正斜杠 + 去尾斜杠。
 * 三样都要：Windows 路径不区分大小写；调用方可能喂进未归一化的串
 * （归一化是**另一层**的事，判据不能靠它兜底）；尾斜杠能让 `C:/a/b/` 与 `C:/a/b` 判成两个。
 */
function fold(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function samePath(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

function isInside(parent: string, child: string): boolean {
  const p = fold(parent);
  const c = fold(child);
  return c === p || c.startsWith(`${p}/`);
}

/** 整段相等才算（`my-node_modules` 不是 `node_modules`） */
function hasSegment(p: string, seg: string): boolean {
  return fold(p).split('/').includes(seg);
}

/**
 * 是文件系统根：`/`、`C:`（归一化去掉了尾斜杠）、`C:\`、或空串。
 * 未归一化的裸盘符 `C:`（在 Windows 上其实指"当前盘当前目录"）也会命中 ——
 * 方向是**往保守偏**（判成根 = 不登记），可以接受。
 */
export function isFsRoot(p: string): boolean {
  const t = p.replace(/[\\/]+$/, '');
  return t === '' || t === '/' || /^[a-z]:$/i.test(t);
}

/**
 * 判定。**顺序即结论**（每一条的理由见文件头），改动顺序等于改判据。
 */
export function judgeProject(p: ProjectProbes): ProjectVerdict {
  const cwd = p.cwd;

  // ① 硬排除 —— 在证据之前
  if (p.home !== null && samePath(cwd, p.home)) return { kind: 'candidate', path: cwd, reason: 'home' };
  if (p.tmp !== null && isInside(p.tmp, cwd)) return { kind: 'candidate', path: cwd, reason: 'tmp' };
  if (isFsRoot(cwd)) return { kind: 'candidate', path: cwd, reason: 'fs-root' };
  if (hasSegment(cwd, 'node_modules')) return { kind: 'candidate', path: cwd, reason: 'node_modules' };

  // ② 实物档案 —— 最硬，可推翻位置（含"我在仓库子目录里，但这个子目录我一直在用"）
  if (p.hasArchive) return { kind: 'independent', path: cwd, via: 'archive' };

  // ③ git 仓库：在仓库里时，独立单元由 git 说
  const root = p.gitRoot();
  if (root !== null && root !== '') {
    return samePath(cwd, root)
      ? { kind: 'independent', path: cwd, via: 'git-root' }
      : { kind: 'nested', path: cwd, root };
  }

  // ④ 清单文件（只在不在仓库里时）
  if (p.manifest !== null) return { kind: 'independent', path: cwd, via: 'manifest' };

  // ⑤ 候选
  return { kind: 'candidate', path: cwd, reason: 'no-evidence' };
}

/** 候选理由 → 人话（回执与启动提示共用一处文案） */
export function reasonText(reason: CandidateReason): string {
  switch (reason) {
    case 'home':
      return '这是家目录';
    case 'tmp':
      return '这是临时目录';
    case 'fs-root':
      return '这是磁盘根目录';
    case 'node_modules':
      return '这是依赖包目录（node_modules 下）';
    case 'no-evidence':
      return '这里没有 .flint/ 或 TASK.md，不是 git 仓库根，也没有清单文件';
  }
}
