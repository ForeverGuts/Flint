/**
 * 通用请求助手 —— 抽离 fetch 逻辑，避免 chat/stream 重复。
 * 调用方：DeepSeekProvider 等具体实现
 * 服务于：统一 OpenAI 兼容格式的 HTTP 请求与流式解析
 */
import type { LLMConfig, LLMMessage, LLMStreamEvent } from './types.js';
import { EventStream } from '../runtime/event-stream.js';

/* ════════════════════════════════════════════════════════════════════════════
   通用 fetch 构造（非流式 + 流式共用）
     需要：config.baseUrl → API 地址
           config.apiKey  → 认证密钥
           config.model   → 模型名
           body           → 请求参数（messages, stream 等）
   过程：拼接 URL → 注入 Authorization header → 序列化 JSON body
   ════════════════════════════════════════════════════════════════════════════ */

function buildRequest(config: LLMConfig, body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ ...body, model: config.model }),
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   非流式请求（chat）
     需要：config.baseUrl → API 地址（如 https://api.deepseek.com）
           messages       → 对话消息列表 [{role, content}, ...]
   过程：发起 fetch → 等完整 HTTP 响应 → 解析 JSON → 提取 choices[0].message.content
   返回：完整回复文本（一次性）
   ════════════════════════════════════════════════════════════════════════════ */

export async function createChat(config: LLMConfig, messages: LLMMessage[]): Promise<string> {
  const body: Record<string, unknown> = { messages, stream: false, thinking: { type: 'disabled' } };
  const res = await fetch(`${config.baseUrl}/chat/completions`, buildRequest(config, body));
  if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}

/* ════════════════════════════════════════════════════════════════════════════
   流式请求（stream）
     需要：config.baseUrl → API 地址
           messages       → 对话消息列表
           EventStream    → 推拉通道，生产者 push，消费者 for await...of
   过程分 5 步：
     ① 发起 fetch + stream:true（告诉 API 我要流式）
     ② 获取 reader（ReadableStream，逐块读取 HTTP 响应体）
     ③ 粘包/半包处理（buffer 拼合 → 按行切分 → 完整行解析 → 半截放回）
     ④ 遍历完整行，解析 SSE data JSON，提取 delta.content
     ⑤ 流结束 → push end 事件（携带完整文本）
   ════════════════════════════════════════════════════════════════════════════ */

export function createSSEStream(config: LLMConfig, messages: LLMMessage[]): EventStream<LLMStreamEvent> {
  // ① 创建 EventStream 实例
  //    需要两个判断函数：
  //    - isComplete：当事件 type === 'end' 时标记流结束
  //    - extractResult：从 end 事件中提取完整文本供 result() 使用
  const eventStream = new EventStream<LLMStreamEvent>(
    (event) => event.type === 'end',
    (event) => event as { type: 'end'; fullText: string },
  );

  // ② 立即启动异步生产者（不阻塞当前线程，EventStream 内部缓冲）
  //    消费者通过 for await...of 从 EventStream 拉取事件
  (async () => {
    try {
      // ── ②-a 发起 HTTP 请求 ──
      //     需要：config.baseUrl + /chat/completions
      //           config.apiKey → Bearer token
      //           body → model + messages + stream:true
      //     过程：fetch → 等待第一个响应头 → 获取可读流 res.body
      //     注意：此时连接保持打开，API 会持续发送 SSE 事件
      const body: Record<string, unknown> = { messages, stream: true, thinking: { type: 'disabled' } };
      const res = await fetch(`${config.baseUrl}/chat/completions`, buildRequest(config, body));
      if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);

      // ── ②-b 获取流读取器 ──
      //     res.body 是 ReadableStream<Uint8Array>（HTTP 响应体的流式接口）
      //     getReader() 返回一个可逐块读取的 reader
      //     每次 reader.read() 返回 { done: boolean, value: Uint8Array }
      const reader = res.body!.getReader();

      // ── ②-c 初始化 SSE 解析状态 ──
      //     decoder：将 Uint8Array 二进制块解码为字符串（UTF-8）
      //     buffer：粘包/半包缓冲区（存储上一轮未完成的半截行）
      //     full：累加所有 token，最终作为 end 事件的完整文本
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';

      // ── ②-d 主循环：逐块读取 HTTP 流 ──
      //     每次循环读取一个 chunk（可能是多个 SSE 事件、半个事件、或多个完整事件）
      //     当 res.body 读完时 done === true
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // ── ②-e 粘包/半包处理 ──
        //     问题：一次 reader.read() 可能拿到：
        //       - 半个 SSE 事件（"data: {\"choices\":[{\"delta\":{\"cont"）
        //       - 多个完整 SSE 事件粘在一起
        //     处理：
        //       1. 新数据追加到 buffer（和上一轮的半截拼起来）
        //       2. 按 \n 切分成行（SSE 协议每行以 \n 结尾）
        //       3. 弹出行数组的最后一项放回 buffer（可能是不完整的半截）
        //       4. 剩余行都是完整的，进入下一阶段解析
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        // ── ②-f 逐行解析 SSE ──
        //     每行格式：data: {"choices":[{"delta":{"content":"你好"}}]}
        //     过虑规则：
        //       - 空行 → 跳过（SSE 协议用空行分隔事件）
        //       - data: [DONE] → 跳过（API 的流结束标记）
        //       - 不以 data: 开头 → 跳过（非 SSE 行）
        //       - 合法 → JSON.parse 提取 delta.content
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            // ── ②-g 提取 token 并推入 EventStream ──
            //     trimmed.slice(6) 去掉 "data: " 前缀
            //     json.choices[0].delta.content 是本次的 token 块
            //     可能为空（如 role 标记行），此时跳过
            const json = JSON.parse(trimmed.slice(6)) as {
              choices?: Array<{ delta: { content?: string } }>;
            };
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              full += content;                                   // 累加到完整文本
              eventStream.push({ type: 'token', text: content }); // push 到 EventStream
            }
          } catch {
            // 跳过无法解析的 SSE 行（如非 JSON 的 keepalive 行）
          }
        }
      }

      // ── ②-h 流结束 ──
      //     当 reader.read() 返回 done: true 时，HTTP 流已关闭
      //     data: [DONE] 标记已在解析循环中被跳过
      //     此时推入 end 事件，携带完整文本，供消费者使用
      eventStream.push({ type: 'end', fullText: full });
    } catch {
      // ── ②-i 异常处理 ──
      //     网络断开 / API 返回错误 / JSON 解析失败 等
      //     调用 eventStream.end() 强制结束流
      //     消费者会在 for await...of 中退出循环
      eventStream.end();
    }
  })();

  return eventStream;
}
