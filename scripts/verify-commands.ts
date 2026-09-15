/**
 * verify-commands.ts —— 项目命令注册表（ROADMAP 10.6.1，**发现**半边）
 *
 * 为什么需要它：这条功能的价值是"模型不必再猜这个项目有哪些命令"，而它有三个容易悄悄
 * 失效或悄悄越界的位置，本套件逐个钉死：
 *   ① 解析 —— package.json 是**人写的、可能脏的**文件。读不懂就当没有（退回现状），
 *      绝不该让启动失败；但**条目级**的脏数据要丢掉（空名 / 超长名 / 值不是字符串），
 *      否则注入里会出现 `- \`npm run \`〔其他〕—— undefined` 这种垃圾。
 *   ② 引用 —— 登记表写 `{"use":"test"}` 时，"引用不到"必须等于"不启用"。这是**声明即授权**
 *      的另一面：引用了一个注册表里没有的名字，等同于没声明，跑它是无授权执行。
 *   ③ 界线 —— **发现 ≠ 授权**。本模块只许"发现 + 被引用"，**不许执行任何命令**。
 *      这条一旦破（比如手滑加一句"没登记表就自动跑第一条 test"），模型改一行
 *      package.json 就给自己开了一条免弹窗执行的路 —— 与 postcheck 防的那条是同一条。
 *
 * 验什么（手段与行为分开钉）：
 *   ① 解析 —— 逐形状（非 JSON / 非对象 / 无 scripts / scripts 不是对象 / 脏条目）+ 顺序与 trim
 *   ② 分类 —— 七类各一组正反例（**只影响展示标签**，不影响任何判定，故只钉映射本身）
 *   ③ 查找 —— 命中 / 未命中 / 精确匹配（前缀不算）/ 非字符串
 *   ④ 渲染 —— 空表缺席 / 单行形状 / 上限截断 / 预览截断 / 标题
 *   ⑤ 登记表引用 use —— 命中 / 引用不到 / 不传表 / 与 command 同写（含糊）/ 空白 / 非字符串
 *   ⑥ 源码守护 —— 零 import；**不执行任何命令**（无 spawn/exec）；main 播种一次；
 *      runtime 与 system-prompt 都接了；core 类型里有 commands 位
 *   ⑦ 行为证明 —— 真读本仓 package.json；真 SystemPromptServiceImpl 注入（含层缺席）；
 *      端到端：真文件 → 播种 → 登记表 use → 解析出可执行串
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-commands.ts
 *      （npm run verify 会自动发现本文件，无需登记）
 * 退出码：failed > 0 → 1
 *
 * 环境依赖：⑦ 段读本仓真实的 package.json（本仓必然有，否则整个 verify 都跑不起来）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemPromptServiceImpl } from '../src/context/system-prompt.js';
import {
  COMMAND_NAME_MAX, COMMAND_PREVIEW_MAX, COMMANDS_RENDER_MAX, KIND_LABELS, PACKAGE_JSON_FILE,
  classifyCommand, commandRegistry, findCommand, parsePackageScripts, renderCommandsSection,
  type ProjectCommand,
} from '../src/project/commands.js';
import { parsePostcheckConfig, postcheckRegistry } from '../src/project/postcheck.js';

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

const ok = (text: string): string => JSON.stringify(text.slice(0, 90));

/** 造一份最小 package.json 文本 */
const pkg = (scripts: unknown): string => JSON.stringify({ name: 'demo', scripts });

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 解析：宽容到底（读不懂=没有），条目级严格（脏条目丢掉）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n① 解析（宽容到底：读不懂就当没有，退回现状）');

const one = parsePackageScripts(pkg({ test: 'tsc --noEmit' }));
check('A1 合法 scripts → 一条命令，run 是 `npm run <name>`',
  one.length === 1 && one[0].name === 'test' && one[0].run === 'npm run test', ok(JSON.stringify(one)));
check('A2 script 保留原始值（展示"这条到底跑什么"）', one[0].script === 'tsc --noEmit');

check('A3 非字符串（undefined）→ 空表', parsePackageScripts(undefined).length === 0);
check('A4 空串 / 纯空白 → 空表',
  parsePackageScripts('').length === 0 && parsePackageScripts('  \n ').length === 0);
check('A5 不是 JSON（比如文件被写坏了）→ 空表', parsePackageScripts('{oops').length === 0);
check('A6 JSON 数组 → 空表', parsePackageScripts('[]').length === 0);
check('A7 JSON 字符串 / null / 数字 → 空表',
  parsePackageScripts('"x"').length === 0
  && parsePackageScripts('null').length === 0
  && parsePackageScripts('42').length === 0);
check('A8 对象但**没有 scripts** 字段 → 空表（不是报错）',
  parsePackageScripts('{"name":"demo"}').length === 0);
check('A9 scripts 是数组 / 字符串 / null → 空表',
  parsePackageScripts('{"scripts":[]}').length === 0
  && parsePackageScripts('{"scripts":"build"}').length === 0
  && parsePackageScripts('{"scripts":null}').length === 0);
check('A10 scripts 是空对象 → 空表（有字段但没内容，仍是"没有命令"）',
  parsePackageScripts(pkg({})).length === 0);

const dirty = parsePackageScripts(pkg({
  '': 'should be dropped',
  '   ': 'also dropped',
  [`n${'x'.repeat(COMMAND_NAME_MAX)}`]: 'too long',
  good: 'kept',
  num: 42,
  nul: null,
  bool: true,
  empty: '   ',
}));
check('A11 空名 / 纯空白名 → 丢掉（JSON 允许 "" 作键，但那不是能跑的命令）',
  dirty.every((c) => c.name.trim() !== ''));
check('A12 超长名 → 丢掉（> COMMAND_NAME_MAX）',
  dirty.every((c) => c.name.length <= COMMAND_NAME_MAX));
check('A13 值不是非空字符串（数字 / null / 布尔 / 空白）→ 丢掉',
  dirty.length === 1 && dirty[0].name === 'good', ok(JSON.stringify(dirty)));
check('A14 名字与值都 trim（手写 JSON 常带空白）',
  parsePackageScripts(pkg({ '  test  ': '  node a.mjs  ' }))[0].script === 'node a.mjs'
  && parsePackageScripts(pkg({ '  test  ': 'node a.mjs' }))[0].name === 'test');
check('A15 保持 scripts 的原顺序（不重排 —— 顺序是 package.json 自己的表达）',
  parsePackageScripts(pkg({ zeta: 'z', alpha: 'a', mid: 'm' })).map((c) => c.name).join(',')
    === 'zeta,alpha,mid');
check('A16 多个字段混在一起时只取 scripts（name/version/deps 都不进表）',
  parsePackageScripts('{"name":"x","version":"1.0.0","scripts":{"a":"A"},"deps":{}}').length === 1);
check('A17 常量：来源是 package.json（Makefile 半边未做，见模块文件头）',
  PACKAGE_JSON_FILE === 'package.json' && COMMANDS_RENDER_MAX === 40 && COMMAND_NAME_MAX === 60);

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 分类：只影响展示标签，不影响任何判定
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n② 分类（展示分组；判错只影响标签好不好看）');

check('B1 type / tsc → typecheck',
  classifyCommand('typecheck', '') === 'typecheck' && classifyCommand('types', '') === 'typecheck');
check('B2 test / spec / e2e / check → test',
  classifyCommand('test', '') === 'test'
  && classifyCommand('test:e2e', '') === 'test'
  && classifyCommand('spec', '') === 'test');
check('B3 lint / eslint → lint',
  classifyCommand('lint', '') === 'lint' && classifyCommand('lint:fix', '') === 'lint');
check('B4 build / compile / bundle / dist → build',
  classifyCommand('build', '') === 'build' && classifyCommand('compile', '') === 'build');
check('B5 format / fmt / prettier → format',
  classifyCommand('format', '') === 'format' && classifyCommand('fmt', '') === 'format');
check('B6 dev / serve / start / watch → dev',
  classifyCommand('dev', '') === 'dev' && classifyCommand('start', '') === 'dev');
check('B7 没有特征 → other（不硬猜）',
  classifyCommand('deploy', '') === 'other' && classifyCommand('docs:sync', '') === 'other');
check('B8 大小写不敏感（npm 脚本名大小写混用很常见）',
  classifyCommand('Test', '') === 'test' && classifyCommand('TSC-check', '') === 'typecheck');
check('B9 typecheck 优先于 test（`type-check` 同时含 type 与 check）',
  classifyCommand('type-check', '') === 'typecheck');
check('B10 名字无特征但脚本里是 tsc → typecheck（兜底看内容）',
  classifyCommand('verify', 'tsc --noEmit') === 'typecheck');
check('B11 兜底只在 other 才生效（lint 的脚本里就算有 tsc 也还是 lint）',
  classifyCommand('lint', 'tsc --noEmit') === 'lint');
check('B12 七个 kind 都有中文标签（注入里不能出现 undefined）',
  Object.keys(KIND_LABELS).length === 7
  && Object.values(KIND_LABELS).every((v) => typeof v === 'string' && v !== ''));

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 查找：精确匹配（引用的就是 scripts 的键）
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n③ 查找（登记表 use 的解析依据）');

const table: ProjectCommand[] = parsePackageScripts(pkg({ test: 't', build: 'b', 'lint:fix': 'l' }));
check('C1 命中 → 返回该条', findCommand(table, 'test')?.run === 'npm run test');
check('C2 未命中 → undefined（引用不到 = 不启用，见 ⑤）', findCommand(table, 'nope') === undefined);
check('C3 **精确匹配**：前缀不算命中（`lint` 不该命中 `lint:fix`）',
  findCommand(table, 'lint') === undefined, ok(String(findCommand(table, 'lint')?.name)));
check('C4 名字带空白 → trim 后仍命中', findCommand(table, '  test  ')?.name === 'test');
check('C5 非字符串 / 空串 / 纯空白 → undefined',
  findCommand(table, 42) === undefined
  && findCommand(table, '') === undefined
  && findCommand(table, '   ') === undefined);

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 渲染：空表缺席 + 硬上限
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n④ 渲染（空表整段缺席；超上限只报条数）');

check('D1 空表 → 空串（整段缺席，与 project/memory/task 三层同一纪律）',
  renderCommandsSection([]) === '');
check('D2 非数组（脏入参）→ 空串，不抛',
  renderCommandsSection(undefined as never) === '');
const oneLine = renderCommandsSection(parsePackageScripts(pkg({ test: 'tsc --noEmit' })));
check('D3 单条 → 标题一行 + 命令一行（一行一条才好扫）',
  oneLine.split('\n').length === 2, ok(oneLine));
check('D4 行内含可执行的 run、分类标签与脚本预览',
  oneLine.includes('`npm run test`') && oneLine.includes('〔测试〕') && oneLine.includes('tsc --noEmit'),
  ok(oneLine));
check('D5 标题点明来源（模型知道这张表从哪来、不是凭空编的）',
  oneLine.startsWith('## 项目命令（来自 package.json 的 scripts'), ok(oneLine.split('\n')[0]));

const many = renderCommandsSection(parsePackageScripts(pkg(
  Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`c${i}`, `echo ${i}`])),
)));
check('D6 超过上限 → 只列前 40 条', many.split('\n').length === 1 + COMMANDS_RENDER_MAX + 1,
  ok(String(many.split('\n').length)));
check('D7 超出部分**报条数**（这是地图不是完整清单）',
  many.includes('另有 5 条未列出'), ok(many.split('\n').slice(-1)[0]));
check('D8 恰好等于上限 → 不报"另有"',
  !renderCommandsSection(parsePackageScripts(pkg(
    Object.fromEntries(Array.from({ length: COMMANDS_RENDER_MAX }, (_, i) => [`c${i}`, `echo ${i}`])),
  ))).includes('未列出'));

const longScript = renderCommandsSection(parsePackageScripts(pkg({ x: 'y'.repeat(500) })));
check('D9 脚本预览超长 → 截断并带省略号（注入不是看全文的地方）',
  longScript.includes('…') && longScript.split('\n')[1].length < 500,
  ok(String(longScript.split('\n')[1].length)));
check('D10 预览长度上限常量与实现一致', COMMAND_PREVIEW_MAX === 120);

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑤ 登记表引用 use：授权仍来自人写的登记表
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑤ 登记表引用（use：授权不变，命令本体交给注册表）');

const menu: ProjectCommand[] = parsePackageScripts(pkg({ test: 'tsc --noEmit', build: 'tsc -p .' }));

check('E1 {"use":"test"} → 解析成那条命令的 run',
  parsePostcheckConfig('{"use":"test"}', menu)?.command === 'npm run test',
  ok(String(parsePostcheckConfig('{"use":"test"}', menu)?.command)));
check('E2 use + timeoutMs → 两者都取到',
  JSON.stringify(parsePostcheckConfig('{"use":"test","timeoutMs":9000}', menu))
  === JSON.stringify({ command: 'npm run test', timeoutMs: 9000 }));
check('E3 引用了注册表里**没有**的名字 → null（引用不到 = 没声明 = 不跑）',
  parsePostcheckConfig('{"use":"nope"}', menu) === null);
check('E4 **不传命令表**时 use → null（没有注册表就无所谓引用）',
  parsePostcheckConfig('{"use":"test"}') === null);
check('E5 命令表是空表时 use → null', parsePostcheckConfig('{"use":"test"}', []) === null);
check('E6 command 与 use **都写** → null（含糊 = 不知道该听谁的）',
  parsePostcheckConfig('{"use":"test","command":"npm run build"}', menu) === null);
check('E7 use 是空串 / 纯空白 → null',
  parsePostcheckConfig('{"use":""}', menu) === null
  && parsePostcheckConfig('{"use":"   "}', menu) === null);
check('E8 use 不是字符串 → null', parsePostcheckConfig('{"use":123}', menu) === null);
check('E9 use 是 null → null（不是"没给"）',
  parsePostcheckConfig('{"use":null}', menu) === null);
check('E10 只写 command（旧格式）照旧工作（本条不破坏已登记的登记表）',
  parsePostcheckConfig('{"command":"npm run x"}', menu)?.command === 'npm run x');
check('E11 两个都没有 → null（没声明就是没授权）',
  parsePostcheckConfig('{}', menu) === null);
check('E12 引用不占用默认超时（use 走的是同一条超时校验）',
  parsePostcheckConfig('{"use":"test","timeoutMs":1}', menu) === null);

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑥ 源码守护：位置与界线比实现更容易错
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑥ 源码守护（发现 ≠ 授权：本模块不许执行任何命令）');

const cmdSrc = fs.readFileSync(path.join(ROOT, 'src/project/commands.ts'), 'utf8');
const cmdCode = stripComments(cmdSrc);
const mainCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf8'));
const runtimeCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/runtime/runtime.ts'), 'utf8'));
const spCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/context/system-prompt.ts'), 'utf8'));
const coreSpCode = stripComments(fs.readFileSync(path.join(ROOT, 'src/core/system-prompt.ts'), 'utf8'));

check('F1 commands.ts 零 import（纯函数模块，解析渲染能脱离终端验）',
  !/^import /m.test(cmdCode), ok(cmdCode.slice(0, 60)));
check('F2 **不执行任何命令**：全文件无 spawn / exec / child_process（发现 ≠ 授权）',
  !/\b(spawnSync|spawn|execSync|execFileSync|exec)\b/.test(cmdCode)
  && !/node:child_process/.test(cmdCode), ok(cmdCode.match(/\b(spawnSync|execSync|execFileSync)\b/)?.[0] ?? ''));
check('F3 commands.ts 也不碰 fs（读文件在 harness，模块只收文本）',
  !/node:fs/.test(cmdCode) && !/\breadFileSync\b/.test(cmdCode));
check('F4 main.ts 在启动时播种命令表（读 package.json）',
  mainCode.includes('existsSync(PACKAGE_JSON_FILE)') && mainCode.includes('parsePackageScripts('));
check('F5 **运行期不回读**：读 package.json 在 main.ts 里只出现一次（自我授权路径）',
  (mainCode.match(/readFileSync\(PACKAGE_JSON_FILE/g) ?? []).length === 1);
check('F6 登记表解析拿到了命令表（use 才有得查）',
  /parsePostcheckConfig\(readFileSync\(POSTCHECK_FILE[^)]*\),\s*commands\)/.test(mainCode),
  ok(mainCode.match(/parsePostcheckConfig\([^\n]*/)?.[0] ?? ''));
check('F7 runtime 每轮渲染并注入命令段',
  runtimeCode.includes('renderCommandsSection(commandRegistry.get())')
  && runtimeCode.includes('commands: commandsSection'));
check('F8 空表 → 传 undefined（半段缺席，不塞空串进提示词）',
  runtimeCode.includes("commandsSection === '' ? undefined : commandsSection"));
check('F9 system-prompt 的 project 层把 commands 拼进同一条消息',
  /layer: 'project'/.test(spCode) && spCode.includes('ctx.commands'));
check('F10 两半都无 → project 层整层缺席（维持"没有就不注入"）',
  /if \(ctx\.project \|\| ctx\.commands\)/.test(spCode));
check('F11 SystemPromptContext 里加了 commands 位（类型层没漏）',
  /commands\?: string \| undefined;/.test(coreSpCode));
// 分层序是**承重的**（越稳定越靠前）：命令表并进 project 层，不能把它挪到别处去
const idxSkills = spCode.indexOf("layer: 'skills'");
const idxProject = spCode.indexOf("layer: 'project'");
const idxMemory = spCode.indexOf("layer: 'memory'");
check('F12 分层序没被动过：union 那串仍是官方顺序',
  coreSpCode.includes("'core' | 'tools' | 'skills' | 'project' | 'memory' | 'task' | 'summary' | 'custom'"),
  ok(coreSpCode.match(/SystemPromptLayer = [^\n]*/)?.[0] ?? ''));
check('F13 project 层仍夹在 skills 与 memory 之间（命令表并进它，不是另起一层）',
  idxSkills >= 0 && idxProject > idxSkills && idxMemory > idxProject,
  ok(`skills=${idxSkills} project=${idxProject} memory=${idxMemory}`));

/* ═══════════════════════════════════════════════════════════════════════════════
   ⑦ 行为证明：真文件 + 真注入
   ═══════════════════════════════════════════════════════════════════════════════ */

console.log('\n⑦ 行为证明（真 package.json + 真 SystemPromptServiceImpl）');

// ── G：真读本仓自己的 package.json（这是它每天要面对的输入） ──
const real = parsePackageScripts(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('G1 本仓 package.json 解析出多条命令', real.length >= 3, ok(String(real.length)));
check('G2 里面认得出 verify（本仓的验证入口）', real.some((c) => c.name === 'verify'));
check('G3 每条都有 run / script / kind 三件套（注入时不会有 undefined）',
  real.every((c) => c.run.startsWith('npm run ') && c.script !== '' && KIND_LABELS[c.kind] !== undefined));
check('G4 真实命令表渲染出来是多行（不是空段）',
  renderCommandsSection(real).split('\n').length === real.length + 1);

// ── H：真注入（跑真对象，不只看源码） ──
const noopBus = { emitHook: async () => undefined, on: () => () => {} } as never;
const svc = new SystemPromptServiceImpl({
  core: [], tools: [], skills: [], fallback: 'fallback',
}, noopBus);
const baseCtx = {
  tools: '', skills: [] as string[], model: 'test-model', summary: undefined,
  historyCount: 0,
};

const built = await svc.build({
  ...baseCtx,
  project: '模块 A / 模块 B',
  commands: renderCommandsSection(real),
});
const projectMsg = built.messages.find((m) => m.layer === 'project');
check('H1 注入真的发生了：project 层存在', projectMsg !== undefined);
check('H2 同一条消息里既有现状快照也有命令表（两半合成一层）',
  projectMsg?.content.includes('[项目现状]') === true
  && projectMsg?.content.includes('## 项目命令') === true, ok(projectMsg?.content.slice(0, 80)));

const onlyCommands = await svc.build({ ...baseCtx, commands: renderCommandsSection(real) });
check('H3 只有命令表、没有现状快照 → 层仍在（任一半就出层）',
  onlyCommands.messages.some((m) => m.layer === 'project') === true);

const neither = await svc.build({ ...baseCtx });
check('H4 两半都无 → **整层缺席**（没有就不注入）',
  neither.messages.some((m) => m.layer === 'project') === false);

// ── I：端到端 —— 真文件 → 播种 → 登记表 use → 可执行的那一句 ──
const cwd0 = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-commands-'));
try {
  process.chdir(tmp);
  fs.writeFileSync('package.json', JSON.stringify({
    name: 'demo',
    scripts: { verify: 'tsc --noEmit', build: 'tsc -p .' },
  }));
  fs.mkdirSync('.flint', { recursive: true });
  fs.writeFileSync('.flint/postcheck.json', '{"use":"verify","timeoutMs":20000}');

  // 与 harness/main.ts 播种那几行**同形**（同一条链路，不是另写一份）
  const discovered = parsePackageScripts(fs.readFileSync('package.json', 'utf-8'));
  commandRegistry.set(discovered);
  postcheckRegistry.set(parsePostcheckConfig(
    fs.readFileSync('.flint/postcheck.json', 'utf-8'), discovered,
  ));

  check('I1 端到端：真 package.json → 注册表里确实有 verify',
    commandRegistry.get().some((c) => c.name === 'verify'));
  check('I2 端到端：登记表 `{"use":"verify"}` 解析成可执行的那一句',
    postcheckRegistry.get()?.command === 'npm run verify',
    ok(String(postcheckRegistry.get()?.command)));
  check('I3 端到端：超时也一起取到了', postcheckRegistry.get()?.timeoutMs === 20000);

  // 引用一个不存在的名字 → 不启用（**没有登记表就什么都不跑**的同一条纪律）
  fs.writeFileSync('.flint/postcheck.json', '{"use":"does-not-exist"}');
  postcheckRegistry.set(parsePostcheckConfig(
    fs.readFileSync('.flint/postcheck.json', 'utf-8'), discovered,
  ));
  check('I4 端到端：引用不到 → null（不会拿一条没被授权的命令去跑）',
    postcheckRegistry.get() === null);

  // 没有 package.json 的项目：一切退回现状
  fs.rmSync('package.json');
  const noPkg: ProjectCommand[] = [];
  commandRegistry.set(noPkg);
  postcheckRegistry.set(parsePostcheckConfig('{"use":"verify"}', noPkg));
  check('I5 端到端：没有 package.json → 命令表空、use 解析失败（默认态零行为变化）',
    commandRegistry.get().length === 0 && postcheckRegistry.get() === null);
} finally {
  process.chdir(cwd0);
  postcheckRegistry.clear();
  commandRegistry.clear();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
