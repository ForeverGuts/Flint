/**
 * InputHandler 粘贴/按键解析专项验证（问题 2 修复回归）。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-input.ts
 *
 * 背景：旧实现把"任何含 \r\n 的 chunk"整块当作 Enter 提交且丢弃块内文本，
 * 多行粘贴（复杂问题）被静默吞掉——没提交、没回复、没反馈。
 * 新实现：括号粘贴（mode 2004）状态机 + 逐段解析（文本永不丢弃）。
 */
import { InputHandler } from '../src/io/ui/input-handler.js';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

interface Harness {
  ih: InputHandler;
  feed: (s: string) => void;
  submits: Array<{ text: string; mode: string }>;
  escapes: string[];
  buffer: () => string;
}

function scenario(): Harness {
  const ih = new InputHandler();
  const submits: Array<{ text: string; mode: string }> = [];
  const escapes: string[] = [];
  ih.onSubmit = (text, mode) => submits.push({ text, mode });
  ih.onEscapeSequence = (seq) => escapes.push(seq);
  // 不经 start()（无 TTY），直接喂 handleData（private，测试通道）
  const feed = (s: string) => (ih as unknown as { handleData(c: Buffer): void }).handleData(Buffer.from(s, 'utf-8'));
  const buffer = () => ih.getText();
  return { ih, feed, submits, escapes, buffer };
}

console.log('── 基础输入（逐字/整段/提交） ──');
{
  const h = scenario();
  h.feed('你'); h.feed('好');
  ok('逐字追加不打断', h.buffer() === '你好');
  h.feed('\r');
  ok('单独 Enter 提交既有 buffer', h.submits.length === 1 && h.submits[0].text === '你好' && h.submits[0].mode === 'enter');
  ok('提交后 buffer 清空', h.buffer() === '');
}
{
  const h = scenario();
  h.feed('hello');
  ok('整段 chunk 直连不加空格', h.buffer() === 'hello');
}
{
  const h = scenario();
  h.feed('text\r');
  ok('文本+Enter 同 chunk：文本先入 buffer 再提交（旧实现丢文本）', h.submits.length === 1 && h.submits[0].text === 'text');
}
{
  const h = scenario();
  h.feed('\r');
  ok('空 buffer 的 Enter 完全 no-op', h.submits.length === 0);
}

console.log('── 多行粘贴（无 bracketed 支持的降级路径） ──');
{
  const h = scenario();
  h.feed('l1\r\nl2\r\n');
  ok('多行合并为一条消息提交一次（旧实现整块丢弃）', h.submits.length === 1 && h.submits[0].text === 'l1 l2');
}
{
  const h = scenario();
  h.feed('l1\r\nl2');
  ok('无尾换行的多行内容：合并不自动提交', h.submits.length === 0 && h.buffer() === 'l1 l2');
}
{
  // 用户现场：多行中文复杂问题整块粘贴
  const h = scenario();
  h.feed('4】一间囚房里关押着两个犯人，该怎么办呢？\r\n答：心理问题，不是逻辑问题\r\n');
  ok('用户场景：多行中文粘贴不丢字、提交一次', h.submits.length === 1 && h.submits[0].text.includes('4】一间囚房') && h.submits[0].text.includes('答：心理问题'));
}

console.log('── 括号粘贴（bracketed paste，mode 2004） ──');
{
  const h = scenario();
  h.feed('\x1b[200~line1\r\nline2\x1b[201~');
  ok('整块 bracketed 粘贴：入 buffer 不自动提交', h.submits.length === 0 && h.buffer() === 'line1 line2');
  h.feed('\r');
  ok('粘贴后 Enter 明确提交', h.submits.length === 1 && h.submits[0].text === 'line1 line2');
}
{
  const h = scenario();
  h.feed('\x1b[200~par');
  h.feed('tial\x1b[201~');
  ok('跨 chunk 粘贴累积', h.submits.length === 0 && h.buffer() === 'partial');
}
{
  const h = scenario();
  h.feed('\x1b[200~abc\x1b[201~\r');
  ok('粘贴+Enter 同 chunk：提交一次', h.submits.length === 1 && h.submits[0].text === 'abc');
}
{
  const h = scenario();
  h.feed('前缀');
  h.feed('\x1b[200~内容\x1b[201~');
  ok('已输入文本与粘贴内容以空格衔接', h.buffer() === '前缀 内容');
}

console.log('── 转义序列 / 焦点事件 / 组合键 ──');
{
  const h = scenario();
  h.feed('\x1b[I'); h.feed('\x1b[O');
  ok('焦点事件静默丢弃（不入 buffer、不当序列外发）', h.buffer() === '' && h.escapes.length === 0);
}
{
  const h = scenario();
  h.feed('\x1b[A');
  ok('方向键交给 onEscapeSequence', h.escapes.length === 1 && h.escapes[0] === '\x1b[A' && h.buffer() === '');
}
{
  const h = scenario();
  h.feed('\x1b[Ahello');
  ok('序列后随文本：只消费序列，剩余继续解析（旧实现整 chunk 吞掉）', h.escapes[0] === '\x1b[A' && h.buffer() === 'hello');
}
{
  const h = scenario();
  h.feed('\x1b'); h.feed('x');
  ok('孤立 ESC 后接普通字符：丢 ESC 留字符', h.buffer() === 'x');
}
{
  const h = scenario();
  h.feed('\x1b'); h.feed('[A');
  ok('拆包方向键正常拼装', h.escapes.length === 1 && h.escapes[0] === '\x1b[A');
}
{
  const h = scenario();
  h.feed('q'); h.feed('\x1b\r');
  ok('Alt+Enter → followUp 模式提交', h.submits.length === 1 && h.submits[0].text === 'q' && h.submits[0].mode === 'alt-enter');
}
{
  const h = scenario();
  h.feed('abc'); h.feed('\x7f');
  ok('退格删一字符', h.buffer() === 'ab');
}
{
  const h = scenario();
  h.feed('ab\x7fc');
  ok('同 chunk 混合文本+退格+文本', h.buffer() === 'ac');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
