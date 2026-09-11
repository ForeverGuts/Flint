/**
 * 实测真值采集器 —— 串跑 `scripts/` 下所有 `verify-*`，汇总出「现在到底有多少套、多少项」。
 *
 * 为什么单独成模块：有两个消费者，且它们**必须拿到同一份真值**——
 *   - `scripts/run-verify.mjs`（`npm run verify`）：打印逐套表 + 核对文档数字（只读）。
 *   - `scripts/docs-sync.mjs`（`npm run docs:sync`）：把这份真值写进 `Log/` 的生成区。
 * 抄成两份的话，两边的"真值"迟早分家；而"真值分家"正是整个生成区机制要消灭的东西。
 *
 * 口径与历史一致（别顺手改）：解析每套自己打印的 `结果：N 通过 / M 失败`。这行有四种分隔符
 * 变体（`/` 与 `，`）、也有无「（共 N 项）」后缀的，正则一并兼容；**解析不到就按退出码判成败、
 * 项数记 `?`**，绝不静默当成通过。别拿"进程退出码为 0"当项数依据——那只说明没红，不说明跑了多少。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} ROOT 仓库根目录
 * @param {{onFail?: (name: string, output: string) => void}} [opts]
 *   `onFail` 在某一套失败时被调用，用来现场打印原始输出（长跑时能看见进度；
 *   `docs-sync` 不需要，就不传）。
 * @returns {{
 *   files: string[], rows: Array<{name: string, pass: string|number, fail: string|number, ok: boolean}>,
 *   suites: number, tsSuites: number,
 *   totalPass: number, totalFail: number, bad: number, unparsed: number,
 * }}
 */
export function collectStats(ROOT, opts = {}) {
  const SCRIPTS = path.join(ROOT, 'scripts');
  const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  if (!fs.existsSync(TSX)) {
    throw new Error(`找不到 tsx：${TSX}\n先跑 npm install。`);
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
    if (!ok) opts.onFail?.(name, out);
  }

  return {
    files,
    rows,
    suites: rows.length,
    tsSuites: files.filter((n) => n.endsWith('.ts')).length,
    totalPass,
    totalFail,
    bad,
    unparsed,
  };
}
