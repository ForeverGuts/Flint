/**
 * 工作区外写保护 —— ROADMAP 10.9.3 的程序侧。
 * 调用方：harness/main.ts（注册 before_tool_call 核心钩子 = 第三道闸）、
 *         commands/builtin/workspace.ts（/workspace，用户显式放行外写目录）、
 *         harness/project-context.ts（切项目时清空放行表）
 * 服务于：把"只改当前项目里的文件"从提示词自律升级为**程序闸** ——
 *         默认拒 cwd 之外的写，模型不能自己把文件写到项目外面去。
 *
 * ── 它挡的是哪一件事（缺口原样）──
 * 此前 write / edit 可以写**任意路径**：`path: "C:/Users/31075/.bashrc"`、
 * `path: "../other-project/src/index.ts"` 一律照写。权限弹窗拦不住这一类 ——
 * 弹窗问的是"这次调用要不要做"，而它恰好有两处够不着（与 10.9.2 同源）：
 *   · 非 TTY / RPC 模式下权限**自动放行**（登记在案的已知边界），那里没有人在看；
 *   · 用户对某个 write 点过"本次全部允许"之后，同一目标文件不再弹窗。
 * 于是"AI 跑到项目外面去改东西"这件事，全程只靠模型自觉。
 *
 * ── 三条承重（判据的形状都由它们决定）──
 *
 * ① **只有 L1、没有 L2**（同 10.9.2）。契约锁是"L1 字面闸 + L2 事后比对文件内容、可回滚"，
 *    这道闸只能有 L1 —— 写到工作区外是**效果**，事后要拿去跟什么比对？没有基线可比、
 *    也没有"回滚到哪个版本"的答案（那是个新建文件，回滚等于删掉别人的东西）。
 *    照抄不了 L2，判据方向就只能是**事前把范围划准**。
 *
 * ② **判据按"声明的目标路径"判，不按命令语义判**（同 10.9.2 的"看目标不看旗标"）。
 *    `write` / `edit` 的参数里有一个**明确的目标路径** `path`，判它一条就够；
 *    路径长什么样、是新建还是覆盖、内容是啥，一概不看。
 *
 * ③ **`bash` 刻意不进这道闸**（本条的**最大边界**，写在拒因里）。
 *    bash 的目标藏在命令串里（重定向、参数、脚本、变量、`tee`），而同一个位置
 *    **读和写长得一模一样**：`grep x /etc/hosts` 读、`echo x > /etc/hosts` 写。
 *    按字面判会把 `node …/tsc`、`git -C /other log`、`grep x /tmp/a` 这类**正常命令**
 *    一起堵死 —— 违反"宁可少拦不可误拦"（误拦会让人把闸关掉，比漏拦更坏）。
 *    所以：bash 的**灾难形态**由 10.9.2 覆盖，**普通外写**不覆盖，本判据不声称挡得住。
 *
 * ── 显式授权为什么走独立通道，而不是权限弹窗（决策，同 C11）──
 * 权限子系统的语义是"**弹窗放行** + 进 allowlist"，回答"这次调用要不要做"；
 * 这道闸要的是"**默认拒写** + 用户点名的目录"，回答"要不要放开这条边界"。
 * 若挂在弹窗上，非 TTY 下自动放行这一条就让它**形同虚设** —— 而那正是本条要治的场景之一。
 * 故本闸只认自己的放行表（`workspaceGrants`），与 PermissionManager 无任何交集：
 * 唯一开门动作是用户敲 `/workspace allow <目录>`，**模型自己开不了**（同 /charter unlock 的分工）。
 *
 * ── 与 C2 的关系（顺手解掉一条登记在案的阻塞）──
 * 路线图 C2 记着"`spec.ts` 刻意无数组形状 → 阻 10.9.3（路径列表）"，当初是把"放行若干路径"
 * 默认成了**工具参数**（那确实要数组形状）。既然授权动作由**用户**发起、经由 `/workspace`
 * 命令解析自由文本，就完全不必碰 `tools/spec.ts` —— C2 对本条的阻塞与它对 10.8.1 的阻塞
 * 同型：**"这条要动 X"之前先问一句"它非得是工具吗"**。落点选对，代价凭空少一整块。
 *
 * ── 内存表是会话级；"长期"要走显式 `--save`（ROADMAP 10.9.1）──
 * 放行表本身仍然**只在内存、只活一次会话**（与 charterLock 同源）：一次随手放行不该
 * 被放大成长期有效。用户确实要"长期信任某个目录"时，改走**显式**的
 * `/workspace allow --save <目录>` —— 落盘那半边全在 `permission/grants.ts`，
 * 本文件**刻意一个 fs 都不碰**（verify-workspace 的 G8 钉着这条）。
 * 分工一句话：**默认只活一次会话，长期要用户说出口；说了就真长期。**
 * 项目切换时仍**必须清空**（见 project-context.ts）—— 清完之后栽回来的是
 * **B 自己**在盘上的那一份，不是 A 的（"凡在旧项目取得的许可都不跟着搬"照旧成立）。
 *
 * ── 已知边界（不装糊涂）──
 * · **符号链接 / junction 由第二步兜底**（ROADMAP 10.9.5 补）。第一步仍只做字符串路径
 *   代数、不碰 fs —— 那是它能喂假目录逐形状打靶的原因；**第二步** `findTraversal` 在
 *   "声明在内"时追一次**真落点**（解析器由 `ctx.realpath` 注入，见下面 ctx 的注释）：
 *   `cwd/link-to-out/x` 这类形状第一步判"内部"，第二步判"真落点在外面" → 拒。
 *   ⚠ 第二步**只在注入了 `realpath` 时生效**，没注入时判据逐字退回改动前的行为 ——
 *   既有调用点与既有 126 条断言因此零扰动（这是"加一步"而不"换判据"的代价与好处）。
 * · **`bash` 不覆盖**（见承重③）。
 * · **`~` 不展开**（与 write / edit / read 同口径）：`path: "~/x"` 写的是 **cwd 下一个名叫
 *   `~` 的目录**，不碰家目录 —— 所以它判成"内部"是**对的**，不是漏拦。
 * · **MSYS 形式 `/c/Users/...` 不认**（与 read 同口径），但落点与 `read` 不同、
 *   值得写清：`path.resolve` 把开头的 `/` 读成"**当前盘**的根"（不是"相对 cwd"），
 *   于是它变成 `C:\c\Users\...` —— 在工作区**外面**，被判成外部。
 *   结果是**一句带完整解释的拒**（而不是静默误解成"内部的某个文件"），方向是对的：
 *   要写外面请用盘符形式，那是同一条可见的拒。
 *   ⚠ 这一条初稿写成"会被判成 cwd 之下的 `c/Users/...`，即内部"——**推理补的一半**，
 *   被套件的 B15 当场逮住（实测是外部）。"没实测到的那一半不许用推理补"，同一条纪律。
 * · **工作区就是 cwd**（与 10.11.1 的项目身份同口径："cwd 即身份"）。在仓库子目录里启动时，
 *   工作区是那个子目录、仓库根在它外面 —— 被拒时拒因会告诉你怎么放行。
 *
 * 零运行时依赖：只用 node:path（内置）+ 纯函数。
 */
import path from 'node:path';
import type { HookDeny } from '../loop/tool-hooks.js';

/** 拒因前缀 —— 套件靠它认出"是这道闸给的拒绝"（同 10.9.2 的 `[危险命令拦截]`） */
export const WORKSPACE_MARK = '[工作区边界]';

/**
 * 进这道闸的工具 = 参数里有**明确目标路径**的那两个。
 * 刻意不是"凡能写文件的工具"：`bash` 能写但判不出来（见文件头承重③），
 * `todo` / `memory` / `record_event` / `archive` 的目标路径是**写死的项目内文件**，
 * 不由模型给，没有判的必要。
 */
export const GUARDED_WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

/** 判据的注入上下文 —— cwd 与放行表都是参数，不直读模块状态，纯函数才验得动 */
export interface WorkspaceContext {
  /** 工作区根 */
  cwd: string;
  /** 用户已显式放行的**绝对**目录（每个都含其子树） */
  grants: readonly string[];
  /**
   * 追**真落点**的解析器（符号链接 / junction）—— 可选、注入式。
   *
   * 为什么是注入而不是本文件直接 import 一份实现：本文件的判据刻意**只依赖 node:path
   * 与钩子契约类型**（G1/G2 钉着这条），"碰 fs"的那一半因此留在 `tools/paths.ts` 的
   * `realPathOf`，由装配处（harness/main.ts）注入。判据本身仍是纯的 —— 套件照样能喂
   * 一个**假解析器**逐形状打靶，与 cwd / grants 是同一个立场（判据要能被喂假数据）。
   * **缺省不注入 = 不追**：判据退回纯代数，行为与 10.9.5 之前逐字相同。
   */
  realpath?: (abs: string) => string;
}

/**
 * `target` 是否落在 `root` 之内（含 root 自身）。两边都先 `path.resolve` ——
 * 幂等，所以传已归一化的路径也照旧，调用方不必记得先归一（少一个脚枪）。
 *
 * 为什么不用字符串前缀：`C:/Users/31075/Desktop/Ts_Agent2` 的字符串前缀就是
 * `C:/Users/31075/Desktop/Ts_Agent` —— 前缀判定会把**兄弟目录判成内部**（探针实测：
 * `startsWith` 在这里返回 true）。`path.relative` 给的是代数结果，天然没有这个坑。
 *
 * 外部有三种形态，都要认出来：
 *   · `../x`（上级方向）—— 相对路径以 `..` 开头
 *   · `D:\x`（跨盘）—— relative 给不出相对路径，直接返回绝对路径
 *   · `\\server\share\x`（UNC）—— 同上
 *
 * ⚠ 判"以 `..` 开头"必须带上分隔符：**名叫 `..foo` 的文件是在内部的**，
 *   只写 `rel.startsWith('..')` 会把它误判成外部（danger.ts 的 `isSelfOrAncestor`
 *   就有这个形状的宽松写法，读者别照抄那一处）。G12 钉着这条，防"顺手简化"。
 */
export function isUnder(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return true; // 就是它自己
  if (path.isAbsolute(rel)) return false; // 跨盘 / UNC
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * 目标路径是否落在**工作区之外** —— 纯函数，**不碰 fs**。
 *
 * "不碰 fs"是硬约束，不是风格：`write` 的使命之一就是**创建还不存在的文件**，
 * 对不存在的路径做 realpath 会抛；退一步用 existsSync 也会把"新建"误判成异常。
 * 路径代数（`path.resolve` 只做字符串运算）正好够用，且套件能喂假目录逐形状打靶。
 *
 * 放行表里的每个目录**含其子树** —— 这是 C1 当年点名要的东西：
 * "目录级授权要真做，得先有一个**只按路径授权**的独立入口，不能靠匹配规则顺带实现"
 * （见 permission/manager.ts 的注释）。这里就是那个入口：判据是 `isUnder`，
 * 而不是"授权键的前缀匹配"——后者在 bash 那条线上会把 `cd src/` 放大成 `cd src/ && rm -rf .`。
 */
export function isOutsideWorkspace(target: string, ctx: WorkspaceContext): boolean {
  const abs = path.resolve(ctx.cwd, target);
  if (isUnder(path.resolve(ctx.cwd), abs)) return false;
  for (const g of ctx.grants) {
    if (isUnder(g, abs)) return false;
  }
  return true;
}

/**
 * **第二步**的判据（ROADMAP 10.9.5）：**声明的**路径落在某个根里，**追出来的真落点**却出了
 * 那个根 —— 符号链接 / junction 穿越。命中时返回**出界的那个根**（拒因要报它），否则 undefined。
 *
 * 三段判据，每段都有反例钉着（见 `verify-paths.ts`）：
 *  ① **声明路径不在这个根里 → 不是它的责任**，跳到下一个根。少了这一句，就会拿 A 根去套 B 根
 *     的路径（cwd 与某条放行目录互不包含时立刻误判）。
 *  ② **根与目标都要先取真落点再比**。只对目标取会**假阳**：cwd 自己就是个符号链接时
 *     （macOS 的 `/tmp` → `/private/tmp` 是常态、Windows 上把项目挂在 junction 下同理），
 *     声明与真落点都在真实子树里，但拿去跟**没取真落点的 cwd** 比就"出界"了。
 *  ③ 判定复用 `isUnder`（**同一份代数**，不另写一套比较）。而且 Windows 上 `path.relative`
 *     **大小写不敏感**（2026-09-19 探针实测：`relative(MixedCase, MIXEDCASE/f)` 得 `f`），
 *     所以解析器把大小写规范成磁盘上的写法（`realpathSync.native` 的行为）不会造成假阳。
 *
 * **fail-open**：没注入解析器 → 不追（返回 undefined）；解析器抛异常 → 也返回 undefined。
 * 判据的否定方向（"出界了"）要求证据确凿，**追不动就没有证据** —— 同三道闸的立场。
 */
export function findTraversal(
  declaredAbs: string,
  ctx: WorkspaceContext,
): string | undefined {
  const rp = ctx.realpath;
  if (!rp) return undefined;
  try {
    const realTarget = rp(declaredAbs);
    for (const root of [ctx.cwd, ...ctx.grants]) {
      if (!isUnder(root, declaredAbs)) continue; // ① 声明就不在这个根里，不是它的责任
      if (!isUnder(rp(root), realTarget)) return root; // ② 两侧都取真落点再比
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 第二步的教学拒因 —— 与 `renderWorkspaceReason` **同族不同因**，所以两者共用
 * `WORKSPACE_MARK`：它们回答的是**同一个问题**（"这次写会不会落到工作区外"），
 * 只是判据换了一步（声明路径 / 真落点）。
 *
 * 一处刻意与第一步**分开**的地方：这里的三条出路**不是**"`/workspace allow` 那个目录"
 * —— 那条路解决不了问题（声明路径本来就在项目里，放行它没有意义），真正的出路是
 * "中间某一段是个链接，改用真实路径"。**方向给错比不给更坏。**
 */
export function renderTraversalReason(
  target: string,
  declaredAbs: string,
  realAbs: string,
  root: string,
): string {
  return [
    `${WORKSPACE_MARK} 这条调用没有被执行：路径**看着**在工作区里，追下去却落在外面（符号链接 / junction）。`,
    `  声明的路径 = ${declaredAbs}`,
    `  真落点     = ${realAbs}`,
    `  它出界于   = ${root}`,
    '  三条出路：',
    '    · 目标本来就是项目里的文件 —— 中间有一段（目录或文件）是符号链接，指向了项目外面。'
      + '先 ls 看一眼它的真实指向，再用真路径写一次；',
    '    · 确实要写到链接指向的那个地方 —— 那就按"项目外的目录"办：把"写哪个文件、为什么"'
      + '讲给用户听，请他执行 /workspace allow <目录>（**仅本会话有效**，含其子树）；',
    '    · 只是要看外面的文件 —— 用 read。这道闸只管写。',
    `  （说明：目标原文「${target}」，与上面两条实路径可能只差一个链接。它不是沙箱。）`,
  ].join('\n');
}

/**
 * 教学拒因 —— 与 10.9.2 的 `renderDangerReason` **同形**（同族的两条拒绝读起来该像一家人）：
 * 命中什么 · 这一条**没被执行** · 三条出路 · 末段自认边界。
 *
 * 一处刻意的省略：字面量本身就等于解析结果时（绝大多数绝对路径）**不再重复印一遍** ——
 * 拼接放大型的噪音在本仓记过多次，能少印一行就少印一行。
 *
 * 另一处刻意的省略：**不在这里提 `--save`**（长期放行，ROADMAP 10.9.1）。这条拒因是递给
 * **模型**的，而模型转述它的时刻恰好是用户"正被挡住、只想把挡路的东西挪开"的那一刻 ——
 * 由模型主动提示一个"永久放行"的选项，等于把这个决定从用户手里挪进了模型的措辞里。
 * 长期放行的发现路径应当是用户自己敲一句 `/workspace` 看到用法（那里写着 `--save`），
 * 与"落盘不是默认、要用户说出口"是同一条取舍。
 */
export function renderWorkspaceReason(target: string, ctx: WorkspaceContext): string {
  const abs = path.resolve(ctx.cwd, target);
  const root = path.resolve(ctx.cwd);
  const same = abs.replace(/\\/g, '/') === target.replace(/\\/g, '/');
  return [
    `${WORKSPACE_MARK} 这条调用没有被执行：目标落在工作区之外。`,
    same ? `  目标 = ${abs}` : `  目标「${target}」解析后 = ${abs}`,
    `  工作区 = ${root}（含其全部子目录）`,
    '  三条出路：',
    '    · 目标本来就在项目里 —— 多半是路径写错了（落到了兄弟目录或上级目录）。先用 ls 看清项目根在哪，再用项目内的相对路径写一次；',
    '    · 确实要写到项目外 —— 把"写哪个文件、为什么"讲给用户听，'
      + '请他执行 /workspace allow <目录> 放行那个目录（**仅本会话有效**，含其子树）。'
      + '这是**唯一**的开门动作，模型自己开不了；',
    '    · 只是要看外面的文件 —— 用 read。这道闸只管写。',
    '  （说明：这道闸只管 write / edit 的**目标路径参数**；bash 的目标藏在命令串里'
      + '（读和写长得一样），判不出来、刻意不判；符号链接会追真落点另判（见本闸第二步）。'
      + '它不是沙箱。）',
  ].join('\n');
}

/**
 * 钩子适配器 —— 探针与套件都从这里进（**唯一实现**，别在 main.ts 就地写一份）。
 *
 * fail-open 的边界与钩子契约一致：工具名不认识、args 形状不对、`path` 不是字符串或为空，
 * 一律**放行**（钩子是基础设施不是策略，写错了不能让所有文件写入集体瘫痪）。
 * `ctx` 缺省时才去读 `process.cwd()` 与模块级放行表 —— 这样默认行为跟着 chdir 走
 * （`/projects --switch` 之后立刻用新 cwd 判定），而套件可以完全脱离环境注入。
 */
export function guardWorkspaceWrite(
  toolName: string,
  args: unknown,
  ctx?: WorkspaceContext,
): HookDeny | undefined {
  if (!GUARDED_WRITE_TOOLS.has(toolName)) return undefined;
  if (typeof args !== 'object' || args === null) return undefined;
  const target = (args as { path?: unknown }).path;
  // ⚠ 这里原有一支 `|| target.trim() === ''`（"全空白也算没有目标"）——**已按探针实证删掉**：
  //   空白路径 `path.resolve(cwd, '   ')` 必然落在工作区**之内**，于是它怎么判都是放行，
  //   那一支**永远改不了结论**（变异 M14 全绿 = "没有断言看得见它"，就是那句判决书）。
  //   真正需要 fail-open 的是"非字符串"——那一支的必要性由 C9 钉着：去掉它，
  //   `path.resolve(cwd, 42)` 会当场抛，套件崩在中途（M14b 按预期崩溃）。
  if (typeof target !== 'string') return undefined;

  const c = ctx ?? { cwd: process.cwd(), grants: workspaceGrants.list() };
  const abs = path.resolve(c.cwd, target);

  // 第一步：**声明的**目标路径落在工作区之外 → 拒（本闸原有的那一半，纯字符串代数）
  if (isOutsideWorkspace(target, c)) {
    return { action: 'deny', reason: renderWorkspaceReason(target, c) };
  }

  // 第二步（ROADMAP 10.9.5）：声明在内，但**真落点**出了那个根 —— 符号链接穿越。
  // 顺序刻意如此：第一步更便宜、更确定、拒因更通用（"路径写到项目外去了"）；
  // 第二步只在第一步已放行、且注入了解析器时才跑，代价（两次 fs）只落在真要写的调用上。
  const escapedRoot = findTraversal(abs, c);
  if (escapedRoot && c.realpath) {
    return {
      action: 'deny',
      reason: renderTraversalReason(target, abs, c.realpath(abs), escapedRoot),
    };
  }

  return undefined;
}

/**
 * 外写放行表 —— 会话级单例（进程内）。**这张内存表本身永不落盘**：
 * "长期"那一份在 `permission/grants.ts`（磁盘 → 播种时栽进来 → 到了这里仍然只是一张内存表）。
 *
 * 存的是"用户点过名的目录"（绝对路径）。放行一个目录 = 放行它**及其子树**，
 * 因为外写的真实用法是"往某个地方连着写几个文件"，逐文件放行会把体验做坏
 * （而体验坏了，用户就会去关闸 —— 那比漏拦更坏）。
 *
 * 写入口有两个，**可信度来源不同，所以刻意是两个方法**（别顺手合成一个）：
 *   · `allow()` —— **用户开门**：唯一调用方是 `/workspace` 命令（verify-workspace 的 G13 钉着）；
 *   · `fill()`  —— **播种**：把用户已经写在盘上的名单栽回内存，唯一调用方是
 *                   `seedProjectContext()`，且它按"先清后栽"写成 `clear()` + `fill()`。
 */
export const workspaceGrants = {
  dirs: [] as string[],

  /** 放行一个目录（含其子树）。返回**归一化后的绝对路径**，回执要用它 */
  allow(dir: string, cwd: string = process.cwd()): string {
    const abs = path.resolve(cwd, dir);
    if (!this.dirs.includes(abs)) this.dirs.push(abs);
    return abs;
  },

  /**
   * 用一批目录**填充**放行表（**不**先清空 —— 清空是调用方显式的一步）。
   *
   * 刻意不自带清空的两个理由：
   *   ① 与另三个 store 的 `reset()` + `loadFromFile()` 配成同一个形状，"先清后栽"在
   *      调用点**看得见**；自带清空会让调用点只剩一步，"忘了清"这件事就再也看不出来了
   *      （而症状是上一个项目放行的目录静默留着）。
   *   ② 它与 `allow()` 的可信度来源不同（见上面那段块注释），合成一个方法之后
   *      "到底谁在开门"就说不清了。
   * 逐个走 `allow()` 而不是自己 push：归一化与去重只留一份实现。
   */
  fill(dirs: readonly string[], cwd: string = process.cwd()): void {
    for (const d of dirs) this.allow(d, cwd);
  },

  /** 当前放行的目录（副本 —— 调用方改它不该影响状态） */
  list(): string[] {
    return [...this.dirs];
  },

  /**
   * 清空放行表。三个调用方**同一个动作**：用户敲 `/workspace clear`、
   * 播种时复位（`seedProjectContext`，**紧接着 `fill()` 栽回本项目自己的那一份**）、
   * 验证脚本在用例之间擦干净单例状态。
   * 不另起 `reset()` 别名 —— 初始态就是空表，`clear` 已经把语义说完了。
   */
  clear(): void {
    this.dirs.length = 0;
  },
};
