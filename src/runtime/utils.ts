/**
 * 工具函数 —— 从 runtime.ts 抽离的通用方法。
 * 调用方：runtime.ts（prompt 方法中引用）
 * 服务于：LLM 回复中的工具调用解析、Token 用量估算
 */

/** 修复 LLM 生成的 JSON 中常见的格式错误 */
function fixJSON(raw: string): string {
  let s = raw.trim();
  // 去掉尾随逗号：{a:1,} → {a:1}
  s = s.replace(/,\s*([}\]])/g, '$1');
  // 补全缺失的引号：{a:1} → {"a":1}
  s = s.replace(/(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
  // 将单引号替换为双引号
  s = s.replace(/'/g, '"');
  // 修复 Windows 路径中的单反斜杠（如 C:\Users → C:\\Users）
  // 使用负向后顾，只在反斜杠「没有被前一个反斜杠转义」时才处理
  // 避免破坏 JSON 中正确的 \\ 转义序列（即 \\U 不会被拆成 \ + \U）。
  // 排除列表中保留 \n、\t、\r、\b、\f、\u 等标准 JSON 转义符，
  // 不把合法转义错误地加倍。注意：此函数只在原生 JSON.parse 失败后调用，
  // 绝大多数 LLM 生成的 JSON 是合法的，不走这里。
  s = s.replace(/(?<!\\)\\([^"\\\/bfnrtu])/g, '\\\\$1');
  return s;
}

/**
 * 从文本中提取 <tool_call>...</tool_call> 或 <tool_call>{...}（无闭合标签）格式的工具调用。
 *
 * LLM 有时会省略 </tool_call> 闭合标签，此函数同时支持两种格式：
 *   格式 1: <tool_call>{"name":"read","arguments":{...}}</tool_call>
 *   格式 2: <tool_call>{"name":"read","arguments":{...}}   ← 无闭合标签
 *
 * 解析策略：找到 <tool_call> 后，从后续文本中逐字符跟踪大括号深度，
 * 当深度回到 0 时认为 JSON 对象结束，从中提取 name 和 arguments。
 */
export function parseToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const results: Array<{ name: string; args: Record<string, unknown> }> = [];
  const startTag = '<tool_call>';
  let searchFrom = 0;

  while (true) {
    const tagStart = text.indexOf(startTag, searchFrom);
    if (tagStart === -1) break;

    const jsonStart = tagStart + startTag.length;
    if (jsonStart >= text.length) break;

    // 从 <tool_call> 后面开始，找到匹配的闭合大括号
    // 注意：LLM 生成的 JSON 中的 \ 是路径分隔符（如 C:\Users），
    // 不是 JSON 转义符，所以解析时不跳过 \ 后的字符。
    let braceDepth = 0;
    let jsonEnd = -1;
    let inString = false;

    for (let i = jsonStart; i < text.length; i++) {
      const ch = text[i];

      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue; // 字符串内的字符不参与大括号计数

      if (ch === '{') { braceDepth++; continue; }
      if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0) { jsonEnd = i; break; }
      }
    }

    if (jsonEnd === -1) break; // 没有找到闭合的 JSON 对象

    const jsonStr = text.slice(jsonStart, jsonEnd + 1);
    searchFrom = jsonEnd + 1;

    let json: Record<string, unknown> | null = null;
    // ① 先尝试原生 JSON.parse（LLM 通常生成合法 JSON，含 \\n 等标准转义）
    try {
      json = JSON.parse(jsonStr);
    } catch {
      // ② 原生解析失败 → 用 fixJSON 修复常见格式错误后再试
      // fixJSON 只在原生解析失败时使用，避免破坏合法 JSON 中的 \n 等转义
      try {
        const fixed = fixJSON(jsonStr);
        json = JSON.parse(fixed);
      } catch {
        // ③ 修复后仍解析失败 → 跳过此调用
        console.warn(`[parseToolCalls] 跳过无法解析的调用: ${jsonStr.slice(0, 80)}`);
      }
    }
    if (json) {
      results.push({
        name: (json.name as string) || ((json.function as Record<string, unknown> | undefined)?.name as string) || 'unknown',
        args: ((json.arguments ?? json.args) as Record<string, unknown>) || {},
      });
    }
  }

  return results;
}

/** Token 用量估算（API 未返回精确用量时的兜底） */
export function estimateTokenUsage(
  input: string,
  output: string,
): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const estimate = (text: string) => {
    let tokens = 0;
    for (const char of text) {
      if (/[一-鿿]/.test(char)) {
        tokens += 1; // 中文字符
      } else if (/\s/.test(char)) {
        tokens += 0.2; // 空格
      } else {
        tokens += 0.25; // 英文字符
      }
    }
    return Math.max(1, Math.ceil(tokens));
  };
  const promptTokens = estimate(input);
  const completionTokens = estimate(output);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/**
 * 流式工具调用文本过滤 —— 从逐片到达的 LLM token 流中剔除 <tool_call> 块。
 * 调用方：runtime.ts（单 stream 循环里，把每个 token 先过这里再推给 UI）
 * 服务于：工具调用标签是给系统解析的，不应展示给用户
 *
 * 难点：token 是逐片到达的，单看某个 token 无法判断它是否属于 <tool_call>。
 * 方案：累积一个"尾随缓冲"，当缓冲末尾与 <tool_call> 开头匹配时，
 *       后续内容进入"隐藏模式"，直到拼出 </tool_call> 闭合标签。
 *       隐藏模式下吞掉所有文本；非隐藏模式下把文本返回供展示。
 *
 * 用法（状态机，跨多次调用保持 this 引用）：
 *   const filter = createToolCallFilter();
 *   const visible = filter.push(tokenText);   // 返回应展示给用户的文本（可为空）
 *   filter.flush();                            // 流结束时取残留（若有未闭合标签）
 */
export interface ToolCallFilter {
  /** 喂入一段 token 文本，返回应展示给用户的文本（tool_call 内部为空串） */
  push(text: string): string;
  /** 流结束时调用，返回缓冲中的残留可见文本（丢弃未闭合的 tool_call 尾部） */
  flush(): string;
  /** 当前是否处于 tool_call 隐藏模式（供调试/测试） */
  inToolCall(): boolean;
}

/** 创建工具调用过滤状态机 */
export function createToolCallFilter(): ToolCallFilter {
  const OPEN_TAG = '<tool_call>';
  const CLOSE_TAG = '</tool_call>';
  /** 尾随缓冲：累积未消费的字符，用于匹配开标签 */
  let tail = '';
  /** 是否处于 tool_call 隐藏模式 */
  let hidden = false;
  /** 隐藏模式中累积的片段（用于匹配闭合标签） */
  let hiddenBuf = '';

  return {
    push(text: string): string {
      if (!text) return '';
      let visible = '';
      let pending = text;

      if (hidden) {
        // ── 隐藏模式：累积直到拼出闭合标签 ──
        hiddenBuf += pending;
        const closeIdx = hiddenBuf.indexOf(CLOSE_TAG);
        if (closeIdx !== -1) {
          hidden = false;
          hiddenBuf = '';
        }
        return ''; // 隐藏模式下不展示任何内容
      }

      // ── 正常模式：把新文本拼到尾随缓冲 ──
      tail += pending;

      // 检查是否出现开标签：从缓冲中查找 <tool_call>
      const openIdx = tail.indexOf(OPEN_TAG);
      if (openIdx !== -1) {
        // 开标签之前的文本是可见的
        visible = tail.slice(0, openIdx);
        // 进入隐藏模式，开标签本身及其后内容都不展示
        hidden = true;
        hiddenBuf = tail.slice(openIdx + OPEN_TAG.length);
        tail = '';
        // 如果开标签后已含闭合标签（极端情况，同片内闭合），尝试立即闭合
        if (hiddenBuf.includes(CLOSE_TAG)) {
          hidden = false;
          hiddenBuf = '';
        }
        return visible;
      }

      // 没找到开标签：但尾随缓冲可能只含开标签的前缀（如 "<tool_ca"）
      // 保留 tail 用于下一片匹配，同时把"确定是前缀"的部分截掉
      const maxPrefixLen = OPEN_TAG.length - 1;
      if (tail.length > maxPrefixLen) {
        // 前 tail.length - maxPrefixLen 个字符不可能属于开标签前缀（超长了），可以安全展示
        const safeLen = tail.length - maxPrefixLen;
        visible = tail.slice(0, safeLen);
        tail = tail.slice(safeLen);
      }
      return visible;
    },

    flush(): string {
      const leftover = tail;
      tail = '';
      if (hidden) {
        // 流结束时仍在隐藏模式 → 开标签未闭合，丢弃隐藏缓冲，tail 也一并丢弃
        hidden = false;
        hiddenBuf = '';
        return '';
      }
      return leftover;
    },

    inToolCall(): boolean {
      return hidden;
    },
  };
}
