/**
 * 授权持久化 —— ROADMAP 10.9.1 的「工作区外写」那一半。
 * 调用方：harness/project-context.ts（播种时把**本项目**的长期放行目录栽回内存表）、
 *         commands/builtin/workspace.ts（`allow --save` 落盘、`clear` 清条目）
 * 服务于：把"外写放行"从**本会话**升级为**长期** —— 用户点名一次，以后每次启动都生效，
 *         不必每次重打。而"要不要放宽这条边界"的决定权**仍然只在用户手里**（见下）。
 *
 * ── 落点与形状 ──
 *   ~/.flint/permissions.json（**全局目录 + 按项目分区**，同 R12 的口径）
 *   { "version": 1,
 *     "projects": { "<归一化项目路径>": { "write": ["<绝对目录>", …] } } }
 *   · 放**全局**目录而不放项目的 `.flint/`：外写授权是"这台机器上这个人"的选择。
 *     放进项目目录会跟着仓库走 —— 别人 clone 走一份"我已经同意过"的名单，正是最坏的形状。
 *   · `write` 这一层**不是多余的嵌套**：C1 的 A 选项（只持久化只读类授权）将来加一个
 *     `read` 即可，文件形状与分区键都不用动。
 *
 * ── 四条承重 ──
 *
 * ① **磁盘在进程内只读一次**（沿用 ProjectRegistry 的手法：`loaded` 布尔 + 首次访问时载入）。
 *    这不只是省一次 IO：读完之后**运行期不再回读**，于是"模型改一行文件 → 立刻多一条授权"
 *    这条自我授权通路根本不存在。连带效果是 `/projects --switch` 切到新项目时取的是
 *    **内存里早就读到的那份快照**（不产生第二次磁盘读）而它照样正确 —— 因为快照里装的
 *    本来就是所有项目的条目。与 10.6.1 / 10.6.2 那条"只在启动读一次"是同一条纪律。
 *
 * ② **读不懂一律不启用**（同 postcheck 的「声明即授权」）：文件不存在 / JSON 坏 / 顶层形状
 *    不对 / 某个项目那段形状不对 / 元素不是字符串 —— 一律当**没有**。判据放在**读**这一侧
 *    （而不是使用侧），于是"坏了一半的文件"退化成空表，而不是半套生效。**绝不猜、绝不放宽**：
 *    这是授权书，宽容解析等于替用户签名。
 *
 * ③ **读不懂就不许覆盖**（承重②的下半句，单独列是因为它是**写**侧的事）：只要载入时记下了
 *    `loadError`，任何写操作一律**拒绝执行**并如实返回原因。否则 `allow --save` 会把一个
 *    "读不懂但里面有别的项目"的文件覆盖成只剩当前条目 —— 一次静默的跨项目数据丢失。
 *    同一条也管版本：`version` 不是 1（未来的格式）同样拒写，不猜怎么迁移。
 *
 * ④ **写失败必须看得见**（与 ProjectRegistry 的"登记失败静默"**刻意相反**）：那边是旁路便利
 *    （少记一条项目无所谓），这边是用户明确要求的授权 ——"以为存上了、其实没存"是最坏的
 *    一种静默（重启之后他不会再检查一遍）。故 `persistGrant` / `forgetGrants` 一律把错误
 *    原样返回给命令层，由回执说出来。
 *
 * ── 为什么默认**不**落盘（决策，写在这里防"顺手改成默认存"）──
 * `/workspace allow` 保持**本会话**语义，长期放行要显式 `--save`。理由与"autoKey 不截断"、
 * 与"契约锁要不要接权限子系统"是同一条：**宁可让用户多打一个词，也不让一次随手同意静默放大**。
 * 落盘 = 把"这次我同意"变成"以后每次都同意"，而那恰恰是 10.9.3 要防的那种静默失效 ——
 * 只是时间尺度从一次会话拉到了无限。
 *
 * ── 已知边界（不装糊涂）──
 * · 文件在 `~/.flint/`，**模型起个 shell 就能写它**（用 write / edit 反而写不到：那目录在
 *   工作区之外，被 10.9.3 的闸挡着）。但**启动之后不再回读**，所以运行期改它一律不生效，
 *   要等下次启动。这是"文件式授权"共有的边界，与 `.flint/postcheck.json` 同型。
 * · 分区键是**归一化后的 cwd**（复用注册表那把尺子，不另写一份），所以在仓库**子目录**里
 *   启动 = 另一个键 = 另一套授权。与"工作区就是 cwd"同一口径（见 workspace.ts 头注）。
 * · 只记目录，不记时间、不记"是谁批的"：这两样在会话级状态里都没有，编一个出来只是好看。
 * · 写盘不是原子的（一次 `writeFileSync`）：写到一半掉电会留下坏 JSON，此时承重②把它整份
 *   当没有 —— 代价是"长期放行没了得重放一次"，不是"拿到了半套授权"。方向是刻意选的。
 *
 * 零运行时依赖：只用 node:fs / node:path（内置）+ 两处本项目模块（全局目录常量、路径归一）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { GLOBAL_DIR } from '../config/manager.js';
import { normalizeProjectPath } from '../eventlog/registry.js';

/** 命名空间：目前只有"外写放行"，将来 C1 的只读授权加一层 `read` 即可（见文件头） */
export const GRANTS_NAMESPACE = 'write';

/** 认识的格式版本（不是这个数 → 拒写，见承重③） */
const KNOWN_VERSION = 1;

/**
 * 落点：全局目录下，跨项目共享（按项目分区）。
 *
 * 环境变量 `FLINT_PERMISSIONS_FILE` **在用的时候现读**（不写成模块级常量）——
 * 与 `FLINT_PROJECTS_FILE` / `FLINT_CONFIG` 同一手法：ESM 的 import 会被提升到文件顶部，
 * 写死在加载期的常量拿不到脚本里设的值。这条不是可有可无的便利：验证套件要真跑
 * `allow --save` 与 `clear`，没有这个开关，每跑一次都会往**用户真实的**
 * `~/.flint/permissions.json` 里写，甚至把他自己的长期放行清掉。
 */
export function permissionsFilePath(): string {
  return process.env.FLINT_PERMISSIONS_FILE || path.join(GLOBAL_DIR, 'permissions.json');
}

/** 内存快照：归一化项目键 → 该项目的长期外写目录（绝对路径）。整份文件只载入一次。 */
let snapshot = new Map<string, string[]>();

/** 载入是否已经发生过（承重①的闸：只读一次的"只"靠它） */
let loaded = false;

/** 载入时读不懂的原因（null = 读懂了或文件不存在）。非 null 时**一律拒写**（承重③） */
let loadError: string | null = null;

/** 相对写法按**项目键**解析（而不是按当前 cwd）—— 文件是写给项目看的，不是写给进程看的 */
function absDirOf(projectKey: string, d: string): string {
  return path.isAbsolute(d) ? path.resolve(d) : path.resolve(projectKey, d);
}

/**
 * 载入（首次访问时一次，之后**不回读**——承重①）。
 *
 * 全函数的失败都是"退化成空表"，唯一的例外是把原因记进 `loadError` 供写侧拒写：
 * 对**读**来说"读不懂"和"没有"行为相同（都不启用）；对**写**来说两者天差地别
 * （覆不覆盖别人那份数据）。
 */
export function loadGrantsFile(): void {
  if (loaded) return;
  loaded = true; // 先置位：载入过程本身不许再递归进来
  const file = permissionsFilePath();
  try {
    if (!existsSync(file)) return;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      loadError = '顶层不是一个对象';
      return;
    }
    const version = (raw as { version?: unknown }).version;
    if (version !== undefined && version !== KNOWN_VERSION) {
      loadError = `version 是 ${JSON.stringify(version)}，不是认识的 ${KNOWN_VERSION}`;
      return;
    }
    const projects = (raw as { projects?: unknown }).projects;
    if (projects === undefined) return; // 合法但空（例如刚被 clear 过）
    if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) {
      loadError = 'projects 不是一个对象';
      return;
    }
    for (const [key, section] of Object.entries(projects as Record<string, unknown>)) {
      if (typeof section !== 'object' || section === null || Array.isArray(section)) continue;
      const dirs = (section as Record<string, unknown>)[GRANTS_NAMESPACE];
      if (!Array.isArray(dirs)) continue;
      const projectKey = normalizeProjectPath(key);
      const kept: string[] = [];
      for (const d of dirs) {
        if (typeof d !== 'string' || d.trim() === '') continue;
        const abs = absDirOf(projectKey, d.trim());
        if (!kept.includes(abs)) kept.push(abs);
      }
      if (kept.length > 0) snapshot.set(projectKey, kept);
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
}

/** 本项目的长期放行目录（副本 —— 调用方改它不该影响快照）。 */
export function persistedGrants(projectKey: string): string[] {
  loadGrantsFile();
  return [...(snapshot.get(normalizeProjectPath(projectKey)) ?? [])];
}

/**
 * 序列化。键与目录都**排序**再写：同一份内存快照永远产出同一串字节，
 * 于是 ① 文件 diff 干净、② 套件可以拿整串文本比对（不用先解析）。
 * 空条目（目录数为 0）直接不落 —— `clear` 之后不该留下一个空壳让人以为还有东西。
 */
function serialize(): string {
  const projects: Record<string, Record<string, string[]>> = {};
  for (const key of [...snapshot.keys()].sort()) {
    const dirs = [...(snapshot.get(key) ?? [])].sort();
    // ⚠ 这里原有一支 `if (dirs.length === 0) continue;`（"空条目不落盘"）——**已按探针实证删掉**：
    //   三个写路径都不可能往快照里放进空数组（`persistGrant` 只会追加、`forgetGrants` 直接
    //   `snapshot.delete(key)`、载入侧是 `if (kept.length > 0)` 才 set），于是那一支**永远改不了
    //   结论**（变异 N26 全绿 = 那句"没有断言看得见它"的判决书）。
    //   "不留空壳"这件事由套件的 A13 钉在**真正的机制**上：`forgetGrants` 删键，不是留个空数组。
    projects[key] = { [GRANTS_NAMESPACE]: dirs };
  }
  return `${JSON.stringify({ version: KNOWN_VERSION, projects }, null, 2)}\n`;
}

/** 落盘。成功 undefined，失败返回原因（**不许静默** —— 承重④）。 */
function flush(): string | undefined {
  try {
    const file = permissionsFilePath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, serialize(), 'utf-8');
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 写之前统一过一遍承重③：读不懂就拒写（并说清为什么），绝不覆盖。 */
function refuseIfUnreadable(): string | undefined {
  loadGrantsFile();
  if (loadError === null) return undefined;
  return `${permissionsFilePath()} 读不懂（${loadError}）；为免覆盖里面可能存在的其它项目条目，本次**拒绝写入**`
    + ' —— 请先修好它或把它删掉。';
}

/**
 * 记一个目录为本项目的**长期**放行（含其子树）。成功 undefined，失败返回原因。
 *
 * `dir` 传**已经归一化的绝对路径**（`workspaceGrants.allow()` 的返回值）：再 resolve 一次
 * 会用到另一个基准，两个基准迟早对不上（文件里写着一个、内存表里判着另一个）。
 * 传相对路径也接得住（按项目键解析），但那是兜底不是用法。
 */
export function persistGrant(projectKey: string, dir: string): string | undefined {
  const refused = refuseIfUnreadable();
  if (refused !== undefined) return refused;
  const key = normalizeProjectPath(projectKey);
  const abs = absDirOf(key, dir);
  const cur = snapshot.get(key) ?? [];
  if (!cur.includes(abs)) snapshot.set(key, [...cur, abs]);
  return flush();
}

/**
 * 忘掉本项目的**全部**长期放行（用户 `/workspace clear`）。别的项目的条目一字不动。
 *
 * 盘上本来就没有本项目 → **不写盘**。两个理由：① 不为了"清空"凭空 create 一个文件；
 * ② 快照为空也可能是"文件读不懂"，而那时 `refuseIfUnreadable` 已经先挡下了 ——
 * 于是"清了个读不懂的文件"这种把别人数据擦掉的路径不存在。
 */
export function forgetGrants(projectKey: string): { removed: string[]; error?: string } {
  const refused = refuseIfUnreadable();
  if (refused !== undefined) return { removed: [], error: refused };
  const key = normalizeProjectPath(projectKey);
  const removed = snapshot.get(key) ?? [];
  if (removed.length === 0) return { removed: [] };
  snapshot.delete(key);
  const error = flush();
  return error === undefined ? { removed } : { removed, error };
}

/**
 * 清掉"只读一次"的记忆，让下一次访问重新读盘。
 *
 * **只给验证套件用**（用例之间要换一份文件）：生产路径上没有任何调用方 ——
 * 有了它，"运行期回读"就只差一次调用，而那正是承重①要挡的东西。
 * 故 verify-grants 里有一条源码守护钉着"src/ 下零调用方"。
 */
export function resetGrantsFileCache(): void {
  snapshot = new Map();
  loaded = false;
  loadError = null;
}
