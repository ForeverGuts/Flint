/**
 * 逐文件内容扫描的遍历器 —— `grep` 与 `symbols` 共用（ROADMAP 10.7.1）。
 * 调用方：tools/builtin.ts 的 grep / symbols 两个 handler（本模块**唯一**的调用方）。
 *
 * ── 为什么要有这个模块 ──
 * `grep` 此前把"怎么走目录、哪些文件不该看"整段写在自己的 handler 里：跳过表 + `.gitignore`
 * 规则 + 二进制探测 + 体积上限 + 文件数上限，约 50 行。再加一个 `symbols` 工具时，最省事的
 * 写法是**再抄一遍** —— 而"同一份清单在两处各写一份"正是 10.7.3 当初批评过的东西
 * （`ls` / `grep` 里那份硬编码清单）。所以这里收成一份：目录怎么走、什么文件不该读，
 * 只有一个答案；调用方各自只回答两件事 —— **收哪些文件名**（`accept`）与
 * **每读到一个文件做什么**（`onFile`）。
 *
 * 形状上是"探针"而不是"判据"：它碰 fs，所以不放任何策略。`grep` 的 include glob、
 * `symbols` 的代码扩展名名单，都由调用方以 `accept` 回调带进来。
 *
 * ── 承重①：跳过表 = 内置默认 ∪ `.gitignore`，且**只有一份** ──
 * `SKIP_DIRS`（`.git` / `node_modules` / `dist`）是底线，**不**交给用户在自己的
 * `.gitignore` 里填空话 —— 哪怕他把这三个名字放回来也一样跳过。`.gitignore` 规则由调用方
 * 读好传进来（读配置在工具层，本模块不读任何配置文件）。
 * `ls` 也 import 同一份 `SKIP_DIRS`：它走的是"列目录树"（形状不同，条目要带层级前缀、
 * 还要按目录优先排序），所以不共用遍历器，但**跳过表必须同源**。
 *
 * ── 承重②：fail-safe 朝"多给"倒，例外只有两类 ──
 * 读不动就跳过（不让一次搜索整体失败），认不出的东西一律当"不在名单里"处理。
 * 这与 `gitignore.ts` 界线②（认不出即丢弃、朝"不忽略"倒）是同一条纪律：藏掉本来看得见的
 * 东西比多显示噪音危险 —— 模型会据此以为自己已经看全了。唯一的例外是**二进制与超大文件**：
 * 那两类不是"看不见的内容"，而是读进来只会毁掉结果的东西（一个 png 能贡献几百行乱码命中，
 * 把命中名额全吃光）。跳过它们并把条数交给调用方报出去，比灌一屏乱码诚实。
 *
 * ── 承重③：不追符号链接指向的目录（刻意） ──
 * `readdirSync(..., { withFileTypes: true })` 给的是 lstat 语义的 dirent：指向目录的链接
 * `isDirectory()` 为 false，于是它被当成一个"文件"交给 `readFileSync`（读到 EISDIR → 跳过），
 * **不会**被递归进去。这是刻意的：追链接会走出项目边界、甚至绕回来自成死循环，而 flint 的
 * 一贯立场是"看得见的缺失好过看不见的通路"。代价是"项目里放一个指向源码目录的软链接"时
 * 那半边搜不到 —— 这不是静默错误（模型会去 read 真实路径），但确实是一条边界，写在这里。
 *
 * ── 承重④：一条容易被忽略的排名单 ──
 * `item.name.startsWith('.')` 把**所有**点开头的名字挡掉（不止 `.git`）。所以 `.flint/`、
 * `.env`、`.github/` 一律不在搜索结果里。这是 `grep` 改造前就有的行为，本模块**照搬**：
 * 换的是手段，不该顺带改掉对外可观测的判定口径。
 *
 * 零运行时依赖：只用 node:fs（内置）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { isIgnoredByGitignore, type IgnoreRule } from '../project/gitignore.js';

/**
 * 永久的目录跳过名单 —— 内容扫描（本模块）与目录列举（`ls`）共用这一份。
 * 它是**底线**：用户在自己的 `.gitignore` 里写 `!node_modules` 也改不动它。
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist']);

/** 一次调用最多读多少个文件（防误指向盘根时走到天荒地老；与 grep 改造前的 5000 同量级） */
export const SCAN_MAX_FILES = 5000;

/** 单文件体积上限：超过就不读（读进来只为搜一遍，不值得） */
export const SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 二进制判定的探测窗口（只看头部，不整文件扫 NUL） */
export const SCAN_PROBE_BYTES = 8192;

/** 一个文件被跳过的原因 */
export type ScanSkipReason = 'unreadable' | 'big' | 'binary';

/** 读一个文件准备扫描：ok=false 时 `reason` 说明为什么没读（调用方决定怎么计数） */
export type ScanRead = { ok: true; buf: Buffer } | { ok: false; reason: ScanSkipReason };

/**
 * 二进制判定：头部窗口内有 NUL 字节即视为二进制（与 ripgrep 同一思路）。
 * 注意 Buffer.indexOf 的第三参是 encoding 而非结束位置，限定窗口只能先 subarray
 *（subarray 越界会自动夹到长度，不必自己 Math.min）。
 *
 * **全仓唯一一份**（ROADMAP 10.7.4 起也供 read 工具复用）："体检口径只许有一份"
 * 是 10.7.3 立下的规矩 —— grep/symbols 与 read 若各判各的，同一个文件就会出现
 * "搜得到却读不得"（或反过来）的分裂口径，且两份名单必然漂移。
 */
export function headIsBinary(buf: Buffer, probeBytes: number = SCAN_PROBE_BYTES): boolean {
  return buf.subarray(0, probeBytes).indexOf(0) !== -1;
}

/**
 * 读一个文件并做两道体检（体积 / 二进制）。
 * 分开导出是因为调用方有一条"点名单个文件"的路径：那时没有目录要走，但仍要过同样的体检
 * —— 体检口径只许有一份，否则点名一个 3GB 文件就会把它整个读进内存。
 */
export function readForScan(
  abs: string,
  maxFileBytes: number = SCAN_MAX_FILE_BYTES,
  probeBytes: number = SCAN_PROBE_BYTES,
): ScanRead {
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return { ok: false, reason: 'unreadable' };   // 无权限 / 占用中 / 是个目录
  }
  if (buf.length > maxFileBytes) return { ok: false, reason: 'big' };
  if (headIsBinary(buf, probeBytes)) return { ok: false, reason: 'binary' };
  return { ok: true, buf };
}

/** 一次扫描的计数。调用方要把它们报给模型：0 命中时模型需要区分"扫了 300 个文件确实没有"与"过滤器把文件都排除了" */
export interface ScanStats {
  /** 真正读进来并交给 onFile 的文件数 */
  scanned: number;
  /** 因头部含 NUL 被判为二进制而跳过 */
  skippedBinary: number;
  /** 因超过体积上限而跳过 */
  skippedBig: number;
  /** 被 `accept` 挡掉的文件数（`grep` 的 include 过滤 / `symbols` 的非代码扩展名） */
  filtered: number;
  /** 是否提前停止（onFile 返回 false，或撞上 maxFiles） */
  stopped: boolean;
}

export interface ScanRequest {
  /** 绝对路径：文件或目录（由 `resolveToolPath` 统一解析，本模块不解析路径） */
  root: string;
  /** `root` 是不是目录。由调用方算好传进来，避免本模块再 stat 一次 */
  isDir: boolean;
  /** 搜索根那一层的 `.gitignore` 编译结果；缺省 = 没有规则 */
  ignoreRules?: IgnoreRule[];
  /**
   * 文件名过滤。**只在 root 是目录时生效** —— 点名的文件从不套过滤
   * （`grep x a.ts --include=*.js` 照旧搜 a.ts，这是 gitignore 界线④的同一条精神：
   * 用户已经把路径说出来了，别替他藏）。
   * 显式允许 undefined：调用方常常只有"有条件时"才带这个回调（exactOptionalPropertyTypes 下
   * 「传 undefined」与「不传」不是一回事，这里允许前者，省掉调用方一层拼对象）
   */
  accept?: ((fileName: string) => boolean) | undefined;
  maxFiles?: number;
  maxFileBytes?: number;
  probeBytes?: number;
  /**
   * 每读到一个文件调一次。返回 `false` = 立刻停止整次遍历（命中够了的那个 cap）。
   * `abs` 是这次真正读的绝对路径，`rel` 是相对**搜索根**的路径（两边都往上拼 `/`，
   * 与改造前的字符串形态逐字符相同 —— 回执口径不因本次抽取而漂移）。
   */
  onFile: (abs: string, rel: string, buf: Buffer) => boolean | void;
}

/**
 * 遍历并逐文件回调。返回计数，不返回内容（内容由 `onFile` 自己攒）。
 *
 * 检查次序照搬改造前的 `grep`：**先读、后计数、再回调**，且 `maxFiles` 数的是
 * "真正读进来并过了体检的文件"，跳过的那些不计入 —— 次序变了，报给模型的
 * "已扫 N 个文件"就会跟着变。
 */
export function scanPaths(req: ScanRequest): ScanStats {
  const ignoreRules = req.ignoreRules ?? [];
  const maxFiles = req.maxFiles ?? SCAN_MAX_FILES;
  const maxFileBytes = req.maxFileBytes ?? SCAN_MAX_FILE_BYTES;
  const probeBytes = req.probeBytes ?? SCAN_PROBE_BYTES;
  const stats: ScanStats = { scanned: 0, skippedBinary: 0, skippedBig: 0, filtered: 0, stopped: false };

  /** 返回 false = 调用方喊停 */
  const visit = (abs: string, rel: string): boolean => {
    if (stats.scanned >= maxFiles) { stats.stopped = true; return false; }
    const r = readForScan(abs, maxFileBytes, probeBytes);
    if (!r.ok) {
      if (r.reason === 'binary') stats.skippedBinary++;
      else if (r.reason === 'big') stats.skippedBig++;
      return true;   // 读不动只是这一个文件的事，遍历继续
    }
    stats.scanned++;
    return req.onFile(abs, rel, r.buf) !== false;
  };

  if (!req.isDir) {
    visit(req.root, req.root);
    return stats;
  }

  // rel = 相对**搜索根**的路径，理由同 ls 的 walk：gitignore 的规则相对它所在的那一层，
  // 锚定与"任意深度"两种语义都靠它才判得对。目录被命中就整棵子树不再往下走，
  // 于是"父目录被排除后，里面的文件救不回来"这条 git 语义在这里天然成立。
  const walk = (dir: string, rel: string): void => {
    if (stats.stopped) return;
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;   // 无权限等 → 跳过该目录
    }
    items.sort((a, b) => a.name.localeCompare(b.name));   // 排序让输出稳定，断言才可复现
    for (const item of items) {
      if (stats.stopped) return;
      if (item.name.startsWith('.') || SKIP_DIRS.has(item.name)) continue;
      const full = `${dir}/${item.name}`;
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (isIgnoredByGitignore(childRel, item.isDirectory(), ignoreRules)) continue;
      if (item.isDirectory()) { walk(full, childRel); continue; }
      if (req.accept && !req.accept(item.name)) { stats.filtered++; continue; }
      if (!visit(full, childRel)) { stats.stopped = true; return; }
    }
  };

  walk(req.root, '');
  return stats;
}
