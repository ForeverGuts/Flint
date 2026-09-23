/**
 * 压缩判据（纯函数）—— ROADMAP 10.8.6 / 10.8.7 / 10.8.8 / 10.8.9 / 10.8.12。
 * 调用方：context/compaction.ts（maybeCompact 与 compactTo 两个入口）
 * 服务于：把「要不要压 / 留多少 / 从哪切 / 摘要写多长 / 失败了怎么办」这五件事
 *         从压缩执行流程里抽出来 —— 执行流程混着 LLM 调用与落盘，没法逐条打靶。
 *
 * ── 为什么这五件要放在一起 ──
 * 它们改的是**同一个位置**（切割点），但动机各不相同：
 *   10.8.9 体积触发 → 决定"要不要压"；
 *   10.8.9 预算保留 → 决定"留多少"（进而决定切割点在哪）；
 *   10.8.12 合法性  → 决定"这个切割点能不能用，不能就往哪挪"；
 *   10.8.7/8 摘要   → 决定"被换出去的那段写多长、要不要带上上一版"；
 *   10.8.6 失败退避 → 决定"上次没压成，这次还试不试"。
 * 混在 compactTo 里会变成一串互相咬合的 if，改一条牵三条、谁也说不清为什么。
 *
 * ── 零 import（除 token 估算）──
 * 只依赖 core/token-estimate.ts 那个纯函数；不碰 fs、不碰时间、不碰随机数。
 */

import { estimateMessagesTokens, estimateTokens } from '../core/token-estimate.js';

/**
 * 上下文体积预算（token）：历史估算超过它就压。
 *
 * 为什么是这个数：**压缩是为了省钱和提速，不是为了腾地方**（模型真正的上限在几十万量级，
 * 离这里很远）。12000 ≈ 一次请求里"历史部分"开始明显拖慢、且每轮都按这个长度重复付费的拐点。
 * 条数阈值（20）**保留为兜底**而不是删掉：体积估算对"大量极短消息"不敏感，
 * 那种情况仍靠条数兜住（否则会攒出几百条短消息，工具描述与 system 之外的部分照样膨胀）。
 */
export const CONTEXT_BUDGET_TOKENS = 12000;

/** 保留窗口的预算 = 上下文预算的这个比例（压完要让历史**明显**小于预算，否则下一轮立刻又触发） */
export const KEEP_BUDGET_RATIO = 0.5;

/**
 * 保留窗口的**下限**（条）。
 * 为什么有下限：一条消息就可能占满整个预算（比如工具吐回一整个文件），
 * 若严格按预算算会得出"保留 1 条"——那等于把模型刚做的事也清掉了，它连上一轮在干什么都不知道。
 * 4 = 一问一答 + 可能的一轮工具往返。
 */
export const MIN_KEEP = 4;

/** 条数兜底阈值（与体积阈值**或**的关系：任一超了就压） */
export const COMPACT_MESSAGE_THRESHOLD = 20;

/**
 * 摘要字数预算（字）。
 * 为什么从 50 改成 400：50 字概括 10 轮对话几乎必然丢光——这是"信息逐层消失"里**最便宜可修**的一环。
 * 成本几乎不变（摘要只占上下文极小一块：400 字 ≈ 400 token，相对 12000 的预算是 3%）。
 *
 * 顺带它就是**滚动摘要防无限变长**的答案：每一版摘要都受同一个上限约束，
 * 所以摘要链天然有界，不需要再叠一层"摘要的摘要"。
 */
export const SUMMARY_BUDGET_CHARS = 400;

/** 触发判定结果 */
export interface CompactVerdict {
  /** 是否需要压缩 */
  needed: boolean;
  /** 触发原因：`tokens` 体积超预算 / `messages` 条数超阈值；不需要时缺省 */
  reason?: 'tokens' | 'messages' | undefined;
  /** 估算出的历史体积（token）—— 回执与断言都用它，避免调用方再算一遍 */
  tokens: number;
}

/**
 * 要不要压缩（**体积或条数，任一超了就压**）。
 *
 * 为什么是"或"而不是只留体积：只留体积的话，200 条极短闲聊永远不触发，
 * 而条数本身也会拖累（每条都要带 role、都要进注意力）。只留条数（改前的行为）则相反：
 * 3 条超长消息体积已经很大却不触发。两条都在，各自兜住对方看不见的那一半。
 */
export function shouldCompact(
  history: ReadonlyArray<{ content: string }>,
  budgetTokens: number = CONTEXT_BUDGET_TOKENS,
  messageThreshold: number = COMPACT_MESSAGE_THRESHOLD,
): CompactVerdict {
  const tokens = estimateMessagesTokens(history);
  if (tokens > budgetTokens) return { needed: true, reason: 'tokens', tokens };
  if (history.length > messageThreshold) return { needed: true, reason: 'messages', tokens };
  return { needed: false, tokens };
}

/**
 * 保留窗口取多少条 —— **按体积算，条数只是上限与下限**。
 *
 * 从末尾往前累加，直到累计体积超过 `budgetTokens` 就停；
 * 结果夹在 `[minKeep, maxKeep]` 之间。
 *   · 消息很短（常见情况）：累加到上限也没超预算 → 夹到 `maxKeep`，与改前"保留 10 条"**逐字一致**；
 *   · 消息很长：几条就把预算吃满 → 窗口自动收窄，这才是按体积触发想要的效果。
 */
export function chooseKeep(
  messages: ReadonlyArray<{ content: string }>,
  budgetTokens: number,
  maxKeep: number,
  minKeep: number = MIN_KEEP,
): number {
  if (messages.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    sum += estimateTokens(messages[i].content);
    n++;
    if (sum > budgetTokens) break;
  }
  return Math.min(Math.max(n, minKeep), Math.max(1, maxKeep));
}

/**
 * 把切割点挪到**合法边界**（ROADMAP 10.8.12）。
 *
 * 为什么必须有这一步（2026-09-23 查证确认）：工具结果是**逐条落盘**的独立条目
 * （`role: 'tool'` + `tool_call_id`，见 runtime.ts 轮末落盘），所以"倒数第 N 条"完全可能
 * 落在一条工具结果上。真落在上面，保留窗口第一条就是一条**没有配对 tool_use 的孤儿结果**，
 * 多数模型 API 会直接拒绝这次请求（症状：压缩后第一次提问就报错）。
 *
 * 往哪挪：**往前**（更早）挪到最近的非 tool 条目。会话里的顺序是
 * `assistant(带 tool_calls) → tool → tool → assistant`，所以往前挪一步通常就落到那条
 * 发起调用的 assistant 上——调用与结果一起被保留，成对。
 * 往**后**挪是错的：那会把这条孤儿留在窗口里，病没治。
 *
 * 代价：保留条数会比预算多几条（安全优先，宁可多留不可造孤儿）。
 */
export function safeCutIndex(roles: ReadonlyArray<string>, cut: number): number {
  if (roles.length === 0) return 0;
  let i = Math.min(Math.max(cut, 0), roles.length - 1);
  while (i > 0 && roles[i] === 'tool') i--;
  return i;
}

/**
 * 摘要提示词（ROADMAP 10.8.7 放宽预算 + 10.8.8 滚动摘要）。
 *
 * 滚动摘要 = 把上一版摘要**前置**喂进去，让信息能跨层传承（改前每版都从零重写，
 * 压三次之后开头那批在模型视野里彻底消失）。
 *
 * 两条防漂移的硬话写进提示词里：
 *  ① "保留关键决策、约束、待办与结论" —— 明确该留什么，别让模型自由发挥成一段流水账；
 *  ② "与概括冲突处以新对话为准" —— 否则旧摘要里的过时结论会被一直传下去。
 */
export function renderSummaryPrompt(
  prevSummary?: string | undefined,
  budgetChars: number = SUMMARY_BUDGET_CHARS,
): string {
  if (!prevSummary) {
    return `将以下对话压缩为一段摘要（不超过 ${budgetChars} 字），保留关键决策、约束、待办与结论。只输出摘要。`;
  }
  return (
    `以下是更早阶段的概括（请保留其中仍然成立的关键信息）：\n《${prevSummary}》\n\n` +
    `将这段概括与下面的新对话压缩为一段摘要（不超过 ${budgetChars} 字）：` +
    `保留关键决策、约束、待办与结论；与概括冲突处以新对话为准。只输出摘要。`
  );
}

/**
 * 上次摘要失败后，这次还试不试（ROADMAP 10.8.6 的退避）。
 *
 * 为什么需要退避：失败时历史**原样返回**（不再偷偷裁掉），于是下一轮体积/条数**仍然**超阈值
 * —— 不退避的话每轮都会白烧一次摘要调用。
 * 判据：只有对话比失败那刻**又长了 step 条**才重试（`>=`）。没失败过（`failedAt` 缺省）永远试。
 */
export function shouldRetryAfterFailure(
  historyLength: number,
  failedAt: number | undefined,
  step: number,
): boolean {
  if (failedAt === undefined) return true;
  return historyLength >= failedAt + step;
}
