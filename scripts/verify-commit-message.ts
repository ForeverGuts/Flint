/**
 * verify-commit-message.ts —— commit message 自动生成（ROADMAP 10.5.3）
 *
 * 为什么需要它：本模块的**全部价值都在"从 diff 反推文案"的判断上**，而那几条判断都"错了也不报错"：
 *   · 分类错了（把 docs 判成 feat）→ 只是消息不准，git 照样提交成功；
 *   · scope 猜错了（`src` 当成了 scope）→ 只是标题多余一个词，没有任何症状。
 * 共同点是**没有运行时报错**，所以只能靠断言盯着。
 *
 * 验什么（手段与行为分开钉，断言名字 = 它的射程，正反都给）：
 *   ① summarizeChanges —— numstat 解析 + 汇总（与 git.ts 的口径是否同一份）
 *   ② classifyChangeType —— 路径特征 → 类型（docs/test/style/config/code 各路径 + 混合兜底 + 空兜底）
 *   ③ inferScope —— 目录公共前缀 → scope（同子目录 / 仅 src / 根目录 / 单文件深层 / tests / 分叉 / 空）
 *   ④ generateCommitMessage —— 组装（单文件 / 多文件 / scope 缺席 / 空 files 返回 null / 二进制标注 / 超 20 封顶）
 *
 * 2026-09-28：删掉原 ④（extractCommitFormat + 规约 opt-out）整段与相关断言 —— 用户拍板**格式固定
 * 走 Conventional Commits**，规约正文不再参与。原 E6/E8（opt-out 标题形态）随之删除，E 段重编为 D 段。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-commit-message.ts
 * 退出码：failed > 0 → 1
 *
 * 环境依赖：纯单元，不碰 git、不碰 fs、不起进程（本模块刻意零运行时依赖）。
 */
import { parseNumstat, summarizeFiles, type DiffFile } from '../src/git/git.js';
import {
  classifyChangeType, generateCommitMessage, inferScope, summarizeChanges,
} from '../src/project/commit-message.js';

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

/** 把 numstat 文本解析成 DiffFile[]（与 handler 里那一步同口径） */
const files = (numstat: string): DiffFile[] => parseNumstat(numstat);

console.log('【① summarizeChanges：numstat 解析与汇总】');
{
  const num = '3\t0\tsrc/a.ts\n1\t2\tsrc/b.ts\n';
  const r = summarizeChanges(num);
  check('A1 解析出 2 个文件、行数汇总正确（+4 −2）',
    r.files.length === 2 && r.summary.files === 2 && r.summary.added === 4 && r.summary.deleted === 2
    && r.summary.binary === 0, JSON.stringify(r.summary));
  check('A2 summarizeChanges 的 summary 逐字段等于「parseNumstat + 单独 summarizeFiles」',
    (() => {
      const direct = summarizeFiles(parseNumstat(num));
      return JSON.stringify(direct) === JSON.stringify(r.summary);
    })());
}
{
  const r = summarizeChanges('-\t-\tlogo.png\n');
  check('A3 二进制行：binary=true、行数不计入（added/deleted 为 null 且汇总 +0 −0）',
    r.files.length === 1 && r.files[0]!.binary === true && r.files[0]!.added === null
    && r.summary.binary === 1 && r.summary.added === 0 && r.summary.deleted === 0, JSON.stringify(r.summary));
}
check('A4 空 numstat → 0 文件、汇总全 0',
  (() => { const r = summarizeChanges(''); return r.files.length === 0 && r.summary.files === 0
    && r.summary.added === 0 && r.summary.deleted === 0; })());

console.log('');
console.log('【② classifyChangeType：路径特征 → 类型（正反对照）】');
check('B1 全是 .md → docs',
  classifyChangeType(files('1\t0\tREADME.md\n5\t1\tdocs/x.md\n')) === 'docs');
check('B2 全是测试文件（.test.ts / .spec.ts）→ test',
  classifyChangeType(files('10\t0\tsrc/foo.test.ts\n2\t2\tsrc/bar.spec.ts\n')) === 'test');
check('B3 全是样式文件（.css / .scss）→ style',
  classifyChangeType(files('3\t0\ta.css\n1\t1\tb.scss\n')) === 'style');
check('B4 全是配置（tsconfig.json / .github/workflows）→ chore',
  classifyChangeType(files('1\t0\ttsconfig.json\n2\t0\t.github/workflows/ci.yml\n')) === 'chore');
check('B5 混合（源码 + 一个测试文件）→ 含源码就归 feat 兜底（不误判成 test）',
  classifyChangeType(files('1\t0\tsrc/a.ts\n2\t0\tsrc/foo.test.ts\n')) === 'feat');
check('B6 单个源码文件 → feat',
  classifyChangeType(files('5\t3\tsrc/git/write.ts\n')) === 'feat');
check('B7 空数组 → chore 兜底（不抛异常，真正拦截在生成前的"无已暂存改动"）',
  classifyChangeType([]) === 'chore');

console.log('');
console.log('【③ inferScope：目录公共前缀 → scope】');
check('C1 同子目录 src/git/* → scope 取最后一段 "git"',
  inferScope(files('1\t0\tsrc/git/a.ts\n2\t0\tsrc/git/b.ts\n')) === 'git');
check('C2 公共前缀仅到 src → null（"src" 太泛，不当 scope，避免 feat(src): …）',
  inferScope(files('1\t0\tsrc/a.ts\n2\t0\tsrc/b.ts\n')) === null);
check('C3 根目录文件（无公共目录）→ null',
  inferScope(files('1\t0\tREADME.md\n2\t0\tLICENSE\n')) === null);
check('C4 单文件深层路径 src/project/rules.ts → scope "project"',
  inferScope(files('1\t0\tsrc/project/rules.ts\n')) === 'project');
check('C5 同目录 tests/* → scope "tests"',
  inferScope(files('1\t0\ttests/foo.ts\n2\t0\ttests/bar.ts\n')) === 'tests');
check('C6 src 之下分叉（git/ 与 project/）→ 公共前缀只剩 src → null',
  inferScope(files('1\t0\tsrc/git/a.ts\n2\t0\tsrc/project/b.ts\n')) === null);
check('C7 空数组 → null',
  inferScope([]) === null);

console.log('');
console.log('【④ generateCommitMessage：组装（单/多/空/scope/二进制/超 20 封顶）】');
{
  const msg = generateCommitMessage({ files: files('5\t3\tsrc/git/write.ts\n') })!;
  check('D1 单文件源码 → 标题 "feat(git): 更新 write.ts"，正文含路径与 (+5 −3)',
    msg.startsWith('feat(git): 更新 write.ts')
    && msg.includes('\n\n+5 −3：')
    && msg.includes('src/git/write.ts (+5 −3)'), msg);
}
{
  const msg = generateCommitMessage({ files: files('1\t0\tx.md\n2\t0\ty.md\n') })!;
  check('D2 多文件 docs → 标题 "docs: 改动 2 个文件"，正文逐文件列 (+1 −0)(+2 −0)',
    msg.startsWith('docs: 改动 2 个文件')
    && msg.includes('x.md (+1 −0)') && msg.includes('y.md (+2 −0)'), msg);
}
{
  const msg = generateCommitMessage({ files: files('1\t0\tsrc/a.ts\n2\t0\tsrc/b.ts\n') })!;
  check('D3 scope 缺席（仅 src）→ 标题不带括号 scope（"feat: 改动 2 个文件"，而非 "feat(src): …"）',
    msg.startsWith('feat: 改动 2 个文件') && !msg.includes('(src)'), msg);
}
check('D4 空 files → 返回 null（调用方据此回绝，而不是生成空消息）',
  generateCommitMessage({ files: [] }) === null);
check('D5 二进制文件 → 正文标"（二进制）"而非行数',
  (() => { const m = generateCommitMessage({ files: files('-\t-\tlogo.png\n') })!;
    return m.includes('logo.png（二进制）') && !m.includes('logo.png (+'); })(),
  generateCommitMessage({ files: files('-\t-\tlogo.png\n') }) ?? 'null');
check('D6 多文件超 20 条时正文封顶并标"共 N 个文件"（防止消息爆长，验证手段而非死板数字）',
  (() => {
    const many = Array.from({ length: 25 }, (_, i) => `1\t0\tf${i}.ts`).join('\n') + '\n';
    const m = generateCommitMessage({ files: files(many) })!;
    return m.includes('…（共 25 个文件）') && (m.match(/\(\+\d+ −\d+\)/g) ?? []).length === 20;
  })());
{
  // 钉住"冒号前第一个词必须是类型词"这条形状判据：scope 只许跟在类型词后面的括号里，
  // 绝不单独顶在冒号前 —— 早先 `git: 改动 2 个文件` 就是这么错的（git 只是个目录名）。
  // D1 只覆盖了单文件，这条补"多文件 + 能推断出 scope"这个形态。
  const msg = generateCommitMessage({ files: files('1\t0\tsrc/git/a.ts\n2\t0\tsrc/git/b.ts\n') })!;
  const subject = msg.split('\n')[0]!;
  check('D7 多文件有 scope → 标题 "feat(git): 改动 2 个文件"（类型词在括号之前）',
    subject === 'feat(git): 改动 2 个文件', subject);
}

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
