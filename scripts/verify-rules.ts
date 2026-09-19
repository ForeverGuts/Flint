/**
 * verify-rules.ts —— 项目规约读取（ROADMAP 10.2.1）
 *
 * 验什么（手段与行为分开钉）：
 *   ① `rulesCandidates` —— 判据纯函数：三级 × 两名字的**顺序**、等级编号、绝对路径落点，
 *      以及"**走到盘根就停**"（这条不是防御性代码，它直接决定渲染给模型的"取自上一级目录"
 *      是不是真话 —— 所以它必须能脱离真盘根打靶）
 *   ② `clipRules` —— 截断与空值（空 / 全空白 / 恰好等于上限 / 超限 / 非字符串）
 *   ③ `renderRulesSection` —— 给人（模型）读的那节：方位词、冲突时以人为准那句、等级越界退化
 *   ④ **真目录端到端**（probeRules）—— 三层真目录：命中在 0/1/2 级、同目录 AGENTS 赢、
 *      **距离优先于名字**、空文件不算命中、`AGENTS.md` 是目录时跳过并**继续往下找**
 *   ⑤ 注入层 —— 用**真** SystemPromptServiceImpl 验"两节同一条消息、规约在前、层序未动、
 *      任一节缺席只出另一节、两节都无则整层缺席"
 *   ⑥ 播种装配 —— 真 `seedProjectContext()`：装了 / **先清后栽**（切到没规约的项目要变 null）
 *   ⑦ 源码守护 —— 判据不碰盘、唯一调用点、三处接线真的在、**层序一个字没动**
 *
 * ── 为什么必须进沙箱 ──
 * ⑥ 段真跑 `seedProjectContext()`，它会**写项目登记**（`~/.flint/projects.jsonl`）。
 * 不搬走的话，跑一次套件就往用户真实通讯录里写几行临时目录。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-rules.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemPromptServiceImpl } from '../src/context/system-prompt.js';
import { seedProjectContext } from '../src/harness/project-context.js';
import {
  RULES_FILENAMES,
  RULES_MAX,
  RULES_UP_LEVELS,
  clipRules,
  renderRulesSection,
  rulesCandidates,
  rulesRegistry,
} from '../src/project/rules.js';
import { probeRules } from '../src/project/probe.js';
import { enterSandbox } from './lib/sandbox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const sandbox = enterSandbox('flint-rules-');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 断言失败时印一点现场（把长文本压成一行，免得刷屏） */
const ok = (s: string | undefined | null): string =>
  s === undefined || s === null ? '（null）' : s.replace(/\s+/g, ' ').slice(0, 80);

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ═══ ① 判据：候选名单（顺序 / 等级 / 到根为止） ═══ */
console.log('── ① rulesCandidates（纯判据：顺序 · 等级 · 到盘根为止）──');

{
  const c = rulesCandidates(isWin ? 'C:/work/proj' : '/work/proj');
  const names = c.map((x) => x.name);
  const levels = c.map((x) => x.level);
  check('A1 三级 × 两名字 = 6 条候选', c.length === (RULES_UP_LEVELS + 1) * RULES_FILENAMES.length,
    `实际 ${c.length} 条`);
  check('A2 同目录内 `AGENTS.md` 排在 `CLAUDE.md` 之前（数组顺序即优先级）',
    names[0] === 'AGENTS.md' && names[1] === 'CLAUDE.md', names.slice(0, 2).join(','));
  check('A3 等级是 0,0,1,1,2,2 —— 先近后远（近的更具体，该先赢）',
    levels.join(',') === '0,0,1,1,2,2', levels.join(','));
  const base = path.resolve(isWin ? 'C:/work/proj' : '/work/proj');
  check('A4 等级 0 落在 cwd 自己、等级 1 落在父目录、等级 2 落在祖父目录',
    c[0]?.abs === path.join(base, 'AGENTS.md')
    && c[2]?.abs === path.join(path.dirname(base), 'AGENTS.md')
    && c[4]?.abs === path.join(path.dirname(path.dirname(base)), 'AGENTS.md'),
    ok(c[4]?.abs));
  // ⚠ 这条是"到盘根就停"的唯一无歧义打靶点：不停的话根会被当成"上一级/上两级"各探一遍，
  //   同一个文件被报出三个等级，而等级正是要渲染给模型看的（"取自上一级目录"就成了假话）。
  const root = isWin ? 'C:/' : '/';
  const rc = rulesCandidates(root);
  check('A5 从盘根起步只出 2 条（`dirname(root) === root`，不许把根当成"上一级"）',
    rc.length === RULES_FILENAMES.length && rc.every((x) => x.level === 0),
    `${rc.length} 条 / 等级 ${rc.map((x) => x.level).join(',')}`);
  check('A6 相对写法也给绝对路径（判据自己 resolve，调用方不必先转）',
    rulesCandidates('rel/dir').every((x) => path.isAbsolute(x.abs)));
}

/* ═══ ② clipRules：截断与空值 ═══ */
console.log('── ② clipRules（注入上限）──');

{
  check('B1 正常文本原样返回', clipRules('# 规矩\n- 甲') === '# 规矩\n- 甲');
  check('B2 空串 → undefined（**不注入一句空话**）', clipRules('') === undefined);
  check('B3 全空白 → undefined（"存在但是空的"与"没有"同待遇）', clipRules('  \n\t \r\n ') === undefined);
  const long = 'x'.repeat(RULES_MAX + 500);
  const clipped = clipRules(long);
  check('B4 超限 → 截到上限并标一刀（让模型知道还有后文）',
    clipped !== undefined && clipped.length === RULES_MAX + '\n...（截断）'.length
    && clipped.endsWith('...（截断）'), `长度 ${clipped?.length}`);
  check('B5 恰好等于上限 → **不截**（边界是"超过"而不是"达到"）',
    clipRules('y'.repeat(RULES_MAX))?.endsWith('...（截断）') === false);
  check('B6 两侧空白被 trim（大小判定用 trim 后的长度，不拿空白充当内容）',
    clipRules('\n\n  正文  \n\n') === '正文');
  check('B7 非字符串（null / 数字）→ undefined，绝不抛',
    clipRules(null as unknown as string) === undefined
    && clipRules(42 as unknown as string) === undefined);
}

/* ═══ ③ renderRulesSection：给人（模型）读的那节 ═══ */
console.log('── ③ renderRulesSection（拒因/路标文案）──');

{
  check('C1 没命中 → 空串（整节缺席，不拿空壳占上下文）', renderRulesSection(null) === '');
  check('C2 正文为空的命中 → 同样空串（防御：不该有这种命中，但别把空话注进去）',
    renderRulesSection({ name: 'AGENTS.md', level: 0, text: '   ' }) === '');
  const s = renderRulesSection({ name: 'AGENTS.md', level: 0, text: '- 甲' });
  check('C3 命中：带 `[项目规约]` 头 + 文件名 + 正文', s.includes('[项目规约]')
    && s.includes('AGENTS.md') && s.endsWith('- 甲'), ok(s));
  check('C4 节首明说"与下方项目记忆冲突时以这里为准"（权威来源不同，必须点破）',
    s.includes('由人维护') && s.includes('与下方项目记忆冲突时以这里为准'), ok(s));
  check('C5 等级 → 方位词：0 项目根 / 1 上一级目录 / 2 上两级目录',
    renderRulesSection({ name: 'A.md', level: 0, text: 'x' }).includes('取自项目根')
    && renderRulesSection({ name: 'A.md', level: 1, text: 'x' }).includes('取自上一级目录')
    && renderRulesSection({ name: 'A.md', level: 2, text: 'x' }).includes('取自上两级目录'));
  check('C6 等级越界 → 退化成"上溯 N 级"，**不编一个假方位词**',
    renderRulesSection({ name: 'A.md', level: 7, text: 'x' }).includes('上溯 7 级'));
  check('C7 名字缺失 → 兜底第一个文件名（宁可说"AGENTS.md"，也别印一句空白）',
    renderRulesSection({ name: '', level: 0, text: 'x' }).includes('AGENTS.md'));
}

/* ═══ ④ 真目录端到端：probeRules ═══ */
console.log('── ④ 真目录端到端（probeRules）──');

/** 造三层临时项目 base/mid/proj —— 从 proj 上溯两级正好落在 base（不会探到控制之外的目录） */
function mkLevels(): { base: string; mid: string; proj: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-rules-lv-'));
  const mid = path.join(base, 'mid');
  const proj = path.join(mid, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  return { base, mid, proj };
}
const put = (dir: string, name: string, text: string): void =>
  fs.writeFileSync(path.join(dir, name), text, 'utf-8');

{
  const a = mkLevels();
  put(a.proj, 'AGENTS.md', '# A 级规矩\n- 第一条\n');
  put(a.proj, 'CLAUDE.md', '# 同目录的另一份\n');
  const r = probeRules(a.proj);
  check('D1 命中 cwd 自己那份：等级 0 + 名字 + 正文（trim 过）',
    r?.level === 0 && r?.name === 'AGENTS.md' && r?.text === '# A 级规矩\n- 第一条', ok(r?.text));
  check('D2 同目录两份都在 → `AGENTS.md` 赢（中立约定优先于某个工具的私有名）',
    r?.name === 'AGENTS.md');

  const b = mkLevels();
  put(b.proj, 'CLAUDE.md', '# 只有 CLAUDE\n');
  check('D3 cwd 只有 `CLAUDE.md` → 照样命中（不是只认 AGENTS.md）',
    probeRules(b.proj)?.name === 'CLAUDE.md');

  const c = mkLevels();
  put(c.mid, 'AGENTS.md', '# 上级的规矩\n');
  const rc = probeRules(c.proj);
  check('D4 cwd 没有、上一级有 → 等级 1（不是漏掉，也不是当成 0）',
    rc?.level === 1 && rc?.name === 'AGENTS.md', ok(rc?.text));

  const d = mkLevels();
  put(d.base, 'CLAUDE.md', '# 上两级的规矩\n');
  const rd = probeRules(d.proj);
  check('D5 只剩上两级有 → 等级 2', rd?.level === 2 && rd?.name === 'CLAUDE.md');

  // ⚠ 这条钉的是**两个判据的次序**：距离(等级) 优先于 名字。
  //   把顺序写反（先按名字把三级的 AGENTS.md 都挑一遍）时，本用例会去命中 mid 那份。
  const e = mkLevels();
  put(e.proj, 'CLAUDE.md', '# 近的那份\n');
  put(e.mid, 'AGENTS.md', '# 远的、名字更优先的那份\n');
  const re = probeRules(e.proj);
  check('D6 近的 `CLAUDE.md` 赢过远的 `AGENTS.md`（**距离优先于名字**）',
    re?.level === 0 && re?.name === 'CLAUDE.md' && re?.text === '# 近的那份', ok(re?.text));

  const f = mkLevels();
  check('D7 三层都没有 → null（整节缺席，且不抛）', probeRules(f.proj) === null);

  const g = mkLevels();
  put(g.proj, 'AGENTS.md', '   \n\n  ');     // 空文件（只有空白）
  put(g.proj, 'CLAUDE.md', '# 有内容的那份\n');
  const rg = probeRules(g.proj);
  check('D8 空文件**不算命中** → 继续往下找，命中同目录的下一份',
    rg?.name === 'CLAUDE.md' && rg?.level === 0, ok(rg?.text));

  const h = mkLevels();
  fs.mkdirSync(path.join(h.proj, 'AGENTS.md')); // 同名**目录**：existsSync 为真，读会抛
  put(h.mid, 'AGENTS.md', '# 上级的真文件\n');
  const rh = probeRules(h.proj);
  check('D9 读不动（`AGENTS.md` 是目录）→ 跳过该候选并**继续往下找**，不是直接放弃',
    rh?.level === 1 && rh?.text === '# 上级的真文件', ok(rh?.text));

  const i2 = mkLevels();
  put(i2.proj, 'AGENTS.md', 'z'.repeat(RULES_MAX + 200));
  const ri = probeRules(i2.proj);
  check('D10 真超长文件 → 真截断（探针把上限用上了，不是只有纯函数会截）',
    ri !== undefined && ri.text.endsWith('...（截断）'));

  const j = mkLevels();
  put(j.proj, 'AGENTS.md', '\n\n# 头尾都有空白\n\n');
  check('D11 真文件也 trim（首尾空行不许占注入预算）',
    probeRules(j.proj)?.text === '# 头尾都有空白');

  let threw = false;
  let rootHit: ReturnType<typeof probeRules> = null;
  try {
    rootHit = probeRules(isWin ? 'C:/' : '/');
  } catch {
    threw = true;
  }
  check('D12 盘根起步不抛异常，且等级只能是 0（**没有**把根当成"上一级"）',
    !threw && (rootHit === null || rootHit.level === 0), ok(rootHit?.text));
}

/* ═══ ⑤ 注入层：真 SystemPromptServiceImpl ═══ */
console.log('── ⑤ 注入层（真 SystemPromptServiceImpl）──');

const noopBus = { emitHook: async () => undefined, on: () => () => {} } as never;
const svc = new SystemPromptServiceImpl({ core: [], tools: [], skills: [], fallback: 'fallback' }, noopBus);
const baseCtx = { tools: '', skills: [] as string[], model: 'test-model', summary: undefined, historyCount: 0 };

{
  const both = await svc.build({ ...baseCtx, rules: '[项目规约]（X）\n- 甲', memory: '- 乙', task: '- [ ] 丙' });
  const memMsgs = both.messages.filter((m) => m.layer === 'memory');
  check('E1 规约与记忆是**同一条消息**（同一个 memory 层，没有偷偷加层）', memMsgs.length === 1);
  const content = memMsgs[0]?.content ?? '';
  check('E2 同层内**规约在前、记忆在后**（人写的规矩压住模型攒的结论）',
    content.indexOf('[项目规约]') >= 0
    && content.indexOf('[项目规约]') < content.indexOf('[项目记忆]'), ok(content));
  check('E3 层序未动：memory 仍排在 task 之前',
    both.messages.findIndex((m) => m.layer === 'memory') < both.messages.findIndex((m) => m.layer === 'task'));

  const onlyRules = await svc.build({ ...baseCtx, rules: '[项目规约]（X）\n- 甲' });
  const onlyRulesMsg = onlyRules.messages.find((m) => m.layer === 'memory');
  check('E4 只有规约（没有项目记忆）→ 层照常在，且不出现 `[项目记忆]` 空壳',
    onlyRulesMsg !== undefined && onlyRulesMsg.content.includes('[项目规约]')
    && !onlyRulesMsg.content.includes('[项目记忆]'), ok(onlyRulesMsg?.content));

  const onlyMemory = await svc.build({ ...baseCtx, memory: '- 乙' });
  check('E5 只有项目记忆 → 逐字与接入前相同（不影响老路径）',
    onlyMemory.messages.find((m) => m.layer === 'memory')?.content
      === '[项目记忆]（跨会话持久，适用于本项目的所有任务）\n- 乙');

  const neither = await svc.build({ ...baseCtx });
  check('E6 两节都无 → **整层缺席**（维持"没有就不注入"的纪律）',
    neither.messages.some((m) => m.layer === 'memory') === false);
}

/* ═══ ⑥ 播种装配：真 seedProjectContext ═══ */
console.log('── ⑥ 播种装配（真 seedProjectContext）──');

{
  const a = mkLevels();
  put(a.proj, 'AGENTS.md', '# 本项目的规矩\n- 甲\n');
  process.chdir(a.proj);
  seedProjectContext();
  const ra = rulesRegistry.get();
  check('F1 启动播种：注册表里就是当前项目的规约',
    ra?.name === 'AGENTS.md' && ra?.level === 0 && ra?.text?.includes('甲') === true, ok(ra?.text));

  const b = mkLevels(); // 三层都没有规约
  process.chdir(b.proj);
  seedProjectContext();
  check('F2 切到**没有规约**的项目 → 先清后栽，注册表必须是 null（不能顶着上一个项目的规约）',
    rulesRegistry.get() === null, ok(rulesRegistry.get()?.text));

  const c = mkLevels();
  put(c.mid, 'CLAUDE.md', '# 上级总则\n');
  process.chdir(c.proj);
  seedProjectContext();
  check('F3 切项目时**重找**（不是只在启动找一次）：上级那份也能被认出来',
    rulesRegistry.get()?.level === 1 && rulesRegistry.get()?.name === 'CLAUDE.md');

  check('F4 播种 → 渲染 这一串真接得上（注册表里的东西直接进注入文案）',
    renderRulesSection(rulesRegistry.get()).includes('[项目规约]'));

  process.chdir(sandbox.dir);
}

/* ═══ ⑦ 源码守护 ═══ */
console.log('── ⑦ 源码守护 ──');

{
  const srcDir = path.join(ROOT, 'src');
  const readSrc = (rel: string): string => fs.readFileSync(path.join(srcDir, rel), 'utf8');

  const rulesSrc = readSrc('project/rules.ts');
  const rulesCode = stripComments(rulesSrc);
  const probeCode = stripComments(readSrc('project/probe.ts'));
  const rtCode = stripComments(readSrc('runtime/runtime.ts'));
  const pcCode = stripComments(readSrc('harness/project-context.ts'));
  const implCode = stripComments(readSrc('context/system-prompt.ts'));
  const coreCode = stripComments(readSrc('core/system-prompt.ts'));

  check('G1 rules.ts 判据不碰盘：import 只指向 node:path（不是 node:fs / child_process）',
    (rulesSrc.match(/^import .*from '([^']+)'/gm) ?? []).every((l) => /from 'node:path'/.test(l))
    && !/node:fs|child_process/.test(rulesCode));

  // 唯一调用点：判据不许被别处复制一份（散成多份就迟早各改各的）
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    .filter((f) => f.endsWith('.ts'));
  const callers = walk(srcDir)
    .filter((f) => /rulesCandidates\(/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  check('G2 `rulesCandidates` 只被探针调用（定义在 rules.ts、调用在 probe.ts，**唯一**）',
    callers.length === 2
    && callers.includes('src/project/rules.ts') && callers.includes('src/project/probe.ts'),
    callers.join(' / '));

  check('G3 runtime 真接线：渲染 + 传进 build（算了不用 = 没接）',
    rtCode.includes('renderRulesSection(rulesRegistry.get())')
    && rtCode.includes('rules: rulesSection === \'\' ? undefined : rulesSection'));
  // 接线断言（生产里这一行在不在）。**行为**由 F1–F3 钉：F2 那条"切到无规约项目必须变 null"
  // 就是"先清后栽"要的效果 —— 而 `set` 本身是全量替换，`set(null)` 即清，
  // 所以这里**故意**没有配对 `clear()`（判据见 project-context.ts 那段的注）。
  check('G4 播种处真把探测结果装进注册表（`rulesRegistry.set(probeRules(...))`）',
    /rulesRegistry\.set\(probeRules\(process\.cwd\(\)\)\)/.test(pcCode));
  check('G5 core 的 SystemPromptContext 有 `rules` 位',
    /rules\?:\s*string\s*\|\s*undefined/.test(coreCode));
  // ⚠ 若判据写成 `if (ctx.memory)`，那么"有规约但没有记忆"时规约会被整节丢掉 —— 演示脚本
  //   那种端到端的缺失正是靠这一条补上（它与 E4 是一对：一条钉源码意图、一条钉真行为）。
  check('G6 注入判据是 `ctx.rules || ctx.memory`（**不是** `ctx.memory` —— 只看记忆会把规约丢掉）',
    /if \(ctx\.rules \|\| ctx\.memory\)/.test(implCode));
  check('G7 注册表三件套齐（set / get / clear —— 切项目与测试都要复位）',
    /rulesRegistry = \{/.test(rulesCode)
    && /set\(hit: RulesHit \| null\)/.test(rulesCode) && /get\(\): RulesHit \| null/.test(rulesCode)
    && /clear\(\)/.test(rulesCode));
  // 本条钉的是"**没有偷偷加一层**"：规约折进 memory 层是刻意的取舍（见 rules.ts 文件头），
  // 而最容易的走偏方式就是顺手给 union 添一个 'rules' —— 那条串是承重的，动了要同步两处套件。
  check('G8 分层序一个字没动（union 里**没有** rules 这种新层）',
    coreCode.includes("'core' | 'tools' | 'skills' | 'project' | 'memory' | 'task' | 'summary' | 'custom'")
    && !/'rules'/.test(coreCode));
  check('G9 probe.ts 仍是"唯一碰盘"的那个：规约文件的读取只在那里',
    probeCode.includes('readFileSync(c.abs') && !/readFileSync\(.*AGENTS/.test(rulesCode));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
