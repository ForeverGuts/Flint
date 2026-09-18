/**
 * verify-at-file.ts —— `@file` 输入引用（ROADMAP 10.8.1）
 *
 * 为什么需要它：这条功能的产物**用户看不见**（它活在送进 LLM 的用户消息里），而它有三类
 * 失效都**不会报错、只会静静地把句子改坏**：
 *   ① 误判 —— 把邮箱 `a@b.com` 或代码里的 `@Component` 当成引用；
 *   ② 静默替换 —— 用户想写"字面的 @某文件"，结果句子被换成占位符（没有它就没法表达不想引用）；
 *   ③ 拼接 —— 正文改写与附件块拼装两处各干各的，读起来多了 / 少了一个空行（真跑 demo 才露）。
 * 三类都不是异常，所以只能靠断言钉住。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 识别（判据第一节：位置 + 形状）—— 邮箱 / 数字前缀 / 中文标点 / 收尾标点 / 转义 / 下标 /
 *      **引号包裹的路径**（Windows 给带空格的路径加引号）/ **拖入的裸绝对路径**（相对路径必须不认）
 *   ② 组装（纯函数喂合成事实）—— 占位符 / 附件块形态 / fail-open / 去重 / 两种上限 /
 *      **空行只该有一个**（真跑才发现的那个回归）/ **拖入形态（整条输入一个 `@` 都没有）也要能替换**
 *   ③ 转义 `@@`
 *   ④ 探针（真目录真文件）—— 统计 / 目录 / 二进制 / 太大两档 / BOM / **不递归**
 *   ⑤ 源码守护 —— 判据零 import、不碰 fs 不起进程、探针是唯一碰 fs 处、main.ts 真接线
 *   ⑥ 行为证明 —— 真 Runtime 真 `onInput`，前一个 handler 的 transform 真的被后一个看到
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-at-file.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 * 退出码：failed > 0 → 1
 *
 * 环境依赖：④ 会造临时目录与几种真文件（含一个 3 MB 的与一个 2100 行的），
 *   在 `finally` 里删干净 —— 本项目有过"清理写在函数末尾、崩一次留一个"的教训。
 *
 * 已知留白（不装糊涂）：`@@` 解码"要写字面两个 @ 得写四个"这条**没有专门的用例** ——
 *   它不是一个独立分支，只是单趟重写的自然结果，已在 ③ 里用 `@@@@` 覆盖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { Runtime } from '../src/runtime/runtime.js';
import {
  AT_HEADER,
  AT_MAX_REFS,
  AT_MAX_TOTAL_BYTES,
  composeAtFile,
  formatBytes,
  looksLikeAbsPath,
  looksLikePath,
  parseAtCandidates,
  type AtProbe,
} from '../src/input/at-file.js';
import { atFileInputHandler, probeAtRef, resolveAtFile } from '../src/input/probe.js';

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

/** 抹掉注释再查（本仓已多次踩"源码文本断言被自己的说明文字判红"） */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** 合成"读到了"的事实 */
const okProbe = (p: string, content = 'X', extra: Partial<AtProbe> = {}): AtProbe => ({
  path: p, resolved: `/abs/${p}`, content, note: `${content.split('\n').length} 行`, truncated: false,
  bytes: Buffer.byteLength(content, 'utf-8'), ...extra,
});
/** 合成"没读到"的事实 */
const missProbe = (p: string, note = '找不到这个路径'): AtProbe => ({
  path: p, resolved: '', content: null, note, truncated: false, bytes: 0,
});
/** 走"识别 → 喂合成事实"这条纯路径（下标由 parseAtCandidates 自己保证一致） */
const withFacts = (text: string, probes: AtProbe[]) =>
  composeAtFile(text, parseAtCandidates(text), probes);
/** 候选路径列表（看识别结果用） */
const paths = (text: string): string[] => parseAtCandidates(text).map((c) => c.path);

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 识别：位置判据 + 形状判据（不碰磁盘）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n① 识别（哪些 @ 才算引用）');

check('A1 行首 @path → 是候选', paths('@src/a.ts 看看').join() === 'src/a.ts');
check('A2 空格后的 @path → 是候选', paths('看看 @src/a.ts').join() === 'src/a.ts');
check('A3 全角括号后的 @path → 是候选（中文行文常见）', paths('（@src/a.ts）').join() === 'src/a.ts');

check('A4 **邮箱不当引用**：@ 前面是字母', paths('发到 a@b.com 去').length === 0);
check('A5 @ 前面是数字 → 不当引用', paths('版本 x2@y.ts').length === 0);
check('A6 @ 前面是下划线 / 点 / 减号 → 不当引用',
  paths('a_@b.ts').length === 0 && paths('a.@b.ts').length === 0 && paths('a-@b.ts').length === 0);

check('A7 装饰器位置（行首 / 空格后）**是候选** —— 靠"形状 + 读不到不吭声"挡住，不靠位置排除',
  paths('@Component\nexport class A {}').join() === 'Component');

check('A8 收尾句号剥掉', paths('见 @src/a.ts. 这里').join() === 'src/a.ts');
check('A9 收尾逗号 / 右括号剥掉',
  paths('见 @src/a.ts,').join() === 'src/a.ts' && paths('(@src/a.ts)').join() === 'src/a.ts');
check('A10 中文标点**截断**（不是剥 —— 它是句子分隔符）',
  paths('见 @src/a.ts，然后 @src/b.ts').join() === 'src/a.ts,src/b.ts');

check('A11 一条输入里多个引用按出现顺序给',
  paths('@a.ts @b.ts @c.ts').join() === 'a.ts,b.ts,c.ts');
check('A12 空 @（后面什么都没有）不产生候选', paths('就只有 @ 一个符号').length === 0);
check('A13 只有收尾标点、剥完为空 → 不产生候选', paths('@...').length === 0);

check('A14 下标可回切原文（start/end 与 raw 一致）', (() => {
  const text = '看看 @src/a.ts 这段';
  // ⚠ 用 `?.` 而不是 `[0]!`：判据一旦不再产出候选，`[0]!` 会让**整个套件崩在这里** ——
  //    红是红了，但红得不干净（后面几十条根本没跑，变异脚本只能报"未命中预期"）。
  //    断言应当"红得整齐"：缺候选就这一条 ❌，其余照常跑完。
  const c = parseAtCandidates(text)[0];
  return text.slice(c?.start, c?.end) === c?.raw && c?.raw === '@src/a.ts';
})());

check('A15 形状判据：含 / \\ . 才算"像路径"',
  looksLikePath('src/a.ts') && looksLikePath('a/b') && looksLikePath('a\\b') && looksLikePath('a.ts')
  && !looksLikePath('Component') && !looksLikePath('src'));

/* ── 引号包裹的路径（Windows 拖入 / 粘贴给带空格的路径加引号）── */

check('A16 双引号里的路径**连着空格一起读**（引号让空格不再是断句符）；引号内两侧空白被 trim',
  paths('看 @"C:\\a b\\c.ts" 这段').join() === 'C:\\a b\\c.ts'
  && paths('看 @" C:\\a b\\c.ts " 这段').join() === 'C:\\a b\\c.ts');
check('A17 单引号也认（PowerShell / POSIX shell 给的形式）',
  paths("看 @'C:\\a b\\c.ts' 这段").join() === 'C:\\a b\\c.ts');
check('A18 引号**算进替换范围**（正文里要连引号一起换成占位符，不留孤零零的引号）', (() => {
  const text = '看 @"C:\\a b\\c.ts" 这段';
  const c = parseAtCandidates(text)[0];      // `?.` 同上：缺候选时只该这一条红
  return text.slice(c?.start, c?.end) === c?.raw && c?.raw === '@"C:\\a b\\c.ts"';
})());
check('A19 引号**没闭合**（打字打到一半）→ 退化成"读到空白为止"并丢掉开头那个引号',
  paths('看 @"C:\\a b\\c.ts 这段').join() === 'C:\\a');
check('A20 空引号 `@""` 不产生候选', paths('看 @"" 这段').length === 0);
check('A21 引号短语**两条通路的闸在不同阶段**：`@` 通路会先认下来（形状闸在组装段 → 没读到就静默，'
+ '见 B28），裸通路在识别段就挡住（它没有"用户主动点名"这个前提，只能靠形状）',
  paths('他说 @"hello world" 这句').join() === 'hello world'
  && paths('他说 "hello world" 这句').length === 0);

/* ── 拖入的裸绝对路径（前面没有 `@`）── */

check('A22 裸盘符路径 → 是候选（拖入的主要形态）',
  paths('看看 C:\\proj\\a.ts 这段').join() === 'C:\\proj\\a.ts');
check('A23 裸 UNC（`\\\\server\\share`）与裸 POSIX 根（`/var/log/x`）都认',
  paths('看 \\\\srv\\share\\a.ts 和 /var/log/a.log').join() === '\\\\srv\\share\\a.ts,/var/log/a.log');
check('A24 裸**相对路径不认** —— 这条取舍是整条判据的关键（正文里提相对路径是常见行文，认了会凭空多附件）',
  paths('看看 src/a.ts 写错了没，还有 ./b.ts 和 c.ts').length === 0);
check('A25 裸路径的位置判据：紧跟在词字符后不认（`abcC:\\a.ts` 不是拖入）',
  paths('abcC:\\a.ts').length === 0 && paths('（C:\\a.ts）').join() === 'C:\\a.ts');
check('A26 `@@` 也护得住裸路径（位置判据把"前面是 `@`"挡在外，同一条性质）',
  paths('@@C:\\a.ts').length === 0 && paths('@@src/a.ts').length === 0);
check('A27 收尾标点在两种形态下都剥掉路径、且**替换范围**口径不同：裸路径把标点留在正文里，'
+ '引号形态连标点带引号一起吃（否则正文会剩一个孤零零的引号）', (() => {
  const bare = '看 C:\\a\\b.ts.';
  const c1 = parseAtCandidates(bare)[0];      // `?.` 同上
  const quoted = '看 @"C:\\a b.ts." 这段';
  const c2 = parseAtCandidates(quoted)[0];
  return c1?.path === 'C:\\a\\b.ts' && bare.slice(c1.start, c1.end) === 'C:\\a\\b.ts'
    && c2?.path === 'C:\\a b.ts' && quoted.slice(c2.start, c2.end) === '@"C:\\a b.ts."';
})());
check('A28 `looksLikeAbsPath` 正反两组：盘符 / UNC / POSIX 真，相对路径与裸文件名假',
  looksLikeAbsPath('C:\\a.ts') && looksLikeAbsPath('c:/a.ts') && looksLikeAbsPath('\\\\srv\\s\\a.ts')
  && looksLikeAbsPath('/var/a.log')
  && !looksLikeAbsPath('src/a.ts') && !looksLikeAbsPath('./a.ts') && !looksLikeAbsPath('a.ts')
  && !looksLikeAbsPath('looks.like/path'));

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 组装：纯函数喂合成事实
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n② 组装（占位符 / 附件块 / fail-open / 上限 / 空行）');

const one = withFacts('看看 @src/a.ts 对不对', [okProbe('src/a.ts', 'line1\nline2')]);
check('B1 读到了 → 正文换占位符，且带路径名（不只是编号，方便读）',
  one.text.startsWith('看看 [引用 1：src/a.ts] 对不对'), one.text.slice(0, 40));
check('B2 读到了 → 附件块有抬头声明（防提示注入那句）', one.text.includes(AT_HEADER));
check('B3 读到了 → 定界符 + 统计 + 结尾标记齐备',
  one.text.includes('引用 1/1：src/a.ts（2 行）') && one.text.includes('引用 1 结束'));
check('B4 文件内容**原样**在块里（不被转义、不被再处理）', one.text.includes('line1\nline2'));
check('B5 changed = true', one.changed);

const noPathShape = withFacts('代码里的 @Component 别动', [missProbe('Component')]);
check('B6 读不到 + **形状不像路径** → 整句一字不动、连备注都不加（挡装饰器刷屏）',
  noPathShape.changed === false && noPathShape.text === '代码里的 @Component 别动');

const missPath = withFacts('看看 @src/nope.ts 这段', [missProbe('src/nope.ts')]);
check('B7 读不到 + 形状像路径 → 正文里 @path **原样保留**（fail-open，不改用户的句子）',
  missPath.text.includes('看看 @src/nope.ts 这段'));
check('B8 读不到 → 出现「没读到的引用」并给出原因', missPath.text.includes('【没读到的引用】')
  && missPath.text.includes('- @src/nope.ts：找不到这个路径'));
check('B9 读不到 → **不出现附件抬头**（没有附件就别摆出"以下是引用的文件"）',
  missPath.text.includes(AT_HEADER) === false);

check('B10 空行回归：正文与备注段之间**恰好一个空行**（真跑 demo 才发现的拼接 bug）',
  missPath.text === '看看 @src/nope.ts 这段\n\n【没读到的引用】\n- @src/nope.ts：找不到这个路径',
  JSON.stringify(missPath.text));
check('B11 附件块首：抬头与正文之间也恰好一个空行（全文只该有两处空行：正文↔抬头、抬头↔定界符）',
  one.text.includes('对不对\n\n[引用的文件]')
  && (one.text.match(/\n\n/g) ?? []).length === 2,
  JSON.stringify((one.text.match(/\n\n/g) ?? []).length));

const both = withFacts('@src/a.ts 与 @src/nope.ts',
  [okProbe('src/a.ts', 'A'), missProbe('src/nope.ts')]);
// ⚠ 正文那段用 `startsWith` 精确比对而不是 `includes` —— 没读到的那条路径**在下面的
//   「没读到的引用」区里又会印一遍**，用 includes 的话正文被改坏了也照样命中（变异测试逮到过）。
check('B12 读到与没读到并存 → 正文里前者换占位符、后者逐字不动',
  both.text.startsWith('[引用 1：src/a.ts] 与 @src/nope.ts\n\n')
  && both.text.includes('【没读到的引用】'));

const dup = withFacts('@src/a.ts 再来一次 @./src/a.ts', [
  okProbe('src/a.ts', 'A'),
  { ...okProbe('./src/a.ts', 'A'), resolved: '/abs/src/a.ts' },   // 同一文件，不同原文
]);
check('B13 去重按**解析后的绝对路径**：两份原文同一个文件 → 只一个附件',
  (dup.text.match(/引用 1\/1/g) ?? []).length === 1, dup.text);
check('B14 去重后正文两处都指向同一个编号',
  (dup.text.match(/\[引用 1：/g) ?? []).length === 2);

const six = withFacts(
  '@a.ts @b.ts @c.ts @d.ts @e.ts @f.ts',
  ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => okProbe(`${n}.ts`, n)),
);
check(`B15 个数上限：${AT_MAX_REFS} 个进块`, (six.text.match(/-----\s*引用 \d+\/\d+：/g) ?? []).length === AT_MAX_REFS);
check('B16 超出个数上限的第 6 个 → 进「没进上下文的引用」并说明原因',
  six.text.includes('【没进上下文的引用】') && six.text.includes('f.ts：超出个数上限'));
check('B17 被丢的那条**不在正文里留占位符**（没进上下文就别假装进了）',
  six.text.includes('[引用 6：') === false);

const big1 = okProbe('big1.ts', 'x', { bytes: 200 * 1024 });
const big2 = okProbe('big2.ts', 'y', { bytes: 200 * 1024 });
const budget = withFacts('@big1.ts @big2.ts', [big1, big2]);
check(`B18 合计字节上限：第一份进、第二份撑破 → 进丢弃表（上限 ${formatBytes(AT_MAX_TOTAL_BYTES)}）`,
  budget.text.includes('引用 1/1：big1.ts') && budget.text.includes('big2.ts：附件合计超过'));

const trunc = withFacts('@src/a.ts', [okProbe('src/a.ts', 'A', { truncated: true, note: '只取前 3/900 行' })]);
check('B19 被截断的文件 → 标题里明说「已截断」（不让人以为看全了）',
  trunc.text.includes('只取前 3/900 行，已截断'));

const none = withFacts('这段完全正常，没有任何引用', []);
check('B20 无候选 → 文本**逐字**不变且 changed=false', none.changed === false
  && none.text === '这段完全正常，没有任何引用');

const mismatch = composeAtFile('看看 @src/a.ts', parseAtCandidates('看看 @src/a.ts'), []);
check('B21 探针少给一格（数组错位）→ 当"没读到"处理，不抛、不错位',
  mismatch.changed === true && mismatch.text.includes('【没读到的引用】'));

/* ── 拖入形态（裸绝对路径）：整条输入一个 `@` 都没有 ── */

const drag = withFacts('看看 C:\\proj\\a.ts 这段', [okProbe('C:\\proj\\a.ts', 'DRAG')]);
check('B22 拖入 → 路径换成占位符、附件进块、changed=true（整条输入里本来一个 `@` 都没有）',
  drag.changed && drag.text.startsWith('看看 [引用 1：C:\\proj\\a.ts] 这段')
  && drag.text.includes('引用 1/1：C:\\proj\\a.ts') && drag.text.includes(AT_HEADER));

check('B23 拖入失败 → 报「没读到」，且报的是**原文**（不凭空给它补一个 `@`）', (() => {
  const o = withFacts('看看 C:\\proj\\nope.ts 这段', [missProbe('C:\\proj\\nope.ts')]);
  return o.text.includes('- C:\\proj\\nope.ts：找不到这个路径') && o.text.includes('@') === false;
})());

check('B24 带引号的引用被替换时**连引号一起吃掉**（正文里不留孤零零的引号）', (() => {
  const o = withFacts('看 "C:\\p\\a b.ts" 这段', [okProbe('C:\\p\\a b.ts', 'X')]);
  return o.text.split('\n\n')[0] === '看 [引用 1：C:\\p\\a b.ts] 这段';
})());

check('B25 `@` 与拖入指向同一文件 → 去重成一个附件，两处占位符同号', (() => {
  const text = '看 C:\\p\\a.ts 和 @C:/p/a.ts 这两处';
  const o = composeAtFile(text, parseAtCandidates(text), [
    okProbe('C:\\p\\a.ts', 'A', { resolved: 'C:\\p\\a.ts' }),
    okProbe('C:/p/a.ts', 'A', { resolved: 'C:\\p\\a.ts' }),   // 原文不同、解析后同一个文件
  ]);
  return (o.text.match(/引用 1\/1/g) ?? []).length === 1
    && (o.text.match(/\[引用 1：/g) ?? []).length === 2;
})());

check('B26 拖入与 `@` 混用 → 编号按出现顺序（拖入的也可以是 1 号）', (() => {
  const text = '看 C:\\p\\a.ts 和 @src/b.ts';
  const o = composeAtFile(text, parseAtCandidates(text), [okProbe('C:\\p\\a.ts', 'A'), okProbe('src/b.ts', 'B')]);
  return o.text.startsWith('看 [引用 1：C:\\p\\a.ts] 和 [引用 2：src/b.ts]');
})());

check('B27 拖入一个**目录**（探针说"这是个目录"）→ 不进块、不占编号，但**要报**（拖入的失败不能静默）', (() => {
  const o = withFacts('看 C:\\proj\\sub 这段', [missProbe('C:\\proj\\sub', '这是个目录，不是文件（要列目录请用 ls）')]);
  return o.text.includes('【没读到的引用】') && o.text.includes('这是个目录')
    && o.text.includes('[引用 1：') === false;
})());

check('B28 引号里不是路径（`@"hello world"`）→ 读不到也**静默**：整句逐字不动（形状闸对引号形态同样成立）',
  (() => { const o = withFacts('他说 @"hello world" 这句', [missProbe('hello world')]);
    return o.changed === false && o.text === '他说 @"hello world" 这句'; })());

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 转义 `@@`
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n③ 转义 `@@`（写"字面的 @文件"的唯一办法）');

check('C1 `@@x` 不是候选', paths('@@src/a.ts').length === 0);
check('C2 `@@x` → 解码成 `@x`，且算作改动',
  (() => { const o = withFacts('@@src/a.ts', []); return o.changed && o.text === '@src/a.ts'; })());
check('C3 `@@@@` → 解码成 `@@`（加倍转义，同 todo 投影那套）',
  (() => { const o = withFacts('@@@@x', []); return o.text === '@@x'; })());
check('C4 转义与真引用并存：前者字面、后者进块',
  (() => {
    const o = withFacts('@@src/a.ts 是字面量，@src/a.ts 才是引用', [okProbe('src/a.ts', 'A')]);
    // ⚠ 这里必须查"还有没有 `@@`"而不是查 `includes('@src/a.ts 是字面量')` ——
    //   后者在**没解码**时也成立（`@@src/a.ts…` 包含 `@src/a.ts…` 这个子串），是条假绿断言。
    return o.text.startsWith('@src/a.ts 是字面量') && o.text.includes('@@') === false
      && o.text.includes('[引用 1：src/a.ts] 才是引用');
  })());
check('C5 `@@@x` → 第一个 `@@` 解码、第三个 `@` 前面是 `@` 故不成候选（结果 `@@x`）',
  (() => { const o = withFacts('@@@x', []); return o.text === '@@x' && paths('@@@x').length === 0; })());

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 探针：真目录、真文件
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n④ 探针（真文件：统计 / 目录 / 二进制 / 太大 / BOM / 不递归）');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-at-'));
try {
  fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'sub', 'a.ts'), 'line1\nline2\nline3');
  fs.writeFileSync(path.join(tmp, 'bom.ts'), '\uFEFFconst a = 1;');
  fs.writeFileSync(path.join(tmp, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
  fs.writeFileSync(path.join(tmp, 'huge.txt'), 'x'.repeat(3 * 1024 * 1024));
  fs.writeFileSync(path.join(tmp, 'long.txt'), Array.from({ length: 2100 }, (_, i) => `L${i}`).join('\n'));
  // 不递归：a.ts 的内容里再写一个 @ref.ts，且 ref.ts 真实存在
  fs.writeFileSync(path.join(tmp, 'ref.ts'), 'REF');
  fs.writeFileSync(path.join(tmp, 'nested.ts'), '内容里提到 @ref.ts 一句');

  const candOf = (t: string) => parseAtCandidates(t)[0]!;

  const ok = probeAtRef(tmp, candOf('@sub/a.ts'));
  check('D1 真文件读到内容 + 统计（行数 / 字节）', ok.content === 'line1\nline2\nline3'
    && ok.note === '3 行 / 17 B' && ok.bytes === 17 && ok.truncated === false);
  check('D2 resolved 是绝对路径（去重靠它）', path.isAbsolute(ok.resolved) && ok.resolved.endsWith('a.ts'));

  const dir = probeAtRef(tmp, candOf('@sub'));
  check('D3 目录 → 明说"这是个目录，不是文件"并指向 ls', dir.content === null
    && dir.note.includes('这是个目录') && dir.note.includes('ls'));

  const bin = probeAtRef(tmp, candOf('@bin.dat'));
  check('D4 含 NUL 的文件 → 判二进制并跳过（灌进上下文只是乱码）',
    bin.content === null && bin.note.includes('二进制'));

  const huge = probeAtRef(tmp, candOf('@huge.txt'));
  check('D5 超读前天花板（2 MB）→ **连读都不读**，报大小并建议用 read 分段',
    huge.content === null && huge.note.includes('太大') && huge.note.includes('3.0 MB')
    && huge.note.includes('read'));

  const long = probeAtRef(tmp, candOf('@long.txt'));
  check('D6 超行数上限 → 截断到 2000 行、标 truncated、note 说清"只取前几行"',
    long.truncated === true && long.content!.split('\n').length === 2000
    && long.note.startsWith('只取前 2000/2100 行'));

  const bom = probeAtRef(tmp, candOf('@bom.ts'));
  check('D7 BOM 被去掉（块里第一行不该多一个看不见的字符）',
    bom.content === 'const a = 1;' && bom.content!.charCodeAt(0) !== 0xfeff);

  const missing = probeAtRef(tmp, candOf('@sub/nope.ts'));
  check('D8 不存在 → "找不到这个路径"，不抛', missing.content === null && missing.note === '找不到这个路径');

  // 解析器注入：钉住"路径解析抛异常"那一支也在（宽容读的完整面）
  const badResolve = probeAtRef(tmp, candOf('@sub/a.ts'), (() => { throw new Error('boom'); }) as never);
  check('D9 路径解析抛异常 → 折成一句 note，绝不抛出去',
    badResolve.content === null && badResolve.note === '路径解析失败');

  // 不递归：端到端走 resolveAtFile，附件只有 1 份，ref.ts 的内容不该出现
  const nested = resolveAtFile('看 @nested.ts', tmp);
  check('D10 **不递归**：附件内容里的 @ref.ts 不展开（否则可以互相引用、展开不收敛）',
    (nested.text.match(/引用 \d+\/\d+：/g) ?? []).length === 1
    && nested.text.includes('内容里提到 @ref.ts 一句')
    && nested.text.includes('引用 1/1：nested.ts'));

  // 真目录端到端：换 cwd 相对路径真的落到那个目录
  const rel = resolveAtFile('看 @sub/a.ts', tmp);
  check('D11 相对路径按传入 cwd 解析（与 read 工具同口径）',
    rel.text.includes('line1\nline2\nline3') && rel.text.includes('引用 1/1：sub/a.ts'));

  const noAt = resolveAtFile('完全没有引用的输入', tmp);
  check('D12 输入不含 @ → 不碰 fs、原样返回（C9：不进启动关键路径，也不在无关输入上花 IO）',
    noAt.changed === false && noAt.text === '完全没有引用的输入');

  /* ── 拖入形态走真文件（带空格的路径要真带上引号才能读）── */

  const spaced = path.join(tmp, 'drag probe.ts');
  fs.writeFileSync(spaced, 'DRAGSPACE\n第二行');

  const quoted = resolveAtFile(`看 @"${spaced}" 这段`, tmp);
  check('D13 真·带空格的文件 + 引号（拖入形态）→ 读到内容；标题里是**干净的路径**，正文不留引号',
    quoted.text.includes('DRAGSPACE') && quoted.text.includes('引用 1/1：')
    && quoted.text.startsWith('看 [引用 1：') && quoted.text.includes('drag probe.ts] 这段')
    && quoted.text.includes('"] 这段') === false, quoted.text.split('\n')[0]);

  const bareReal = resolveAtFile(`看 ${path.join(tmp, 'sub', 'a.ts')} 这段`, tmp);
  check('D14 真·拖入（裸绝对路径、整条输入一个 `@` 都没有）→ 也读到内容'
  + '（这条同时是"短路只看 `@`"那个坑的回归）',
    bareReal.text.includes('line1\nline2\nline3') && bareReal.text.startsWith('看 [引用 1：'));

  const bareDir = resolveAtFile(`看 ${path.join(tmp, 'sub')} 这个目录`, tmp);
  check('D15 拖入一个目录 → 报"这是个目录"（拖入的失败**看得见**，不静默吞掉）',
    bareDir.text.includes('【没读到的引用】') && bareDir.text.includes('这是个目录'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 源码守护：判据不碰 IO，探针是唯一碰 fs 的地方，接线真的在
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ 源码守护（分层没被蛀空）');

const srcJudge = stripComments(read('src/input/at-file.ts'));
const srcProbe = stripComments(read('src/input/probe.ts'));
const srcMain = stripComments(read('src/harness/main.ts'));

check('E1 判据模块**零 import**（可脱离磁盘逐条打靶的前提）',
  /(^|\n)\s*import[\s{*'"]/.test(srcJudge) === false);
check('E2 判据里不出现任何 fs / 子进程能力',
  /node:fs|child_process|readFileSync|existsSync|spawn|execFile/.test(srcJudge) === false);
check('E3 探针是唯一 import `node:fs` 的 input 模块',
  /node:fs/.test(srcProbe) && fs.readdirSync(path.join(ROOT, 'src/input'))
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /node:fs/.test(stripComments(read(`src/input/${f}`)))).join() === 'probe.ts');
check('E4 探针不起任何子进程（这条功能不该有进程成本）',
  /child_process|spawnSync|execFileSync|execSync/.test(srcProbe) === false);
check('E5 main.ts 真的把 `@file` 挂上了 runtime.onInput（且用的是那个**唯一实现**）',
  srcMain.includes('runtime.onInput(') && srcMain.includes('atFileInputHandler('));
check('E6 main.ts 的挂点**在模式分发之前**（REPL 与 RPC 一个口径，而不是只服务终端）',
  srcMain.indexOf('runtime.onInput(') < srcMain.indexOf("FLINT_MODE === 'rpc'"));
check('E7 判据与探针共用同一份上限常量（不在两处各写一遍数字）',
  /AT_MAX_REFS/.test(srcProbe) === false && /from '\.\/at-file\.js'/.test(srcProbe));
check('E8 用户可见文案里没有"模板串被反引号截断"的隐患：附件抬头不含反引号',
  AT_HEADER.includes('`') === false);
check(`E9 个数上限**钉在 5**（它是写进 DECISION_LOG 的策略数，不能被子类改常量悄悄放大）`,
  AT_MAX_REFS === 5, String(AT_MAX_REFS));
// ⚠ 下面两条是**手段类**断言（钉结构不钉行为），共用一段"识别段函数体"的切片。
//   行为侧的对应断言是 A14/A16~A28（识别）与 B22~B27（组装）。
const parseBody = srcJudge.slice(
  srcJudge.indexOf('export function parseAtCandidates'),
  srcJudge.indexOf('export function looksLikePath'),
);

// ⚠ E10 原来写成"匹配整条语句"的正则（`if (text[i + 1] === '@') { i++; continue; }`）——
//   变异测试**照绿穿过去了**：那次变异把条件并成 `if (text[i] === '@' && text[i + 1] === '@')`，
//   语句整体变了样，正则认不出来。这类断言全部要问一句"换一种等价写法还认不认"。
//   所以改成宽式：**识别段里不许出现任何"看下一个字符是不是 `@`"的动作** —— 因为 `@@` 的安全性
//   由"`@` 在 STOP 里 + `@` 不在 BEFORE_OK 里"推导得来，一旦有人开始往后看，那两条就没人守了。
check('E10 `@@` 的安全性来自"位置判据 + `@` 在 STOP 里"，**不来自**识别段里某个专门分支'
+ '（变异证明那条分支是死代码，已删；断言写成宽式，免得换个写法就穿过去）',
  /\btext\s*\[\s*i\s*\+\s*1\s*\]\s*===\s*'@'/.test(parseBody) === false);

check('E11 两条通路（`@` 与裸路径）共用同一份收路径实现：识别段里不该再出现 STOP / TRAILING_JUNK 的直接使用',
  parseBody.includes('takePath(') && !parseBody.includes('STOP') && !parseBody.includes('TRAILING_JUNK'));

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑥ 行为证明：真 Runtime、真 onInput 链路
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 行为证明（真 Runtime 的 inputHandlers 链路）');

/** 造一个够 prompt() 走到"输入预处理"那一步的 Runtime（同 verify-projects 的手法） */
function makeRuntime(): Runtime {
  return new Runtime({
    llm: { chat: async () => ({ content: '' }), stream: () => { throw new Error('本脚本不触发 LLM'); } },
    session: { getHistory: () => [], clear: async () => {}, appendMessage: () => {} },
    tools: {
      getLLMTools: () => [], requiresPermission: () => false,
      execute: async () => ({ status: 'ok', content: '' }), register: () => {},
    },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} },
    skills: { load: () => {}, getAll: () => [], get: () => undefined },
    events: new PromptEventEmitter(),
    spanCollector: { collect: () => [], running: () => [] },
    commandSystem: { register: () => {}, list: () => [], execute: async () => null },
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction: { maybeCompact: async (m: unknown[]) => ({ compacted: false, messages: m }) },
    systemPromptService: { build: async () => ({ messages: [] }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-at-e2e-'));
try {
  fs.writeFileSync(path.join(dir2, 'target.ts'), 'export const TARGET = 1;');

  // F1/F2：用 **main.ts 交出去的那一个 handler**（同一个工厂，不是测试里复刻的副本）
  const rt = makeRuntime();
  let seen = '(没跑到)';
  rt.onInput(atFileInputHandler(() => dir2));
  rt.onInput((text) => { seen = text; return { action: 'handled' }; });

  await rt.prompt('看 @target.ts');
  check('F1 真 Runtime：handler 按注册顺序执行，前一个的 transform 真的传给后一个',
    seen.includes('[引用 1：target.ts]'), seen.slice(0, 60));
  check('F2 附件内容在链路末端真的在（不是只在纯函数里成立）',
    seen.includes('export const TARGET = 1;') && seen.includes(AT_HEADER));

  const rt2 = makeRuntime();
  let seen2 = '(没跑到)';
  rt2.onInput(atFileInputHandler(() => dir2));
  rt2.onInput((text) => { seen2 = text; return { action: 'handled' }; });
  await rt2.prompt('没有引用的普通一句话');
  check('F3 不含 @ 的输入走到链路末端时**逐字未改**（短路真的生效，不是"改了但看起来一样"）',
    seen2 === '没有引用的普通一句话');

  // F4：handler 吞掉输入的那条既有契约仍在（handled → prompt 返回空串）
  const rt3 = makeRuntime();
  rt3.onInput(() => ({ action: 'handled' }));
  const swallowed = await rt3.prompt('随便什么');
  check('F4 `handled` 语义未被本次接线破坏（吞掉输入 → 返回空串，不触发 LLM）', swallowed === '');

  // F5：cwd 是**回调**，不是创建时抓下来的字符串 ——
  //     项目切换会 chdir，抓死的那个会让"切完项目还读旧目录的文件"
  const rt4 = makeRuntime();
  let seen4 = '(没跑到)';
  let live = dir2;
  rt4.onInput(atFileInputHandler(() => live));
  rt4.onInput((text) => { seen4 = text; return { action: 'handled' }; });
  await rt4.prompt('看 @target.ts');
  check('F5 cwd 每次调用现取（第一次能读到）', seen4.includes('export const TARGET = 1;'));
  live = os.tmpdir();                       // 模拟切到一个没有 target.ts 的地方
  await rt4.prompt('看 @target.ts');
  check('F5b 换了 cwd 之后**立刻按新目录判**（证明没把 cwd 抓死在闭包里）',
    seen4.includes('export const TARGET = 1;') === false && seen4.includes('@target.ts'));

  // F6：拖入形态（整条输入一个 `@` 都没有）也要真的走到附件 ——
  //     这条是"短路只看 `@`"那个坑的行为侧回归：判据写错时纯函数侧一片绿，只有真链路照得出来。
  const rt5 = makeRuntime();
  let seen5 = '(没跑到)';
  rt5.onInput(atFileInputHandler(() => dir2));
  rt5.onInput((text) => { seen5 = text; return { action: 'handled' }; });
  await rt5.prompt(`看 ${path.join(dir2, 'target.ts')} 这段`);
  check('F6 真 Runtime：拖入形态（无 `@`）也注入附件，且正文里是它换来的占位符',
    seen5.includes('export const TARGET = 1;') && seen5.includes(AT_HEADER)
    && seen5.startsWith('看 [引用 1：'), seen5.slice(0, 60));
} finally {
  fs.rmSync(dir2, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
