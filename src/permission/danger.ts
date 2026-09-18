/**
 * 危险命令拦截（ROADMAP 10.9.2）—— bash 命令串里的**灾难形态黑名单**。
 * 调用方：harness/main.ts 的 before_tool_call 核心钩子（排在契约闸**之后**、git 路由**之前**）。
 * 服务于：让"顺手写出来的一条命令把机器/项目毁掉"这件事，在**权限弹窗之前**就被程序拦下。
 *
 * ── 为什么必须有这道程序闸（弹窗不够吗）──
 * 弹窗两处够不着：
 *   ① **非 TTY / RPC 模式下权限是自动放行的**（登记在案的已知边界）——那里没有任何人在看；
 *   ② bash 的授权键是**完整命令串**，用户点过一次"本次全部允许"，同一条命令再来一次就不再弹。
 * 而"程序闸先于人闸、判据必须完备"这条纪律（见 charter.ts），在**不可逆**的命令上比在契约上更硬。
 *
 * ── 它和契约锁最大的不同：**没有 L2** ──
 * 契约锁有两层：L1 事前按字面文件名拦，L2 事后比对文件内容、变了就回滚（效果侧兜底）。
 * 本条**只能有 L1** —— 删除**不可逆**，事后没有任何东西可以比对、可以回滚。
 * 所以：L1 漏了就是漏了。这句不是免责声明，是选择判据时的**约束条件**——
 * 它决定了下面的判据必须"宁可少拦，不可误拦"：误拦的代价是可见的一句报错（用户改写一下就好），
 * 漏拦的代价是不可逆的数据丢失，而**误拦会让人把这道闸关掉**，那才是最坏的结局。
 *
 * ── 这是**护栏，不是沙箱** ──
 * 判据只看命令串的**字面形态**。变量拼装（`rm -rf $DIR`）、命令替换（`rm -rf $(pwd)`）、
 * 写进脚本里再由 `npm run` 触发、用别的语言重写一遍 —— 一律绕得过去。
 * 本模块**不声称**自己挡得住绕过；它挡的是"模型/用户顺手直接写出来"的那一类灾难形态。
 * 判据刻意窄，是为了让上面那条"宁可少拦"成立，不是为了假装完备。
 *
 * ── 三类灾难形态（共同特征：不可逆 + 在这个项目里几乎没有正当用法）──
 *   ① **删除整棵树** —— 递归/批量删除命令的目标命中"一棵树的根"：文件系统根 / 盘根 / UNC 共享根 /
 *      家目录本身 / 已知系统目录本身 / **当前工作目录本身或它的上级**。最后那一条是本项目最该挡的：
 *      `rm -rf ..` 把整个项目连未提交的改动一起删掉，是"手一抖"的典型形态。
 *   ② **写裸设备 / 格式化** —— `mkfs*` / `fdisk` / `parted` / `wipefs` / `diskpart` / `format C:` /
 *      `dd of=/dev/sd*` / `> /dev/sd*`。覆盖的是分区表或文件系统，不是文件。
 *   ③ **关机重启 / fork 炸弹** —— 打断用户机器上一切正在跑的东西。
 *
 * ── 判据的关键选择（三条，都有反例在套件里钉着）──
 *   · **位置判据**：命令词取**段首**（按 `&& || ; | & 换行` 切段），不是"出现在命令串里"。
 *     `git log --grep=reboot`、`grep shutdown src/` 里那些**是数据不是命令**，必须放过。
 *     （对照 `mentionsContract`：那边是"文件名出现在命令串里"，因为文件名不会当动词用；
 *      这边 `reboot` / `format` / `rm` 都会。）
 *   · **看目标，不看旗标**：目标是"一棵树的根"就拒，不管它带 `-r` 还是 `-f`。
 *     `rm -rf C:/Users/31075` 与 `rm C:/Users/31075` 一样是灾难（后者只是会失败），
 *     而"带没带 -r"需要解析旗标组合（`-force` 里也有个 r），多出来的判断只会多处出错。
 *   · **一层 shell 包装展开**：`bash -c "rm -rf /"` / `cmd /c "rd /s /q C:\"` / `powershell -Command …`
 *     会把真正的命令藏在一个字符串里。展开**一层**（展开后的串里若还有包装，不再展开）——
 *     只展开一层是刻意的：不递归就不会有收敛问题，而"转两层包装"已经不是顺手写出来的形态了。
 *
 * ── 刻意不做（都是**判不出来**，不是"忘了做"）──
 *   · **`rm -rf ~/Documents` 这类"家目录里的其他目录"** —— 它与 `rm -rf ~/tmp`（正当清理）在形状上
 *     完全一样，判不出来。那是"目标在工作区之外"，属 **10.9.3（工作区外写保护）** 的活，不是本条的。
 *   · **`rm -rf *`** —— 通配符的展开范围判不出来；`*` 本身不指向任何目录，硬猜会误伤
 *     （在临时目录里 `rm -rf *` 是常见正当写法）。注意带根的写法是拦的：`rm -rf /*` 命中（展开后是 `/`）。
 *   · **`curl … | sh`** —— 它不是不可逆操作（跑完才知道干了什么），而且在容器/CI 里是常见正当做法。
 *     真正该管的是它下载下来的东西，而那个本模块看不到。
 *   · **`git push --force` / `git reset --hard`** —— 是**常见且经常正当**的操作，一刀切拒会让工具
 *     没法用；且它们的损失通常能从 reflog / 远端找回，不属"不可逆"。写侧的确认闸是 **10.5.2** 的活。
 *   · **`chmod -R 000 /` 这类权限自毁**、**`kill -9 -1` 之类杀光进程** —— 判断题边界还没划清，先不猜。
 *
 * ── 已知代价（明确记下来，不装看不见）──
 *   · **`rm -rf /s` 会被拒**（判成 S 盘根）。这是 MSYS 展开的副作用：`/c` 必须认成 `C:/`（否则
 *     Git Bash 形式拖出来的路径全漏），而"认了字母就是盘符"就必然把单字母的根目录一起卷进来。
 *     代价落在"POSIX 命令 + 单字母目标"这一格，实际发生率极低；而 cmd 的 `/s` `/q` 这类旗标
 *     由 `isSlashFlag` 单独挡掉（`del /f /s /q dist` 放行 —— 套件 C45 钉着）。
 *     **要它还改不了**：这条不修，因为它与"认 MSYS"是同一枚硬币的两面。
 *
 * 零项目依赖：只 import 两个 node 内置模块（path / os）。判据是**纯函数**，cwd / home / 平台
 * 都从参数进来（注入而非直读），所以 verify-danger.ts 不需要真终端就能逐形状打靶。
 */
import path from 'node:path';
import os from 'node:os';
import type { HookDeny } from '../loop/tool-hooks.js';

/** 判据的注入上下文 —— 三个值都**注入而非直读**，套件才能造真目录、也才能两边方言都测 */
export interface DangerContext {
  /** 基准目录：它就是"项目"本身，递归删除它或它的上级 = 删掉整个项目 */
  cwd: string;
  /** 家目录（`~` / `$HOME` / `%USERPROFILE%` 的归宿） */
  home: string;
  /** 路径方言：只有 Windows 才把 `/c/Users/...`（MSYS 写法）认成 `C:/Users/...` */
  platform?: NodeJS.Platform;
}

/** 命中一条黑名单 */
export interface DangerHit {
  /** 类别名（进拒因标题） */
  kind: string;
  /** 具体命中（哪个目标 / 哪条命令） */
  detail: string;
  /** 为什么这条是不可逆的灾难（一句话） */
  why: string;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ① 词法层：切段 → 取命令词 → 展包装
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 按 shell 的**命令分隔符**切段：`&&` `||` `;` `|` `&` 与换行。
 * 刻意**不解析引号**：`echo "a; rm -rf /"` 会被切成两段、第二段被当成命令而误拦。
 * 要正确处理就得写一个 shell 词法分析器（引号、转义、`$()` 嵌套……），那是另一个量级；
 * 这里选的是**宁可偶尔多拦一条无害的 echo** —— 它可见、可改写，而漏拦是静默的。
 * （顺序承重：`&&` 必须排在 `&` 前面、`||` 必须排在 `|` 前面，否则会被切碎。）
 */
export function splitSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||;|\||&|[\r\n])+/);
}

/** 剥掉 token 首尾的引号（**不做**全局抹引号：`git commit -m "rm -rf /"` 里的那是数据） */
export function unquote(token: string): string {
  return token.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
}

/**
 * token → 命令词：剥引号 → 反斜杠转正斜杠 → 取基名（`/sbin/reboot` 与 `reboot` 同判）→
 * 去 Windows 可执行后缀 → 小写。
 * 按基名判的代价：恰好有个叫 `reboot` 的脚本会被误拦（`./reboot`）—— 可见、可改写，接受。
 */
export function commandWord(token: string): string {
  const t = unquote(token).replace(/\\/g, '/');
  const base = t.slice(t.lastIndexOf('/') + 1);
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** 会执行"另一个 shell 里的命令串"的包装器 + 它传参用的旗标（一层展开用） */
const WRAPPER_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'cmd', 'powershell', 'pwsh']);
const WRAPPER_FLAGS = new Set(['-c', '/c', '-command', '-cmd']);

/**
 * 展开一层 shell 包装：`bash -c "rm -rf /"` → `rm -rf /`。不是包装形态就返回 null。
 * 只取"旗标之后的所有 token 拼回去"—— 拼回去这件事对带空格的引号串是不精确的
 * （引号会被拆成独立 token 的碎片），但目标判据在拼回来的串上照样能工作：
 * `cmd /c "rd /s /q C:\"` → `"rd /s /q C:\"` → 段首命令词 `rd`、目标 `C:/`（引号在 token 级剥掉）。
 */
export function unwrapShell(command: string): string | null {
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    const word = tokens[0] === undefined ? '' : commandWord(tokens[0]);
    if (!WRAPPER_SHELLS.has(word)) continue;
    const flagAt = tokens.findIndex((t, i) => i > 0 && WRAPPER_FLAGS.has(t.toLowerCase()));
    if (flagAt < 0) continue;
    const inner = tokens.slice(flagAt + 1).join(' ').trim();
    if (inner !== '') return inner;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ② 目标层：把一段 token 归一成"它指向哪棵树"
   ═══════════════════════════════════════════════════════════════════════════════ */

/** 已知的系统目录（**按盘符剥掉后的路径**比对，故 Windows 与 POSIX 共用一张表） */
export const SYSTEM_DIRS: readonly string[] = [
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys',
  '/var', '/opt', '/home', '/root', '/users',
  '/windows', '/program files', '/program files (x86)', '/programdata', '/system', '/library',
  '/applications',
];

function tokenize(segment: string): string[] {
  const s = segment.trim().replace(/^\(+/, '').replace(/\)+$/, '').trim();
  return s === '' ? [] : s.split(/\s+/);
}

/**
 * 目标 token → 绝对路径；**判不出来返回 null**（fail-open）。
 * 归一化顺序：
 *   · 剥成对/半对的引号（`"C:/"`、`cmd /c` 展开后残留的 `C:\"`）
 *   · 反斜杠转正斜杠（Windows 写法）
 *   · 结尾的 `*` 截断 —— `/*` 就是 `/`，`C:/*` 就是 `C:/`（`rm -rf *` 因为展开后为空而放过）
 *   · `~` / `$HOME` / `%USERPROFILE%` → home（**只认这三种确定的写法**，其余带 `$` `%` 的一律判不出来）
 *   · Windows 下把 MSYS 的 `/c/Users/...` 认成 `C:/Users/...`
 *     （与 `@file`/`read` 的口径**故意相反**：那边不认 MSYS 是因为认错会报错，
 *       这边认错的代价是"多拦一条"，方向正好相反 —— 判据的容错方向由**误判的后果**决定。）
 */
export function expandTarget(raw: string, ctx: DangerContext): string | null {
  // 反引号 = 命令替换：它的值是**跑出来的**，判不出来，绝不能当字面目录名（那等于假装判得出来）。
  // 这一步必须在剥引号**之前** —— `unquote` 会把反引号一起当引号剥掉，剥完就再也认不出它是替换了。
  if (raw.includes('`')) return null;
  let s = unquote(raw).replace(/\\/g, '/');
  if (s === '') return null;
  const star = s.indexOf('*');
  if (star >= 0) s = s.slice(0, star);
  if (s === '') return null;
  const home = ctx.home.replace(/\\/g, '/').replace(/\/+$/, '');
  const lower = s.toLowerCase();
  // ⚠ 三种写法的**切片长度各不相同**（`~` 是 1、`$HOME` 是 5、`%USERPROFILE%` 是 14）：
  //   当初照着 `~` 那支抄 `slice(1)`，`$HOME/x` 就被拼成了「家目录 + HOME/x」——
  //   单看代码像是对的，是套件的 B4 逐字比路径才照出来的。
  if (s === '~' || lower === '$home') s = home;
  else if (s.startsWith('~/')) s = home + s.slice(1);
  else if (lower.startsWith('$home/')) s = home + s.slice('$home'.length);
  else if (lower === '%userprofile%') s = home;
  else if (lower.startsWith('%userprofile%/')) s = home + s.slice('%userprofile%'.length);
  else if (/[$%]/.test(s)) return null;          // 其余变量写法：判不出来，放行
  if (ctx.platform === 'win32') {
    const msys = /^\/([a-z])(\/.*)?$/i.exec(s);
    if (msys) s = `${msys[1]!.toUpperCase()}:${msys[2] ?? '/'}`;
  }
  return path.resolve(ctx.cwd, s);
}

/** 是不是"文件系统/盘的根"：`/`、`C:/`、`C:`、UNC 共享根 `\\server\share\` */
export function isFilesystemRoot(p: string): boolean {
  const s = p.replace(/\\/g, '/');
  if (s === '/') return true;
  if (/^[a-z]:\/?$/i.test(s)) return true;
  return /^\/\/[^/]+\/[^/]+\/?$/.test(s);
}

/** `anc` 是不是 `child` 本身或它的上级（两边都先 resolve；Windows 大小写由 path.relative 处理） */
export function isSelfOrAncestor(anc: string, child: string): boolean {
  if (anc === '' || child === '') return false;
  const a = path.resolve(anc);
  const b = path.resolve(child);
  if (a === b) return true;
  const rel = path.relative(a, b);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 盘符剥掉后的路径（系统目录表按这个比对） */
function withoutDrive(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase().replace(/^[a-z]:/, '');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ③ 三类黑名单
   ═══════════════════════════════════════════════════════════════════════════════ */

/** 删除类命令词（POSIX 与 cmd.exe 各自的主力 + PowerShell cmdlet 全名与别名） */
const DELETE_WORDS = new Set(['rm', 'rd', 'rmdir', 'del', 'remove-item']);
/**
 * cmd.exe 的命令还认 `/x` 形式的旗标（`rd /s /q`）—— POSIX 的 `rm` 不认，因为 `/s` 那时是路径。
 * ⚠ 只有**删除类**的命令词有份：`isSlashFlag` 唯一的调用点是 `judgeDelete`，而它第一行就把
 *   非删除词挡掉了。曾把 `format` / `shutdown` 也列在这里（"它们也用 `/x` 旗标"听起来对），
 *   但那两个判据压根不走 `isSlashFlag`（`judgeDevice` 自己认盘符、`judgePower` 不看旗标），
 *   是**纯死数据** —— 变异 M30 拿掉它们套件全绿，遂删（同 `judgeDelete` 里那行 `>` `<`
 *   跳过分支的先例：探针证明不可达就删，不留在那里充数）。
 */
const SLASH_FLAG_WORDS = new Set(['rd', 'rmdir', 'del']);
/** 写裸设备 / 格式化：命令词本身即是灾难，不必看目标 */
const DEVICE_WORDS = new Set([
  'fdisk', 'sfdisk', 'parted', 'wipefs', 'diskpart', 'format', 'mkswap', 'cryptsetup',
]);
/** 关机 / 重启 */
const POWER_WORDS = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);
/** 裸设备名（`dd of=` 与重定向目标看它）——`null` 刻意不在内：`dd … of=/dev/null` 是正当基准写法 */
const DEVICE_TARGET = /^\/dev\/(sd|hd|vd|nvme|mmcblk|disk|loop|mapper|sr)/i;
/** fork 炸弹（经典写法；空白压掉后再匹配） */
const FORK_BOMB = /:\(\)\{:\|:&\};:/;

/**
 * 这个 token 是 **cmd.exe 的 `/x` 旗标**吗（旗标不是删除目标）。
 *
 * ⚠ 它**不是装饰**：MSYS 展开（见 `expandTarget`）会把 `/s` `/q` `/f` 这类**单字母**写法
 *   认成 `S:/` `Q:/` `F:/` —— 也就是**盘根**。少了这一步，`del /f /s /q dist`（cmd 里最常见的
 *   一次正常清理）会被判成"在删 S 盘和 Q 盘"，直接误拦。C38/C45 钉着这一支。
 *   旗标前缀按命令分家：cmd.exe 的命令认 `/x`（`rd /s /q`），而 POSIX 的 `rm` **不认**
 *   —— 那时 `/s` 是一个真实存在的根目录名，正是文件头「已知代价」那条的来源。
 *
 * ⚠ 这里**故意没有**"`-` 开头就是旗标"那一支 —— 写过，实测是**观测上不可达**的：
 *   `-rf` 这类 token 即便被当成目标，`expandTarget` 也只会解出 `cwd/-rf`
 *   （相对路径永远落在 cwd 下，不可能是任何一棵树的根），于是"当旗标跳过"与
 *   "当目标解一次"的结局**逐字一样**。探针（`rm -rf -rf` / `rm -` / `rd -` / `rd - /s /q`
 *   等 11 条）改动前后输出完全相同，遂删 —— 与 `judgeDelete` 里那行 `>` `<` 跳过分支
 *   同一处理（探针证明无观测差异就删，不留在那里充数）。
 *   附带把名字从 `isFlag` 改成 `isSlashFlag`：它只管 `/x`，再叫"是不是旗标"就是名字在撒谎。
 */
function isSlashFlag(token: string, word: string): boolean {
  return SLASH_FLAG_WORDS.has(word) && /^\/[a-z]+$/i.test(token);
}

/**
 * ① 删除类命令：目标是不是"一棵树的根"。
 * ⚠ 第一行那句 `DELETE_WORDS.has(word)` 是**承重**的，不是防御性代码：
 *   少了它，任何命令只要**有一个 `/` 一类的参数**就会被误判成删除
 *   （`echo "rm -rf /"`、`prettier --write .`、`format C:` 三个都撞过这条，
 *    是本套件第一次跑探针时逮到的 —— 而它们的共同点是"别人手里的参数长得像路径"）。
 *   同段的另外两个判据（`judgeDevice` / `judgePower`）各自在函数内部做了同样的校验。
 */
function judgeDelete(word: string, tokens: readonly string[], ctx: DangerContext): DangerHit | null {
  if (!DELETE_WORDS.has(word)) return null;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isSlashFlag(token, word)) continue;
    const abs = expandTarget(token, ctx);
    if (abs === null) continue;
    let detail: string | null = null;
    // ⚠ 这个阶梯的**顺序是承重的，而且只有人读得出对错** —— 套件只判 `kind`，看不见文案。
    //   已被 demo 真跑照出一次：`rm -rf ~` 原本报"目标是当前工作目录的上级：C:\Users\31075"，
    //   因为家目录**恰好也落在 cwd 的祖先链上**（`~/proj` 这种布局就是常态），
    //   而"祖先"排在"家目录"前面先撞上了。话没说错，但用户打的是 `~`、读到"上级"只会更糊涂。
    //   次序据此定为 **根 → cwd 本身 → 家目录本身 → cwd 的上级 → 系统目录**：
    //   凡是重叠的，让**更具体**的那条身份赢（C47 钉着这一条）。
    if (isFilesystemRoot(abs)) detail = `目标是文件系统 / 盘的根：${abs}`;
    else if (path.resolve(abs) === path.resolve(ctx.cwd)) detail = `目标就是当前工作目录本身：${abs}`;
    else if (abs === path.resolve(ctx.home)) detail = `目标是家目录本身：${abs}`;
    else if (isSelfOrAncestor(abs, ctx.cwd)) detail = `目标是当前工作目录的上级：${abs}`;
    else if (SYSTEM_DIRS.includes(withoutDrive(abs))) detail = `目标是系统目录本身：${abs}`;
    if (detail === null) continue;
    return {
      kind: '删除整棵树',
      detail,
      why: '这类删除不可逆：它会连未提交的改动、构建产物、以及那棵树下的一切一起删掉，'
        + '没有回收站、也没有办法回滚。',
    };
  }
  return null;
}

/** ② 写裸设备 / 格式化 */
function judgeDevice(word: string, tokens: readonly string[], command: string): DangerHit | null {
  if (word.startsWith('mkfs')) {
    return { kind: '写裸设备 / 格式化', detail: `命令是 ${word}（格式化文件系统）`,
      why: '格式化直接覆盖文件系统，整块盘上的数据会变得不可读 —— 不是删文件，是不可逆地毁掉它们。' };
  }
  if (DEVICE_WORDS.has(word)) {
    if (word === 'format' && !tokens.some((t, i) => i > 0 && /^["']?[a-z]:/i.test(unquote(t)))) return null;
    // `format` 必须带一个盘符（否则可能是 `prettier format` 一类无关命令词）
    return { kind: '写裸设备 / 格式化', detail: `命令是 ${word}`,
      why: '分区表 / 文件系统的写入不可逆，出错的代价是整块盘。' };
  }
  if (word === 'dd') {
    const bad = tokens.slice(1).find((t) => {
      const s = unquote(t);
      return /^of=/i.test(s) && DEVICE_TARGET.test(s.slice(3));
    });
    if (bad) {
      return { kind: '写裸设备 / 格式化', detail: `dd 的输出目标是裸设备：${unquote(bad).slice(3)}`,
        why: '`dd of=/dev/...` 会直接覆盖那块设备上的数据，没有任何中间层可以挽回。' };
    }
    return null;
  }
  // 重定向到裸设备：`... > /dev/sda`
  const redirect = /(?:^|\s)\d?>>?\s*(\/dev\/\S+)/i.exec(command);
  if (redirect && DEVICE_TARGET.test(redirect[1]!)) {
    return { kind: '写裸设备 / 格式化', detail: `重定向目标是裸设备：${redirect[1]}`,
      why: '把输出直接写进裸设备等于就地覆盖那块盘。' };
  }
  return null;
}

/** ③ 关机 / 重启 / fork 炸弹 */
function judgePower(word: string, tokens: readonly string[]): DangerHit | null {
  const why = '它会打断用户机器上所有正在跑的东西；fork 炸弹更会在几秒内耗尽进程表，'
    + '机器卡到只能硬重启。';
  if (POWER_WORDS.has(word)) {
    return { kind: '关机 / 重启 / fork 炸弹', detail: `命令是 ${word}`, why };
  }
  if (word === 'init' && tokens.slice(1).some((t) => t === '0' || t === '6')) {
    return { kind: '关机 / 重启 / fork 炸弹', detail: '命令是 init 0 / init 6（切换运行级 = 关机 / 重启）', why };
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ④ 出口：纯函数判据 + 钩子适配器 + 拒因渲染
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 找第一条命中的灾难形态；没有返回 null。
 * `depth` 只用于"包装展开一层"：展开出来的串再判一次，但**不再展开**（depth 到 1 就停）。
 */
export function findDangerousCommand(command: string, ctx: DangerContext, depth = 0): DangerHit | null {
  if (typeof command !== 'string' || command.trim() === '') return null;
  if (FORK_BOMB.test(command.replace(/\s+/g, ''))) {
    return { kind: '关机 / 重启 / fork 炸弹', detail: '命令串是经典的 fork 炸弹写法',
      why: '它会在几秒内把进程表打满，机器卡到只能硬重启。' };
  }
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    const word = commandWord(tokens[0]!);
    const hit = judgeDelete(word, tokens, ctx)
      ?? judgeDevice(word, tokens, segment)
      ?? judgePower(word, tokens);
    if (hit) return hit;
  }
  if (depth === 0) {
    const inner = unwrapShell(command);
    if (inner !== null) return findDangerousCommand(inner, ctx, 1);
  }
  return null;
}

/**
 * 钩子形状的适配器（与 charter.ts 的 guardContractWrite 同一位置关系）：
 * 只看 `bash` 工具；命中返回 deny 契约，其余一律 undefined（fail-open，交回主流程）。
 */
export function guardDangerousCommand(
  toolName: string,
  args: unknown,
  ctx: DangerContext = { cwd: process.cwd(), home: os.homedir(), platform: process.platform },
): HookDeny | undefined {
  if (toolName !== 'bash') return undefined;
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== 'string' || command.trim() === '') return undefined;
  const hit = findDangerousCommand(command, ctx);
  if (hit === null) return undefined;
  return { action: 'deny', reason: renderDangerReason(command, hit) };
}

/**
 * 拒因（教学文案）：说清**没跑**、命中哪一类、为什么不可逆、以及三条出路。
 * 最后一段"护栏不是沙箱"是刻意保留的：不写这句，读的人会以为这道闸有它没有的强度。
 */
export function renderDangerReason(command: string, hit: DangerHit): string {
  return `[危险命令拦截] 「${command.trim()}」命中【${hit.kind}】：${hit.detail}\n`
    + `  ${hit.why}\n`
    + '  这条命令**没有被执行**（程序闸排在权限弹窗之前，所以用户也没被打扰）。\n'
    + '  三条出路：\n'
    + '    · 把目标缩小到具体目录 —— 本判据只认"一棵树的根"（文件系统根 / 盘根 / 家目录本身 / 系统目录本身 / 当前工作目录及其上级），缩小之后就不再命中；\n'
    + '    · 换成你实际想做的那个动作（例如只想清构建产物，就把目标写成那个产物目录）；\n'
    + '    · 若确实必须这么做 —— 请用户在**他自己的终端里**执行。这道闸只在 flint 进程内生效，进程外它管不着。\n'
    + '  （说明：这是**护栏不是沙箱**。命令串拼装、变量替换、包在脚本里、改写一下都能绕过，本判据不声称挡得住 —— 它挡的是顺手直接写出来的那一类形态。）';
}
