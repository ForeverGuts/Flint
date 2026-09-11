/**
 * 文档链接验证脚本 —— Log/ 下所有 markdown 的锚点死链检查。
 *
 * 为什么只查锚点、不查"文档里提到的文件路径是否存在"：
 *   实测后者误报率过高——扫出 31 个候选缺失路径，其中 28 个是裸文件名（`main.ts`、
 *   `verify-c1.ts`，文件其实在，只是没带目录前缀）或运行时产物（`trace.jsonl`、`TASK.md`），
 *   剩下的还是"故意提到不存在的东西"的说明性引用（GLOSSARY 里写"旧文档指向的
 *   src/runtime/session.ts 不存在"）。要压住这些得维护一张例外表，收益不抵成本。
 *   锚点检查则是零误报的：slug 规则确定，解析得出就是得出。
 *
 * 锚点有两种，本脚本都认（见 anchorsOf）：
 *   ① **标题 slug**（GitHub / VSCode 预览一致）：标题转小写 → 删掉非字母数字空格连字符的
 *      字符（全角括号、斜杠、点号都删，中日韩文字保留）→ 空格换连字符。
 *      例：`### Usage（用量）` → `#usage用量`；`### 决策 6：不做 DI 容器` → `#决策-6不做-di-容器`
 *   ② **显式 id**：`<a id="log-2026-09-11-doc-number-check"></a>` 单独一行放在标题上方。
 *      为什么要有它：slug 是 `f(标题文字)`，于是"链接不断"只能靠"标题文字不许改"（④ 段
 *      那 6 条契约就是这么来的）。显式 id 把这个依赖**倒过来** —— 锚点值由作者给定、与
 *      文字无关，日后怎么重述标题都不会断，引用也短（不必写一串 CJK slug）。
 *      它与 append-only 天生一对：条目只追加不改写，所以 id 写一次就永不改。
 *
 * 运行：node scripts/verify-docs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'Log');

/**
 * 把 markdown 的**代码区**抹成等长空白：围栏代码块整段跳过，行内代码 `` `…` `` 抹平。
 *
 * 为什么必须做：`Log/*_RULES.md` 通篇是"模板"（`<a id="log-YYYY-MM-DD-短名"></a>` 与
 * `[说明](./X.md#log-…)` 写在围栏里当示例），正文里也会用行内代码**引用**一个链接当例子。
 * 它们都不是真的锚点/链接——不排除就会两头出错：①把模板当成真 id；②把示例当成断链报出来。
 * 2026-09-11 落地显式 id 时这两条**同时发生**（`ARCHITECTURE_LOG_RULES.md` 的模板被当成
 * 两个真 id、`GLOSSARY.md` 行内代码里那个示例被当成断链），是校验自己逮出来的。
 * 换成等长空白而不是删行，是为了不动行号、方便对着输出回原文找。
 */
function stripCode(lines) {
  const out = [];
  let fence = null;
  for (const l of lines) {
    const m = /^\s*(```+|~~~+)/.exec(l);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (fence === m[1][0]) fence = null;
      out.push(' '.repeat(l.length));
      continue;
    }
    if (fence !== null) {
      out.push(' '.repeat(l.length));
      continue;
    }
    out.push(l.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length)));
  }
  return out;
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function slug(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} \-]/gu, '')
    .replace(/ /g, '-');
}

/** 抽出一份文档里所有标题的 slug */
function slugsOf(lines) {
  const out = [];
  for (const l of lines) {
    const m = /^#{1,6}\s+(.*)$/.exec(l);
    if (m) out.push(slug(m[1]));
  }
  return out;
}

/** 抽出一份文档里所有**显式锚点**（`<a id="…"></a>`）—— 稳定锚点的载体，见头部说明 */
function idsOf(lines) {
  const out = [];
  for (const l of lines) {
    for (const m of l.matchAll(/<a\s+id="([^"]+)"\s*>\s*<\/a>/g)) out.push(m[1]);
  }
  return out;
}

/** 一份文档里**可被链接到**的全部锚点 = 标题 slug ∪ 显式 id。两种都认。 */
function anchorsOf(lines) {
  return [...slugsOf(lines), ...idsOf(lines)];
}

const docs = fs.readdirSync(LOG).filter((n) => n.endsWith('.md')).sort();
const cache = new Map();
function read(name) {
  if (!cache.has(name)) {
    cache.set(name, fs.readFileSync(path.join(LOG, name), 'utf8').split(/\r?\n/));
  }
  return cache.get(name);
}

const cleanCache = new Map();
/** 原行去掉代码区之后的版本 —— 锚点与链接的**唯一**取材来源（见 stripCode） */
function readClean(name) {
  if (!cleanCache.has(name)) cleanCache.set(name, stripCode(read(name)));
  return cleanCache.get(name);
}

/* ── ① 同文件锚点 ── */

console.log('\n① 同文件锚点（](#xxx) 必须能在本文的标题 slug 或显式 id 里解析出来）');
const deadHere = [];
for (const d of docs) {
  const lines = readClean(d);
  const anchors = anchorsOf(lines);
  const refs = new Set();
  for (const l of lines) {
    for (const m of l.matchAll(/\]\(#([^)]+)\)/g)) refs.add(m[1]);
  }
  if (refs.size === 0) continue;
  const dead = [...refs].filter((r) => !anchors.includes(r));
  for (const x of dead) deadHere.push(`${d}#${x}`);
  check(`${d}：${refs.size} 处同文件锚点全部可解析`, dead.length === 0, dead.join(', '));
}

/* ── ② 跨文件锚点 ── */

console.log('\n② 跨文件锚点（](./X.md#yyy) 的目标文件与锚点都得在——锚点同样含显式 id）');
const deadCross = [];
for (const d of docs) {
  const lines = readClean(d);
  const refs = [];
  for (const l of lines) {
    for (const m of l.matchAll(/\]\((?:\.\/)?([\w\u4e00-\u9fa5.\-]+\.md)(#[^)]*)?\)/g)) {
      refs.push({ file: m[1], anchor: m[2] ? m[2].slice(1) : null });
    }
  }
  if (refs.length === 0) continue;
  const bad = [];
  for (const r of refs) {
    if (!fs.existsSync(path.join(LOG, r.file))) {
      bad.push(`${r.file}(文件不存在)`);
      deadCross.push(`${d} -> ${r.file}`);
      continue;
    }
    if (r.anchor && !anchorsOf(readClean(r.file)).includes(r.anchor)) {
      bad.push(`${r.file}#${r.anchor}`);
      deadCross.push(`${d} -> ${r.file}#${r.anchor}`);
    }
  }
  check(`${d}：${refs.length} 处跨文件引用全部可解析`, bad.length === 0, bad.join(', '));
}

/* ── ③ 显式锚点卫生 ── */

// 显式 id 有个 slug 没有的失效方式：**同一份文件里出现两次**时，跳转只会落到第一处，
// 后面的引用静默指错（标题重名时 GitHub 会自动去重成 `-1` 后缀，而显式 id 重复是完全
// 静默的）。所以这里钉两件事：不重复、命名守约定（照约定写就不会撞名）。
console.log('\n③ 显式锚点卫生（<a id="…">）：不重复、命名守约定');
{
  const all = [];
  const dup = [];
  for (const d of docs) {
    const ids = idsOf(readClean(d));
    all.push(...ids);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) dup.push(`${d}#${id}`);
      seen.add(id);
    }
  }
  check(`全库 ${all.length} 个显式 id 在同一份文件里不重复`, dup.length === 0, dup.join(', '));
  const badName = all.filter((id) => !/^log-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(id));
  check('显式 id 全部符合 log-<日期>-<短名> 形状', badName.length === 0, badName.join(', '));
  // 前两条若因为「一个都没扫到」而空转全绿，就成了一条没有内容的检查——idsOf 的正则
  // 一旦被写窄（例如漏掉空格），症状正是这个。用「非空」把它堵住。
  check('确实扫到了显式 id（不是空集）', all.length > 0, `实得 ${all.length} 个`);
}

/* ── ④ 入站锚点契约 ── */

// 两类锚点在这里的待遇不同，因为**改起来能不能修**不同：
//   - 显式 id（上面第 ③ 段）：作者给定、与文字无关，断了可以直接在新引用里改；
//   - 标题 slug（这一段）：锚点值由标题文字算出，一旦有引用指着它，改标题文字就静默断链。
//     而这些标题在 append-only 的日志里（旧条目不改写），断了**没法在源头修**——只能
//     反过来把标题文字本身钉成契约。
// 这 6 条是历史遗留（引用早于显式 id 约定）。从 2026-09-11 起新日志条目一律带显式 id，
// 所以这个名单**只会变短不会变长**。
console.log('\n④ 入站锚点契约（被别的文档引用着的标题，文字不得改动）');
{
  const arch = slugsOf(readClean('ARCHITECTURE.md'));
  for (const s of ['决策-1pi-模式调用方持有循环', '决策-5streaming-以回调方式提供', '决策-6不做-di-容器']) {
    check(`ARCHITECTURE.md 仍有 #${s}`, arch.includes(s));
  }
  const glo = slugsOf(readClean('GLOSSARY.md'));
  for (const s of ['pi-模式', 'project-metadata项目元数据', 'event-subscription事件订阅']) {
    check(`GLOSSARY.md 仍有 #${s}`, glo.includes(s));
  }
}

/* ── ⑤ 汇总 ── */

console.log('\n⑤ 汇总');
check(`扫到 Log/ 下全部 ${docs.length} 份 markdown`, docs.length >= 14, `实得 ${docs.length}`);
check('全库死链合计为 0', deadHere.length + deadCross.length === 0,
  [...deadHere, ...deadCross].join(', '));

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
