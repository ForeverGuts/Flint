/**
 * 后台任务（ROADMAP 10.10.1）—— 进程/任务表管理。
 *
 * 与 `runChildInTree`（等到结束）的分野：本模块起进程后立即返回任务 id，
 * 输出进字节环形缓冲，工具通过 `task output` 回读（回读时才整体 `decodeChildOutput` 解码）
 *，避免流式 TextDecoder 的跨 chunk 多字节截断。C6 纯净：后台进程输出只进环形缓冲/文件，
 * 经 tool 结果回读，**绝不直写 stdout**。
 *
 * 退出清理挂点 = 模块自注册 `process.on('exit')`（同步 `spawnSync taskkill /T /F`）。
 * 运行时 `runtime.stop()` 仍为空 TODO；SIGINT/SIGTERM/异常崩溃全部汇入进程退出，
 * 注册一次覆盖所有路径、最小侵入（不动 main.ts）。
 */

import { createRequire } from 'node:module';
import { planTreeKill, spawnDetached } from './proctree.js';
import { describeTreeKill } from './proctree.js';
import { decodeChildOutput } from './runner.js';

const require = createRequire(import.meta.url);

const BACKGROUND_MAX_BUFFER = 1024 * 1024; // 每流 1MB

class RingBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  droppedBytes = 0;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const oldest = this.chunks.shift()!;
      this.bytes -= oldest.length;
      this.droppedBytes += oldest.length;
    }
    if (this.bytes > this.limit && this.chunks.length === 1) {
      const last = this.chunks[0];
      this.chunks[0] = last.subarray(Math.max(0, last.length - this.limit));
      this.bytes = this.chunks[0].length;
      this.droppedBytes += last.length - this.chunks[0].length;
    }
  }
  snapshot(): Buffer {
    return this.chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.chunks);
  }
}

export type BackgroundTaskStatus = 'running' | 'exited' | 'killed' | 'spawn_failed';

export interface BackgroundTaskInfo {
  id: number;
  command: string;
  status: BackgroundTaskStatus;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  spawnErrorCode: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  droppedStdoutBytes: number;
  droppedStderrBytes: number;
  settleForced: boolean;
}

interface TaskInternal {
  id: number;
  command: string;
  pid: number | null;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  signal: string | null;
  spawnErrorCode: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  out: RingBuffer;
  err: RingBuffer;
  settled: boolean;
}

export class BackgroundTaskStore {
  private tasks = new Map<number, TaskInternal>();
  private nextId = 1;
  constructor(private readonly maxBuffer = BACKGROUND_MAX_BUFFER) {
    process.on('exit', () => {
      const { spawnSync } = require('node:child_process');
      for (const [_id, t] of this.tasks) {
        if (t.status === 'running' && t.pid != null) {
          try {
            const plan = planTreeKill(t.pid, process.platform);
            if (plan) {
              /* args 仅为说明；实际调用直接用 plan 结构 */
              // 同步清理：exit 钩子只允许同步
              spawnSync(plan.kind === 'taskkill' ? 'taskkill' : 'kill',
                plan.kind === 'taskkill' ? [...plan.argv] : [String(-plan.pid), plan.signal],
                { windowsHide: true, timeout: 3000 });
            }
          } catch { /* 退出时清理失败不阻断退出 */ }
        }
      }
    });
  }
  spawn(command: string): { id: number; pid: number | null } {
    const id = this.nextId++;
    const { spawn } = require('node:child_process');
    const platform = process.platform;
    const detached = spawnDetached(platform);
    const child = spawn(command, {
      shell: true, cwd: process.cwd(), windowsHide: true,
      detached, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = new RingBuffer(this.maxBuffer);
    const err = new RingBuffer(this.maxBuffer);
    const t: TaskInternal = {
      id, command, pid: child.pid ?? null, status: 'running',
      exitCode: null, signal: null, spawnErrorCode: null,
      startedAtMs: Date.now(), endedAtMs: null,
      out, err, settled: false,
    };
    this.tasks.set(id, t);
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e: Error & { code?: string }) => {
      if (t.settled) return;
      t.settled = true;
      t.status = 'spawn_failed';
      t.spawnErrorCode = e.code ?? 'SPAWN_FAILED';
      t.endedAtMs = Date.now();
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (t.settled) return;
      t.settled = true;
      t.status = (t.status === 'killed') ? 'killed' : (code === null && signal !== null ? 'exited' : 'exited');
      t.exitCode = code;
      t.signal = signal ? String(signal) : null;
      t.endedAtMs = Date.now();
    });
    return { id, pid: child.pid ?? null };
  }
  list(): BackgroundTaskInfo[] {
    const res: BackgroundTaskInfo[] = [];
    for (const t of this.tasks.values()) {
      res.push({
        id: t.id, command: t.command, status: t.status, pid: t.pid,
        exitCode: t.exitCode, signal: t.signal, spawnErrorCode: t.spawnErrorCode,
        startedAtMs: t.startedAtMs, endedAtMs: t.endedAtMs,
        stdoutBytes: t.out.snapshot().length, stderrBytes: t.err.snapshot().length,
        droppedStdoutBytes: t.out.droppedBytes, droppedStderrBytes: t.err.droppedBytes,
        settleForced: false,
      });
    }
    return res.sort((a, b) => a.id - b.id);
  }
  status(id: number): BackgroundTaskInfo | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    return {
      id: t.id, command: t.command, status: t.status, pid: t.pid,
      exitCode: t.exitCode, signal: t.signal, spawnErrorCode: t.spawnErrorCode,
      startedAtMs: t.startedAtMs, endedAtMs: t.endedAtMs,
      stdoutBytes: t.out.snapshot().length, stderrBytes: t.err.snapshot().length,
      droppedStdoutBytes: t.out.droppedBytes, droppedStderrBytes: t.err.droppedBytes,
      settleForced: false,
    };
  }
  output(id: number, tail?: number): { stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number; droppedStdoutBytes: number; droppedStderrBytes: number; truncated: boolean } | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    const rawOut = t.out.snapshot();
    const rawErr = t.err.snapshot();
    let outBuf = rawOut, errBuf = rawErr;
    if (tail != null && tail > 0) {
      if (tail < rawOut.length) outBuf = rawOut.subarray(rawOut.length - tail);
      if (tail < rawErr.length) errBuf = rawErr.subarray(rawErr.length - tail);
    }
    const stdout = decodeChildOutput(outBuf);
    const stderr = decodeChildOutput(errBuf);
    return {
      stdout, stderr,
      stdoutBytes: rawOut.length, stderrBytes: rawErr.length,
      droppedStdoutBytes: t.out.droppedBytes, droppedStderrBytes: t.err.droppedBytes,
      truncated: (tail != null && (rawOut.length > tail || rawErr.length > tail)),
    };
  }
  kill(id: number): { kind: 'killed'; plan: ReturnType<typeof planTreeKill>; msg: string } | { kind: 'already-ended'; status: BackgroundTaskStatus; exitCode?: number | null } | { kind: 'not-found' } {
    const t = this.tasks.get(id);
    if (!t) return { kind: 'not-found' };
    if (t.status !== 'running') return { kind: 'already-ended', status: t.status, exitCode: t.exitCode };
    const plan = t.pid != null ? planTreeKill(t.pid, process.platform) : null;
    if (plan) {
      try {
        const { spawnSync } = require('node:child_process');
        if (plan.kind === 'taskkill') {
          spawnSync('taskkill', [...plan.argv], { windowsHide: true, timeout: 3000 });
        } else {
          spawnSync('kill', [String(plan.pid), plan.signal], { windowsHide: true, timeout: 3000 });
        }
      } catch { /* kill 发出即可，即使真正杀失败也是任务已发出终止 */ }
    }
    // 先设 killed（后续 close 到来再确认）；grace 不在这里 arm，因为 kill 是异步的，
    // 由 close 事件结算；若死锁（后代攥管道不放）则交给进程 exit 钩子兜底。
    t.status = 'killed';
    return { kind: 'killed', plan, msg: plan ? describeTreeKill(plan) : '已发出终止（无 pid）' };
  }
}

export const backgroundStore = new BackgroundTaskStore();
