/**
 * 扩展系统接口（core 层公共契约）。
 * 调用方：context/extension-loader.ts（装载用户扩展）
 * 服务于：定义用户扩展脚本的注册契约 —— 段落 / hook / watcher 三类扩展分开，
 *         用户 export 对应注册函数，系统自动扫描装载（不碰 main）。
 *
 * 用户操作：
 *   - 段落扩展：在 src/extensions/sections/ 下建文件，export function registerSections(ctx)
 *   - hook 扩展：在 src/extensions/hooks/ 下建文件，export function registerHooks(ctx)（ctx 有 on，可改写流程）
 *   - 旁观扩展：在 src/extensions/watchers/ 下建文件，export function registerWatchers(ctx)（ctx 只有 events，只订阅）
 */
import type { SectionFn } from './system-prompt.js';
import type { EventBus } from './events.js';

/** 段落扩展注册上下文（用户加段落用） */
export interface SectionRegistrationCtx {
  /** 添加一个系统提示词段落（用户可自定义扩展） */
  addSection(fn: SectionFn): void;
}

/** hook 扩展注册上下文（用户订阅 hook 用） */
export interface HookRegistrationCtx {
  /** 订阅事件（复用 EventBus 语义：on 可返回结果影响流程） */
  on(type: string, handler: (event: unknown) => unknown): () => void;
  /** 访问事件总线（如需 emit） */
  events: EventBus;
}

/**
 * 旁观扩展注册上下文（只看只录、不改流程）—— 供纯消费型扩展用，如 trace-log 落盘。
 * 与 HookRegistrationCtx 的唯一区别就是没有 on：拿不到 on 就改不了流程，
 * 这条约束由类型系统兜住，不靠使用自觉。
 */
export interface WatcherRegistrationCtx {
  /** 访问事件总线（subscribe 收全量事件；也可 emit 便签段） */
  events: EventBus;
}
