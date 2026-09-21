/**
 * 手动压缩与留档（ROADMAP 10.8.4）的**判据** —— 纯函数，**零 import**。
 *
 * 调用方：`/compact` 命令（`src/commands/builtin/compact.ts`）经 `Runtime.compactSession()`；
 *          落盘那一半在 `compact-snapshot-file.ts`（**唯一**碰 fs 的地方）。
 * 服务于：让"压缩"这件**不可逆**的事变成一次**用户自己按下的决定**，并且按下去之前
 *         先把要被换掉的那段原文**整份留下来**。
 *
 * ── 为什么压缩需要留档 ──
 * 压缩 = 用一段 LLM 摘要替换掉 N 条原始消息。摘要是有损的、且**不可逆**（事后没有任何
 * 东西可以比对、可以回滚 —— 与"只做 L1、没有 L2"那几条闸是同一类判断）。此前只有
 * **自动**压缩（历史超过 20 条触发），用户既不能主动压，压掉的内容也无处可查。
 *
 * ── 为什么只给**手动**压缩留档（自动压缩刻意不留）──
 * 自动压缩是系统为了让上下文塞进窗口而做的自我维护，用户**没有"此刻要丢掉细节"的意图**；
 * 每次自动压缩都落一份文件，会在 `.flint/` 里堆出一批用户从没要过、自己也对不上号的东西
 * （哪次压的是哪一段，他并不知道）。**手动压缩才是一次决定** —— 留档是这个决定的一部分，
 * 而不是压缩这件事的普遍副作用。所以 `beforeSummarize` 钩子只由 `compactSession()` 传，
 * `maybeCompact`（自动）那条路一个字都不碰。
 *
 * ── 留档失败 → **拒绝压缩**（fail-closed）──
 * 留档写不进去还照压，等于"说好留底、其实没留"的不可逆丢失。压缩是用户**主动**要求的，
 * 他此刻的选择是"压掉 + 留档"；留不了档，这次压缩就不成立。拒绝是**可见的**（回执写明
 * 原因），比"悄悄压了但没留底"好 —— 后者要等他想回头查原文时才发现。
 *
 * ── 内容**不截断** ──
 * 留档的意义就是"原文还在"，截断的留档等于没留（`compactTo` 喂给 LLM 的那份才截 200 字，
 * 那是**摘要的输入**，不是留档）。上限只防"离谱地大"：单条超 64KB 时截断并**标出来**
 * （标了才不是谎报）。
 *
 * 零运行时依赖、零 import：文件名 / 渲染 / 参数解析全是字符串活儿，可以在内存里逐条打靶。
 */

/** 留档目录（相对 cwd，与账本 `events.jsonl` 同住 `.flint/`） */
export const SNAPSHOT_DIR = '.flint/snapshots';

/** 单条消息留档上限：超过就截，但**必须标出来**（静默截断 = 谎报"原文完整"） */
export const SNAPSHOT_MSG_MAX = 64 * 1024;

/** 会话名在文件名里保留的长度（防一个超长名把文件名撑爆） */
const SESSION_PART_MAX = 40;

/** `/compact` 的结果 —— 回执与留档都从它渲染 */
export interface CompactOutcome {
  /** 是否真的压缩了（false 时看 reason） */
  compressed: boolean;
  /** 没压缩的原因（**必须**能直接念给用户听） */
  reason?: string | undefined;
  /** 本次要保留的最近条数（缺省来自 `compact-snapshot` 的调用方） */
  keep: number;
  /** 被压缩掉（= 已留档）的条数 */
  dropped: number;
  /** 压缩后上下文里还剩的条数 */
  kept: number;
  /** 留档的相对路径（compressed 为真时必有） */
  snapshot?: string | undefined;
  /** LLM 摘要（压缩成功时必有） */
  summary?: string | undefined;
}

/** 留档文件的元信息 */
export interface SnapshotMeta {
  /** 留档时刻 */
  at: Date;
  /** 会话文件名（拿不到就不写，不编一个） */
  session?: string | undefined;
  /** 本次保留的最近条数 */
  keep: number;
}

/** 一条被留档的消息 */
export interface SnapshotMessage {
  role: string;
  content: string;
}

/**
 * 解析 `/compact` 的参数。只认两种写法：`keep=N` 与裸数字 `N`；其余一律**报错并给用法**，
 * 不做"尽力猜"（猜错了用户以为压了，其实没压 —— 沉默的误读比明确的报错贵）。
 * @returns `keep` 为 null = 用调用方的缺省值
 */
export function parseCompactArgs(
  args: string,
): { ok: true; keep: number | null } | { ok: false; error: string } {
  const s = args.trim();
  if (s === '') return { ok: true, keep: null };
  const m = /^(?:keep=)?(\d+)$/.exec(s);
  if (!m) return { ok: false, error: `认不出「${s}」—— 只认 keep=N 或直接给一个数字` };
  return { ok: true, keep: Number(m[1]) };
}

/** 两位补零（不用 `Intl` / `toISOString`，保持判据零依赖） */
const pad = (n: number): string => String(n).padStart(2, '0');

/** 会话名 → 文件名安全片段（非 `[A-Za-z0-9._-]` 一律换成 `-`） */
export function safeSessionPart(session: string | undefined): string {
  if (!session) return '';
  const cleaned = session.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, SESSION_PART_MAX);
  return cleaned === '' ? '' : cleaned;
}

/**
 * 留档文件名：`compact-<日期>-<时间>[-<会话>].md`。
 * 会话名进名是**刻意的**：一份留档必须对得上"它是哪次会话压下来的"，否则用户打开
 * 一堆 `compact-20260921-*.md` 无从分辨。
 */
export function snapshotFileName(at: Date, session?: string): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
    + `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const part = safeSessionPart(session);
  return part === '' ? `compact-${stamp}.md` : `compact-${stamp}-${part}.md`;
}

/** 留档的相对路径（回执里显示它，用户能照着打开） */
export function snapshotRelPath(fileName: string): string {
  return `${SNAPSHOT_DIR}/${fileName}`;
}

/** 留档正文：元信息 + 逐条原文（**完整**，超限才截且标注） */
export function renderSnapshot(
  meta: SnapshotMeta,
  messages: SnapshotMessage[],
): string {
  const stamp = `${meta.at.getFullYear()}-${pad(meta.at.getMonth() + 1)}-${pad(meta.at.getDate())}`
    + ` ${pad(meta.at.getHours())}:${pad(meta.at.getMinutes())}:${pad(meta.at.getSeconds())}`;
  const lines: string[] = [
    '# 压缩留档（flint /compact）',
    '',
    `- 留档时间：${stamp}`,
    `- 会话：${meta.session ?? '（未标注）'}`,
    `- 本次压缩：保留最近 ${meta.keep} 条，以下 ${messages.length} 条被换成一段摘要`,
    '- 说明：**以下原文完整保留在此** —— 压缩只影响模型的上下文，不影响这份文件',
    '',
    '---',
    '',
  ];
  messages.forEach((m, i) => {
    const long = m.content.length > SNAPSHOT_MSG_MAX;
    const body = long ? `${m.content.slice(0, SNAPSHOT_MSG_MAX)}\n…（单条超 ${SNAPSHOT_MSG_MAX} 字节，已截断 ${m.content.length - SNAPSHOT_MSG_MAX} 字节）` : m.content;
    lines.push(`[${i + 1}] ${m.role}: ${body}`);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * `/compact` 的回执文本。压缩与否**两态都要说清"发生了什么"** —— 尤其是没压的那一态：
 * 用户按下命令却什么都没变，最贵的后果是他以为压过了。
 */
export function renderCompactReceipt(r: CompactOutcome): string {
  if (!r.compressed) {
    return `⏸ 没有压缩 —— 原因：${r.reason ?? '（未说明）'}`;
  }
  const lines = [
    `✅ 已压缩：压缩掉 ${r.dropped} 条，保留最近 ${r.keep} 条`,
    `· 留档：${r.snapshot ?? '（缺失）'}（原文逐条完整保留 —— 压缩只影响上下文）`,
    `· 摘要：${r.summary ?? '（无）'}`,
  ];
  return lines.join('\n');
}
