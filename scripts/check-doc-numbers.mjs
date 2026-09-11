/**
 * 文档数字一致性校验 —— `Log/` 里那些「当前真值」类数字与实测是否相符。
 *
 * 为什么需要它：`套数 / 项数` 这类"现在是多少"的事实，一旦被**手抄**到多处，改一次测试就得
 * 人肉同步七八个数字，漏一个就漂。而 `verify-docs.mjs` 只管锚点、**不管数字** —— 这是整套
 * 文档体系里唯一没有机器兜底的地方。历史证明它会漂：653 / 633 / 605 三个数字曾同时躺在不同
 * 文件里；2026-09-11 一次小小的改动就制造了 18 处漂移。
 *
 * ── 2026-09-11 第二轮：白名单从 23 处收缩到 11 处 ──
 * 上一轮的做法是"把每一处手抄都加进白名单看着"。那治的是症状。真正的病是**同一个事实被抄了
 * 太多份**，所以这一轮分两路收口：
 *   - **去重（L1）**：手抄的副本改成**引用**。`ARCHITECTURE.md` 的测试行与债 5、`目录.md` 的
 *     职责表与 scripts/ 树的逐套项数、`ROADMAP.md` 已完成表末行，都不再重述当前口径，只指向
 *     TESTING.md。它们的白名单条目随之**整段删掉**（本文件里已无这些 at()）。
 *   - **生成区（L2）**：剩下的必须出现、且算得出来的数字（套数 / 项数）交给 AUTOGEN 区块，
 *     由 `npm run docs:sync` 从实测真值写入，人不再碰 —— 见下面 ④ 段与 `scripts/autogen.mjs`。
 *
 * 为什么"引用"能替代"看着"：`ROADMAP` 的已完成表此前要**特判取末行**（它是穿着快照外衣的
 * 追加日志），那个特例本身就是设计味道；现在它整表被声明为**历史记账**，特例连根消失。
 *
 * 为什么**剩下的**必须是白名单、不能全库扫：`\d+ 套 / \d+ 项` 在追加日志里随处可见，那些是
 * **历史事实**（"当时全量 556 项"），改了才是篡改历史快照。盲扫会让本校验永久红，而永久红的
 * 检查等于没有。同一条推理 `verify-docs.mjs` 头部也写过一次（它为什么不去查"文档里提到的文件
 * 是否存在"）。
 *
 * 为什么它不算一套 `verify-*` 套件：① 名字用 `check-` 前缀，不匹配 run-verify 的
 * `^verify-.+\.(ts|mjs)$`，不会被当成第 N 套重复跑；② 它的断言**不计入** `totalPass` ——
 * 否则"总项数对不对"会取决于"你有没有把校验自己算进去"，成了自指。它由 run-verify 在汇总
 * 之后调用，独立汇报一行。
 *
 * 单独运行没有意义（它需要 run-verify 手里的实测数字）。要跑就跑 `npm run verify`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { AUTOGEN_FILES, syncText } from './autogen.mjs';

/**
 * 还需要手抄、因而需要被看着的文档。
 *
 * 2026-09-11 第二轮从四份缩到**一份**：`ARCHITECTURE.md` / `目录.md` / `ROADMAP.md` 里的当前
 * 口径已全部改成引用或（随文档一起）删除，不再有"断言现在是多少"的句子，于是没什么可查的了。
 */
const WATCHED = ['TESTING.md'];

/** TESTING.md 的套件表格：`| \`verify-x.ts\` | 17 | ... |`。逐套项数现在**只有这一处**。 */
function suitesInTesting(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^\| `(verify-[\w.-]+\.(?:ts|mjs))` \| (\d+) \|/.exec(line);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

/**
 * 纯函数：喂给它「文档文本」和「实测数字」，吐出漂移清单。
 * 文本用 `{ 文件名 → 内容 }` 传、读不到用 `null` —— 这样才能在验证脚本里用合成文档测它
 * （不用去改真仓库的文档来制造红）。
 *
 * @param {Record<string, string|null>} texts
 * @param {{suites: number, tsSuites: number, total: number, rows: Array<{name: string, pass: string|number}>, names?: any, exits?: any}} actual
 * @returns {{checked: number, drift: string[]}}
 */
export function diffDocNumbers(texts, actual) {
  const drift = [];
  let checked = 0;

  const textOf = (file) => (typeof texts[file] === 'string' ? texts[file] : null);

  /** 一处（可含多个数字的）当前值：第 i 个捕获组必须等于 expects[i] */
  const at = (file, re, label, expects) => {
    const text = textOf(file);
    if (text === null) {
      drift.push(`${file}：读不到，无法比对「${label}」`);
      return;
    }
    const m = re.exec(text);
    if (!m) {
      drift.push(`${file}：找不到「${label}」——文案改过了，还是这一处被删了？`);
      return;
    }
    expects.forEach((want, i) => {
      checked++;
      const got = Number(m[i + 1]);
      if (got !== want) drift.push(`${file} 的「${label}」写 ${got}，实际 ${want}`);
    });
  };

  /* ── ① TESTING 里仍然手抄的总额类当前值 ── */
  // 顶部 blockquote 与第二节的统计数字**已改成生成区**，不在这里查（见 ④ 段）。
  // 留下的三处是散在正文里、句式各不相同的句子，划生成区会把句子切碎，得不偿失。

  at('TESTING.md', /全量 (\d+) 套，一条命令/, '第四节「全量 N 套，一条命令」', [actual.suites]);
  at('TESTING.md', /的 (\d+) 套\*\*必须\*\*直连 node 走 tsx/, '第四节「.ts 的 N 套必须直连 node」',
    [actual.tsSuites]);
  at('TESTING.md', /\*\*无覆盖率统计\*\*：(\d+) 项覆盖了什么/, '第七节「N 项覆盖了什么」', [actual.total]);

  /* ── ② TESTING 第三节：写法分布（断言函数名 / 退出码变体） ── */

  // 这一节写的也是「当前真值」。它此前没被机器看着，而**本轮实测它已经错了**：
  // 「`if (failed > 0) process.exit(1)`（1 套）」实际是 2 套（phase-ab 与 steering），
  // 而四个变体之和 5+3+7+1=16 恰好等于当时的 .ts 套件数——错得很安静。所以纳入。
  if (actual.names) {
    const text = textOf('TESTING.md');
    if (text === null) {
      drift.push('TESTING.md：读不到，无法比对「第三节写法分布」');
    } else {
      for (const fn of ['assert', 'check', 'ok']) {
        const line = text.split('\n').find((l) => l.startsWith(`| \`${fn}\` |`));
        if (!line) {
          drift.push(`TESTING.md：找不到「第三节 ${fn} 那一行」`);
          continue;
        }
        const m = /（(\d+) 套/.exec(line);
        if (!m) {
          drift.push(`TESTING.md：找不到「第三节 ${fn} 那一行的套数」`);
          continue;
        }
        checked++;
        if (Number(m[1]) !== actual.names[fn]) {
          drift.push(`TESTING.md 的「第三节 ${fn}」写 ${m[1]} 套，实际 ${actual.names[fn]}`);
        }
      }
    }
  }

  if (actual.exits) {
    const text = textOf('TESTING.md');
    const line = text === null
      ? undefined
      : text.split('\n').find((l) => l.includes('退出码行为一致'));
    if (!line) {
      drift.push('TESTING.md：找不到「退出码行为一致」那段');
    } else {
      // 四个变体按文中出现顺序取值：setTimeout / ===0 / >0 / if
      const order = ['timeout', 'eq', 'gt', 'if'];
      const got = [...line.matchAll(/（(\d+) 套/g)].map((m) => Number(m[1]));
      if (got.length !== order.length) {
        drift.push(`TESTING.md：退出码那段只解析出 ${got.length} 个套数（期望 ${order.length} 个）`);
      } else {
        order.forEach((key, i) => {
          checked++;
          if (got[i] !== actual.exits[key]) {
            drift.push(`TESTING.md 的「退出码变体 ${key}」写 ${got[i]} 套，实际 ${actual.exits[key]}`);
          }
        });
        // 结构不变量：四种变体覆盖全部套件，和必须等于套件总数
        const sum = order.reduce((a, k) => a + actual.exits[k], 0);
        if (sum !== actual.suites) {
          drift.push(`脚本本身的退出码变体只覆盖 ${sum} 套，而套件总数是 ${actual.suites}（有一种写法没被 scanSuiteStyles 认出来）`);
        }
        const all = /\*\*(\d+) 套都会在有断言失败时返回非零\*\*/.exec(line);
        if (!all) {
          drift.push('TESTING.md：找不到「N 套都会在有断言失败时返回非零」');
        } else {
          checked++;
          if (Number(all[1]) !== actual.suites) {
            drift.push(`TESTING.md 的「N 套都会在有断言失败时返回非零」写 ${all[1]} 套，实际 ${actual.suites}`);
          }
        }
      }
    }
  }

  /* ── ③ 逐套项数：只在 TESTING 的套件表格里（`目录.md` 的树已不再重述） ── */

  {
    const file = 'TESTING.md';
    const text = textOf(file);
    if (text === null) {
      drift.push(`${file}：读不到，无法逐套比对项数`);
    } else {
      const declared = suitesInTesting(text);
      for (const r of actual.rows) {
        if (!declared.has(r.name)) {
          drift.push(`${file} 漏了 ${r.name} 这一套（清单里没有它）`);
          continue;
        }
        checked++;
        const n = declared.get(r.name);
        if (String(n) !== String(r.pass)) {
          drift.push(`${file} 的 ${r.name} 写 ${n} 项，实际 ${r.pass}`);
        }
      }
      for (const name of declared.keys()) {
        if (!actual.rows.some((r) => r.name === name)) {
          drift.push(`${file} 列了 ${name}，但本次没跑到这套脚本`);
        }
      }
    }
  }

  /* ── ④ 生成区（AUTOGEN）：内容必须等于 docs-sync 会写进去的那一份 ── */

  // 用**同一个 syncText** 算期望值（`gofmt` 亦然：写与查共用一份模板），所以两边的定义
  // 不可能分家。这里只读——修要显式跑 `npm run docs:sync`。
  const stats = { suites: actual.suites, tsSuites: actual.tsSuites, totalPass: actual.total };
  for (const file of AUTOGEN_FILES) {
    const text = textOf(file);
    if (text === null) {
      drift.push(`${file}：读不到，无法核对生成区`);
      continue;
    }
    const r = syncText(text, stats);
    for (const e of r.errors) drift.push(`${file} 生成区结构问题：${e}`);
    for (const d of r.drift) drift.push(`${file} 的 ${d}`);
    checked += r.regions;
  }

  return { checked, drift };
}

/** 四种退出码写法。判定见 scanSuiteStyles——用**合并正则**匹配，不是逐个 test */
const EXIT_STYLES = [
  ['timeout', /setTimeout\(\(\) => process\.exit\(failed > 0 \? 1 : 0\), 100\)/],
  ['eq', /process\.exit\(failed === 0 \? 0 : 1\)/],
  ['gt', /process\.exit\(failed > 0 \? 1 : 0\)/],
  ['if', /if \(failed > 0\) process\.exit\(1\)/],
];
const EXIT_RE = new RegExp(EXIT_STYLES.map(([, re]) => `(?:${re.source})`).join('|'), 'g');

/**
 * 扫 `scripts/` 下所有 `verify-*` 源码，数出两件**写进 TESTING 第三节**的事实：
 * 每套用哪个断言函数名、用哪种退出码写法。
 *
 * 为什么值得机器数：它们和项数一样是「当前真值」，却同样是手工填的，而**本轮实测到它已经错过**——
 * 「`if (failed > 0) process.exit(1)`（1 套）」实际是 2 套（phase-ab 与 steering），
 * 四个变体之和 5+3+7+1=16 恰好等于当时的 `.ts` 套件数，于是错得非常安静。
 */
export function scanSuiteStyles(ROOT) {
  const dir = path.join(ROOT, 'scripts');
  const names = { assert: 0, check: 0, ok: 0 };
  const exits = { timeout: 0, eq: 0, gt: 0, if: 0 };
  const files = fs.readdirSync(dir).filter((x) => /^verify-.+\.(ts|mjs)$/.test(x)).sort();
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // 断言函数名：锚在行首的**定义**上，所以夹具里那些 `| \`assert\` |` 之类的文本不会误伤
    if (/^function assert\b/m.test(src)) names.assert++;
    else if (/^function check\b/m.test(src)) names.check++;
    else if (/^function ok\b/m.test(src)) names.ok++;

    // 退出码：认**最后一次**匹配到的那一种。两个理由：
    //   ① 用**合并正则**（交替式从左到右、先列先匹配）而不是逐条 test —— `setTimeout(() =>
    //      process.exit(failed > 0 ? 1 : 0), 100)` 里也含 gt 那一段，逐条判时"最后出现的 gt"
    //      位置比 timeout 更靠后，于是整条被误判成 gt（2026-09-11 实测：timeout 全被吞、gt 数成 12）；
    //      合并正则会在 `setTimeout(` 处就让 timeout 分支吃掉整条，根本轮不到里面的 gt。
    //   ② 取最后一次是因为**测试夹具会逐字引用**别的写法当数据（`verify-doc-numbers.ts` 的合成
    //      文档里就写着 `setTimeout(…)` 与 `if (failed > 0) process.exit(1)`），按"出现顺序"判会
    //      把夹具里的引用当成该套自己的写法（实测：timeout 数成 6 套、if 数成 2 套）。
    //      退出语句本来就是脚本的最后一句，取最后一次即正解。
    const all = [...src.matchAll(EXIT_RE)];
    const last = all[all.length - 1];
    if (last) {
      const hit = EXIT_STYLES.find(([, re]) => new RegExp(`^(?:${re.source})$`).test(last[0]));
      if (hit) exits[hit[0]]++;
    }
  }
  return { files: files.length, names, exits };
}

/**
 * IO 包装：从 `Log/` 读那几份文档、顺手扫一遍 `scripts/` 数出写法分布，再交给 `diffDocNumbers`。
 * 读不到不抛——由 `diffDocNumbers` 记成一条漂移（文件被改名/删掉本身就该红）。
 */
export function checkDocNumbers(ROOT, actual) {
  const texts = {};
  for (const f of new Set([...WATCHED, ...AUTOGEN_FILES])) {
    try {
      texts[f] = fs.readFileSync(path.join(ROOT, 'Log', f), 'utf8');
    } catch {
      texts[f] = null;
    }
  }
  let full = actual;
  try {
    const styles = scanSuiteStyles(ROOT);
    full = { ...actual, names: styles.names, exits: styles.exits };
  } catch {
    // 扫不到 scripts/（例如根目录不存在）：保持 null，第二节的比对会记成漂移
    full = { ...actual, names: null, exits: null };
  }
  return diffDocNumbers(texts, full);
}
