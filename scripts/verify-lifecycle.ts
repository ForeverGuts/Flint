/**
 * verify-lifecycle.ts —— 项目生命周期协议：**归档侧**（ROADMAP P10.12.5 / 10.12.6 / 10.12.8 / 10.12.11）
 *
 * 为什么需要它：协议到"归档"这一步之前，DEVLOG 与路线图状态全靠**模型自己记得写**——
 * 日志写了、状态忘了改，没人会喊。这套断言把三件事钉成一件：DEVLOG 追加、事件双写、
 * 路线图状态推进 + 提议下一坐标，全由 archive 工具一次做完。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 路径常量 —— 四份文档同住 cwd/.flint/
 *   ② DEVLOG 排版 —— 形状固定四段、空段不写空标题、多行压单行（纯函数层）
 *   ③ 表切片 —— `findCoordTable` 与 `parseRoadmap` 口径一致、`spliceCoordTable`
 *      **只换表那几行**（表外散文逐字保留，这是"原地改"与"重写整份文件"的分水岭）
 *   ④ 状态推进 —— `setStatus` 不可变、`resolveStatuses` 落盘的是权威状态
 *   ⑤ 提议下一坐标与依赖环 —— 只有"未开始 + 叶子 + 依赖已完成"才被提议；父坐标是容器不算工作；
 *      环是**死锁**（`findCycles`）：格式层不拦、回执层点名，否则"提不出下一坐标"会被读成"活干完了"
 *   ⑥ 现状快照 —— `clipSnapshot` / `readProjectSnapshot` 的四种"没有"与截断
 *   ⑦ 行为 —— 真 `ToolRegistry` 跑 archive：双写落到哪、回执说什么、追加不重复写头、有环时点名
 *   ⑧ 拒绝路径 —— 编号不存在 / 父坐标 / 路线图格式坏 → [INVALID] 且**一字不落盘**
 *   ⑨ 源码守护 —— 纯模块零依赖、archive 不走权限弹窗、runtime 不 import io
 *   ⑩ 提示词交叉比对 —— 工具名与 DoD 四要素必须在 core-section 里（两边分家则门禁形同虚设）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-lifecycle.ts
 * 退出码：failed > 0 → 1
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { TaskStore } from '../src/todo/store.js';
import { MemoryStore } from '../src/memory/store.js';
import { EventStore } from '../src/eventlog/store.js';
import { DEVLOG_FILE, PROJECT_FILE } from '../src/project/charter.js';
import {
  COLUMNS, ROADMAP_FILE, compareId, findCoordTable, findCycles, nextCoord, parseRoadmap, renderRoadmap,
  resolveStatuses, setStatus, spliceCoordTable, unmetDeps, type Coord,
} from '../src/project/roadmap.js';
import { DEVLOG_HEADER, formatArchiveReceipt, formatStamp, renderDevlogEntry } from '../src/project/lifecycle.js';
import { SNAPSHOT_MAX, clipSnapshot, readProjectSnapshot } from '../src/project/snapshot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 造一个坐标对象（默认叶子、未开始、无依赖） */
function coord(id: string, over: Partial<Coord> = {}): Coord {
  return { id, title: `坐标 ${id}`, status: '未开始', klass: '轻量', deps: [], ...over };
}

/** 一份带**表外散文**的路线图（切片测试要靠它证明"表外一行没动"） */
const PROSE_HEAD = '> 表外散文：切片时一行都不许动。';
const PROSE_TAIL = '这一段在表外，归档只改表那几行。';
function roadmapDoc(rows: string[]): string {
  return [
    '# 项目路线图', '', PROSE_HEAD, '', '## 坐标表', '',
    `| ${COLUMNS.join(' | ')} |`, `|${COLUMNS.map(() => '---').join('|')}|`, ...rows, '',
    '## 备注', '', PROSE_TAIL, '',
  ].join('\n');
}
const BASE_ROWS = [
  '| 1 | 一组 | 未开始 | 系统 | — |',
  '| 1.1 | 甲 | 已完成 | 轻量 | — |',
  '| 1.2 | 乙 | 未开始 | 轻量 | 1.1 |',
  '| 1.3 | 丙 | 未开始 | 轻量 | — |',
];

/* ── ① 路径常量 ── */
console.log('── ① 路径常量 ──');

check('A1 路线图落点是 .flint/ROADMAP.md', ROADMAP_FILE === '.flint/ROADMAP.md', ROADMAP_FILE);
check('A2 开发日志落点是 .flint/DEVLOG.md', DEVLOG_FILE === '.flint/DEVLOG.md', DEVLOG_FILE);
check('A3 现状快照落点是 .flint/PROJECT.md', PROJECT_FILE === '.flint/PROJECT.md', PROJECT_FILE);
check('A4 四份文档同住项目级隐藏目录（都带 .flint/ 前缀）',
  [ROADMAP_FILE, DEVLOG_FILE, PROJECT_FILE].every((p) => p.startsWith('.flint/')));
check('A5 DEVLOG 文件头写明"只追加"与四段',
  DEVLOG_HEADER.includes('只追加') && DEVLOG_HEADER.includes('前后区别') && DEVLOG_HEADER.includes('遗留'));

/* ── ② DEVLOG 排版 ── */
console.log('── ② DEVLOG 排版 ──');

const fullEntry = renderDevlogEntry({
  coord: '1.2', title: '乙', at: '2026-09-14 18:40',
  changes: '新增 A', meaning: '让 B 不再靠自觉', impact: 'tools +1',
  leftover: 'C 还没做', evidence: '84 项 0 失败',
});
const lines = fullEntry.split('\n');

check('B1 标题行形状：## 编号 · 标题（时刻）', lines[0] === '## 1.2 · 乙（2026-09-14 18:40）', lines[0]);
check('B2 三段必填逐字带标签',
  fullEntry.includes('**前后区别**：新增 A') && fullEntry.includes('**意义**：让 B 不再靠自觉')
  && fullEntry.includes('**影响面**：tools +1'));
check('B3 有 leftover 时写"**遗留**："行', fullEntry.includes('**遗留**：C 还没做'));
check('B4 有 evidence 时写"**验证证据**："行', fullEntry.includes('**验证证据**：84 项 0 失败'));
check('B5 每段独占一行（标题 + 空行 + 5 段 = 7 行）', fullEntry.trimEnd().split('\n').length === 7, String(fullEntry.trimEnd().split('\n').length));

const lean = renderDevlogEntry({
  coord: '2', title: '丁', at: '2026-09-14 18:41',
  changes: 'x', meaning: 'y', impact: 'z',
});
check('B6 缺 leftover / evidence 时**不写空标题**（写了等于宣告"本该有内容"）',
  !lean.includes('**遗留**') && !lean.includes('**验证证据**'));
check('B7 可选段留空串等同于缺省（空串也整行不写）',
  !renderDevlogEntry({ coord: '2', title: '丁', at: 't', changes: 'x', meaning: 'y', impact: 'z', leftover: '', evidence: '' }).includes('**遗留**'));

const messy = renderDevlogEntry({
  coord: '3', title: '多\n行  标题', at: 't',
  changes: '第一行\n第二行', meaning: '  a    b  ', impact: 'x',
});
check('B8 多行输入被压成单行（形状契约：四段各占一行）', messy.split('\n')[0] === '## 3 · 多 行 标题（t）', messy.split('\n')[0]);
check('B9 段内多余空白被压缩', messy.includes('**前后区别**：第一行 第二行') && messy.includes('**意义**：a b'));
check('B10 末尾留空行（append 时与下一节分开）', fullEntry.endsWith('\n\n'), JSON.stringify(fullEntry.slice(-4)));

const stamped = formatStamp(new Date(2026, 0, 2, 3, 4));
check('B11 formatStamp 月/日/时/分补零', stamped === '2026-01-02 03:04', stamped);
check('B12 formatStamp 取的是传入的时刻（纯函数，不读系统时间）',
  formatStamp(new Date(2030, 11, 31, 23, 59)) === '2030-12-31 23:59');

/* ── ③ 表切片 ── */
console.log('── ③ 表切片（只换表那几行）──');

const doc = roadmapDoc(BASE_ROWS);
const range = findCoordTable(doc);
check('C1 找得到坐标表，start 指向表头行（0 基）', range !== null && doc.split('\n')[range.start]?.includes('编号'), JSON.stringify(range));
check('C2 end 指向最后一条数据行（不吃后面的散文）',
  range !== null && doc.split('\n')[range.end]?.trim() === BASE_ROWS[BASE_ROWS.length - 1], JSON.stringify(range));
check('C3 找不到表 → null', findCoordTable('# 没有表\n\n一段散文\n') === null);
check('C4 列名不对的表格不被当成坐标表',
  findCoordTable(['| a | b | c |', '|---|---|---|', '| 1 | 2 | 3 |'].join('\n')) === null);
check('C5 表头后没有分隔行 → 不算表',
  findCoordTable(['| 编号 | 坐标 | 状态 | 类别 | 依赖 |', '| 1 | 甲 | 未开始 | 轻量 | — |'].join('\n')) === null);
check('C6 前面有别的表格时，仍能定位到真正的坐标表',
  (() => {
    const md = ['| a | b |', '|---|---|', '| 1 | 2 |', '', '| 编号 | 坐标 | 状态 | 类别 | 依赖 |', '|---|---|---|---|---|', '| 1 | 甲 | 未开始 | 轻量 | — |'].join('\n');
    const r = findCoordTable(md);
    return r !== null && md.split('\n')[r.start]?.startsWith('| 编号');
  })());

const parsed = parseRoadmap(doc);
check('C7 夹具本身是合法的（四坐标、零错）', parsed.errors.length === 0 && parsed.coords.length === 4, parsed.errors.join('|'));

const spliced = spliceCoordTable(doc, setStatus(parsed.coords, '1.2', '已完成'));
check('C8 切片后**表外散文逐字保留**（头）', spliced.includes(PROSE_HEAD));
check('C9 切片后**表外散文逐字保留**（尾）', spliced.includes(PROSE_TAIL));
check('C10 切片后目标状态确实改了',
  spliced.split('\n').some((l) => l.startsWith('| 1.2 |') && l.includes('已完成')));
check('C11 切片后重新解析零错、且状态是新的', (() => {
  const again = parseRoadmap(spliced);
  return again.errors.length === 0 && again.coords.find((c) => c.id === '1.2')?.status === '已完成';
})());
check('C12 表外行数不变（只动了表区间）',
  doc.split('\n').length === spliced.split('\n').length,
  `${doc.split('\n').length} vs ${spliced.split('\n').length}`);
check('C13 无坐标表时 splice **原样返回**（不凭空造表）', (() => {
  const md = '# 只有散文\n';
  return spliceCoordTable(md, [coord('1')]) === md;
})());
check('C14 splice 会顺手规范化渲染（依赖顺序 / 空格）', (() => {
  const c = [{ id: '1', title: '  甲  ', status: '未开始' as const, klass: '轻量' as const, deps: ['3', '1.2'] }];
  const out = spliceCoordTable(roadmapDoc(['| 1 | x | 未开始 | 轻量 | — |']), c);
  return out.split('\n').some((l) => l === '| 1 | 甲 | 未开始 | 轻量 | 1.2,3 |');
})());

/* ── ④ 状态推进 ── */
console.log('── ④ 状态推进 ──');

const base = [coord('1', { klass: '系统' }), coord('1.1'), coord('1.2')];
const advanced = setStatus(base, '1.1', '已完成');
check('D1 setStatus 改了指定项', advanced[1]?.status === '已完成');
check('D2 setStatus 不动其它项', advanced[0]?.status === '未开始' && advanced[2]?.status === '未开始');
check('D3 setStatus **不改入参**（返回新数组）', base[1]?.status === '未开始');
check('D4 编号不存在 → 内容不变', JSON.stringify(setStatus(base, '9.9', '已完成')) === JSON.stringify(base));

const parentPlaceholder = [coord('1', { klass: '系统' }), coord('1.1', { status: '已完成' }), coord('1.2', { status: '已完成' })];
const resolved = resolveStatuses(parentPlaceholder);
check('D5 落盘的是**权威状态**：父行占位值被换成派生值（全完成 → 已完成）',
  resolved[0]?.status === '已完成', resolved[0]?.status);
check('D6 resolveStatuses 幂等', JSON.stringify(resolveStatuses(resolved)) === JSON.stringify(resolved));
check('D7 显式搁置压过派生', (() => {
  const cs = [coord('1', { status: '搁置', klass: '系统' }), coord('1.1', { status: '已完成' })];
  return resolveStatuses(cs)[0]?.status === '搁置';
})());
check('D8 叶子行用的是它自己写的状态', resolveStatuses([coord('1', { status: '进行中' })])[0]?.status === '进行中');

/* ── ⑤ 提议下一坐标与依赖环 ── */
console.log('── ⑤ 提议下一坐标与依赖环 ──');

const tree = [
  coord('1', { klass: '系统' }),
  coord('1.1', { status: '已完成' }),
  coord('1.2', { deps: ['1.1'] }),
  coord('1.3'),
];
check('E1 提议的是"未开始 + 叶子 + 依赖已完成"的坐标', nextCoord(tree)?.id === '1.2', nextCoord(tree)?.id);
check('E2 按**编号序**取第一个（1.2 先于 1.3）',
  compareId('1.2', '1.3') < 0 && nextCoord(tree)?.id === '1.2');
check('E3 已完成的不再被提议', nextCoord([coord('1', { status: '已完成' })]) === null);
check('E4 搁置的不被提议（等人来解冻，不是"下一步"）', nextCoord([coord('1', { status: '搁置' })]) === null);
check('E5 父坐标不被提议（它只是容器，不是一件可做的工作）',
  nextCoord([coord('1', { klass: '系统' }), coord('1.1', { status: '已完成' }), coord('1.2', { status: '已完成' })]) === null);
check('E6 依赖未完成的叶子不被提议',
  nextCoord([coord('1'), coord('1.1', { status: '进行中' }), coord('1.2', { deps: ['1.1'] })]) === null);
check('E7 依赖是父坐标时看**派生**状态（子全完成 → 依赖已满足）', (() => {
  const cs = [coord('1', { klass: '系统' }), coord('1.1', { status: '已完成' }), coord('2', { deps: ['1'] })];
  return nextCoord(cs)?.id === '2';
})());
check('E8 依赖里既有父也有子时不重复提议（父全完成即满足）', (() => {
  const cs = [coord('1', { klass: '系统' }), coord('1.1', { status: '已完成' }), coord('2', { deps: ['1', '1.1'] })];
  return nextCoord(cs)?.id === '2';
})());
check('E9 全被依赖卡住 → null', nextCoord([coord('1', { status: '进行中' }), coord('2', { deps: ['1'] })]) === null);
check('E10 unmetDeps 给出尚未完成的依赖', unmetDeps(tree, '1.2').length === 0
  && unmetDeps([coord('1', { status: '进行中' }), coord('2', { deps: ['1'] })], '2').join(',') === '1');
check('E11 unmetDeps 编号不存在 → 空数组', unmetDeps(tree, '9.9').length === 0);
check('E12 nextCoord **不改入参**（纯查询）', (() => {
  const cs = [coord('1', { status: '已完成' }), coord('2')];
  const before = JSON.stringify(cs);
  nextCoord(cs);
  return JSON.stringify(cs) === before;
})());

/* ── ⑤b 依赖环检测：环是死锁，必须点名（格式层不拦、回执层报）── */

check('E13 无环 → 空数组', findCycles(tree).length === 0, JSON.stringify(findCycles(tree)));
check('E14 两坐标互相依赖 → 一个环，代表路径闭合且从最小编号打头',
  JSON.stringify(findCycles([coord('1.1', { deps: ['1.2'] }), coord('1.2', { deps: ['1.1'] })]))
  === JSON.stringify([['1.1', '1.2', '1.1']]),
  JSON.stringify(findCycles([coord('1.1', { deps: ['1.2'] }), coord('1.2', { deps: ['1.1'] })])));
check('E15 三元环 → 一条代表路径（首尾闭合）',
  JSON.stringify(findCycles([coord('1', { deps: ['2'] }), coord('2', { deps: ['3'] }), coord('3', { deps: ['1'] })]))
  === JSON.stringify([['1', '2', '3', '1']]));
check('E16 自环也是一元环', (() => {
  const cyc = findCycles([coord('1', { deps: ['1'] })]);
  return cyc.length === 1 && JSON.stringify(cyc[0]) === JSON.stringify(['1', '1']);
})());
check('E17 依赖指向**表外**编号不算环（那是格式错误，不归环检测重复报）',
  findCycles([coord('1', { deps: ['9'] })]).length === 0);
check('E18 环上的坐标**永不被提议**（死锁的判定式本身）',
  nextCoord([coord('1.1', { deps: ['1.2'] }), coord('1.2', { deps: ['1.1'] }), coord('2', { status: '已完成' })]) === null);
check('E19 成环的表在**格式上合法**（parse 不因环报错——两类问题分开管）', (() => {
  const md = roadmapDoc([
    '| 1 | 一组 | 未开始 | 系统 | — |',
    '| 1.1 | 甲 | 未开始 | 轻量 | 1.2 |',
    '| 1.2 | 乙 | 未开始 | 轻量 | 1.1 |',
  ]);
  return parseRoadmap(md).errors.length === 0;
})());
check('E20 两个独立的环都报（找到一个不收工）',
  JSON.stringify(findCycles([
    coord('1.1', { deps: ['1.2'] }), coord('1.2', { deps: ['1.1'] }),
    coord('2.1', { deps: ['2.2'] }), coord('2.2', { deps: ['2.1'] }),
  ])) === JSON.stringify([['1.1', '1.2', '1.1'], ['2.1', '2.2', '2.1']]));
check('E21 输入顺序不影响环的代表路径（归一化真的收敛）',
  JSON.stringify(findCycles([coord('1.2', { deps: ['1.1'] }), coord('1.1', { deps: ['1.2'] })]))
  === JSON.stringify([['1.1', '1.2', '1.1']]));
check('E22 环与"被依赖卡住"能**同时**成立（不是二选一）', (() => {
  const cs = [coord('1.1', { deps: ['1.2'] }), coord('1.2', { deps: ['1.1'] }), coord('3', { deps: ['1.1'] })];
  return findCycles(cs).length === 1 && unmetDeps(cs, '3').join(',') === '1.1';
})());

/* ── ⑥ 现状快照 ── */
console.log('── ⑥ 现状快照（.flint/PROJECT.md 注入侧）──');

check('F1 空串 → undefined（不注入一句空话）', clipSnapshot('') === undefined);
check('F2 纯空白 → undefined', clipSnapshot('  \n\t \n') === undefined);
check('F3 短文本两端 trim 后原样', clipSnapshot('  # 现状\n\n- 模块 A  ') === '# 现状\n\n- 模块 A');
check('F4 恰好等于上限不截断', clipSnapshot('x'.repeat(SNAPSHOT_MAX))?.endsWith('x') === true
  && !(clipSnapshot('x'.repeat(SNAPSHOT_MAX)) ?? '').includes('截断'));
check('F5 超上限被截断且带标记', (() => {
  const out = clipSnapshot('y'.repeat(SNAPSHOT_MAX + 10)) ?? '';
  return out.includes('（截断）') && out.startsWith('y');
})());
check('F6 文件不存在 → undefined', readProjectSnapshot(path.join(ROOT, 'no-such-dir/PROJECT.md')) === undefined);

/* ── ⑦ 行为：真 ToolRegistry 跑 archive ── */
console.log('── ⑦ 行为：archive 工具 ──');

const cwd0 = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-verify-lifecycle-'));
const devlogPath = (): string => path.join(tmpDir, DEVLOG_FILE);
const devlogText = (): string => (fs.existsSync(devlogPath()) ? fs.readFileSync(devlogPath(), 'utf-8') : '');
const seed = (roadmap: string | null): void => {
  fs.rmSync(path.join(tmpDir, '.flint'), { recursive: true, force: true });
  if (roadmap !== null) {
    fs.mkdirSync(path.join(tmpDir, '.flint'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ROADMAP_FILE), roadmap, 'utf-8');
  }
};
const archiveArgs = {
  coord: '1.2', changes: '新增 lifecycle.ts 与 archive 工具', meaning: '让"记得改状态"变成程序必做',
  impact: 'tools 子系统 +1', leftover: '', evidence: '84 项 0 失败',
};

try {
  process.chdir(tmpDir);   // 工具用相对路径（.flint/...），落点靠 cwd

  {
    seed(roadmapDoc(BASE_ROWS));
    const evs = new EventStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), evs);
    const r = await reg.execute('archive', archiveArgs);

    check('G1 归档成功 → [OK]，回执带编号与标题',
      r.status === 'ok' && r.content.includes('已归档坐标 1.2 · 乙'), r.content.slice(0, 80));
    check('G2 DEVLOG 被创建且带文件头', devlogText().startsWith('# 开发日志'));
    check('G3 DEVLOG 含这一节与四段',
      devlogText().includes('## 1.2 · 乙（') && devlogText().includes('**前后区别**：新增 lifecycle.ts 与 archive 工具')
      && devlogText().includes('**验证证据**：84 项 0 失败'));
    check('G4 路线图里该坐标 → 已完成', (() => {
      const after = parseRoadmap(fs.readFileSync(path.join(tmpDir, ROADMAP_FILE), 'utf-8'));
      return after.errors.length === 0 && after.coords.find((c) => c.id === '1.2')?.status === '已完成';
    })());
    check('G5 路线图**表外散文一字未动**', (() => {
      const after = fs.readFileSync(path.join(tmpDir, ROADMAP_FILE), 'utf-8');
      return after.includes(PROSE_HEAD) && after.includes(PROSE_TAIL);
    })());
    check('G6 事件库落一条 kind=system（双写的机读一侧）',
      evs.all().length === 1 && evs.all()[0]?.kind === 'system', JSON.stringify(evs.all().map((e) => e.kind)));
    check('G7 事件四段带着中文标签（人翻档案时看得懂哪段是什么）', (() => {
      const e = evs.all()[0];
      return (e?.context ?? '').startsWith('前后区别：') && (e?.decision ?? '').startsWith('意义：')
        && (e?.reason ?? '').startsWith('影响面：') && (e?.outcome ?? '').includes('验证证据：');
    })(), JSON.stringify(evs.all()[0]));
    check('G8 事件被真的追加落盘（.flint/events.jsonl 有一行）',
      fs.existsSync(path.join(tmpDir, '.flint/events.jsonl'))
      && fs.readFileSync(path.join(tmpDir, '.flint/events.jsonl'), 'utf-8').trim().split('\n').length === 1);
    check('G9 回执**顺带提议下一坐标**（1.3；1.1 已完成、1.2 刚归档）',
      r.content.includes('[下一坐标] 1.3 · 丙'), r.content.slice(-90));
    check('G10 回执报出剩余未完成叶子坐标数', r.content.includes('剩余未完成叶子坐标：1 个'));
    check('G11 事件 tags 便于检索', (evs.all()[0]?.tags ?? []).join(',') === 'archive,1.2');
  }

  {
    // 第二次归档：DEVLOG 必须**追加**，文件头不许重复写
    seed(roadmapDoc(BASE_ROWS));
    const evs = new EventStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), evs);
    await reg.execute('archive', archiveArgs);
    await reg.execute('archive', { ...archiveArgs, coord: '1.3', changes: '改 B' });
    const heads = devlogText().split('\n').filter((l) => l === '# 开发日志').length;
    check('G12 第二次归档是**追加**：文件头只出现一次', heads === 1, String(heads));
    check('G13 两节都在、顺序是归档顺序、节间有空行',
      devlogText().indexOf('## 1.2') < devlogText().indexOf('## 1.3')
      && /\n\n## 1\.3/.test(devlogText()));
    check('G14 两次归档 = 两条事件（不合并、不覆盖）', evs.all().length === 2);
  }

  {
    // 没有路线图：归档照做，但明确说"状态没地方推进"
    seed(null);
    const evs = new EventStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), evs);
    const r = await reg.execute('archive', archiveArgs);
    check('G15 无 .flint/ROADMAP.md 时仍归档（DEVLOG + 事件都写）',
      r.status === 'ok' && devlogText().includes('## 1.2') && evs.all().length === 1);
    check('G16 回执明说状态没推进、无法提议下一坐标',
      r.content.includes('没有 .flint/ROADMAP.md') && r.content.includes('无法提议'), r.content.slice(-110));
  }

  {
    // 表里有依赖环：nextCoord 会静默返回 null，回执必须**点名**，否则被读成"活干完了"
    seed(roadmapDoc([
      '| 1 | 一组 | 未开始 | 系统 | — |',
      '| 1.1 | 甲 | 未开始 | 轻量 | 1.2 |',
      '| 1.2 | 乙 | 未开始 | 轻量 | 1.1 |',
      '| 2 | 丙 | 未开始 | 轻量 | — |',
    ]));
    const evs = new EventStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), evs);
    const r = await reg.execute('archive', { ...archiveArgs, coord: '2', changes: 'x' });
    check('G17 表有环 → 回执点名【依赖环】并给出环路径（模型据此去改表）',
      r.status === 'ok' && r.content.includes('[依赖环]') && r.content.includes('1.1 → 1.2 → 1.1'),
      r.content.slice(-170));
    check('G18 提不出下一坐标时**区分**"卡在环里"与"已做完了"',
      r.content.includes('[下一坐标] 提不出来') && r.content.includes('依赖环')
      && !r.content.includes('已没有未开始的叶子'));
  }

  /* ── ⑧ 拒绝路径（一字不落盘）── */
  console.log('── ⑧ 拒绝路径：一字不落盘 ──');

  {
    seed(roadmapDoc(BASE_ROWS));
    const evs = new EventStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), evs);
    const r = await reg.execute('archive', { ...archiveArgs, coord: '9.9' });
    check('H1 编号不存在 → [INVALID]', r.status === 'invalid' && r.content.startsWith('[INVALID]'));
    check('H2 拒绝时列出表内既有编号（模型据此改口，而不是瞎猜）',
      r.content.includes('1.1') && r.content.includes('1.2') && r.content.includes('1.3'));
    check('H3 拒绝时 DEVLOG **没被创建**', !fs.existsSync(devlogPath()));
    check('H4 拒绝时事件库为空', evs.all().length === 0);
    check('H5 拒绝时路线图**一字未改**',
      fs.readFileSync(path.join(tmpDir, ROADMAP_FILE), 'utf-8') === roadmapDoc(BASE_ROWS));
  }

  {
    seed(roadmapDoc(BASE_ROWS));
    const evs = new EventStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), evs);
    const r = await reg.execute('archive', { ...archiveArgs, coord: '1' });
    check('H6 归档父坐标 → [INVALID]，并点出"状态由子坐标派生"',
      r.status === 'invalid' && r.content.includes('父坐标') && r.content.includes('派生'));
    check('H7 父坐标拒绝时列出它的子坐标，且**一字不落盘**',
      r.content.includes('1.1') && !fs.existsSync(devlogPath()) && evs.all().length === 0);
  }

  {
    // 路线图本身格式坏：门禁不允许在坏表上推进状态
    seed(roadmapDoc(['| 1 | 一组 | 未开始 | 系统 | — |', '| 1.1 | 甲 | 完成了 | 轻量 | — |']));
    const evs = new EventStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), evs);
    const r = await reg.execute('archive', { ...archiveArgs, coord: '1.1' });
    check('H8 路线图格式坏（状态不在枚举内）→ [INVALID] 且引用门禁口径',
      r.status === 'invalid' && r.content.includes('路线图格式有错'), r.content.slice(0, 90));
    check('H9 格式坏时**一字不落盘**（DEVLOG 不存在、事件为空、路线图原文未动）',
      !fs.existsSync(devlogPath()) && evs.all().length === 0
      && parseRoadmap(fs.readFileSync(path.join(tmpDir, ROADMAP_FILE), 'utf-8')).errors.length === 1);
  }

  {
    // 缺必填段：spec 层就该拦下（[INVALID]，不进 handler）
    seed(roadmapDoc(BASE_ROWS));
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), new MemoryStore(), new EventStore());
    const r = await reg.execute('archive', { coord: '1.2', changes: 'x', meaning: 'y' });
    check('H10 缺 impact 被 spec 拦下 → [INVALID]，且没写任何文件', r.status === 'invalid' && !fs.existsSync(devlogPath()));
  }
} finally {
  process.chdir(cwd0);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/* ── ⑨ 源码守护 ── */
console.log('── ⑨ 源码守护 ──');

const roadmapSrc = fs.readFileSync(path.join(ROOT, 'src/project/roadmap.ts'), 'utf8');
const lifecycleSrc = fs.readFileSync(path.join(ROOT, 'src/project/lifecycle.ts'), 'utf8');
const snapshotSrc = fs.readFileSync(path.join(ROOT, 'src/project/snapshot.ts'), 'utf8');
const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf8');
const runtimeSrc = fs.readFileSync(path.join(ROOT, 'src/runtime/runtime.ts'), 'utf8');

check('I1 roadmap.ts 零 import（纯函数模块）', !/^import /m.test(roadmapSrc));
check('I2 lifecycle.ts 零 import（纯函数模块，不碰 fs）',
  !/^import /m.test(lifecycleSrc) && !/writeFileSync|appendFileSync|readFileSync/.test(lifecycleSrc));
check('I3 snapshot.ts 只用 node:fs + 项目内常量',
  /from 'node:fs'/.test(snapshotSrc) && !/node:(path|os|child_process)/.test(snapshotSrc));
check('I4 archive 工具**不**带 requirePermission（系统行为，别每坐标弹一次窗）',
  /name: 'archive',[\s\S]{0,400}?spec: \{/.test(builtinSrc) && !/name: 'archive',[\s\S]{0,300}?requirePermission/.test(builtinSrc));
check('I5 archive 工具不 import io 模块（RPC 启动路径不许被拖进写 stdout 的层）',
  !/^import .*io\//m.test(builtinSrc));
check('I6 runtime.ts 不调 console.log（stdout 纯净规则；io/ 的 UI 构件可导入）',
  !/\bconsole\.log\s*\(/.test(runtimeSrc));
check('I7 runtime 每轮读现状快照（10.12.5 的注入线接上了）',
  /readProjectSnapshot\(\)/.test(runtimeSrc) && /project: projectSnapshot/.test(runtimeSrc));

/* ── ⑩ 提示词交叉比对 ── */
console.log('── ⑩ 与提示词交叉比对 ──');

const coreSrc = fs.readFileSync(path.join(ROOT, 'src/context/sections/core-section.ts'), 'utf8');
check('J1 提示词教用 archive 工具归档（工具名两边一致）', coreSrc.includes('archive 工具'));
check('J2 提示词写明 DoD 四件套与"缺一件不许标完成"',
  coreSrc.includes('四件套') && coreSrc.includes('验证证据') && coreSrc.includes('缺一件不许'));
check('J3 提示词说明 PROJECT.md 每轮注入（模型知道它是自己的视野）',
  coreSrc.includes('PROJECT.md 每轮都会注入'));
check('J4 提示词保留"只追加"与"以本条为准"（DEVLOG 的追加纪律）',
  coreSrc.includes('只追加') && coreSrc.includes('以本条为准'));
check('J5 提示词保留"前后区别必须基于 git diff 或验证结果"',
  coreSrc.includes('git diff 或验证结果'));

const spSrc = fs.readFileSync(path.join(ROOT, 'src/context/system-prompt.ts'), 'utf8');
const coreSpSrc = fs.readFileSync(path.join(ROOT, 'src/core/system-prompt.ts'), 'utf8');
check('J6 project 层已接进注入链路（类型 + 实现两处都在）',
  coreSpSrc.includes("'project'") && spSrc.includes("layer: 'project'"));
check('J7 project 层排在 skills 之后（比 memory 易变、比 task 稳定的定位）',
  spSrc.indexOf("layer: 'project'") > spSrc.indexOf('this.config.skills')
  && spSrc.indexOf("layer: 'project'") < spSrc.indexOf("layer: 'memory'"));

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
