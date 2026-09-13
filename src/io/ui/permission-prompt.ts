/**
 * 权限确认选择器 —— 操作前拦截，显示三个选项供用户选择。
 * 调用方：runtime.askPermission（AgentLoop 的 onPermission 回调）
 * 服务于：允许一次 / 本次全部允许 / 拒绝
 *
 * ── 2026-09-13 起：弹窗本体走组件树，本文件只留**纯定义** ──
 * 旧实现直接调 selectFromList 裸写 stdout，与 TreeUI 的自绘渲染（spinner 每 250ms 重绘
 * 状态行 / 任务面板 / 输入框）抢同一块屏幕：面板一刷新就把下面的行盖掉——
 * 用户实测"选项 3（拒绝）被隐藏"。现在 TTY 下由 runtime.select → TreeUI.showSelect
 * 把弹窗接进组件树（selectBox 容器），与 spinner 同一套 Screen 布局，互不覆盖。
 * 管道模式（RPC / 脚本）：runtime.select 回落 selectFromList，非 TTY 下它直接返回
 * 第一项（允许一次）——即自动放行，与旧行为一致，且不再往 stdout 打"自动允许"日志
 *（那行 console.log 在 RPC 模式下是一颗 stdout 纯净性的雷）。
 *
 * ── 顺带澄清与高亮（同日用户反馈）──
 * ① "本次全部允许"的描述原是"后续自动放行"，用户误以为是"本轮所有命令都放行"。
 *    实际授权粒度是 autoKey = `工具:目标`（PermissionManager **精确匹配**，见其注释），
 *    描述照实写清作用域。
 * ② 标题行（🔧 工具名 请求：…）在 TTY 弹窗里用**黄加粗**整行高亮——
 *    让用户第一眼看清这是对哪个文件 / 哪个目标的操作。
 */
export type PermissionChoice = 'once' | 'always' | 'deny';

/**
 * 三个选项 —— **唯一定义处**（顺序即显示顺序）。
 * 供 runtime.select 的组件树选择器与管道回落选择器共用，别处不得再抄一份。
 */
export const PERMISSION_OPTIONS: Array<{
  value: PermissionChoice;
  label: string;
  description: string;
}> = [
  { value: 'once',   label: '允许一次',     description: '仅本次放行' },
  { value: 'always', label: '本次全部允许', description: '同一工具同一目标，本会话内自动放行' },
  { value: 'deny',   label: '拒绝',        description: '取消操作' },
];

const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * 弹窗标题：🔧 那一行。
 * styled=true → 整行黄加粗（TTY 弹窗，SelectList 的 fitWidth 对 ANSI 免疫）；
 * styled=false → 纯文本（测试快照比对、日志等不含 ANSI 的场合）。
 */
export function permissionTitle(toolName: string, detail: string, styled: boolean): string {
  const base = `🔧 ${toolName} 请求：${detail}`;
  return styled ? `${YELLOW}${BOLD}${base}${RESET}` : base;
}
