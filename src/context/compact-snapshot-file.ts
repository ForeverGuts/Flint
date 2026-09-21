/**
 * 手动压缩留档的**落盘**（副作用侧）—— 唯一碰 fs 的地方。
 *
 * 调用方：`Runtime.compactSession()`（经 `compactNow` 的 `beforeSummarize` 钩子）
 * 服务于：ROADMAP 10.8.4 —— 压缩前把要被换掉的原文整份写进 `.flint/snapshots/`
 *
 * 为什么与判据分家：判据（`compact-snapshot.ts`）是零 import 的纯函数，文件名怎么起、
 * 正文长什么样都能在内存里逐条打靶；本文件只有"建目录 + 写一个文件"这一件事。
 *
 * ── 失败必须**报出来**、不许静默 ──
 * 留档的目的是"原文还在"。写失败还接着压 = 说好留底其实没留，而且是**不可逆**的丢。
 * 所以这里返回 `ok:false + reason`，由调用方（runtime）据此**中止压缩**并把原因念给用户。
 *
 * ── 落点是**相对 cwd** 的 `.flint/` ──
 * 与账本 `events.jsonl` 同一口径（`.flint/` 是项目资产、隐藏目录、ls/grep 天然跳过）。
 * 套件里靠 `scripts/lib/sandbox.ts` 的 chdir 隔离，不会写进真仓库。
 *
 * 零运行时依赖：只用 node:fs / node:path。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { SNAPSHOT_DIR, snapshotRelPath } from './compact-snapshot.js';

/** 写一份留档。成功给绝对与相对两个路径（相对路径进回执、绝对路径供断言自证） */
export function saveCompactionSnapshot(
  cwd: string,
  fileName: string,
  text: string,
): { ok: true; abs: string; rel: string } | { ok: false; reason: string } {
  const dir = path.join(cwd, SNAPSHOT_DIR);
  const abs = path.join(dir, fileName);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(abs, text, 'utf-8');
    return { ok: true, abs, rel: snapshotRelPath(fileName) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
