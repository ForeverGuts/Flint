/**
 * verify-skill-deps.ts —— 技能依赖追踪（Skill.depends 声明 + getDependents 反查 + reload broken）
 *
 * 验什么（手段与行为分开钉）：
 *   ① 行为段（真目录）—— frontmatter `depends:` 解析形状（单个 / 逗号多个 / 空白 / 空值 / 去重 / 缺键）
 *   ② 行为段 —— getDependents 反向查询：多依赖者按清单序、悬空名字也可查、未命中为空
 *   ③ 行为段 —— reload 的 broken：删被依赖者 → 依赖者进 broken / 无依赖者不进 / 依赖者同删不进 /
 *      新增者声明依赖不算 broken / 观察者真收到 broken
 *   ④ 纯函数段 —— skills-section：标注依赖 / 标注缺失 / 无依赖不标 / 旧 ctx（无 skillDeps）兼容 / 空清单跳过
 *   ⑤ 源码守护 —— runtime 构造 skillDeps / section 读取 / tree-ui 用 change.broken / TODO 已删
 *
 * 设计取舍（为什么没有 addDependency）：程序化注册 API 若没有真实调用方，就是本仓库已付过三次学费的
 * 「支持但未接线」债（runtime.onInput / appendMessage extra / permission.clear）。依赖的唯一声明口是
 * frontmatter，查询走 getDependents，broken 只描述"本次删除导致的断裂"。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-skill-deps.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillLoader, type SkillChange } from '../src/runtime/skill.js';
import { skillsSection } from '../src/context/sections/skills-section.js';
import type { SystemPromptContext } from '../src/core/system-prompt.js';

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

/** 造一个临时"项目"：tmp/skills/ 目录 + 写技能文件的小工具（frontmatter name 与文件名一致，教训见 verify-skill-watch） */
function makeProject(tag: string): {
  root: string;
  skillsDir: string;
  write: (name: string, opts?: { depends?: string }) => void;
  remove: (name: string) => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flint-skilldeps-${tag}-`));
  const skillsDir = path.join(root, 'skills');
  fs.mkdirSync(skillsDir);
  return {
    root,
    skillsDir,
    write: (name, opts = {}) => {
      const fm = [`name: ${name}`, `description: ${name} 的描述`];
      if (opts.depends !== undefined) fm.push(`depends: ${opts.depends}`);
      fs.writeFileSync(path.join(skillsDir, `${name}.md`), `---\n${fm.join('\n')}\n---\n\n${name} 正文。`, 'utf-8');
    },
    remove: (name) => fs.rmSync(path.join(skillsDir, `${name}.md`), { force: true }),
  };
}

/** 构造最小合法 SystemPromptContext（段落是纯函数，直接喂形状） */
function makeCtx(partial: { skills: string[]; skillDeps?: Record<string, string[]> }): SystemPromptContext {
  return { tools: '', model: 'test-model', historyCount: 0, ...partial };
}

/* ── ① 行为段：depends 解析 ── */
console.log('── ① 行为段：frontmatter depends 解析（真目录）──');
{
  const proj = makeProject('parse');
  proj.write('a'); // 无 depends 键
  proj.write('b', { depends: 'a' }); // 单个
  proj.write('c', { depends: 'a, b' }); // 逗号多个
  proj.write('d', { depends: ' a ,  b ,a ' }); // 空白 + 重复
  proj.write('e', { depends: '' }); // 空值
  fs.writeFileSync(path.join(proj.skillsDir, 'f.md'), '---\nname: f\ndescription: f\ndepends: true\n---\n\nf 正文。', 'utf-8'); // 非字符串值

  const loader = new SkillLoader(proj.root);
  loader.load();
  check('D1 无 depends 键 → 空数组', JSON.stringify(loader.get('a')?.depends) === '[]');
  check('D2 单个依赖解析', JSON.stringify(loader.get('b')?.depends) === '["a"]');
  check('D3 逗号多个解析', JSON.stringify(loader.get('c')?.depends) === '["a","b"]');
  check('D4 空白容忍 + 去重保序', JSON.stringify(loader.get('d')?.depends) === '["a","b"]');
  check('D5 空值 → 空数组', JSON.stringify(loader.get('e')?.depends) === '[]');
  check('D6 非字符串值（布尔）→ 空数组不炸', JSON.stringify(loader.get('f')?.depends) === '[]');

  fs.rmSync(proj.root, { recursive: true, force: true });
}

/* ── ② 行为段：getDependents 反向查询 ── */
console.log('── ② 行为段：getDependents 反向查询 ──');
{
  const proj = makeProject('reverse');
  proj.write('a');
  proj.write('b', { depends: 'a' });
  proj.write('c', { depends: 'a' });
  proj.write('d', { depends: 'ghost' }); // 悬空声明（ghost 不存在）

  const loader = new SkillLoader(proj.root);
  loader.load();
  const deps = loader.getDependents('a');
  check('D7 多依赖者全查出', deps.includes('b') && deps.includes('c') && deps.length === 2, `实际 ${JSON.stringify(deps)}`);
  check('D8 悬空名字也可查（谁声明了依赖它）', JSON.stringify(loader.getDependents('ghost')) === '["d"]');
  check('D9 未命中 → 空数组', JSON.stringify(loader.getDependents('nobody')) === '[]');
  check('D10 自身不依赖自己（a 无声明 → 不在 a 的依赖者里）', !loader.getDependents('a').includes('a'));

  fs.rmSync(proj.root, { recursive: true, force: true });
}

/* ── ③ 行为段：reload 的 broken ── */
console.log('── ③ 行为段：reload broken（删除导致的依赖断裂）──');
{
  const proj = makeProject('broken');
  proj.write('a');
  proj.write('b', { depends: 'a' });
  proj.write('c', { depends: 'a' });
  proj.write('solo', { depends: 'nobody' }); // 悬空声明，与 a 的存亡无关

  const loader = new SkillLoader(proj.root);
  loader.load();
  const events: SkillChange[] = [];
  const unsubscribe = loader.onChange((change) => events.push(change));

  proj.remove('a');
  const change = loader.reload();
  check('D11 removed 含 a', change.removed.includes('a') && change.removed.length === 1);
  check('D12 broken = b、c（依赖被删者的都在）', JSON.stringify([...change.broken].sort()) === '["b","c"]', `实际 ${JSON.stringify(change.broken)}`);
  check('D13 悬空声明者不因无关删除进 broken', !change.broken.includes('solo'));

  proj.remove('b'); // 依赖者自己也删
  const change2 = loader.reload();
  check('D14 依赖者同删 → 不进 broken', !change2.broken.includes('b'), `实际 ${JSON.stringify(change2.broken)}`);

  proj.write('b2', { depends: 'c' }); // 新增者声明依赖现有技能
  const change3 = loader.reload();
  check('D15 新增者声明依赖不算 broken', change3.added.includes('b2') && !change3.broken.includes('b2'));

  proj.remove('c');
  const change4 = loader.reload();
  check('D16 被删者的依赖者跨批次仍能查出（b2 依赖 c）', change4.broken.includes('b2'));

  check('D17 观察者真收到 broken（通知线通）', events.length === 4 && events.every((e) => Array.isArray(e.broken)));
  check('D18 broken 与观察者收到的第 4 条一致', events[3].broken.includes('b2'));

  unsubscribe();
  fs.rmSync(proj.root, { recursive: true, force: true });
}

/* ── ④ 纯函数段：skills-section 的依赖标注 ── */
console.log('── ④ 纯函数段：skills-section 标注依赖与缺失 ──');
{
  const both = skillsSection(
    makeCtx({ skills: ['review', 'audit'], skillDeps: { review: ['audit'], audit: [] } }),
  );
  check('D19 有依赖 → 标注「（依赖: audit）」', both !== undefined && both.includes('review（依赖: audit）'));
  check('D20 无依赖 → 不标注', both !== undefined && /^  - audit$/m.test(both));

  const missing = skillsSection(
    makeCtx({ skills: ['review'], skillDeps: { review: ['audit', 'lint'] } }),
  );
  check('D21 缺失依赖 → 标注「缺失」', missing !== undefined && missing.includes('（缺失: audit, lint）'));
  check('D22 缺失标注不冒充存在（audit 不以依赖者身份出现）', missing !== undefined && !missing.includes('- audit'));

  const legacy = skillsSection(makeCtx({ skills: ['review'] }));
  check('D23 旧 ctx（无 skillDeps）兼容 → 纯列表不标依赖', legacy !== undefined && !legacy.includes('依赖'));

  check('D24 空清单 → undefined（跳过本段）', skillsSection(makeCtx({ skills: [] })) === undefined);
}

/* ── ⑤ 源码守护 ── */
console.log('── ⑤ 源码守护：接线点防回退 ──');
{
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
  const runtimeSrc = read('src/runtime/runtime.ts');
  const sectionSrc = read('src/context/sections/skills-section.ts');
  const treeSrc = read('src/io/ui/tree-ui.ts');
  const skillSrc = read('src/runtime/skill.ts');

  check('D25 runtime 构造 ctx 时带 skillDeps', runtimeSrc.includes('skillDeps:'));
  check('D26 skills-section 真的读取 skillDeps（不是死字段）', sectionSrc.includes('ctx.skillDeps'));
  check('D27 tree-ui 提示行真的消费 change.broken', treeSrc.includes('change.broken'));
  check('D28 skill.ts 的依赖追踪 TODO 已删（实现已落地）', !skillSrc.includes('TODO: 依赖追踪'));
  check('D29 SkillChange 契约含 broken', skillSrc.includes('broken: string[]'));
}

console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
if (failed > 0) process.exit(1);
