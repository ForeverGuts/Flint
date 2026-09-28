/**
 * verify-commit-message.ts —— commit message 自动生成（ROADMAP 10.5.3）
 *
 * 为什么需要它：本模块的**全部价值都在"从 diff 反推文案"的判断上**，而那几条判断都"错了也不报错"：
 *   · 分类错了（把 docs 判成 feat）→ 只是消息不准，git 照样提交成功；
 *   · scope 猜错了（`src` 当成了 scope）→ 只是标题多余一个词，没有任何症状；
 *   · opt-out 正则漏判 → 规约说"用中文"却还是出了 Conventional 标题，模型也看不出"本该不同"。
 * 这三条的共同点是**没有运行时报错**，所以只能靠断言盯着。
 *
 * 验什么（手段与行为分开钉，断言名字 = 它的射程，正反都给）：
 *   ① summarizeChanges —— numstat 解析 + 汇总（与 git.ts 的口径是否同一份）
 *   ② classifyChangeType —— 路径特征 → 类型（docs/test/style/config/code 各路径 + 混合兜底 + 空兜底）
 *   ③ inferScope —— 目录公共前缀 → scope（同子目录 / 仅 src / 根目录 / 单文件深层 / tests / 分叉 / 空）
 *   ④ extractCommitFormat —— 默认 Conventional + 规约显式 opt-out（含"只提约定式提交没说不要"的反例）
 *   ⑤ generateCommitMessage —— 组装（单文件 / 多文件 / scope 缺席 / 空 files 返回 null / 二进制标注 / opt-out 走纯中文）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-commit-message.ts
 * 退出码：failed > 0 → 1
 *
 * 环境依赖：纯单元，不碰 git、不碰 fs、不起进程（本模块刻意零运行时依赖）。
 */
import { parseNumstat, summarizeFiles, type DiffFile } from '../src/git/git.js';
import {
  classifyChangeType, extractCommitFormat, generateCommitMessage, inferScope, summarizeChanges,
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
console.log('【④ extractCommitFormat：默认 Conventional + 规约 opt-out】');
check('D1 没有规约正文 → 默认 Conventional（conventional: true）',
  extractCommitFormat(null).conventional === true);
check('D2 规约正文为空串 → 默认 Conventional',
  extractCommitFormat('   \n ').conventional === true);
check('D3 规约只说"遵循 Conventional Commits"（没说不要）→ 仍是 Conventional',
  extractCommitFormat('提交请遵循 Conventional Commits：type(scope): subject').conventional === true);
check('D4 规约"不要用 Conventional Commits" → opt-out（conventional: false）',
  extractCommitFormat('提交不要用 Conventional Commits，用中文写）。').conventional === false);
check('D5 规约"commit 消息用中文" → opt-out',
  extractCommitFormat('commit 消息用中文描述本次改动。').conventional === false);
check('D6 规约只提"约定式提交"四个字、没说"不要" → 不误判为 opt-out（仍是 Conventional）',
  extractCommitFormat('我们项目采用约定式提交规范。').conventional === true);

console.log('');
console.log('【⑤ generateCommitMessage：组装（单/多/空/scope/二进制/opt-out）】');
{
  const msg = generateCommitMessage({ files: files('5\t3\tsrc/git/write.ts\n') })!;
  check('E1 单文件源码 → 标题 "feat(git): 更新 write.ts"，正文含路径与 (+5 −3)',
    msg.startsWith('feat(git): 更新 write.ts')
    && msg.includes('\n\n+5 −3：')
    && msg.includes('src/git/write.ts (+5 −3)'), msg);
}
{
  const msg = generateCommitMessage({ files: files('1\t0\tx.md\n2\t0\ty.md\n') })!;
  check('E2 多文件 docs → 标题 "docs: 改动 2 个文件"，正文逐文件列 (+1 −0)(+2 −0)',
    msg.startsWith('docs: 改动 2 个文件')
    && msg.includes('x.md (+1 −0)') && msg.includes('y.md (+2 −0)'), msg);
}
{
  const msg = generateCommitMessage({ files: files('1\t0\tsrc/a.ts\n2\t0\tsrc/b.ts\n') })!;
  check('E3 scope 缺席（仅 src）→ 标题不带括号 scope（"feat: 改动 2 个文件"，而非 "feat(src): …"）',
    msg.startsWith('feat: 改动 2 个文件') && !msg.includes('(src)'), msg);
}
check('E4 空 files → 返回 null（调用方据此回绝，而不是生成空消息）',
  generateCommitMessage({ files: [] }) === null);
check('E5 二进制文件 → 正文标"（二进制）"而非行数',
  (() => { const m = generateCommitMessage({ files: files('-\t-\tlogo.png\n') })!;
    return m.includes('logo.png（二进制）') && !m.includes('logo.png (+'); })(),
  generateCommitMessage({ files: files('-\t-\tlogo.png\n') }) ?? 'null');
/** opt-out 下不该出现的两种前缀形状：Conventional 类型词，以及任何"英文词:"（含 scope 目录名） */
const TYPE_WORD_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(|$)/;
const ASCII_LABEL_RE = /^[A-Za-z][\w./-]*\s*[:：]/;
{
  // opt-out：规约说不要 Conventional → 标题是**纯中文一句话，不带任何前缀**。
  // 2026-09-28 实测改掉早先的 "git: 更新 write.ts"：scope 是目录名，顶在冒号前会被当成
  // 提交类型。位置信息不靠标题补——正文已逐行列出完整路径。
  const msg = generateCommitMessage({
    files: files('5\t3\tsrc/git/write.ts\n'),
    rulesText: '提交消息不要用 Conventional Commits，用中文一句话说明。',
  })!;
  const subject = msg.split('\n')[0]!;
  check('E6 opt-out（单文件有 scope）→ 标题 "更新 write.ts"，既无类型词也无 "git:" 这类前缀',
    subject === '更新 write.ts' && !TYPE_WORD_RE.test(subject) && !ASCII_LABEL_RE.test(subject),
    subject);
}
check('E7 多文件超 20 条时正文封顶并标"共 N 个文件"（防止消息爆长，验证手段而非死板数字）',
  (() => {
    const many = Array.from({ length: 25 }, (_, i) => `1\t0\tf${i}.ts`).join('\n') + '\n';
    const m = generateCommitMessage({ files: files(many) })!;
    return m.includes('…（共 25 个文件）') && (m.match(/\(\+\d+ −\d+\)/g) ?? []).length === 20;
  })());
{
  // E6 只覆盖了"单文件"；多文件且能推断出 scope 时才是早先 `scope: 描述` 露馅的地方
  // （会产出 "git: 改动 2 个文件"）。补这一条把该形态钉住。
  const msg = generateCommitMessage({
    files: files('1\t0\tsrc/git/a.ts\n2\t0\tsrc/git/b.ts\n'),
    rulesText: '提交消息不要用 Conventional Commits，用中文一句话说明。',
  })!;
  const subject = msg.split('\n')[0]!;
  check('E8 opt-out（多文件有 scope）→ 标题 "改动 2 个文件"，不出现 "git:" 这类目录名当前缀',
    subject === '改动 2 个文件' && !subject.includes('git') && !ASCII_LABEL_RE.test(subject),
    subject);
}

console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
