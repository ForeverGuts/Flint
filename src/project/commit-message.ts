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
 * 输入只有一样、且是**结构性**的东西：`git diff --cached --numstat` 的纯文本 ——
 *   每行 `增\t删\t路径`，没有任何源码内容。规约正文（AGENTS.md / CLAUDE.md）**不再参与**
 *   （早先参与过，2026-09-28 删掉，理由见下）。
 * 我们**不读源码、不调任何语言模型**：靠路径特征（`.md` / `.test.ts` / `tsconfig.json` …）与
 * 行数统计反推，产出的是一条**草稿**，用户可在弹窗前/后改。
 * 这不是缺陷而是刻意的边界：读懂"这次到底改了什么业务逻辑"超出了 numstat 能给的信息，
 * 硬猜反而会比"让用户补一句"更糟。
 *
 * ── 格式为什么不再取规约（2026-09-28 用户拍板删掉 opt-out）──
 * 早先有一支"规约里写了'不要用 Conventional Commits'就退回纯中文一行式"。删掉它：
 *   ① 中文一行式把**类型**这个信息整段丢了 —— "改动 2 个文件"既看不出是加功能还是修 bug，
 *      机器也读不懂（自动汇总更新日志、自动定版本号全用不了）。拿一个明显更差的输出去
 *      "尊重"一条多半是随口写下的规矩，不划算。
 *   ② 真有项目要别的格式（Jira 编号、gitmoji …），正解是**调用方显式给 message**，
 *      不是让本模块去解析模板 —— 那等于引入一套没人拍过板的语法。
 * 于是格式固定为 **Conventional Commits**（`type(scope): subject`），规约正文不再参与。
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

/** 生成消息的入参（files 来自 numstat 解析；格式固定 Conventional Commits，没有其它开关） */
export interface CommitMessageOptions {
  files: DiffFile[];
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
   拼装：subject + body
   ───────────────────────────────────────────────────────────────────────────── */

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * 单行主题：`type(scope): 描述`。单文件用文件名，多文件用"改动 N 个文件"
 * （数字来自程序汇总，不随 locale 变）。
 *
 * scope 放在括号里是安全的，**前提是冒号前第一个词是类型词**。2026-09-28 实测踩过反面：
 * 早先的中文一行式没有类型词，scope 就被顶到了冒号前（`git: 改动 2 个文件`），而 `git`
 * 只是个**目录名**，读者会当成提交类型 —— 比不加还误导。所以：scope 要么跟在类型词后面，
 * 要么整个不带，绝不单独占用冒号前面的位置。
 */
function buildSubject(
  type: CommitType, scope: string | null, files: DiffFile[], summary: FileSummary,
): string {
  const what = files.length === 1
    ? `更新 ${basename(files[0]!.path)}`
    : `改动 ${summary.files} 个文件`;
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
  const summary = summarizeFiles(files);
  const type = classifyChangeType(files);
  const scope = inferScope(files);
  const subject = buildSubject(type, scope, files, summary);
  const body = buildBody(files, summary);
  return `${subject}\n\n${body}`;
}
