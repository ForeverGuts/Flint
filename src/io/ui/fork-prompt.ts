/**
 * 分叉点提问的**交互实现** —— 把"问用户一个问题"接到 flint 的选择器上。
 *
 * 调用方：`src/harness/main.ts`（组装时 `createForkAsker(...)` 注入 `registerBuiltinTools`）。
 * 服务于：`ask` 工具在 TTY 下弹出一个带候选方案的选择框，等用户拍板。
 *
 * ── 为什么单独一个文件，而不是直接写在 tools/builtin.ts 里 ──
 * `src/io/` 是**允许往 stdout 写字**的一层（它管界面），而工具层在 RPC 模式下也在跑，
 * 那里 stdout 必须一行一个 JSON（`rpc.ts` 的协议通道）。`tools/builtin.ts` 一旦 import
 * 了 io 层的模块，RPC 启动路径就把 UI 层拖进来了——今天没出事只是因为没人调用它，
 * 属"碰巧干净"。所以：工具层只认 `AskFn` 这个**接口**（定义在纯模块 `project/fork.ts`），
 * 真正的实现由 main.ts 在 TTY 侧注入。缺省实现是"永远答问不了"，安全的那一侧。
 *
 * ── ⚠ 与权限弹窗刻意相反的一条：fail-closed ──
 * 权限弹窗在非 TTY 下回落"允许一次"（放行）——放行至少不拦事，是 fail-open。
 * 分叉点**不能**这么干：选择器在非 TTY 下返回第一项，那等于把"人工决策点"静默变成
 * "默认采用第一个候选"，用户根本没看见就被定了。所以这里先探终端，**没有终端就一个
 * 选项都不选**，返回 null 让上层降级成"用文字问用户"（人还是看得到、答得上）。
 *
 * 选择器本身（`selector.ts`）已有"固定行数 + 回退清行"的不漂移策略与 Ctrl+C 取消，
 * 本文件不重复实现，只做"该不该问 + 怎么把值交回来"。
 */
import { selectFromList } from './selector.js';
import type { AskFn, Choice } from '../../project/fork.js';

/** 选择器签名（与 `Runtime.select` 一致，便于直接注入；只做类型引用，不 import Runtime） */
export type ForkSelector = (items: Choice[], title?: string) => Promise<string | undefined>;

/** 缺省选择器：裸 selectFromList（仅在没有 Runtime 的场合兜底；TTY 下应由 main.ts 传 runtime.select） */
const defaultSelect: ForkSelector = (items, title) => selectFromList(items, title);

/**
 * 造一个 `AskFn`。
 * @param select 选择器。TTY 下传 `runtime.select`（走 TreeUI 组件树，与 spinner/任务面板同布局，
 *               不会被面板刷新盖掉）；不传则用裸选择器。
 * @param isTty 终端探测。可注入——验证套件靠它把"TTY / 非 TTY"两种环境各演一遍。
 */
export function createForkAsker(
  select?: ForkSelector,
  isTty: () => boolean = () => process.stdin.isTTY === true,
): AskFn {
  return async (question, choices) => {
    // ⚠ 顺序是承重的：**先判终端，再调选择器**。反过来的话，非 TTY 下选择器
    // 会返回第一项，等于替用户选了——正是本文件头说的那个洞。
    if (!isTty()) return null;
    try {
      const picked = await (select ?? defaultSelect)(choices, question);
      return picked ?? null;   // Ctrl+C 取消 → null（= 没做选择）
    } catch {
      return null;             // 选择器自身异常 → 当作没问成，绝不猜一个答案
    }
  };
}
