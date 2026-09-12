/**
 * verify-skill-watch.ts —— 技能热重载（SkillLoader.reload/startWatch + main 装配 + TreeUI 通知线）
 *
 * 验什么（手段与行为分开钉）：
 *   ① 行为段（真目录）—— SkillLoader 扫描 / frontmatter / get / getAll 副本 / 目录缺失空清单
 *   ② 行为段 —— reload 的增删差与观察者：启动 load() 不通知、新增/删除/内容更新三形状、
 *      观察者异常隔离（fail-open）、退订
 *   ③ 行为段（真 fs.watch + 防抖）—— 新增/修改/删除经 watcher 到达、防抖合并 N→1、
 *      stopWatch 后无通知、watched 目录被删不炸
 *   ④ 源码守护 —— main.ts 装配（'.' + startWatch）、runtime 每轮现取 getAll()（LLM 侧自愈）、
 *      TreeUI 订阅与退订、SkillLoader 零依赖（不 import 事件总线）
 *
 * 教训（2026-09-12）：测试造技能文件必须用与文件名一致的 frontmatter name，
 * 否则技能名 ≠ 文件名、增删差断言全线错位（首轮 10 红里 6 红是自坑）。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-skill-watch.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillLoader, type SkillChange } from '../src/runtime/skill.js';

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

/** 轮询等待条件成立（watcher 事件是异步的，用轮询而不是裸 sleep——省时且稳） */
async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 造一个临时"项目"：tmp/skills/ 目录 + 写技能文件的小工具 */
function makeProject(tag: string): {
  root: string;
  skillsDir: string;
  write: (name: string, desc?: string) => void;
  remove: (name: string) => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flint-skill-${tag}-`));
  const skillsDir = path.join(root, 'skills');
  fs.mkdirSync(skillsDir);
  return {
    root,
    skillsDir,
    /** 写技能文件：**frontmatter name 与文件名一致**（防技能名错位，见文件头教训） */
    write: (name, desc = `${name} 的描述`) =>
      fs.writeFileSync(path.join(skillsDir, `${name}.md`), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${name} 正文。`, 'utf-8'),
    remove: (name) => fs.rmSync(path.join(skillsDir, `${name}.md`), { force: true }),
  };
}

/* ── ① 行为段：扫描 / frontmatter / get ── */
console.log('── ① 行为段：真目录加载（扫描 / frontmatter / get / getAll 副本）──');
{
  const proj = makeProject('load');
  proj.write('review');
  fs.writeFileSync(path.join(proj.skillsDir, 'bare.md'), '无 frontmatter 的正文。', 'utf-8'); // 缺 name → 文件名兜底
  fs.writeFileSync(
    path.join(proj.skillsDir, 'tool.md'),
    `---\nname: translate\ndescription: 翻译\ndisable-model-invocation: true\n---\n\n正文。`,
    'utf-8',
  );

  const loader = new SkillLoader(proj.root);
  const result = loader.load();
  check('W1 三个 .md 都被扫到', result.skills.length === 3, `实际 ${result.skills.length}`);
  check('W2 frontmatter name/description 解析', loader.get('review')?.description === 'review 的描述');
  check('W3 缺 name → 文件名兜底（bare.md → bare）', loader.get('bare') !== undefined);
  check('W4 frontmatter name 覆盖文件名（tool.md → translate）', loader.get('translate') !== undefined && loader.get('tool') === undefined);
  check('W5 disable-model-invocation true 解析', loader.get('translate')?.disableModelInvocation === true);
  check('W6 get 未命中 → undefined', loader.get('nope') === undefined);

  const all = loader.getAll();
  all.push({ name: 'ghost', description: '', filePath: '', baseDir: '', disableModelInvocation: false, body: '', frontmatter: {} });
  check('W7 getAll 返回副本（外部 push 不污染内部）', loader.getAll().length === 3);

  const empty = new SkillLoader(path.join(proj.root, 'no-such-dir'));
  check('W8 目录不存在 → 空清单不抛', empty.load().skills.length === 0);

  fs.rmSync(proj.root, { recursive: true, force: true });
}

/* ── ② 行为段：reload 增删差与观察者 ── */
console.log('── ② 行为段：reload 增删差与观察者（异常隔离 / 退订 / 启动 load 不通知）──');
{
  const proj = makeProject('reload');
  proj.write('review');
  const loader = new SkillLoader(proj.root);
  loader.load();

  let notified = 0;
  let last: SkillChange | null = null;
  const seenBySecond: SkillChange[] = [];
  const off1 = loader.onChange((c) => { notified++; last = c; });
  loader.onChange((c) => { seenBySecond.push(c); });

  check('W9 启动期 load() 不触发通知', notified === 0, `实际 ${notified}`);

  // 内容更新：增删皆空
  proj.write('review', '改过的描述');
  loader.reload();
  check('W10 内容更新 → added/removed 皆空', last !== null
    && (last as SkillChange).added.length === 0 && (last as SkillChange).removed.length === 0);

  // 新增
  proj.write('extra');
  const r1 = loader.reload();
  check('W11 reload 返回值即载荷：added 含新技能', r1.added.length === 1 && r1.added[0] === 'extra');
  check('W12 观察者收到同一载荷', notified === 2 && (last as SkillChange).added[0] === 'extra');

  // 删除
  proj.remove('extra');
  const r2 = loader.reload();
  check('W13 删除 → removed 含被删名', r2.removed.length === 1 && r2.removed[0] === 'extra');
  check('W14 reload 后 get 未命中', loader.get('extra') === undefined);

  // 观察者异常隔离：第一个观察者抛异常，第二个照常收到、reload 照常返回
  off1();
  loader.onChange(() => { throw new Error('观察者故意炸'); });
  proj.write('extra2');
  const r3 = loader.reload();
  check('W15 观察者异常不影响 reload 结果（fail-open）', r3.added[0] === 'extra2');
  check('W16 观察者异常不影响其他观察者', seenBySecond.length === 4 && seenBySecond[3].added[0] === 'extra2');

  fs.rmSync(proj.root, { recursive: true, force: true });
}

/* ── ③ 行为段：真 fs.watch + 防抖 ── */
console.log('── ③ 行为段：真 fs.watch（新增 / 修改 / 删除 / 防抖合并 / stop / 目录被删）──');
{
  // 场景 1：新增 → 修改 → 删除，经 watcher 全链路到达
  const proj = makeProject('watch1');
  proj.write('review');
  const loader = new SkillLoader(proj.root);
  loader.load();
  let last: SkillChange | null = null;
  loader.onChange((c) => { last = c; });

  loader.startWatch();
  await sleep(250); // fs.watch 注册是异步的：等就位，防首写事件竞态丢失
  check('W17 startWatch 后 watching=true', loader.watching === true);
  loader.startWatch(); // 幂等
  check('W18 重复 startWatch 幂等（不双开）', loader.watching === true);

  proj.write('added-live');
  const gotAdd = await waitFor(() => (last as SkillChange | null)?.added.includes('added-live') === true);
  check('W19 新文件经 watcher 到达（added）', gotAdd);

  await sleep(500); // 排干前一步的防抖余波，避免串场
  proj.write('added-live', '改过的描述');
  const gotMod = await waitFor(() => (last as SkillChange | null) !== null
    && (last as SkillChange).added.length === 0 && (last as SkillChange).removed.length === 0);
  check('W20 修改经 watcher 到达（内容更新形状）', gotMod);

  await sleep(500);
  proj.remove('added-live');
  const gotDel = await waitFor(() => (last as SkillChange | null)?.removed.includes('added-live') === true);
  check('W21 删除经 watcher 到达（removed）', gotDel);
  loader.stopWatch();
  fs.rmSync(proj.root, { recursive: true, force: true });
}

{
  // 场景 2：防抖合并 —— 100ms 内连写 3 个文件，只应收到 1 次通知
  const proj = makeProject('watch2');
  const loader = new SkillLoader(proj.root);
  loader.load();
  let count = 0;
  loader.onChange(() => { count++; });
  loader.startWatch();
  await sleep(250);
  proj.write('a1');
  await sleep(40);
  proj.write('a2');
  await sleep(40);
  proj.write('a3');
  await sleep(900);
  check('W22 防抖合并：三连写只通知一次', count === 1, `实际 ${count} 次`);
  loader.stopWatch();
  fs.rmSync(proj.root, { recursive: true, force: true });
}

{
  // 场景 3：stopWatch 后不再收到通知
  const proj = makeProject('watch3');
  const loader = new SkillLoader(proj.root);
  loader.load();
  let count = 0;
  loader.onChange(() => { count++; });
  loader.startWatch();
  await sleep(250);
  loader.stopWatch();
  check('W23 stopWatch 后 watching=false', loader.watching === false);
  proj.write('late');
  await sleep(900);
  check('W24 停止后写文件 → 无通知', count === 0, `实际 ${count} 次`);
  fs.rmSync(proj.root, { recursive: true, force: true });
}

{
  // 场景 4：watched 目录被删 → 进程不炸；目录重建后 load() 照常可用
  const proj = makeProject('watch4');
  const loader = new SkillLoader(proj.root);
  proj.write('review');
  loader.load();
  loader.startWatch();
  await sleep(250);
  fs.rmSync(proj.skillsDir, { recursive: true, force: true });
  await sleep(600); // 给 error 事件留时间（平台差异：有的发 error，有的静默失聪）
  const stillAlive = true; // 走到这里 = 没炸
  fs.mkdirSync(proj.skillsDir); // 重建目录
  proj.write('review'); // 重新放入技能
  const reloaded = loader.load();
  const recovered = reloaded.skills.length === 1; // 显式 load 的恢复路径始终可用
  check('W25 watched 目录被删 → 不抛不崩，重建后 load() 照常可用',
    stillAlive && recovered,
    `load 后 ${reloaded.skills.length} 个，skills 目录存在=${fs.existsSync(proj.skillsDir)}`);
  loader.stopWatch();
  fs.rmSync(proj.root, { recursive: true, force: true });
}

/* ── ④ 源码守护 ── */
console.log('── ④ 源码守护（装配 / 自愈 / 通知线 / 零依赖）──');
{
  const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const mainSrc = src('src/harness/main.ts');
  check('W26 main.ts 装配传 \'.\'（修 skills/skills 扫错目录）', /new SkillLoader\('\.'\)/.test(mainSrc));
  check('W27 main.ts 调 startWatch', /skills\.startWatch\(\)/.test(mainSrc));
  const runtimeSrc = src('src/runtime/runtime.ts');
  check('W28 提示词每轮现取 getAll()（LLM 侧自愈的根基）',
    runtimeSrc.includes('skills: this.skills.getAll().map((s) => s.name)'));
  const treeSrc = src('src/io/ui/tree-ui.ts');
  check('W29 TreeUI 订阅技能热重载', treeSrc.includes('getSkillLoader().onChange'));
  check('W30 stop 时退订技能观察者', /unsubscribeSkills\(\)/.test(treeSrc));
  const skillSrc = src('src/runtime/skill.ts');
  check('W31 SkillLoader 零依赖：不 import 事件总线', !/from '\.\/events\.js'/.test(skillSrc));
  check('W32 热重载 TODO 已摘（startWatch/stopWatch 落地）', !/TODO: 热重载/.test(skillSrc));
}

console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
