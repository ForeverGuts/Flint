/**
 * `.gitignore` 解析与匹配 —— 纯函数，**零 import**（与 `postcheck.ts` 同形：读盘在工具层）。
 *
 * 用途：`ls` / `grep` 的"噪音跳过表"原先是硬编码 `['.git','node_modules','dist']`，
 *       而项目自己的 `.gitignore` 里通常还列着 `build/`、`sessions/`、`*.log`……
 *       这些一律会进结果。本模块把 `.gitignore` 编译成跳过规则，由工具层**合并**进去
 *       （ROADMAP 10.7.3）：跳过表 = 内置默认 ∪ `.gitignore`。
 *
 * 四条界线（改之前先读，别"顺手补全"）：
 *
 *   ① **这是减噪，不是门禁。** 判错的代价只是"多显示 / 少显示一个条目"，与安全无关。
 *      同一判据见 `git/route.ts` 的"是路由不是闸"：**不完整无害**，所以下面刻意只做一个子集。
 *
 *   ② **认不出的模式一律丢弃，fail-safe 朝"不忽略"那一侧倒。**
 *      宁可多显示噪音，也不能把一条理解错的正则套上去——那会**藏掉用户本来看得见的文件**，
 *      而模型据此以为自己已经看全了目录。藏比漏危险得多：漏了它还能绕过 `read` 读回来，
 *      藏了它根本不知道那东西存在。这就是 `compilePattern` 宁可返回 null 的原因。
 *
 *   ③ **只读搜索根那一层的 `.gitignore`**，不递归读子目录的、也不向上找仓根。
 *      git 的完整语义会叠加各级 `.gitignore`，我们不做——差的方向是"少忽略"＝只多噪音，
 *      换来的是"规则相对谁"这件事**没有歧义**（所有相对路径都相对同一个搜索根）。
 *
 *   ④ **显式点名的路径从不套规则。** `ls build` / `grep x build/a.log` 照旧给结果：
 *      用户已经把路径说出来了，替他"贴心地"藏掉是帮倒忙。这条由调用方实现（本模块只答"该不该忽略"）。
 */
/* eslint-disable no-useless-escape */

/** 文件名。调用方与源码守护共用这个常量，别处不再写字面量 */
export const GITIGNORE_FILE = '.gitignore';

/** 文件体积上限：超过就不读（`.gitignore` 是用户资产，怪大文件不该拖慢每一次 ls/grep） */
export const GITIGNORE_MAX_BYTES = 256 * 1024;

/** 单行长度上限：超长视为异常输入，丢弃（不施加任何影响） */
export const GITIGNORE_LINE_MAX = 500;

/** 规则条数上限：病态 .gitignore 不该拖慢每一次 ls / grep */
export const GITIGNORE_RULE_MAX = 300;

export interface IgnoreRule {
  /** 编译后的完整匹配正则（自带 ^…$，非锚定模式下自带"任意深度"前缀） */
  re: RegExp;
  /** 目录专属：原模式以 / 结尾 —— 只命中目录，不命中同名文件 */
  dirOnly: boolean;
  /** 取反：原模式以 ! 开头 —— 命中则该路径**重新纳入** */
  negated: boolean;
  /** 原始行，调试与回执用 */
  source: string;
}

/** 正则元字符转义（`new RegExp` 由串构造，`/` 不必转但转了也无害，保持一处逻辑） */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * 去掉行尾空白；被反斜杠保住的空格是字面量，保留（连同反斜杠，由 compilePattern 处理转义）。
 * git 就是这个行为：`foo\ ` 匹配名字里真带尾空格的文件，而 `foo ` 等价于 `foo`。
 */
function stripTrailingBlanks(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
    if (end >= 2 && line[end - 2] === '\\') break;
    end--;
  }
  return line.slice(0, end);
}

/**
 * 读一个字符类 `[...]` —— start 指向 `[`。
 * git 的字符类里不含 `/`：遇到就说明这个 `[` 其实只是个字面左方括号。
 * 读不出来（没闭合、空内容）返回 null，调用方按字面量处理。
 */
function readCharClass(p: string, start: number): { text: string; next: number } | null {
  let j = start + 1;
  let neg = false;
  if (p[j] === '!' || p[j] === '^') { neg = true; j += 1; }
  let bodyText = '';
  let closed = false;
  while (j < p.length) {
    if (p[j] === ']') { closed = true; break; }
    if (p[j] === '/') return null;
    if (p[j] === '\\') {
      if (j + 1 < p.length) { bodyText += escapeRe(p[j + 1]); j += 2; continue; }
      bodyText += '\\\\'; j += 1; continue;
    }
    bodyText += escapeRe(p[j]);
    j += 1;
  }
  if (!closed || bodyText === '') return null;
  return { text: `[${neg ? '^' : ''}${bodyText}]`, next: j + 1 };
}

/**
 * 把一条 gitignore 模式编译成完整匹配正则。**认不出就返回 null，绝不猜。**
 *
 * 支持的子集：`#` 注释（由 parseGitignore 处理）/ `!` 取反 / 尾部 `/` 为目录专属 /
 * 首部 `/` 或中间含 `/` 为锚定 / `**` 独占一段时跨目录 / `*` `?` `[a-z]`（含 `[!…]`）/ `\x` 转义。
 */
function compilePattern(pat: string): RegExp | null {
  let anchored = false;
  let p = pat;

  // git 的锚定规则：**首部**有 / 或**中间**有 / → 相对 .gitignore 所在层；
  // 否则（如 `foo/`、`*.log`）在任意深度都可命中。
  // 注意尾部那个 / 已在 parseGitignore 摘掉（用于判 dirOnly），所以 `foo/` 不会因此被当成锚定——
  // 这正是"删除线""today/"这类规则能在深层目录生效的原因。
  if (p.startsWith('/')) { anchored = true; p = p.slice(1); }
  else if (p.includes('/')) anchored = true;
  if (p === '') return null;

  let body = '';
  let i = 0;
  while (i < p.length) {
    const prevIsSep = i === 0 || p[i - 1] === '/';
    // `**` 只有**独占一整段**（前是行首或 / 、后是行尾或 /）才作跨目录通配；
    // 其余连续星号 git 视为普通 `*`，我们也照办（`a**b` ≈ `a*b`）
    if (p.startsWith('**', i) && prevIsSep && (i + 2 >= p.length || p[i + 2] === '/')) {
      if (i + 2 >= p.length) {
        body += '.*';            // 结尾的 `a/**`：斜杠已写入 body，含义变成"里面的全部"
        i += 2;
      } else {
        body += '(?:.*/)?';      // `**/`：吃掉它后面那个 /，于是 `a/**/b` 也能命中 `a/b`
        i += 3;
      }
      continue;
    }
    const ch = p[i];
    if (ch === '*') { body += '[^/]*'; i += 1; continue; }
    if (ch === '?') { body += '[^/]'; i += 1; continue; }
    if (ch === '\\') {
      if (i + 1 < p.length) { body += escapeRe(p[i + 1]); i += 2; }
      else { body += '\\\\'; i += 1; }    // 行尾裸反斜杠：当字面量，不让它非法/
      continue;
    }
    if (ch === '[') {
      const cls = readCharClass(p, i);
      if (cls === null) { body += '\\['; i += 1; continue; }
      body += cls.text; i = cls.next; continue;
    }
    body += escapeRe(ch);
    i += 1;
  }

  const prefix = anchored ? '' : '(?:.*/)?';
  try {
    return new RegExp(`^${prefix}${body}$`);
  } catch {
    return null;      // 编译不过说明这次翻译用了它不认的语法 —— 丢弃，不做任何判断
  }
}

/**
 * 解析 `.gitignore` 全文为规则表。**认不出的行静默丢弃**（见文件头界线 ②）。
 * 空内容 / 全是注释 → 空数组，调用方行为与"没有这个功能时"逐字一致。
 */
export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split('\n')) {
    const line = stripTrailingBlanks(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
    if (line === '' || line.startsWith('#')) continue;
    if (line.length > GITIGNORE_LINE_MAX) continue;

    let rest = line;
    let negated = false;
    if (rest.startsWith('!')) { negated = true; rest = rest.slice(1); }
    else if (rest.startsWith('\\!') || rest.startsWith('\\#')) rest = rest.slice(1);   // 字面 ! / #
    if (rest === '') continue;

    let dirOnly = false;
    if (rest.endsWith('/')) { dirOnly = true; rest = rest.replace(/\/+$/, ''); }
    if (rest === '' || rest === '/') continue;         // `!` 后没东西 / 光一个 `/`：无意义
    rest = rest.replace(/^\/+/, '/');                  // `//a` 归一为 `/a`

    const re = compilePattern(rest);
    if (re === null) continue;
    rules.push({ re, dirOnly, negated, source: line });
    if (rules.length >= GITIGNORE_RULE_MAX) break;
  }
  return rules;
}

/**
 * 判一条**相对搜索根**的路径（用 `/` 分隔，如 `src/a/b.ts`）该不该被跳过。
 * 参数是完整相对路径，函数自己逐层上溯，**调用方不需要先判过祖先**。
 *
 * 两条规则都对齐 git：① **末次匹配胜出**——最后命中的那条说了算，所以 `!keep` 能救回
 * 被 `*.tmp` 排掉的同层文件；② **父目录被排除后里面全部排除**，深层的 `!` 救不回来。
 * 代价是判一次要跑「层数 × 规则数」次正则，真实 `.gitignore` 规模下可忽略不计。
 */
export function isIgnoredByGitignore(relPath: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  if (rules.length === 0) return false;
  // 防御：Windows 也可能塞进来 `\` 分隔的路径，夹掉两端多余的 /
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (rel === '') return false;

  // **一层一层往外 loop，而不是只判叶子。** 这是探针实测逼出来的：只判叶子时，
  // `build/` 规则下 `build/x.txt` 我们答"不忽略"，git 答"忽略"——因为 git 的语义是
  // **父目录被排除后里面全部排除，且深层取反救不回来**。想让这个函数对**任意路径**
  // 都答得对（而不是指望调用方小心翼翼地先判过祖先），就必须自己往上走。
  // 正好它也落地了"整棵子树不再往里看"这件事，两端不会分家。
  const segs = rel.split('/');
  let acc = '';
  for (let i = 0; i < segs.length; i++) {
    acc = i === 0 ? segs[i] : `${acc}/${segs[i]}`;
    // 中间层一定是目录；只有最后一层按实际类型判（影响 dirOnly 规则生不生效）
    const leafIsDir = i === segs.length - 1 ? isDir : true;
    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !leafIsDir) continue;
      if (!rule.re.test(acc)) continue;
      ignored = !rule.negated;
    }
    if (ignored) return true;      // 这一层被排除 → 里面全是，不再往里看
  }
  return false;
}
