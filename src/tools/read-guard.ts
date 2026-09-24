/**
 * read 工具的二进制与体积体检 —— 判据纯函数（ROADMAP 10.7.4，2026-09-24）。
 * 调用方：tools/builtin.ts 的 read handler（本模块唯一的接线点）。
 *
 * ── 为什么要有这个模块 ──
 * `read` 此前对任何文件都整个读进来：误读一个 `.png` / `.zip` 就是一屏乱码灌进上下文，
 * 点名一个几 GB 的文件也是整个往内存里吞。grep / symbols 那条路早有体检（`search/walk.ts`
 * 的 `readForScan`：体积 + 头部 NUL 探测），但 read 走的是"点名单个文件"的门，一直没接。
 *
 * ── 承重①：二进制判据**只此一份** ──
 * 判定函数是 `walk.ts` 导出的 `headIsBinary`（头部窗口含 NUL 即二进制，与 ripgrep 同思路）
 * —— 本模块**不复制判定式，只 import 它**。"体检口径只许有一份"是 10.7.3 立下的规矩：
 * 两份名单必然漂移，同一个文件会出现"搜得到却读不得"的分裂口径。
 *
 * ── 承重②：先二进制后体积，次序承重 ──
 * 一个又二进制又超大的文件，正确答案是"这是二进制，别读"而不是"太大请分段"——
 * 分段读出来的还是乱码，**方向给错比不给更坏**（与 10.9.5 两步出路的取舍同一条纪律）。
 *
 * ── 承重③：体积只拦"整读"，分段永远放行 ──
 * `read` 本来就有 offset/limit 分段读取，那是大文件的**正规通道**；拦它等于把正门焊死。
 * 所以体积闸只在"整读"（limit 是缺省值 `Number.MAX_SAFE_INTEGER`）时生效。
 * 上限 64KB 的依据：上下文体积预算 12000 token（compaction-policy.ts），64KB 文本 ≈ 1.6 万
 * token —— 一次整读就足以把当轮顶进压缩。整数倍刻意不凑"好看"的数，按预算倒推。
 *
 * ── 承重④：fail-open ──
 * 头部探不动（打开失败 / 读不出）→ 没有证据就不拦，回到改前行为。体检是护栏不是沙箱：
 * 它拦的是"顺手误读"，不声称挡得住一切。
 *
 * ── 返回值的选择：toolOk，不是 toolNegative ──
 * 五个有效否定前缀（NOT_FOUND / NOT_DIR / NOT_FILE / NO_MATCH / EMPTY）各有既定语义，
 * "二进制没读"哪个都不沾；为此扩第六个前缀却没有程序消费方（下游只看 status 分类），
 * 违背"要程序判定的才结构化"。toolError 也不对 —— 参数合法、路径没错，模型没犯错，
 * 计失败会把"连读三个不同的二进制文件"误判成"重复犯错"触发退避提示。
 * 结论：toolOk + 正文说清"没读、为什么、怎么办"。给模型的输出本来就是散文。
 *
 * 零第三方依赖：只 import node:fs 与本仓 search/walk.js（单源判据）。
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { SCAN_PROBE_BYTES, headIsBinary } from '../search/walk.js';

/** read 的整读体积上限：没指定 offset/limit 时，文件超过它就不整个读 */
export const READ_WHOLE_MAX_BYTES = 64 * 1024;

/** 体检命中的两类：头部含 NUL 的二进制 / 整读超限的大文本 */
export type ReadGuardKind = 'binary' | 'oversized';

/**
 * 判"这次 read 是不是整读"：limit 缺省时 parseSpec 填的是 optPosInt 的默认值
 * `Number.MAX_SAFE_INTEGER` —— 模型没传 limit 就等于要整个读。
 */
export function isWholeRead(limit: number): boolean {
  return limit === Number.MAX_SAFE_INTEGER;
}

/**
 * 体检判定（纯函数，逐形状打靶用）。
 * 次序承重：先二进制后体积（理由见模块头承重②）。
 * 边界：恰好等于上限**放行**（只有"超过"才拦 —— 与 danger 闸"看目标不看旗标"同款的
 * 窄判据口味：多读 1 字节的文件不值得拦，判据宁可少拦不可误拦）。
 */
export function classifyRead(input: {
  sizeBytes: number;
  limit: number;
  headIsBinary: boolean;
}): ReadGuardKind | undefined {
  if (input.headIsBinary) return 'binary';
  if (isWholeRead(input.limit) && input.sizeBytes > READ_WHOLE_MAX_BYTES) return 'oversized';
  return undefined;
}

/**
 * 读文件的头部探测窗（最多 `maxBytes` 字节，缺省与扫描遍历同一窗口）。
 * 供二进制判定用 —— 只探头部，不为体检把大文件整个读进内存。
 * 探不动（打开失败 / 无权限）返回 null，调用方据此 fail-open。
 */
export function readHeadBytes(abs: string, maxBytes: number = SCAN_PROBE_BYTES): Buffer | null {
  let fd = -1;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(maxBytes);
    let off = 0;
    while (off < maxBytes) {
      const n = readSync(fd, buf, off, maxBytes - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } catch {
    return null;
  } finally {
    if (fd !== -1) { try { closeSync(fd); } catch { /* 关不掉也不改判据结论 */ } }
  }
}

/**
 * 接线一步到位：探头部 → 判二进制 → 判体积。
 * 探不动（头部读不出）→ undefined（fail-open，回到改前行为）。
 */
export function guardForRead(abs: string, sizeBytes: number, limit: number): ReadGuardKind | undefined {
  const head = readHeadBytes(abs);
  if (head === null) return undefined;
  return classifyRead({ sizeBytes, limit, headIsBinary: headIsBinary(head) });
}

/**
 * 体检命中后给模型看的说明（**给人/模型读的输出** —— 断言断在这段渲染文本上）。
 * 三样齐全：没读（事实）· 为什么（判据）· 怎么办（出路）。
 * 二进制的出路**刻意不是**"分段读"——那段路对二进制走不通（承重②的方向纪律）。
 */
export function renderReadNotice(kind: ReadGuardKind, displayPath: string, sizeBytes: number): string {
  if (kind === 'binary') {
    return `未读取内容: ${displayPath} 是二进制文件（头部 ${SCAN_PROBE_BYTES} 字节内含 NUL 字节，read 只返回文本），大小 ${sizeBytes} 字节。不要再对它调 read，重试结果相同。若里面其实是你需要的文本，先确认文件本身；若只想了解它是什么，直接说明，可用 bash 查看。`;
  }
  return `未整读: ${displayPath} 共 ${sizeBytes} 字节，超过整读上限 ${READ_WHOLE_MAX_BYTES} 字节。用 offset/limit 分段读取: 先读开头一段（如 offset=1 limit=50）看清结构，再按需读后面的段落。`;
}
