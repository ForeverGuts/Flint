/**
 * 项目准入判据的**探针**（副作用侧）—— 把磁盘与 git 的硬信息探好，交给 detect.ts 判。
 *
 * 调用方：harness/project-context.ts（播种时判定"这个目录要不要进通讯录"）
 * 服务于：ROADMAP 10.11.6（通讯录保守准入 + 候选兜底）
 *
 * 为什么与判据分家：判据（detect.ts）是**能逐条穷举验证的纯函数**，本文件只有
 * "把信息取回来"这一件事 —— 于是判据的每条分支都能用构造出来的 probes 打靶，
 * 不必先造一个真目录、真仓库（那样每验一条都付一次 fs + 子进程）。
 *
 * ── 实测（2026-09-17 探针，Windows / node 22）──
 *   · `git rev-parse --show-toplevel`：仓库内 15~16ms（首次 721ms，冷缓存）；
 *     非仓库目录（家目录 / 盘根 / 临时目录）**快速失败** ~14ms（git 向上遍历到根后报错）。
 *   · git 不在 PATH：`execFileSync` 抛 ENOENT，3ms —— 所以"没有 git"是**快**的，
 *     不需要为它加前置探测（`which git` 本身也得起一个进程）。
 *   正因为有 721ms 那一下，`gitRoot` 才做成**惰性回调**（见 detect.ts 的 ProjectProbes）：
 *   家目录 / 盘根 / node_modules / 已有档案的项目都在判据 ①② 定案，压根不探 git。
 *
 * ── 认不出即丢弃（与 .gitignore 同口径）──
 * git 缺失、超时、不在仓库里 —— 一律返回 null（"没有这个证据"），**不抛**。
 * 后果只有一个方向：这个目录最多变成"候选"（不写盘），不会变成"垃圾条目"。
 *
 * 零运行时依赖：只用 node 内置（child_process / fs / os / path）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeProjectPath } from '../eventlog/registry.js';
import { MANIFEST_FILES, judgeProject, type ProjectProbes, type ProjectVerdict } from './detect.js';
import { STACK_CANDIDATES, type StackProbes } from './stack.js';
import { clipRules, rulesCandidates, type RulesHit } from './rules.js';

/**
 * 实物档案的落点 —— 任一存在，就是"flint 真在这儿工作过"。
 * `.flint/` 是项目档案目录（memory.md / events.jsonl / CHARTER.md / postcheck.json 住这儿），
 * `TASK.md` 是清单（历史原因落在 cwd 根，见 todo/store.ts）。
 *
 * ⚠ `.flint/` 在**家目录**下是 flint 的全局配置目录（GLOBAL_DIR）—— 这正是判据把
 * "硬排除"排在"看档案"之前的原因（见 detect.ts 文件头 ①）。
 */
const ARCHIVE_MARKERS: readonly string[] = ['.flint', 'TASK.md'];

/** 归一化家目录 / 临时目录（取不到 → null；判据那边遇到 null 会跳过对应那条排除） */
function safeNorm(p: string | undefined): string | null {
  if (!p) return null;
  const n = normalizeProjectPath(p);
  return n || null;
}

/**
 * git 仓库根（归一化）。不在仓库里 / git 不可用 / 超时 → null。
 *
 * `rev-parse --show-toplevel` 给的是**仓库根**而不是"有没有 .git"——
 * 判据要靠 `根 等于不等于 cwd` 区分"我是仓库"与"我是仓库的子目录"。
 * 实测输出是正斜杠的 Windows 绝对路径（`C:/Users/...`），与归一化口径一致。
 */
function gitRootOf(dir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    });
    const t = out.trim();
    return t ? normalizeProjectPath(t) : null;
  } catch {
    return null;
  }
}

/** 探一个目录（只读；`gitRoot` 是惰性回调，本函数不跑子进程） */
export function probeProject(dir: string): ProjectProbes {
  const cwd = normalizeProjectPath(dir);
  return {
    cwd,
    home: safeNorm(os.homedir()),
    tmp: safeNorm(os.tmpdir()),
    hasArchive: ARCHIVE_MARKERS.some((m) => existsSync(path.join(cwd, m))),
    manifest: MANIFEST_FILES.find((f) => existsSync(path.join(cwd, f))) ?? null,
    gitRoot: () => gitRootOf(cwd),
  };
}

/** 探 + 判 —— 调用方（播种 / `/projects`）要的就是这一个结论 */
export function classifyProject(dir: string): ProjectVerdict {
  return judgeProject(probeProject(dir));
}

/**
 * 技术栈探测的探针（ROADMAP 10.1.1）—— 只做**存在性检查**，外加读一份 `package.json`
 * 的文本（它的 `packageManager` 字段是包管理器的第一顺位依据）。
 *
 * 为什么把 package.json 的**文本**整份取回来、而不是在这里先解析出字段：解析属于**判据**，
 * 判据要能被逐条打靶（`parsePackageManagerField` 有一组脏输入用例），所以它留在 stack.ts。
 * 本文件只负责"把字节取回来"，与 `probeProject` 同一分家理由。
 *
 * **宽容读**：文件不存在 / 读失败 / 权限不够 → 那一格给 null，绝不抛。
 * 后果只有一个方向 —— 画像少说一句（甚至整段缺席），不会让启动失败。
 *
 * 成本（回答 C9）：只有 `existsSync` × 候选文件数 + 至多一次 `readFileSync`，
 * 且**不含任何子进程**（不像 `probeProject` 可能起 git）。调用方在播种时跑一次。
 */
export function probeStack(dir: string): StackProbes {
  const cwd = normalizeProjectPath(dir);
  const files = STACK_CANDIDATES.filter((f) => existsSync(path.join(cwd, f)));
  let packageJson: string | null = null;
  if (files.includes('package.json')) {
    try {
      packageJson = readFileSync(path.join(cwd, 'package.json'), 'utf-8');
    } catch {
      packageJson = null;
    }
  }
  return { files, packageJson };
}

/**
 * 项目规约的探针（ROADMAP 10.2.1）—— 按 `rulesCandidates()` 给的顺序**首命中即停**，
 * 回来一份 `RulesHit`（文件名 + 取自哪一级 + 截断后的正文）。
 *
 * 为什么顺序由判据给、探针只管照做：名单与优先级（先近后远、同目录内 `AGENTS.md` 先）
 * 是**能逐条打靶的判断**（`rulesCandidates()` 是纯函数，连"走到盘根就停"都在里面），
 * 探针的价值只在于"把它落到磁盘上" —— 与 `probeStack` / `probeProject` 同一分家理由。
 *
 * **两个"继续往下找"（不是错误，是判据的一部分）**：
 *   · 文件不存在 / 读不动（权限 / 是目录 / 编码坏）→ 跳过该候选；
 *   · 存在但**正文为空** → 同样跳过（空文件不算命中，"命中但什么都没说"比不注入更坏）。
 * 全都没命中 → `null`，整节缺席。**任何情况都不抛** —— 它跑在每轮请求的必经之路上。
 *
 * 成本（回答 C9）：候选最多 6 个（3 级 × 2 名字），每个一次 `existsSync`，**至多一次**
 * `readFileSync`（首命中即停），**不含任何子进程**。且它**不在启动关键路径上** ——
 * `seedProjectContext()` 只在启动 / 切项目时各调一次，运行期一次都不读盘。
 */
export function probeRules(dir: string): RulesHit | null {
  for (const c of rulesCandidates(dir)) {
    if (!existsSync(c.abs)) continue;
    let text: string | undefined;
    try {
      text = clipRules(readFileSync(c.abs, 'utf-8'));
    } catch {
      text = undefined;
    }
    if (text === undefined) continue; // 空文件 / 读不动：跳过，继续往下找
    return { name: c.name, level: c.level, text };
  }
  return null;
}
