/**
 * 分叉点（技术选型决策点）—— 提问、分类、回话文本。ROADMAP P10.12.x / 新增能力。
 *
 * 调用方：`src/tools/builtin.ts` 的 `ask` 工具（第 12 个内置工具）、`scripts/verify-fork.ts`。
 * 服务于：模型在**技术选型分叉点**上不再自己脑补一个方案往下冲，而是**截断当前行为**、
 *   把问题抛给用户，等用户拍板或要求先讨论。
 *
 * ── 它治的是什么病 ──
 * 模型的默认行为是"把不确定的地方悄悄替你定掉"：你说"加个存储层"，它自己选了
 * "每会话一个 JSONL 文件"，然后按这个前提写了 300 行。等你看出来时，返工成本已经付了。
 * 根因不是它笨，是它**倾向于顺从**（顺从被解读成"立刻开工"）。分叉点机制就是把
 * "这里有一个必须由人拍板的选择"从模型的内心戏变成**一次阻塞式提问**。
 *
 * ── 两条出路（用户 2026-09-14 拍板的语义）──
 *   ① 确定技术选型 —— 用户当场选一个，之后这条决定要落到路线图 / DEVLOG。
 *   ② 保留选项，先讨论 —— 不选，先把"问题是什么 / 矛盾点是什么 / 抉择的对象是什么"
 *      聊清楚（用 `grill-me` 技能的方式：一次一问、附推荐答案），聊完再把分叉点抛回来。
 *
 * ── 三条刻意的设计取舍 ──
 * ① **无终端时绝不自动选**（fail-closed）。权限弹窗在非 TTY 下回落"允许一次"（放行），
 *    那是因为"放行"至少不拦事；而**替用户在 A/B 之间选一个**是完全不同性质的事——
 *    那会把"人工决策点"静默变成"默认取第一个"，比不提供这个功能还糟。
 *    故 `ask` 在无交互终端时返回"问不了"，让模型改用文字提问（人还是能看到并回答）。
 * ② **不接权限子系统**（同 C11 的判据）。权限回答"这次调用要不要跑"，分叉点回答
 *    "这个设计该选哪条路"——混进同一个授权键空间，"本次全部允许 write" 会顺带把
 *    提问通道也静默打开。
 * ③ **决定要留痕由程序做，落到路线图由模型做**。用户拍了板这件事是**事实**，
 *    不该依赖模型记得去记（它可能忘）；而"这个决定该写进路线图的哪一行、怎么措辞"
 *    是**判断**，程序做不了。故：事件库由工具确定性写入，路线图由模型按指令改。
 *
 * 零运行时依赖：纯函数 + 字面量（连 node 内置都不需要）。
 */

/** 「先讨论」在选项列表里的哨兵值。用一个不可能与候选撞车的形状（候选是按序号的） */
export const DEFER_VALUE = '__defer__';

/**
 * 「先讨论」时模型必须先问清的三件事 —— **逐字**来自用户 2026-09-14 的原话：
 * "目前遭遇的问题是什么？或者需要进行思考的矛盾点是什么？抉择的对象是什么？"
 * 提示词（core-section.ts）里那几句与这里是同一套字，由 verify-fork 交叉比对——
 * 两边各存一份迟早分家。
 */
export const DISCUSS_QUESTIONS = [
  '目前遭遇的问题是什么？',
  '需要思考的矛盾点是什么？',
  '抉择的对象是什么？',
] as const;

/** 讨论技能的名字（`<cwd>/skills/` 下的文件；flint 的技能是纯 markdown） */
export const DISCUSS_SKILL = 'grill-me';

/** 一个候选方案 */
export interface Candidate {
  /** 序号值（0 基的字符串）。选择器回传的就是它，不拿标签当键——标签可能重复 */
  value: string;
  /** 候选名（短），如 "A 单文件"、"SQLite" */
  label: string;
  /** 取舍说明（可空） */
  description: string;
}

/** 选择器条目的形状（与 `src/io/ui/selector.ts` 的 SelectorChoice 结构一致，刻意不 import） */
export interface Choice {
  value: string;
  label: string;
  description?: string;
}

/**
 * 提问函数：把问题与选项交给 UI，等用户选，返回选中项的 value。
 * **返回 null = 这个环境问不了**（非 TTY / RPC / 用户 Ctrl+C 取消），由调用方降级为文字提问。
 */
export type AskFn = (question: string, choices: Choice[]) => Promise<string | null>;

/**
 * 缺省提问函数：**永远答"问不了"**。
 * 这是安全的那一侧：工具层不 import 任何 UI 模块（否则 RPC 模式会把 io 层拖进启动路径，
 * 而 io 层是允许往 stdout 写字的——`rpc.ts` 的 stdout 必须一行一个 JSON）。
 * 真正的交互实现由 main.ts 在 TTY 侧注入（`src/io/ui/fork-prompt.ts`），
 * 测试与 RPC 走这个缺省值，行为是"降级为文字提问"而不是"静默替用户选"。
 */
export const NO_INTERACTION: AskFn = async () => null;

/* ═══════════════════════════════════════════════════════════════════════════════
   解析候选
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 把 `options` 参数解析成候选列表。
 *
 * 为什么是分隔字符串而不是数组参数：本项目 `tools/spec.ts` 只提供 5 种**标量**形状
 * （str / strAllowEmpty / optStr / optPosInt / optBool），刻意没有数组形状——那是有意的
 * 克制（数组参数会引出嵌套校验、部分成功等一堆要维护的死代码）。故沿用 `record_event`
 * 的 tags 那套写法：用分隔符表达列表。
 *
 * 分隔符认 `|` / `｜` / 换行（模型三种都可能用）。每项按**第一个**冒号拆成
 * `标签` 与 `说明`（写 `SQLite: 单文件、零依赖` 就是"标签 + 取舍"）；
 * 没有冒号时整项当标签。空项丢弃。
 */
export function parseCandidates(raw: string): Candidate[] {
  const out: Candidate[] = [];
  for (const part of raw.split(/[|｜\n]/)) {
    const item = part.trim();
    if (item === '') continue;
    const m = item.match(/^([^:：]*)[:：]([\s\S]*)$/);
    const label = (m ? m[1] : item).trim();
    const description = (m ? m[2] : '').trim();
    if (label === '') continue;
    out.push({ value: String(out.length), label, description });
  }
  return out;
}

/** 候选 → 选择器条目，末尾追加一条「先讨论」（顺序即显示顺序，讨论永远在最后=默认不选） */
export function buildChoices(candidates: Candidate[]): Choice[] {
  return [
    ...candidates.map((c) => (c.description
      ? { value: c.value, label: c.label, description: c.description }
      : { value: c.value, label: c.label })),
    { value: DEFER_VALUE, label: '保留选项，先讨论', description: '不拍板：先把问题与矛盾点聊清楚' },
  ];
}

/**
 * 选择器标题：`🔀 问题 —— 背景`（背景可省）。
 *
 * **必须压成单行**（所有空白含换行压成单个空格）：selector 的"固定行数 + 回退清行"不漂移
 * 策略依赖行数恒定，标题里带 `\n` 会多出一个物理行，回退就算错 → 选择器漂移。
 * 与 `tools/builtin.ts` 里 edit / bash 的 `permissionDetail` 是同一条约束、同一个手法。
 */
export function buildForkTitle(question: string, context: string): string {
  const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const q = flat(question);
  const c = flat(context);
  return c === '' ? `🔀 ${q}` : `🔀 ${q} —— ${c}`;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   分类与回话文本
   ═══════════════════════════════════════════════════════════════════════════════ */

export type ForkOutcome =
  /** 用户当场拍板选了第 index 个候选 */
  | { kind: 'decide'; candidate: Candidate }
  /** 用户要求先讨论 */
  | { kind: 'discuss' }
  /** 没有可交互终端（或用户取消）——没做任何选择 */
  | { kind: 'unavailable' };

/**
 * 把选择器的回传值分类。`null`（取消 / 无法提问）、`DEFER_VALUE`、候选序号三路。
 * 认不出的值（不可能出现，除非选择器被换掉）按"没做选择"处理——**不猜**。
 */
export function classifyChoice(value: string | null, candidates: Candidate[]): ForkOutcome {
  if (value === null) return { kind: 'unavailable' };
  if (value === DEFER_VALUE) return { kind: 'discuss' };
  const candidate = candidates.find((c) => c.value === value);
  return candidate ? { kind: 'decide', candidate } : { kind: 'unavailable' };
}

/** 候选列表的纯文本形态（写进"先讨论"/"问不了"两条回话里，让模型不必回头翻参数） */
export function formatCandidates(candidates: Candidate[]): string {
  return candidates
    .map((c, i) => `  ${i + 1}. ${c.label}${c.description ? ` —— ${c.description}` : ''}`)
    .join('\n');
}

/**
 * 生成 `ask` 工具回给**模型**的文本（不含 `[OK]` 前缀，前缀由 spec.ts 的构造器加）。
 * 三段各自把"接下来该干什么"写死——回话文本就是给模型的指令，含糊了它就会自己发挥。
 */
export function formatForkResult(
  question: string,
  context: string,
  candidates: Candidate[],
  outcome: ForkOutcome,
): string {
  const head = `分叉点：${question.trim()}${context.trim() ? `\n背景：${context.trim()}` : ''}\n候选方案：\n${formatCandidates(candidates)}`;

  if (outcome.kind === 'unavailable') {
    return `${head}\n\n⚠ 未做任何选择：当前环境没有可交互终端（管道 / RPC 模式），弹不出选择框。`
      + `\n请在回复里把这个分叉点**直接讲给用户**：一句话说清卡在哪、逐个列出候选方案与取舍、给出你的推荐，`
      + `然后停下来等答复。\n不要替他选，也不要假装问过了。`;
  }

  if (outcome.kind === 'discuss') {
    return `${head}\n\n用户选择：**保留选项，先讨论**（没有拍板）。`
      + `\n决定已按 kind=decision 记入事件库（标题带"待讨论"）。`
      + `\n现在**不要**继续往下做，也不要替用户选。按下面的方式把这件事讨论清楚：`
      + `\n- 先读取并遵循 \`skills/${DISCUSS_SKILL}.md\`：把决策当成一棵树，**一次只问一个问题**，`
      + `每个问题**附上你的推荐答案与理由**；能自己读代码确认的，就别拿去问用户。`
      + `\n- 先把这三件事问清楚（逐字照问，不要合并成一段）：`
      + DISCUSS_QUESTIONS.map((q, i) => `\n  ${i + 1}. ${q}`).join('')
      + `\n- 讨论收口后，把分叉点**重新抛给用户拍板**（再次调用 ask，或直接在回复里列方案请用户选）。`
      + `\n- 用户明确说"你定"时才可以定，并在回复里写明你替他定了什么、依据是什么。`;
  }

  const c = outcome.candidate;
  return `${head}\n\n用户已拍板：**${c.label}**${c.description ? `（${c.description}）` : ''}`
    + `\n这条决定已按 kind=decision 写入事件库（确定性留痕，不依赖你记得去记）。接下来把这些做完：`
    + `\n① 落到路线图 .flint/ROADMAP.md：已有对应坐标就用 edit 改那一行的"坐标"措辞；`
    + `这个决定本身就是一件待做的事，就追加一行新坐标（五列顺序不能变，编号用分段编号如 10.3 / 10.3.2）。`
    + `\n② 若它是"系统"级（跨 ≥2 次会话 / 触及 ≥3 个模块 / 含架构决策），立项写 .flint/CHARTER.md。`
    + `\n③ 把"决定了什么 + 为什么"追加进 .flint/DEVLOG.md（只追加），前后依据要写清。`
    + `\n不要再就同一个分叉点问第二次。`;
}
