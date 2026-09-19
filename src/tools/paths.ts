/**
 * 工具层统一路径解析 —— ROADMAP 10.9.5（路径穿越防护）的程序侧。
 * 调用方：tools/builtin.ts 的 read / write / edit / ls / grep（把"模型给的路径串"
 *         解析成"这次调用真正要碰的绝对路径"）、
 *         harness/main.ts（把 realPathOf 注入工作区闸，做真落点校验）。
 *
 * ── 它治的是哪一件事（缺口原样：**无统一校验**）──
 * 此前工具层**根本没有解析这一步**：五个 handler 各自把参数做一次
 * `path.replace(/\\/g, '/')` 就直接交给 fs，由 Node 隐式按 `process.cwd()` 解析。
 * 后果两条：
 *   ① 没有任何一处能回答"这次调用**真正要碰的绝对路径**是什么"。于是凡"按落点判"的
 *      检查都只能各自为政 —— 10.9.3 的闸自己 `path.resolve` 了一遍，与工具层那份是**两份**；
 *   ② **符号链接 / junction 完全没人追**。10.9.3 的闸写明"只做字符串路径代数、不碰 fs"，
 *      于是 `write cwd/link-out/x`（`link-out` 指向项目外）被判成"内部"照写 —— 这是
 *      10.9.3 登记在案的边界，也正是"路径穿越"最真实的那一条。
 *
 * ── 承重①：本模块是"相对 → 绝对"的**唯一实现** ──
 * `resolveToolPath` 只做 `path.resolve`（纯字符串代数），之所以还值得有个函数，是因为
 * "谁负责把模型的路径串变成绝对路径"必须**只有一个答案**：分散在多处时，将来任何
 * "按落点判"的新检查都得重新回答一遍"你 resolve 了吗、跟别人 resolve 的一样吗"。
 * 它同时返回 `display`（原文归一化反斜杠）—— 工具回执里印的**仍然是模型写的那串**，
 * 报告口径不因本次改动而变化（改了会平添一屏绝对路径，且与既有套件断言无关地漂移）。
 *
 * ── 承重②：`realPathOf` 只对**已存在的最长前缀**求 realpath ──
 * 10.9.3 当初拒绝 realpath 的理由是"目标文件可能还不存在，`realpathSync` 会抛" ——
 * 那句话对**整条路径**成立，对**最长已存在祖先**不成立：往上退到第一个真实存在的目录，
 * 对它求 realpath，再把剩下的段原样接回去。于是"新建文件"照样算得出真落点。
 *
 * ── 承重③：必须用 `realpathSync.native`，不能用普通版 ──
 * 本仓实测（2026-09-19 探针，tmp 目录造 `MixedCase/` 后逐个查）：
 *   · 普通版**原样返回入参的大小写** —— 传 `mixedcase` 得 `mixedcase`、传 `MIXEDCASE` 得 `MIXEDCASE`；
 *   · `native` 一律返回**磁盘上的规范大小写**（`MixedCase`）。
 * 也就是说只有 native 给出的是"文件系统认的那个名字"，普通版给的是"你刚才说的那个名字"。
 * ⚠ **同一轮探针推翻了本仓一条旧说法的**一半**：既有取证（`.workbuddy/memory/DETAILS.md`）
 * 写的是"普通版原样返回入参大小写、**不解 junction**"，前半句复现了，**后半句在 junction 上不成立** ——
 * 本机实测 `realpathSync(link)` 与 `realpathSync.native(link)` **结果逐字符相同**（都追到了真实目录）。
 * 仍选 native 的理由因此收窄成"要规范大小写"这一条，而**不是**"只有它能追 junction"。
 * （顺带一条同轮取证：`path.relative` 在 Windows 上**大小写不敏感** ——
 * `relative(MixedCase, MIXEDCASE/f.txt)` 返回 `f.txt`。这正是下面判据敢拿"真落点"与
 * "声明路径"比边界、而不担心大小写造成**假阳**的原因。）
 *
 * ── 承重④：失败一律 fail-open（退化成入参）──
 * 追不动（权限 / 盘符不存在 / 路径畸形）时返回**入参**，即"当它没有符号链接"。
 * 理由与三道闸一致：这是基础设施不是策略，让"解析不出来"变成"所有写都失败"比漏追更坏；
 * 而且判据的**否定方向**（"真落点出界"）要求证据确凿，追不动就没有证据。
 *
 * 零运行时依赖：只用 node:path / node:fs（内置）。
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

/** 真落点解析器 —— 工作区闸把它当**参数**收（判据因此仍能在内存里喂假解析器打靶） */
export type RealPathResolver = (abs: string) => string;

/** 一条被解析过的工具路径 */
export interface ToolPath {
  /** 模型给的原文（一字不动，拒因里要原样引它） */
  raw: string;
  /** 回执里印的形态：原文的反斜杠归一（与改动前逐字符相同） */
  display: string;
  /** 这次调用真正要碰的绝对路径 */
  abs: string;
}

/**
 * 把模型给的路径串解析成绝对路径 —— **全仓唯一的"相对 → 绝对"实现**。
 *
 * 只做 `path.resolve`，不动 fs（因此对"还不存在的文件"同样成立）。
 * `~` 不展开、MSYS 形式 `/c/…` 不认 —— 这两条**刻意与 read / write / 闸同口径**：
 * 前者世界里 `path.resolve(cwd, '~/x')` 落在 cwd 下的 `~` 目录（判"在里面"是对的），
 * 后者 `path.resolve(cwd, '/c/x')` 解到**当前盘**根（不是相对 cwd），得到 `C:\c\x`。
 * 两种都是**看得见的结论**，不是静默误解 —— 换口径才是引入新语义。
 */
export function resolveToolPath(raw: string, cwd: string): ToolPath {
  return {
    raw,
    display: raw.replace(/\\/g, '/'),
    abs: path.resolve(cwd, raw),
  };
}

/**
 * 追出 `abs` 的真落点：对**最长的已存在祖先**求 `realpathSync.native`，余下的段原样接回。
 * 追不动（一路退到根仍失败）时返回**入参**（fail-open，见文件头承重④）。
 *
 * 传相对路径是调用方的错，但这里不抛：先 `path.resolve` 补成绝对（同样的 fail-open 立场）。
 */
export function realPathOf(abs: string): string {
  const start = path.isAbsolute(abs) ? abs : path.resolve(abs);
  const tail: string[] = [];
  let cur = start;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(cur);
      // 退到根（`C:\` / `/` / UNC 根）还失败 → 放弃，整体退化成入参
      if (parent === cur) return start;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
