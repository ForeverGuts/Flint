/**
 * 文档数字一致性校验（`scripts/check-doc-numbers.mjs` + `scripts/autogen.mjs`）的验证套件。
 *
 * 为什么它自己也要算一套：那套判定逻辑是「正则 + 白名单」，而**正则写窄了、白名单漏了一处**，
 * 症状都是"静默全绿"——正是本项目反复强调的假绿（一旦某处不再被扫到，它就从"一致"变成
 * "没人看"）。所以每一处「当前值」都必须有一条用例证明"把它改错就会被逮住"。
 *
 * 为什么这些用例不拿真仓库的文档来造红：把真 `Log/` 写错来制造红，代价是真文档被写坏
 * （忘了改回来就是事故）。所以纯函数 `diffDocNumbers` 接受**合成文档**，用例全在内存里造，
 * 一个字节都不碰真仓库。真仓库只验一件事（D7）：白名单里那些位置**还找得到**——
 * 文案被改写成别的样子时，这条会红。
 *
 * **生成区那一半为什么要单独钉**（D9）：`docs-sync` 与校验用的是**同一个渲染器**，这正是
 * `gofmt` 的做法（写与查共用一份模板），好处是两边不会分家；**代价是"渲染器本身写错"时
 * 两边会一起错、且完全静默**。所以 D9 拿**手写的期望字符串**去钉渲染器的输出——绝不让它
 * 自己证明自己。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-doc-numbers.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffDocNumbers, checkDocNumbers } from './check-doc-numbers.mjs';
import { syncText, findRegions, RENDERERS, AUTOGEN_FILES } from './autogen.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/* ── 合成文档 ── */

/** 实测数字（合成）：3 套、合计 100 项、其中 2 套是 .ts */
const ACTUAL = {
  suites: 3,
  tsSuites: 2,
  total: 100,
  names: { assert: 1, check: 1, ok: 1 },
  exits: { timeout: 1, eq: 0, gt: 1, if: 1 },
  rows: [
    { name: 'verify-a.ts', pass: '60' },
    { name: 'verify-b.mjs', pass: '40' },
  ],
};

const row = (name: string, n: number): string => `| \`${name}\` | ${n} | 验什么 | 手法 |`;

/** 合成文档里的两处生成区（内容按 ACTUAL 渲染，所以初始状态是"已同步"） */
const REGION_SUMMARY =
  '<!-- BEGIN AUTOGEN:test-summary -->3 套零依赖验证脚本、合计 **100 项**断言<!-- END AUTOGEN:test-summary -->';
const REGION_COUNTS =
  '<!-- BEGIN AUTOGEN:test-counts -->**项数合计 100**（其中 2 套是 `.ts` 走 tsx、1 套 `.mjs` 直跑）<!-- END AUTOGEN:test-counts -->';

const goodTesting = (): string => [
  `> 现状：**不用任何测试框架**。${REGION_SUMMARY}，\`npm run verify\` 一条命令串跑；另有 1 个真实链路冒烟脚本。`,
  '',
  `全部在 \`scripts/\` 下，${REGION_COUNTS}。其中 \`verify-b.mjs\` 为 2026-09-11 新增：`,
  '',
  row('verify-a.ts', 60),
  row('verify-b.mjs', 40),
  '',
  '| 名字 | 签名 | 哪几套 |',
  '|------|------|--------|',
  '| `assert` | `(name, cond, detail = \'\')` | c1（1 套） |',
  '| `check` | `(name, cond, detail?)` | c2（1 套） |',
  '| `ok` | `(name, cond)` | c3（1 套） |',
  '',
  '**退出码行为一致、写法有四种变体**：`setTimeout(() => process.exit(failed > 0 ? 1 : 0), 100)`（1 套，留给异步句柄收尾）、`process.exit(failed === 0 ? 0 : 1)`（0 套）、`process.exit(failed > 0 ? 1 : 0)`（1 套：a）、`if (failed > 0) process.exit(1)`（1 套）。**3 套都会在有断言失败时返回非零**，所以串跑靠退出码判定是安全的。',
  '',
  '另有 `scripts/rpc-smoke.mjs`：起真子进程打真实 API。唯一会花钱的一项，**不计入上面的项数合计**。',
  '',
  '全量 3 套，一条命令：',
  '',
  '单套。`.ts` 的 2 套**必须**直连 node 走 tsx——`npx tsx` 同样被执行策略挡住：',
  '',
  '- **无覆盖率统计**：100 项覆盖了什么、漏了什么，只能人工判断。',
  '其余 2 套的项数是固定的。',
].join('\n');

// 下面三份刻意写着**离谱的假数字**：它们是 D3 的对照组——去重之后，这三份已不再"断言现在是
// 多少"，所以里面的数字**必须不被查**（真去扫它们，就是又要人肉同步一遍，去重白做）。
const goodArchitecture = (): string => [
  '| 测试 | vitest 全套 | 零依赖验证脚本（`npm run verify` 串跑）；**套数与项数不在此重述**，见 TESTING.md |',
  '| 假数据 | 对照 | 这段写着 999 套 9999 项，但它不是"当前值"，不该被查 |',
].join('\n');

const goodCatalog = (): string => [
  '| `scripts/` | 验证脚本（套数与项数**不在此重述**，唯一口径见 TESTING.md） | ✅ |',
  '│   ├── verify-a.ts        #   a 的功能面',
  '│   ├── verify-b.mjs       #   b 的锚点检查',
  '│   # 对照：这行写着 777 项，去重后不再被查',
].join('\n');

/** 已完成表按时间升序；这一份整表已被声明为**历史记账**，故一律不查（含最后一行） */
const goodRoadmap = (): string => [
  '| **A** | 上一轮的东西，全库 2 套 50 项 |',
  '| **B** | 这一轮的东西，全库 3 套 100 项 |',
  '| **C** | 去重之后新行不再写全库口径 |',
].join('\n');

function goodTexts(over: Record<string, string | null> = {}): Record<string, string | null> {
  return {
    'TESTING.md': goodTesting(),
    'ARCHITECTURE.md': goodArchitecture(),
    '目录.md': goodCatalog(),
    'ROADMAP.md': goodRoadmap(),
    ...over,
  };
}

/** 在 goodTexts 上换掉一处片段（找不到就抛，避免用例悄悄失效） */
function mutate(file: string, from: string, to: string): Record<string, string | null> {
  const texts = goodTexts();
  const before = texts[file] as string;
  if (!before.includes(from)) throw new Error(`用例写错了：${file} 里没有 ${JSON.stringify(from)}`);
  return goodTexts({ [file]: before.replace(from, to) });
}

const driftOf = (texts: Record<string, string | null>) => diffDocNumbers(texts, ACTUAL).drift;

console.log('\nD0 模块形状');
check('导出 diffDocNumbers（纯函数）与 checkDocNumbers（IO 包装）',
  typeof diffDocNumbers === 'function' && typeof checkDocNumbers === 'function');
check('导出生成区的 syncText / findRegions / RENDERERS / AUTOGEN_FILES',
  typeof syncText === 'function' && typeof findRegions === 'function'
  && typeof RENDERERS === 'object' && Array.isArray(AUTOGEN_FILES));
check('checkDocNumbers 对不存在的根目录不抛，而是记成漂移',
  (() => {
    try {
      return checkDocNumbers(path.join(ROOT, '__no_such_dir__'), ACTUAL).drift.length > 0;
    } catch {
      return false;
    }
  })());

/* ── D1 全对时零漂移 ── */

console.log('\nD1 合成文档全对 → 零漂移');
{
  const r = diffDocNumbers(goodTexts(), ACTUAL);
  check('零漂移', r.drift.length === 0, r.drift.join(' | '));
  // 16 = 第二节「其余 N 套」1 处 + 第四节 3 处 + 第三节写法 3 处 + 退出码 5 处 + 逐套 2 行 + 生成区 2 处。
  // 用**等值**而不是 `>=`：报少了说明有一处被静默漏扫（假绿），那正是本套最该拦住的事。
  check('确实比对了 16 处（不是空转）', r.checked === 16, `checked=${r.checked}`);
}

/* ── D2 每一处「当前值」改错都必须被逮住 ── */

console.log('\nD2 逐处改错 → 各红一条（证明每一处都被真查）');
{
  // [说明, 文件, 原文, 改后, 期望漂移里出现的关键词, 期望命中条数]
  const cases: Array<[string, string, string, string, string, number]> = [
    ['TESTING 第四节「全量 N 套」', 'TESTING.md', '全量 3 套，一条命令', '全量 9 套，一条命令', '全量 N 套', 1],
    ['TESTING 第四节「.ts 的 N 套」', 'TESTING.md', '`.ts` 的 2 套**必须**', '`.ts` 的 9 套**必须**', '.ts 的 N 套', 1],
    ['TESTING 第七节「N 项覆盖了什么」', 'TESTING.md', '：100 项覆盖了什么', '：999 项覆盖了什么', 'N 项覆盖了什么', 1],
    ['TESTING 第二节「其余 N 套的项数是固定的」', 'TESTING.md', '其余 2 套的项数是固定的', '其余 9 套的项数是固定的', '其余 N 套', 1],
    ['TESTING 第三节 assert 行的套数', 'TESTING.md', 'c1（1 套）', 'c1（9 套）', '第三节 assert', 1],
    ['TESTING 第三节 check 行的套数', 'TESTING.md', 'c2（1 套）', 'c2（9 套）', '第三节 check', 1],
    ['TESTING 第三节 ok 行的套数', 'TESTING.md', 'c3（1 套）', 'c3（9 套）', '第三节 ok', 1],
    ['TESTING 退出码变体 timeout 的套数', 'TESTING.md', '（1 套，留给异步句柄收尾）', '（9 套，留给异步句柄收尾）', '变体 timeout', 1],
    ['TESTING 退出码变体 eq 的套数', 'TESTING.md', '（0 套）', '（8 套）', '变体 eq', 1],
    ['TESTING 退出码变体 gt 的套数', 'TESTING.md', '（1 套：a）', '（9 套：a）', '变体 gt', 1],
    ['TESTING 退出码变体 if 的套数', 'TESTING.md', '（1 套）。**3 套都会', '（9 套）。**3 套都会', '变体 if', 1],
    ['TESTING「N 套都会在有断言失败时返回非零」', 'TESTING.md', '**3 套都会在', '**9 套都会在', '返回非零', 1],
    ['生成区 test-summary 的套数', 'TESTING.md', '3 套零依赖验证脚本', '9 套零依赖验证脚本', '生成区「test-summary」', 1],
    ['生成区 test-summary 的项数', 'TESTING.md', '合计 **100 项**断言', '合计 **999 项**断言', '生成区「test-summary」', 1],
    ['生成区 test-counts 的项数', 'TESTING.md', '**项数合计 100**', '**项数合计 999**', '生成区「test-counts」', 1],
    ['生成区 test-counts 的 .ts 套数', 'TESTING.md', '其中 2 套是 `.ts`', '其中 7 套是 `.ts`', '生成区「test-counts」', 1],
  ];
  for (const [desc, file, from, to, expect, count] of cases) {
    const hits = driftOf(mutate(file, from, to)).filter((d) => d.includes(expect));
    check(`${desc} 改错 → 红 ${count} 条`, hits.length === count, `实得 ${hits.length} 条：${hits.join(' | ')}`);
  }
}

/* ── D3 对照组：去重后不再重述当前值的文档，里面的数字必须**不被**查 ── */

console.log('\nD3 对照组：引用式文档 + 追加日志里的数字不进比对（这是白名单的全部理由）');
{
  check('ARCHITECTURE / 目录 / ROADMAP 里那些假数字（999 套 / 777 项）零漂移',
    driftOf(goodTexts()).length === 0);

  const withLogs = goodTexts({
    'CHANGE_LOG.md': '2026-01-01 00:00 | [CI✅] 全量 5 套 **12 通过 / 0 失败**，共 7 套 3 项',
    'ARCHITECTURE_LOG.md': '同日全量 99 套 9999 项、`tsc` EXIT=0',
    'GLOSSARY.md': '词条里提到 42 套 4242 项',
  });
  check('追加日志与 GLOSSARY 里的数字根本不进比对范围（不在白名单里）',
    driftOf(withLogs).length === 0, driftOf(withLogs).join(' | '));
}

/* ── D4 对照组：ROADMAP 已完成表整表不查（含末行） ── */

console.log('\nD4 对照组：ROADMAP 已完成表已改判为历史记账，整表不查');
{
  // 这条是 2026-09-11 去重的直接后果：此前要**特判取末行**，因为末行恰好=现状；但"改一次测试
  // 就得回头改写历史行"本身就是设计味道。现在连末行也不查了——新行干脆不写全库口径。
  check('把末行改成「999 套 9999 项」仍然零漂移（若又变回"只认末行"，这条会红）',
    driftOf(mutate('ROADMAP.md', '全库 3 套 100 项', '全库 999 套 9999 项')).length === 0);
}

/* ── D5 逐套项数：只在 TESTING 的套件表格里 ── */

console.log('\nD5 逐套项数（去重后唯一落点是 TESTING 的套件表格）');
{
  check('TESTING 表格里某项数写错 → 红',
    driftOf(mutate('TESTING.md', '| `verify-a.ts` | 60 |', '| `verify-a.ts` | 61 |'))
      .some((d) => d.includes('TESTING.md 的 verify-a.ts')));
  check('TESTING 表格漏掉一整套 → 红',
    driftOf(mutate('TESTING.md', `\n${row('verify-b.mjs', 40)}`, ''))
      .some((d) => d.includes('TESTING.md 漏了 verify-b.mjs')));
  check('清单里列了本次没跑到的套件 → 红',
    driftOf(mutate('TESTING.md', '全量 3 套，一条命令', '全量 3 套，一条命令\n'
      + row('verify-ghost.ts', 1)))
      .some((d) => d.includes('列了 verify-ghost.ts')));
  check('目录.md 的 scripts/ 树里写项数不再被查（已去重）',
    driftOf(mutate('目录.md', 'b 的锚点检查', 'b 的锚点检查（40 项）')).length === 0);
}

/* ── D6 缺文件 ── */

console.log('\nD6 白名单/生成区里的文件读不到');
{
  check('TESTING.md 缺失 → 记成漂移而不是抛异常',
    driftOf(goodTexts({ 'TESTING.md': null }))
      .some((d) => d.includes('TESTING.md：读不到')));
}

/* ── D7 真仓库：白名单里那些位置**还找得到**吗 ── */

console.log('\nD7 真 Log/ ：白名单的每一处「当前值」与每个生成区都还在（文案被改写时这条会红）');
{
  // 数字故意全传 -1：本段只关心「找不找得到」，不关心「数字对不对」——后者由 run-verify
  // 用实时数字去做（它手里才有真值）。这里筛出的正是「正则匹配不上」这一类漂移。
  const real = checkDocNumbers(ROOT, { suites: -1, tsSuites: -1, total: -1, rows: [] });
  const missing = real.drift.filter((d) => /找不到|读不到|结构问题/.test(d));
  check('白名单每一处 + 每个生成区都能在真文档里定位到', missing.length === 0, missing.join(' | '));
}

/* ── D8 结构不变量：四种退出码写法必须覆盖全部套件 ── */

console.log('\nD8 结构不变量（script 层的事实，不是文档写的）');
{
  // 这条不谈文档，谈脚本自己：若 `scanSuiteStyles` 的某个正则写窄了、认不出某种写法，
  // 那套就会被静默漏掉、四变体之和也不再等于套件数。变异测试正是靠它发现"少认了一种"。
  check('退出码变体覆盖不齐（有一种写法没被 scanSuiteStyles 认出来）→ 红',
    diffDocNumbers(goodTexts(), { ...ACTUAL, exits: { timeout: 1, eq: 0, gt: 1, if: 0 } })
      .drift.some((d) => d.includes('只覆盖 2 套')));
}

/* ── D9 生成区：渲染器输出用手写期望值钉死 + 结构与幂等 ── */

console.log('\nD9 生成区（写与查共用渲染器，所以必须单独钉渲染器本身）');
{
  const s = { suites: 3, tsSuites: 2, totalPass: 100 };

  // ① 拿**手写**的期望字符串钉渲染器输出。绝不能用 RENDERERS 自比——那正是"生成器与校验器
  //    一起错"的静默场景。
  check('test-summary 渲染输出逐字正确',
    RENDERERS['test-summary'](s) === '3 套零依赖验证脚本、合计 **100 项**断言',
    RENDERERS['test-summary'](s));
  check('test-counts 渲染输出逐字正确',
    RENDERERS['test-counts'](s) === '**项数合计 100**（其中 2 套是 `.ts` 走 tsx、1 套 `.mjs` 直跑）',
    RENDERERS['test-counts'](s));
  check('test-counts 的 .mjs 套数是减出来的（3 - 2 = 1）',
    RENDERERS['test-counts']({ suites: 5, tsSuites: 4, totalPass: 9 }).includes('1 套 `.mjs` 直跑'));

  // ② 结构问题必须记成 errors（docs-sync 据此**拒绝写盘**），不能当成普通漂移"尽力修"
  const noEnd = syncText('<!-- BEGIN AUTOGEN:test-counts -->x', s);
  check('BEGIN 没有 END → errors（不是 drift）',
    noEnd.errors.some((e) => e.includes('标记不配对')), noEnd.errors.join(' | '));

  const crossed = syncText('<!-- BEGIN AUTOGEN:test-summary -->y<!-- END AUTOGEN:test-counts -->', s);
  check('区段 id 串了（BEGIN a 配到 END b）→ errors',
    crossed.errors.some((e) => e.includes('区段 id 串了')), crossed.errors.join(' | '));

  const unknown = syncText('<!-- BEGIN AUTOGEN:no-such-id -->z<!-- END AUTOGEN:no-such-id -->', s);
  check('未知 id → errors（docs-sync 没有对应渲染器，不能猜）',
    unknown.errors.some((e) => e.includes('未知的生成区 id')), unknown.errors.join(' | '));

  const none = syncText('这里一个标记都没有。', s);
  check('一个生成区都没有 → errors（标记被整段删掉了）',
    none.errors.some((e) => e.includes('一个生成区都没有')), none.errors.join(' | '));

  // ③ 幂等：同步过的文本再同步不该有任何改动（否则 `docs-sync` 会一直"改"同一个文件）
  const once = syncText(goodTesting(), s);
  const twice = syncText(once.next, s);
  check('syncText 幂等（第二次零改动）', twice.changed === 0, `第二次 changed=${twice.changed}`);
  check('第一次确实改动了 0 处（合成文档本来就是同步好的）', once.changed === 0, `changed=${once.changed}`);

  const stale = syncText(goodTesting().replace('合计 **100 项**断言', '合计 **1 项**断言'), s);
  check('内容过期 → 一次改动 1 处、且 drift 点名',
    stale.changed === 1 && stale.drift.some((d) => d.includes('test-summary')));

  // ④ 只替换内容、不碰标记；行内区段不被撑成多行
  const fixed = syncText(goodTesting().replace('合计 **100 项**断言', '合计 **1 项**断言'), s).next;
  check('标记原样保留', fixed.includes('<!-- BEGIN AUTOGEN:test-summary -->')
    && fixed.includes('<!-- END AUTOGEN:test-summary -->'));
  check('行内区段没被撑成多行（内容仍与前后文同行）',
    fixed.includes('<!-- END AUTOGEN:test-summary -->，`npm run verify` 一条命令串跑')
    && fixed.split('\n').length === goodTesting().split('\n').length, '行内空白没保住');
  check('findRegions 在两个相邻区段处不会吞成一个（非贪婪）',
    findRegions(goodTesting()).length === 2, `实得 ${findRegions(goodTesting()).length}`);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
