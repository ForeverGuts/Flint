/**
 * 段落扩展示例 —— 演示用户如何添加自定义系统提示词段落。
 * 用户操作：在本目录（src/extensions/sections/）建文件，export registerSections(ctx)，
 * 系统自动装载，无需改 main。
 */
import type { SectionFn } from '../../core/system-prompt.js';

/** 用户自定义段落：回复规范（可基于 ctx 动态，如当前模型） */
const replyRules: SectionFn = (ctx) => `## 回复规范
- 回答使用中文
- 代码块标注语言
- 遇到不确定的如实说明
- 当前模型：${ctx.model}`;

/** 注册段落扩展 */
export function registerSections(ctx: { addSection(fn: SectionFn): void }): void {
  ctx.addSection(replyRules);
}
