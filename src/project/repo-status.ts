/**
 * 仓库状态注入（ROADMAP 10.5.5，**判据**半边）—— 把"这个项目的 git 当前在哪"从
 * "模型每次自己 `bash git status` 现探"变成"播种时探一次、每轮渲染进上下文"。
 *
 * 调用方：`project/probe.ts`（探针，唯一跑子进程处）、`context/system-prompt.ts`（注入侧）、
 *         `harness/project-context.ts`（播种）、`scripts/verify-repo-status.ts`
 * 服务于：模型现在**不知道自己在哪条分支、工作区脏不脏**——每次要先用 `bash` 跑一条 `git status`
 *         才看得见。而 `bash` 走的是弹窗 / 危险闸通道，纯"想看一眼状态"却要付出交互代价，
 *         且只回原始文本（分支领先落后得自己数 porcelain 码）。本条把这份信息在**会话起点**
 *         就摆进视野，与 10.1.1（技术栈画像）/ 10.2.1（规约读取）同一形状。
 *
 * ── 为什么是"播种一次、运行期只渲染不回读" ──
 * 与 stack / rules / commands **同一判断**：这几样都是"这个项目长什么样"的展示内容，
 * 播种时（启动与切项目）各探一次进注册表，运行期只渲染。**理由同 stack.ts 文件头**：
 * 命令表的包管理器前缀由 stack 派生，刷新率必须一致才不会出现两处口径；规约/画像/状态
 * 同层出现，缺省约定都是"会话内基本不变"。
 *
 * ── ⚠C4 的答法（"仓库状态是每轮变的，播种一次不就过时了？"）──
 * 是，且**这是刻意的**。本段定位是"会话起点快照"，就像进办公室时看一眼墙上的项目看板——
 * 告诉你"这轮开始你在哪"。会话中途你 commit 了 / 切了分支，看板不会自动翻页，
 * 但**随时可以** `git status` 工具查实时状态（那是另一条通道，且是结构化的）。
 * 选择"播种一次"而非"每轮跑 git"的理由两条：
 *   ① 不把"每轮一次子进程"塞进请求的必经之路（破坏"秒级启动 / 零额外 IO"护栏）；
 *   ② 与 stack/rules/commands 同刷新率，避免"画像说在 main 分支、状态段说在 dev"这种分家。
 * 故边界写清楚：**这是起点快照，不是实时账**；要实时用 git 工具。不装糊涂。
 *
 * ── 解析复用 git.ts（单源，不重造轮子）──
 * `parseStatus` 是 `git.ts` 里已落地的 porcelain 解析（同一条 `status --porcelain=v1 -z --branch`），
 * 本模块只 import **类型**（`import type`），运行期零依赖；真正把字节喂给 parser 的是 `probe.ts`
 * （它跑子进程）。这样"解析两字母码"这件事全仓只有 git.ts 一份，本模块只做"把解析结果
 * 压成要展示的视图 + 渲染"。
 *
 * 零运行时依赖：本文件**只** `import type` 一个类型（编译期抹掉），不碰 fs、不起进程、不 import 任何值。
 */
import type { RepoStatus } from '../git/git.js';

/** 压平后的仓库状态视图（注入用的纯数据）。`null` 由探针用来表示"不是 git 仓库 / 探测失败"。 */
export interface RepoStatusView {
  /** 是否在 git 仓库内（探针探失败 = false，整段缺席） */
  inRepo: boolean;
  /** 当前分支名；detached 时为 null（游离头没有分支名） */
  branch: string | null;
  /** HEAD 游离（不在任何分支，如 detached checkout / rebase 中途） */
  detached: boolean;
  /** 分支已建但还没有任何提交（unborn，如 `git init` 后未提交） */
  unborn: boolean;
  /** 领先上游的提交数（无上游 = 0） */
  ahead: number;
  /** 落后上游的提交数（无上游 = 0） */
  behind: number;
  /** 已暂存改动条目数（XY 的 X 位是真实变更码，且非未跟踪/忽略） */
  staged: number;
  /** 未暂存改动条目数（XY 的 Y 位是真实变更码，且非未跟踪/忽略） */
  unstaged: number;
  /** 未跟踪文件数（xy === '??'） */
  untracked: number;
}

/** XY 两字母码里"算一次真实改动"的字符集（M/A/D/R/C/T，U 是冲突——也算脏，计入对应半边） */
const DIRTY = /^[MADRCTU]/;

/**
 * 把 `parseStatus` 的完整结果压成展示视图（**纯函数**）。
 *
 * 计数口径：
 *   · `??` 未跟踪 → 只进 `untracked`，不计入 staged / unstaged（它俩指"已纳入版本控制的改动"）；
 *   · `!!` 已忽略 → 跳过（忽略文件不是"脏"，模型不必操心）；
 *   · X 位为变更码 → `staged++`（已暂存）；Y 位为变更码 → `unstaged++`（未暂存）；
 *     重命名 `R ` 的 X 位是 `R`（变更码）→ 计 1 次已暂存，Y 位是空格 → 不计未暂存。
 * 这正是 `git status -z` 的语义；本函数只做"按位归类"，不重新发明判定。
 *
 * 入参一定是合法 `RepoStatus`（探针只在没有失败时才调它），故这里不判空——
 * "不是仓库"由探针返回 null 表达，不经过本函数。
 */
export function summarizeRepoStatus(s: RepoStatus): RepoStatusView {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const e of s.entries) {
    if (e.xy === '??') { untracked++; continue; }
    if (e.xy === '!!') continue; // 已忽略：不算脏
    const x = e.xy[0] ?? ' ';
    const y = e.xy[1] ?? ' ';
    if (DIRTY.test(x)) staged++;
    if (DIRTY.test(y)) unstaged++;
  }
  return {
    inRepo: true,
    branch: s.detached ? null : s.branch,
    detached: s.detached,
    unborn: s.unborn,
    ahead: s.ahead,
    behind: s.behind,
    staged,
    unstaged,
    untracked,
  };
}

/**
 * 渲染注入用的【仓库状态】节。**非仓库 / 探测失败（null）→ 空串**（整段缺席）——
 * 与 project / memory / task 各层同一纪律：没有就不注入，别拿空壳占上下文。
 *
 * 三行以内讲清：在哪条分支、领先落后多少、工作区干不干净。标题里那句"会话起点快照 / 实时用 git 工具"
 * 是**给模型的路标**——它读不到"这段是何时探的"，这句话替它划清"这是起点状态"的边界，
 * 免得它把陈旧分支名当成实时真相去 commit。
 */
export function renderRepoStatusSection(v: RepoStatusView | null): string {
  if (!v || !v.inRepo) return '';
  const lines: string[] = [];
  if (v.detached) {
    lines.push('HEAD 游离（不在任何分支上）');
  } else if (v.unborn) {
    lines.push(`分支：${v.branch ?? '（未知）'}（尚无任何提交）`);
  } else {
    lines.push(`分支：${v.branch ?? '（未知）'}`);
  }
  if (v.ahead > 0 || v.behind > 0) {
    lines.push(`领先上游 ${v.ahead} / 落后 ${v.behind}`);
  }
  const dirty = v.staged + v.unstaged + v.untracked;
  if (dirty === 0) {
    lines.push('工作区干净');
  } else {
    lines.push(
      `工作区：${v.staged} 处已暂存改动、${v.unstaged} 处未暂存改动、${v.untracked} 个未跟踪文件`,
    );
  }
  return `[仓库状态]（会话开始时的快照；实时状态用 git 工具查询）\n- ${lines.join('\n- ')}`;
}

/**
 * 当前仓库状态（内存单例）。**运行期唯一真相源**，与 `stackRegistry` / `rulesRegistry` 同手法：
 * 由 `harness/project-context.ts` 在**启动与切换项目时**各播种一次，之后只渲染不回读。
 *
 * `null` 表示"当前目录不是 git 仓库 / 探测失败"——渲染时整段缺席（模型照样可以 `git status` 工具自查）。
 */
let current: RepoStatusView | null = null;

export const repoStatusRegistry = {
  set(v: RepoStatusView | null): void {
    current = v;
  },
  get(): RepoStatusView | null {
    return current;
  },
  /** 复位（切换项目与测试都要用：模块级单例会跨项目 / 跨套件残留） */
  clear(): void {
    current = null;
  },
};
