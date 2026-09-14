/**
 * verify-roadmap.ts —— 项目生命周期协议：路线图坐标表的**格式门禁**（ROADMAP P10.12 第一步）
 *
 * 为什么需要它：`.flint/ROADMAP.md` 此前是"模型随手写的自由文本"——列名换了、状态写成别的词、
 * 编号重复、依赖指向不存在的编号，**没有任何东西会喊**。协议里唯一被机器看着的只有那把契约锁。
 * 这套断言把"格式漂移"变成红灯。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 契约常量 —— 状态/类别是封闭枚举、列顺序即契约、编号是分段编号
 *   ② 编号代数 —— 规范化、逐段比较（不是字典序）、父子判定（`compareId` 错一位，
 *      依赖列表的"升序"就会看着对实际错，故与解析同等对待）
 *   ③ 解析合法表 —— 字段逐个正确、依赖归一化、散文与别的表格不干扰
 *   ④ 解析非法表 —— **逐形状报错**且错误信息带行号（门禁的价值全在这段）
 *   ⑤ 状态派生 —— 父级状态是子树的函数：叶子用自己写的、父行走派生、显式搁置压过派生
 *   ⑥ 渲染与往返 —— `parse(render(x))` 恒等；含**两组随机属性测试**（平表恒等 + 树形幂等）
 *   ⑦ 与提示词交叉比对 —— 代码里的枚举字面必须出现在 `core-section.ts` 里
 *      （两边各存一份枚举迟早分家，届时门禁会永远红或永远绿 = 等于没有）
 *   ⑧ 源码守护 —— 模块零依赖、不落盘；真实 `.flint/ROADMAP.md` 存在则必须解析零错
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-roadmap.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLUMNS,
  COORD_CLASSES,
  COORD_STATUSES,
  ID_SEP,
  NO_DEP,
  compareId,
  deriveStatuses,
  descendantsOf,
  idSegments,
  isAncestor,
  isParent,
  normalizeId,
  parentOf,
  parseRoadmap,
  renderRoadmap,
  resolveStatuses,
  type Coord,
} from '../src/project/roadmap.js';

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

/** 造一张坐标表（表头与分隔行按契约） */
function table(rows: string[]): string {
  return [`| ${COLUMNS.join(' | ')} |`, `|${COLUMNS.map(() => '---').join('|')}|`, ...rows].join('\n');
}

/** 造一个坐标对象（默认叶子、无依赖） */
function coord(id: string, over: Partial<Coord> = {}): Coord {
  return { id, title: `坐标 ${id}`, status: '未开始', klass: '轻量', deps: [], ...over };
}

/* ── ① 契约常量 ── */
console.log('── ① 契约常量 ──');

check('A1 状态是四个的封闭枚举', COORD_STATUSES.length === 4);
check('A2 状态逐字等于 未开始 / 进行中 / 已完成 / 搁置',
  COORD_STATUSES.join(',') === '未开始,进行中,已完成,搁置', COORD_STATUSES.join(','));
check('A3 类别是 轻量 / 系统（封闭枚举）', COORD_CLASSES.length === 2 && COORD_CLASSES.join(',') === '轻量,系统');
check('A4 列恰五列且顺序即契约',
  COLUMNS.join(',') === '编号,坐标,状态,类别,依赖', COLUMNS.join(','));
check('A5 无依赖占位非空且不含数字', NO_DEP.length > 0 && !/\d/.test(NO_DEP));
check('A6 分段分隔符是点', ID_SEP === '.');

/* ── ② 编号代数 ── */
console.log('── ② 编号代数 ──');

check('B1 单段编号合法', normalizeId('3') === '3');
check('B2 多段编号合法', normalizeId('10.12.5') === '10.12.5');
check('B3 前导零被规范化（01.002 → 1.2）', normalizeId('01.002') === '1.2');
check('B4 首尾空白被吃掉', normalizeId('  7.8  ') === '7.8');
check('B5 尾点非法（1.）', normalizeId('1.') === null);
check('B6 首点非法（.1）', normalizeId('.1') === null);
check('B7 空段非法（1..2）', normalizeId('1..2') === null);
check('B8 非数字段非法（a.1）', normalizeId('a.1') === null);
check('B9 零段非法（1.0）', normalizeId('1.0') === null);
check('B10 带符号非法（-1 / +1）', normalizeId('-1') === null && normalizeId('+1') === null);
check('B11 段数组切分正确', idSegments('10.12.5').join(',') === '10,12,5');
check('B12 父编号取法（10.12.5 → 10.12）', parentOf('10.12.5') === '10.12');
check('B13 顶层编号没有父', parentOf('10') === null);
check('B14 逐段比较：1.2 在 1.10 之前（字典序会反）', compareId('1.2', '1.10') < 0);
check('B15 逐段比较：短的在前（1 在 1.2 之前）', compareId('1', '1.2') < 0);
check('B16 逐段比较：相等为 0', compareId('10.12', '10.12') === 0);
check('B17 逐段比较：首段不同按首段', compareId('2.1', '10.1') < 0);
check('B18 祖孙判定（1 是 1.2.3 的祖先）', isAncestor('1', '1.2.3'));
check('B19 祖孙判定不认字面相似（1 不是 10 的祖先）', !isAncestor('1', '10'));
check('B20 自己不是自己的祖先', !isAncestor('1.2', '1.2'));

const tree: Coord[] = [
  coord('1', { title: '大任务' }),
  coord('1.1', { title: '子任务甲' }),
  coord('1.2', { title: '子任务乙' }),
  coord('1.2.1', { title: '孙任务' }),
  coord('2', { title: '独立任务' }),
];
check('B21 父行判定（1 与 1.2 是父行）', isParent('1', tree) && isParent('1.2', tree));
check('B22 叶子不是父行', !isParent('1.1', tree) && !isParent('2', tree));
check('B23 后代含孙辈（1 的后代是 1.1/1.2/1.2.1）',
  descendantsOf('1', tree).map((c) => c.id).join(',') === '1.1,1.2,1.2.1');
check('B24 后代不含自己', !descendantsOf('1.2', tree).some((c) => c.id === '1.2'));
check('B25 父行判定不认字面前缀（1 的子的编号是 1.1 而不是 10）',
  !descendantsOf('1', tree).some((c) => c.id === '10'));
check('B26 顶层编号没有父', parentOf('2') === null);

/* ── ③ 解析：合法表 ── */
console.log('── ③ 解析合法表 ──');

const ok1 = parseRoadmap(table(['| 1 | 搭项目脚手架 | 进行中 | 系统 | — |']));
check('C1 标准表解析出 1 条且零错', ok1.errors.length === 0 && ok1.coords.length === 1, ok1.errors.join(' | '));
check('C2 字段逐个正确',
  ok1.coords[0]?.id === '1'
  && ok1.coords[0]?.title === '搭项目脚手架'
  && ok1.coords[0]?.status === '进行中'
  && ok1.coords[0]?.klass === '系统');

const ok2 = parseRoadmap(table([
  '| 1 | 甲 | 已完成 | 轻量 | — |',
  '| 2 | 乙 | 进行中 | 系统 | 1 |',
  '| 3 | 丙 | 未开始 | 轻量 | 2,1 |',
]));
check('C3 多行全部解析', ok2.coords.length === 3 && ok2.errors.length === 0, ok2.errors.join(' | '));
check('C4 依赖归一化升序（2,1 → [1,2]）', ok2.coords[2]?.deps.join(',') === '1,2');
check('C5 依赖去重（1,1 → [1]）',
  parseRoadmap(table(['| 1 | 甲 | 未开始 | 轻量 | — |', '| 2 | 乙 | 未开始 | 轻量 | 1,1 |'])).coords[1]?.deps.join(',') === '1');
check('C6 中文逗号也算分隔',
  parseRoadmap(table(['| 1 | 甲 | 未开始 | 轻量 | — |', '| 2 | 乙 | 未开始 | 轻量 | 1 |', '| 3 | 丙 | 未开始 | 轻量 | 1，2 |'])).coords[2]?.deps.join(',') === '1,2');
check('C7 占位破折号 → 无依赖', ok2.coords[0]?.deps.length === 0);
check('C8 空单元格 → 无依赖',
  parseRoadmap(table(['| 1 | 甲 | 未开始 | 轻量 |  |'])).coords[0]?.deps.length === 0);
check('C9 表格前后的散文不干扰',
  parseRoadmap(`# 路线图\n\n一些说明。\n\n${table(['| 1 | 甲 | 未开始 | 轻量 | — |'])}\n\n末尾再说两句。`).coords.length === 1);
check('C10 文件里另一张表格不干扰（表头不同）',
  parseRoadmap(['| 阶段 | 说明 |', '|---|---|', '| 一 | 先做地基 |', '', table(['| 1 | 甲 | 未开始 | 轻量 | — |'])].join('\n')).coords.length === 1);
check('C11 CRLF 行尾可解析',
  parseRoadmap(table(['| 1 | 甲 | 未开始 | 轻量 | — |']).replace(/\n/g, '\r\n')).coords.length === 1);
check('C12 表中间多插一条分隔行不报错',
  parseRoadmap(table(['| 1 | 甲 | 未开始 | 轻量 | — |', '|---|---|---|---|---|', '| 2 | 乙 | 未开始 | 轻量 | 1 |'])).coords.length === 2);
check('C13 标题里的竖线用 \\| 转义后解析还原',
  parseRoadmap(table(['| 1 | 甲\\|乙 | 未开始 | 轻量 | — |'])).coords[0]?.title === '甲|乙');
check('C14 分段编号可解析（10.12.5）',
  parseRoadmap(table(['| 10 | 甲 | 未开始 | 轻量 | — |', '| 10.12 | 乙 | 未开始 | 轻量 | — |', '| 10.12.5 | 丙 | 未开始 | 轻量 | 10 |']))
    .coords.map((c) => c.id).join(',') === '10,10.12,10.12.5');
check('C15 依赖写分段编号并按逐段序归一化（2,10.1.2,10.1 → 10.1,10.1.2,2 里的顺序）',
  parseRoadmap(table([
    '| 2 | 甲 | 未开始 | 轻量 | — |',
    '| 10.1 | 乙 | 未开始 | 轻量 | — |',
    '| 10.1.2 | 丙 | 未开始 | 轻量 | — |',
    '| 3 | 丁 | 未开始 | 轻量 | 2,10.1.2,10.1 |',
  ])).coords[3]?.deps.join(',') === '2,10.1,10.1.2');
check('C16 编号前导零规范化后不产生"重复"误报',
  parseRoadmap(table(['| 01.2 | 甲 | 未开始 | 轻量 | — |', '| 1 | 乙 | 未开始 | 轻量 | — |'])).errors.length === 0);

/* ── ④ 解析：非法表逐形状报错 ── */
console.log('── ④ 解析非法表 ──');

const err1 = parseRoadmap('# 只有散文，没有表');
check('D1 没有表 → 报找不到坐标表', err1.errors.length === 1 && err1.errors[0].includes('找不到坐标表'));

check('D2 表头改名（编号 → 序号）→ 报找不到坐标表',
  parseRoadmap(['| 序号 | 坐标 | 状态 | 类别 | 依赖 |', '|---|---|---|---|---|', '| 1 | 甲 | 未开始 | 轻量 | — |'].join('\n')).errors.length === 1);
check('D3 表头缺一列 → 报找不到坐标表',
  parseRoadmap(['| 编号 | 坐标 | 状态 | 类别 |', '|---|---|---|---|', '| 1 | 甲 | 未开始 | 轻量 |'].join('\n')).errors.some((e) => e.includes('找不到坐标表')));

const err4 = parseRoadmap(table(['| 1 | 甲 | 未开始 | 轻量 |']));
check('D4 数据行列数不对 → 报列数', err4.errors.some((e) => e.includes('5 列') && e.includes('4 列')), err4.errors.join(' | '));
const err5 = parseRoadmap(table(['| 1 | 甲 | 在做 | 轻量 | — |']));
check('D5 状态不在枚举 → 报状态并列出可取值',
  err5.errors.some((e) => e.includes('在做') && e.includes('未开始')), err5.errors.join(' | '));
const err6 = parseRoadmap(table(['| 1 | 甲 | 未开始 | 大工程 | — |']));
check('D6 类别不在枚举 → 报类别', err6.errors.some((e) => e.includes('大工程')), err6.errors.join(' | '));
const err7 = parseRoadmap(table(['| abc | 甲 | 未开始 | 轻量 | — |']));
check('D7 编号非数字 → 报编号', err7.errors.some((e) => e.includes('编号') && e.includes('abc')), err7.errors.join(' | '));
const err8 = parseRoadmap(table(['| 0 | 甲 | 未开始 | 轻量 | — |']));
check('D8 编号为 0 → 报分段编号', err8.errors.some((e) => e.includes('分段编号')), err8.errors.join(' | '));
const err8b = parseRoadmap(table(['| 1. | 甲 | 未开始 | 轻量 | — |']));
check('D8b 编号 1. 非法 → 报分段编号', err8b.errors.some((e) => e.includes('分段编号')), err8b.errors.join(' | '));
const err8c = parseRoadmap(table(['| 1.0 | 甲 | 未开始 | 轻量 | — |']));
check('D8c 编号 1.0 非法（段必须是正整数）', err8c.errors.some((e) => e.includes('分段编号')), err8c.errors.join(' | '));
const err9 = parseRoadmap(table(['| 1 |  | 未开始 | 轻量 | — |']));
check('D9 坐标空白 → 报空白', err9.errors.some((e) => e.includes('坐标') && e.includes('空白')), err9.errors.join(' | '));
const err10 = parseRoadmap(table(['| 1 | 甲 | 未开始 | 轻量 | — |', '| 2 | 乙 | 未开始 | 轻量 | 甲 |']));
check('D10 依赖不是编号 → 报依赖', err10.errors.some((e) => e.includes('依赖') && e.includes('甲')), err10.errors.join(' | '));
const err11 = parseRoadmap(table(['| 1 | 甲 | 未开始 | 轻量 | — |', '| 1 | 乙 | 未开始 | 轻量 | — |']));
check('D11 编号重复 → 报重复', err11.errors.some((e) => e.includes('重复')), err11.errors.join(' | '));
const err11b = parseRoadmap(table(['| 1.2 | 甲 | 未开始 | 轻量 | — |', '| 01.2 | 乙 | 未开始 | 轻量 | — |']));
check('D11b 规范化后撞车也算重复（1.2 与 01.2）', err11b.errors.some((e) => e.includes('重复')), err11b.errors.join(' | '));
const err12 = parseRoadmap(table(['| 2 | 甲 | 未开始 | 轻量 | 2 |']));
check('D12 自依赖 → 报依赖了自己', err12.errors.some((e) => e.includes('依赖了自己')), err12.errors.join(' | '));
const err13 = parseRoadmap(table(['| 1 | 甲 | 未开始 | 轻量 | 9 |']));
check('D13 依赖不存在的编号 → 报没有这个编号', err13.errors.some((e) => e.includes('没有编号 9')), err13.errors.join(' | '));
const err14 = parseRoadmap(table(['| 1.2 | 乙 | 未开始 | 轻量 | — |']));
check('D14 父编号不存在 → 报层次无从解析（只有 1.2、没有 1）',
  err14.errors.some((e) => e.includes('1.2') && e.includes('没有编号 1')), err14.errors.join(' | '));
check('D15 报错信息带行号（门禁要能指到那一行）',
  err5.errors.some((e) => /第 \d+ 行/.test(e)), err5.errors.join(' | '));
check('D16 有错时不把半成品当成功（coords 不含坏行）', err5.coords.length === 0);
check('D17 父编号存在时层次合法（1 与 1.2 都有）',
  parseRoadmap(table(['| 1 | 甲 | 未开始 | 轻量 | — |', '| 1.2 | 乙 | 未开始 | 轻量 | — |'])).errors.length === 0);

/* ── ⑤ 状态派生 ── */
console.log('── ⑤ 状态派生 ──');

const flat = [coord('1', { status: '进行中' }), coord('2', { status: '已完成' })];
check('E1 无子表：派生值等于各自写的', deriveStatuses(flat).get('1') === '进行中' && deriveStatuses(flat).get('2') === '已完成');

const allDone: Coord[] = [coord('1', { status: '未开始', klass: '系统' }), coord('1.1', { status: '已完成' }), coord('1.2', { status: '已完成' })];
check('E2 子全已完成 → 父派生为已完成（无视父行手写的"未开始"）', deriveStatuses(allDone).get('1') === '已完成');

const allNew: Coord[] = [coord('1', { status: '进行中' }), coord('1.1', { status: '未开始' }), coord('1.2', { status: '未开始' })];
check('E3 子全未开始 → 父派生为未开始（无视父行手写的"进行中"）', deriveStatuses(allNew).get('1') === '未开始');

const mixed: Coord[] = [coord('1'), coord('1.1', { status: '已完成' }), coord('1.2', { status: '未开始' })];
check('E4 有完成有未开始 → 父派生为进行中', deriveStatuses(mixed).get('1') === '进行中');

const frozen: Coord[] = [coord('1', { status: '搁置' }), coord('1.1', { status: '已完成' }), coord('1.2', { status: '已完成' })];
check('E5 父行显式搁置压过派生（子全完成也不改父）', deriveStatuses(frozen).get('1') === '搁置');

const childFrozen: Coord[] = [coord('1'), coord('1.1', { status: '已完成' }), coord('1.2', { status: '搁置' })];
check('E6 子有搁置有完成 → 父仍派生为已完成（搁置不算未完成）', deriveStatuses(childFrozen).get('1') === '已完成');

const allFrozen: Coord[] = [coord('1'), coord('1.1', { status: '搁置' }), coord('1.2', { status: '搁置' })];
check('E7 子全搁置 → 父派生为搁置', deriveStatuses(allFrozen).get('1') === '搁置');

const deep: Coord[] = [
  coord('1'),
  coord('1.1', { status: '已完成' }),
  coord('1.2'),
  coord('1.2.1', { status: '已完成' }),
  coord('1.2.2', { status: '未开始' }),
];
check('E8 孙辈参与派生（1.2 有完成有未开始 → 1.2 与 1 都进行中）',
  deriveStatuses(deep).get('1.2') === '进行中' && deriveStatuses(deep).get('1') === '进行中');
const deepDone: Coord[] = [
  coord('1'),
  coord('1.1', { status: '已完成' }),
  coord('1.2'),
  coord('1.2.1', { status: '已完成' }),
  coord('1.2.2', { status: '已完成' }),
];
check('E9 全部叶子完成 → 整棵树派生为已完成（含中间父行）',
  deriveStatuses(deepDone).get('1.2') === '已完成' && deriveStatuses(deepDone).get('1') === '已完成');
check('E10 只声明了父、没有任何子 → 退回父行自己写的值',
  deriveStatuses([coord('1', { status: '进行中' })]).get('1') === '进行中');

const resolved = resolveStatuses(allDone);
check('E11 resolveStatuses 不修改入参',
  allDone[0].status === '未开始' && resolved[0].status === '已完成');
check('E12 resolveStatuses 幂等', JSON.stringify(resolveStatuses(resolved)) === JSON.stringify(resolved));
check('E13 resolveStatuses 只换状态、其余字段一字不动',
  resolved.map((c) => `${c.id}/${c.title}/${c.klass}`).join(',') === allDone.map((c) => `${c.id}/${c.title}/${c.klass}`).join(','));

/* ── ⑥ 渲染与往返 ── */
console.log('── ⑥ 渲染与往返 ──');

check('F1 表头逐字等于契约', renderRoadmap([]).split('\n')[0] === `| ${COLUMNS.join(' | ')} |`);
check('F2 空清单 → 只有表头 + 分隔行两行', renderRoadmap([]).split('\n').length === 2);
const emptyRt = parseRoadmap(renderRoadmap([]));
check('F3 空清单往返：0 条且零错', emptyRt.coords.length === 0 && emptyRt.errors.length === 0);

const pipeTitle: Coord = coord('1', { title: '甲|乙' });
check('F4 标题含竖线 → 往返不丢', parseRoadmap(renderRoadmap([pipeTitle])).coords[0]?.title === '甲|乙');
const backTitle: Coord = coord('1', { title: 'C:\\path\\to' });
check('F5 标题含反斜杠 → 往返不丢', parseRoadmap(renderRoadmap([backTitle])).coords[0]?.title === 'C:\\path\\to');
check('F6 render 归一化依赖（乱序 + 重复）',
  renderRoadmap([coord('3', { deps: ['2', '1', '2'] })]).includes('| 1,2 |'));
check('F7 render 归一化标题首尾空白',
  renderRoadmap([coord('1', { title: '  甲  ' })]).includes('| 甲 |'));
check('F8 render 保真分段编号', renderRoadmap([coord('10.12.5')]).includes('| 10.12.5 |'));
check('F9 树形表往返零错',
  parseRoadmap(renderRoadmap(resolveStatuses(tree))).errors.length === 0,
  parseRoadmap(renderRoadmap(resolveStatuses(tree))).errors.join(' | '));
check('F10 父行渲染前先 resolve，写出来的是派生值',
  renderRoadmap(resolveStatuses(allDone)).includes('| 1 | 坐标 1 | 已完成 | 系统 | — |'),
  renderRoadmap(resolveStatuses(allDone)).split('\n')[2]);

/** mulberry32：零依赖确定性 PRNG（手写样例容易恰好避开 bug，故用属性测试） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 随机标题的字符池刻意含 `|`、`\`、空格、CJK —— 手写样例不会去碰这些边界
const POOL = '甲乙丙丁abcXYZ019 |\\,.-—：';
function randomTitle(rnd: () => number): string {
  const len = 1 + Math.floor(rnd() * 12);
  let title = '';
  for (let k = 0; k < len; k++) title += POOL[Math.floor(rnd() * POOL.length)];
  return title.trim() || 'x';
}

// 属性测试一：**平表**（单段编号）—— render → parse 必须逐字段恒等
let rtBad = 0;
{
  const rnd = mulberry32(20260914);
  for (let g = 0; g < 40; g++) {
    const n = 1 + Math.floor(rnd() * 5);
    const coords: Coord[] = [];
    for (let i = 1; i <= n; i++) {
      const deps: string[] = [];
      for (let j = 1; j <= n; j++) if (j !== i && rnd() < 0.3) deps.push(String(j));
      coords.push({
        id: String(i),
        title: randomTitle(rnd),
        status: COORD_STATUSES[Math.floor(rnd() * COORD_STATUSES.length)],
        klass: COORD_CLASSES[Math.floor(rnd() * COORD_CLASSES.length)],
        deps: [...new Set(deps)].sort(compareId),
      });
    }
    const back = parseRoadmap(renderRoadmap(coords));
    if (back.errors.length > 0 || JSON.stringify(back.coords) !== JSON.stringify(coords)) rtBad++;
  }
}
check('F11 属性测试：40 组随机平表 render→parse 往返恒等', rtBad === 0, `不符 ${rtBad} 组`);

// 属性测试二：**树形表** —— 生成的每棵树都合法，但父行状态是乱写的；
// 断言 `resolve` 幂等，且 resolve 后的表 render→parse 仍恒等（派生值可被持久化）
let treeBad = 0;
{
  const rnd = mulberry32(20260915);
  for (let g = 0; g < 40; g++) {
    const n = 1 + Math.floor(rnd() * 6);
    const ids: string[] = [];
    while (ids.length < n) {
      const parent = ids.length > 0 && rnd() < 0.7 ? ids[Math.floor(rnd() * ids.length)] : null;
      const id = parent === null ? String(ids.length + 1) : `${parent}.${1 + Math.floor(rnd() * 3)}`;
      if (ids.includes(id)) continue;
      // 父编号必须存在：从空表起步时只能先建顶层，故此处必然满足（parent 取自已有 ids）
      ids.push(id);
    }
    const coords: Coord[] = ids.map((id) => ({
      id,
      title: randomTitle(rnd),
      status: COORD_STATUSES[Math.floor(rnd() * COORD_STATUSES.length)],
      klass: COORD_CLASSES[Math.floor(rnd() * COORD_CLASSES.length)],
      deps: [],
    }));
    const once = resolveStatuses(coords);
    const twice = resolveStatuses(once);
    if (JSON.stringify(once) !== JSON.stringify(twice)) { treeBad++; continue; }
    const back = parseRoadmap(renderRoadmap(once));
    if (back.errors.length > 0 || JSON.stringify(back.coords) !== JSON.stringify(once)) treeBad++;
  }
}
check('F12 属性测试：40 组随机树 resolve 幂等且 resolve 后 render→parse 恒等', treeBad === 0, `不符 ${treeBad} 组`);

/* ── ⑦ 与提示词交叉比对 ── */
console.log('── ⑦ 与提示词交叉比对 ──');

const coreSrc = fs.readFileSync(path.join(ROOT, 'src/context/sections/core-section.ts'), 'utf8');
check('G1 提示词含全部状态枚举字面',
  COORD_STATUSES.every((s) => coreSrc.includes(s)), COORD_STATUSES.filter((s) => !coreSrc.includes(s)).join(','));
check('G2 提示词含全部类别枚举字面',
  COORD_CLASSES.every((s) => coreSrc.includes(s)), COORD_CLASSES.filter((s) => !coreSrc.includes(s)).join(','));
check('G3 提示词含五个列名',
  COLUMNS.every((c) => coreSrc.includes(c)), COLUMNS.filter((c) => !coreSrc.includes(c)).join(','));
check('G4 提示词讲了"编号即层次"（分段编号 + 父级状态派生、不手写）',
  coreSrc.includes('分段编号') && coreSrc.includes('父级状态') && coreSrc.includes('派生'));

/* ── ⑧ 源码守护 ── */
console.log('── ⑧ 源码守护 ──');

const roadmapSrc = fs.readFileSync(path.join(ROOT, 'src/project/roadmap.ts'), 'utf8');
check('H1 roadmap.ts 零 import（纯函数模块，含枚举这唯一真相源）', !/^import /m.test(roadmapSrc));
check('H2 roadmap.ts 不落盘（解析/渲染都不碰 fs）',
  !/writeFileSync|appendFileSync|readFileSync|'node:fs'/.test(roadmapSrc));

const realFile = path.join(process.cwd(), '.flint/ROADMAP.md');
if (fs.existsSync(realFile)) {
  const real = parseRoadmap(fs.readFileSync(realFile, 'utf8'));
  check('H3 真实 .flint/ROADMAP.md 解析零错', real.errors.length === 0, real.errors.join(' | '));
} else {
  console.log('  ⏭ H3 本仓库无 .flint/ROADMAP.md（格式门禁的适用对象是目标项目的路线图）');
}

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
