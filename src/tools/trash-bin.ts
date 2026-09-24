/**
 * 回收站执行层（ROADMAP 10.9.6）—— `trash` 工具与 `/undo` 命令**唯一碰 fs 的地方**。
 *
 * 调用方：tools/builtin.ts（`trash` 工具的 handler）、commands/builtin/undo.ts（`/undo`）
 * 服务于：把"删除"落成"移进 `.flint/trash/` + 记一笔"，让它在事后可查、可还原。
 *
 * ── 落点：与账本同住 `.flint/` ──
 * `.flint/` 是项目资产、隐藏目录（ls / grep 天然跳过），账本 `events.jsonl` 与压缩留档
 * `snapshots/` 都在那儿，回收站跟着同住。三个文件：
 *   · `.flint/trash/<id>/<原相对路径>` —— 被回收的实体，**保留原目录结构**（否则还原时
 *     不知道它原来在哪，也可能撞名）；
 *   · `.flint/trash/manifest.jsonl` —— 回收记录，一行一笔，**只追加**；
 *   · `.flint/trash/out.jsonl` —— "已出库"的 id，一行一笔，**只追加**（还原与清理两种都记）。
 * 为什么出库另开一个文件而不是回头改 manifest：manifest 是**只追加**的流水，回头改写等于
 * 把"发生过什么"改掉 —— 而这正是本条要治的那种"事后无从比对"。出库是**新事实**，追加即可。
 *
 * ── 判据与 fs 分开（与项目其余各闸同一形状）──
 * `refuseTarget()` 是**纯函数**（不碰 fs、不看时钟），四种"不该回收"的形状都钉在那儿，
 * 套件可以逐条打靶；`trashTarget()` 只做"判完之后真动手"。
 *
 * ── 拿不准就**不动**（与 write / edit 同一条纪律）──
 * 移动是 `renameSync`：要么整体搬走、要么抛错，**不存在搬了一半**的状态。抛错时返回
 * `MOVE_FAILED`，目标**原样留在原地** —— 静默丢文件比拒绝一次的代价大得多。
 *
 * 零运行时依赖：只用 node:fs / node:path。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 回收站根目录（相对 cwd，与账本同住 .flint/） */
export const TRASH_DIR = '.flint/trash';
/** 回收记录（只追加，一行一笔） */
export const TRASH_MANIFEST = '.flint/trash/manifest.jsonl';
/** 已出库的记录 id（只追加，一行一笔；how 区分"还原"与"清理"） */
export const TRASH_OUT = '.flint/trash/out.jsonl';
/** 清理阈值（天）：超过这么久还没还原的，清掉腾地方 */
export const PRUNE_AFTER_DAYS = 7;

/** 一笔回收记录 */
export interface TrashRecord {
  /** 记录 id，同时是回收站里的子目录名 */
  id: string;
  /** 回收时刻（ISO 字符串） */
  time: string;
  /** 原路径（相对 cwd，正斜杠） */
  from: string;
  /** 回收站里的路径（相对 cwd，正斜杠） */
  to: string;
  /** 是不是目录 */
  isDir: boolean;
  /** 字节数；目录记 -1（不递归统计，那对大目录是白跑一趟） */
  bytes: number;
}

/** 拒绝 / 失败的**种类**（机器可读，回执与断言都靠它） */
export type TrashCode =
  | 'NOT_FOUND' // 目标不存在
  | 'OUTSIDE' // 目标在工作区之外
  | 'IS_ROOT' // 目标就是工作区本身
  | 'IS_TRASH' // 目标在回收站里（回收回收站 = 自己吃自己）
  | 'MOVE_FAILED' // rename 抛错（含跨盘）
  | 'LOST' // 已经移进回收站了，但**记录没写进去** —— 没有凭据，还原不了
  | 'EMPTY' // 没有可还原的（/undo 的常态）
  | 'GONE' // 记录还在、实体没了
  | 'OCCUPIED'; // 原位置已被别的东西占了（还原会覆盖它 → 不动）

export interface TrashFailure {
  code: TrashCode;
  /** 给模型 / 用户看的一句话（含"目标原样没动"这类结论） */
  message: string;
}

export type TrashOutcome = { ok: true; record: TrashRecord } | ({ ok: false } & TrashFailure);

let recordCounter = 0;

/** 记录 id：时间戳 + 递增序号（同一毫秒内连删两笔也不会撞名） */
function nextRecordId(): string {
  recordCounter++;
  return `t${Date.now().toString(36)}_${recordCounter}`;
}

/** 绝对 → 相对 cwd 的正斜杠形态（manifest 里存这个，换台机器也能读） */
function relOf(cwd: string, abs: string): string {
  return path.relative(cwd, abs).replace(/\\/g, '/');
}

/** 读一个 jsonl 文件；不存在返回空数组，**坏行跳过**（账本里有坏行不该让整个命令挂掉） */
function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // 坏行跳过：它是"读不懂"，不是"该拒绝"—— 回收站是给人救急的，别因为一行坏了就瘫掉
    }
  }
  return out;
}

function appendLine(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf-8');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   判据（纯函数，不碰 fs）
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 这个目标**该不该拒**。纯函数 —— `outside` 由调用方算好传进来（工作区判定要 cwd / 放行表 /
 * 真落点解析器，那是装配处的活，本文件不直读它们）。
 */
export function refuseTarget(abs: string, cwd: string, outside: boolean): TrashFailure | null {
  if (outside) {
    return {
      code: 'OUTSIDE',
      message: '目标在工作区之外 —— 回收站只管这个项目里的东西，外面的请在用户自己的终端里处理。',
    };
  }
  // 整个工作区本身：回收它等于把项目（连同 .flint/ 里的回收站与账本）一起搬进自己内部
  if (path.resolve(abs) === path.resolve(cwd)) {
    return { code: 'IS_ROOT', message: '目标是**项目根目录本身** —— 要清整个项目请用户自己来。' };
  }
  const rel = relOf(cwd, abs);
  if (rel === TRASH_DIR || rel.startsWith(`${TRASH_DIR}/`)) {
    return { code: 'IS_TRASH', message: '目标已经在回收站里了 —— 不再重复回收（要彻底清除请用户自己删）。' };
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   执行（碰 fs）
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 把一个目标移进回收站并记一笔。**失败时目标原样留在原地**。
 */
export function trashTarget(abs: string, cwd: string, outside: boolean): TrashOutcome {
  const refused = refuseTarget(abs, cwd, outside);
  if (refused !== null) return { ok: false, ...refused };

  if (!fs.existsSync(abs)) {
    return { ok: false, code: 'NOT_FOUND', message: `目标不存在: ${relOf(cwd, abs)}` };
  }

  const stat = fs.statSync(abs);
  const id = nextRecordId();
  const from = relOf(cwd, abs);
  const to = `${TRASH_DIR}/${id}/${from}`;
  const toAbs = path.join(cwd, to);

  try {
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(abs, toAbs);
  } catch (e) {
    // rename 是原子的：要么搬走、要么没动。所以这里可以如实说"原样没动"。
    return {
      ok: false,
      code: 'MOVE_FAILED',
      message: `没能移进回收站（${e instanceof Error ? e.message : String(e)}）—— **目标原样留在原地**。`,
    };
  }

  const record: TrashRecord = {
    id,
    time: new Date().toISOString(),
    from,
    to,
    isDir: stat.isDirectory(),
    bytes: stat.isDirectory() ? -1 : stat.size,
  };
  try {
    appendLine(path.join(cwd, TRASH_MANIFEST), record);
  } catch (e) {
    // ⚠ 移动已经成功、manifest 没记上 —— 文件在回收站里，但**没有凭据可以还原它**。
    // 这是唯一一处"做不到也要如实说"的分支：把这一笔补记不回去了（id 已生成、实体已移动），
    // 只能把实情告诉调用方，绝不假装成功。
    return {
      ok: false,
      code: 'LOST',
      message: `目标已移进回收站，但**记录没写进去**（${e instanceof Error ? e.message : String(e)}）`
        + ` —— 它现在无法被 /undo 还原，请告知用户到 ${to} 手动取回。`,
    };
  }
  return { ok: true, record };
}

/** 全部回收记录（按追加序，最老的在前） */
export function readRecords(cwd: string): TrashRecord[] {
  return readJsonl<TrashRecord>(path.join(cwd, TRASH_MANIFEST));
}

/** 已出库的 id 集合（还原过的 + 清理过的） */
export function readOutIds(cwd: string): Set<string> {
  const rows = readJsonl<{ id?: unknown }>(path.join(cwd, TRASH_OUT));
  const out = new Set<string>();
  for (const r of rows) if (typeof r.id === 'string') out.add(r.id);
  return out;
}

/** 还没出库的记录（按追加序）—— `/undo` 还原的是**最后**一笔 */
export function pendingRecords(cwd: string): TrashRecord[] {
  const out = readOutIds(cwd);
  return readRecords(cwd).filter((r) => !out.has(r.id));
}

export type UndoOutcome =
  | { ok: true; record: TrashRecord }
  | ({ ok: false } & TrashFailure);

/**
 * 还原最近一笔（`/undo`）。**覆盖写不发生**：原位置已经有东西就拒，不动任何一方。
 */
export function undoLast(cwd: string): UndoOutcome {
  const pending = pendingRecords(cwd);
  const rec = pending[pending.length - 1];
  if (rec === undefined) {
    return { ok: false, code: 'EMPTY', message: '回收站里没有待还原的东西。' };
  }

  const keptAbs = path.join(cwd, rec.to);
  if (!fs.existsSync(keptAbs)) {
    return {
      ok: false,
      code: 'GONE',
      message: `回收站里找不到这一笔（${rec.to}）—— 它可能被手工清掉了。记录仍在清单里，可用 /undo list 查看。`,
    };
  }
  const backAbs = path.join(cwd, rec.from);
  if (fs.existsSync(backAbs)) {
    return {
      ok: false,
      code: 'OCCUPIED',
      message: `原位置已经有东西了（${rec.from}）—— 还原会覆盖它，所以**没动**。`
        + '请先处理掉那个文件，或让模型换个路径。',
    };
  }

  try {
    fs.mkdirSync(path.dirname(backAbs), { recursive: true });
    fs.renameSync(keptAbs, backAbs);
  } catch (e) {
    return {
      ok: false,
      code: 'MOVE_FAILED',
      message: `还原失败（${e instanceof Error ? e.message : String(e)}）—— 东西**还在回收站里**，没有丢。`,
    };
  }

  appendLine(path.join(cwd, TRASH_OUT), { id: rec.id, time: new Date().toISOString(), how: 'restore' });
  return { ok: true, record: rec };
}

/**
 * 清掉超过 `PRUNE_AFTER_DAYS` 天还没还原的东西（回收站不是垃圾桶，别让它无限长）。
 * 只清**待还原**且**超期**的；删掉的是回收站里的副本 —— 原位置早已没有它。
 */
export function pruneTrash(cwd: string, now: number = Date.now()): number {
  const out = readOutIds(cwd);
  const cutoff = now - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const rec of readRecords(cwd)) {
    if (out.has(rec.id)) continue;
    const t = Date.parse(rec.time);
    if (Number.isNaN(t) || t > cutoff) continue; // 时间读不出来的一律不清理（宁可留着）
    const keptAbs = path.join(cwd, rec.to);
    try {
      fs.rmSync(keptAbs, { recursive: true, force: true });
    } catch {
      continue; // 擦不动就留着，下次再说
    }
    appendLine(path.join(cwd, TRASH_OUT), { id: rec.id, time: new Date().toISOString(), how: 'prune' });
    removed++;
  }
  return removed;
}
