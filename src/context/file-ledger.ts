/**
 * 文件操作清单（ROADMAP 10.8.11）—— 压缩链路的**判据纯函数**。
 * 调用方：context/compaction.ts 的 compactTo（抽取 + 合并）与 runtime（渲染进摘要层）。
 *
 * 解决的问题：摘要会丢细节，但"这个会话碰过哪些文件"对编程 Agent 是可操作性最高的
 * 窄信息（Pi 的 compaction entry 带 readFiles / modifiedFiles 并逐层累积，2026-09-22 调研）。
 * 摘要由 LLM 散文生成、会漂移；清单由程序从**结构化 tool_calls** 里抽取、确定性渲染 —— 谁也不掩护谁。
 *
 * 零 import（判据模块纪律，同 compact-snapshot.ts）：不碰 fs、不起进程、不认 JSON 以外的格式。
 *
 * ⚠ 已知边界（护栏不是沙箱的同类账）：bash 里的 `echo > file` / `cat a > b` **看不见** ——
 * 工具调用参数里没有那扇门的目标，本清单只认结构化工具调用的目标路径。
 */

// ── 认哪几个工具（封闭枚举，刻意做窄）────────────────────────────────
// 改写类：内容或位置变了。trash 是"移进回收站"，对"这文件还在不在原地"是实质变化，归这里。
export const LEDGER_WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'git_write', 'trash']);
// 只读类：ls 的目标是目录，但"看过哪个目录"同样值得记（模型压完后想知道自己扫过哪）。
export const LEDGER_READ_TOOLS: ReadonlySet<string> = new Set(['read', 'ls']);
// bash / spawn / grep / symbols / refs / todo / memory …… 刻意不进：要么没有文件目标，
// 要么目标在自由文本里判不准（bash），进来了只会让清单说谎。

// ── 体积上限（逐层累积也不许无限涨 —— Pi 的招数成立的前提是"体积恒定"）────
export const LEDGER_MODIFIED_CAP = 50;
export const LEDGER_READ_CAP = 30;
/** 单条路径截断（参数里混进超长串时保住清单体积；160 足够放下任何正常路径） */
const PATH_CLIP = 160;

/**
 * 从一批消息的 tool_calls 里抽出文件路径。
 * 只看 `function.name` 在两个封闭枚举里的调用；参数串解析失败就**跳过那条**（不猜）。
 * 目标格：`path`（write/edit/read/ls/trash 主格）→ `target`（git_write）。
 */
export function extractTouched(
  msgs: Array<{ role: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> } | undefined>,
): { modified: string[]; read: string[] } {
  const modified: string[] = [];
  const read: string[] = [];
  for (const msg of msgs) {
    if (!msg || msg.role !== 'assistant' || !msg.tool_calls) continue;
    for (const call of msg.tool_calls) {
      const name = call.function.name;
      // 目标桶：两个枚举都不认的工具直接跳过（不进任何桶 —— "没认出来"不能伪装成"看过"）
      const isWrite = LEDGER_WRITE_TOOLS.has(name);
      const isRead = LEDGER_READ_TOOLS.has(name);
      if (!isWrite && !isRead) continue;
      let target: unknown;
      try {
        const args: unknown = JSON.parse(call.function.arguments);
        if (args && typeof args === 'object') {
          const obj = args as Record<string, unknown>;
          target = obj.path ?? obj.target;
        }
      } catch {
        continue; // 参数不是合法 JSON → 这条不抽（宁缺毋滥）
      }
      if (typeof target !== 'string' || target.trim() === '') continue;
      const p = target.length > PATH_CLIP ? target.slice(0, PATH_CLIP) : target;
      (isWrite ? modified : read).push(p);
    }
  }
  // 统一约定：**最近优先**（同批内消息倒序）。mergeLedger 的上限截断丢尾部 = 丢最老，
  // 渲染顺序也是新→旧 —— 三个动作共用同一条序，谁也不许再自己 reverse。
  return { modified: modified.reverse(), read: read.reverse() };
}

/**
 * 与上一版清单合并去重（**新条目优先**：超上限时先丢最老的 —— 最近碰过的文件最可操作）。
 * 去重键 = 路径字符串原样（不归一化大小写 / 分隔符：模型写什么样就记什么样，
 * 归一化反而可能把两个真实不同的路径合成一个）。
 */
export function mergeLedger(
  prev: { modified?: string[]; read?: string[] } | undefined,
  next: { modified: string[]; read: string[] },
): { modified: string[]; read: string[] } {
  const merge = (prevList: string[] | undefined, nextList: string[], cap: number): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...nextList, ...(prevList ?? [])]) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      if (out.length >= cap) break;
    }
    return out;
  };
  return {
    modified: merge(prev?.modified, next.modified, LEDGER_MODIFIED_CAP),
    read: merge(prev?.read, next.read, LEDGER_READ_CAP),
  };
}

/** 两个桶全空 → 这份清单不该存在（调用方据此决定写不写字段、渲染层据此决定出不出去） */
export function isLedgerEmpty(l: { modified: string[]; read: string[] }): boolean {
  return l.modified.length === 0 && l.read.length === 0;
}

/**
 * 渲染成摘要层的一节（**给人/模型读的输出**——断言断在渲染文本上，这是本仓的老规矩）。
 * 空清单返回空串（调用方见空串就不拼，不产生空节）；单边空只渲染另一边。
 */
export function renderLedger(l: { modified: string[]; read: string[] } | undefined): string {
  if (!l || isLedgerEmpty(l)) return '';
  const parts: string[] = [];
  if (l.modified.length > 0) parts.push(`改过: ${l.modified.join('、')}`);
  if (l.read.length > 0) parts.push(`看过: ${l.read.join('、')}`);
  return `[本会话碰过的文件（截至最近一次压缩）] ${parts.join('｜')}`;
}

/**
 * 摘要层成文：摘要散文在前、清单节在后（唯一拼接点，runtime 只调这里）。
 * 没摘要 → undefined（摘要层整层不出现）；有摘要无清单 → 原样返回（逐字不回退）。
 */
export function glueSummaryLedger(
  summary: string | undefined,
  ledger?: { modified: string[]; read: string[] },
): string | undefined {
  if (!summary) return undefined;
  const ledgerText = renderLedger(ledger);
  return ledgerText ? `${summary}\n\n${ledgerText}` : summary;
}
