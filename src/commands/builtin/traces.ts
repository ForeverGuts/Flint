/**
 * /traces 命令 —— 就地查看本次会话的行为分段耗时（内存，不落盘）。
 * 调用方：commands/loader.ts（自动扫描 builtin/ 目录装载）
 * 服务于：可观测性的"随手看一眼"——不必先开 TS_AGENT_TRACE 落盘、再翻 jsonl 文件，
 *         敲一下就知道最近几段各花了多久、成没成、此刻还在跑的是哪段
 *
 * 数据从 runtime.getTraces() / getRunningSpans() 来（Runtime 只读委托 SpanCollector），
 * 与 trace-log watcher 是同一份配对代码的两个独立实例：一个落盘、一个上屏，互不依赖。
 * 所以本命令开箱即用，不需要任何环境变量。
 */
import type { Runtime } from '../../runtime/runtime.js';
import type { CollectedSpan } from '../../core/events.js';

/** 状态 → 图标（与 /diagnostics 的判色习惯一致） */
const ICON: Record<string, string> = {
  ok: '✅',
  error: '❌',
  unclosed: '⚠️',
  running: '⏳',
};

/** 缺省展示条数 */
const DEFAULT_LIMIT = 10;

/** 耗时格式：不到 1 秒报毫秒，否则报秒（一位小数） */
function dur(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 用量只报 totalTokens（三项明细留给 trace.jsonl，这里要的是一眼扫过） */
function tokensOf(u: unknown): string {
  if (!u || typeof u !== 'object') return '';
  const total = (u as Record<string, unknown>).totalTokens;
  return typeof total === 'number' ? `${total} tok` : '';
}

/**
 * 每段挑最有用的信息拼一句。字段名按 runtime/events.ts 的 SpanContracts 取，
 * 缺就不显示（可缺字段的语义是"确实没有可报的"，不是 0 —— 显示 0 会骗人）。
 */
function detailOf(s: CollectedSpan): string {
  const i = s.input;
  const o = s.output;
  const p: string[] = [];

  switch (s.name) {
    case 'llm_request': {
      if (typeof i.model === 'string') p.push(i.model);
      if (typeof o.firstTokenMs === 'number') p.push(`首字 ${dur(o.firstTokenMs)}`);
      else if (o.firstTokenMs === null) p.push('首字 未收到');
      const tk = tokensOf(o.usage);
      if (tk) p.push(tk);
      if (typeof o.toolCallCount === 'number' && o.toolCallCount > 0) p.push(`调 ${o.toolCallCount} 个工具`);
      break;
    }
    case 'tool_call': {
      if (typeof i.name === 'string') p.push(i.name);
      if (typeof o.resultLength === 'number') p.push(`结果 ${o.resultLength} 字`);
      break;
    }
    case 'prompt': {
      if (typeof o.turns === 'number') p.push(`${o.turns} 轮`);
      const tu = tokensOf(o.totalUsage);
      if (tu) p.push(tu);
      break;
    }
    case 'compaction': {
      if (typeof i.msgCount === 'number') p.push(`压 ${i.msgCount} 条`);
      if (typeof o.summaryLength === 'number') p.push(`摘要 ${o.summaryLength} 字`);
      break;
    }
    default: {
      // 便签段（note_*）：载荷是自由字典，挑出门载荷的前两个键值显示
      p.push(...Object.entries(o).slice(0, 2).map(([k, v]) => `${k}=${String(v)}`));
    }
  }
  if (typeof s.error === 'string') p.push(s.error.slice(0, 60));
  return p.join(' · ');
}

/** 一行：图标 + 段名 + 耗时 + 进门序号 + 细节 */
function lineOf(s: CollectedSpan): string {
  const icon = ICON[s.status] ?? '•';
  const detail = detailOf(s);
  return `  ${icon} ${s.name.padEnd(12)}${dur(s.durationMs).padStart(7)}  #${s.seq}${detail ? `  ${detail}` : ''}`;
}

export function activate(runtime: Runtime): void {
  runtime.registerCommand('traces', '查看最近的行为分段耗时（内存，不落盘）', async (args) => {
    const all = runtime.getTraces();
    const running = runtime.getRunningSpans();

    // 参数：纯数字 = 条数；其他 = 段名关键字过滤（条数回落到缺省）
    const arg = args.trim();
    const isCount = /^\d+$/.test(arg);
    const limit = isCount ? Math.max(1, Number(arg)) : DEFAULT_LIMIT;
    const keyword = arg && !isCount ? arg.toLowerCase() : '';

    // 过滤对"正在跑"同样生效：说了只看 llm，就不该顺手带出一段 tool_call
    const match = (s: CollectedSpan): boolean => !keyword || s.name.toLowerCase().includes(keyword);
    const shown = all.filter(match).slice(-limit).reverse();   // 新的在前
    const runningShown = running.filter(match);

    if (shown.length === 0 && runningShown.length === 0) {
      return '📭 还没收到任何行为段。发一轮对话后再看（段是随对话实时收的，不必开 TS_AGENT_TRACE）。';
    }

    /* 合计只算 prompt 段：段是嵌套的（prompt 包着 llm_request，llm_request 又包着 tool_call），
       把所有 durationMs 加起来会把同一段时间重复计好几遍。prompt 是最外层且彼此不重叠，
       它的和才等于用户真正等掉的墙钟时间。 */
    const wallMs = all.filter((s) => s.name === 'prompt').reduce((sum, s) => sum + s.durationMs, 0);

    const head = keyword
      ? `段名含 "${keyword}" 的 ${shown.length} 段（本次会话共收 ${all.length} 段）:`
      : `最近 ${shown.length} 段（本次会话共收 ${all.length} 段 · 对话墙钟合计 ${dur(wallMs)}）:`;

    const runningBlock = runningShown.length > 0
      ? `\n正在跑（${runningShown.length} 段）:\n${runningShown.map(lineOf).join('\n')}`
      : '';

    // 走到这里 shown 为空只有一种可能：过滤词没命中已收束的段，但正好有段在跑
    const hint = shown.length === 0
      ? '\n（已收束的段里没有匹配这个过滤词的。段名有 prompt / llm_request / tool_call / compaction）'
      : `\n（/traces 20 看最近 20 段 · /traces llm 按段名过滤 · 明细落盘需 TS_AGENT_TRACE=1）`;

    return `${head}\n${shown.map(lineOf).join('\n')}${runningBlock}${hint}`;
  });
}
