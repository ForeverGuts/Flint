/**
 * 扩展装载验证脚本 —— 三类口子的装载 / ctx 能力边界 / 容错 / 清理。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-extensions.ts
 *
 * 背景（此前两处盲区）：
 *   - verify-events 的 ⑧ 是直接 import trace-log 模块 + 手工调 registerWatchers，
 *     它只测了扩展本身，从没测过"装载器扫不扫得到扩展目录"——搬目录这类改动最大的风险点恰在此
 *   - "watcher 拿不到 on"这条能力边界只写在类型声明里，而类型声明自己是可以被改的
 *     （接口加一个 on + 调用处跟着加，两行一起改，编译全过，没人报警）
 *
 * 手法：探针法。往三类扩展目录各临时放一个探针文件，探针把收到的 ctx 的键记到 globalThis，
 *       跑真实 loadExtensions 后断言键集合。类型在运行时被擦除，只能这样看"它实际递了什么"。
 *       探针文件在 finally 里全部删除 —— 残留会被每次真实启动装载。
 *
 * 覆盖：
 *   ① 三类口子都能被装载器扫到并注册成功
 *   ② ctx 能力边界：watcher 只有 events / hook 有 on+events / sections 只有 addSection
 *   ③ 边界的行为证据：不开开关时零订阅，watcher 从不往精确监听表里加东西
 *   ④ 走真实装载路径的 trace-log 端到端落盘（verify-events 只测了手工注册那条路）
 *   ⑤ 单个扩展抛异常不连坐同目录里排在它后面的扩展（loadDir 的静默 catch）
 *   ⑥ 探针清理干净，生产目录无残留
 */
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '../src/context/extension-loader.js';
import { PromptEventEmitter } from '../src/runtime/events.js';

let passed = 0;
let failed = 0;

function check(desc: string, ok: boolean, extra?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${desc}`);
  } else {
    failed++;
    console.log(`  ❌ ${desc}${extra ? `（${extra}）` : ''}`);
  }
}

const extRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'extensions');

/** 四个临时探针：三类口子各一个 + 一个故意抛异常的坏扩展（测容错） */
const PROBES = {
  sections: join(extRoot, 'sections', '__probe-ext.ts'),
  hooks: join(extRoot, 'hooks', '__probe-ext.ts'),
  watchers: join(extRoot, 'watchers', '__probe-ext.ts'),
  bad: join(extRoot, 'watchers', '__bad-ext.ts'),
};

/* 探针内容：只把"实际收到的 ctx 长什么样"记到 globalThis。
   参数写 unknown 是为了不与装载器的 ctx 类型声明互相约束 —— 要测的正是它实际递了什么。
   __bad-ext 的字母序排在 __probe-ext 与 trace-log 之前（_ < t），
   于是它先抛错，正好验证"前面的坏了不牵连后面的"。 */
const PROBE_SRC = {
  sections: `export function registerSections(ctx: unknown): void {
  (globalThis as Record<string, unknown>).__probeSections = Object.keys(ctx as object);
}
`,
  hooks: `export function registerHooks(ctx: unknown): void {
  (globalThis as Record<string, unknown>).__probeHooks = Object.keys(ctx as object);
}
`,
  watchers: `export function registerWatchers(ctx: unknown): void {
  const c = ctx as Record<string, unknown>;
  const g = globalThis as Record<string, unknown>;
  g.__probeWatchers = { keys: Object.keys(c), hasOn: 'on' in c, isBus: c.events === g.__probeBus };
}
`,
  bad: `export function registerWatchers(): void {
  throw new Error('故意失败：验证单个扩展抛异常不连坐其他扩展');
}
`,
};

/** 总线内部的两张表（TS 的 private 只是编译期，运行时可读 —— 断言边界的行为证据要用） */
function tablesOf(bus: PromptEventEmitter): { subs: Set<unknown>; hooks: Map<string, unknown> } {
  const b = bus as unknown as { subscribers: Set<unknown>; hooks: Map<string, unknown> };
  return { subs: b.subscribers, hooks: b.hooks };
}

const g = globalThis as Record<string, unknown>;

async function main(): Promise<void> {
  for (const [k, p] of Object.entries(PROBES)) {
    writeFileSync(p, PROBE_SRC[k as keyof typeof PROBE_SRC], 'utf-8');
  }

  const tmp = join(tmpdir(), `flint-ext-${Date.now()}.jsonl`);

  try {
    /* ══ 第一轮：不开 FLINT_TRACE —— 测装载、ctx 边界、零开销、容错 ══ */
    console.log('① 三类口子都能被装载器扫到并注册成功');
    const bus1 = new PromptEventEmitter();
    g.__probeBus = bus1;
    const ext = await loadExtensions(bus1);

    check('sections 装载到 1 个段落（example-rule 那一个；探针不注册段落）',
      ext.sections.length === 1, `实际 ${ext.sections.length}`);
    check('hooks 目录被扫到：hook 探针的 registerHooks 被调过', Array.isArray(g.__probeHooks));
    check('watchers 目录被扫到：watcher 探针的 registerWatchers 被调过',
      g.__probeWatchers !== undefined);

    console.log('');
    console.log('② ctx 能力边界（三类口子各拿到哪把钥匙）');
    const w = g.__probeWatchers as { keys: string[]; hasOn: boolean; isBus: boolean } | undefined;
    const h = g.__probeHooks as string[] | undefined;
    const s = g.__probeSections as string[] | undefined;

    check('watcher 的 ctx 键恰好只有 events',
      w?.keys.join(',') === 'events', `实际 [${w?.keys.join(',') ?? '探针未被调'}]`);
    check('watcher 的 ctx 里没有 on —— "旁观者改流程"这条边界真的封住了', w?.hasOn === false);
    check('watcher 拿到的 events 就是外面那条总线（不是空壳、不是副本）', w?.isBus === true);
    check('对照组：hook 的 ctx 同时有 on 与 events（证明探针手法本身读得到东西）',
      h !== undefined && h.includes('on') && h.includes('events'), `实际 [${h?.join(',') ?? '探针未被调'}]`);
    check('对照组：sections 的 ctx 键恰好只有 addSection',
      s?.join(',') === 'addSection', `实际 [${s?.join(',') ?? '探针未被调'}]`);

    console.log('');
    console.log('③ 边界的行为证据（不是看声明，是看总线里实际多了什么）');
    const t1 = tablesOf(bus1);
    check('不开 FLINT_TRACE 时通配订阅表为空 —— "不订阅、零开销"是实证而非注释',
      t1.subs.size === 0, `实际 ${t1.subs.size} 个订阅者`);
    check('精确监听表恰好是 example-hook 的三个工具/提示钩子（watcher 一条都没加）',
      t1.hooks.size === 3
      && t1.hooks.has('before_request')
      && t1.hooks.has('before_tool_call')
      && t1.hooks.has('after_tool_call'),
      `实际 [${[...t1.hooks.keys()].join(',') || '空'}]`);

    console.log('');
    console.log('⑤ 容错：单个扩展抛异常不连坐（loadDir 的静默 catch）');
    check('坏扩展抛异常后，同目录排在它后面的 watcher 探针仍被装载',
      w !== undefined && w.keys.join(',') === 'events');
    check('坏扩展抛异常后，另两个目录的扩展照常装载（sections 仍 1 个、hook 探针仍被调）',
      ext.sections.length === 1 && Array.isArray(g.__probeHooks));

    /* ══ 第二轮：开 FLINT_TRACE —— 走真实装载路径的端到端落盘 ══ */
    console.log('');
    console.log('④ 走真实装载路径的 trace-log 端到端（verify-events 测的是手工注册那条路）');
    process.env.FLINT_TRACE = '1';
    process.env.FLINT_TRACE_FILE = tmp;
    const bus2 = new PromptEventEmitter();
    await loadExtensions(bus2);
    const t2 = tablesOf(bus2);
    check('开了开关后 trace-log 挂上了通配订阅（且只挂了它自己一个）',
      t2.subs.size === 1, `实际 ${t2.subs.size}`);

    bus2.beginTurn();
    await bus2.trace('llm_request', { turn: 1, model: 'm', messageCount: 1, toolCount: 0 },
      async (span) => { span.set({ textLength: 3 }); });

    const lines = existsSync(tmp) ? readFileSync(tmp, 'utf-8').trim().split('\n').filter(Boolean) : [];
    check('自动装载的 watcher 真的落了盘：一对 span = 一行', lines.length === 1, `实际 ${lines.length} 行`);
    if (lines.length === 1) {
      const row = JSON.parse(lines[0]) as Record<string, any>;
      check('那行是完整记录（name/spanId/startedAt/durationMs/status/input/output 齐全）',
        row.name === 'llm_request' && typeof row.spanId === 'string'
        && typeof row.startedAt === 'string' && typeof row.durationMs === 'number'
        && row.status === 'ok' && row.input && row.output);
      check('进门载荷与出门载荷都在同一行（配对成功，且中途 set 的字段并进了 output）',
        row.input?.model === 'm' && row.output?.textLength === 3);
      check('段已关门，无 unclosed 残留', row.status !== 'unclosed');
    } else {
      check('那行是完整记录', false, '没有落盘行可查');
      check('进门载荷与出门载荷都在同一行', false, '没有落盘行可查');
      check('段已关门，无 unclosed 残留', false, '没有落盘行可查');
    }
    check('坏扩展抛异常也没牵连同目录的 trace-log（它排在坏扩展后面）', lines.length === 1);
  } finally {
    /* 探针必须删干净：残留在 src/extensions/ 里会被每次真实启动装载 */
    delete process.env.FLINT_TRACE;
    delete process.env.FLINT_TRACE_FILE;
    delete g.__probeBus;
    delete g.__probeSections;
    delete g.__probeHooks;
    delete g.__probeWatchers;
    for (const p of Object.values(PROBES)) {
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* 删不掉就让下面两条断言报红 */ }
      }
    }
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* 临时落盘文件残留不影响结论 */ }
    }
  }

  console.log('');
  console.log('⑥ 探针清理干净（生产目录不留垃圾）');
  check('四个探针文件都已从磁盘删除', Object.values(PROBES).every((p) => !existsSync(p)),
    Object.values(PROBES).filter((p) => existsSync(p)).join(' / '));
  const leftover = ['sections', 'hooks', 'watchers']
    .flatMap((d) => readdirSync(join(extRoot, d)).filter((f) => f.startsWith('__')))
    .join(' / ');
  check('三类扩展目录里没有 __ 开头的残留文件', leftover === '', leftover || '无');
  check('watchers/ 目录里只剩 trace-log.ts 一个文件',
    readdirSync(join(extRoot, 'watchers')).join(',') === 'trace-log.ts',
    readdirSync(join(extRoot, 'watchers')).join(' / '));

  console.log('');
  console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
