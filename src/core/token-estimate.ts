/**
 * Token 估算 —— 没有分词器时的**粗算兜底**（按字符类别加权）。
 * 调用方：runtime/utils.ts（`/usage` 在 API 没报用量时的兜底）、
 *         context/compaction-policy.ts（压缩触发判据与保留窗口预算）
 * 服务于：两处都要回答"这段文本大概多少 token"，而**这个判据只能有一份** ——
 *         各写一份必然漂移，且漂移是**互相掩护**的（各测各的都绿，合起来口径不一致）。
 *
 * ── 为什么是粗算 ──
 * 零运行时依赖 = 没有分词器。真实的 tokenizer 对中文大约 1~1.5 token/字、
 * 对英文大约 4 字符/token。这里取"中文 1、空白 0.2、其他 0.25"这一组近似，
 * 精度够用于**阈值判断**（几百 token 的误差不影响"该不该压"这个结论），
 * 不够用于计费 —— 计费一律优先用 API 回传的真值。
 *
 * 零 import、纯函数：不碰 fs、不依赖任何运行时状态。
 */

/** 单段文本的估算 token 数（空文本也算 1：与历史行为一致，避免出现 0 这种"什么都没发"的假象） */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    if (/[一-鿿]/.test(char)) {
      tokens += 1; // 中文字符
    } else if (/\s/.test(char)) {
      tokens += 0.2; // 空白
    } else {
      tokens += 0.25; // 英文 / 数字 / 符号
    }
  }
  return Math.max(1, Math.ceil(tokens));
}

/** 一批消息的估算 token 数（按 `content` 累加；`role` 那几个字符忽略不计） */
export function estimateMessagesTokens(messages: ReadonlyArray<{ content: string }>): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content);
  return total;
}
