/**
 * 起子进程并**管住它的整棵树** —— I/O 部分（ROADMAP 10.6.6）。
 *
 * 策略（该杀谁、怎么杀、POSIX 与 Windows 的差别）在 `proctree.ts`，本文件只负责执行：
 * 起进程、攒输出、到点按树杀、把观测折成调用方能用的形状。
 *
 * ── 为什么是异步 spawn 而不是 spawnSync / execSync ──────────────────────────
 * 见 proctree.ts 文件头（一句话：同步 API 超时返回时 shell 已经死了，那时再想按树杀，
 * Windows 的 `/T` 已经找不到孙子 —— 探针实测 status=128）。代价是本函数必须自己
 * 接管三件原本由同步 API 代劳的事：
 *
 *   ① **攒输出**：手动收 stdout / stderr，自己盯 maxBuffer（超了就按树杀，
 *      否则一个疯狂输出的子进程会把 flint 的内存吃光）。
 *   ② **判定结束**：等 `close`（不是 `exit`）—— `close` 意味着 stdio 管道也关了。
 *      但正因如此它可能被"仍攥着管道的后代"卡住，所以杀树之后还挂一条
 *      `TREE_KILL_GRACE_MS` 的兜底定时器**强制结算**，把"超时"从"永久卡住"里救回来。
 *   ③ **映射失败**：把 (超时 / 超缓冲 / 起不来) 折成 postcheck 契约里那三个 errorCode，
 *      对外可观测的形状与换机制之前**逐字一致**。
 *
 * ── 与 execSync 的两处刻意对齐 ─────────────────────────────────────────────
 *   · `stdio[0] = 'inherit'`：execSync 的 stdin 是继承父进程的。若改成管道且没人写，
 *     一条读 stdin 的命令会静默挂住直到超时 —— 那是把一个"等输入"的行为伪装成"超时"。
 *   · 非零退出**不抛异常**：这里把退出码当成数据还回去（bash 的失败输出、自检的
 *     未通过判定都要读它）。抛异常只适合"只要成功/失败"的调用方，这里不是。
 */

import type { TreeKillPlan } from './proctree.js';
import { TREE_KILL_GRACE_MS, classifyChildFailure, planTreeKill, spawnDetached } from './proctree.js';

export interface ChildRunOptions {
  /** 一整句 shell 命令（含空格与参数），**走 shell** —— 与 git 工具"参数即数据"相反 */
  command: string;
  /** 上限；到点按树杀 */
  timeoutMs: number;
  /** 单流输出上限；超了按树杀（子进程还在往外写，不杀会一直攒） */
  maxBuffer: number;
  cwd: string;
}

export interface ChildRunOutcome {
  /** 退出码；null = 没正常退出（被超时杀掉 / 被信号中止） */
  status: number | null;
  /** 中止信号名；正常结束为 null */
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  /** 到了上限还没结束，**已按树终止** */
  timedOut: boolean;
  /** 输出超 maxBuffer，**已按树终止** */
  overflow: boolean;
  /** 进程根本起不来（error 事件）时的 code 与说明 */
  spawnError: { code: string; message: string } | null;
  /** 真发出去过的杀树计划；没触发过是 null —— 调用方据此知道"这次没杀成" */
  killPlan: TreeKillPlan | null;
  /** true = 靠宽限期兜底结算的（正常路径是 close 事件）。观测用，不影响判定 */
  settleForced: boolean;
}

/** 折成 postcheck 契约的 errorCode（null = 正常结束，退出码才是判据） */
export function childFailureCode(o: ChildRunOutcome): 'ETIMEDOUT' | 'ENOBUFS' | 'SPAWN_FAILED' | null {
  return classifyChildFailure({
    timedOut: o.timedOut,
    overflow: o.overflow,
    spawnErrorCode: o.spawnError === null ? null : o.spawnError.code,
  });
}

export async function runChildInTree(o: ChildRunOptions): Promise<ChildRunOutcome> {
  const { spawn, spawnSync } = await import('node:child_process');
  const platform = process.platform;

  return await new Promise<ChildRunOutcome>((resolve) => {
    const child = spawn(o.command, {
      shell: true,
      cwd: o.cwd,
      windowsHide: true,
      detached: spawnDetached(platform),
      // stdin 继承父进程（对齐 execSync）；stdout / stderr 走管道自己收
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let overflow = false;
    let spawnError: { code: string; message: string } | null = null;
    let killPlan: TreeKillPlan | null = null;
    let settleForced = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (status: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      resolve({
        status,
        signal,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks),
        timedOut,
        overflow,
        spawnError,
        killPlan,
        settleForced,
      });
    };

    /**
     * 端掉整棵树。三条判定都不是洁癖：
     *   · 计划算不出来（没 pid）= 压根没起来，如实记 null，不伪造"杀过了"；
     *   · 进程**已经退出**就不动手 —— 此刻那个 pid 已无主，杀它可能伤到被复用了同一
     *     pid 的无关进程；
     *   · 杀完不在这里结算，交给 close / 宽限期 —— 那两处才掌握"输出收干净了没有"。
     */
    const killTree = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const plan = planTreeKill(child.pid, platform);
      if (plan === null) return;
      killPlan = plan;
      if (plan.kind === 'taskkill') {
        try {
          spawnSync('taskkill', [...plan.argv], { encoding: 'buffer', windowsHide: true });
        } catch { /* taskkill 自己起不来（极罕见）不该把超时处理搞崩 */ }
        return;
      }
      try {
        process.kill(plan.pid, plan.signal);
      } catch { /* 组已经不在了 = 目的已达到 */ }
    };

    /** 兜底：杀树之后 close 仍不来（有后代攥着管道不放）就强制结算，别把超时变成卡死 */
    const armGrace = (): void => {
      if (graceTimer !== null || settled) return;
      graceTimer = setTimeout(() => {
        settleForced = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(child.exitCode, child.signalCode === null ? null : String(child.signalCode));
      }, TREE_KILL_GRACE_MS);
    };

    timer = setTimeout(() => {
      timedOut = true;
      killTree();
      armGrace();
    }, o.timeoutMs);

    const onData = (chunk: Buffer, isOut: boolean): void => {
      if (settled) return;
      if (isOut) {
        outBytes += chunk.length;
        if (outBytes > o.maxBuffer) { overflow = true; killTree(); armGrace(); return; }
        outChunks.push(chunk);
        return;
      }
      errBytes += chunk.length;
      if (errBytes > o.maxBuffer) { overflow = true; killTree(); armGrace(); return; }
      errChunks.push(chunk);
    };

    child.stdout?.on('data', (c: Buffer) => onData(c, true));
    child.stderr?.on('data', (c: Buffer) => onData(c, false));
    child.on('error', (e: Error & { code?: string }) => {
      spawnError = { code: e.code ?? 'SPAWN_FAILED', message: e.message.slice(0, 200) };
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal === null ? null : String(signal)));
  });
}
