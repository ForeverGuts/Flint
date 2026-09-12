/**
 * edit 工具验证脚本 —— 精准替换的"肯拒绝"性质与字节级保真。
 *
 * 背景：edit 的价值不在"会替换"（split/join 一行就够），而在**拿不准时拒绝且一字不落盘**：
 *       0 命中说明模型记错了原文，多命中说明指认不唯一，两种情况下"猜一个"都会静默改错地方，
 *       而模型和用户都看不出来。本套把这两条拒绝路径、以及 Windows 上最容易出事的
 *       行尾/BOM 保真钉死。
 *
 * 三段承重设计（改代码前请先读，别"顺手修好"）：
 *   ① 拒绝路径用 [ERROR] 前缀：agent-loop 把 [ERROR]/[VERIFY_FAILED]/[INVALID] 记作失败，
 *      而"重复失败保护"只在失败时计数——换成 [NO_MATCH]/[NOT_FOUND] 等于关掉那层保护，
 *      模型会拿同一个错 oldText 一直空转烧轮次。
 *      （2026-09-05 起 [INVALID] 也计失败，行为上已等价；但 0 命中不是"参数格式不合法"，
 *      而是"文件内容与模型预期不符"——参数本身完全合法，语义上仍属执行失败，故保留 [ERROR]）
 *   ② permissionDetail 必须返回单行：selector 标题只占 1 行且按 fitWidth 截断，
 *      文案里带 \n 会多出一个物理行，把"固定行数 + 回退清行"算错 → 选择器漂移。
 *   ③ 弹窗文案与授权匹配键是两个变量：匹配键（autoKey）由 permissionKey 定、**不截断**，
 *      文案（detail）由 permissionDetail 定、截到 80 字符。两者混用一个字符串会让"本次全部
 *      允许"永远失配；而匹配键一旦截断就会反过来静默扩权（见 verify-permission.ts）。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-edit.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';

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

/* ── 真件：用生产用的 ToolRegistry，不打桩 ── */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-edit-'));
const registry = new ToolRegistry();
registerBuiltinTools(registry);

/** 建一个临时文件，返回绝对路径 */
function makeFile(name: string, content: string | Buffer): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}
// execute 现在返回结构化 ToolResult（status 给机器、content 给模型）；
// 本地 helper 统一解包出模型可见文本，下面的断言一字不动
const edit = async (args: Record<string, unknown>): Promise<string> =>
  (await registry.execute('edit', args)).content;
const text = (p: string): string => fs.readFileSync(p, 'utf-8');
const bytes = (p: string): Buffer => fs.readFileSync(p);
const countLf = (s: string): number => (s.match(/\n/g) ?? []).length;
const countCrlf = (s: string): number => (s.match(/\r\n/g) ?? []).length;

const builtinSrc = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8');
const loopSrc = fs.readFileSync(path.join(ROOT, 'src/loop/agent-loop.ts'), 'utf-8');
const coreSrc = fs.readFileSync(path.join(ROOT, 'src/core/tools.ts'), 'utf-8');

/* ── ① 契约：可选成员不打坏现有实现 ── */

console.log('\n① 契约与注册（加的是**可选**成员，9 处 ToolProvider 替身不受影响）');
{
  const llmTools = registry.getLLMTools();
  const names = llmTools.map((t) => t.function.name);
  check('A1 内置工具从 5 个变 7 个，含 edit 与 todo', llmTools.length === 7 && names.includes('edit') && names.includes('todo'), names.join(','));
  check('A2 edit 需要用户确认（改类工具不可静默执行）', registry.requiresPermission('edit') === true);
  const params = llmTools.find((t) => t.function.name === 'edit')?.function.parameters as
    | { required?: string[]; properties?: Record<string, unknown> }
    | undefined;
  check('A3 必填 path/oldText/newText，replaceAll 为可选',
    JSON.stringify(params?.required) === JSON.stringify(['path', 'oldText', 'newText'])
    && params?.properties?.replaceAll !== undefined,
    JSON.stringify(params?.required));
  check('A4 ToolProvider.permissionDetail 声明为**可选**成员（必需成员会打坏替身与实现）',
    /permissionDetail\?\(name: string, args: Record<string, unknown>\): string \| undefined;/.test(coreSrc));
  check('A5 agent-loop 用可选调用 + 兜底（permissionKey 没定义就退回完整 args JSON、permissionDetail 没定义就退回前 80 字符）',
    /tools\.permissionKey\?\.\(tc\.function\.name, args\) \|\| argsJson/.test(loopSrc)
    && /tools\.permissionDetail\?\.\(tc\.function\.name, args\) \|\| argsJson\.slice\(0, 80\)/.test(loopSrc));
  check('A6 拒绝路径用 error（toolError）这一点留有承重注释（防止后人为一致性改成 negative 关掉重复失败保护）',
    /状态的选择是\*\*承重的\*\*/.test(builtinSrc) && /return toolError\(`oldText 在文件中找不到/.test(builtinSrc));
}

/* ── ② 唯一命中：真改，且只改那一处 ── */

console.log('\n② 唯一命中 → 替换生效');
{
  const p = makeFile('b.txt', 'line one\nconst count = 1;\nline three\n');
  const r = await edit({ path: p, oldText: 'const count = 1;', newText: 'const count = 2;' });
  check('B1 返回 [OK] 并报告替换了 1 处', r.startsWith('[OK]') && r.includes('已替换 1 处'), r);
  check('B2 文件内容真的变了（不是只在返回值里说变了）', text(p).includes('const count = 2;'));
  check('B3 未命中的部分逐字符不变', text(p) === 'line one\nconst count = 2;\nline three\n', JSON.stringify(text(p)));
  check('B4 [OK] 文案带行数与字符数变化（模型据此判断改动规模）',
    r.includes('行') && r.includes('字符'), r);
}

/* ── ③ 0 命中：拒绝，文件一字不动 ── */

console.log('\n③ 0 命中 → 拒绝（模型记错原文时任何"猜"都是破坏）');
{
  const p = makeFile('c.txt', 'alpha\nbeta\n');
  const before = bytes(p);
  const r = await edit({ path: p, oldText: 'gamma', newText: 'x' });
  check('C1 返回 [ERROR]（会被 agent-loop 记作失败 → 重复失败保护生效）', r.startsWith('[ERROR]'), r);
  check('C2 文件逐字节一字不动', bytes(p).equals(before));
  check('C3 文案给出可操作的下一步：报文件行数 + 要求逐字符一致 + 让模型先 read',
    r.includes('文件共 3 行') && r.includes('逐字符一致') && r.includes('read'), r);
  // 结构化返回值（2026-09-12）后分类不再解析前缀文本，钉两件事：
  // ① core 里 toolStatusFails 的名单**恰好**是 invalid / error / verify_failed 三个；
  // ② agent-loop 只准调这个唯一判定式（`failed = toolStatusFails(result.status)`），
  //    不许再自己 startsWith——副本会漂移，正是旧协议的病根。
  const failsDef = coreSrc.match(/export function toolStatusFails[\s\S]*?\n}/)?.[0] ?? '';
  const failsList = [...failsDef.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check('C4 计失败的状态恰好是 invalid / error / verify_failed 三个（C1 的意义依赖这条）',
    failsList.join(',') === 'invalid,error,verify_failed', `实际=${JSON.stringify(failsList)}`);
  check('C4b agent-loop 的 failed 判定走唯一判定式 toolStatusFails，不再解析前缀文本',
    /failed = toolStatusFails\(result\.status\)/.test(loopSrc), loopSrc.slice(0, 0) || 'loop 缺 toolStatusFails 接线');
}

/* ── ④ 多命中：拒绝并回报候选行号；replaceAll 才全改 ── */

console.log('\n④ 多命中 → 拒绝 + 候选行号（"改第一处"是最危险的静默错改）');
{
  const p = makeFile('d.txt', 'foo\nbar\nfoo\nbaz\nfoo\n');
  const before = bytes(p);
  const r = await edit({ path: p, oldText: 'foo', newText: 'qux' });
  check('D1 默认拒绝，返回 [ERROR]', r.startsWith('[ERROR]'), r);
  check('D2 文件逐字节一字不动（没有偷偷改第一处）', bytes(p).equals(before));
  check('D3 回报命中数与**正确的**候选行号', r.includes('命中 3 处') && r.includes('第 1, 3, 5 行'), r);
  check('D4 文案指明两条出路：加上下文使其唯一，或显式 replaceAll',
    r.includes('唯一') && r.includes('replaceAll'), r);
  const r2 = await edit({ path: p, oldText: 'foo', newText: 'qux', replaceAll: true });
  check('D5 replaceAll: true 时全部替换并报告处数', r2.startsWith('[OK]') && r2.includes('已替换 3 处'), r2);
  check('D6 替换后旧文本 0 次、新文本 3 次',
    text(p).split('foo').length - 1 === 0 && text(p).split('qux').length - 1 === 3, JSON.stringify(text(p)));
}

/* ── ⑤ 行尾与 BOM：Windows 上最要紧的一节 ── */

console.log('\n⑤ 行尾 / BOM 保真（core.autocrlf=true 检出的源码就是 CRLF）');
{
  // 纯 CRLF：模型发来的 oldText 必然用 \n，不归一化就 0 命中
  const p = makeFile('e1.txt', 'a = 1;\r\nb = 2;\r\nc = 3;\r\n');
  const r = await edit({ path: p, oldText: 'b = 2;', newText: 'b = 9;' });
  check('E1 纯 CRLF 文件用 \\n 版 oldText 也能命中（归一化副本生效）', r.startsWith('[OK]'), r);
  check('E2 改完仍是纯 CRLF（每个 \\n 都带 \\r，没变成混合行尾）',
    countLf(text(p)) === 3 && countCrlf(text(p)) === 3, JSON.stringify(text(p)));
  check('E3 全文逐字节等于预期（未改动行的 CRLF 完好）',
    text(p) === 'a = 1;\r\nb = 9;\r\nc = 3;\r\n', JSON.stringify(text(p)));
  check('E4 [OK] 文案明说 CRLF 已保持', r.includes('CRLF 已保持'), r);

  // BOM：按 'utf-8' 编码读会静默吃掉 BOM，写回就丢了
  const pb = makeFile('e2.txt', Buffer.from('\uFEFFx = 1;\ny = 2;\n', 'utf-8'));
  const rb = await edit({ path: pb, oldText: 'y = 2;', newText: 'y = 3;' });
  check('E5 带 BOM 的文件改完 BOM 仍在（头三字节仍是 EF BB BF）',
    bytes(pb)[0] === 0xef && bytes(pb)[1] === 0xbb && bytes(pb)[2] === 0xbf, bytes(pb).subarray(0, 3).toString('hex'));
  // 按字节比，不按 'utf-8' 读回来比：实测 Node v24.12.0 用 utf-8 读**不剥** BOM，
  // 断言"读回来等于不含 BOM 的文本"会把 Node 的行为细节当成被测对象的性质。
  check('E6 BOM 之后的内容逐字节正确，且文案明说 BOM 已保持',
    bytes(pb).equals(Buffer.from('\uFEFFx = 1;\ny = 3;\n', 'utf-8')) && rb.includes('BOM 已保持'),
    bytes(pb).toString('hex'));

  // 纯 LF 不能被"顺手"转成 CRLF
  const pl = makeFile('e3.txt', 'p = 1;\nq = 2;\n');
  await edit({ path: pl, oldText: 'q = 2;', newText: 'q = 3;' });
  check('E7 纯 LF 文件改完仍是纯 LF', countCrlf(text(pl)) === 0 && countLf(text(pl)) === 2);

  // 混合行尾：不做波及全文的还原，宁可拒绝
  const pm = makeFile('e4.txt', 'm = 1;\r\nn = 2;\nn = 3;\n');
  const bm = bytes(pm);
  const rm = await edit({ path: pm, oldText: 'm = 1;\nn = 2;', newText: 'z' });
  check('E8 混合行尾文件跨行匹配不上时拒绝且文件不动（不猜、不全文还原）',
    rm.startsWith('[ERROR]') && bytes(pm).equals(bm), rm);
}

/* ── ⑥ 参数校验与边界 ── */

console.log('\n⑥ 参数与边界');
{
  const p = makeFile('f1.txt', 'keep\nDROP ME\nkeep2\n');
  const r = await edit({ path: p, oldText: 'DROP ME\n', newText: '' });
  check('F1 newText 传空串 = 删除该片段（合法意图，不当缺参拒绝）',
    r.startsWith('[OK]') && text(p) === 'keep\nkeep2\n', `${r} / ${JSON.stringify(text(p))}`);

  const p2 = makeFile('f2.txt', 'aaa\n');
  const b2 = bytes(p2);
  const r2 = await edit({ path: p2, oldText: 'aaa' });
  check('F2 newText 键缺失 → [INVALID] 且文件不动（漏传不能静默删光内容）',
    r2.startsWith('[INVALID]') && r2.includes('newText') && bytes(p2).equals(b2), r2);

  const r3 = await edit({ path: p2, newText: 'x' });
  check('F3 oldText 缺失 → [INVALID]', r3.startsWith('[INVALID]') && r3.includes('oldText'), r3);
  const r4 = await edit({ path: p2, oldText: '   ', newText: 'x' });
  check('F4 oldText 全空白 → [INVALID]（空白片段会命中一片，必须挡）',
    r4.startsWith('[INVALID]') && bytes(p2).equals(b2), r4);

  const r5 = await edit({ path: p2, oldText: 'aaa', newText: 'aaa' });
  check('F5 oldText 与 newText 相同 → [INVALID] 且文件不动（不落盘、不假报成功）',
    r5.startsWith('[INVALID]') && bytes(p2).equals(b2), r5);

  const r6 = await edit({ path: path.join(tmpDir, 'nope.txt'), oldText: 'a', newText: 'b' });
  check('F6 文件不存在 → [NOT_FOUND]（有效否定，与 read/write 一致，不是 [ERROR]）',
    r6.startsWith('[NOT_FOUND]') && r6.includes('write'), r6);
  const r7 = await edit({ path: tmpDir, oldText: 'a', newText: 'b' });
  check('F7 路径是目录 → [NOT_FILE]', r7.startsWith('[NOT_FILE]'), r7);
}

/* ── ⑦ 弹窗文案：单行契约 + 显示与匹配键分离 ── */

console.log('\n⑦ permissionDetail（显示归显示，授权匹配键归匹配键）');
{
  const d = registry.permissionDetail('edit', {
    path: 'src\\tools\\builtin.ts', oldText: 'const a = 1;', newText: 'const a = 2;',
  });
  check('G1 registry 把 permissionDetail 转发到工具，文案含路径与改动方向',
    d !== undefined && d.includes('src/tools/builtin.ts') && d.includes('→'), String(d));
  const multi = registry.permissionDetail('edit', {
    path: 'a.ts', oldText: 'line1\nline2\ttabbed\r\nline3', newText: 'x\ny',
  });
  check('G2 多行/带制表符的文本也被压成**单行**（带 \\n 会让 selector 固定行数回退算错 → 漂移）',
    multi !== undefined && !multi.includes('\n') && !multi.includes('\r') && !multi.includes('\t'),
    JSON.stringify(multi));
  check('G3 长文本被截断（弹窗标题只有 1 行，过长由 fitWidth 砍，工具侧先自截更可读）',
    multi !== undefined && multi.length < 80, String(multi?.length));
  const ra = registry.permissionDetail('edit', { path: 'a.ts', oldText: 'x', newText: 'y', replaceAll: true });
  check('G4 replaceAll 在文案里可见（用户要能看出这次会改多处）',
    ra !== undefined && ra.includes('全部'), String(ra));
  check('G5 未定义 permissionDetail 的工具（write）返回 undefined → agent-loop 退回默认',
    registry.permissionDetail('write', { path: 'a.ts', content: 'x' }) === undefined);
  check('G6 授权匹配用 autoKey、显示用 detail（合并成一个会让"本次全部允许"永远失配）',
    /isAutoAllowed\(tc\.function\.name, autoKey\)/.test(loopSrc)
    && /grantAutoAllow\(tc\.function\.name, autoKey\)/.test(loopSrc)
    && /onPermission\?\.\(tc\.function\.name, detail\)/.test(loopSrc));
}

/* ── 收尾 ── */

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
