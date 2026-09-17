/**
 * todo 工具 + TaskStore 的功能专套 —— 任务清单 C 方案（工具做接口、文件做持久层）。
 *
 * 背景：改造前是"文件即状态"——模型用 `write` 维护 TASK.md（全量重抄），harness 用**一个正则**
 *       数复选框。三个真实弱点：① 改一个勾要重抄整份清单；② "结构"只是正则，没有 id/顺序/唯一进行中；
 *       ③ 模型谎报完成不留痕（那次更新不经过工具）。
 * 现在：**真相源 = 内存里的 TaskStore**（本套的 ①② 段）；`todo` 工具只做**增量**变更（⑤ 段）；
 *       TASK.md 降级为**投影 + 启动种子**（④ 段）；runtime 注入与预算判定改读 store（⑥ 段）。
 *
 * 三段承重设计（改代码前请先读，别"顺手补全"）：
 *   ① **render 与 parse 必须严格互逆**（② 段属性测试钉死）。写盘用 render、启动读盘用 parse，
 *      两者不互逆则"重启一次漂一次"。同一手法在 `Log/` 的生成区已用过（`syncText` 一份模板同给
 *      写与查）。所以**注入可截断、投影绝不截断**——截一刀就破互逆。
 *   ② **投影是单向往文件**，运行期绝不回读（⑥ 段源码断言）。否则 store 与文件成了两处判定，
 *      迟早漂移——正是旧注释里担心的"两处正则漂移"的同构病。
 *   ③ **`hasUnchecked` 与 `hasUncheckedTask(render())` 必须恒等**（③ 段）。前者是结构化判定
 *      （taskStore 用来决定预算/注入），后者是文本判定（system-prompt 用来加续传提示）。
 *      两处判定若分家，会出现"注入了清单却没有续传提示"这类静默错位。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-todo.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { TASK_HISTORY_FILE, TaskStore, depthsOf, formatDuration, itemDuration, taskStore } from '../src/todo/store.js';
import { hasUncheckedTask } from '../src/context/system-prompt.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { SpanCollectorImpl } from '../src/runtime/span-collector.js';
import { EventStream } from '../src/runtime/event-stream.js';
import { activate as activateTasks } from '../src/commands/builtin/tasks.js';

/* ── 断言 ── */

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-verify-todo-'));
const P = (name: string): string => path.join(tmpDir, name);

/** 把内容写进临时目录并返回路径（给"手写 TASK.md / 归档文件"那类用例用） */
function writeTemp(name: string, content: string): string {
  const p = P(name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/**
 * 假时钟：`tick(ms)` 推着走。耗时类断言**必须**能确定性复现 ——
 * 用真实 `Date.now()` 只能断言"大概差几百毫秒"，那种断言迟早变 flaky。
 */
function clockOf(start = 1_700_000_000_000): { now: () => number; tick: (ms: number) => void } {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

/** 只取参与互逆的**结构字段**（时间戳刻意不投影，见 ② 段的口径与 B8 的完备性断言） */
const struct = (items: Array<Record<string, unknown>>): string =>
  JSON.stringify(items.map(({ text, status, parent, after }) => ({ text, status, parent, after })));
const structOf = (s: TaskStore): string => struct(s.list() as unknown as Array<Record<string, unknown>>);

/* ══════════════════════════════════════════════════════════════════════════
   ① TaskStore 基本操作与不变量
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n① TaskStore 操作与不变量');

{
  const s = new TaskStore();
  check('A1 新 store 为空', s.isEmpty() && s.counts().total === 0 && !s.hasUnchecked());

  check('A2 add 返回 1 基序号（1/2/3）',
    s.add('读目录').kind === 'added' && s.add('改代码').kind === 'added'
    && s.add('跑验证').kind === 'added' && s.counts().total === 3);
  check('A3 新项状态是 pending', s.list().every((i) => i.status === 'pending'));
  check('A4 add 空白文本 → empty-text 且不入列',
    s.add('   ').kind === 'empty-text' && s.counts().total === 3);
  check('A5 add 规整空白（换行/多空格 → 单空格 + trim）',
    (() => { const t = new TaskStore(); t.add('  改  a\nb  '); return t.list()[0].text === '改 a b'; })());

  check('A6 start(2) 把第 2 项置为 active',
    s.start(2).kind === 'started' && s.list()[1].status === 'active');
  s.start(3);
  check('A7 唯一 active 不变量：start(3) 后第 2 项降回 pending',
    s.list()[1].status === 'pending' && s.list()[2].status === 'active');

  check('A8 done(1) 置为 done', s.done(1) === true && s.list()[0].status === 'done');
  check('A9 越界 start → out-of-range（0 / 超界 / 小数都不接受）；done 仍返 false',
    s.start(0).kind === 'out-of-range' && s.done(0) === false
    && s.start(4).kind === 'out-of-range' && s.done(9) === false && s.done(1.5) === false);

  const c = s.counts();
  check('A10 counts 分类正确（1 done / 1 active / 1 pending / 共 3）',
    c.total === 3 && c.done === 1 && c.active === 1 && c.pending === 1, JSON.stringify(c));

  const snap = s.list();
  snap[0].text = '被外部改掉';
  snap.push({ text: '幽灵项', status: 'pending', parent: 0, after: null, createdAt: null, startedAt: null, doneAt: null });
  check('A11 list() 是防御性拷贝（改返回值不影响 store 内部）',
    s.list()[0].text !== '被外部改掉' && s.counts().total === 3);

  s.clear();
  check('A12 clear 清空', s.isEmpty() && s.counts().total === 0);
}

/* ── ①b 层级与依赖（10.3.1 / 10.3.2） ── */

{
  const s = new TaskStore();
  check('A13 add(text, parent, after) 把层级与依赖记在项上（0 = 不设；after 存 null）',
    (() => {
      s.add('根');
      s.add('子', 1);
      s.add('孙', 2);
      s.add('有依赖', 0, 2);
      const l = s.list();
      return l[1].parent === 1 && l[2].parent === 2 && l[3].parent === 0 && l[3].after === 2
        && l[0].parent === 0 && l[0].after === null;
    })());
  check('A14 add 的 parent 不存在 → bad-parent，且**不入列**（状态一字未动）',
    (() => { const r = s.add('x', 9); return r.kind === 'bad-parent' && r.parent === 9 && s.counts().total === 4; })());
  check('A15 add 的 after 不存在 → bad-after，且不入列',
    (() => { const r = s.add('x', 0, 9); return r.kind === 'bad-after' && r.after === 9 && s.counts().total === 4; })());
  check('A16 依赖只许指向**更早**的项 ⇒ 不可能成环、层级计算不发散',
    (() => {
      // 能指向的只有"已存在"的项，而新项总在最后 → 引用恒为向过去
      const t = new TaskStore();
      for (let i = 0; i < 12; i++) t.add(`第 ${i + 1} 项`, i === 0 ? 0 : i, i % 3 === 0 ? 0 : i);
      const d = depthsOf(t.list());
      return d.every((n, i) => i === 0 ? n === 0 : n === d[t.list()[i].parent - 1] + 1);
    })());

  check('A17 start 被未完成前置挡住 → blocked（带 by/byText），且**状态一行未动**',
    (() => {
      const t = new TaskStore();
      t.add('甲'); t.add('乙', 0, 1);
      const r = t.start(2);
      return r.kind === 'blocked' && r.by === 1 && r.byText === '甲'
        && t.list().every((i) => i.status === 'pending');
    })());
  check('A18 前置完成后 start 放行', (() => {
    const t = new TaskStore();
    t.add('甲'); t.add('乙', 0, 1);
    t.start(2); t.start(1); t.done(1);
    const r = t.start(2);
    return r.kind === 'started' && t.list()[1].status === 'active';
  })());
  check('A19 done **不**受依赖约束（完成是事实陈述，拦住只会把模型卡死）', (() => {
    const t = new TaskStore();
    t.add('甲'); t.add('乙', 0, 1);
    return t.done(2) === true && t.list()[1].status === 'done';
  })());
  check('A20 前置缺失（理论上不可达）按已满足处理（fail-open，不锁死清单）', (() => {
    const t = new TaskStore();
    t.add('甲');
    // 手工构造一条指向不存在项的依赖 —— 只有手写文件/手工构造能造出来
    t.loadFromFile(writeTemp('missing-dep.md', '- [ ] 甲\n- [ ] 乙 ←7'));
    return t.start(2).kind === 'started';
  })());
}

/* ── ①c 时间戳与耗时（10.3.4） ── */

{
  const clk = clockOf();
  const s = new TaskStore(clk.now);
  s.add('甲'); clk.tick(5000); s.add('乙');
  check('A21 add 记 createdAt', s.list().every((i) => i.createdAt === 1_700_000_000_000 || i.createdAt === 1_700_000_005_000));
  clk.tick(10_000); s.start(1);
  check('A22 start 记 startedAt；重复 start 不重记（进行中不刷新起点）',
    s.list()[0].startedAt === 1_700_000_015_000
    && (() => { clk.tick(1000); s.start(1); return s.list()[0].startedAt === 1_700_000_015_000; })());
  check('A23 被降回 pending 的项**不动** startedAt（展示口径按状态判，不抹掉事实）',
    (() => { clk.tick(1000); s.start(2); return s.list()[0].startedAt === 1_700_000_015_000 && s.list()[0].status === 'pending'; })());
  clk.tick(30_000); s.done(1);
  check('A24 done 记 doneAt；重复 done 不改写已完成时刻（那是历史）',
    s.list()[0].doneAt === 1_700_000_047_000
    && (() => { clk.tick(9999); s.done(1); return s.list()[0].doneAt === 1_700_000_047_000; })());
  check('A25 从 done 重新 start（回退意图）→ doneAt 清空、startedAt 重记为**新一次尝试**',
    (() => {
      clk.tick(1000);
      s.start(1);
      return s.list()[0].doneAt === null && s.list()[0].startedAt === 1_700_000_057_999;
    })());  check('A26 没 start 过就 done → startedAt 仍是 null（耗时不编 0）',
    (() => { const t = new TaskStore(clk.now); t.add('甲'); t.done(1); return t.list()[0].startedAt === null && t.done(1) === true; })());

  check('A27 itemDuration：未开始 → null / 进行中随时间生长 / 完成定格',
    (() => {
      const c = clockOf();
      const t = new TaskStore(c.now);
      t.add('甲'); t.add('乙');
      t.start(1);
      const running = t.list()[0];
      const at0 = itemDuration(running, c.now());
      c.tick(9000);
      const at9 = itemDuration(t.list()[0], c.now());
      t.done(1);
      c.tick(5000);
      const done = itemDuration(t.list()[0], c.now());   // 完成后不再长
      return at0 === 0 && at9 === 9000 && done === 9000
        && itemDuration(t.list()[1], c.now()) === null;
    })());
  check('A28 itemDuration：时钟回拨（end < startedAt）→ null 而不是负数',
    (() => {
      const t = new TaskStore();
      t.add('甲'); t.start(1);
      return itemDuration(t.list()[0], 1) === null;
    })());
  check('A29 formatDuration 四档 + 负值按 0',
    formatDuration(0) === '0s' && formatDuration(900) === '1s' && formatDuration(59_400) === '59s'
    && formatDuration(150_000) === '2m30s' && formatDuration(3_900_000) === '1h05m'
    && formatDuration(-5) === '0s', `${formatDuration(150_000)} / ${formatDuration(3_900_000)}`);
  check('A30 spanOf：整份跨度 = 最后一个完成 − 最早一个登记；缺时刻 → null',
    (() => {
      const c = clockOf();
      const t = new TaskStore(c.now);
      t.add('甲'); c.tick(60_000); t.add('乙');
      t.start(1); t.done(1); t.start(2); c.tick(30_000); t.done(2);
      const span = TaskStore.spanOf(t.list());
      return span === 90_000 && TaskStore.spanOf(TaskStore.fromMarkdown('- [x] 旧').list()) === null;
    })());
}

/* ══════════════════════════════════════════════════════════════════════════
   ② render / parse 互逆（投影与种子是一对逆运算）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n② render 与 parse 严格互逆（写盘 / 读盘是一对逆运算）');

{
  const s = new TaskStore();
  s.add('读目录');
  s.add('改 builtin.ts');
  s.add('跑验证');
  s.start(2);
  s.done(3);
  check('B1 render 输出逐字正确（[ ] 未开始 / [>] 进行中 / [x] 完成）',
    s.render() === '- [ ] 读目录\n- [>] 改 builtin.ts\n- [x] 跑验证', JSON.stringify(s.render()));

  const back = TaskStore.fromMarkdown(s.render());
  check('B2 parse(render()) 还原出逐字相同的清单（结构字段）',
    structOf(back) === structOf(s), structOf(back));

  check('B3 空 store：render 是空串、parse 空串得空清单',
    new TaskStore().render() === '' && TaskStore.fromMarkdown('').counts().total === 0);

  /**
   * B8 先立口径再跑属性测试：**参与互逆的字段是白名单**，时间戳刻意不投影。
   * 这条断言防的是"以后给 TaskItem 加了个字段、忘了归类" —— 那时键数对不上，当场变红；
   * 没有它，属性测试（只比白名单里的字段）会把"新增字段一律不落盘"静默放过去。
   */
  const sample = new TaskStore();
  sample.add('x');
  const keys = Object.keys(sample.list()[0]).sort();
  const structKeys = ['after', 'parent', 'status', 'text'];
  const timeKeys = ['createdAt', 'doneAt', 'startedAt'];
  check('B8 字段归类完备：TaskItem 的键 = 结构字段（参与互逆）∪ 时间戳（刻意不投影）',
    JSON.stringify(keys) === JSON.stringify([...structKeys, ...timeKeys].sort()),
    keys.join(','));

  // 属性测试：伪随机生成合法状态（含层级与依赖）→ render → parse → 结构必须完全一致
  let seed = 123456789;
  const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  // 字符池**刻意含三个特殊字符**（← 依赖标记 / ⇐ 转义符 / ⤴ 父标记）：
  // 转义方案不拿对抗样本打，就等于没验（同一手法：verify-roadmap 的随机表字符池含 | 与反斜杠）
  const pool = [
    '读目录', '改 a.ts', '跑验证', '修 bug', '写文档', '带 两个  空格',
    '行尾箭头 ←', '混排 ⇐←⤴ 三种', '结尾 ←3', '结尾 ⤴2', '孤立的 ⇐ 单字', '←3',
  ];
  let roundTripOk = 0;
  let treeOk = 0;
  let stableOk = 0;
  for (let iter = 0; iter < 40; iter++) {
    const a = new TaskStore();
    const n = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) {
      // 随机挂父项与依赖（只指向已存在的项 —— 与 add 的校验同一口径）
      const parent = i > 0 && rnd() < 0.5 ? 1 + Math.floor(rnd() * i) : 0;
      const after = i > 0 && rnd() < 0.4 ? 1 + Math.floor(rnd() * i) : 0;
      a.add(pool[Math.floor(rnd() * pool.length)], parent, after);
    }
    for (let k = 0; k < 3; k++) {
      const idx = 1 + Math.floor(rnd() * a.counts().total);
      a.start(idx); a.done(idx);
    }
    const b = TaskStore.fromMarkdown(a.render());
    if (structOf(b) === structOf(a)) roundTripOk++;
    if (depthsOf(b.list()).join(',') === depthsOf(a.list()).join(',')) treeOk++;
    // 幂等：再走一圈不该继续变形（手写怪缩进归一化之后就该稳住）
    if (structOf(TaskStore.fromMarkdown(b.render())) === structOf(b)) stableOk++;
  }
  check('B4 属性测试：40 组随机状态（含层级/依赖/特殊字符）render→parse 结构一致',
    roundTripOk === 40, `${roundTripOk}/40`);
  check('B5 属性测试附带：层级深度数组也逐项一致（不只看字段，看**树形**）',
    treeOk === 40, `${treeOk}/40`);
  check('B6 属性测试附带：第二轮起幂等（parse∘render 是投影，不来回漂）',
    stableOk === 40, `${stableOk}/40`);

  check('B7 行尾 ` ←N` 标记：依赖落盘可见、读回还原；正文里同形的字串被转义隔开',
    (() => {
      const t = new TaskStore();
      t.add('甲');
      t.add('乙', 0, 1);
      t.add('正文结尾就是 ←1', 0, 0);   // 正文里的 ←1 不是标记
      const md = t.render();
      const r = TaskStore.fromMarkdown(md);
      return md.includes('- [ ] 乙 ←1')
        && r.list()[1].after === 1
        && r.list()[2].after === null && r.list()[2].text === '正文结尾就是 ←1'
        && structOf(r) === structOf(t);
    })());

  check('B9 父标记 ` ⤴N` 按需出现：缩进推得出时不写、推不出时才写（探针实测的层级漂移）',
    (() => {
      const t = new TaskStore();
      t.add('甲'); t.add('乙'); t.add('丙');
      t.add('补在甲下面', 1);           // 位置在乙丙之后 ⇒ 缩进表达不了，必须带标记
      const md = t.render();
      const ok1 = md === '- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n  - [ ] 补在甲下面 ⤴1';
      const r = TaskStore.fromMarkdown(md);
      const ok2 = r.list()[3].parent === 1 && structOf(r) === structOf(t);
      // 对照组：正常按大纲顺序登记（子项紧跟父项）时**一个标记都不加**
      const u = new TaskStore();
      u.add('甲'); u.add('子', 1); u.add('乙');
      return ok1 && ok2 && u.render() === '- [ ] 甲\n  - [ ] 子\n- [ ] 乙';
    })());

  check('B10 转义可逆：正文含 ← / ⇐ / ⤴ 时逐字还原（前缀码，解码唯一）',
    (() => {
      const t = new TaskStore();
      const texts = ['纯箭头 ←', '纯转义符 ⇐', '纯父标记 ⤴', '⇐←所有⇐⇐组合⇐←', '结尾三连 ←←←', '空格结尾 '];
      for (const x of texts) t.add(x);
      const r = TaskStore.fromMarkdown(t.render());
      return r.list().map((i) => i.text).join('|') === texts.map((x) => x.trim()).join('|')
        && r.render() === t.render();     // 渲染也应稳定
    })());

  // 兼容旧 TASK.md 的写法：星号、缩进、带序号前缀、散文行
  const legacy = TaskStore.fromMarkdown([
    '## 目标',
    '把某个功能做完',
    '',
    '- [ ] 1. 第一步',
    '  * [x] 第二步（已完成）',
    '  - [>] 第三步（进行中）',
    '随便一句散文，不是清单',
  ].join('\n'));
  check('B11 兼容旧格式：星号 / 序号前缀都认（散文与标题被跳过）；缩进从 2026-09-17 起**算层级**',
    legacy.counts().total === 3
    && legacy.list()[0].text === '1. 第一步'
    && legacy.list()[1].status === 'done'
    && legacy.list()[2].status === 'active'
    && legacy.list()[1].parent === 1 && legacy.list()[2].parent === 1);

  const multiActive = TaskStore.fromMarkdown('- [>] a\n- [>] b\n  - [>] c');
  check('B12 多 [>] 归一：只保留第一处 active，其余降为 pending（**全局**不变量，不分层）',
    multiActive.list()[0].status === 'active'
    && multiActive.list()[1].status === 'pending'
    && multiActive.list()[2].status === 'pending');

  check('B13 手写文件的怪输入归一：跳级缩进挂到最近祖先、越界/前向标记留在正文里',
    (() => {
      const t = TaskStore.fromMarkdown([
        '- [ ] 第一步',
        '        - [ ] 深缩进无中间层',
        '- [ ] 第二步 ←9',        // 9 越界 → 不认，整段留在正文
        '  - [ ] 合法依赖 ←2',
      ].join('\n'));
      const l = t.list();
      return l[1].parent === 1 && l[1].text === '深缩进无中间层'
        && l[2].after === null && l[2].text === '第二步 ←9'
        && l[3].parent === 3 && l[3].after === 2;
    })());

  check('B14 时间戳刻意不投影：render 里不出现时间、parse 回来一律 null',
    (() => {
      const clk = clockOf();
      const t = new TaskStore(clk.now);
      t.add('甲'); t.start(1); t.done(1);
      const r = TaskStore.fromMarkdown(t.render());
      return !/\d{10,}/.test(t.render())      // 没有 epoch 数字混进投影
        && r.list()[0].createdAt === null && r.list()[0].startedAt === null && r.list()[0].doneAt === null;
    })());
}

/* ══════════════════════════════════════════════════════════════════════════
   ③ 两处"有没有未完成"的判定必须恒等
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n③ hasUnchecked() 与 hasUncheckedTask(render()) 恒等（防两处判定分家）');

{
  const mk = (f: (s: TaskStore) => void): TaskStore => { const s = new TaskStore(); f(s); return s; };
  const scenarios: Array<[string, TaskStore]> = [
    ['空清单', mk(() => {})],
    ['全 pending', mk((s) => { s.add('a'); s.add('b'); })],
    ['有进行中', mk((s) => { s.add('a'); s.add('b'); s.start(2); })],
    ['进行中 + 已完成', mk((s) => { s.add('a'); s.add('b'); s.done(1); s.start(2); })],
    ['全完成', mk((s) => { s.add('a'); s.add('b'); s.done(1); s.done(2); })],
  ];
  let agree = 0;
  for (const [, s] of scenarios) {
    if (s.hasUnchecked() === hasUncheckedTask(s.render())) agree++;
  }
  check('C1 5 个代表性状态下两处判定恒等', agree === 5, `${agree}/5`);

  check('C2 hasUncheckedTask 把 [>]（进行中）算作未完成',
    hasUncheckedTask('- [>] 进行中') === true && hasUncheckedTask('- [x] 完成') === false);
  check('C3 hasUncheckedTask 仍认旧写法（星号 / 缩进）',
    hasUncheckedTask('* [ ] a') === true && hasUncheckedTask('  - [ ] a') === true);
}

/* ══════════════════════════════════════════════════════════════════════════
   ④ 投影（写盘）与种子（读盘）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n④ projectToFile 投影 / loadFromFile 种子');

{
  const s = new TaskStore();
  s.add('甲');
  s.add('乙');
  s.start(2);
  const f1 = P('proj1.md');
  check('D1 有未完成项 → 写盘，内容 = render() + 换行',
    s.projectToFile(f1) === null && fs.existsSync(f1)
    && fs.readFileSync(f1, 'utf-8') === `${s.render()}\n`);

  s.done(1);
  s.done(2);
  check('D2 全完成后 → 删除投影文件（沿用"全勾选即删"，不留僵尸计划）',
    s.projectToFile(f1) === null && !fs.existsSync(f1));

  const s0 = new TaskStore();
  const f0 = P('proj0.md');
  fs.writeFileSync(f0, 'stale\n');
  check('D3 空清单 → 不写、并删除已存在的旧文件',
    s0.projectToFile(f0) === null && !fs.existsSync(f0));

  const s2 = new TaskStore();
  const f2 = P('seed2.md');
  fs.writeFileSync(f2, '- [ ] x\n- [>] y\n- [x] z\n');
  s2.loadFromFile(f2);
  const c2 = s2.counts();
  check('D4 种子：吸收有未完成项的文件，且保留文件',
    c2.total === 3 && c2.pending === 1 && c2.active === 1 && c2.done === 1 && fs.existsSync(f2),
    JSON.stringify(c2));

  const s3 = new TaskStore();
  const f3 = P('seed3.md');
  fs.writeFileSync(f3, '- [x] 全做完了\n- [x] 真的\n');
  s3.loadFromFile(f3);
  check('D5 种子：全勾选文件 → 空清单 + 删除文件（旧清理语义）',
    s3.isEmpty() && !fs.existsSync(f3));

  const s4 = new TaskStore();
  s4.loadFromFile(P('不存在的文件.md'));
  check('D6 种子：文件缺失 → 空清单，不抛', s4.isEmpty());

  const s5 = new TaskStore();
  const f5 = P('seed5.md');
  fs.writeFileSync(f5, '   \n\n');
  s5.loadFromFile(f5);
  check('D7 种子：空白文件 → 空清单', s5.isEmpty());

  // 跨"重启"往返：A 变更 → 投影 → 新 store 读同一文件 → 与 A 相同
  const A = new TaskStore();
  A.add('甲');
  A.add('乙');
  A.add('丙');
  A.start(2);
  A.done(1);
  const fa = P('restart.md');
  A.projectToFile(fa);
  const B = new TaskStore();
  B.loadFromFile(fa);
  check('D8 跨重启往返：投影 → 重新读取 → 结构字段逐字相同（时间戳刻意不落盘）',
    structOf(B) === structOf(A), structOf(B));

  const s6 = new TaskStore();
  const f6 = P('legacy.md');
  fs.writeFileSync(f6, '## 目标\n做完它\n- [ ] 第一步\n- [>] 第二步\n');
  s6.loadFromFile(f6);
  check('D9 种子兼容旧 TASK.md：清单项被吸收、散文标题被丢弃',
    s6.counts().total === 2 && s6.list()[0].text === '第一步');
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑤ todo 工具端到端（真 ToolRegistry + registerBuiltinTools，走 parse 校验）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ todo 工具端到端（增量接口 + 返回值即清单 + 投影）');

{
  // 工具把 TASK.md 写在 cwd —— 切到临时目录，避免污染仓库根
  const cwd0 = process.cwd();
  process.chdir(tmpDir);
  try {
    const store = new TaskStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, store);
    // execute 现在返回结构化 ToolResult；helper 解包出模型可见文本，断言不动
    const todo = async (args: Record<string, unknown>): Promise<string> =>
      (await reg.execute('todo', args)).content;

    check('E1 todo 已注册进 LLMTools（模型看得见）',
      reg.getLLMTools().some((t) => t.function.name === 'todo'));

    const r1 = await todo({ op: 'add', text: '读目录' });
    check('E2 add 返回 [OK] 且回显带序号的清单',
      r1.startsWith('[OK]') && r1.includes('1. [ ] 读目录'), r1.split('\n').slice(0, 2).join(' / '));

    await todo({ op: 'add', text: '改代码' });
    await todo({ op: 'add', text: '跑验证' });
    const r3 = await todo({ op: 'start', index: 2 });
    check('E3 头部计数正确 + start 后第 2 项为进行中',
      r3.includes('3 项：0 完成 / 1 进行中 / 2 待办') && r3.includes('2. [>] 改代码'),
      r3.split('\n')[0]);

    const r4 = await todo({ op: 'done', index: 1 });
    check('E4 done 后第 1 项为完成', r4.includes('1. [x] 读目录'));

    const rDef = await todo({ op: 'done' });   // 缺 index → 默认 1
    check('E5 done 缺 index 时作用于第 1 项（默认 1，语义已文档化）',
      rDef.includes('1. [x] 读目录') && rDef.includes('1 完成 /'), rDef.split('\n')[0]);

    check('E6 每次变更后 TASK.md 反映当前状态（投影生效）',
      fs.existsSync(path.join(tmpDir, 'TASK.md'))
      && fs.readFileSync(path.join(tmpDir, 'TASK.md'), 'utf-8').includes('- [>] 改代码'));

    check('E7 add 缺 text → [INVALID]', (await todo({ op: 'add' })).startsWith('[INVALID]'));
    check('E8 start 越界 → [INVALID] 且说明范围',
      (await todo({ op: 'start', index: 99 })).startsWith('[INVALID]'));
    check('E9 未知 op → [INVALID] 且列出可用操作',
      (await todo({ op: 'frobnicate' })).startsWith('[INVALID]') && (await todo({ op: 'frobnicate' })).includes('add'));
    check('E10 缺 op → [INVALID]（由 parse 拦）', (await todo({})).startsWith('[INVALID]'));
    check('E11 text 传数字 → [INVALID]（spec 类型校验生效，不再 String() 强转）',
      (await todo({ op: 'add', text: 123 })).startsWith('[INVALID]'));
    check('E12 传未知参数 → [INVALID]（parse 拒多余参数）',
      (await todo({ op: 'add', text: 'x', foo: 1 })).startsWith('[INVALID]'));

    const rc = await todo({ op: 'clear' });
    check('E13 clear → 清单清空 + 移除 TASK.md',
      rc.startsWith('[OK]') && !fs.existsSync(path.join(tmpDir, 'TASK.md')) && store.isEmpty());

    // 缺省 store 必须是进程级单例（runtime 也读同一个），否则"工具改了、runtime 看不到"
    const reg2 = new ToolRegistry();
    registerBuiltinTools(reg2);   // 不传第二参
    await reg2.execute('todo', { op: 'add', text: '单例探针' });
    check('E14 不传 store 时作用于共享单例 taskStore（tool 与 runtime 同一份状态）',
      taskStore.counts().total >= 1 && taskStore.list().some((i) => i.text === '单例探针'));
    taskStore.clear();
  } finally {
    process.chdir(cwd0);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑥ 接线与源码防回退（真相源在 store，运行期不回读文件）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 接线证明与源码防回退');

{
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'src/runtime/runtime.ts'), 'utf-8');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src/context/sections/core-section.ts'), 'utf-8');
  const loopSrc = fs.readFileSync(path.join(ROOT, 'src/loop/agent-loop.ts'), 'utf-8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf-8');

  check('F1 runtime 不再有 loadTaskMemory（旧的"文件即状态"入口已删）',
    !runtimeSrc.includes('loadTaskMemory'));
  check('F2 runtime 改读 taskStore（注入 task 层与预算判定同源）',
    runtimeSrc.includes('taskStore.hasUnchecked()') && runtimeSrc.includes('taskStore.render()'));
  check('F3 播种模块用 loadFromFile 做一次性种子，main 启动时调用它（ROADMAP 10.11.1：启动与'
    + ' `/projects --switch` 共用同一份实现，两份实现只会各错一半）',
    /taskStore\.loadFromFile\(TASK_FILE\)/.test(
      fs.readFileSync(path.join(ROOT, 'src/harness/project-context.ts'), 'utf-8'))
    && mainSrc.includes('seedProjectContext()'));
  check('F4 core-section 教的是 todo 工具，不再教"用 write 写 TASK.md"',
    coreSrc.includes('todo op:"add"') && !/用 write 创建 TASK\.md/.test(coreSrc));
  check('F5 agent-loop 收尾提示已从"write 记入 TASK.md"改为"用 todo 更新清单"',
    /用 todo 如实更新清单/.test(loopSrc) && !/用 write 把当前进度/.test(loopSrc));
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑦ 运行期接线（行为证明）：真 Runtime 会把 taskStore 渲进 system 的 task 层
   （⑥ 段是源码断言、钉的是手段；这段直接跑一轮，钉"行为面真的通了"）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑦ Runtime 运行期接线（行为）：taskStore → system 的 task 层');

{
  const cwd0 = process.cwd();
  process.chdir(tmpDir);
  try {
    // 假 LLM：无工具调用、一轮即收尾（原型链上有 stream，见下方说明）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeLlm: any = {
      chat: async () => ({ content: '' }),
      stream: () => {
        const es = new EventStream<{ type: string; [k: string]: unknown }>(
          (e) => e.type === 'end',
          (e) => e as { type: 'end'; fullText: string },
        );
        queueMicrotask(() => {
          es.push({ type: 'token', text: 'ok' });
          es.push({ type: 'end', fullText: 'ok' });
        });
        return es;
      },
    };
    // 假 session：记录落盘但不参与断言
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session: any = { getMessages: async () => [], appendMessage: async () => {}, clear: async () => {} };
    // 关键探针：假 systemPromptService 把收到的 ctx 记下来
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastCtx: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sysPrompt: any = {
      build: async (ctx: unknown) => {
        lastCtx = ctx;
        return { messages: [{ layer: 'core', content: 'x' }] };
      },
    };
    const rt = new Runtime({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      llm: fakeLlm as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: session as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: '' }), register: () => {} } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skills: { load: () => {}, getAll: () => [], get: () => undefined } as any,
      events: new PromptEventEmitter(),
      spanCollector: new SpanCollectorImpl(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commandSystem: { register: () => {}, list: () => [], execute: async () => null } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      diagnosticsService: { record: () => {}, getAll: () => [] } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compaction: { maybeCompact: async (h: unknown) => ({ history: h }) } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      systemPromptService: sysPrompt as any,
    });

    taskStore.clear();
    await rt.prompt('随便说点什么');
    check('G1 空清单：Runtime 不注入 task 层（ctx.task 为 undefined）', lastCtx?.task === undefined);

    taskStore.add('第一步');
    taskStore.add('第二步');
    await rt.prompt('继续');
    check('G2 有未完成项：ctx.task 正是 taskStore.render() 的渲染结果',
      typeof lastCtx?.task === 'string'
      && lastCtx.task.includes('- [ ] 第一步') && lastCtx.task.includes('- [ ] 第二步'),
      JSON.stringify(lastCtx?.task));

    taskStore.start(1);
    taskStore.done(2);
    taskStore.done(1);
    await rt.prompt('再继续');
    check('G3 全部完成：不再注入 task 层（hasUnchecked 为假，预算/续传提示同步关闭）', lastCtx?.task === undefined);

    taskStore.clear();
  } finally {
    process.chdir(cwd0);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑧ 展示层的两根支柱：变更通知 + 最近一份快照
   （面板本身是 UI，渲染测试在 verify-ui.ts；这里钉的是"面板赖以成立的数据与契约"：
     没通知 → 模型勾完一项屏幕不动；没快照 → 面板收起后上一轮再也查不到）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑧ 展示层支撑：onChange 通知 / 最近一份快照 / /tasks 命令');

{
  const s = new TaskStore();
  let n = 0;
  const off = s.onChange(() => { n++; });

  check('H1 订阅本身不触发通知', n === 0);
  s.add('a');
  check('H2 add 触发一次', n === 1);
  s.start(1);
  check('H3 start 触发', n === 2);
  s.done(1);
  check('H4 done 触发', n === 3);
  s.add('');
  check('H5 被拒绝的 add（空文本）不触发 —— 状态没变就不该让 UI 重绘', n === 3);
  s.start(99);
  check('H6 越界 start 不触发', n === 3);
  s.done(99);
  check('H7 越界 done 不触发', n === 3);
  s.clear();
  check('H8 clear 触发', n === 4);
  s.clear();
  check('H9 空清单再 clear 不触发（无变化）', n === 4);
  off();
  s.add('b');
  check('H10 退订后不再触发（TreeUI.stop 靠它防监听器泄漏）', n === 4);
}

{
  const s = new TaskStore();
  check('H11 从未完成过时 lastCompleted() 为 null', s.lastCompleted() === null);
  s.add('一');
  s.add('二');
  s.done(1);
  check('H12 只完成一部分时不记录 —— 那还不叫"已完成"', s.lastCompleted() === null);
  s.done(2);
  const snap = s.lastCompleted();
  check('H13 最后一项完成的那一刻记下快照',
    snap !== null && snap.length === 2 && snap.every((i) => i.status === 'done'));
  s.clear();
  check('H14 clear 之后快照仍在 —— 这正是它存在的理由', s.lastCompleted()?.length === 2);

  const copy = s.lastCompleted()!;
  copy[0].text = '被外部改了';
  check('H15 lastCompleted() 是防御性拷贝（改返回值不污染 store）',
    s.lastCompleted()![0].text === '一');
}

{
  const s = new TaskStore();
  s.add('甲');
  s.start(1);
  check('H16 renderItems(无序号) 与 render() 逐字相同（排版只有一处实现）',
    TaskStore.renderItems(s.list()) === s.render());
  check('H17 renderItems(带序号) 与 renderNumbered() 逐字相同',
    TaskStore.renderItems(s.list(), true) === s.renderNumbered());
}

{
  taskStore.reset();
  // 假 runtime：只截获注册动作，把 handler 拿出来直接调（不必真起一个 Runtime）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reg: { name: string; desc: string; fn: () => string } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activateTasks({ registerCommand: (name: string, desc: string, fn: () => string) => { reg = { name, desc, fn }; } } as any);

  check('H18 /tasks 已注册（loader 自动扫描 builtin/ 目录）', reg?.name === 'tasks');
  check('H19 空清单且无历史：如实说没有', (reg?.fn() ?? '').includes('没有进行中的任务'));

  taskStore.add('步骤一');
  taskStore.add('步骤二');
  taskStore.done(1);
  const cur = reg!.fn();
  check('H20 有清单时显示当前（含项数、完成记号、待办空框）',
    cur.includes('2 项') && cur.includes('✓') && cur.includes('☐'), cur);

  taskStore.done(2);
  taskStore.clear();
  const after = reg!.fn();
  check('H21 清空后回看最近一份已完成的清单',
    after.includes('最近一份已完成') && after.includes('步骤一') && after.includes('步骤二'), after);
  check('H22 回看的那一份全部是已完成记号（没有残留空框）', !after.includes('☐'), after);

  // ── 历史归档（2026-09-13 用户反馈：/tasks 要能看到历史清单与时间戳） ──
  // 归档文件写在 cwd（与 TASK.md 同目录）——切到临时目录，避免污染仓库根
  const cwdH = process.cwd();
  process.chdir(tmpDir);
  try {
    taskStore.reset();
    const histPath = path.join(tmpDir, TASK_HISTORY_FILE);
    const s = new TaskStore();
    s.add('归档甲');
    s.add('归档乙');
    check('H23 没有待归档时 archiveToFile 是 no-op（不创建文件）',
      s.archiveToFile(TASK_HISTORY_FILE) === null && !fs.existsSync(histPath));
    s.done(1);
    check('H24 只完成一部分时不产生归档（半途而废的不叫"已完成"）',
      !fs.existsSync(histPath));
    s.done(2);
    check('H25 全完成产生待归档，archiveToFile 落盘成功',
      s.archiveToFile(TASK_HISTORY_FILE) === null && fs.existsSync(histPath));
    check('H26 归档即消费：重复调用不追加重复条目',
      s.archiveToFile(TASK_HISTORY_FILE) === null
      && TaskStore.readHistory(histPath).length === 1);
    const h = TaskStore.readHistory(histPath);
    check('H27 回读的时间戳形如 YYYY-MM-DD HH:mm',
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(h[0]?.at ?? ''), h[0]?.at);
    check('H28 回读条目与完成清单逐项一致（文本 + 全 done 状态）',
      h[0]?.items.length === 2
      && h[0].items.every((i) => i.status === 'done' && i.text.startsWith('归档')));
    check('H29 读不存在的历史文件 → 空数组不炸', TaskStore.readHistory(path.join(tmpDir, '没有.md')).length === 0);

    // /tasks 回看历史（真 handler，cwd 已在临时目录；store 已 reset → 走历史分支）
    const hist = reg!.fn();
    check('H30 /tasks 无当前清单时展示历史完成记录（时间戳行 + 条目名）',
      hist.includes('历史完成记录') && /\d{4}-\d{2}-\d{2} \d{2}:\d{2} 完成/.test(hist)
      && hist.includes('归档甲') && hist.includes('归档乙'), hist);
  } finally {
    process.chdir(cwdH);
    taskStore.reset();
  }

  taskStore.reset();
}

/* ── 清理与汇总 ── */

fs.rmSync(tmpDir, { recursive: true, force: true });
check('Z1 临时目录已清理', !fs.existsSync(tmpDir));

// 结果行格式是 run-verify.mjs 的解析契约（/结果[：:]\s*(\d+)\s*通过.../），别改成自由文案
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
