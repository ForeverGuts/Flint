/**
 * git **写侧**结构化工具 —— 判据、argv 与"给人看的文案"（ROADMAP 10.5.2）。
 * 调用方：tools/builtin.ts 的 `git_write` 工具（跑子进程）+ scripts/verify-git-write.ts。
 * 服务于：把 git 的暂存 / 提交 / 推送从"一条 Shell 命令串"变成**结构**，让每一次写都落在
 *         权限弹窗上，并让强制推送无法被上一次的"本次全部允许"顺手放行。
 *
 * ── 缺口原样 ──
 * 写侧此前**没有任何结构化通道**：add / commit / push 只能走 `bash "git commit -m …"`。
 * 三个代价，与 10.5.1 给只读侧记账时列的三条**同源**：
 *   ① 用户在弹窗里看到的是一整条 Shell 命令（带引号、`&&`、`;`），而不是"提交什么、推到哪"；
 *   ② bash 的授权边界是**整条命令串** —— `git commit … && curl … | sh` 是一次授权，
 *      本地与网络、读与写被绑在同一笔账里；
 *   ③ 模型能在那条命令里装上任意 git 选项（`--no-verify` 跳过钩子、`-c alias.x=…` 定义别名），
 *      而"哪些选项被允许"在那条路上**无法枚举** —— 本条的全部工作就是把可表达的选项收成三个 op。
 *
 * ── 本条的结构判断：写侧**单独成工具**，不与 `git` 混 ──
 * 最省事的做法是给 `git` 加三个 op。这里刻意没那么做，理由只有一条但很硬：
 * **"这个工具能不能改用户的文件"必须由工具身份回答，不能由参数回答。**
 * 计划模式的闸（10.4.1 的 `guardPlanMode`）**刻意只看工具名**、不看参数，因为"能不能改用户
 * 文件"是工具身份的属性；若把写 op 塞进 `git`，那句话就得改成"看 op" —— 而 op 是参数，
 * 于是每处判定（计划模式、审计、人读文档）都要各自解析一遍，漏一处就是静默通路。
 * 所以本仓的 git 有**两个入口**：`git`（永不写）、`git_write`（写）。
 *
 * ── 三个 op：add / commit / push ──
 * 为什么 add 也算：没有它，commit 就成了半条通道 —— 模型每提交一次都得回 bash 拿一次授权，
 * 而那条回程正是本条要治的病。"写侧 git"就是**暂存 + 提交 + 推送**这三件事，一件不少。
 * （反过来，只读查询仍然只走 `git`：两个工具的分工是"写 / 不写"，不是"新 / 旧"。）
 *
 * ── 选项注入是**结构上**挡掉的，不是靠黑名单 ──
 * 2026-09-20 探针取证（git 2.52.0），三条都不是推的：
 *   · `git push -- <远端> <分支>` 合法 ⇒ `--` 之后的两个位置参数**不可能**被当成选项；
 *   · `git push -- --dry-run` → `fatal: strange pathname '--dry-run' blocked`（git 自己也不收）；
 *   · `git commit -m --amend` 之后 `git log` 显示那条提交的消息就是字面的 `--amend`
 *     （提交条数 +1、**没有** amend）⇒ `-m` 的下一个 token 是**值**，不管它长什么样。
 * 于是 argv 的**形状**是承重的：push 的 `--` 必须在两个位置参数之前、强制旗标必须在它之前。
 * ⚠ 另有一条前置校验把"以 `-` 开头的远端名 / 分支名"判成 `[INVALID]`。**它不是防线**
 *   （防线是 `--`），它管的是**分类与文案**：这种输入原样重试必然再错，该进 `invalid` 那一类
 *   （于是计入失败、触发"你在重复犯错"的提示），并由我们说出"那个位置要填的是**名字**"。
 *   两个机制各管一件事，别把其中任一个当成另一个的备份。
 *
 * ── 确认落在**权限弹窗**，不在程序闸（C7 的答法）──
 * 路线图 C7 挂着："`decodeDeny` 是二值契约，想表达'这条危险、让我确认一下'时只能选拒或放行。"
 * 本条的确认**从头到尾不经过程序闸**：`git_write` 的 `requirePermission` 为真，每一次写都在
 * **权限弹窗**上问人，而弹窗本来就是三态（允许一次 / 本次全部允许 / 拒绝）。
 * ⇒ C7 是"**想在程序闸里说 ask**"的账单，不是"想让人确认"的账单。
 *   通用问法：遇到"二值契约装不下 ask"，先问一句 —— **这个 ask 该由程序问，还是该由人答？**
 *   （与 C8 那次同构：先看清约束问的是哪个形状，往往能把它整个换掉，而不是去满足它。）
 *
 * ── `--force` 的"二次确认"落在**授权键**上 ──
 * 强制推送刻意**留在入口里**（它经常是正当的：rebase 之后的特性分支该用 --force-with-lease 推），
 * 10.9.2 也明确把它留给本条、没进危险闸。做法不是"问两遍"，而是：
 *   **授权键里带强制模式**（`push:origin/main:overwrite` 与 `push:origin/main` 是两笔账），
 *   于是用户为普通 push 按下的"本次全部允许"**永远覆盖不到**一次强制推送 —— 它必然单独再问。
 * 这才是"二次"在这套架构里的技术含义：**不是问两遍，而是上一次的许可不适用这一次。**
 * （键还必须是**稳定键**：默认那条"拿整串 args JSON 当键"的兜底，任何一次参数增删都会让此前
 *   所有"本次全部允许"静默失配、表现为"怎么每次都要重问"—— 这正是 `permissionKey` 存在的理由。）
 *
 * ── 刻意不做（判据写在这儿，不是忘了）──
 * · **不给 `--no-verify`**：钩子是项目自己的治理（本仓的 pre-commit 就跑 verify），
 *   一个"跳过检查"的开关等于把项目的门自己拆了。要跳请在你自己的终端里做。
 * · **不替模型决定暂存什么**：add 只认一个 path（`--` 之后），没有 `-A`、没有通配展开。
 * · **不留 `-u` / `--set-upstream`**：那是**写配置**（改 `.git/config`），与本条"改仓库内容"
 *   不是一类动作；需要时 bash 一次，用户会在弹窗上看到它。
 * · **不接任何交互输入**：调用点注入 `GIT_TERMINAL_PROMPT=0` —— 需要输密码时**直接失败**
 *   而不是挂住等人敲。凭据问题的出路是用户的终端，不是这里。
 * · **不做 `--amend` / `reset` / `checkout` / `rebase`**：它们都是"改写已有的历史 / 工作区"，
 *   各有各的判据；要做得各有一条 route 与各自的取证，本条不顺手带上。
 *
 * ⚠ 已知边界（不装糊涂）：**护栏不是沙箱** —— 模型仍可用 bash 跑 `git commit --no-verify`、
 *   `git push --force`。本条做的是"**给正当用法一条结构化、看得懂的通道**"，
 *   以及"**让强制推送必须被单独看见一次**"，不是"让那些事做不成"。
 *
 * 只 import 同一子系统的既有件：`git.js` 的类型（编译期擦除）+ 三个值
 * （`buildGitArgs` / `LOG_FORMAT` / `renderShow` / `redactCredentialsIn` / `renderBranchLine`
 * —— argv 与格式串各只有一份定义，不在这里另抄一遍）。
 * 零第三方依赖、不碰 fs、不起进程：本文件全是纯函数。
 */
import {
  buildGitArgs, LOG_FORMAT, redactCredentialsIn, renderBranchLine, renderShow,
  type RepoStatus, type ShowResult,
} from './git.js';

/** 三个写操作。**这是白名单，不是示例** —— 工具层拿它当唯一入口，别的 op 一律拒 */
export type GitWriteOp = 'add' | 'commit' | 'push';

export const GIT_WRITE_OPS: readonly GitWriteOp[] = ['add', 'commit', 'push'];

/**
 * 强制推送的两种**真实存在**的形态。空串 = 不强制（默认只推能快进的）。
 *
 * 刻意不给"布尔 force"：`--force` 与 `--force-with-lease` 的危险程度差一个量级，
 * 一个 `true` 表达不出这个差别 —— 模型只能在"lease（远端被别人推过就失败）"与
 * "overwrite（直接盖掉）"之间**显式选一个**，并因此在文案里被明确告知它选了什么。
 */
export type ForceMode = '' | 'lease' | 'overwrite';

export const FORCE_MODES: readonly ForceMode[] = ['', 'lease', 'overwrite'];

/** `force` 参数的**原值** → 模式。认不出一律 null（由调用方判成 [INVALID]，**不猜**） */
export function normalizeForce(value: string): ForceMode | null {
  const v = value.trim().toLowerCase();
  return (FORCE_MODES as readonly string[]).includes(v) ? (v as ForceMode) : null;
}

/** 模式 → git 旗标。空串 = 一个旗标都不加 */
export function forceFlag(mode: ForceMode): string {
  if (mode === 'lease') return '--force-with-lease';
  if (mode === 'overwrite') return '--force';
  return '';
}

/** 模式 → 人话（弹窗文案与失败文案共用一处说法） */
export function forceLabel(mode: ForceMode): string {
  if (mode === 'lease') return '强制推送（--force-with-lease：远端若被别人推过就会失败）';
  if (mode === 'overwrite') return '强制推送（--force：会盖掉远端已有的提交）';
  return '';
}

export interface GitWriteParams {
  op: GitWriteOp;
  /** add：要暂存什么。落在 `--` **之后**（pathspec 位置，不会被当选项）；单值 —— spec 表达不了数组 */
  path: string;
  /** commit：提交消息。它是 `-m` 的**值**（探针：`-m --amend` 之后消息就是字面的 `--amend`） */
  message: string;
  /** push：远端名或 URL；留空 = 用配置好的上游 */
  remote: string;
  /** push：分支名；留空 = 当前分支 */
  branch: string;
  force: ForceMode;
}

/** 与只读侧同一前缀：quotepath 管中文路径、color.ui 管 ANSI 码（**push 的输出是会着色的**） */
const BASE: readonly string[] = ['-c', 'core.quotepath=false', '-c', 'color.ui=false'];

/**
 * 构造 git 的参数数组。调用方必须用 `execFileSync('git', argv)` —— **不经 shell**。
 * 形状本身就是判据（见文件头）：`--` 把位置参数与选项彻底隔开，强制旗标只能落在它之前。
 */
export function buildGitWriteArgs(p: GitWriteParams): string[] {
  const base = [...BASE];
  switch (p.op) {
    case 'add':
      return [...base, 'add', '--', p.path.trim()];

    case 'commit':
      // **不给 `--no-verify`**（见文件头"刻意不做"）：钩子必须跑。
      // 也不给 `-a` / `--amend` / `--allow-empty`：本工具只提交"已经暂存好的东西" ——
      // 那既是 git 自己的语义，也是唯一能被事前讲清楚的那一种。
      return [...base, 'commit', '-m', p.message];

    case 'push': {
      const argv = [...base, 'push'];
      const flag = forceFlag(p.force);
      if (flag !== '') argv.push(flag);
      const remote = p.remote.trim();
      const branch = p.branch.trim();
      // `--` 只在真有位置参数时才加：一个都没有时它什么都不保护
      //（`git push` 走配置好的上游，那是最常见的形态）
      if (remote !== '' || branch !== '') argv.push('--');
      if (remote !== '') argv.push(remote);
      if (branch !== '') argv.push(branch);
      return argv;
    }
  }
}

/**
 * 取值落在**选项位置**的校验。判据是**位置**，不是内容 —— 同一个 `--force` 当提交消息完全正常，
 * 当远端名却是选项（见文件头：防线是 `--`，这里管的是分类与文案）。
 */
export function rejectOptionLike(value: string, label: string, hint: string): string | null {
  const v = value.trim();
  if (!v.startsWith('-')) return null;
  return `${label} 不能以 "-" 开头（写的是 "${v}"）—— 那个位置要填的是${hint}，不是 git 的选项。`
    + '以 "-" 开头的 token 会被 git 当成旗标，所以本工具直接拒绝、没有执行。';
}

/** 检查结果：通过给规范化参数，不通过给**给模型看的原因**（两样恰好有一件） */
export interface WriteCheck {
  params: GitWriteParams | null;
  problem: string | null;
}

function rawStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 把**未校验的原始 args** 变成规范化参数 + 一句原因。纯函数、不抛异常
 * （权限层拿到的就是未经 parse 的 args，所以这里必须容忍任何形状）。
 */
export function checkWriteArgs(args: unknown): WriteCheck {
  const r = (typeof args === 'object' && args !== null && !Array.isArray(args))
    ? args as Record<string, unknown>
    : {};
  const opRaw = rawStr(r.op);
  if (!(GIT_WRITE_OPS as readonly string[]).includes(opRaw)) {
    return {
      params: null,
      problem: `未知操作 op=${opRaw === '' ? '(空)' : opRaw}，可用的是 ${GIT_WRITE_OPS.join(' / ')}`
        + '（写操作走本工具；查仓库状态走只读的 git 工具）。',
    };
  }
  const force = normalizeForce(rawStr(r.force));
  if (force === null) {
    return {
      params: null,
      problem: `认不出 force=${rawStr(r.force)}。它只收两个值：lease（--force-with-lease，`
        + '远端被别人推过就失败）、overwrite（--force，直接盖掉远端提交）；不强制就留空。',
    };
  }
  const params: GitWriteParams = {
    op: opRaw as GitWriteOp,
    path: rawStr(r.path),
    message: rawStr(r.message),
    remote: rawStr(r.remote),
    branch: rawStr(r.branch),
    force,
  };
  const problem = validateWriteParams(params);
  return problem === null ? { params, problem: null } : { params: null, problem };
}

/**
 * 逐 op 的形状校验。**落在纯函数里**而不是全塞进 spec：`tools/spec.ts` 表达不了
 * "仅当 op=commit 且 message 留空时走自动生成"这种跨字段语义（同 blame 的 path，
 * 判据只能写在 handler 这一侧）。commit 的 message 留空不再在这里拒 —— 放行给 handler，
 * 由它在跑 commit 前基于已暂存 diff 生成（ROADMAP 10.5.3）。
 */
export function validateWriteParams(p: GitWriteParams): string | null {
  if (p.op === 'add') {
    if (p.path.trim() === '') {
      return 'add 要说清暂存什么：path 不能是空的（要暂存本目录下全部改动就写 "."）。';
    }
    return null;
  }
  if (p.op === 'commit') {
    // message 留空 = 请求基于已暂存的 diff 自动生成（ROADMAP 10.5.3）。
    // 这里不再以"空消息"拒 —— 否则自动生成这条路永远走不进来。
    // 真正的"有没有东西可提交"由 handler 在跑 commit 前确认：无已暂存改动会明确回绝，
    // 有就调 generateCommitMessage 写好再提交。
    return null;
  }
  // push：两个位置参数都落在 `--` **之前**，任一以 "-" 开头都会被 git 当选项
  const badRemote = rejectOptionLike(p.remote, 'remote', '远端名或 URL');
  if (badRemote !== null) return badRemote;
  const badBranch = rejectOptionLike(p.branch, 'branch', '分支名');
  if (badBranch !== null) return badBranch;
  // 只给分支不给远端：`git push <远端> <分支>` 的**第一个**位置参数是远端，
  // 单给分支会被当成"名为 main 的远端" —— 那是一条看着成功、其实推错地方的命令
  if (p.branch.trim() !== '' && p.remote.trim() === '') {
    return 'push 只认"远端 + 分支"**成对**给：`git push <远端> <分支>` 的第一个位置参数是**远端**，'
      + '只给 branch 会被当成远端名。要么两个都给（remote="origin", branch="main"），'
      + '要么两个都留空（走配置好的上游）。';
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   权限身份：授权键 与 弹窗文案
   ═══════════════════════════════════════════════════════════════════════════════ */

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').trim();
}

/**
 * 授权键 —— **用户按"本次全部允许"时看见的那件事**（与 write/edit 给路径、bash 给整条命令
 * 同一立场：键就是"他刚才同意的是什么"）。
 *
 * 三条判断：
 *   · **commit 的键带消息**（同 bash 给整条命令）：换一条消息就是另一次提交，该重问；
 *   · **add 的键带路径**（同 write/edit 给路径）；
 *   · **push 的键带远端/分支，并且带强制模式** —— 这是本模块最重要的一个键，它让
 *     "普通 push 的本次全部允许"**覆盖不到**强制推送（见文件头"二次确认"）。
 * 认不出形状（权限层拿的是未 parse 的 args）→ 退回整串 JSON，与 agent-loop 的兜底同口径：
 * 宁可失配让用户多点一次，也不扩权。
 */
export function gitWritePermissionKey(args: unknown): string {
  const { params } = checkWriteArgs(args);
  if (params === null) return JSON.stringify(args) ?? '';
  if (params.op === 'add') return `add:${params.path.trim()}`;
  if (params.op === 'commit') return `commit:${params.message.trim()}`;
  const remote = params.remote.trim() === '' ? '(上游)' : params.remote.trim();
  const branch = params.branch.trim() === '' ? '(当前分支)' : params.branch.trim();
  return `push:${remote}/${branch}${params.force === '' ? '' : `:${params.force}`}`;
}

/**
 * 弹窗标题（权限弹窗只有一行；`permissionDetail` 的默认是 args JSON 前 80 字符，
 * 那个形状在这里恰好看不出"推到哪、强不强制"—— 同 edit 当初加 `permissionDetail` 的理由）。
 *
 * ⚠ 与 `permissionKey` **刻意分开**：这里给人看、可以带中文与符号；那里做匹配、必须稳定。
 * 把富文本当键 = "本次全部允许"永远匹配不上（每次文案都可能不同）。
 */
export function gitWritePermissionDetail(args: unknown): string {
  const { params, problem } = checkWriteArgs(args);
  if (params === null) return `git_write：参数不合法（${firstLine(problem ?? '')}）`;
  if (params.op === 'add') return `git add：暂存 ${params.path.trim() || '(未填)'}`;
  if (params.op === 'commit') return `git commit：${firstLine(params.message) || '(消息为空)'}`;
  const remote = params.remote.trim() === '' ? '(上游)' : params.remote.trim();
  const branch = params.branch.trim() === '' ? '(当前分支)' : params.branch.trim();
  const warn = forceLabel(params.force);
  return `git push：${remote}/${branch}${warn === '' ? '' : `  ⚠ ${warn}`}`;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   执行：argv 与"跑完拿什么当事实"
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * commit 成功后的**复核** argv：`log -1 --format=<与 show 同一串> --numstat`。
 *
 * 为什么不解析 `git commit` 自己那句输出：它是**本地化**的（`[main abc1234] …` /
 * `1 file changed` 在别的语言环境会变样），而这里的形状是实测过的结构 ——
 * 「格式块 + 空行 + numstat」，与 `show` 完全一致，于是 `parseShow` / `renderShow`
 * 原样复用（2026-09-20 探针：`cat -A` 看到 `<格式块>^$` / 空行 / `1^I0^Ia.txt`）。
 */
export function commitFollowUpArgs(): string[] {
  return [...BASE, 'log', '-1', `--format=${LOG_FORMAT}`, '--date=short', '--numstat'];
}

/**
 * push 成功后的**复核** argv：只读 status（走只读侧的 `buildGitArgs`，**不在这里另搓一份**）。
 *
 * 为什么不用 push 自己那句输出：它必定印出远端 URL（`To https://user:token@host/…`），
 * 而且同样是本地化的。复核拿到的 ahead/behind 是**结构性**的、locale 无关，
 * 而且回答的正是模型真正要知道的那件事 —— "推完之后我和上游是什么关系"。
 */
export function pushFollowUpArgs(): string[] {
  return buildGitArgs({ op: 'status', target: '', path: '', lines: '', limit: 10 });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   渲染
   ═══════════════════════════════════════════════════════════════════════════════ */

/** git 原话最多带多少字进正文（这与审计的 target 摘要不是一回事：那里 200，这里是给模型读的证据） */
export const WRITE_STDERR_MAX = 300;

/** 提交成功的正文：事实来自 `log -1` 的复核（渲染复用只读侧的 renderShow，说法只有一份） */
export function renderCommitResult(entry: ShowResult): string {
  return ['提交成功（这次 commit 已经落进本仓库）。', renderShow(entry, '', false)].join('\n');
}

/**
 * 推送成功的正文：事实来自 push **之后**的一次只读复核。
 *
 * 分支那一行直接调只读侧导出的 `renderBranchLine` —— **逐字同一句话**（`[分支] main → origin/main`）。
 * 不复用它的后果很具体：`push` 之后"到底同没同步"会由两处用两套话讲，而它们迟早不一致，
 * 且不一致的形态恰好是"两边单独看都对"。
 *
 * "与上游一致"这半句只在**平齐**时补一句 —— 只读侧的留白是为省字，而刚推完的人要的正是这个答复。
 */
export function renderPushResult(status: RepoStatus): string {
  const lines = ['推送完成（这次 push 已经执行到远端）。', renderBranchLine(status)];
  if (!status.detached && !status.unborn && status.upstream !== null
    && status.ahead === 0 && status.behind === 0) {
    lines.push('  本地与上游一致：没有领先或落后的提交。');
  }
  return lines.join('\n');
}

/**
 * 写操作失败的正文。**git 的原话在这里是唯一证据**（non-fast-forward / 钩子拒绝 /
 * "没有暂存的改动"都只有它说得清），所以原样带上 —— 但**先打码**：
 * push 的失败信息里必定带远端 URL（实测 `To <url>` 与 `failed to push some refs to '<url>'`），
 * 而 URL 里可能带 token（同 10.5.1 的 `remote` 那条口径）。
 *
 * ⚠ `text` 是**两路合并后**的原话（调用侧拼的）。为什么不是只有 stderr：2026-09-20 探针
 * 实测三条失败各走各的流 —— `add`（`fatal: pathspec … did not match any files`）与
 * `push`（`fatal: 'x' does not appear to be a git repository`）在 **stderr**，
 * 而 `commit` 最常见的那个（`nothing to commit, working tree clean`）在 **stdout**、
 * stderr 是空的。只收 stderr 会让模型最常撞的那次提交失败变成"git 没有给出任何信息"。
 */
export function renderWriteFailure(op: GitWriteOp, text: string): string {
  const detail = redactCredentialsIn(text).trim();
  const head = op === 'add' ? '暂存失败' : op === 'commit' ? '提交失败' : '推送失败';
  const lines = [`${head}（这次 ${op} 没有成功）。`];
  lines.push(detail === ''
    ? '  git 没有给出任何信息（退出码非 0、输出为空）—— 原始状态请用只读的 git 工具看（op=status）。'
    : `  git 说：${detail.length > WRITE_STDERR_MAX ? `${detail.slice(0, WRITE_STDERR_MAX)}…` : detail}`);
  lines.push(`  常见原因：${WRITE_FAILURE_HINTS[op]}`);
  return lines.join('\n');
}

/**
 * 逐 op 的"接下来怎么办"。刻意写**常见原因 + 出路**而不是复述 git 的话：
 * 那句原话已经在上面了，模型缺的是"这几种情形各自该怎么走"。
 */
const WRITE_FAILURE_HINTS: Record<GitWriteOp, string> = {
  add: '路径不在这个仓库里（比如写成绝对路径、或跑到了别的目录下）· '
    + '或者它被 .gitignore 忽略了（被忽略的文件暂存不了，这是 git 自己的规矩）',
  commit: '① 没有已暂存的改动（本工具**不替你 add** —— 要暂存先 op=add；'
    + '也不替你 `-a`，因为那会把"哪些改动进了这次提交"藏起来）；'
    + '② 仓库的 pre-commit 钩子拒绝了这次提交 —— 那就先修它，**本工具不会跳过钩子**；'
    + '③ 没配 user.name / user.email（首次提交常见，请在终端里配一次）',
  push: '① 远端有你本地没有的提交（`rejected … non-fast-forward`）—— 先 pull / rebase 对齐，'
    + '**不要**用强制推送去盖掉别人的提交；确实是自己改写过的特性分支才显式加 force="lease"'
    + '（它会先检查远端有没有被人推过）；'
    + '② 没配远端、或当前分支没有上游分支 —— 那就把 remote 与 branch **成对**给上；'
    + '③ 凭据不可用：本工具把 GIT_TERMINAL_PROMPT 置 0，**需要输密码时直接失败而不是挂住等人敲** ——'
    + '凭据问题请在你自己终端里处理一次（配好之后本工具就能用）',
};

/**
 * 超时（网络与钩子都可能慢）。真·后台执行属 10.10.1，本条不顺手造它 ——
 * 但**必须有一个上限**：没有上限的同步子进程在钩子写了个交互提示时会永久挂住整个轮次。
 */
export const WRITE_TIMEOUT_MS: Record<GitWriteOp, number> = {
  add: 30_000,
  commit: 60_000,
  push: 120_000,
};
