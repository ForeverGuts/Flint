/**
 * 生成区（AUTOGEN 区块）—— `Log/` 里那几个由**程序算出来**的数字。
 *
 * 为什么要有它：`套数 / 项数` 是"现在是多少"这类**算得出来的事实**，此前靠人或模型抄进文档
 * （本仓库叫"手抄区"）。手抄会漏、会编、会漂——本仓库实测过两次（TESTING 第三节那两处既有
 * 错数、以及 `check-doc-numbers.mjs` 上线首跑点名的 18 处漂移）。生成区的做法：在文档里用
 * 一对 HTML 注释划出"这块归机器管"，由 `scripts/docs-sync.mjs`（`npm run docs:sync`）从
 * **实测真值**写进去，人一个字都不碰。
 *
 * 三条设计约束，都不是随便定的：
 *   ① **落盘的是渲染后的 Markdown，不是 `{{占位符}}`**。`Log/` 是给人**和** Agent 的 Read
 *      工具直接读的，占位符会让两边都读到垃圾；生成完再落盘，文件才保持"直接可读"。这条
 *      也正是它能与 flint "零构建管线 / 零运行时依赖"约束共存的原因——不需要模板引擎。
 *      标记本身是 HTML 注释，渲染时不可见。
 *   ② **只接管算得出来的事实**。生成区里**不许放散文**——"为什么这样切""已知取舍"这类判断
 *      程序给不出来，必须由人或 AI 写；混进去会被 `docs-sync` 覆掉，或被校验判红。
 *   ③ **`verify` 只读、`docs:sync` 才写**。`gofmt -l` / `cargo fmt --check` 的范式：CI 里
 *      只检查、只报红；本地显式跑同步命令修。一个会顺手改你文件的"校验"会让人不敢跑它，
 *      也会让"CI 通过"与"本地通过"变成两件事。
 *
 * 与"手抄区"的关系：**生成区可以重复出现**——同一个 id 出现几处都行，内容由同一个渲染器
 * 给出（像编译产物可以出现在多个位置）；"去重"针对的是**手抄**的副本。所以 `Log/` 现在的
 * 纪律是三分的：
 *   算得出来的 → 生成区（可多处）· 判断性的 → 手写（唯一落点）· 历史数字 → 冻结（追加日志）。
 *
 * 校验那一侧在 `scripts/check-doc-numbers.mjs` ⑥ 段：它调用**同一个 `syncText`** 算出期望值
 * 再比文件内容（与 `gofmt` 同理，写与查共用一份模板），所以两边不可能分家。也正因如此，
 * `verify-doc-numbers.ts` 必须拿**手写的期望字符串**去钉渲染器的输出——否则"生成器与校验器
 * 一起错"就是静默的。
 */

/** 生成区所在的文件（相对 `Log/`）。试水只做 TESTING 一份，跑通再推广。 */
export const AUTOGEN_FILES = ['TESTING.md'];

/**
 * id → 渲染器。给出该区段**唯一正确**的内容；输入是实测真值，不是文件里的旧值。
 * 区段内容**只许是数字事实**，不许夹带散文（见文件头 ②）。
 *
 * @param {{suites: number, tsSuites: number, totalPass: number}} s
 */
export const RENDERERS = {
  'test-summary': (s) => `${s.suites} 套零依赖验证脚本、合计 **${s.totalPass} 项**断言`,
  'test-counts': (s) =>
    `**项数合计 ${s.totalPass}**（其中 ${s.tsSuites} 套是 \`.ts\` 走 tsx、`
    + `${s.suites - s.tsSuites} 套 \`.mjs\` 直跑）`,
};

const beginTag = (id) => `<!-- BEGIN AUTOGEN:${id} -->`;
const endTag = (id) => `<!-- END AUTOGEN:${id} -->`;
const REGION_RE = /<!-- BEGIN AUTOGEN:([\w-]+) -->([\s\S]*?)<!-- END AUTOGEN:([\w-]+) -->/g;
const BEGIN_RE = /<!-- BEGIN AUTOGEN:([\w-]+) -->/g;
const END_RE = /<!-- END AUTOGEN:([\w-]+) -->/g;

/** 把区段内容压成一行短串，用于报错文案（漂移信息必须单行，便于终端里逐条读）。 */
const oneLine = (s) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
};

/**
 * 找出所有 `BEGIN … END` 区段。返回文档顺序的数组，带**内容**以及**内容区间的精确偏移**
 * （`bodyStart` / `bodyEnd`），供 `syncText` 只替换内容、不碰标记本身。
 *
 * 注意正则是**非贪婪**的（`[\s\S]*?`），所以两个相邻区段不会被吞成一个。
 *
 * @returns {Array<{id: string, endId: string, inner: string, start: number, end: number, bodyStart: number, bodyEnd: number}>}
 */
export function findRegions(text) {
  const out = [];
  for (const m of text.matchAll(REGION_RE)) {
    const id = m[1];
    const endId = m[3];
    out.push({
      id,
      endId,
      inner: m[2],
      start: m.index,
      end: m.index + m[0].length,
      bodyStart: m.index + beginTag(id).length,
      bodyEnd: m.index + m[0].length - endTag(endId).length,
    });
  }
  return out;
}

/**
 * 纯函数：按实测真值算出每段生成区的正确内容。
 *
 * @param {string} text 文档原文
 * @param {{suites: number, tsSuites: number, totalPass: number}} stats 实测真值
 * @returns {{next: string, drift: string[], errors: string[], changed: number, regions: number}}
 *   - `next`：把所有区段内容换成正确值之后的文档
 *   - `drift`：内容不符的清单（**可修**，`docs-sync` 会写掉它）
 *   - `errors`：结构问题（标记不配对 / id 未知 / 一个区段都没有）——**不可猜测，拒绝写盘**
 *   - `changed`：被改动的区段数
 */
export function syncText(text, stats) {
  const drift = [];
  const errors = [];
  const regions = findRegions(text);

  /* ── 结构检查：先确保标记本身是好的，再谈内容 ── */

  const countOf = (re) => {
    const m = new Map();
    for (const x of text.matchAll(re)) m.set(x[1], (m.get(x[1]) ?? 0) + 1);
    return m;
  };
  const begins = countOf(BEGIN_RE);
  const ends = countOf(END_RE);
  for (const id of new Set([...begins.keys(), ...ends.keys()])) {
    const b = begins.get(id) ?? 0;
    const e = ends.get(id) ?? 0;
    if (b !== e) errors.push(`\`${id}\` 标记不配对：BEGIN ${b} 个 / END ${e} 个`);
    if (!RENDERERS[id]) errors.push(`未知的生成区 id \`${id}\`——docs-sync 没有对应的渲染器`);
  }
  for (const r of regions) {
    if (r.id !== r.endId) errors.push(`区段 id 串了：BEGIN \`${r.id}\` 配到了 END \`${r.endId}\``);
  }
  if (regions.length === 0 && begins.size === 0 && ends.size === 0) {
    errors.push('一个生成区都没有——标记被删了？');
  }

  /* ── 内容：逐段比期望值，并就地替换（保留原有的前后空白，所以行内区段不会被撑成多行） ── */

  let next = '';
  let cursor = 0;
  let changed = 0;
  for (const r of regions) {
    const want = RENDERERS[r.id] ? RENDERERS[r.id](stats) : r.inner.trim();
    next += text.slice(cursor, r.bodyStart);
    if (r.inner.trim() !== want.trim()) {
      changed++;
      drift.push(`生成区「${r.id}」内容不符：文件里是「${oneLine(r.inner)}」，应为「${oneLine(want)}」`);
    }
    const lead = /^\s*/.exec(r.inner)[0];
    const trail = /\s*$/.exec(r.inner)[0];
    next += lead + want + trail;
    cursor = r.bodyEnd;
  }
  next += text.slice(cursor);

  return { next, drift, errors, changed, regions: regions.length };
}
