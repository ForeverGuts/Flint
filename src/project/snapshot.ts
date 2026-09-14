/**
 * 项目现状快照（`.flint/PROJECT.md`）的读取 —— ROADMAP P10.12.5 的**注入侧**。
 * 调用方：`runtime/runtime.ts`（每轮构建系统提示词前读一次，填 `ctx.project`）
 * 服务于：让"当前系统由哪些模块 / 技术点构成"**一直躺在模型视野里**，不必每轮
 *         重新 ls + read 去把项目形状猜一遍。
 *
 * ── 为什么这里**允许**运行期读文件（与"投影单向往文件、运行期绝不回读"不冲突）──
 * 那条纪律治的是"**两处判定**"：TaskStore / MemoryStore 有内存真相源，再回读文件就等于
 * 多出一个来源，两者迟早漂移。现状快照**没有 store** —— 文件就是唯一真相源，
 * 所以这里读的是**同一处**，不是第二处。附带的好处是**自愈**：模型用 write / edit
 * 改完它立刻生效，不需要任何"谁通知 UI / 谁通知 runtime"的线（那条线在别处是必需的，
 * 在这里因为压根没有第二份状态而消失）。
 *
 * 与 CHARTER 的分工（三件套的修改策略三分）：CHARTER 是**契约**（立项后冻结、改需许可，
 * 由 charter.ts 的钩子拦）；本文件是**快照**（随代码漂移、自由改，不作任何拦截）。
 *
 * 零运行时依赖：只用 node:fs（内置）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { PROJECT_FILE } from './charter.js';

/**
 * 注入上限。注入是**展示**，可以截（投影落盘才不许截）——现状快照本该是"一页纸说清
 * 系统由哪些模块构成"，写成长文本身就跑偏了；真超了就在末尾标一刀，让模型知道还有后文。
 */
export const SNAPSHOT_MAX = 3000;

/** 截断（纯函数，便于验证）：空内容 → undefined（**不注入一句空话**） */
export function clipSnapshot(text: string, max: number = SNAPSHOT_MAX): string | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  return t.length > max ? `${t.slice(0, max)}\n...（截断）` : t;
}

/**
 * 读现状快照。文件不存在 / 内容为空 / 读失败 → 一律 undefined（该层不注入）。
 * 三种情形都当"没有"处理：注入层缺席是良性的（模型照旧用 ls/read 自己看），
 * 而抛异常会挡在每轮请求的必经之路上。
 */
export function readProjectSnapshot(path: string = PROJECT_FILE, max: number = SNAPSHOT_MAX): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return clipSnapshot(readFileSync(path, 'utf-8'), max);
  } catch {
    return undefined;
  }
}
