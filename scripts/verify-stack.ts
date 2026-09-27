/**
 * verify-stack.ts —— 技术栈自动探测（ROADMAP 10.1.1）
 *
 * 为什么需要它：这条功能的产物是**注入进上下文的一段话**，而它有一个特殊之处 ——
 * 它不只是给人看的画像，**命令表的 `run` 串前缀由它派生**（`npm run test` 还是 `pnpm run test`）。
 * 于是判错的后果分两级：轻的是画像说错话（模型多读一个文件就能纠正），
 * 重的是**命令表指向一个项目里根本不存在的包管理器**（拼出来的命令行跑不起来，
 * 而退出码非 0 看着像"项目不通过"——正是 10.6.1 要消灭的那类误判）。
 *
 * 还有一条**承重**的事只能在这里钉：**没有 `package.json` 的项目绝不能被说成"用 npm"**。
 * 一个纯 Rust 项目配着 `npm run` 前缀，比不说更糟。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 判据（纯函数，逐分支穷举）—— 三选一优先级（声明 > 证据 > 默认）；锁文件逐个；
 *      非 Node 生态；多生态固定顺序；**与输入文件顺序无关**；认不出即丢弃
 *   ② 渲染 —— 空画像缺席 / 标题 / 依据 / "判不出来"要有原因 / 脏输入
 *   ③ 注册表 —— 初值 / set / 脏值 / clear
 *   ④ 与命令表的接头（10.1.1 ⇄ 10.6.1）—— 包管理器进 `run` 串；缺省仍是 npm；
 *      **脏值退回默认**（它要拼进一句要被执行的命令里）
 *   ⑤ 源码守护 —— 判据不碰 fs / 不起进程；原料清单**接 detect.ts 那份、不另开**；
 *      方向单向；探针是唯一做 IO 的地方；播种处重探；两半同刻播种
 *   ⑥ 行为证明 —— 真目录真探针；真播种（含**切到空目录必须清掉旧画像**）；
 *      真 SystemPromptServiceImpl 的四半合成与整层缺席；端到端"探测 → 命令表"
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-stack.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 * 退出码：failed > 0 → 1
 *
 * 环境依赖：⑥ 会真的 chdir 到临时目录，并把通讯录用 `FLINT_PROJECTS_FILE` 重定向到临时文件
 *   （**绝不碰用户真实的 ~/.flint/projects.jsonl**，理由见 registry.ts 的 projectsFilePath）；
 *   结束时还原 cwd 并删临时目录。
 *
 * 已知留白（不装糊涂）：非 Node 生态**没有命令派生的用例** —— 因为那条功能**刻意没做**
 *   （本机装不了 cargo / go / poetry，按"没实测到的那一半不许用推理补"的纪律留白）。
 *   所以 ① 里那几个生态只钉到"语言与包管理器名对不对"为止。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemPromptServiceImpl } from '../src/context/system-prompt.js';
import { seedProjectContext } from '../src/harness/project-context.js';
import {
  DEFAULT_MANAGER, commandRegistry, parsePackageScripts, renderCommandsSection,
} from '../src/project/commands.js';
import { MANIFEST_FILES } from '../src/project/detect.js';
import { probeStack } from '../src/project/probe.js';
import {
  EMPTY_STACK, STACK_CANDIDATES, detectStack, parsePackageManagerField,
  renderStackSection, stackRegistry, type ProjectStack, type StackProbes,
} from '../src/project/stack.js';

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
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const ok = (s: unknown): string => String(s);

/** 造一份探针结果（判据是纯函数，所以每条分支都能这样打靶，不必先造真目录） */
const sp = (files: string[], packageJson: string | null = null): StackProbes => ({ files, packageJson });
/** 造一份 package.json 文本（只有 packageManager 字段时用） */
const pkgField = (value: unknown): string => JSON.stringify({ packageManager: value });
/** 取第 i 个生态（越界给一个空壳，避免用例抛异常把整段打断） */
const item = (s: ProjectStack, i = 0) =>
  s.items[i] ?? { language: '(缺)', manager: null, via: '', markers: [] };

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 判据：纯函数，逐分支穷举
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n① 判据（存在性探测 → 语言 / 包管理器）');

const empty = detectStack(sp([]));
check('A1 一个标记都没有 → 空画像、nodeManager 为 null（不无中生有）',
  empty.items.length === 0 && empty.nodeManager === null);

const bare = detectStack(sp(['package.json']));
check('A2 package.json 无锁文件无字段 → JavaScript + 默认 npm（= 本条之前的硬编码值）',
  item(bare).language === 'JavaScript' && item(bare).manager === 'npm'
  && bare.nodeManager === 'npm', ok(item(bare).manager));
check('A3 默认那条的 via 说的是实话（"既无锁文件，也无字段"），不是含糊其辞',
  item(bare).via.includes('默认') && item(bare).via.includes('packageManager'));

const ts = detectStack(sp(['package.json', 'tsconfig.json']));
check('A4 有 tsconfig.json → TypeScript（比翻 devDependencies 稳，且不用解析内容）',
  item(ts).language === 'TypeScript');

// 锁文件逐个：四个形状都要有正例（漏一个就是"这个包管理器永不生效"）
const locks: ReadonlyArray<readonly [string, string]> = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];
check('A5 五个锁文件各自都能认出包管理器（含 bun 的两种后缀）',
  locks.every(([f, m]) => detectStack(sp(['package.json', f])).nodeManager === m),
  ok(locks.map(([f]) => `${f}=${detectStack(sp(['package.json', f])).nodeManager}`).join(' ')));
check('A6 锁文件那条的 via 点名是哪个文件给的（依据要可追）',
  item(detectStack(sp(['package.json', 'pnpm-lock.yaml']))).via.includes('pnpm-lock.yaml'));

// **顺序链**：一次把四个锁文件都摆上，再逐个撤掉 —— 只测"两个同时存在"是可被绕过的
// （变异实测：把 yarn 与 pnpm 在表里对调，只测 pnpm+package-lock 的用例照样全绿）
check('A7 四个锁文件同时存在 → 取 pnpm（声明优先级链的第一环）',
  detectStack(sp(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']))
    .nodeManager === 'pnpm');
check('A8 优先级链逐环撤掉：去 pnpm → yarn；去 yarn → bun；去 bun → npm（**顺序**被完整钉住）',
  detectStack(sp(['package.json', 'package-lock.json', 'yarn.lock', 'bun.lockb'])).nodeManager === 'yarn'
  && detectStack(sp(['package.json', 'package-lock.json', 'bun.lockb'])).nodeManager === 'bun'
  && detectStack(sp(['package.json', 'package-lock.json'])).nodeManager === 'npm',
  ok([
    detectStack(sp(['package.json', 'package-lock.json', 'yarn.lock', 'bun.lockb'])).nodeManager,
    detectStack(sp(['package.json', 'package-lock.json', 'bun.lockb'])).nodeManager,
  ].join(',')));
check('A9 顺序与"探针返回的文件顺序"无关（不是碰巧取到了第一个）',
  detectStack(sp(['package.json', 'pnpm-lock.yaml', 'package-lock.json'])).nodeManager === 'pnpm'
  && detectStack(sp(['package-lock.json', 'pnpm-lock.yaml', 'package.json'])).nodeManager === 'pnpm');

check('A10 `packageManager` 字段优先于锁文件（声明 > 实物证据）',
  detectStack(sp(['package.json', 'package-lock.json'], pkgField('pnpm@9.1.0'))).nodeManager === 'pnpm');
check('A11 字段那条的 via 点明是字段（而不是谎报成锁文件）',
  item(detectStack(sp(['package.json'], pkgField('yarn@4.0.0+sha256.abc')))).via.includes('packageManager'));
check('A12 字段带版本号 / 大写 / 前后空格都能取到名字',
  detectStack(sp(['package.json'], pkgField('PNPM@9.1.0'))).nodeManager === 'pnpm'
  && detectStack(sp(['package.json'], pkgField('  yarn@4 '))).nodeManager === 'yarn');

// 认不出即丢弃（往下滚到锁文件，而不是把陌生字符串当命令前缀）
check('A13 字段认不出（make@1）→ 丢弃，滚回锁文件（绝不把陌生名字塞进 run 串）',
  detectStack(sp(['package.json', 'yarn.lock'], pkgField('make@1'))).nodeManager === 'yarn'
  && parsePackageManagerField(pkgField('make@1')) === null);
check('A14 字段是脏值（非字符串 / 空 / 缺字段 / 文本不是 JSON）→ 一律 null',
  parsePackageManagerField(pkgField(42)) === null
  && parsePackageManagerField(pkgField('')) === null
  && parsePackageManagerField('{"name":"demo"}') === null
  && parsePackageManagerField('{oops') === null
  && parsePackageManagerField(undefined) === null
  && parsePackageManagerField('[]') === null);

/** **承重**：没有 package.json 就不许认 npm —— 一个纯 Rust 项目不该被说成"用 npm" */
check('A15 只有 tsconfig.json、没有 package.json → 语言仍是 TypeScript，但**包管理器判不出来**',
  item(detectStack(sp(['tsconfig.json']))).language === 'TypeScript'
  && item(detectStack(sp(['tsconfig.json']))).manager === null
  && detectStack(sp(['tsconfig.json'])).nodeManager === null);
check('A16 判不出来时 via 必须给**原因**（编一个默认比留白危险：留白会去查，编错不会）',
  item(detectStack(sp(['tsconfig.json']))).via.includes('package.json')
  && item(detectStack(sp(['tsconfig.json']))).via.includes('说明用哪个工具')
  // 且原因里**不许**再带"判不出来"这几个字：那三个字由渲染器加且只加一次，
  // 两处都带会印成"判不出来 —— 判不出来"（拼接放大型缺陷，回归守卫在 B7）
  && !item(detectStack(sp(['tsconfig.json']))).via.includes('判不出来'));

// ── 非 Node 生态：只报语言与包管理器名，**不派生命令**（边界见文件头）──
check('A17 pyproject.toml → Python，包管理器**判不出来**（只声明依赖，不说明用哪个工具）',
  item(detectStack(sp(['pyproject.toml']))).language === 'Python'
  && item(detectStack(sp(['pyproject.toml']))).manager === null
  && item(detectStack(sp(['pyproject.toml']))).via.includes('不说明'));
check('A18 Python 的工具文件能定出包管理器（poetry / uv / pipenv）',
  item(detectStack(sp(['pyproject.toml', 'poetry.lock']))).manager === 'poetry'
  && item(detectStack(sp(['pyproject.toml', 'uv.lock']))).manager === 'uv'
  && item(detectStack(sp(['Pipfile']))).manager === 'pipenv');
check('A19 只有 requirements.txt → pip（它是清单，也是"用 pip 装"的证据）',
  item(detectStack(sp(['requirements.txt']))).manager === 'pip');
check('A20 go.mod → Go / go；Cargo.toml → Rust / cargo',
  item(detectStack(sp(['go.mod']))).language === 'Go'
  && item(detectStack(sp(['go.mod']))).manager === 'go'
  && item(detectStack(sp(['Cargo.toml']))).language === 'Rust'
  && item(detectStack(sp(['Cargo.toml']))).manager === 'cargo');
check('A21 Java：pom.xml → mvn；build.gradle / build.gradle.kts → gradle',
  item(detectStack(sp(['pom.xml']))).manager === 'mvn'
  && item(detectStack(sp(['build.gradle']))).manager === 'gradle'
  && item(detectStack(sp(['build.gradle.kts']))).manager === 'gradle');
check('A22 非 Node 生态**不会**顺手给出 npm（否则命令表会拿它去拼 run 串）',
  [detectStack(sp(['go.mod'])), detectStack(sp(['Cargo.toml'])), detectStack(sp(['pom.xml'])),
    detectStack(sp(['pyproject.toml']))].every((s) => s.nodeManager === null));

// ── 多生态 / 顺序 / 无关变量 ──
const poly = detectStack(sp(['pyproject.toml', 'package.json', 'Cargo.toml', 'go.mod']));
check('A23 多生态都报出来，且顺序**固定**（Node → Python → Go → Rust）',
  poly.items.map((i) => i.language).join(',') === 'JavaScript,Python,Go,Rust',
  ok(poly.items.map((i) => i.language).join(',')));
check('A24 顺序与"探针返回的文件顺序"无关（不靠输入顺序碰巧对）',
  detectStack(sp(['go.mod', 'Cargo.toml', 'pyproject.toml', 'package.json'])).items.map((i) => i.language).join(',')
  === 'JavaScript,Python,Go,Rust');
check('A25 每个生态都带上是哪些文件把它认出来的（markers 可追）',
  item(detectStack(sp(['package.json', 'tsconfig.json', 'pnpm-lock.yaml']))).markers.join(',')
  === 'package.json,tsconfig.json,pnpm-lock.yaml'
  && item(detectStack(sp(['requirements.txt']))).markers.join(',') === 'requirements.txt');
check('A26 认不出的标记（Makefile / Dockerfile 之类）不产生任何生态 —— 不给假信号',
  detectStack(sp(['Makefile', 'Dockerfile', 'README.md'])).items.length === 0);
check('A27 脏输入（files 不是数组 / probes 为空）不抛、按空画像处理',
  detectStack({ files: null as never, packageJson: null }).items.length === 0
  && detectStack({} as never).items.length === 0);
check('A28 package.json 文本坏了但文件在 → 仍是 Node 生态，只是包管理器滚回默认 npm',
  detectStack(sp(['package.json'], '{oops')).nodeManager === 'npm');

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 渲染
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n② 渲染（注入段）');

check('B1 空画像 → **空串**（整段缺席，不拿空壳占上下文）',
  renderStackSection(EMPTY_STACK) === '' && renderStackSection(detectStack(sp([]))) === '');
const rendered = renderStackSection(detectStack(sp(['package.json', 'tsconfig.json', 'pnpm-lock.yaml'])));
check('B2 标题点明"包管理器由这里派生"（否则模型会把画像与命令表当成两件事）',
  rendered.startsWith('## 项目技术栈') && rendered.includes('命令表'));
check('B3 一行一个生态：语言 + 包管理器 + 依据 + 标记',
  rendered.split('\n').length === 2
  && rendered.includes('TypeScript') && rendered.includes('`pnpm`') && rendered.includes('pnpm-lock.yaml'),
  ok(rendered.split('\n')[1] ?? ''));
check('B4 判不出来时渲染成"判不出来 —— 原因"（不留空白让人猜）',
  renderStackSection(detectStack(sp(['pyproject.toml']))).includes('包管理器判不出来 —— `pyproject.toml` 只声明依赖'));
check('B5 多生态渲染成多行（行数 = 生态数 + 1 行标题）',
  renderStackSection(detectStack(sp(['package.json', 'Cargo.toml']))).split('\n').length === 3);
check('B6 脏输入（items 不是数组）→ 空串（宽容，不抛）',
  renderStackSection({ items: null as never, nodeManager: null }) === '');
// 拼接放大（本仓记过的缺陷类型）：数据里与渲染器里各带一次"判不出来"，拼出来就是
// "包管理器判不出来 —— 判不出来（…）"。单看任一侧都正确，**一拼接才现形** —— 演示脚本
// 第一次跑就把它照出来了，故补这条回归守卫。
check('B7 "判不出来"在一行里**只出现一次**（数据给纯原因、前缀由渲染器加）',
  !renderStackSection(detectStack(sp(['pyproject.toml']))).includes('判不出来 —— 判不出来')
  && !renderStackSection(detectStack(sp(['tsconfig.json']))).includes('判不出来 —— 判不出来')
  && (renderStackSection(detectStack(sp(['pyproject.toml']))).match(/判不出来/g) ?? []).length === 1,
  ok(renderStackSection(detectStack(sp(['pyproject.toml']))).split('\n')[1] ?? ''));

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 注册表（内存单例）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n③ 注册表');

stackRegistry.clear();
check('C1 复位后是空画像（模块级单例会跨套件 / 跨项目残留，初值必须是空）',
  stackRegistry.get().items.length === 0 && stackRegistry.get().nodeManager === null);
const sample = detectStack(sp(['package.json', 'pnpm-lock.yaml']));
stackRegistry.set(sample);
check('C2 set → get 拿到同一份（含 nodeManager）',
  stackRegistry.get().nodeManager === 'pnpm' && stackRegistry.get().items.length === 1);
stackRegistry.set(null as never);
check('C3 set 脏值（null / items 不是数组）→ 落回空画像，不留半截状态',
  stackRegistry.get().items.length === 0 && stackRegistry.get().nodeManager === null);
stackRegistry.set(sample);
stackRegistry.clear();
check('C4 clear → 立刻空（切换项目要靠它，不能等下一次 set）',
  stackRegistry.get().nodeManager === null);

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 与命令表的接头（10.1.1 ⇄ 10.6.1 的唯一接线处）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n④ 与命令表的接头（run 串前缀）');

const pkgText = JSON.stringify({ scripts: { test: 'tsc --noEmit' } });
check('D1 包管理器进 `run` 串：传入 pnpm → `pnpm run test`（这就是 10.6.1 注释里留的那半句）',
  parsePackageScripts(pkgText, 'pnpm')[0]?.run === 'pnpm run test',
  ok(parsePackageScripts(pkgText, 'pnpm')[0]?.run));
check('D2 **缺省仍是 npm** —— 探测不到东西的项目，命令表行为逐字不回退',
  parsePackageScripts(pkgText)[0]?.run === 'npm run test'
  && DEFAULT_MANAGER === 'npm'
  && parsePackageScripts(pkgText, undefined)[0]?.run === 'npm run test');
check('D3 脏包管理器（空串 / 带空格 / 带命令分隔符 / 非字符串）→ 一律退回默认',
  parsePackageScripts(pkgText, '')[0]?.run === 'npm run test'
  && parsePackageScripts(pkgText, 'a b')[0]?.run === 'npm run test'
  && parsePackageScripts(pkgText, 'npm; rm -rf /')[0]?.run === 'npm run test'
  && parsePackageScripts(pkgText, 42 as never)[0]?.run === 'npm run test');
check('D4 挡脏值这条不是装饰：它拼出的是一句**要被执行**的命令串',
  !parsePackageScripts(pkgText, 'npm && echo pwned')[0]?.run.includes('echo'));
check('D5 换包管理器不影响参数解析的其余部分（name / script / kind 三件套不变）',
  JSON.stringify(parsePackageScripts(pkgText, 'yarn')[0]?.name) === '"test"'
  && parsePackageScripts(pkgText, 'yarn')[0]?.script === 'tsc --noEmit');

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 源码守护
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ 源码守护');

const stackSrc = read('src/project/stack.ts');
const detectSrc = read('src/project/detect.ts');
const probeSrc = read('src/project/probe.ts');
const seedSrc = read('src/harness/project-context.ts');
const mainSrc = read('src/harness/main.ts');
const runtimeSrc = read('src/runtime/runtime.ts');
const spSrc = read('src/context/system-prompt.ts');
const coreSpSrc = read('src/core/system-prompt.ts');
const stackBody = stripComments(stackSrc);

check('E1 判据不碰 fs、不起进程（不出现 node:fs / node:child_process / existsSync / readFileSync）',
  !/node:fs|node:child_process|existsSync|readFileSync|execFileSync/.test(stackBody));
check('E2 原料清单**接 detect.ts 那一份**，不另开（那边注释里点名要接的）',
  stackBody.includes("from './detect.js'") && stackBody.includes('...MANIFEST_FILES,'));
check('E3 承接是**全包含**的：detect 的每个清单文件都在探测候选里',
  MANIFEST_FILES.every((f) => STACK_CANDIDATES.includes(f))
  && STACK_CANDIDATES.length > MANIFEST_FILES.length,
  ok(MANIFEST_FILES.filter((f) => !STACK_CANDIDATES.includes(f)).join(',')));
check('E4 方向单向：detect.ts **不**反向 import stack.ts（不然两个用途互相绑架）',
  !/from '\.\/stack\.js'/.test(detectSrc));
check('E5 探针是唯一做 IO 的地方（probeStack 在 probe.ts，读文件不由判据代劳）',
  probeSrc.includes('export function probeStack') && probeSrc.includes('STACK_CANDIDATES'));
check('E6 播种处**重探**（不是只 set 一次就完 —— 切项目必须换画像）',
  stripComments(seedSrc).includes('stackRegistry.set(detectStack(probeStack(process.cwd())))'));
check('E7 两半在**同一时刻**播种：画像先于命令表（main.ts 那句在 seedProjectContext 之后）',
  mainSrc.indexOf('seedProjectContext()') < mainSrc.indexOf('stackRegistry.get().nodeManager'));
check('E8 main.ts 用画像的 nodeManager 喂 parsePackageScripts，判不出来时退回 DEFAULT_MANAGER',
  mainSrc.includes('stackRegistry.get().nodeManager ?? DEFAULT_MANAGER')
  && mainSrc.includes('parsePackageScripts(readFileSync(PACKAGE_JSON_FILE, \'utf-8\'), manager)'));
check('E9 runtime 每轮渲染并注入画像段；空段传 undefined（半段缺席）',
  runtimeSrc.includes('renderStackSection(stackRegistry.get())')
  && runtimeSrc.includes("stackSection === '' ? undefined : stackSection")
  && runtimeSrc.includes('stack: stackSection'));
check('E10 project 层从三半扩成**四半**（现状 → 画像 → 命令表 → 仓库状态），条件含 ctx.repo',
  /if \(ctx\.project \|\| ctx\.stack \|\| ctx\.commands \|\| ctx\.repo\)/.test(spSrc)
  && spSrc.indexOf('parts.push(`[项目现状]') < spSrc.indexOf('parts.push(ctx.stack)')
  && spSrc.indexOf('parts.push(ctx.stack)') < spSrc.indexOf('parts.push(ctx.commands)')
  && spSrc.indexOf('parts.push(ctx.commands)') < spSrc.indexOf('parts.push(ctx.repo)'));
check('E11 SystemPromptContext 里有 stack 位（类型层没漏；分层序 union 未动，由 verify-commands 钉）',
  /stack\?: string \| undefined;/.test(coreSpSrc));

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑥ 行为证明：真目录 + 真播种 + 真注入
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 行为证明（真目录 + 真 SystemPromptServiceImpl）');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-stack-'));
const dirA = path.join(tmpRoot, 'a-pnpm');
const dirB = path.join(tmpRoot, 'b-rust');
const dirC = path.join(tmpRoot, 'c-empty');
const cwd0 = process.cwd();
process.env.FLINT_PROJECTS_FILE = path.join(tmpRoot, 'projects.jsonl');
try {
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  fs.mkdirSync(dirC);
  fs.writeFileSync(path.join(dirA, 'package.json'), JSON.stringify({ scripts: { test: 'tsc --noEmit' } }));
  fs.writeFileSync(path.join(dirA, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(dirA, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  fs.writeFileSync(path.join(dirB, 'Cargo.toml'), '[package]\nname = "x"\n');

  // ── G：真探针 ──
  const pa = probeStack(dirA);
  check('G1 真目录探到三个标记文件（存在性检查真的读到了磁盘）',
    pa.files.sort().join(',') === 'package.json,pnpm-lock.yaml,tsconfig.json', ok(pa.files.join(',')));
  check('G2 package.json 的**文本**被取了回来（字段判定不靠猜）',
    typeof pa.packageJson === 'string' && pa.packageJson.includes('scripts'));
  check('G3 空目录 → 没有任何标记、也没有 package.json 文本',
    probeStack(dirC).files.length === 0 && probeStack(dirC).packageJson === null);
  check('G4 真探针的产物喂给判据 → pnpm / TypeScript',
    detectStack(pa).nodeManager === 'pnpm' && item(detectStack(pa)).language === 'TypeScript');

  // 坏 JSON 的真文件：画像不该因此崩（宽容读）
  fs.mkdirSync(path.join(tmpRoot, 'd-bad'));
  fs.writeFileSync(path.join(tmpRoot, 'd-bad', 'package.json'), '{oops');
  check('G5 package.json 是坏 JSON 的真文件 → 探针仍取到文本，判据按默认 npm 收场（不抛）',
    detectStack(probeStack(path.join(tmpRoot, 'd-bad'))).nodeManager === 'npm');

  // ── H：真播种（含"切到空目录必须清掉旧画像"）──
  process.chdir(dirA);
  seedProjectContext();
  check('H1 真播种：A 目录（pnpm）→ 注册表里就是 pnpm / TypeScript',
    stackRegistry.get().nodeManager === 'pnpm'
    && item(stackRegistry.get()).language === 'TypeScript', ok(stackRegistry.get().nodeManager));
  process.chdir(dirB);
  seedProjectContext();
  check('H2 切到 B（Rust，无 package.json）→ 画像**整体换掉**，且绝不留着 npm',
    stackRegistry.get().nodeManager === null
    && item(stackRegistry.get()).language === 'Rust', ok(stackRegistry.get().nodeManager));
  // 切到**空目录**：这一条才是"先清后栽"真正的靶子 —— A↔B 两边都有文件时，
  // "文件存在就替换"会掩盖"没有文件时没清掉"。而它必须自带前置条件：
  // 变异实测发现，若播种整段被删掉，注册表**从一开始就是空的**，这一条会**碰巧全绿**。
  const beforeEmpty = stackRegistry.get().items.length;
  process.chdir(dirC);
  seedProjectContext();
  check('H3 切到空目录 → 画像变空（**只有切到空项目才验得到**；自带上一步非空的前置）',
    beforeEmpty === 1 && stackRegistry.get().items.length === 0
    && stackRegistry.get().nodeManager === null, ok(`before=${beforeEmpty}`));
  process.chdir(dirA);
  seedProjectContext();
  check('H4 切回 A → 又是 pnpm（重探是真的，不是缓存了第一次的结论）',
    stackRegistry.get().nodeManager === 'pnpm');

  // ── I：端到端 —— 探测 → 命令表（两半的接头）──
  const discovered = parsePackageScripts(
    fs.readFileSync('package.json', 'utf-8'),
    stackRegistry.get().nodeManager ?? DEFAULT_MANAGER,
  );
  commandRegistry.set(discovered);
  check('I1 端到端：pnpm 项目里，命令表的 run 串是 `pnpm run test`（不是写死的 npm）',
    commandRegistry.get()[0]?.run === 'pnpm run test', ok(commandRegistry.get()[0]?.run));
  check('I2 端到端：注入用的命令段里也是同一句话（渲染没把它变回 npm）',
    renderCommandsSection(commandRegistry.get()).includes('`pnpm run test`'));
} finally {
  process.chdir(cwd0);
  commandRegistry.clear();
  stackRegistry.clear();
  delete process.env.FLINT_PROJECTS_FILE;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ── J：真 SystemPromptServiceImpl（三半合成 / 顺序 / 整层缺席）──
const noopBus = { emitHook: async () => undefined, on: () => () => {} } as never;
const svc = new SystemPromptServiceImpl({ core: [], tools: [], skills: [], fallback: 'fallback' }, noopBus);
const baseCtx = { tools: '', skills: [] as string[], model: 'test-model', summary: undefined, historyCount: 0 };

const three = await svc.build({
  ...baseCtx,
  project: '模块 A / 模块 B',
  stack: renderStackSection(detectStack(sp(['package.json', 'pnpm-lock.yaml']))),
  commands: renderCommandsSection(parsePackageScripts(pkgText, 'pnpm')),
});
const threeMsg = three.messages.find((m) => m.layer === 'project');
check('J1 真注入：project 层里三半都在（现状快照 / 技术栈 / 命令表）',
  threeMsg?.content.includes('[项目现状]') === true
  && threeMsg?.content.includes('## 项目技术栈') === true
  && threeMsg?.content.includes('## 项目命令') === true, ok(threeMsg?.content.slice(0, 60)));
check('J2 三半的顺序是 现状 → 画像 → 命令表（画像在前，命令表里的 pnpm 才读得通）',
  threeMsg !== undefined
  && threeMsg.content.indexOf('[项目现状]') < threeMsg.content.indexOf('## 项目技术栈')
  && threeMsg.content.indexOf('## 项目技术栈') < threeMsg.content.indexOf('## 项目命令'));
check('J3 三半仍是**同一条消息**（没有另起一层，层序未动）',
  three.messages.filter((m) => m.layer === 'project').length === 1);

const onlyStack = await svc.build({ ...baseCtx, stack: '## 项目技术栈（…）' });
check('J4 只有画像 → 层仍在（任一半就出层，三半同理）',
  onlyStack.messages.some((m) => m.layer === 'project') === true);
const noStack = await svc.build({ ...baseCtx, project: '只 有 现状' });
check('J5 画像缺席时不影响另外两半（project 层照常在）',
  noStack.messages.some((m) => m.layer === 'project') === true
  && noStack.messages.find((m) => m.layer === 'project')?.content.includes('技术栈') === false);
const neither = await svc.build({ ...baseCtx });
check('J6 三半都无 → **整层缺席**（维持"没有就不注入"的纪律）',
  neither.messages.some((m) => m.layer === 'project') === false);

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
