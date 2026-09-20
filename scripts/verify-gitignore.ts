/**
 * verify-gitignore.ts —— `ls` / `grep` 读项目 `.gitignore`（ROADMAP 10.7.3）
 *
 * 为什么需要它：跳过表原先是硬编码 `['.git','node_modules','dist']`，而项目自己写的
 *   `build/`、`*.log`、`sessions/` 一律会钻进结果里污染上下文。本轮把 `.gitignore`
 *   编译成规则合并进去。它有四个容易悄悄失效的位置，本套逐个钉死：
 *
 *   ① **语义**（最贵的一处）。gitignore 的规矩很怪：什么时候算锚定、`**` 什么时候跨目录、
 *      尾部 `/` 只管目录、`!` 能不能救回……全是"自以为对"的重灾区。所以 ② 段的期望值
 *      **不是我推的**——它们是拿 `git check-ignore` 当标尺逐条对拍出来的实测值
 *      （WorkBuddy_Test/probe-gitignore.ts，25 条全一致）。改 semantics 若只在自己的
 *      想象里自洽，这里会红。
 *   ② **父目录被排除 = 里面全部排除**。这条同样是实测逼出来的：只判叶子时，`build/` 之下
 *      的 `build/x.txt` 我们答"不忽略"、git 答"忽略"。做法是**自己逐层上溯**，让函数对
 *      任意路径都答得对，而不是指望调用方先判过祖先。
 *   ③ **默认态零行为变化**。没有 `.gitignore`（或它读不出来、或全是注释、或超长）时必须退回
 *      "一条规则也没有"——列表与搜索结果和没接这个功能之前**逐字一致**。这是 C10 的硬要求。
 *   ④ **内置默认不能丢**。新增的是**并集**：`.git` / `node_modules` / `dist` 永远跳过，
 *      哪怕某个用户改了 `.gitignore` 把它们放回来（安全底线不交给人手填空话）。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 解析逐形状（注释 / 空行 / 取反 / 目录专属 / 锚定 / CRLF / 尾空格 / 上限）
 *   ② 匹配语义 25 条（期望值取自真 git）
 *   ③ fail-safe 与边界（认不出就丢、超大文件、全是注释）
 *   ④ 源码守护（纯模块零 import；ls 与 grep 两处都接；宽容读；内置默认仍在）
 *   ⑤ 行为证明（真临时目录 + 真工具调用）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-gitignore.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 * 退出码：failed > 0 → 1
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/builtin.js';
import {
  GITIGNORE_MAX_BYTES, isIgnoredByGitignore, parseGitignore,
} from '../src/project/gitignore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** 抹掉注释再查（本仓已多次踩"源码文本断言被自己的说明文字判红"） */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ok = (text: string): string => JSON.stringify(text.slice(0, 160));

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 解析：逐形状
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n① 解析逐形状');

check('A1 空内容 → 空表（没有规则，行为与没接此功能一致）', parseGitignore('').length === 0);
check('A2 纯空行 → 空表', parseGitignore('\n\n\n').length === 0);
check('A3 只有注释 → 空表', parseGitignore('# 构建产物\n').length === 0);
check('A4 注释行本身不成为规则', parseGitignore('# dist/\n').length === 0);
check('A5 一条普通规则 → 1 条', parseGitignore('node_modules/\n').length === 1);
check('A6 CRLF 也能解析（Windows 写的文件）', parseGitignore('a.log\r\nb.log\r\n').length === 2);
check('A7 无末尾换行也能解析', parseGitignore('a.log').length === 1);
check('A8 前后空白被吃掉', parseGitignore('  a.log  \n').length === 1);

const rA9 = parseGitignore('build/\n')[0];
check('A9 尾部 / → dirOnly=true', rA9.dirOnly === true, JSON.stringify(rA9.source));
const rA10 = parseGitignore('build\n')[0];
check('A10 没有尾部 / → dirOnly=false（能命中同名文件）', rA10.dirOnly === false);
const rA11 = parseGitignore('!keep.log\n')[0];
check('A11 首部 ! → negated=true', rA11.negated === true);
check('A12 超过行数上限后停止收集（病态文件不该拖慢 ls/grep）',
  parseGitignore(Array.from({ length: 400 }, (_, i) => `pat-${i}\n`).join('')).length <= 300);
check('A13 单行长度超限 → 该行丢弃', parseGitignore(`${'x'.repeat(600)}\n`).length === 0);
check('A14 光一个 / → 无意义，丢弃', parseGitignore('/\n').length === 0);
check('A15 只有 ! 没有名字 → 丢弃', parseGitignore('!\n').length === 0);
check('A16 source 保留原始行（回执与排查用）',
  parseGitignore('#x\n  keep  \n')[0]?.source === '  keep',
  ok(JSON.stringify(parseGitignore('#x\n  keep  \n')[0]?.source)));

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 匹配语义 —— 期望值取自真 git（`git check-ignore` 逐条对拍，25 条全一致）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n② 匹配语义（期望值取自真 git 的对拍，不是推的）');

// 规则集与探针 WorkBuddy_Test/probe-gitignore.ts 完全一致
const GI = [
  '# 注释行（下面那条才生效）',
  '*.log',
  '/root.txt',
  'build/',
  'onlydir/',
  'temp',
  '*.tmp',
  '!important.tmp',
  'sub/*.tmp',
  '!sub/keep.tmp',
  'deep/**/x',
  'x/**/y',
  'a[0-9].txt',
  'we?rd.txt',
  '\\#literal.txt',
  'trailspace.txt   ',
].join('\n') + '\n';
const rules = parseGitignore(GI);

/** [相对路径, 是不是目录, git 的答案] —— 第三列是 `git check-ignore` 的实测输出 */
const ORACLE: Array<[string, boolean, boolean]> = [
  ['app.log', false, true],
  ['sub/app.log', false, true],
  ['root.txt', false, true],
  ['sub/root.txt', false, false],
  ['build', true, true],
  ['src/build', true, true],
  ['build/x.txt', false, true],
  ['onlydir', false, false],
  ['temp', true, true],
  ['tempfile', false, false],
  ['junk.tmp', false, true],
  ['important.tmp', false, false],
  ['sub/junk.tmp', false, true],
  ['sub/keep.tmp', false, false],
  ['deep/a/b/x', false, true],
  ['x/y', false, true],
  ['x/m/y', false, true],
  ['x/m/n/y', false, true],
  ['a1.txt', false, true],
  ['ab.txt', false, false],
  ['weird.txt', false, true],
  ['wrd.txt', false, false],
  ['#literal.txt', false, true],
  ['trailspace.txt', false, true],
  ['notes.txt', false, false],
  // 下面三条专门钉「**中间含 / 即锚定**」这条分支 —— 它们是 M1 变异揭出来的：
  // 去掉那条分支后，锚定模式会退化成"任意深度命中"，而这三条真 git 并不这么判
  ['sub/sub/junk.tmp', false, true],       // 命中的是任意深度的 `*.tmp`，不是锚定的 `sub/*.tmp`
  ['sub/deep/a/b/x', false, false],        // `deep/**/x` 锚定在根，深层不生效
  ['sub/x/y', false, false],               // 同上
];
for (const [rel, isDir, expect] of ORACLE) {
  check(`· ${rel}${isDir ? '/（目录）' : ''} → ${expect ? '忽略' : '不忽略'}`,
    isIgnoredByGitignore(rel, isDir, rules) === expect,
    `我们答 ${isIgnoredByGitignore(rel, isDir, rules)}`);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ fail-safe 与边界
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n③ fail-safe 与边界（认不出就丢，绝不猜）');

check('C1 空规则表 → 一律不忽略（默认态零行为变化）',
  isIgnoredByGitignore('a/b/c', false, []) === false);
check('C2 单个 [ 当字面左方括号处理（git 同样如此），规则仍然成立而不是整条被扔掉',
  isIgnoredByGitignore('a[bc.txt', false, parseGitignore('a[bc.txt\n')) === true);
check('C3 同一个模式不会误伤普通名字 abc.txt（没落成语焉不详的字符集去瞎匹配）',
  isIgnoredByGitignore('abc.txt', false, parseGitignore('a[bc.txt\n')) === false);
check('C4 Windows 风格的反斜杠路径也判得对（防御）',
  isIgnoredByGitignore('build\\x.txt', false, rules) === true);
check('C5 两端多余斜杠被夹掉',
  isIgnoredByGitignore('/build/', true, rules) === true);
check('C6 空路径不参与判定，直接返回 false 而不是炸',
  isIgnoredByGitignore('', false, rules) === false);
check('C7 没 [] 也能用：* 不跨 /（这是最容易做错的一条）',
  isIgnoredByGitignore('a/b.log', false, parseGitignore('a*.log\n')) === false);
check('C8 同层先后冲突时末次胜出',
  isIgnoredByGitignore('x', false, parseGitignore('*\n!x\n')) === false
  && isIgnoredByGitignore('x', false, parseGitignore('!x\n*\n')) === true);

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 源码守护
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n④ 源码守护（手段要钉死：换成任何等价实现都应报错）');

const modSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/project/gitignore.ts'), 'utf-8'));
const builtinRaw = fs.readFileSync(path.join(ROOT, 'src/tools/builtin.ts'), 'utf-8');
const builtinSrc = stripComments(builtinRaw);
// 2026-09-20（ROADMAP 10.7.1）：`grep` 的遍历搬进 `src/search/walk.ts`（与 `symbols` 共用），
// 于是 D 段钉的那两件事**换了落点**：跳过表只有一份（在 walk.ts），`rel` 的拼法也只有一份。
// 判据因此从"builtin 里有几处"改成"**这两个文件各有一处、总数不许多**"——换落点不等于放宽。
const walkSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/search/walk.ts'), 'utf-8'));

check('D1 gitignore.ts 零 import（纯函数，可脱离终端验）',
  !/^import\s/m.test(modSrc) && !/require\(/.test(modSrc));
check('D2 ls 与 grep 与 symbols 与 refs **四个**工具都接了 loadIgnoreRules（少一个就有一半路径没过滤）',
  (builtinSrc.match(/loadIgnoreRules\(/g) ?? []).length === 5,   // 定义 1 + 调用 4（ls / grep / symbols / refs）
  String((builtinSrc.match(/loadIgnoreRules\(/g) ?? []).length));
check('D3 两处落点都在按 .gitignore 过滤：ls 自己调一次，grep 与 symbols 经 search/walk.ts 的同一处',
  (builtinSrc.match(/isIgnoredByGitignore\(/g) ?? []).length === 1
  && (walkSrc.match(/isIgnoredByGitignore\(/g) ?? []).length === 1,
  `${(builtinSrc.match(/isIgnoredByGitignore\(/g) ?? []).length} / ${(walkSrc.match(/isIgnoredByGitignore\(/g) ?? []).length}`);
check('D4 loadIgnoreRules 宽容：任何异常都退回空表（读不出来 = 没有规则，而不是让工具失败）',
  /catch \{\s*return \[\];\s*\}/.test(builtinSrc));
check('D5 内置默认仍在 —— `.git` / `node_modules` / `dist` 是底线，不交给人手填空话（全仓只有一份定义，在 search/walk.ts）',
  /const SKIP_DIRS: ReadonlySet<string> = new Set\(\['\.git', 'node_modules', 'dist'\]\);/.test(walkSrc)
  && !/new Set\(\['\.git'/.test(builtinSrc));
check('D6 四个工具的 description 都告诉了模型"会按 .gitignore 过滤"（否则它会以为文件不存在）',
  builtinRaw.includes('项目 .gitignore 里列出的路径')
  && (builtinRaw.match(/项目 \.gitignore 里列出的路径/g) ?? []).length === 4);
check('D7 文件名走常量，不在工具层写字面量', builtinSrc.includes('GITIGNORE_FILE'));
check('D8 匹配时传的是**相对搜索根**的路径（rel 逐层拼出来）：ls 一处 + search/walk.ts 一处，各只有一份',
  /childRel = rel \? `\$\{rel\}\/\$\{item\.name\}` : item\.name;/.test(builtinSrc)
  && (builtinSrc.match(/childRel = rel \?/g) ?? []).length === 1
  && /childRel = rel \? `\$\{rel\}\/\$\{item\.name\}` : item\.name;/.test(walkSrc)
  && (walkSrc.match(/childRel = rel \?/g) ?? []).length === 1);

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 行为证明 —— 真临时目录 + 真工具调用
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ 行为证明（真建目录、真调 ls / grep）');

/** 造一个项目：每个文件的内容都带 NEEDLE <名字>，便于断言"到底扫没扫" */
function buildProject(files: Record<string, string>, gitignore?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ign-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  if (gitignore !== undefined) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore, 'utf-8');
  return dir;
}

const FILES: Record<string, string> = {
  'a.txt': 'NEEDLE a\n',
  'notes.txt': 'NEEDLE notes\n',
  'app.log': 'NEEDLE app\n',
  'keep.log': 'NEEDLE keep\n',
  'logs': 'NEEDLE logs（这是个**文件**，用来试 dirOnly 规则会不会误伤同名文件）\n',
  'build/built.txt': 'NEEDLE build\n',
  'sessions/s.txt': 'NEEDLE sessions\n',
  'sub/app.log': 'NEEDLE subapp\n',
};
const GI_TEXT = [
  '# 注释',
  'build/',
  'logs/',
  'sessions/',
  '*.log',
  '!keep.log',
].join('\n') + '\n';

const registry = new ToolRegistry();
registerBuiltinTools(registry);

const tmp = buildProject(FILES, GI_TEXT);
const tmpNoGi = buildProject(FILES);
const tmpCommentOnly = buildProject(FILES, '# 只有注释\n');
const tmpHuge = buildProject(FILES, `# 超长\n${'x'.repeat(GITIGNORE_MAX_BYTES + 10)}\n`);

try {
  const ls = await registry.execute('ls', { path: tmp });

  check('E1 ls 不再列出被忽略的目录（build / sessions）',
    ls.status === 'ok' && !ls.content.includes('build/') && !ls.content.includes('sessions/'),
    ok(ls.content));
  check('E2 ls 不再列被忽略的文件（app.log）', !ls.content.includes('app.log'), ok(ls.content));
  check('E3 取反生效：keep.log 仍在列表里', ls.content.includes('keep.log'), ok(ls.content));
  check('E4 目录专属规则不误伤同名**文件**：logs 仍在列表里',
    ls.content.includes('logs'), ok(ls.content));
  check('E5 没被忽略的照旧显示（a.txt / notes.txt / sub）',
    ls.content.includes('a.txt') && ls.content.includes('notes.txt') && ls.content.includes('sub/'),
    ok(ls.content));
  check('E6 .gitignore 自己不进列表（dotfile 规则依旧，与本次改动无关）',
    !ls.content.includes('.gitignore'));

  const deep = await registry.execute('ls', { path: tmp, depth: 3 });
  check('E7 递归时忽略规则照样生效（sub/app.log 不在深层列表里）',
    !deep.content.includes('app.log'), ok(deep.content));

  const grep = await registry.execute('grep', { pattern: 'NEEDLE', path: tmp });
  check('E8 grep 不再扫被忽略目录里的文件（build / sessions 的命中不出现）',
    !grep.content.includes('NEEDLE build') && !grep.content.includes('NEEDLE sessions'),
    ok(grep.content));
  check('E9 grep 不再扫被忽略的文件（app.log 与 sub/app.log 的命中不出现）',
    !grep.content.includes('NEEDLE app') && !grep.content.includes('NEEDLE subapp'),
    ok(grep.content));
  check('E10 grep 仍能看到该看的（a.txt / keep.log / logs）',
    grep.content.includes('NEEDLE a') && grep.content.includes('NEEDLE keep')
    && grep.content.includes('NEEDLE logs'), ok(grep.content));
  check('E11 统计里的扫描数不含被忽略项（4 个：a.txt / keep.log / logs / notes.txt）',
    /已扫 4 个文件/.test(grep.content), ok(grep.content));

  const explicitFile = await registry.execute('grep', { pattern: 'NEEDLE', path: path.join(tmp, 'build/built.txt') });
  check('E12 **显式点名的文件**照旧搜得到（用户把路径说出来了，别替他藏）',
    explicitFile.content.includes('NEEDLE build'), ok(explicitFile.content));
  const explicitDir = await registry.execute('ls', { path: path.join(tmp, 'build') });
  check('E13 **显式点名的目录**照旧列得出（同上）',
    explicitDir.status === 'ok' && explicitDir.content.includes('built.txt'), ok(explicitDir.content));

  const lsNoGi = await registry.execute('ls', { path: tmpNoGi });
  check('E14 **没有 .gitignore 时**与改前逐字一致：build / sessions / app.log 全都回来',
    lsNoGi.content.includes('build/') && lsNoGi.content.includes('sessions/')
    && lsNoGi.content.includes('app.log'), ok(lsNoGi.content));
  const grepNoGi = await registry.execute('grep', { pattern: 'NEEDLE', path: tmpNoGi });
  check('E15 没有 .gitignore 时 grep 扫全部 8 个文件', /已扫 8 个文件/.test(grepNoGi.content),
    ok(grepNoGi.content));

  const lsComment = await registry.execute('ls', { path: tmpCommentOnly });
  check('E16 .gitignore 只有注释 → 等价于没有规则（回退到默认态）',
    lsComment.content.includes('build/') && lsComment.content.includes('app.log'),
    ok(lsComment.content));

  const lsHuge = await registry.execute('ls', { path: tmpHuge });
  check('E17 超长 .gitignore → 不读、不报错，回退到默认态（不是报错失败）',
    lsHuge.status === 'ok' && lsHuge.content.includes('build/'), ok(lsHuge.content));

  const missing = await registry.execute('ls', { path: path.join(tmp, 'no-such-dir') });
  check('E18 目录不存在时行为不变（NOT_FOUND，不是变成 [ERROR]）',
    missing.status === 'negative', `${missing.status} ${ok(missing.content)}`);
} finally {
  for (const d of [tmp, tmpNoGi, tmpCommentOnly, tmpHuge]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

check('Z1 临时目录已清理（不留垃圾在系统 tmp 里）',
  !fs.existsSync(tmp) && !fs.existsSync(tmpNoGi) && !fs.existsSync(tmpCommentOnly)
  && !fs.existsSync(tmpHuge));

/* ═══════════════════════════════════════════════════════════════════════════════ */

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
