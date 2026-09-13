/**
 * /events 命令 —— 在终端翻阅历史事件库（人看的入口；模型的入口是 search_events 工具）。
 *
 * 调用方：commands/loader.ts 自动扫描（本目录每个导出 activate 的文件都会被加载）
 *
 * 读**内存索引**（启动时从 .flint/events.jsonl 全量载入，运行期以内存为准）。
 * 排版共用 formatEvent —— 终端与 search_events 的记号不会分家（单一排版实现纪律）。
 *
 * 参数（空格后全部原样传入，按"词 = 值"解析，可组合）：
 *   /events                          最近 20 条（最新在前）
 *   /events kind=incident            只看事故与坑
 *   /events tag=ui                   只看带 ui 标签的
 *   /events q=弹窗                   关键词子串过滤
 *   /events limit=50                 改返回条数
 */
import type { Runtime } from '../../runtime/runtime.js';
import { eventStore, formatEvent } from '../../eventlog/store.js';

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
    let kind = '', tag = '', keyword = '', limit = DEFAULT_SHOWN;
    for (const raw of args.split(/\s+/).filter(Boolean)) {
      const m = /^(\w+)=(.*)$/.exec(raw.replace(/^["']|["']$/g, ''));
      if (!m) { keyword += ` ${raw}`; continue; }
      const [, k, v] = m;
      if (k === 'kind') kind = v;
      else if (k === 'tag') tag = v;
      else if (k === 'q') keyword += ` ${v}`;
      else if (k === 'limit') limit = Number.parseInt(v, 10) || DEFAULT_SHOWN;
      else keyword += ` ${raw}`;
    }
    keyword = keyword.trim();

    const hits = eventStore.search({
      ...(kind ? { kind } : {}),
      ...(tag ? { tag } : {}),
      ...(keyword ? { keyword } : {}),
      limit,
    });

    if (hits.length === 0) return `无匹配事件（库共 ${total} 条）。检查 kind/tag/q 过滤词。`;
    const filterDesc = [kind && `kind=${kind}`, tag && `tag=${tag}`, keyword && `q=${keyword}`]
      .filter(Boolean).join(' ');
    const head = `历史事件（${filterDesc ? `${filterDesc}，` : ''}显示 ${hits.length}/${total} 条，最新在前）：`;
    return [head, ...hits.map((e, i) => formatEvent(e, i + 1))].join('\n\n');
  });
}
