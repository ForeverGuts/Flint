/**
 * 全量验证入口 —— 串跑 scripts/ 下所有 verify-*（.ts 走 tsx，.mjs 直跑）。
 *
 * 为什么要有它：这些脚本此前只能手工循环跑（TESTING.md 把"package.json 里没有
 * verify 入口"记成缺口），忘了跑就没有防线；`npm run verify` 一条命令解决，
 * 退出码可直接交给 CI。
 *
 * 采集口径（怎么算项数、解析不到怎么办）在 `collect-stats.mjs` 里，与 `docs-sync.mjs`
 * 共用同一份——否则"真值"会有两个版本，而真值分家正是生成区机制要消灭的东西。
 *
 * 末尾还会拿汇总出来的数字去核对 `Log/` 里写的「当前值」（`check-doc-numbers.mjs`，
 * 含生成区）。它**不算一套套件、也不计入合计**——否则"总项数对不对"会取决于"有没有把
 * 校验自己算进去"，成了自指。漂移只影响退出码，单独汇报。
 *
 * 末尾还有**第二把尺**：`.flint/` 的逐套对账（`ledgerDrift`，实现见 `collect-stats.mjs`）
 * ——**跑完账本必须一字未变**。它同样不算套件、不计入合计，漂移只影响退出码。
 * 起因：2026-09-19 查出两个套件把测试产物写进了真账本，累计 123 条，而全套断言全绿。
 *
 * 注意本进程**只读**：修正文档要显式跑 `npm run docs:sync`（见 autogen.mjs 头部 ③）。
 *
 * 运行：node scripts/run-verify.mjs   （或 npm run verify）
 */
import { collectStats } from './collect-stats.mjs';
import { checkDocNumbers } from './check-doc-numbers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let stats;
try {
  stats = collectStats(ROOT, { onFail: (_name, out) => console.log(out) });
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const { rows, suites, tsSuites, totalPass, totalFail, bad, unparsed, ledgerDrift } = stats;

const width = Math.max(...rows.map((r) => r.name.length));
console.log('\n套件'.padEnd(width + 8) + '通过 / 失败   退出码');
console.log('-'.repeat(width + 30));
for (const r of rows) {
  console.log(
    r.name.padEnd(width + 2)
    + `${r.pass} / ${r.fail}`.padEnd(13)
    + (r.ok ? '0' : '非 0  ← 失败'),
  );
}
console.log('-'.repeat(width + 30));
console.log(`合计 ${suites} 套：${totalPass} 通过 / ${totalFail} 失败`
  + (unparsed ? `（${unparsed} 套的结果行没解析出来，项数未计入合计）` : ''));
console.log(bad === 0 ? '全绿。' : `${bad} 套失败。`);

// 文档数字核对：拿上面汇总出来的真值，去比 Log/ 里写的「当前值」
// （白名单 + 生成区，见 check-doc-numbers.mjs 头注释）。
// 独立汇报、**不计入合计** —— 它自己的断言不能算进 totalPass，否则总项数就成了自指。
const docs = checkDocNumbers(ROOT, {
  suites,
  tsSuites,
  total: totalPass,
  rows,
});
if (docs.drift.length === 0) {
  console.log(`\n文档数字：${docs.checked} 处一致。`);
} else {
  console.log(`\n文档数字：${docs.drift.length} 处漂移 ——`);
  for (const d of docs.drift) console.log(`  ❌ ${d}`);
  console.log('（生成区那几处可跑 `npm run docs:sync` 自动修；手写处要自己改）');
}

// 账本对账：**跑完 `.flint/` 必须一字未变**。
// 与文档数字同属"第二把尺"（不是套件、不计入合计）。起因：2026-09-19 查出两个套件把测试
// 产物写进了真账本，累计 123 条，而**全套断言全绿** —— 脏数据没人看得见。
if (ledgerDrift.length === 0) {
  console.log('账本：套件跑完 .flint/ 一字未变。');
} else {
  console.log(`\n账本：${ledgerDrift.length} 套把测试产物写进了 .flint/ ——`);
  for (const d of ledgerDrift) for (const line of d.drift) console.log(`  ❌ ${d.name}: ${line}`);
  console.log('（这是项目资产被污染。修法是让那套开头调 scripts/lib/sandbox.ts 的 enterSandbox()，'
    + '别手工删条目了事 —— 不堵源头，下次跑还会脏。）');
}

process.exit(bad > 0 || totalFail > 0 || docs.drift.length > 0 || ledgerDrift.length > 0 ? 1 : 0);
