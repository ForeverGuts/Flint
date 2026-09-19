/**
 * /events 命令 —— 在终端翻阅历史事件库（人看的入口；模型的入口是 search_events 工具）。
 *
 * 调用方：commands/loader.ts 自动扫描（本目录每个导出 activate 的文件都会被加载）
 *
 * 读**内存索引**（启动时从 .flint/events.jsonl 全量载入，运行期以内存为准）。
 * 排版共用 formatEvent —— 终端与 search_events 的记号不会分家（单一排版实现纪律）。
 * 「翻译」同样在那儿：类型徽章与标签的中文名取自 store 的 `KIND_LABELS` / `TAG_LABELS`
 * —— 是**同一个渲染器的同一个输出**，不是给终端另开的第二套排版。
 *
 * 参数（空格后全部原样传入，按"词 = 值"解析，可组合）：
 *   /events                          最近 20 条（最新在前）
 *   /events offset=20                翻页：跳过最新的 20 条（就是"下一页"）
 *   /events kind=incident            只看事故与坑（中文名也认：`kind=事故`）
 *   /events tag=ui                   只看带 ui 标签的
 *   /events q=弹窗                   关键词子串过滤
 *   /events limit=50                 一页最多几条（改的是"页大小"，不是"第几页"）
 *
 * 为什么翻页是 offset 而不是 page：坐标只有"跳过多少条"这一个数，页大小（limit）可以随时改；
 * page 会把"第几页"和"一页多大"捆在一起算，改 limit 就找不到刚才看到哪儿了。
 * 页脚给的是**可直接粘回去的下一批命令**（带着当前过滤词一起），不用自己记参数。
 */
import type { Runtime } from '../../runtime/runtime.js';
import { eventStore, formatEvent, normalizeKind } from '../../eventlog/store.js';

/** /events 不带参数时的默认条数（防一个跑了很久的 cwd 刷出千行） */
const DEFAULT_SHOWN = 20;

export function activate(runtime: Runtime): void {
  runtime.registerCommand('events', '翻阅历史事件库（决策/经验/事故/工具调用记录）', (args: string) => {
    const total = eventStore.count();
    if (total === 0) {
      return '历史事件库为空（.flint/events.jsonl 不存在或无条目）。'
        + '工具调用会被自动记录；重要决策/经验/坑用 record_event 存档。';
    }

    // 解析 "k=v k=v" 参数（未识别的词当关键词，容忍中文逗号与引号）
    let kind = '', tag = '', keyword = '', limit = DEFAULT_SHOWN, offset = 0;
    for (const raw of args.split(/\s+/).filter(Boolean)) {
      const m = /^(\w+)=(.*)$/.exec(raw.replace(/^["']|["']$/g, ''));
      if (!m) { keyword += ` ${raw}`; continue; }
      const [, k, v] = m;
      if (k === 'kind') kind = v;
      else if (k === 'tag') tag = v;
      else if (k === 'q') keyword += ` ${v}`;
      else if (k === 'limit') limit = Math.max(1, Number.parseInt(v, 10) || DEFAULT_SHOWN);
      // 负数归 0：`offset=-1` 想表达的"从头来"就是 0，不该让它把 slice 算成从末尾数起
      else if (k === 'offset') offset = Math.max(0, Number.parseInt(v, 10) || 0);
      else keyword += ` ${raw}`;
    }
    keyword = keyword.trim();
    // 在这里先归一化一次：下面既要拿它去查，也要拿它决定"全库"该指哪本库、以及页脚回显什么
    kind = normalizeKind(kind);

    // 取**全部命中**再自己切片：翻页是"怎么看"的事，不该往检索口径里塞一个新参数
    // （search 只管"哪些命中、最新在前"，分页归命令层）
    const matched = eventStore.search({
      ...(kind ? { kind } : {}),
      ...(tag ? { tag } : {}),
      ...(keyword ? { keyword } : {}),
      limit: Number.MAX_SAFE_INTEGER,
    });

    if (matched.length === 0) {
      return `无匹配事件（叙事库共 ${total} 条，另有 tool_call 流水 ${eventStore.countCalls()} 条）。检查 kind/tag/q 过滤词。`;
    }

    const page = matched.slice(offset, offset + limit);
    if (page.length === 0) {
      return `已到末尾：offset=${offset} 已经把全部 ${matched.length} 条命中都跳过去了`
        + '（offset 是"跳过最新的 N 条"，翻页用；从头看就别给 offset）。';
    }

    const first = offset + 1;
    const last = offset + page.length;
    const range = first === last ? `第 ${first} 条` : `第 ${first}–${last} 条`;
    const filterDesc = [kind && `kind=${kind}`, tag && `tag=${tag}`, keyword && `q=${keyword}`]
      .filter(Boolean).join(' ');
    // "全库"要指对那本库：kind=tool_call 查的是流水索引，不是叙事库
    const pool = kind === 'tool_call'
      ? `流水共 ${eventStore.countCalls()} 条`
      : `全库 ${total} 条`;
    const scope = filterDesc
      ? `${filterDesc}，显示 ${range} / 命中 ${matched.length} 条（${pool}）`
      : `显示 ${range}，共 ${total} 条`;
    const head = `历史事件（${scope}，最新在前`
      + `；另有 tool_call 流水 ${eventStore.countCalls()} 条在 tool-calls.jsonl，kind=tool_call 查看）：`;

    // 页脚：还有更早的就把"下一批"的命令原样拼出来（过滤词一个不落，能直接粘回去）
    const remaining = matched.length - last;
    const nextArgs = [
      ...(kind ? [`kind=${kind}`] : []), ...(tag ? [`tag=${tag}`] : []),
      ...(keyword ? [`q=${keyword}`] : []), `offset=${last}`, `limit=${limit}`,
    ].join(' ');
    const foot = remaining > 0 ? [`（更早的还有 ${remaining} 条 → /events ${nextArgs}）`] : [];

    // 序号给的是**全库位置**（offset + i + 1），不是"本页第几条" —— 翻页时对得上号
    return [head, ...page.map((e, i) => formatEvent(e, offset + i + 1)), ...foot].join('\n\n');
  });
}
