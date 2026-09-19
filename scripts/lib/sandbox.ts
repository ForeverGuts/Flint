/**
 * scripts/lib/sandbox.ts —— 套件沙箱（**不是套件**：名字不以 `verify-` 开头，
 * `collect-stats.mjs` / `check-doc-numbers.mjs` 都按 `/^verify-.+\.(ts|mjs)$/` 过滤，扫不到它）
 *
 * 为什么要有它：flint 的三个落点里，**两个是相对 cwd 的路径**——
 *   · 账本 `.flint/events.jsonl`（`EVENTS_FILE`）
 *   · 项目登记（`ProjectRegistry`，走 `FLINT_PROJECTS_FILE`，缺省也落在 cwd 附近）
 * 第三个（`~/.flint/permissions.json`）虽然在**用户真实目录**里，但它是"长期放行"的唯一凭据。
 *
 * 于是：套件只要真跑一次"拦一笔 / 放行一笔 / 清一次"，这些东西就成了**项目资产的一部分**。
 * 2026-09-19 发现的实况：`verify-grants` / `verify-workspace` 各跑一遍就往
 * `Ts_Agent/.flint/events.jsonl` 塞十几条审计（`Temp\flint-grants-XXXX` 这种随机目录、
 * `放行 C:\` 这种边界用例），累计 123 条把真账本倒满 —— 而**报错系统完全看不见**
 * （审计落盘失败静默，见 `recordTaskArchive` 上方那句"旁路观测，落盘失败静默"）。
 *
 * 所以凡是会写这些落点的套件，**代码体的第一件事**就是 `enterSandbox()`：
 *   ① mkdtemp → ② 三个落点全部重定向 → ③ chdir 进去 → ④ **自证**重定向成功
 *   （任一条不成立就 exit(1)，绝不带着未隔离的 cwd 继续跑）→ ⑤ 退出时 chdir 回来 + 删临时目录。
 *
 * ⚠ 为什么必须是 `chdir`、不能只靠环境变量：`EVENTS_FILE` 是**模块加载时**定死的相对路径常量，
 *   而套件的 `import` 先于代码体执行 —— 等套件本体跑起来时它早绑好了。chdir 不一样：
 *   相对路径是在**写入那一刻**才参与解析的，所以来得及。授权/登记那两个是"用的时候现读 env"
 *   （`permissionsFilePath()` 是个函数），两种手法都行 —— 于是这里统一用 env 重定向 + chdir。
 *
 * ⚠ 它只管得住**本进程**。`spawn` 出去的子进程有自己的 cwd —— 那是另一条通路，由
 *   `collect-stats.mjs` 的"跑完账本必须一字未变"**逐套对账**兜底（那才是"网"；
 *   这里是"闸"）。两者分工：闸在写之前拦，网在跑完之后点名。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { permissionsFilePath } from '../../src/permission/grants.js';

export interface Sandbox {
  /** 临时根目录（退出时整个删掉） */
  readonly dir: string;
  /** 授权落点（重定向后） */
  readonly permissionsFile: string;
  /** 项目登记落点（重定向后） */
  readonly projectsFile: string;
  /** 账本绝对落点 —— 只给断言用（证明"写是写进了沙箱"） */
  readonly eventsFile: string;
}

let entered: Sandbox | undefined;

/**
 * 开一个沙箱并把当前进程搬进去。**必须在任何真写之前调用**（套件代码体的最前面）。
 * 自证失败 = 当场 `exit(1)`，不给"带着污染继续跑"的机会。
 */
export function enterSandbox(prefix: string): Sandbox {
  if (entered !== undefined) {
    throw new Error(`一个进程只允许进一次沙箱（已经进了 ${entered.dir}）—— 第二次调用说明前一次没收尾。`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cwd0 = process.cwd();
  const permissionsFile = path.join(dir, 'permissions.json');
  const projectsFile = path.join(dir, 'projects.jsonl');
  const eventsFile = path.join(dir, '.flint', 'events.jsonl');

  process.env.FLINT_PERMISSIONS_FILE = permissionsFile;
  process.env.FLINT_PROJECTS_FILE = projectsFile;
  process.chdir(dir);

  // 自证（不计项数）：三样东西都得落到实处，否则后面每一次写都在污染真项目/真用户目录
  const real = (p: string): string => {
    try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
  };
  const problems: string[] = [];
  if (real(process.cwd()) !== real(dir)) problems.push(`cwd 还在 ${process.cwd()}`);
  // 授权落点是"用的时候现读 env"，所以这里正好能顺带证伪"env 设晚了一步"这件事
  if (permissionsFilePath() !== permissionsFile) {
    problems.push(`授权落点 = ${permissionsFilePath()}`);
  }
  if (process.env.FLINT_PROJECTS_FILE !== projectsFile) {
    problems.push(`登记落点 = ${String(process.env.FLINT_PROJECTS_FILE)}`);
  }
  if (problems.length > 0) {
    console.error(`❌ 沙箱没兜住（${prefix}）：${problems.join('；')}\n`
      + '   拒绝继续：本套件会真写账本 / 真清授权 / 真登记项目，跑下去会污染项目资产'
      + '或删掉用户真实的长期放行。');
    process.exit(1);
  }

  process.on('exit', () => {
    try { process.chdir(cwd0); } catch { /* 回不去也不影响结论 */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 擦不动就留着 */ }
  });

  entered = { dir, permissionsFile, projectsFile, eventsFile };
  return entered;
}
