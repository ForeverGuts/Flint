/**
 * 技能段落 —— 告诉 LLM 当前可用的技能（让 Agent 知道能加载哪些技能）。
 * 调用方：SystemPromptService（配置的 sections 之一）
 * 服务于：把 SkillLoader 的技能列表注入系统提示词（动态，ctx.skills）
 */
import type { SectionFn } from '../system-prompt.js';

/** 技能段（ctx.skills 为空时返回 undefined，跳过本段） */
export const skillsSection: SectionFn = (ctx) => {
  const names = ctx.skills;
  if (!names || names.length === 0) return undefined;
  const present = new Set(names);
  const list = names
    .map((name) => {
      const deps = ctx.skillDeps?.[name] ?? [];
      if (deps.length === 0) return `  - ${name}`;
      const missing = deps.filter((d) => !present.has(d));
      const depText = missing.length > 0 ? `${deps.join(', ')}（缺失: ${missing.join(', ')}）` : deps.join(', ');
      return `  - ${name}（依赖: ${depText}）`;
    })
    .join('\n');
  return `你有以下技能（匹配任务时读取对应技能文件）：\n${list}`;
};
