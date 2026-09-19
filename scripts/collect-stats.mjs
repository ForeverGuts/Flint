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
 *
 * 除套件外的**第二把尺**：逐套对账 `.flint/`（`ledgerDrift`）。起因是 2026-09-19 查出
 * `verify-grants` / `verify-workspace` 各跑一遍就往真账本里塞十几条审计，累计 123 条 ——
 * 而**没有任何断言看得见**（审计落盘失败静默 + 套件全绿）。修法是让每套自己进沙箱
 * （`scripts/lib/sandbox.ts`，那是"闸"）；这里再加一道"网"：**跑完账本必须一字未变**。
 * 两把尺分工——闸在写之前拦、只拦得住在册的那几套；网在跑完之后逐套点名，**谁写的一目了然，
 * 连闸不认识的通路（spawn 出去的子进程自己 cwd）也兜得住**。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** `.flint/` 的快照：相对路径（相对 `.flint/`）→ `字节数:sha1 前 12 位`，含"文件在不在"这一层 */
export function snapshotLedger(ROOT) {
  const snap = new Map();
  const walk = (dir, rel) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 = 空快照（正常：刚 clone 下来还没有 .flint/）
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      const r = rel === '' ? it.name : `${rel}/${it.name}`;
      if (it.isDirectory()) walk(p, r);
      else {
        try {
          snap.set(r, `${fs.readFileSync(p).length}:${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12)}`);
        } catch {
          snap.set(r, '?');
        }
      }
    }
  };
  walk(path.join(ROOT, '.flint'), '');
  return snap;
}

/** 两次快照之间的差异（人话版）：`新增 x` / `x 被改写` / `删除 x` */
export function diffLedger(before, after) {
  const out = [];
  for (const [k, v] of after) {
    if (!before.has(k)) out.push(`新增 ${k}`);
    else if (before.get(k) !== v) out.push(`${k} 被改写`);
  }
  for (const k of before.keys()) if (!after.has(k)) out.push(`删除 ${k}`);
  return out;
}

/**
 * @param {string} ROOT 仓库根目录
 * @param {{onFail?: (name: string, output: string) => void}} [opts]
 *   `onFail` 在某一套失败时被调用，用来现场打印原始输出（长跑时能看见进度；
 *   `docs-sync` 不需要，就不传）。
 * @returns {{
 *   files: string[], rows: Array<{name: string, pass: string|number, fail: string|number, ok: boolean}>,
 *   suites: number, tsSuites: number,
 *   totalPass: number, totalFail: number, bad: number, unparsed: number,
 *   ledgerDrift: Array<{name: string, drift: string[]}>,
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
  const ledgerDrift = [];
  let bad = 0;
  let totalPass = 0;
  let totalFail = 0;
  let unparsed = 0;

  for (const name of files) {
    const full = path.join(SCRIPTS, name);
    const args = name.endsWith('.ts') ? [TSX, full] : [full];
    const ledgerBefore = snapshotLedger(ROOT);
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
    const drift = diffLedger(ledgerBefore, snapshotLedger(ROOT));
    if (drift.length > 0) ledgerDrift.push({ name, drift });
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
    ledgerDrift,
  };
}
