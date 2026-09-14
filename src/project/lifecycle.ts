/**
 * 项目生命周期档案 —— ROADMAP P10.12 的**档案侧**（DEVLOG 排版 + 归档回执）。
 * 调用方：`tools/builtin.ts` 的 archive 工具、`scripts/verify-lifecycle.ts`
 * 服务于：把一个坐标"完成"这件事**一次写成两处**——
 *   ① `.flint/DEVLOG.md`（**人读散文**：前后区别 / 意义 / 影响面 / 遗留，只追加）
 *   ② 事件库（**机读四段**，由工具落一条 kind=system）
 * 写两处不是重复，是两种读者：人要能顺序读一遍就明白发生了什么、为什么值得；
 * 机器要能跨会话检索出来（"上次这一步为什么这么改"）。两者刻意不互替
 * （散文进不了检索、四段字段读不出语气），这也正是 10.12.8「归档双写」的意思。
 *
 * ── 为什么分段固定，不做成自由散文 ──
 * "自由散文"在这类记录上很容易退化成流水账（"改了 A、改了 B、跑通了"）——
 * 四段逼着写的人回答四个不同的问题：**改变了什么 / 为什么值得 / 牵动了谁 / 还剩什么**。
 * 形状固定还有个副作用是好事：一眼能看出哪一段被跳过了。
 * 但**空段不写空标题**：写了 `**遗留**：` 后面跟一片空白，等于告诉读者"这里本该有内容"。
 * 故 `leftover` / `evidence` 可选、空则整行不写；`changes` / `meaning` / `impact` 三段由
 * 工具层强制非空（缺了就报 [INVALID]，别写一份自己都说不出价值的归档）。
 *
 * ── 只追加 ──
 * DEVLOG 与 Log/ 的追加日志同一纪律：**历史条目冻死**，要更正就再追加一条"以本条为准"。
 * 所以本模块只负责**渲染一节**，append 由调用方做（本模块不碰 fs）。
 *
 * 零运行时依赖：纯函数 + 字面量（连 node 内置都不需要）。
 */

/** 开发日志（DEVLOG）的文件头 —— 文件不存在时由调用方先写它再追加 */
export const DEVLOG_HEADER = `# 开发日志

> 每完成一个坐标追加一节（**只追加**：要更正就再追加一条"以本条为准"，绝不改写旧节）。
> 每节回答四个问题：前后区别 / 意义 / 影响面 / 遗留。

`;

/** 一次归档的输入。`at` 由调用方给（保持本模块是纯函数，时间不进纯逻辑）。 */
export interface ArchiveInput {
  /** 坐标编号（分段编号，如 `10.12.6`） */
  coord: string;
  /** 坐标标题（取自路线图那一行；路线图缺失时用调用方给的一句） */
  title: string;
  /** 归档时刻，形如 `2026-09-14 18:40` */
  at: string;
  /** 前后区别（**必须基于 git diff 或验证结果**——ROADMAP 10.12.9 的口径） */
  changes: string;
  /** 这一步的意义（改变了什么） */
  meaning: string;
  /** 影响面（牵动了哪些模块 / 谁会受影响） */
  impact: string;
  /** 遗留（可选，空则整行不写） */
  leftover?: string | undefined;
  /** 验证证据（可选）——10.12.9 未落地前由模型自陈，故非必填；有则记下 */
  evidence?: string | undefined;
}

/**
 * 把任意文本压成单行（换行/多空格 → 一个空格，两端 trim）。
 * 不是为了好看：四段各占一行是这段档案的形状契约，放任换行会把一节撑成一团、
 * 也让"哪一段被跳过了"看不出来。与 `eventlog/store.ts` 的 `opt()` 同一手法。
 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 渲染 DEVLOG 的一节（调用方负责 append）。
 * 形状：`## <编号> · <标题>（<时刻>）` + 四段（+可选证据），**末尾含一个空行**
 * 当节间隔 —— 所以本函数的返回值**就是文件里那一段**，append 只需直接拼接。
 */
export function renderDevlogEntry(a: ArchiveInput): string {
  const lines: string[] = [`## ${a.coord} · ${oneLine(a.title)}（${a.at}）`, ''];
  lines.push(`**前后区别**：${oneLine(a.changes)}`);
  lines.push(`**意义**：${oneLine(a.meaning)}`);
  lines.push(`**影响面**：${oneLine(a.impact)}`);
  const leftover = oneLine(a.leftover ?? '');
  if (leftover !== '') lines.push(`**遗留**：${leftover}`);
  const evidence = oneLine(a.evidence ?? '');
  if (evidence !== '') lines.push(`**验证证据**：${evidence}`);
  return `${lines.join('\n')}\n\n`;
}

/** 归档回执要报告的东西（都由调用方（工具）实测后填入，本模块只排版） */
export interface ArchiveOutcome {
  coord: string;
  title: string;
  devlogPath: string;
  /** null = 本目录没有 `.flint/ROADMAP.md`（状态没地方推进，但归档照做） */
  roadmapPath: string | null;
  /** null = 事件已入档；否则是写失败的原因（决定本身仍有效，只是没进磁盘档案） */
  eventWarn: string | null;
  /** 提议的下一坐标（`nextCoord` 的结果），提不出来为 null */
  next: { id: string; title: string } | null;
  /** 提不出下一坐标时的解释：被依赖卡住的未开始叶子（最多工具层给几条） */
  blocked: Array<{ id: string; missing: string[] }>;
  /**
   * 表里的依赖环（`findCycles` 的结果，闭合代表路径）。非空 = 死锁，必须点名：
   * 它与 `blocked` 的长相都是"提不出下一坐标"，但**性质不同**——`blocked` 是"等做完了自然就通了"，
   * 环是"再等也不会通，得人去改表"。混在一起报，模型会以为干等就行。
   */
  cycles: string[][];
  /** 还有几个未完成的叶子坐标（工具层实测） */
  remainingLeaves: number;
}

/**
 * 渲染归档回执（工具的返回值正文）。
 *
 * 为什么回执里要**主动提议下一坐标**：协议的四阶段是闭环（归档 → 提议下一坐标），
 * 但"提议"这件事如果只写进提示词，就会退化成"模型记得就问、忘了就断链"。由工具
 * **在归档那一刻顺带算出来**（纯依赖关系 + 编号序，是输入的函数、不是判断），
 * 就把这一步从"要记得"变成"躲不掉"。选择哪一条仍是模型与用户的事。
 */
export function formatArchiveReceipt(o: ArchiveOutcome): string {
  const lines: string[] = [`已归档坐标 ${o.coord} · ${oneLine(o.title)}`];
  lines.push(`- 开发日志：${o.devlogPath}（追加 1 节，只追加不覆盖）`);
  if (o.roadmapPath !== null) {
    lines.push(`- 路线图：${o.coord} → 已完成（${o.roadmapPath}）`);
  } else {
    lines.push(`- 路线图：本目录没有 .flint/ROADMAP.md —— 状态没地方推进（归档仍已写入）`);
  }
  lines.push(o.eventWarn === null
    ? `- 事件库：已记一条 system 事件（机读四段，可用 search_events 检索）`
    : `- 事件库：写入失败（${o.eventWarn}）—— 归档本身仍有效，只是这份没进磁盘档案`);
  lines.push(`- 剩余未完成叶子坐标：${o.remainingLeaves} 个`);

  // 没路线图就没有"下一步"可言——不提"表里没有未开始坐标"那句，那会让人以为表存在
  if (o.roadmapPath === null) {
    lines.push(`[下一坐标] 无法提议：本目录没有 .flint/ROADMAP.md（先按协议立项再走这一步）`);
    return lines.join('\n');
  }
  // 环先单独点出来：它与"被依赖卡住"在回执里长得像，但二者性质不同——前者**再等也不会通**、
  // 只有人去改表才能解；不单列就会被读成"等前面做完自然轮到它"，而那是死锁最容易被放过去的方式
  if (o.cycles.length > 0) {
    const detail = o.cycles.map((c) => c.join(' → ')).join('；');
    lines.push(`[依赖环] ${o.cycles.length} 个环：环上的坐标永远不会满足依赖（需人工打破——删一条依赖或改指向）—— ${detail}`);
  }
  if (o.next !== null) {
    lines.push(`[下一坐标] ${o.next.id} · ${oneLine(o.next.title)} —— 依赖已满足，可以开工`);
  } else {
    const why: string[] = [];
    if (o.cycles.length > 0) why.push(`${o.cycles.length} 个依赖环（见上，先打破环）`);
    if (o.blocked.length > 0) {
      why.push(`被依赖卡住：${o.blocked.map((b) => `${b.id} 等 ${b.missing.join('、')}`).join('；')}`);
    }
    lines.push(why.length > 0
      ? `[下一坐标] 提不出来 —— ${why.join('；')}`
      : `[下一坐标] 提不出来：表里已没有未开始的叶子坐标（要么做完了，要么都在进行中 / 搁置）`);
  }
  return lines.join('\n');
}

/** 归档时刻的文本（`2026-09-14 18:40`）—— 由调用方传 Date，本模块不取系统时间 */
export function formatStamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + ` ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
