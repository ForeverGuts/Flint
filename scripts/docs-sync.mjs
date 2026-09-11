/**
 * `npm run docs:sync` —— 把 `Log/` 里**生成区**（AUTOGEN 区块）按实测真值重写。
 *
 * 为什么它是**单独的**一条命令、而不是让 `npm run verify` 顺手改文件：见 `autogen.mjs` 头部
 * ③。一句话——`verify` 只读（CI 里只检查、只报红），写盘必须是人显式按下去的。
 *
 * 为什么它要**真跑一遍验证套件**：生成区里的数字必须来自"这一秒的真实结果"，不能来自缓存
 * 文件（缓存会过期，而过期的数字正是这套机制要消灭的东西）。代价是它和 `npm run verify`
 * 一样慢——这是刻意的：宁可慢，不要一个看起来新、其实是旧的数。
 *
 * 行为：
 *   1. 跑全部 `verify-*`，拿真值；
 *   2. 对 `AUTOGEN_FILES` 逐份算出正确内容；
 *   3. **有结构错误就拒绝写盘**（标记不配对 / id 未知）——这时不该猜，也不该"尽力而为"地
 *      写一半，那只会把一个明确的报错变成一份混乱的文档；
 *   4. 否则写回，并把改了哪几处打出来。没有改动就明说"已是最新"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectStats } from './collect-stats.mjs';
import { AUTOGEN_FILES, syncText } from './autogen.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let stats;
try {
  stats = collectStats(ROOT);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

if (stats.bad > 0 || stats.totalFail > 0) {
  console.error(
    `验证套件没全绿（${stats.bad} 套失败 / ${stats.totalFail} 项断言失败），`
    + '拒绝同步文档 —— 拿一份红的实测值去写文档，等于把错误固化进"当前值"。',
  );
  process.exit(1);
}

let changedTotal = 0;
let errorTotal = 0;

for (const file of AUTOGEN_FILES) {
  const full = path.join(ROOT, 'Log', file);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    console.error(`读不到 Log/${file}`);
    errorTotal++;
    continue;
  }

  const { next, drift, errors, changed } = syncText(text, stats);

  if (errors.length > 0) {
    console.error(`\nLog/${file} 的生成区有结构问题，**未写盘**：`);
    for (const e of errors) console.error(`  ✖ ${e}`);
    errorTotal += errors.length;
    continue;
  }

  if (changed === 0) {
    console.log(`Log/${file}：${drift.length === 0 ? '生成区已是最新，无改动。' : ''}`);
    continue;
  }

  fs.writeFileSync(full, next);
  changedTotal += changed;
  console.log(`\nLog/${file}：同步了 ${changed} 处生成区`);
  for (const d of drift) console.log(`  · ${d}`);
}

if (errorTotal > 0) {
  console.error(`\n${errorTotal} 个结构问题未处理，请先修好标记再跑。`);
  process.exit(1);
}

console.log(
  `\n实测真值：${stats.suites} 套 / ${stats.totalPass} 项`
  + `（其中 ${stats.tsSuites} 套 .ts）`
  + `；本次改动 ${changedTotal} 处。`,
);
