/**
 * commit message 自动生成（ROADMAP 10.5.3）
 *
 * 调用方：`tools/builtin.ts` 的 `git_write` 工具（commit 且 message 留空时，基于已暂存的 diff 生成）。
 * 服务于：模型调 `git_write` 提交时，若没给 message，就**不再当场拒掉**，而是看一下"已经暂存了什么"，
 *         据此拼一条草稿消息 —— 让"提交"这一步不必每次都先想一句文案。
 *
 * ── 为什么值得单做一条 ──
 * 10.5.2 的 `git_write` 当初把"空 message"直接拒，理由是"本工具不开编辑器"。
 * 但"不开编辑器"不等于"必须让用户自己想文案"：暂存区里那串改动本身就是最好的线索。
 * 于是这里把"从 diff 反推 message"抽成一个纯模块，让 handler 在跑 commit 前先补一句。
 *
 * ── 这份模块只做"基于结构"的生成，不做"读懂内容" ──
 * 输入只有两样都是**结构性**的东西：
 *   ① `git diff --cached --numstat` 的纯文本 —— 每行 `增\t删\t路径`，没有任何源码内容；
 *   ② 规约文件的正文（可选）—— 只用来判断"要不要走 Conventional Commits"。
 * 我们**不读源码、不调任何语言模型**：靠路径特征（`.md` / `.test.ts` / `tsconfig.json` …）与
 * 行数统计反推，产出的是一条**草稿**，用户可在弹窗前/后改。
 * 这不是缺陷而是刻意的边界：读懂"这次到底改了什么业务逻辑"超出了 numstat 能给的信息，
 * 硬猜反而会比"让用户补一句"更糟。
 *
 * ── "格式取规约文件"具体指什么 ──
 * 默认走 **Conventional Commits**（`type(scope): subject`）。规约文件（AGENTS.md / CLAUDE.md）
 * 若写明了"不要用 Conventional Commits / 提交用中文"，本模块识别到就退回纯中文一行式
 * （`scope: 改动 N 个文件`）。除此之外**不解析任意模板**：规约里的格式写法千奇百怪，
 * 真去解析等于引入一套没人拍过板的语法，与本项目"判据只认结构性信号"的纪律相悖。
 *
 * ── 复用口径（不另搓一份）──
 * numstat 解析与汇总**直接调** `git.ts` 的 `parseNumstat` / `summarizeFiles` ——
 * `show` / `diff` 已经在用同一套，commit message 自然也该用同一套，否则"共 N 个文件 +X −Y"
 * 这种数字会两处各算、迟早分家（见 git.ts 头注里那次否决"抄 git 的英文摘要行"）。
 *
 * ── 纯函数、零运行时依赖 ──
 * 本文件只 import 同一仓库的纯类型与纯函数（git.ts 的解析/汇总 + DiffFile/FileSummary 类型），
 * **不碰 fs、不起进程、不读 rulesRegistry**（规约正文由调用方传进来 —— 这样本模块脱离
 * 模块级单例也能打靶，每条分支都能构造着验）。能落地的判据才写进代码，猜不到的就留白。
 */
import { parseNumstat, summarizeFiles, type DiffFile, type FileSummary } from '../git/git.js';

/** Conventional Commits 的类型集合（本模块会产出其中的子集） */
export type CommitType =
  | 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'perf'
  | 'test' | 'build' | 'ci' | 'chore' | 'revert';

/** 生成时所用的格式。默认 conventional；规约显式 opt-out 时退回纯中文 */
export interface CommitFormat {
  conventional: boolean;
}

/** 生成消息的入参（files 来自 numstat 解析；rulesText 来自 rulesRegistry，可空） */
export interface CommitMessageOptions {
  files: DiffFile[];
  /** 项目规约正文（AGENTS.md / CLAUDE.md）；没有就传 null/undefined → 走默认 Conventional */
  rulesText?: string | null;
}

/** numstat 文本 → 文件清单 + 汇总（薄封装，调用方拿到的就是 git.ts 那套口径） */
export function summarizeChanges(numstat: string): { files: DiffFile[]; summary: FileSummary } {
  const files = parseNumstat(numstat);
  return { files, summary: summarizeFiles(files) };
}

/* ─────────────────────────────────────────────────────────────────────────────
   分类：路径特征 → 变更类型（判据顺序是承重的）
   ───────────────────────────────────────────────────────────────────────────── */

const DOC_RE = /\.(md|markdown|rst|txt|adoc)$/i;
const TEST_RE = /(^|[/.])(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const STYLE_RE = /\.(css|scss|less|sass|styl)$/i;
const CONFIG_RE = /(^|\/)(config|hooks|scripts|migrations)\/|tsconfig|\.json$|\.ya?ml$|\.toml$|^Makefile$|^Dockerfile$|\.github\//i;

type Category = 'docs' | 'test' | 'style' | 'config' | 'code';

/** 单个路径归到哪一类。顺序无关（每个正则互斥性足够），只认后缀/目录特征 */
function categoryOf(path: string): Category {
  if (DOC_RE.test(path)) return 'docs';
  if (TEST_RE.test(path)) return 'test';
  if (STYLE_RE.test(path)) return 'style';
  if (CONFIG_RE.test(path)) return 'config';
  return 'code';
}

/**
 * 一组已暂存文件 → 变更类型。**纯路径判据**：
 * 全部同属一类才给那一类，否则（含任何源码改动）一律 `feat` 兜底。
 *
 * 为什么"混合就归 feat"而不是更细：从 numstat 我们只看得出路径，看不出"这是修 bug 还是加功能"，
 * 强行区分 fix/feat 是猜。约定"只要碰了源码就先给 feat 草稿"，用户改起来比改 'fix' 更省心
 * （把 feat 改成 fix 只是改一个词；反过来若我们猜了 fix、实际是 feat，用户要从"为什么是 fix"想起）。
 *
 * 空数组（无改动）→ `chore` 兜底，但调用方在生成前就会以"无已暂存改动"回绝，这里只是不抛的防线。
 */
export function classifyChangeType(files: DiffFile[]): CommitType {
  if (files.length === 0) return 'chore';
  const cats = files.map((f) => categoryOf(f.path));
  const all = (c: Category): boolean => cats.every((x) => x === c);
  if (all('docs')) return 'docs';
  if (all('test')) return 'test';
  if (all('style')) return 'style';
  if (all('config')) return 'chore';
  return 'feat';
}

/* ─────────────────────────────────────────────────────────────────────────────
   推断 scope：取所有文件目录的最长公共前缀，取最后一段（太泛的首段忽略）
   ───────────────────────────────────────────────────────────────────────────── */

/** 这些顶层目录没有区分度，不该当 scope（落在它们下面的那一段才有意义） */
const SCOPE_IGNORE = new Set(['src', 'lib', 'app', 'root', 'packages', 'internal']);

function commonPrefix(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/**
 * 推断 Conventional Commits 的 scope（如 `git` / `project` / `tests`）。
 *
 * 做法：取所有文件目录的最长公共前缀，再取它的最后一段。前缀退化到 `src` / 空串这类
 * 没有区分度的就返回 null（让标题变成 `feat: …` 而不是 `feat(src): …` —— 后者等于没说）。
 * 例：
 *   `src/git/a.ts` + `src/git/b.ts`         → `git`
 *   `src/a.ts` + `src/b.ts`                 → null（前缀只是 src）
 *   `src/project/rules.ts`（单文件）         → `project`
 *   `README.md` + `LICENSE`（根目录）        → null（无公共目录）
 *   `tests/foo.ts` + `tests/bar.ts`         → `tests`
 */
export function inferScope(files: DiffFile[]): string | null {
  if (files.length === 0) return null;
  const dirs = files.map((f) => {
    const i = f.path.lastIndexOf('/');
    return i < 0 ? '' : f.path.slice(0, i);
  });
  let prefix = dirs[0]!;
  for (let k = 1; k < dirs.length; k++) {
    prefix = commonPrefix(prefix, dirs[k]!);
    if (prefix === '') break;
  }
  if (prefix === '') return null;
  const segs = prefix.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (!last || SCOPE_IGNORE.has(last)) return null;
  return last;
}

/* ─────────────────────────────────────────────────────────────────────────────
   格式：默认 Conventional，规约可显式 opt-out
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * 规约正文里若出现"不要用 Conventional Commits / 提交用中文"这类信号，就退回纯中文一行式。
 * 只认这一条显式 opt-out —— 不解析任意模板（理由见文件头）。
 *
 * 形状：**否定词（不 / 别）→ 同一句内的任意字 → 关键字（conventional / 约定式提交）**。
 * 中间那一段刻意写成 `[^句读]*?`（惰性、且**不跨句**）而不是"否定助词的字符集"——
 * 中文否定助词连写起来是"不要用""不要使用"这种两三个字，用字符集只能吃掉其中一个，
 * 剩下一个就卡在后面（2026-09-27 实测踩到：把"要用"当成 `[要]*` 只吃掉"要"，"用"挡住
 * 后面的关键字，整条判据恒不成立）。跨句限制是为了不让上一段的"不要"去否定下一段的关键词。
 */
const CONV_OPT_OUT = /(?:不|别)[^。，、！？；：\n]*?(conventional|约定式提交)|commit\s*(消息|信息)\s*(用|采用)\s*(中文|自然语言|大白话)/i;

/** 从规约正文提取格式。没有正文 / 没命中 opt-out → 默认 Conventional Commits */
export function extractCommitFormat(rulesText: string | null): CommitFormat {
  if (rulesText && rulesText.trim() !== '' && CONV_OPT_OUT.test(rulesText)) {
    return { conventional: false };
  }
  return { conventional: true };
}

/* ─────────────────────────────────────────────────────────────────────────────
   拼装：subject + body
   ───────────────────────────────────────────────────────────────────────────── */

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** 单行主题：单文件用文件名，多文件用"改动 N 个文件"（数字来自程序汇总，不随 locale 变） */
function buildSubject(
  type: CommitType, scope: string | null, files: DiffFile[], summary: FileSummary, fmt: CommitFormat,
): string {
  const what = files.length === 1
    ? `更新 ${basename(files[0]!.path)}`
    : `改动 ${summary.files} 个文件`;
  if (!fmt.conventional) {
    return scope ? `${scope}: ${what}` : what;
  }
  const head = scope ? `${type}(${scope})` : type;
  return `${head}: ${what}`;
}

/** 正文：先给总账（+X −Y），再列改动文件（封顶 20 条，多了标"共 N 个"） */
function buildBody(files: DiffFile[], summary: FileSummary): string {
  const lines = [`+${summary.added} −${summary.deleted}：`];
  const cap = Math.min(files.length, 20);
  for (let i = 0; i < cap; i++) {
    const f = files[i]!;
    lines.push(f.binary ? `  ${f.path}（二进制）` : `  ${f.path} (+${f.added} −${f.deleted})`);
  }
  if (files.length > cap) lines.push(`  …（共 ${files.length} 个文件）`);
  return lines.join('\n');
}

/**
 * 生成 commit message。**只在这一步拼字符串**，前面全是结构化判据。
 * 无已暂存改动（files 为空）→ 返回 null（调用方据此回绝，而不是生成一条空消息）。
 * 返回的可能是多行字符串（`subject\n\nbody`），`git commit -m` 带换行是合法的。
 */
export function generateCommitMessage(opts: CommitMessageOptions): string | null {
  const files = opts.files ?? [];
  if (files.length === 0) return null;
  const fmt = extractCommitFormat(opts.rulesText ?? null);
  const summary = summarizeFiles(files);
  const type = classifyChangeType(files);
  const scope = inferScope(files);
  const subject = buildSubject(type, scope, files, summary, fmt);
  const body = buildBody(files, summary);
  return `${subject}\n\n${body}`;
}
