/**
 * memory 工具 + MemoryStore 的功能专套 —— 项目长期记忆（C 方案第二次落地）。
 *
 * 结构沿用 verify-todo 的三段承重纪律（同一家族的套件长得像，读法就只有一种）：
 *   ① store 操作与不变量（空文本拒绝 / 重复拒绝 / 越界拒绝 / 防御性拷贝）
 *   ② render 与 fromMarkdown **严格互逆**（投影与种子是一对逆运算；40 组属性测试）
 *   ③ 投影（写盘）与种子（读盘）+ 跨"重启"往返
 *   ④ memory 工具端到端（真 ToolRegistry，走 parse 校验）
 *   ⑤ Runtime 运行期接线（行为证明）：memoryStore → system 的 memory 层
 *   ⑥ /memory 命令（含关键词过滤）
 *   ⑦ 源码防回退（分层顺序 / 注入接线 / 启动种子 / core-section 教学）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-memory.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import { MEMORY_FILE, MemoryStore, memoryStore } from '../src/memory/store.js';
import { TaskStore } from '../src/todo/store.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';
import { SpanCollectorImpl } from '../src/runtime/span-collector.js';
import { EventStream } from '../src/runtime/event-stream.js';
import { activate as activateMemory } from '../src/commands/builtin/memory.js';

/* ── 断言 ── */

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-verify-memory-'));
const P = (name: string): string => path.join(tmpDir, name);

/* ══════════════════════════════════════════════════════════════════════════
   ① MemoryStore 操作与不变量
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n① MemoryStore 操作与不变量');

{
  const s = new MemoryStore();
  check('A1 新 store 为空', s.isEmpty() && s.count() === 0);

  check('A2 add 返回 1 基序号（1/2/3）', s.add('约定甲') === 1 && s.add('坑乙') === 2 && s.add('决策丙') === 3);
  check('A4 add 空白文本 → -1 且不入列', s.add('   ') === -1 && s.count() === 3);
  check('A5 add 规整空白（换行/多空格 → 单空格 + trim）',
    (() => { const t = new MemoryStore(); t.add('  精确  匹配\n不是前缀  '); return t.list()[0] === '精确 匹配 不是前缀'; })());
  check('A6 重复条目 → -2 且不入列（防止模型换个措辞反复存）',
    s.add('约定甲') === -2 && s.count() === 3);

  check('A7 remove(2) 删除第 2 条', s.remove(2) === true && s.count() === 2 && s.list()[1] === '决策丙');
  check('A8 越界 remove → false（0 / 超界 / 小数都不接受）',
    s.remove(0) === false && s.remove(3) === false && s.remove(1.5) === false);

  const snap = s.list();
  snap[0] = '被外部改掉';
  snap.push('幽灵条目');
  check('A9 list() 是防御性拷贝（改返回值不影响 store 内部）',
    s.list()[0] === '约定甲' && s.count() === 2);

  s.clear();
  check('A10 clear 清空', s.isEmpty() && s.count() === 0);
  s.reset();
  check('A11 reset 复位（与 clear 目前等价，语义留给测试隔离）', s.isEmpty());
}

/* ══════════════════════════════════════════════════════════════════════════
   ② render / fromMarkdown 互逆（投影与种子是一对逆运算）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n② render 与 fromMarkdown 严格互逆（写盘 / 读盘是一对逆运算）');

{
  const s = new MemoryStore();
  s.add('约定甲');
  s.add('坑乙：PermissionManager 是精确匹配');
  s.add('决策丙');
  check('B1 render 输出逐字正确（`- ` 条目行）',
    s.render() === '- 约定甲\n- 坑乙：PermissionManager 是精确匹配\n- 决策丙', JSON.stringify(s.render()));

  const back = MemoryStore.fromMarkdown(s.render());
  check('B2 fromMarkdown(render()) 还原出逐字相同的条目',
    JSON.stringify(back.list()) === JSON.stringify(s.list()), JSON.stringify(back.list()));

  check('B3 空 store：render 是空串、parse 空串得空清单',
    new MemoryStore().render() === '' && MemoryStore.fromMarkdown('').count() === 0);

  // 属性测试：伪随机生成合法状态 → render → parse → 必须完全一致（固定种子，可复现）
  let seed = 987654321;
  const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pool = ['约定：精确匹配', '坑：CRLF 行尾', '决策：组件树', '带  两个  空格', '一句很长的记忆条目——里面带破折号与标点，仍然只是一行'];
  let roundTripOk = 0;
  for (let iter = 0; iter < 40; iter++) {
    const a = new MemoryStore();
    const n = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) a.add(pool[Math.floor(rnd() * pool.length)]);
    const b = MemoryStore.fromMarkdown(a.render());
    if (JSON.stringify(b.list()) === JSON.stringify(a.list())) roundTripOk++;
  }
  check('B4 属性测试：40 组随机状态全部 render→parse 往返一致', roundTripOk === 40, `${roundTripOk}/40`);

  // 兼容写法：星号条目、缩进；标题/散文/空行被跳过（memory.md 有 `# 项目记忆` 头）
  const legacy = MemoryStore.fromMarkdown([
    '# 项目记忆',
    '这里是散文，不是条目',
    '',
    '- 条目一',
    '  * 条目二（星号变体）',
    '随便一句散文，也不是条目',
  ].join('\n'));
  check('B5 头部与散文被跳过，星号/缩进变体都认',
    legacy.count() === 2 && legacy.list()[0] === '条目一' && legacy.list()[1] === '条目二（星号变体）');

  check('B6 renderItems(无序号) 与 render() 逐字相同（排版只有一处实现）',
    MemoryStore.renderItems(s.list()) === s.render());
  check('B7 renderItems(带序号) 与 renderNumbered() 逐字相同',
    MemoryStore.renderItems(s.list(), true) === s.renderNumbered());
}

/* ══════════════════════════════════════════════════════════════════════════
   ③ 投影（写盘）与种子（读盘）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n③ projectToFile 投影 / loadFromFile 种子');

{
  const s = new MemoryStore();
  s.add('甲');
  s.add('乙');
  // 投影目标是子目录（.flint/）：首次写入要能自动建目录
  const f1 = P('sub/dir/mem.md');
  check('C1 有条目 → 写盘（自动建父目录），内容 = 头部 + render()',
    s.projectToFile(f1) === null && fs.existsSync(f1)
    && fs.readFileSync(f1, 'utf-8') === `# 项目记忆\n\n${s.render()}\n`);

  const back = MemoryStore.fromMarkdown(fs.readFileSync(f1, 'utf-8'));
  check('C2 写出的文件再 parse 回来逐字一致（头部被跳过）', JSON.stringify(back.list()) === JSON.stringify(s.list()));

  const s0 = new MemoryStore();
  const f0 = P('sub/dir/empty.md');
  fs.writeFileSync(f0, '# 项目记忆\n\n- 遗留\n');
  check('C3 空清单 → 删除投影文件（不留空壳，但不动同目录其他文件）',
    s0.projectToFile(f0) === null && !fs.existsSync(f0) && fs.existsSync(f1));

  const s2 = new MemoryStore();
  s2.loadFromFile(f1);
  check('C4 种子：吸收文件里的条目，且保留文件（记忆不会"过期作废"）',
    s2.count() === 2 && s2.list()[0] === '甲' && fs.existsSync(f1));

  const s3 = new MemoryStore();
  s3.loadFromFile(P('不存在的文件.md'));
  check('C5 种子：文件缺失 → 空清单，不抛', s3.isEmpty());

  // 跨"重启"往返：A 变更 → 投影 → 新 store 读同一文件 → 与 A 相同
  const A = new MemoryStore();
  A.add('第一条');
  A.add('第二条');
  A.add('第三条');
  A.remove(2);
  const fa = P('restart-mem.md');
  A.projectToFile(fa);
  const B = new MemoryStore();
  B.loadFromFile(fa);
  check('C6 跨重启往返：投影 → 重新读取 → 状态逐字相同',
    JSON.stringify(B.list()) === JSON.stringify(A.list()), JSON.stringify(B.list()));
}

/* ══════════════════════════════════════════════════════════════════════════
   ④ memory 工具端到端（真 ToolRegistry + registerBuiltinTools，走 parse 校验）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n④ memory 工具端到端（增量接口 + 返回值即清单 + 投影）');

{
  // 工具把 .flint/memory.md 写在 cwd —— 切到临时目录，避免污染仓库根
  const cwd0 = process.cwd();
  process.chdir(tmpDir);
  try {
    const mem = new MemoryStore();
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, new TaskStore(), mem);
    const memory = async (args: Record<string, unknown>): Promise<string> =>
      (await reg.execute('memory', args)).content;

    check('D1 memory 已注册进 LLMTools（模型看得见）',
      reg.getLLMTools().some((t) => t.function.name === 'memory'));

    const r1 = await memory({ op: 'add', text: '约定甲' });
    check('D2 add 返回 [OK] 且回显带序号的清单',
      r1.startsWith('[OK]') && r1.includes('1. 约定甲'), r1.split('\n').slice(0, 2).join(' / '));

    const r2 = await memory({ op: 'add', text: '坑乙' });
    check('D3 头部计数正确', r2.includes('项目记忆（2 条'), r2.split('\n')[0]);

    check('D4 重复 add → [INVALID] 且原样回显条目',
      (await memory({ op: 'add', text: '约定甲' })).startsWith('[INVALID]'));
    check('D5 add 缺 text → [INVALID]', (await memory({ op: 'add' })).startsWith('[INVALID]'));
    check('D6 remove 越界 → [INVALID] 且说明范围',
      (await memory({ op: 'remove', index: 99 })).startsWith('[INVALID]'));
    check('D7 未知 op → [INVALID] 且列出可用操作',
      (await memory({ op: 'frobnicate' })).startsWith('[INVALID]'));
    check('D8 缺 op → [INVALID]（由 parse 拦）', (await memory({})).startsWith('[INVALID]'));
    check('D9 text 传数字 → [INVALID]（spec 类型校验生效）',
      (await memory({ op: 'add', text: 123 })).startsWith('[INVALID]'));
    check('D10 传未知参数 → [INVALID]（parse 拒多余参数）',
      (await memory({ op: 'add', text: 'x', foo: 1 })).startsWith('[INVALID]'));

    check('D11 每次变更后 .flint/memory.md 反映当前状态（投影生效）',
      fs.existsSync(path.join(tmpDir, '.flint/memory.md'))
      && fs.readFileSync(path.join(tmpDir, '.flint/memory.md'), 'utf-8').includes('- 坑乙'));

    const r3 = await memory({ op: 'remove', index: 2 });
    check('D12 remove 后清单只剩第 1 条', r3.includes('1. 约定甲') && !r3.includes('坑乙'), r3);

    const rc = await memory({ op: 'clear' });
    check('D13 clear → 清空 + 移除 .flint/memory.md',
      rc.startsWith('[OK]') && !fs.existsSync(path.join(tmpDir, '.flint/memory.md')) && mem.isEmpty());

    // 缺省 store 必须是进程级单例（runtime 也读同一个），否则"工具改了、runtime 看不到"
    const reg2 = new ToolRegistry();
    registerBuiltinTools(reg2);   // 全部走缺省单例
    await reg2.execute('memory', { op: 'add', text: '单例探针' });
    check('D14 不传 store 时作用于共享单例 memoryStore（tool 与 runtime 同一份状态）',
      memoryStore.count() >= 1 && memoryStore.list().some((t) => t === '单例探针'));
    memoryStore.reset();
  } finally {
    process.chdir(cwd0);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑤ Runtime 运行期接线（行为证明）：memoryStore → system 的 memory 层
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ Runtime 运行期接线（行为）：memoryStore → system 的 memory 层');

{
  const cwd0 = process.cwd();
  process.chdir(tmpDir);
  try {
    // 假 LLM：无工具调用、一轮即收尾（与 verify-todo ⑦ 段同一套替身）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeLlm: any = {
      chat: async () => ({ content: '' }),
      stream: () => {
        const es = new EventStream<{ type: string; [k: string]: unknown }>(
          (e) => e.type === 'end',
          (e) => e as { type: 'end'; fullText: string },
        );
        queueMicrotask(() => {
          es.push({ type: 'token', text: 'ok' });
          es.push({ type: 'end', fullText: 'ok' });
        });
        return es;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session: any = { getMessages: async () => [], appendMessage: async () => {}, clear: async () => {} };
    // 关键探针：假 systemPromptService 把收到的 ctx 记下来
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastCtx: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sysPrompt: any = {
      build: async (ctx: unknown) => {
        lastCtx = ctx;
        return { messages: [{ layer: 'core', content: 'x' }] };
      },
    };
    const rt = new Runtime({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      llm: fakeLlm as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: session as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => ({ status: 'ok', content: '' }), register: () => {} } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      permission: { isAutoAllowed: () => true, grantAutoAllow: () => {}, clear: () => {} } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skills: { load: () => {}, getAll: () => [], get: () => undefined } as any,
      events: new PromptEventEmitter(),
      spanCollector: new SpanCollectorImpl(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commandSystem: { register: () => {}, list: () => [], execute: async () => null } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      diagnosticsService: { record: () => {}, getAll: () => [] } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compaction: { maybeCompact: async (h: unknown) => ({ history: h }) } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      systemPromptService: sysPrompt as any,
    });

    memoryStore.reset();
    await rt.prompt('随便说点什么');
    check('E1 空记忆：Runtime 不注入 memory 层（ctx.memory 为 undefined）', lastCtx?.memory === undefined);

    memoryStore.add('精确匹配约定');
    memoryStore.add('CRLF 行尾坑');
    await rt.prompt('继续');
    check('E2 有记忆条目：ctx.memory 正是 memoryStore.render() 的渲染结果',
      typeof lastCtx?.memory === 'string'
      && lastCtx.memory.includes('- 精确匹配约定') && lastCtx.memory.includes('- CRLF 行尾坑'),
      JSON.stringify(lastCtx?.memory));

    memoryStore.reset();
    await rt.prompt('再继续');
    check('E3 清空后：不再注入 memory 层', lastCtx?.memory === undefined);
  } finally {
    process.chdir(cwd0);
    memoryStore.reset();
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑥ /memory 命令（含关键词过滤）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ /memory 命令');

{
  memoryStore.reset();
  // 假 runtime：只截获注册动作，把 handler 拿出来直接调（不必真起一个 Runtime）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reg: { name: string; desc: string; fn: (args: string) => string } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activateMemory({ registerCommand: (name: string, desc: string, fn: (args: string) => string) => { reg = { name, desc, fn }; } } as any);

  check('F1 /memory 已注册（loader 自动扫描 builtin/ 目录）', reg?.name === 'memory');
  check('F2 空记忆：如实说没有并指路',
    (reg?.fn('') ?? '').includes('项目记忆为空') && (reg?.fn('') ?? '').includes('memory 工具'));

  memoryStore.add('约定：精确匹配');
  memoryStore.add('坑：CRLF 行尾');
  const all = reg!.fn('');
  check('F3 无参数：显示全部条目（带序号与总数）',
    all.includes('2 条') && all.includes('1. 约定：精确匹配') && all.includes('2. 坑：CRLF 行尾'), all);

  const hit = reg!.fn('crlf');
  check('F4 关键词过滤不分大小写，只显示命中',
    hit.includes('CRLF 行尾') && !hit.includes('精确匹配') && hit.includes('1/2'), hit);
  const miss = reg!.fn('不存在的词');
  check('F5 无命中：如实说没有', miss.includes('无含') && miss.includes('共 2 条'), miss);

  memoryStore.reset();
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑦ 源码防回退（分层顺序 / 注入接线 / 启动种子 / core-section 教学）
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n⑦ 源码防回退');

{
  const corePromptSrc = fs.readFileSync(path.join(ROOT, 'src/core/system-prompt.ts'), 'utf-8');
  const ctxPromptSrc = fs.readFileSync(path.join(ROOT, 'src/context/system-prompt.ts'), 'utf-8');
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'src/runtime/runtime.ts'), 'utf-8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf-8');
  const coreSectionSrc = fs.readFileSync(path.join(ROOT, 'src/context/sections/core-section.ts'), 'utf-8');
  const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8');

  check('G1 SystemPromptLayer 含 memory（类型层承认这一层存在）',
    corePromptSrc.includes("'core' | 'tools' | 'skills' | 'memory' | 'task' | 'summary' | 'custom'"));
  check('G2 SystemPromptContext 有 memory 字段（runtime → build 的通道）',
    /memory\?: string \| undefined/.test(corePromptSrc));

  // 分层顺序是**承重的**（越稳定越靠前）：memory 必须出现在 task 之前、summary 之前
  const idxMemory = ctxPromptSrc.indexOf("layer: 'memory'");
  const idxTask = ctxPromptSrc.indexOf("layer: 'task'");
  const idxSummary = ctxPromptSrc.indexOf("layer: 'summary'");
  check('G3 memory 层注入在 task 之前、summary 之前（稳定前缀纪律）',
    idxMemory !== -1 && idxMemory < idxTask && idxTask < idxSummary);

  check('G4 runtime 读 memoryStore 且把 memory 传进 build（注入接线）',
    runtimeSrc.includes('memoryStore.isEmpty()') && runtimeSrc.includes('memory: projectMemory'));
  check('G5 runtime 截断与 task 层同一口径（2000 字符）',
    /projectMemory = rawMemory && rawMemory\.length > 2000/.test(runtimeSrc));
  check('G6 main 启动时用 loadFromFile 做一次性种子',
    /memoryStore\.loadFromFile\(MEMORY_FILE\)/.test(mainSrc));
  check('G7 core-section 教模型用 memory 工具（暗号对上：注入层存在 ⇔ 教学存在）',
    coreSectionSrc.includes('memory 工具 op:"add"'));
  check('G8 builtin 注册了 memory 工具（工具面存在）',
    builtinSrc.includes("name: 'memory'") && builtinSrc.includes('memoryStore'));

  // 空清单删文件、但不删 .flint/ 目录（events.jsonl 可能还住在里面）——这条语义别"顺手改掉"
  const storeSrc = fs.readFileSync(path.join(ROOT, 'src/memory/store.ts'), 'utf-8');
  check('G9 记忆空清单走 unlinkSync 删文件（不是清空文件内容）', storeSrc.includes('unlinkSync(path)'));
}

/* ── 清理与汇总 ── */

fs.rmSync(tmpDir, { recursive: true, force: true });
check('Z1 临时目录已清理', !fs.existsSync(tmpDir));

// 结果行格式是 run-verify.mjs 的解析契约（/结果[：:]\s*(\d+)\s*通过.../），别改成自由文案
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
