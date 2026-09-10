/**
 * TreeUI 消息框宽度 + 回合指示器专项验证。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-ui.ts
 *
 * 背景（用户实测反馈三件事）：
 *   ① 框宽固定 50 列 → 每行能装的文本太少，窄条难看；改为随终端自适应（50~110）
 *   ② 回复中途的长等待没有状态提示 → 指示器改为"回合级"：从按下 Enter 到 agent_end 全程不黑屏，
 *      并堵住两个历史黑屏窗口（工具执行期、工具结束后的下一次 LLM 调用）
 *   ③ 流式输出期间框是"开着口"的，没有任何"还在输出"的信号 → 开口底边常驻"正在输出… N 秒 · 已收 X 字"，
 *      回复结束才整行换成 └──┘（就地封口，不重建整框）
 *
 * 测试通道：不调用 start()（无 TTY），替换 screen 为哑对象后直接喂 handleEvent，
 *           再从组件树 render() 出的行数组上做断言。
 */
import { TreeUI, type TreeUIInfo } from '../src/io/ui/tree-ui.js';
import type { Runtime } from '../src/runtime/runtime.js';
import { visibleWidth, wrapText } from '../src/io/ui/fit-width.js';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

/* ── 测试脚手架 ─────────────────────────────────────────────── */

/** TreeUI 私有成员测试通道（只读渲染 + 直接喂事件） */
interface UIInternals {
  handleEvent(e: unknown): void;
  onSubmit(text: string, mode: 'enter' | 'alt-enter'): void;
  root: { render(w: number): string[] };
  chat: { render(w: number): string[] };
  stopTurnClock(): void;
  liveBox: unknown;
  liveTimer: ReturnType<typeof setTimeout> | null;
}

const fakeRuntime = {
  currentModel: 'test-model',
  currentBaseUrl: 'https://example.com/v1',
  currentProvider: 'test',
  registerSelect: () => {},
  registerMultiSelect: () => {},
  registerReadLine: () => {},
  subscribe: () => {},
  prompt: async () => '',
} as unknown as Runtime;

const info: TreeUIInfo = {
  model: 'test-model',
  baseUrl: 'https://example.com/v1',
  sessionMsgs: 0,
  toolCount: 3,
  cmdCount: 9,
  skillCount: 1,
};

function setCols(n: number): void {
  Object.defineProperty(process.stdout, 'columns', { value: n, configurable: true });
}

/** 建一个不写终端的 TreeUI（screen 换成哑对象，console.log 保持可用） */
function makeUI(): { ui: TreeUI; it: UIInternals; cols: number } {
  const ui = new TreeUI(fakeRuntime, info);
  const it = ui as unknown as UIInternals;
  (ui as unknown as { screen: unknown }).screen = {
    render: () => {},
    clear: () => {},
    getLineCount: () => 0,
  };
  return { ui, it, cols: process.stdout.columns ?? 80 };
}

/** 收尾：停表 + 清节流定时器（否则 interval 会把进程挂住） */
function teardown(it: UIInternals): void {
  it.stopTurnClock();
  if (it.liveTimer) clearTimeout(it.liveTimer);
}

/** 去掉 ANSI 颜色码，便于文本断言 */
function plain(lines: string[]): string[] {
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

/** 含未配对代理项（emoji 被劈开的痕迹，屏幕上会变乱码方块） */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** 消息区当前渲染行（纯文本） */
function chatLines(it: UIInternals): string[] {
  return plain(it.chat.render(process.stdout.columns ?? 80));
}

/* ── ① 框宽随终端自适应 ─────────────────────────────────────── */

console.log('── ① 框宽自适应（原固定 50 列 → 50~110 夹逼） ──');
{
  setCols(80);
  const { it } = makeUI();
  it.handleEvent({ type: 'stream_text', text: '你好' });
  const ls = chatLines(it);
  const top = ls.find((l) => l.includes('┌')) ?? '';
  ok('80 列终端：框总宽 = 76（占满留白后的可用宽度）', visibleWidth(top) === 76);
  ok('80 列终端：顶边框含 FLINT 标签', top.includes('FLINT'));
  teardown(it);
}
{
  setCols(200);
  const { it } = makeUI();
  it.handleEvent({ type: 'stream_text', text: '你好' });
  const top = chatLines(it).find((l) => l.includes('┌')) ?? '';
  ok('超宽终端：封顶 110 列（行长过长反而难读）', visibleWidth(top) === 110);
  teardown(it);
}
{
  setCols(40);
  const { it } = makeUI();
  it.handleEvent({ type: 'stream_text', text: '你好' });
  const ls = chatLines(it);
  const widest = Math.max(...ls.map((l) => visibleWidth(l)));
  ok('极窄终端：任何行都不超出可见列（不撑破屏幕）', widest <= 40);
  teardown(it);
}
{
  setCols(80);
  const { it } = makeUI();
  // 300 字中文长回复：折行后每行都该把框内宽度用足
  it.handleEvent({ type: 'stream_text', text: '这'.repeat(300) });
  it.handleEvent({ type: 'agent_end' });
  const ls = chatLines(it);
  const content = ls.filter((l) => l.startsWith('    ') && l.includes('这'));
  const maxContent = Math.max(...content.map((l) => visibleWidth(l)));
  ok('长回复折行后单行可见宽度 > 60 列（旧上限仅 49，确实扩建了）', maxContent > 60);
  ok('长回复每行都在框内（不超框总宽 76）', content.every((l) => visibleWidth(l) <= 76));
  ok('长回复折成多行（未截断丢字）', content.length > 4);
  ok('折行后总字数守恒（300 字一字不丢）', content.join('').replace(/\s/g, '').length === 300);
  teardown(it);
}
{
  setCols(80);
  const { it } = makeUI();
  const all = plain(it.root.render(80));
  const rules = all.filter((l) => /^ {2}─+$/.test(l));
  ok('header 分隔线与框同宽（总可见宽 = 76）', rules.length >= 2 && rules.every((l) => visibleWidth(l) === 76));
  const hints = all.filter((l) => /\/(?:help|exit|clear|model|edit_model|usage|history|sessions|diagnostics)/.test(l));
  ok('header 命令提示折成多行（旧实现拼成单行共 110 列）', hints.length >= 2);
  ok('header 命令提示每行不超框内宽', hints.every((l) => visibleWidth(l) <= 76));
  ok('header 尾部命令 /sessions /diagnostics 可见（旧实现被 fitWidth 静默截掉）',
    hints.some((l) => l.includes('/sessions')) && hints.some((l) => l.includes('/diagnostics')));
  ok('header 命令提示在分隔符处断行（每行以完整命令名收尾）',
    hints.every((l) => /\/(?:help|exit|clear|model|edit_model|usage|history|sessions|diagnostics)$/.test(l.trimEnd())));
  teardown(it);
}

/* ── ② 等待期指示器：从 Enter 到首字全程不黑屏 ───────────────── */

console.log('── ② 等待期指示器（按下 Enter 即点亮） ──');
{
  setCols(80);
  const { it } = makeUI();
  it.onSubmit('一个复杂问题', 'enter');
  const ls = plain(it.root.render(80));
  const hint = ls.find((l) => l.includes('已发送')) ?? '';
  ok('提交瞬间状态行即出现（不等 thinking 事件）', hint.length > 0);
  ok('状态行含旋转帧动画', /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(hint));
  ok('状态行含计时秒数', /\d+ 秒/.test(hint));
  ok('用户消息框已入消息区', chatLines(it).some((l) => l.includes('YOU')));
  teardown(it);
}
{
  setCols(80);
  const { it } = makeUI();
  it.handleEvent({ type: 'thinking', phase: 'streaming' });
  const hint = plain(it.root.render(80)).find((l) => l.includes('等待模型响应')) ?? '';
  ok('thinking(streaming) → 显示"等待模型响应"', hint.length > 0);
  ok('等待期同时给出安抚文案', /正在/.test(hint));
  teardown(it);
}
{
  setCols(80);
  const { it } = makeUI();
  it.handleEvent({ type: 'stream_reasoning', text: '推理片段' });
  const hint = plain(it.root.render(80)).find((l) => l.includes('推理中')) ?? '';
  ok('stream_reasoning → 标签升级为"推理中"', hint.length > 0);
  teardown(it);
}

/* ── ③ 流式期：开口底边常驻"正在输出"，结束才换成 └──┘ ────────── */

console.log('── ③ 流式期"还在输出"底边（用户诉求 3） ──');
{
  setCols(80);
  const { it } = makeUI();
  it.handleEvent({ type: 'stream_text', text: '第一段' });
  let ls = chatLines(it);
  ok('首字到达：顶边框立刻出现（不等全部回复）', ls.some((l) => l.includes('┌') && l.includes('FLINT')));
  const foot = ls[ls.length - 1] ?? '';
  ok('流式中：框的最后一行是"正在输出"开口底边', foot.includes('正在输出'));
  ok('流式中：底边带已收字数（进度可量化）', /已收 \d+ 字/.test(foot));
  ok('底边字数与实际收到的字数一致（不等 250ms 动画跳）', /已收 3 字/.test(foot));
  ok('流式中：底边带计时秒数', /\d+ 秒/.test(foot));
  ok('流式中：框尚未封口（没有 └──┘）', !ls.some((l) => l.includes('└')));
  const topBefore = ls.find((l) => l.includes('┌')) ?? '';
  const bodyBefore = ls.filter((l) => l.includes('第一段')).join('');

  it.handleEvent({ type: 'stream_text', text: '第二段' });
  const ls2 = chatLines(it);
  ok('底边字数随 token 实时跟进（3+3=6 字）', /已收 6 字/.test(ls2[ls2.length - 1] ?? ''));
  it.handleEvent({ type: 'agent_end' });
  ls = chatLines(it);
  ok('结束后：开口底边消失', !ls.some((l) => l.includes('正在输出')));
  ok('结束后：底边框 └──┘ 出现', ls.some((l) => l.includes('└')));
  const topAfter = ls.find((l) => l.includes('┌')) ?? '';
  ok('就地封口：顶边框字符串前后完全一致（无整框重建跳变）', topBefore === topAfter);
  ok('就地封口：正文一字未丢', ls.filter((l) => l.includes('第一段') || l.includes('第二段')).join('').includes('第一段')
    && chatLines(it).some((l) => l.includes('第二段'))
    && bodyBefore.length > 0);
  const hintAfter = plain(it.root.render(80)).filter((l) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l));
  ok('结束后：动画定时器已停（无残留旋转帧，防定时器泄漏）', hintAfter.length === 0);
  ok('结束后：liveBox 已释放', it.liveBox === null);
  teardown(it);
}
{
  setCols(80);
  const { it } = makeUI();
  it.handleEvent({ type: 'stream_text', text: '正文' });
  const hintDuringStream = plain(it.root.render(80)).filter((l) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l));
  ok('流式中只有一个指示器（在框底边，底部状态行不重复转）', hintDuringStream.length === 1);
  teardown(it);
}
{
  setCols(80);
  const { it } = makeUI();
  it.handleEvent({ type: 'stream_reasoning', text: 'abc' });
  it.handleEvent({ type: 'stream_text', text: '答案' });
  it.handleEvent({ type: 'agent_end' });
  const ls = chatLines(it);
  const summaries = ls.filter((l) => l.includes('💭'));
  ok('有推理时框内出现💭摘要', summaries.length === 1);
  ok('💭摘要只一行（封口不重复挂）', summaries[0].includes('思考了 3 字'));
  ok('💭摘要位于正文之前（先思考后回答的阅读顺序）',
    ls.findIndex((l) => l.includes('💭')) < ls.findIndex((l) => l.includes('答案')));
  teardown(it);
}
{
  setCols(80);
  const { it } = makeUI();
  it.handleEvent({ type: 'usage', current: { totalTokens: 120 }, total: { totalTokens: 900 } });
  it.handleEvent({ type: 'stream_text', text: '答案' });
  it.handleEvent({ type: 'agent_end' });
  const ls = chatLines(it);
  ok('usage 行挂在底边框之后', ls.findIndex((l) => l.includes('tokens')) > ls.findIndex((l) => l.includes('└')));
  teardown(it);
}

/* ── ④ 工具轮：堵住两个历史黑屏窗口 ─────────────────────────── */

console.log('── ④ 工具轮不黑屏（用户诉求 2 后半） ──');
{
  setCols(80);
  const { it } = makeUI();
  it.handleEvent({ type: 'stream_text', text: '先说一句' });
  it.handleEvent({ type: 'tool_execution_start', name: 'read_file', args: { path: 'a.ts' } });
  let ls = chatLines(it);
  ok('工具开始：上一个流式框已封口（不留孤儿开口框）', ls.some((l) => l.includes('└')));
  ok('工具开始：开口底边已撤（不再谎报"正在输出"）', !ls.some((l) => l.includes('正在输出')));
  let hint = plain(it.root.render(80)).find((l) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l)) ?? '';
  ok('工具执行期：状态行点亮并说明在执行哪个工具', hint.includes('执行 read_file 中'));

  it.handleEvent({ type: 'tool_execution_end', name: 'read_file', result: '✅ 读取成功', ok: true });
  hint = plain(it.root.render(80)).find((l) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l)) ?? '';
  ok('工具结束后：状态行提示"等待模型响应"（过去这段完全黑屏）', hint.includes('等待模型响应'));

  ls = chatLines(it);
  const toolTop = ls.find((l) => l.includes('┌') && l.includes('READ_FILE')) ?? '';
  const toolBottom = ls[ls.length - 1] ?? '';
  ok('工具框顶边与底边同宽', visibleWidth(toolTop) === visibleWidth(toolBottom) && visibleWidth(toolTop) === 76);

  it.handleEvent({ type: 'stream_text', text: '工具之后的回答' });
  it.handleEvent({ type: 'agent_end' });
  ls = chatLines(it);
  ok('工具后另起新框承接新正文', ls.filter((l) => l.includes('┌') && l.includes('FLINT')).length === 2);
  ok('工具后新框正常封口', ls.filter((l) => l.includes('└')).length >= 3);
  teardown(it);
}
{
  setCols(80);
  const { it } = makeUI();
  // steering / followUp 插入新回合：thinking 到达时若框还开着，必须先封口
  it.handleEvent({ type: 'stream_text', text: '上一回合的回答' });
  it.handleEvent({ type: 'thinking', phase: 'analyzing' });
  const ls = chatLines(it);
  ok('新回合 thinking 到达：旧框就地封口', ls.some((l) => l.includes('└')));
  ok('新回合 thinking 到达：不再显示"正在输出"（实际在重新思考）', !ls.some((l) => l.includes('正在输出')));
  ok('新回合 thinking 到达：状态行接管显示"分析中"',
    (plain(it.root.render(80)).find((l) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l)) ?? '').includes('分析中'));
  teardown(it);
}

/* ── ⑤ 边界：无正文 / 命令输出 ─────────────────────────────── */

console.log('── ⑤ 边界场景 ──');
{
  setCols(80);
  const { it } = makeUI();
  it.handleEvent({ type: 'thinking', phase: 'analyzing' });
  it.handleEvent({ type: 'agent_end' });
  ok('无正文的回合：不留空框', chatLines(it).filter((l) => l.includes('┌')).length === 0);
  ok('无正文的回合：状态行已清', plain(it.root.render(80)).filter((l) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l)).length === 0);
  teardown(it);
}
{
  setCols(80);
  const { it } = makeUI();
  // 斜杠命令路径：runtime 直接发 stream_text + agent_end，不发 thinking
  it.handleEvent({ type: 'stream_text', text: '/help 的输出' });
  it.handleEvent({ type: 'agent_end' });
  const ls = chatLines(it);
  ok('命令输出也走完整框（顶边 + 正文 + 底边）',
    ls.some((l) => l.includes('┌')) && ls.some((l) => l.includes('/help 的输出')) && ls.some((l) => l.includes('└')));
  teardown(it);
}

/* ── ⑥ 宽度测量：制表画框按 1 列 / emoji 代理对不劈开 ─────────────── */

console.log('── ⑥ 宽度测量（旧规则把 ─┌┐ 当全角 → 边框被截断） ──');
{
  ok('制表画框按 1 列（旧规则算 2 列，76 字边框被测成 140 列）', visibleWidth('─'.repeat(10)) === 10);
  ok('箭头 ↑↓ 按 1 列（快捷键提示不被截短）', visibleWidth('↑↓ 移动') === 7);
  ok('旋转帧 ⠋⠙⠹ 按 1 列', visibleWidth('⠋⠙⠹') === 3);
  ok('汉字仍按 2 列', visibleWidth('你好') === 4);
  ok('emoji 仍按 2 列（不是代理对拆开的 4 列）', visibleWidth('✅') === 2 && visibleWidth('⏳') === 2);
}
{
  setCols(80);
  const { it } = makeUI();
  it.handleEvent({ type: 'stream_text', text: '你好' });
  it.handleEvent({ type: 'agent_end' });
  const ls = chatLines(it);
  const top = ls.find((l) => l.includes('┌')) ?? '';
  const bottom = ls.find((l) => l.includes('└')) ?? '';
  ok('80 列终端：顶边框以 ┐ 收尾（未被 fitWidth 截掉右半截）', top.endsWith('┐'));
  ok('80 列终端：底边框以 ┘ 收尾', bottom.endsWith('┘'));
  ok('上下边框等宽（框是方的）', visibleWidth(top) === visibleWidth(bottom));
  teardown(it);
}
{
  setCols(80);
  const { it } = makeUI();
  // 60 个 emoji × 2 列 = 120 列 > 框内宽 71 → 必定折行，而旧实现的折行点正好在代理对中间
  it.handleEvent({ type: 'stream_text', text: '✅'.repeat(60) });
  it.handleEvent({ type: 'agent_end' });
  const ls = chatLines(it);
  ok('emoji 长文本折成多行', ls.filter((l) => l.includes('✅')).length > 1);
  ok('折行后无半截代理对（不会渲染成乱码方块）', ls.every((l) => !hasLoneSurrogate(l)));
  ok('emoji 一个不丢（60 个）', ls.join('').split('✅').length - 1 === 60);
  ok('折行行未超框宽', ls.filter((l) => l.includes('✅')).every((l) => visibleWidth(l) <= 76));
  teardown(it);
}
{
  // wrapText 单元粒度：折行不劈代理对、宽度按 2 列算
  const wrapped = wrapText('✅'.repeat(40), 20);
  ok('wrapText：每行不超指定宽', wrapped.every((l) => visibleWidth(l) <= 20));
  ok('wrapText：无半截代理对', wrapped.every((l) => !hasLoneSurrogate(l)));
  ok('wrapText：emoji 总数守恒', wrapped.join('').split('✅').length - 1 === 40);
}

/* ── ⑦ 骨架 span 事件上屏：实测账 + 工具成败不再子串猜测 ─────── */

console.log('── ⑦ 骨架 span 上屏（耗时/首字延迟由生产端实测，UI 不再自己掐表估） ──');
{
  setCols(80);
  const { it } = makeUI();
  it.handleEvent({ type: 'prompt_start', spanId: 's1', input: '你好' });
  it.handleEvent({ type: 'stream_text', text: '回答' });
  it.handleEvent({
    type: 'llm_request_end', spanId: 's2', status: 'ok', durationMs: 2841,
    firstTokenMs: 613, textLength: 2, toolCallCount: 0, usage: null,
  });
  it.handleEvent({ type: 'prompt_end', spanId: 's1', status: 'ok', durationMs: 8412, reply: '回答', turns: 1 });
  it.handleEvent({ type: 'agent_end' });
  const ls = chatLines(it);
  ok('全程耗时取自 prompt_end（实测值，不是 UI 估算值）', ls.some((l) => l.includes('全程 8.4s')));
  ok('模型往返次数与耗时由 llm_request_end 累计而来', ls.some((l) => l.includes('模型 1 次/2.8s')));
  ok('首字延迟（TTFT）上屏——这个数只有生产端量得到', ls.some((l) => l.includes('首字 0.6s')));
  ok('实测账与 usage 行同时挂在框底下方', ls.some((l) => l.includes('⏱')));
  teardown(it);
}
{
  setCols(80);
  const { it } = makeUI();
  // 工具成败改由 ok 字段判定：结果文本里正常出现"失败"二字不再被误判成红框
  it.handleEvent({ type: 'tool_execution_start', name: 'grep', args: { pattern: 'x' } });
  it.handleEvent({ type: 'tool_execution_end', name: 'grep', result: '未找到匹配（失败重试次数 0）', ok: true });
  const raw = it.chat.render(80);
  const line = raw.find((l) => l.includes('未找到匹配')) ?? '';
  ok('ok=true 且文本含"失败"：按成功着绿（旧的子串猜测会误判红）',
    line.includes('\x1b[32m') && !line.includes('\x1b[31m'));

  it.handleEvent({ type: 'tool_execution_start', name: 'grep', args: { pattern: 'y' } });
  it.handleEvent({ type: 'tool_execution_end', name: 'grep', result: '[OK] 已处理', ok: false });
  const line2 = (it.chat.render(80)).find((l) => l.includes('[OK] 已处理')) ?? '';
  ok('ok=false 且文本含 [OK]：按失败着红（旧的子串猜测会误判绿）',
    line2.includes('\x1b[31m') && !line2.includes('\x1b[32m'));
  teardown(it);
}

setCols(80);
console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
