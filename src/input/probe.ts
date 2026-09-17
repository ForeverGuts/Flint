/**
 * `@file` 输入引用的**探针**（副作用侧）—— **全项目唯一**为这条功能碰 fs 的地方。
 *
 * 调用方：`harness/main.ts` 挂给 `runtime.onInput()` 的那个 handler。
 * 服务于：ROADMAP 10.8.1（`@file` 输入引用）。
 *
 * ── 为什么与判据分家（同 `project/detect.ts` ⇄ `project/probe.ts`）──
 * `at-file.ts` 是**能逐条穷举验证的纯函数**，本文件只干"把字节取回来"这一件事。
 * 于是"`@Component` 该不该被当成引用""上限到了丢哪个"这类分支都能用构造出来的事实打靶，
 * 不必先造一堆真文件。
 *
 * ── 宽容读（与项目一贯口径一致）──
 * 找不到 / 是目录 / 是二进制 / 太大 / 读失败 —— 一律变成 `content: null` + 一句人读的原因，
 * **绝不抛**。后果只有一个方向：这条引用不进上下文，而用户能看到为什么。
 *
 * ── "太大"分两档，是两件事 ──
 *   · `AT_READ_CEILING`（2 MB）：**连读都不读**。超过就直接报"太大，已跳过"并建议用 read 工具
 *     分段读。存在的理由是别把一个 3 GB 的文件 `readFileSync` 进内存 —— 那是崩，不是慢。
 *   · `AT_MAX_FILE_BYTES`（64 KB）/ `AT_MAX_LINES`：**读了之后留多少**。这两种是"截断"，
 *     内容还在，只是裁到上限，并在块首标注"已截断"。
 *
 * ── 不新增启动成本（回答 C9 那个口径）──
 * 本模块**只在用户输入里真的出现 `@` 时才跑**，不在启动关键路径上：
 * `composeAtFile` 第一行就有 `text.includes('@')` 的短路，`resolveAtFile` 在候选为空时
 * 连一次 `statSync` 都不会发生。日常输入（不含 `@`）的成本 = 一次字符串扫描。
 *
 * 零运行时依赖：只用 node 内置（fs / path）。
 */
import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import {
  AT_MAX_FILE_BYTES,
  AT_MAX_LINES,
  AT_READ_CEILING,
  composeAtFile,
  formatBytes,
  parseAtCandidates,
  type AtCandidate,
  type AtOutcome,
  type AtProbe,
} from './at-file.js';

/** 二进制嗅探的取样长度 */
const SNIFF_BYTES = 8192;

/**
 * 前 8 KB 里出现 NUL 就当二进制（与 `grep` 的判据同口径）。
 * 为什么值得挡：把一个 PNG 按 UTF-8 解出来是一堆替换字符，灌进上下文既费 token 又毫无信息。
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** 空壳（失败路径统一从这里派生，保证字段一个不缺） */
function blank(pathText: string): AtProbe {
  return { path: pathText, resolved: '', content: null, note: '', truncated: false, bytes: 0 };
}

/**
 * 探一个引用。**宽容**：任何失败都折成一句 `note`。
 *
 * 解析口径与 `read` 工具一致（绝对路径，或相对 cwd 的路径；**不展开 `~`**）——
 * 这是拍板时选的"与 read 同口径"，所以不在这里加任何 read 没有的路径魔法。
 */
export function probeAtRef(cwd: string, cand: AtCandidate, resolve: typeof path.resolve = path.resolve): AtProbe {
  const base = blank(cand.path);
  let abs = '';
  try {
    abs = resolve(cwd, cand.path);
  } catch {
    return { ...base, note: '路径解析失败' };
  }
  const withAbs: AtProbe = { ...base, resolved: abs };

  let size = 0;
  let isFile = false;
  let isDir = false;
  try {
    const st = statSync(abs);
    isFile = st.isFile();
    isDir = st.isDirectory();
    size = st.size;
  } catch {
    return { ...withAbs, note: '找不到这个路径' };
  }
  if (isDir) return { ...withAbs, note: '这是个目录，不是文件（要列目录请用 ls）' };
  if (!isFile) return { ...withAbs, note: '不是普通文件' };
  if (size > AT_READ_CEILING) {
    return {
      ...withAbs,
      note: `文件太大（${formatBytes(size)}），已跳过 —— 需要的话用 read 工具分段读`,
    };
  }

  let raw: Buffer;
  try {
    raw = readFileSync(abs);
  } catch {
    return { ...withAbs, note: '读失败（权限或文件被占用）' };
  }
  if (looksBinary(raw)) return { ...withAbs, note: '看起来是二进制文件，已跳过' };

  // 去掉 BOM：留着会让块里的第一行多一个看不见的字符（与 edit 工具保真的思路相反 ——
  // 那边是"一字不改地写回去"，这边是"给人看的内容"，看不见的字符只会添乱）
  const full = raw.toString('utf-8').replace(/^\uFEFF/, '');
  const totalLines = full.split('\n').length;

  let kept = full.split('\n');
  let truncated = false;
  if (kept.length > AT_MAX_LINES) {
    kept = kept.slice(0, AT_MAX_LINES);
    truncated = true;
  }
  // 字节上限：逐行累加（不是按字符切 —— 多字节字符按字符切会造出半个字）
  let text = kept.join('\n');
  if (Buffer.byteLength(text, 'utf-8') > AT_MAX_FILE_BYTES) {
    const head: string[] = [];
    let used = 0;
    for (const ln of kept) {
      const cost = Buffer.byteLength(ln, 'utf-8') + 1;   // +1 = 换行
      if (used + cost > AT_MAX_FILE_BYTES) break;
      head.push(ln);
      used += cost;
    }
    kept = head;
    text = kept.join('\n');
    truncated = true;
  }

  const bytes = Buffer.byteLength(text, 'utf-8');
  const note = truncated
    ? `只取前 ${kept.length}/${totalLines} 行 / ${formatBytes(bytes)}`
    : `${kept.length} 行 / ${formatBytes(bytes)}`;
  return { ...withAbs, content: text, note, truncated, bytes };
}

/**
 * `runtime.onInput()` 要的那个 handler —— **唯一实现**，`main.ts` 只是把它交出去。
 *
 * 为什么抽成工厂而不是在 `main.ts` 里就地写一个箭头函数：套件若自己复刻一份，就**永远测不到
 * 接线本身**（变异测试逮到过：把 `main.ts` 里的 handler 改成恒返回 `continue`，全套件照绿 ——
 * 因为测的是复刻件的副本）。抽出来之后，套件跑的就是线上那一个。
 *
 * `getCwd` 是个**回调**而不是字符串：项目切换会 chdir，cwd 必须**用的时候现取**
 * （同 `FLINT_CONFIG` / `FLINT_PROJECTS_FILE` 那条惯例，也同"项目级路径全是相对路径、调用时才解析"）。
 *
 * 返回值只用到 `continue` / `transform` 两种，故意**不 import** `runtime.ts` 的那个联合类型 ——
 * 结构上兼容即可，免得为一个类型把 runtime 整条依赖链拉进本模块。
 */
export type AtInputResult = { action: 'continue' } | { action: 'transform'; text: string };

export function atFileInputHandler(getCwd: () => string = () => process.cwd()): (text: string) => AtInputResult {
  return (text) => {
    const out = resolveAtFile(text, getCwd());
    return out.changed ? { action: 'transform', text: out.text } : { action: 'continue' };
  };
}

/**
 * 总装：识别 → 探针 → 组装。**给 `runtime.onInput()` 的那个 handler 用的唯一入口**。
 *
 * `resolve` 可注入，只为让套件能构造"路径解析失败"那一支（默认就是 `path.resolve`）。
 */
export function resolveAtFile(
  text: string,
  cwd: string = process.cwd(),
  resolve: typeof path.resolve = path.resolve,
): AtOutcome {
  const candidates = parseAtCandidates(text);
  if (candidates.length === 0) {
    // 没有候选也可能是"有 `@@` 要解码"—— 交给 composeAtFile 判（它用逐字比较定 changed）
    return composeAtFile(text, candidates, []);
  }
  return composeAtFile(text, candidates, candidates.map((c) => probeAtRef(cwd, c, resolve)));
}
