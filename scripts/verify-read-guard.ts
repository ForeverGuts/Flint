/**
 * read 工具二进制与体积体检验证套件（ROADMAP 10.7.4，2026-09-24）。
 *
 * 背景：read 此前对任何文件都整个读进来 —— 误读二进制是一屏乱码灌上下文，点名大文件
 * 是整个吞内存。grep/symbols 那条路早有体检（search/walk.ts 的 readForScan），但 read
 * 走"点名单个文件"的门一直没接。落地形状：walk.ts 抽出 headIsBinary 作**全仓唯一**
 * 二进制判定 + 判据模块 `src/tools/read-guard.ts`（分类 / 渲染 / 头部探测）+ read handler 接线。
 * 本套逐条打靶：
 *   ① headIsBinary 单元 —— 抽取成独立函数后的判定逐形状（窗口边界两条是重点）
 *   ② readForScan 回归 —— 重构没改老行为（grep/symbols 的口径不许漂）
 *   ③ classifyRead 纯判据 —— 先二进制后体积（次序承重）、边界等于放行、分段永远放行
 *   ④ isWholeRead —— "整读"的识别
 *   ⑤ renderReadNotice —— 断在渲染文本上；**二进制的出路里不许出现"分段"**（方向纪律）
 *   ⑥ 真件驱动 —— 真 ToolRegistry + 真文件端到端，含 NOT_FOUND/NOT_FILE 不受牵连
 *   ⑦ 源码守护 —— 单源（判定式只此一份）、接线在位、顺序在位、阈值单点
 *
 * 本套只在沙箱目录里写真文件，不碰 .flint/ → 照例 enterSandbox()。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-read-guard.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterSandbox } from './lib/sandbox.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import {
  READ_WHOLE_MAX_BYTES, classifyRead, guardForRead, isWholeRead, renderReadNotice,
} from '../src/tools/read-guard.js';
import { SCAN_MAX_FILE_BYTES, SCAN_PROBE_BYTES, headIsBinary, readForScan } from '../src/search/walk.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 自保（不计项数） ── */
const sandbox = enterSandbox('flint-read-guard-');
const tmpDir = sandbox.dir;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail !== undefined ? ` —— ${String(detail)}` : ''}`); }
}

/** 造一块填 65（'A'）的缓冲，再在指定位点点上指定字节 —— 夹具专用 */
function bufAt(size: number, patches: Array<[number, number]>, fill = 65): Buffer {
  const b = Buffer.alloc(size, fill);
  for (const [i, v] of patches) b[i] = v;
  return b;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ① headIsBinary 单元
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ① headIsBinary：抽取后的判定逐形状 ──');
{
  check('A1 纯文本头部 → 不是二进制',
    headIsBinary(Buffer.from('hello world\nconst x = 1;\n')) === false);
  check('A2 头部含 NUL → 二进制',
    headIsBinary(Buffer.concat([Buffer.from('abc'), Buffer.from([0]), Buffer.from('def')])) === true);
  check('A3 NUL 恰在窗口最后一格（下标 8191）→ 二进制（边界含端点）',
    headIsBinary(bufAt(SCAN_PROBE_BYTES, [[SCAN_PROBE_BYTES - 1, 0]])) === true);
  check('A4 NUL 恰在窗口外一格（下标 8192）→ 不是二进制（窗口只看前 8192）',
    headIsBinary(bufAt(SCAN_PROBE_BYTES + 1, [[SCAN_PROBE_BYTES, 0]])) === false);
  check('A5 自定义窗口生效：NUL 在 100、窗口 50 → 不是二进制',
    headIsBinary(bufAt(200, [[100, 0]]), 50) === false);
  check('A6 空文件 → 不是二进制（走正常读取路径）',
    headIsBinary(Buffer.alloc(0)) === false);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ② readForScan 回归（重构没改 grep/symbols 的口径）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ② readForScan 回归：重构不改老行为 ──');
{
  const p = path.join(tmpDir, 'scan-text.txt');
  fs.writeFileSync(p, 'plain text for scan');
  const r = readForScan(p);
  check('B1 小文本 → 照常可读，内容逐字一致', r.ok && r.buf.toString('utf-8') === 'plain text for scan');
}
{
  const p = path.join(tmpDir, 'scan-bin.dat');
  fs.writeFileSync(p, Buffer.concat([Buffer.from('head'), Buffer.from([0]), Buffer.from('tail')]));
  const r = readForScan(p);
  check('B2 含 NUL → 判二进制跳过（grep 的口径不变）', !r.ok && r.reason === 'binary');
}
{
  const p = path.join(tmpDir, 'scan-big.log');
  fs.writeFileSync(p, Buffer.alloc(SCAN_MAX_FILE_BYTES + 1, 65));
  const r = readForScan(p);
  check('B3 超 2MB → 判超大跳过（体积口径不变）', !r.ok && r.reason === 'big');
}
{
  const p = path.join(tmpDir, 'scan-small2.txt');
  fs.writeFileSync(p, Buffer.alloc(20, 65));
  const r = readForScan(p, 10);
  check('B4 自定义体积上限生效（参数照常流动）', !r.ok && r.reason === 'big');
}
{
  const p = path.join(tmpDir, 'scan-late-nul.txt');
  fs.writeFileSync(p, bufAt(200, [[100, 0]]));
  const r = readForScan(p, 1024 * 1024, 50);
  check('B5 自定义探测窗生效：NUL 在 100、窗 50 → 照常可读', r.ok);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ classifyRead 纯判据
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ③ classifyRead：次序承重 + 边界 ──');
{
  check('C1 二进制压过一切：又二进制又超大又是整读 → binary（不是 oversized）',
    classifyRead({ sizeBytes: 10 * 1024 * 1024, limit: Number.MAX_SAFE_INTEGER, headIsBinary: true }) === 'binary');
  check('C2 边界：恰好等于上限 → 放行（只拦"超过"，宁可少拦不可误拦）',
    classifyRead({ sizeBytes: READ_WHOLE_MAX_BYTES, limit: Number.MAX_SAFE_INTEGER, headIsBinary: false }) === undefined);
  check('C3 超上限 1 字节 + 整读 → oversized',
    classifyRead({ sizeBytes: READ_WHOLE_MAX_BYTES + 1, limit: Number.MAX_SAFE_INTEGER, headIsBinary: false }) === 'oversized');
  check('C4 超上限 + 指定 limit（分段）→ 放行（分段是大文件的正规通道，不拦）',
    classifyRead({ sizeBytes: 10 * 1024 * 1024, limit: 50, headIsBinary: false }) === undefined);
  check('C5 二进制 + 指定 limit → 仍是 binary（分段读出来的还是乱码）',
    classifyRead({ sizeBytes: 100, limit: 50, headIsBinary: true }) === 'binary');
  check('C6 干净小文件整读 → 放行（正常路径零变化）',
    classifyRead({ sizeBytes: 500, limit: Number.MAX_SAFE_INTEGER, headIsBinary: false }) === undefined);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ isWholeRead
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ④ isWholeRead：整读的识别 ──');
{
  check('D1 缺省 limit（MAX_SAFE_INTEGER）= 整读', isWholeRead(Number.MAX_SAFE_INTEGER) === true);
  check('D2 任何指定值都不是整读（含 1 这种极端小值）',
    isWholeRead(50) === false && isWholeRead(1) === false);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ renderReadNotice（断在渲染文本上）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑤ renderReadNotice：没读 · 为什么 · 怎么办 ──');
{
  const t = renderReadNotice('binary', 'assets/logo.png', 20480);
  check('E1 二进制说明三样齐全：判了二进制 / 带路径 / 带大小',
    t.includes('二进制') && t.includes('assets/logo.png') && t.includes('20480'));
  check('E2 二进制说明**不许出现"分段/offset"** —— 那条路对二进制走不通，方向给错比不给更坏',
    !t.includes('分段') && !t.includes('offset'));
  check('E3 二进制说明劝退重试（"重试结果相同"必须在场）', t.includes('重试结果相同'));
}
{
  const t = renderReadNotice('oversized', 'data/big.txt', READ_WHOLE_MAX_BYTES + 1);
  check('E4 超大说明给的是分段出路：带路径 / 带大小 / 指名 offset 与 limit',
    t.includes('data/big.txt') && t.includes(String(READ_WHOLE_MAX_BYTES + 1))
    && t.includes('offset') && t.includes('limit'));
  check('E5 超大说明的上限数字来自常量（阈值单点，不手抄第二份）',
    renderReadNotice('oversized', 'x', 1).includes(String(READ_WHOLE_MAX_BYTES)));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑥ 真件驱动：真 ToolRegistry + 真文件
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n── ⑥ 真件驱动：端到端 ──');
{
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);

  // 夹具：二进制（头部含 NUL）/ 超大文本（上限+1 字节）/ 普通文本 / NUL 在窗外 / 又二进制又超大
  fs.writeFileSync(path.join(tmpDir, 'logo.png'),
    Buffer.concat([Buffer.from('PNGMARKER-not-text'), Buffer.from([0, 1, 2, 3])]));
  const big = Buffer.alloc(READ_WHOLE_MAX_BYTES + 1, 65);
  big.write('const bigfilemarker = 1;\n', 0, 'utf-8');
  for (let i = 80; i < big.length; i += 80) big[i] = 10; // 每隔 80 字节一个换行
  fs.writeFileSync(path.join(tmpDir, 'big.txt'), big);
  fs.writeFileSync(path.join(tmpDir, 'text.txt'), 'hello guard\nsecond line\n');
  fs.writeFileSync(path.join(tmpDir, 'late-nul.txt'), bufAt(9000, [[8999, 0]]));
  fs.writeFileSync(path.join(tmpDir, 'binbig.bin'),
    Buffer.concat([Buffer.from([0x4b, 0]), Buffer.alloc(READ_WHOLE_MAX_BYTES + 10, 65)]));

  const read = async (args: Record<string, unknown>) =>
    await registry.execute('read', args);

  // F1：二进制被拦下，只给说明不给内容
  const f1 = await read({ path: path.join(tmpDir, 'logo.png') });
  check('F1 二进制文件：状态 ok、正文说"未读取内容+二进制"，乱码内容一个字不进上下文',
    f1.status === 'ok' && f1.content.includes('未读取内容') && f1.content.includes('二进制')
    && !f1.content.includes('PNGMARKER'), f1.content.slice(0, 120));

  // F2：超大整读被拦下，只给说明不给内容
  const f2 = await read({ path: path.join(tmpDir, 'big.txt') });
  check('F2 超大整读：说"未整读"并点名分段出路，内容不进上下文',
    f2.status === 'ok' && f2.content.includes('未整读') && f2.content.includes('分段')
    && !f2.content.includes('bigfilemarker'), f2.content.slice(0, 120));

  // F3：同一个超大文件，指定 limit 就是正规通道
  const f3 = await read({ path: path.join(tmpDir, 'big.txt'), limit: 5 });
  check('F3 同一个超大文件指定 limit → 照常分段读（正门不焊死）',
    f3.status === 'ok' && f3.content.includes('bigfilemarker') && f3.content.includes('行 1-5:')
    && f3.content.includes('1 | '), f3.content.slice(0, 120));

  // F4：普通小文本与改前行为逐字同形状（行号前缀格式不变）
  const f4 = await read({ path: path.join(tmpDir, 'text.txt') });
  check('F4 普通文本照常读：行号前缀格式与改前一致',
    f4.status === 'ok' && f4.content.includes('1 | hello guard') && f4.content.includes('2 | second line'));

  // F5：NUL 在探测窗外 → 不是二进制，照常读（窗口纪律在真件上成立）
  const f5 = await read({ path: path.join(tmpDir, 'late-nul.txt') });
  check('F5 NUL 在 8KB 窗外 → 不误判二进制，照常读',
    f5.status === 'ok' && f5.content.includes('行 1-1:') && !f5.content.includes('二进制'));

  // F6：又二进制又超大 → 答案必须是"二进制"，绝不能指去分段（次序承重）
  const f6 = await read({ path: path.join(tmpDir, 'binbig.bin') });
  check('F6 双重命中 → 说出的是 binary 那一版（分段对二进制是错误出路）',
    f6.content.includes('二进制') && !f6.content.includes('分段'), f6.content.slice(0, 120));

  // F7/F8：既有否定路径不受牵连
  const f7 = await read({ path: path.join(tmpDir, 'no-such-file.txt') });
  check('F7 文件不存在 → [NOT_FOUND] 原样（体检不抢既有判定的活）',
    f7.status === 'negative' && f7.content.startsWith('[NOT_FOUND]'));
  const f8 = await read({ path: tmpDir });
  check('F8 目标是目录 → [NOT_FILE] 原样', f8.status === 'negative' && f8.content.startsWith('[NOT_FILE]'));

  // F9：guardForRead 的 fail-open 形状（探不动的文件路径 → 不拦）
  check('F9 guardForRead 对打不开的路径返回 undefined（fail-open：没证据不拦）',
    guardForRead(path.join(tmpDir, 'definitely-missing.bin'), 100, Number.MAX_SAFE_INTEGER) === undefined);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑦ 源码守护（stripComments 后扫源码 —— 射程不含注释）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('── ⑦ 源码守护 ──');
{
  /** 抹掉注释再做源码文本断言 —— 本仓踩过九次"断言误伤注释" */
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const walkCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/search/walk.ts'), 'utf-8'));
  const guardCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/tools/read-guard.ts'), 'utf-8'));
  const builtinCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8'));

  check('G1 二进制判定式全仓只此一份：内联写法 `subarray(0, probeBytes).indexOf(0)` 在 walk.ts 只出现一次',
    (walkCode.match(/subarray\(0,\s*probeBytes\)\.indexOf\(0\)/g) ?? []).length === 1);

  check('G2 read-guard 只 import walk 的判据与窗口（不 import readForScan —— 判据不整读文件）',
    guardCode.includes("from '../search/walk.js'")
    && guardCode.includes('SCAN_PROBE_BYTES, headIsBinary')
    && !guardCode.includes('readForScan'));

  check('G3 read handler 真接了体检：guardForRead 与 renderReadNotice 两处调用都在位',
    builtinCode.includes('guardForRead(resolvedAbs')
    && builtinCode.includes('renderReadNotice(guardKind'));

  check('G4 classifyRead 先判二进制后判体积（次序承重 —— 顺序反了方向就给错）',
    (() => {
      const i = guardCode.indexOf("if (input.headIsBinary) return 'binary'");
      // 体积判定那行只认"拿 sizeBytes 与 READ_WHOLE_MAX_BYTES 比较"这个形状，
      // 不钉比较运算符（> 与 >= 是策略微调，不是次序变化 —— 变异 M4 的教训：钉死运算符
      // 会让"边界方向"的变异红错理由，红到手段断言头上）
      const j = guardCode.search(/input\.sizeBytes\s*[><]=?\s*READ_WHOLE_MAX_BYTES/);
      return i !== -1 && j !== -1 && i < j;
    })());

  check('G5 阈值在判定与渲染两处共用同一个常量（改一处两边生效，没有手抄的第二个 65536）',
    /sizeBytes\s*[><]=?\s*READ_WHOLE_MAX_BYTES/.test(guardCode)
    && guardCode.includes('超过整读上限 ${READ_WHOLE_MAX_BYTES}'));
}

/* ── 收尾 ── */
console.log(`\n═══ verify-read-guard：${passed} 通过 / ${failed} 失败 ═══`);
if (failed > 0) process.exit(1);
