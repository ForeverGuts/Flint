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
 * slug 规则（GitHub / VSCode 预览一致）：标题转小写 → 删掉非字母数字空格连字符的字符
 *   （全角括号、斜杠、点号都删，中日韩文字保留）→ 空格换连字符。
 *   例：`### Usage（用量）` → `#usage用量`；`### 决策 6：不做 DI 容器` → `#决策-6不做-di-容器`
 *
 * 运行：node scripts/verify-docs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'Log');

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

const docs = fs.readdirSync(LOG).filter((n) => n.endsWith('.md')).sort();
const cache = new Map();
function read(name) {
  if (!cache.has(name)) {
    cache.set(name, fs.readFileSync(path.join(LOG, name), 'utf8').split(/\r?\n/));
  }
  return cache.get(name);
}

/* ── ① 同文件锚点 ── */

console.log('\n① 同文件锚点（](#xxx) 必须能在本文标题里解析出来）');
const deadHere = [];
for (const d of docs) {
  const lines = read(d);
  const slugs = slugsOf(lines);
  const refs = new Set();
  for (const l of lines) {
    for (const m of l.matchAll(/\]\(#([^)]+)\)/g)) refs.add(m[1]);
  }
  if (refs.size === 0) continue;
  const dead = [...refs].filter((r) => !slugs.includes(r));
  for (const x of dead) deadHere.push(`${d}#${x}`);
  check(`${d}：${refs.size} 处同文件锚点全部可解析`, dead.length === 0, dead.join(', '));
}

/* ── ② 跨文件锚点 ── */

console.log('\n② 跨文件锚点（](./X.md#yyy) 的目标文件与标题都得在）');
const deadCross = [];
for (const d of docs) {
  const lines = read(d);
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
    if (r.anchor && !slugsOf(read(r.file)).includes(r.anchor)) {
      bad.push(`${r.file}#${r.anchor}`);
      deadCross.push(`${d} -> ${r.file}#${r.anchor}`);
    }
  }
  check(`${d}：${refs.length} 处跨文件引用全部可解析`, bad.length === 0, bad.join(', '));
}

/* ── ③ 入站锚点契约 ── */

// 这三条标题被 DECISION_LOG.md 与 GLOSSARY.md 引用着，改标题文字就会静默断链。
// DECISION_LOG 是 append-only（旧条目不改写），所以断的那条没法在源头修——只能钉住标题。
console.log('\n③ 入站锚点契约（被别的文档引用着的标题，文字不得改动）');
{
  const arch = slugsOf(read('ARCHITECTURE.md'));
  for (const s of ['决策-1pi-模式调用方持有循环', '决策-5streaming-以回调方式提供', '决策-6不做-di-容器']) {
    check(`ARCHITECTURE.md 仍有 #${s}`, arch.includes(s));
  }
  const glo = slugsOf(read('GLOSSARY.md'));
  for (const s of ['pi-模式', 'project-metadata项目元数据', 'event-subscription事件订阅']) {
    check(`GLOSSARY.md 仍有 #${s}`, glo.includes(s));
  }
}

/* ── ④ 汇总 ── */

console.log('\n④ 汇总');
check(`扫到 Log/ 下全部 ${docs.length} 份 markdown`, docs.length >= 14, `实得 ${docs.length}`);
check('全库死链合计为 0', deadHere.length + deadCross.length === 0,
  [...deadHere, ...deadCross].join(', '));

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
