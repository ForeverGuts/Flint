/**
 * /plan 命令 —— 计划模式的开关（ROADMAP 10.4.1）。
 * 调用方：commands/loader.ts 自动扫描（本目录每个导出 activate 的文件都会被加载）
 * 服务于：给用户一个**显式的模式开关** —— 开启后，模型改不动任何项目文件
 *         （write / edit / bash 被程序拒绝），只能先交方案。模型自己关不掉
 *         （命令只能由用户输入触发，模型手里没有能碰 `planMode` 的工具）。
 *
 * 参数（空格后第一个词）：
 *   /plan          看状态 + 用法
 *   /plan on       进入计划模式（**仅本会话**）
 *   /plan off      退出计划模式，恢复 write / edit / bash
 *
 * ── 为什么是"两个动词"而不是一个 toggle ──
 * `/plan` 不带参数会切换成什么？用户在"想确认现在是不是计划模式"和"想切过去"之间
 * 有歧义。同族的 `/workspace` 用的是"裸命令 = 看状态，动词 = 动作"，本条照抄 ——
 * **一条命令的默认行为应当是最无害的那个**（看状态不改任何东西）。
 *
 * ── 为什么开模式要**说清它拦的是哪三个工具** ──
 * 用户开这个模式的动机是"先别动手"，而它实际拦下的边界比直觉**窄**也**宽**：
 *   · 窄 —— `todo` / `memory` / `record_event` 照样能写（它们写的是 `.flint/` 下
 *     Agent 自己的笔记本，不是用户的代码）；
 *   · 宽 —— `bash` 一起被拦（**包括只读命令**），代价是计划期间不能跑命令，
 *     换来的是"没有一条一句话就能绕过的洞"（完整取舍见 loop/plan-mode.ts 文件头）。
 * 两条都写进回执：用户按错的模型用它会得出"它明明答应不动手却还在写文件"这种误解。
 *
 * ── 与 C8 的关系（把"RPC 下会不会形同虚设"当场说清）──
 * 这道闸**没有"每一步等人点头"这个环节**，所以非 TTY / RPC 下没有任何东西会被
 * "自动放行" —— 开关开着就一律拒。回执里也照实写，不让用户以为 RPC 下是另一回事。
 */
import type { Runtime } from '../../runtime/runtime.js';
import { PLAN_BLOCKED_TOOLS, planMode } from '../../loop/plan-mode.js';
import { recordPlanMode } from '../../permission/audit.js';

/** 用法 —— 三处回执共用，免得各写一遍走形 */
const USAGE = [
  '用法：',
  '  /plan         看当前状态与用法',
  '  /plan on      进入计划模式（**仅本会话**）：只读、先出方案',
  '  /plan off     退出计划模式，恢复 write / edit / bash',
].join('\n');

/** 被拦工具名单渲染一次 —— 名单只有一份实现（`plan-mode.ts`），这里只负责印出来 */
const BLOCKED = [...PLAN_BLOCKED_TOOLS].join(' / ');

export function activate(runtime: Runtime): void {
  runtime.registerCommand('plan', '计划模式：开启后模型只能先出方案，改不动任何文件', (args: string) => {
    const first = args.trim().toLowerCase();

    if (first === 'on') {
      const wasOn = planMode.isOn();
      planMode.enter();
      // 审计留痕（ROADMAP 10.9.4）：**只在真正切换时**记 —— 已经在计划模式里再敲一次
      // `/plan on` 什么账目都没变，记它只是噪音（与"一次什么都没撤销的 clear 不记"同一条）。
      // 注意开关**已经生效**才记（上面那行 enter 就是生效点）。
      if (!wasOn) recordPlanMode(true);
      return [
        wasOn ? '已经在计划模式里（本次没有变化）。' : '📋 已进入计划模式（本会话有效）。',
        `  接下来被程序拒绝的工具：${BLOCKED}`,
        '  模型仍可读文件、检索、看 git、记自己的账（todo / memory），并可以向你提问；',
        '  它要把「改哪些文件、改什么、为什么、怎么验证」讲给你听之后，你敲 /plan off 它才能动手。',
        '',
        '  边界：这不是沙箱 —— 只拦**模型经工具**发起的调用；'
          + '你在终端里自己敲的命令不受影响。`bash` 一并被拦（含只读命令）：'
          + '留着它就是一条一句话绕过的洞，而读能力本来都有专用工具。',
        '',
        USAGE,
      ].join('\n');
    }

    if (first === 'off') {
      const wasOn = planMode.isOn();
      planMode.exit();
      if (wasOn) recordPlanMode(false);
      return [
        wasOn ? '▶ 已退出计划模式：write / edit / bash 恢复可用。' : '本来就不在计划模式里（本次没有变化）。',
        '',
        USAGE,
      ].join('\n');
    }

    if (first !== '' && first !== 'show' && first !== 'status') {
      return `未知参数 "${first}"。\n${USAGE}`;
    }

    return [
      '计划模式：只读、先出方案（write / edit / bash 会被程序拒绝）。',
      `  当前状态 = ${planMode.isOn() ? '📋 开启（本会话有效）' : '关闭'}`,
      `  拦下的工具 = ${BLOCKED}`,
      '  不拦 = ls / read / grep / git 只读、ask，以及 todo / memory / record_event'
        + '（它们写的是 .flint/ 下 Agent 自己的笔记本，不是你的代码）',
      '',
      USAGE,
      '边界：这道闸不需要人工确认（用户开一次模式、之后全是程序判定），'
        + '所以非 TTY / RPC 下**不会**像权限弹窗那样被自动放行。它不是沙箱：'
        + '只拦模型经工具发起的调用。',
    ].join('\n');
  });
}
