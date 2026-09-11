/**
 * 全量验证入口 —— 串跑 scripts/ 下所有 verify-*（.ts 走 tsx，.mjs 直跑）。
 *
 * 为什么要有它：这些脚本此前只能手工循环跑（TESTING.md 把"package.json 里没有
 * verify 入口"记成缺口），忘了跑就没有防线；`npm run verify` 一条命令解决，
 * 退出码可直接交给 CI。
 *
 * 汇总口径：解析每套自己打印的"结果：N 通过 / M 失败"行拿到项数。这行有四种写法
 * 变体（分隔符 / 与 ，、有无"（共 N 项）"后缀），正则一并兼容；解析不到就按退出码
 * 判定成败、项数记为 ?，不会静默当成通过。
 *
 * 末尾还会拿汇总出来的数字去核对 `Log/` 里写的"当前值"（`check-doc-numbers.mjs`）。
 * 它**不算一套套件、也不计入合计**——否则"总项数对不对"会取决于"有没有把校验自己
 * 算进去"，成了自指。漂移只影响退出码，单独汇报一行。
 *
 * 运行：node scripts/run-verify.mjs   （或 npm run verify）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocNumbers } from './check-doc-numbers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!fs.existsSync(TSX)) {
  console.error(`找不到 tsx：${TSX}\n先跑 npm install。`);
  process.exit(1);
}

const files = fs.readdirSync(SCRIPTS)
  .filter((n) => /^verify-.+\.(ts|mjs)$/.test(n))
  .sort();

const rows = [];
let bad = 0;
let totalPass = 0;
let totalFail = 0;
let unparsed = 0;

for (const name of files) {
  const full = path.join(SCRIPTS, name);
  const args = name.endsWith('.ts') ? [TSX, full] : [full];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = /结果[：:]\s*(\d+)\s*通过\s*[/，,]\s*(\d+)\s*失败/.exec(out);
  const ok = r.status === 0;
  if (!ok) bad++;
  if (m) {
    totalPass += Number(m[1]);
    totalFail += Number(m[2]);
    rows.push({ name, pass: m[1], fail: m[2], ok });
  } else {
    unparsed++;
    rows.push({ name, pass: '?', fail: '?', ok });
  }
  // 失败时把原始输出打出来，否则只看到一行 ❌ 不知道错在哪
  if (!ok) console.log(out);
}

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
console.log(`合计 ${rows.length} 套：${totalPass} 通过 / ${totalFail} 失败`
  + (unparsed ? `（${unparsed} 套的结果行没解析出来，项数未计入合计）` : ''));
console.log(bad === 0 ? '全绿。' : `${bad} 套失败。`);

// 文档数字核对：拿上面汇总出来的真值，去比 Log/ 里写的「当前值」（白名单，见模块头注释）。
// 独立汇报、**不计入合计** —— 它自己的断言不能算进 totalPass，否则总项数就成了自指。
const docs = checkDocNumbers(ROOT, {
  suites: rows.length,
  tsSuites: files.filter((n) => n.endsWith('.ts')).length,
  total: totalPass,
  rows,
});
if (docs.drift.length === 0) {
  console.log(`\n文档数字：${docs.checked} 处一致。`);
} else {
  console.log(`\n文档数字：${docs.drift.length} 处漂移 ——`);
  for (const d of docs.drift) console.log(`  ❌ ${d}`);
}

process.exit(bad > 0 || totalFail > 0 || docs.drift.length > 0 ? 1 : 0);
