/**
 * 任务 ↔ 提交关联的**接缝**（ROADMAP 10.5.4）。
 * 调用方：tools/builtin.ts 的 `git_write`（commit 成功后）+ scripts/verify-git-write.ts。
 * 服务于：提交完，任务清单里那一项能挂上"它被落在哪个提交里"；反过来，回看时能知道
 *         某次提交是为了哪一项任务做的。
 *
 * ── 缺口原样 ──
 * 提交与任务此前是**两个互不相干的世界**：git 只知道 hash 与消息，任务清单只知道文本与状态。
 * 唯一能连起来的办法是模型自己在任务正文里手抄一个 hash —— 那会污染正文（它于是成了
 * "显示文本"的一部分，还要进 encode/decode 的那套前缀码），而且**没人会真的去做**。
 * 结果是两头各丢一半信息：清单看不出活儿提交在哪，提交看不出它是为哪件活儿做的。
 *
 * ── 为什么单独成一个文件 ──
 * 它讲的是"两个子系统怎么连起来"，而两边都不该为对方破例：
 *   · `write.ts` 的立身之本是"只管 git 命令行长什么样、零 I/O"；让它去 import 任务清单，
 *     那句"零依赖"就得改成"除了任务清单"；
 *   · `todo/store.ts` 的立身之本是"零依赖的纯数据结构"；让它去 import 事件库，同理破例。
 * 把接缝单独放一处，两边都保持原样，代价是多一个 60 行的文件。
 *
 * ── 三条承重的判据 ──
 * ① **关联必须由调用方声明，不自动猜。**
 *    不做"自动关联当前进行中的那一项"：提交是**不可逆动作的结果**，而猜错的形态是
 *    ——清单里静静挂着一个错误的 hash，不报错、不冲突、没有任何症状。何况"这次提交属于
 *    哪一项"常常不是 active 那项（一次性提交可能覆盖了清单里前三项）。
 *    ⇒ `index = 0`（缺省）就是"不关联"，回执里明说，**不猜**。
 * ② **能在事前判定的错，别拖到事后报。**
 *    序号越界（清单只有 3 项却写 7）在提交**之前**就判得出来。若等 git 跑完再说
 *    "第 7 项不存在"，模型只能面对一个既成事实干瞪眼 —— 提交已经落进仓库了。
 *    ⇒ `taskLinkError()` 供调用方在跑 git **之前**调用；`linkCommitToTask()` 里那层
 *    越界判定只是**防御**（store 是共享单例，两次调用之间清单可能被改），不是主防线。
 * ③ **提醒可以做进程序，决定不行**（`suggestTaskLink()`）。
 *    判据 ① 说"别猜"，但那不等于"让用户自己记得说" —— 人会忘，忘了这个功能就等于没做。
 *    拆开看是两件事，能各自取最优：
 *      · **提醒**必须**必然出现** ⇒ 写进 `add` 的回执里（模型每回都看得到，不像提示词
 *        那样会被上下文挤掉或忽略）；
 *      · **决定**仍然归人 ⇒ 文案里明说"先问用户"。模型自己拍板就是回到猜，只是猜的人
 *        从代码换成了模型，**错法一模一样**（清单里静静挂着一个不对的 hash）。
 *
 * ── 刻意不做 ──
 * · **不顺手把那项标成完成**：提交 ≠ 那件活儿干完了（可能还要推、还要验证）。一件事只做一件。
 * · **不碰 git**：hash 是调用方给的（它来自 `log -1` 的复核），本模块不自己去查。
 * · **不记"没连上"的事件**：只有真建立了关联才留一条 —— 说"连上了"却没连上的记录比没有更坏。
 *
 * 只 import **类型**（编译期擦除）：运行时零依赖、不起进程、不碰 fs，于是每条分支
 * 都能脱离终端与真实仓库打靶（套件里传真的 TaskStore / EventStore 即可）。
 */
import type { EventStore } from '../eventlog/store.js';
import type { TaskStore } from '../todo/store.js';

/** 一次"提交已完成、要不要把它挂到任务上"的请求 */
export interface CommitLinkRequest {
  /** 任务序号（1 基）。**0 = 不关联**（缺省就是这个值，见文件头判据 ①） */
  index: number;
  /** 本次提交的短 hash（来自 `log -1` 的复核） */
  hash: string;
  /** 提交说明的首行（进事件库，让查账的人知道连的是哪次提交） */
  subject: string;
  /** 事件库落点（由调用方给 —— 本模块不猜路径） */
  file: string;
}

export interface CommitLinkResult {
  /** 是否真的挂上了 */
  linked: boolean;
  /** 给模型看的一句结果（拼进工具回执）。**没请求关联时是空串** —— 那时不该有任何文案 */
  text: string;
}

/**
 * `add` 成功之后的**提醒**：这次提交要不要关联到任务、候选是哪几项。
 *
 * 没有候选 → `null`（调用方据此让回执**逐字不变**）。候选 = 状态为 `active` / `done` 的项：
 *   · **`pending` 刻意不算候选** —— 还没开头的活儿挂到一个提交上，读者会以为它做完了；
 *   · **已经挂过 hash 的项不排除** —— 一件活儿分几次提交很常见，排掉反而漏提醒。
 *
 * ── 时机为什么是 `add` 之后，而不是 `todo done` 之后 ──
 * 三个候选点里只有它同时满足"来得及"与"信息新鲜"：
 *   · `todo done` 之后**太早**：那时通常还没改完、更没暂存，提醒了也提交不了，
 *     而且一次性提交常常覆盖清单里好几项，"刚完成的那一项"未必是答案；
 *   · `commit` 之后**太晚**：提交已经落进仓库、撤不回来，那时再说"要不要关联"
 *     只能干瞪眼（本模块也刻意不做事后补关联 —— 那等于鼓励"先提交再说"）；
 *   · `add` 之后正好：改动已暂存 ⇒ 下一步就是提交，且此刻的清单状态是新鲜的。
 */
export function suggestTaskLink(store: TaskStore): string | null {
  const cand: Array<{ n: number; t: string }> = [];
  store.list().forEach((it, i) => {
    if (it.status === 'active' || it.status === 'done') cand.push({ n: i + 1, t: it.text });
  });
  if (cand.length === 0) return null;
  // 只列最近三项：清单可以很长，全列出来等于没提醒（顺序靠后 = 更晚建的，也更像本次的活儿）
  const shown = cand.slice(-3);
  const list = shown.map((c) => `${c.n}「${clipTaskText(c.t)}」`).join('、');
  const more = cand.length > shown.length ? `，还有 ${cand.length - shown.length} 项未列出` : '';
  return `提交时可以用 task=<序号> 把这次提交关联到任务清单里的某一项（候选：${list}${more}）。\n`
    + '⚠ **先问用户**"要不要关联、关联哪一项"再带这个参数，别自己拍板 —— '
    + '猜错了的形态是清单里静静挂着一个不对的 hash，不报错也不冲突。用户说不用，就别带。';
}

/** 任务文本截断（回执要短，长正文会把真正要紧的那句提示挤下去） */
function clipTaskText(t: string): string {
  const s = t.trim();
  return s.length <= 24 ? s : `${s.slice(0, 24)}…`;
}

/**
 * **事前**判定：这个序号能不能关联得上。能 → null；不能 → 给模型看的原因。
 *
 * `index <= 0` 一律**不是错**（那是"不关联"的声明），所以返回 null。
 */
export function taskLinkError(store: TaskStore, index: number): string | null {
  if (index <= 0) return null;
  const total = store.list().length;
  if (index > total) {
    return `task=${index} 超出了当前清单的范围（一共 ${total} 项）。`
      + '这次 commit **没有执行** —— 序号这种错误在提交之前就该说清，'
      + '等提交落进仓库再发现就来不及了。要么给一个 1 到 ' + total + ' 之间的序号，要么留空（= 不关联）。';
  }
  return null;
}

/**
 * 提交成功之后：把 hash 挂到任务项上，并在事件库留一条。
 *
 * 三态（与 `linked` 一一对应）：
 *   · 没请求关联（index <= 0）→ **什么都不做**，text 空串（连事件也不记）；
 *   · 请求了但挂不上（越界 / hash 空）→ text 说清"提交成了、关联没成"，**不记事件**；
 *   · 挂上了 → 记事件 + 回一句"已关联第 N 项"。
 */
export function linkCommitToTask(
  store: TaskStore, evs: EventStore, req: CommitLinkRequest,
): CommitLinkResult {
  if (req.index <= 0) return { linked: false, text: '' };
  if (req.hash.trim() === '') {
    return { linked: false, text: '提交成功，但没能拿到这次提交的 hash，任务关联没做成。' };
  }
  if (!store.attachCommit(req.index, req.hash)) {
    const total = store.list().length;
    return {
      linked: false,
      text: `提交成功，但任务关联没做成：task=${req.index} 不在当前清单里（一共 ${total} 项）。`
        + '提交本身已经落进仓库了，要补这个关联请再调 todo 记一笔，或下次提交时带上正确的序号。',
    };
  }
  const item = store.list()[req.index - 1];
  const taskText = item?.text ?? '';
  // 事件库只在这一刻记：真连上了才值得留一条（见文件头"刻意不做"）
  evs.recordCommit({ hash: req.hash, subject: req.subject, task: req.index, taskText }, req.file);
  return {
    linked: true,
    text: `已关联到任务第 ${req.index} 项「${taskText}」（提交 ${req.hash}）。`,
  };
}
