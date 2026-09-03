/**
 * 扩展装载器 —— 自动扫描 src/extensions/ 下用户扩展，动态 import 并注册。
 * 调用方：main.ts（组装时装载用户扩展）
 * 服务于：用户加段落/hook/watcher 扩展 = 放一个文件 + export 注册函数，系统自动装载，不碰 main。
 *
 * 目录约定（三类扩展、三条口子，区别在 ctx 给了哪把钥匙）：
 *   - src/extensions/sections/   段落扩展：export function registerSections(ctx)  ctx = { addSection }
 *   - src/extensions/hooks/      hook 扩展：export function registerHooks(ctx)     ctx = { on, events }
 *   - src/extensions/watchers/   旁观扩展：export function registerWatchers(ctx)   ctx = { events }
 *
 * hooks/ 与 watchers/ 的分界（两者都是订阅事件，容易混）：
 *   hook    走 on(type, handler)，返回值由 emitHook 收回，能改写流程（before_build / before_request）
 *   watcher 走 events.subscribe(handler)，通配收所有事件、返回值没人收，只看只录不改流程
 * 所以 watcher 的 ctx 里刻意不给 on —— 旁观者改流程这件事在类型层面就不可能。
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SectionFn } from '../core/system-prompt.js';
import type { EventBus } from '../core/events.js';

interface SectionModule {
  registerSections?: (ctx: { addSection(fn: SectionFn): void }) => void;
}
interface HookModule {
  registerHooks?: (ctx: { on(type: string, handler: (event: unknown) => unknown): () => void; events: EventBus }) => void;
}
/** 旁观扩展模块（只给 events：能订阅、不能用 on 改流程） */
interface WatcherModule {
  registerWatchers?: (ctx: { events: EventBus }) => void;
}

/** 扩展装载结果：收集的段落 + 已装载扩展（hook/watcher）所订阅的 events */
export interface ExtensionLoadResult {
  /** 用户扩展添加的段落 */
  sections: SectionFn[];
  /** 事件总线（hook 扩展注册到它） */
  events: EventBus;
}

/** 扫描目录下 .ts 文件并动态 import，调对应注册函数 */
async function loadDir<T>(dir: string, register: (mod: T) => void): Promise<void> {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    try {
      const mod = (await import(pathToFileURL(join(dir, f)).href)) as T;
      register(mod);
    } catch { /* 单个扩展失败跳过 */ }
  }
}

/**
 * 装载用户扩展。
 * @param events 事件总线（hook 扩展订阅到它）
 * @returns 收集的段落（供 SystemPromptService 使用）+ events
 */
export async function loadExtensions(events: EventBus): Promise<ExtensionLoadResult> {
  const baseDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extensions');
  const sections: SectionFn[] = [];

  // ① 段落扩展：extensions/sections/
  await loadDir<SectionModule>(join(baseDir, 'sections'), (mod) => {
    mod.registerSections?.({ addSection: (fn) => sections.push(fn) });
  });

  // ② hook 扩展：extensions/hooks/（给了 on，可改写流程）
  await loadDir<HookModule>(join(baseDir, 'hooks'), (mod) => {
    mod.registerHooks?.({
      on: (type, handler) => events.on(type, handler),
      events,
    });
  });

  // ③ 旁观扩展：extensions/watchers/（只给 events，只订阅不改流程）
  await loadDir<WatcherModule>(join(baseDir, 'watchers'), (mod) => {
    mod.registerWatchers?.({ events });
  });

  return { sections, events };
}
