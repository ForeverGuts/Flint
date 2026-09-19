/**
 * 审计留痕的**统一落点**（ROADMAP 10.9.4）—— 三个调用方共用这一份组装逻辑：
 *   · harness/main.ts                 钩子链拦下一件工具调用（四道闸 / 路由）
 *   · runtime/runtime.ts              权限弹窗上用户做的决定（拒绝 / 本次全部允许）
 *   · commands/builtin/workspace.ts   放行一个目录（本会话 / 长期）与收回全部放行
 *
 * ── 为什么集中在这里，而不是各处就地拼 recordAudit(...) ──
 *   ① **只有一份定义** —— 闸名、标签、截断口径不会出现"钩子链记「工作区外写」、命令层记
 *      「workspace 闸」"这种两种写法（同一件事两种字面，检索时就是两拨结果）；
 *   ② **可测** —— 套件直接调这几个函数逐条打靶，不必真起进程，也不必碰 runtime 的私有方法；
 *   ③ 调用点各自只剩一行，读代码时"这里是留痕"一眼可见。
 *
 * 条目形状、内存索引、落盘与静默失败仍然归 eventlog/store.ts 的 `recordAudit` ——
 * 本文件只回答"这次动作算审计里的哪一种、写什么字"，不碰文件。
 *
 * ── 记什么、不记什么（这条边界是本模块存在的理由）──
 *   只记**边界决定**：被闸拦下 · 用户拒绝 · 用户给出"本次全部允许" · 放行 / 收回目录。
 *   **不记**一次性的"允许"与正常执行的调用 —— 它们不改变任何授权状态，而每一次调用
 *   已经由 tool-calls.jsonl 流水全量记下了（**含被拦的那些**：钩子拒了工具不执行，但
 *   start/end 事件成对发过，span 照样收束）。审计再记一遍就是双份噪音。
 *
 * ── 目标摘要判据按**参数形状**走，不按工具名 ──
 *   刻意不写"如果工具是 write 就取 path"：那样每加一个受管工具就得回来改一次，而漏改的
 *   症状是**审计条目里目标一片空白**（不报错、也没人会注意到）。改成"谁有 `path` 就用
 *   `path`、谁有 `command` 就用 `command`"，与工具名解耦：闸现在拦 write / edit / bash，
 *   这三种恰好都落在前两个键上，将来加工具也自动跟上。
 *
 * ── 截断口径 ──
 *   与 eventlog/store.ts 里 recordToolCall 的 argsDigest **同长度**（200 字符），
 *   于是审计条目与流水条目对同一条 bash 命令的暴露面**完全相同** —— 本模块不新增泄露面。
 *   bash 命令串里可能夹着 token，这条口径的存在不是为了审计好看，是为了不多露一个字节。
 */
import { EVENTS_FILE, eventStore } from '../eventlog/store.js';

/** 摘要长度上限（见头注：与流水的 argsDigest 同口径） */
export const DIGEST_LIMIT = 200;

/** 按顺序取第一个非空字符串作为目标（见头注：按形状、不按工具名） */
const DIGEST_KEYS = ['path', 'command'] as const;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * 拒因只留**第一行**。
 *
 * 拒因全文是**递给模型**的（教学理由 + 三条出路，几百字），它的读者与审计条目的读者不是
 * 同一批人：模型要的是"我该怎么办"，查账的人要的是"为什么被拦"。把全文抄进审计条目，
 * `/events` 一屏就只能放两条，而且那几百字在模型的 tool 结果里**本来就有**。
 * 所以这里只取第一行 —— 四道闸的拒因首行恰好都是一句话结论（危险闸/工作区闸/路由那三条
 * 是多行信，契约锁那条本身就是单行）。
 *
 * ⚠ 这里的**前置条件**是"拒因不含前导空行"。原先写成"跳过空行找第一个非空行"，
 * 变异探针显示那一支**没有任何断言看得见它、也没有任何调用方走得到**（四条拒因字面
 * 都以内容开头）—— 于是删掉，改成直白的"取第一行"。前置条件改由套件在**产出侧**守：
 * B20 拿一条合成的多行拒因打靶，D8b/D9b/D10b 三个**真实**多行拒因（危险闸 / 工作区闸 /
 * 路由）各打一次 —— 将来谁把整封信抄进审计，红的是那几条断言（指着产出拒因的那个文件），
 * 而不是在这里对着一个空 outcome 猜。
 *
 * ⚠ 另一个坑（套件踩过）：落库那一步（`eventlog/store.ts` 的 `opt`）会先把**所有空白
 * 折叠成单个空格**，所以审计的 outcome 里根本不可能出现 `\n` —— 判据要是写成
 * "outcome 不含换行"，它就是恒真的空断言，怎么改代码都不会红。真正能分辨的判据是
 * "**第二行的内容不许出现**"（见 verify-audit 的 D8b）。
 */
function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').trim();
}

/**
 * 目标摘要。挑不出来（参数不是对象 / 没有这两个键 / 空对象）→ `undefined`，
 * 由调用侧决定"没有目标就不写 context 键"（条目不写空壳）。
 *
 * 兜底用整串 JSON（截同样长度）：宁可记一段粗糙的，也别让审计条目变成
 * "拦了，但不知道拦的是什么"——那正是这条审计要治的病。
 */
export function targetDigest(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  for (const key of DIGEST_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim() !== '') return clip(v.trim(), DIGEST_LIMIT);
  }
  const json = JSON.stringify(rec);
  if (json === undefined || json === '{}') return undefined;
  return clip(json, DIGEST_LIMIT);
}

/**
 * 闸拦下 / 路由改道（从 harness/main.ts 的钩子链调）。
 *
 * `source` 是给人看的闸名、`tag` 是机器可读分类 —— 两个都要，因为它们的读者不同：
 * 人按 source 读懂"被谁拦的"，套件与检索按 tag 精确圈出"哪道闸的动作"。
 * `toolName` 空串一律记成 '(未知工具)'（**只影响显示**：main.ts 传给闸的仍是原值 ''，
 * 判据的 fail-open 口径不因为这里要显示而改变）。`reason` 空则不写 outcome 键。
 */
export function recordGateDeny(input: {
  source: string;
  tag: string;
  toolName: string;
  args: unknown;
  reason?: string | undefined;
}): void {
  const target = targetDigest(input.args);
  eventStore.recordAudit({
    action: 'deny',
    subject: input.toolName === '' ? '(未知工具)' : input.toolName,
    source: input.source,
    tag: input.tag,
    ...(target !== undefined ? { target } : {}),
    ...(typeof input.reason === 'string' && firstLine(input.reason) !== ''
      ? { reason: firstLine(input.reason) }
      : {}),
  }, EVENTS_FILE);
}

/**
 * 放行一个目录（`/workspace allow`，从命令层调）。**授予已经生效之后**才调它 ——
 * 所以这里无条件记，`persistError` 只影响那句话怎么说（长期化失败 ≠ 这次放行没发生）。
 */
export function recordGrant(dir: string, save: boolean, persistError?: string | undefined): void {
  const reason = !save
    ? '本会话有效，重启后失效'
    : persistError === undefined
      ? '长期有效，重启后自动回来'
      : `仅本会话有效；长期化失败：${persistError}`;
  eventStore.recordAudit({
    action: 'grant',
    subject: dir,
    source: save ? '长期' : '本会话',
    reason,
    tag: 'workspace',
  }, EVENTS_FILE);
}

/**
 * 收回本项目全部放行（`/workspace clear`，从命令层调）。
 * **只在真的撤销了东西时调**：一次什么都没撤销的 clear 不改变任何账目，记它只是噪音
 * （与"只记边界决定"同一条）—— 那个判据留在命令层（它才知道 had / removed）。
 */
export function recordRevoke(had: number, removed: number, error?: string | undefined): void {
  const base = `本会话 ${had} 条 + 盘上 ${removed} 条已收回，重启后不会自己回来`;
  // 刻意**不给 source**：撤销动的是"本会话 + 盘上"两份，任何单一来源名都是错的说法
  eventStore.recordAudit({
    action: 'revoke',
    subject: '本项目的外写放行',
    reason: error === undefined ? base : `本会话 ${had} 条 + 盘上 ${removed} 条；盘上那部分没能清掉：${error}`,
    tag: 'workspace',
  }, EVENTS_FILE);
}

/**
 * 权限弹窗上的决定（从 runtime.askPermission 调）。`picked === undefined` 是 Ctrl+C 取消
 * （调用方已把它等同于拒绝）。
 *
 * **`'allow'`（允许一次）刻意不记** —— 见头注"记什么、不记什么"。非 TTY / RPC 下选择器
 * 直接返回第一项（允许一次），于是自动化场景不会在这里留下任何条目，与"自动放行"的事实一致。
 */
export function recordPermissionChoice(
  toolName: string,
  detail: string,
  picked: 'allow' | 'deny' | 'always' | undefined,
): void {
  if (picked === 'allow') return;
  const always = picked === 'always';
  eventStore.recordAudit({
    action: always ? 'grant' : 'refuse',
    subject: toolName === '' ? '(未知工具)' : toolName,
    source: '权限弹窗',
    target: detail,
    reason: always
      ? '用户选择「本次全部允许」—— 同一目标在本会话内不再询问'
      : (picked === undefined ? '弹窗被取消（等同于拒绝），本次不执行' : '用户在弹窗上选择拒绝，本次不执行'),
    tag: 'permission',
  }, EVENTS_FILE);
}
