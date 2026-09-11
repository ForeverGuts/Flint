/**
 * 文档数字一致性校验（`scripts/check-doc-numbers.mjs`）的验证套件。
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
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-doc-numbers.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffDocNumbers, checkDocNumbers } from './check-doc-numbers.mjs';

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

const goodTesting = (): string => [
  '> 现状：**不用任何测试框架**。3 套零依赖验证脚本、合计 **100 项**断言，`npm run verify` 一条命令串跑；另有 1 个真实链路冒烟脚本。',
  '',
  '全部在 `scripts/` 下，**项数合计 100**（其中 2 套是 `.ts` 走 tsx、`verify-b.mjs` 一套直跑）：',
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
  '另有 `scripts/rpc-smoke.mjs`：起真子进程打真实 API。唯一会花钱的一项，不计入 100。',
  '',
  '全量 3 套，一条命令：',
  '',
  '单套。`.ts` 的 2 套**必须**直连 node 走 tsx——`npx tsx` 同样被执行策略挡住：',
  '',
  '- **无覆盖率统计**：100 项覆盖了什么、漏了什么，只能人工判断。',
].join('\n');

const goodArchitecture = (): string => [
  '| 测试 | vitest 全套 | **路线不同、且已定调**：3 套零依赖验证脚本、100 项断言（`npm run verify` 串跑）+ 1 个真实链路冒烟 |',
  '5. ✅ **`package.json` 的工程化缺口**（已补）。现有 `verify`（`run-verify.mjs` 串跑，现 3 套）/ `typecheck` / `clean` 三个入口。',
].join('\n');

const goodCatalog = (): string => [
  '| `scripts/` | 验证脚本（3 套断言共 100 项 + 基线 fixture + RPC 冒烟 + 串跑入口） | ✅ |',
  '│   ├── verify-a.ts        #   a 的功能面（60 项）',
  '│   ├── verify-b.mjs       #   b 的锚点检查（40 项，项数随文档引用浮动）',
].join('\n');

/** 已完成表按时间升序，末行才是「现在」；前一行是历史数字 */
const goodRoadmap = (): string => [
  '| **A** | 上一轮的东西，全库 2 套 50 项 |',
  '| **B** | 这一轮的东西，全库 3 套 100 项 |',
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
  check('确实比对了多处（不是空转）', r.checked >= 18, `checked=${r.checked}`);
}

/* ── D2 每一处「当前值」改错都必须被逮住 ── */

console.log('\nD2 逐处改错 → 各红一条（证明每一处都被真查）');
{
  // [说明, 文件, 原文, 改后, 期望漂移里出现的关键词, 期望命中条数]
  const cases: Array<[string, string, string, string, string, number]> = [
    ['TESTING 顶部 blockquote 的套数', 'TESTING.md', '3 套零依赖', '9 套零依赖', '顶部 blockquote', 1],
    ['TESTING 顶部 blockquote 的项数', 'TESTING.md', '**100 项**', '**999 项**', '顶部 blockquote', 1],
    ['TESTING 第二节「项数合计」', 'TESTING.md', '**项数合计 100**', '**项数合计 999**', '「项数合计」', 1],
    ['TESTING 第二节「其中 N 套是 .ts」', 'TESTING.md', '其中 2 套是', '其中 5 套是', '其中 N 套是 .ts', 1],
    ['TESTING 第二节 rpc-smoke「不计入 N」', 'TESTING.md', '不计入 100。', '不计入 999。', '不计入 N', 1],
    ['TESTING 第四节「全量 N 套」', 'TESTING.md', '全量 3 套，一条命令', '全量 9 套，一条命令', '全量 N 套', 1],
    ['TESTING 第七节「N 项覆盖了什么」', 'TESTING.md', '：100 项覆盖了什么', '：999 项覆盖了什么', 'N 项覆盖了什么', 1],
    ['ARCHITECTURE 第三节「测试」行（两个数字一起错）', 'ARCHITECTURE.md',
      '3 套零依赖验证脚本、100 项断言', '9 套零依赖验证脚本、999 项断言', '第三节「测试」行', 2],
    ['ARCHITECTURE 债 5 的「现 N 套」', 'ARCHITECTURE.md', '现 3 套', '现 9 套', '债 5', 1],
    ['目录职责表', '目录.md', '（3 套断言共 100 项', '（9 套断言共 999 项', '目录职责表', 2],
    ['ROADMAP 已完成表末行的套数', 'ROADMAP.md', '全库 3 套 100 项', '全库 9 套 100 项', '末行', 1],
    ['ROADMAP 已完成表末行的项数', 'ROADMAP.md', '全库 3 套 100 项', '全库 3 套 999 项', '末行', 1],
    ['TESTING 第四节「.ts 的 N 套」', 'TESTING.md', '`.ts` 的 2 套**必须**', '`.ts` 的 9 套**必须**', '.ts 的 N 套', 1],
    ['TESTING 第三节 assert 行的套数', 'TESTING.md', 'c1（1 套）', 'c1（9 套）', '第三节 assert', 1],
    ['TESTING 第三节 ok 行的套数', 'TESTING.md', 'c3（1 套）', 'c3（9 套）', '第三节 ok', 1],
    ['TESTING 退出码变体 gt 的套数', 'TESTING.md', '（1 套：a）', '（9 套：a）', '退出码变体 gt', 1],
    ['TESTING「N 套都会在有断言失败时返回非零」', 'TESTING.md', '**3 套都会在', '**9 套都会在', '返回非零', 1],
  ];
  for (const [desc, file, from, to, expect, count] of cases) {
    const hits = driftOf(mutate(file, from, to)).filter((d) => d.includes(expect));
    check(`${desc} 改错 → 红 ${count} 条`, hits.length === count, `实得 ${hits.length} 条：${hits.join(' | ')}`);
  }
}

/* ── D3 对照组：历史数字必须**不被**查 ── */

console.log('\nD3 对照组：历史数字不被查（这是白名单的全部理由）');
{
  check('ROADMAP 已完成表里**旧行**的旧数字（2 套 50 项）不被算作漂移',
    driftOf(goodTexts()).length === 0);

  const withLogs = goodTexts({
    'CHANGE_LOG.md': '2026-01-01 00:00 | [CI✅] 全量 5 套 **12 通过 / 0 失败**，共 7 套 3 项',
    'ARCHITECTURE_LOG.md': '同日全量 99 套 9999 项、`tsc` EXIT=0',
    'GLOSSARY.md': '词条里提到 42 套 4242 项',
  });
  check('追加日志与 GLOSSARY 里的数字根本不进比对范围（不在白名单里）',
    driftOf(withLogs).length === 0, driftOf(withLogs).join(' | '));
}

/* ── D4 对照组：ROADMAP 只认末行 ── */

console.log('\nD4 对照组：ROADMAP 取**末次**匹配');
{
  check('把旧行改成「999 套 999 项」仍然零漂移（若改成取首次匹配或全查，这条会红）',
    driftOf(mutate('ROADMAP.md', '全库 2 套 50 项', '全库 999 套 999 项')).length === 0);
}

/* ── D5 逐套项数：漏、多、不符 ── */

console.log('\nD5 逐套项数（TESTING 表格 / 目录.md 树两处各查一遍）');
{
  check('TESTING 表格里某项数写错 → 红',
    driftOf(mutate('TESTING.md', '| `verify-a.ts` | 60 |', '| `verify-a.ts` | 61 |'))
      .some((d) => d.includes('TESTING.md 的 verify-a.ts')));
  check('目录.md 树里某项数写错 → 红',
    driftOf(mutate('目录.md', 'a 的功能面（60 项）', 'a 的功能面（61 项）'))
      .some((d) => d.includes('目录.md 的 verify-a.ts')));
  check('TESTING 表格漏掉一整套 → 红',
    driftOf(mutate('TESTING.md', `\n${row('verify-b.mjs', 40)}`, ''))
      .some((d) => d.includes('TESTING.md 漏了 verify-b.mjs')));
  check('清单里列了本次没跑到的套件 → 红',
    driftOf(mutate('TESTING.md', '全量 3 套，一条命令', '全量 3 套，一条命令\n'
      + row('verify-ghost.ts', 1)))
      .some((d) => d.includes('列了 verify-ghost.ts')));
}

/* ── D6 缺文件 ── */

console.log('\nD6 白名单里的文件读不到');
{
  check('ARCHITECTURE.md 缺失 → 记成漂移而不是抛异常',
    driftOf(goodTexts({ 'ARCHITECTURE.md': null }))
      .some((d) => d.includes('ARCHITECTURE.md：读不到')));
}

/* ── D7 真仓库：白名单里那些位置**还找得到**吗 ── */

console.log('\nD7 真 Log/ ：白名单的每一处「当前值」都还在（文案被改写时这条会红）');
{
  // 数字故意全传 -1：本段只关心「找不找得到」，不关心「数字对不对」——后者由 run-verify
  // 用实时数字去做（它手里才有真值）。这里筛出的正是「正则匹配不上」这一类漂移。
  const real = checkDocNumbers(ROOT, { suites: -1, tsSuites: -1, total: -1, rows: [] });
  const missing = real.drift.filter((d) => /找不到|读不到/.test(d));
  check('白名单每一处都能在真文档里定位到', missing.length === 0, missing.join(' | '));
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

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
