/**
 * 项目规约读取（ROADMAP 10.2.1，**判据**半边）—— 把"这个项目自己的规矩"从
 * "靠人肉口头传递 / 模型每次重新猜"变成"程序一次找到、每轮注入"。
 *
 * 调用方：`project/probe.ts`（探针，唯一碰盘处）、`context/system-prompt.ts`（注入侧）、
 *         `harness/project-context.ts`（播种）、`scripts/verify-rules.ts`
 * 服务于：用户在项目里写的 `AGENTS.md` / `CLAUDE.md`（"本项目怎么做事"）自动进模型视野 ——
 *         团队约定不必再靠人肉传递，也不会因为压缩把上下文压没了就丢。
 *
 * ── 为什么值得单做一条 ──
 * 本项目自己的 `CLAUDE.md` 就是活例子：它写着注释规范、文档规则、按需读哪份文件 ——
 * 而这些**只有人在旁边提醒时才会生效**。写进磁盘的规矩若进不了上下文，等于没写：
 * 模型看不见它，就只能按通用习惯办，然后人再纠正一遍（这份纠正的开销每次都要付）。
 *
 * ── 在哪一层：**折进 memory 层做分节，不新开一层**（与 10.1.1 同一判断）──
 * 备选是给 SystemPromptLayer 多一个 `rules`。否掉的理由不是"省事"，是**代价与收益不成比例**：
 * 分层序那条串（`core → tools → skills → project → memory → task → summary`）是承重的 ——
 * 改它要同步动 `core/system-prompt.ts` 的 union 与两处套件里的逐字断言，而**收益只是多一条消息**。
 * 缓存上也没有差别：命中与否都只影响"memory 这条消息重算"，它前面的前缀一个字不动。
 * 于是按 ROADMAP 原话"与 memory 分节"落地：**同一条消息里两节，规约在前、记忆在后**
 * （同层里 `project` 层早已是三半合一条消息，形状一致）。
 *
 * ── 三条判据（顺序是承重的，不是风格）──
 *   ① **先近后远**：cwd → 上一级 → 上两级。近的那份更具体，远的那份是它所在大项目/工作区的总则。
 *   ② **同目录内 `AGENTS.md` 优先于 `CLAUDE.md`**（`RULES_FILENAMES` 的数组顺序即优先级）：
 *      前者是跨工具中立约定（正在成为行业默认），后者是某个工具的私有名，中立的那份更该赢。
 *   ③ **首命中即停，不做合并**：找到第一份就返回，不再看后面的。
 *      这一条**刻意** —— "多份规约谁压谁 / 要不要叠加 / 命中矛盾怎么办"是 ROADMAP **10.2.3**
 *      （规则来源与优先级）与 **10.2.4**（冲突提示）那两条的活儿，本条只回答"**有没有、在哪**"。
 *      把优先级系统提前塞进来，等于让 10.2.3 无活可干、且这一条立刻需要一套没人拍过板的语义。
 *
 * ── 空文件不算命中（继续往下找）──
 * "存在但正文为空"若算命中，注入的就是一句空话（"本项目有规约，但它是空的"）——
 * 比不注入更坏：它会让模型以为规矩已经交代过了。故本模块的口径是
 * **命中 = 文件存在 且 正文非空**，空的 / 读不动的当作没看见、继续往下找。
 * 代价是"占位空 `AGENTS.md` + 有内容的 `CLAUDE.md`"会命中后者 —— 这是想要的行为。
 *
 * ── 读不动一律当没有（fail-open）──
 * 文件不存在 / 权限不够 / 是目录 / 编码坏掉 → 该候选跳过，全都没命中就整节缺席。
 * **注入层缺席是良性的**（模型照旧 `ls` / `read` 自己看），而抛异常会挡在每轮请求的必经之路上。
 *
 * 零运行时依赖：只 import `node:path`（**纯计算**，不碰盘、不起进程）—— 名单、顺序、等级、
 *   渲染、截断全是纯函数，于是每条分支都能构造着打靶（不必先造真目录、真文件）。碰盘在 `probe.ts`。
 */
import * as path from 'node:path';

/**
 * 规约文件名。**数组顺序即优先级**：同一目录里先找 `AGENTS.md`，没有才看 `CLAUDE.md`
 * （理由见文件头判据②）。**只认这两个** —— 别的名字（`.cursorrules` / `GEMINI.md` …）
 * 各有各的格式约定，进来一个就得回答"它算不算同一类"，而本条只做已被两个生态共同承认的那对。
 */
export const RULES_FILENAMES: readonly string[] = ['AGENTS.md', 'CLAUDE.md'];

/**
 * 向上找几级。**cwd 本身算第 0 级**，故 2 = "cwd、上一级、上两级"共三层。
 * 为什么是 2 而不是"一直向上到根"：再往上的目录已经越过了"这个项目"的边界
 * （家目录 / 盘根下不该有规约在起作用），而每一级都要付一次 `existsSync`。
 */
export const RULES_UP_LEVELS = 2;

/**
 * 注入上限（字符）。**与现状快照同一口径**（`snapshot.ts` 的 `SNAPSHOT_MAX = 3000`）：
 * 两者都是"一页纸说清"的文档，超了就是写法跑偏。注入是**展示**，可以截；
 * 截断处标一刀，让模型知道还有后文（它还知道文件名与在哪一级，能自己去 `read`）。
 */
export const RULES_MAX = 3000;

/** cwd 上溯等级 → 人读的方位词（渲染用；等级超出表长时退化成"上溯 N 级"，不编一个假方位） */
const LEVEL_WORDS: readonly string[] = ['项目根', '上一级目录', '上两级目录'];

/** 一个候选（还没碰盘）：绝对路径 + 文件名 + 取自哪一级 */
export interface RulesCandidate {
  /** 绝对路径（`path.join(dir, name)` 的结果），探针拿它去 `existsSync` / `readFileSync` */
  abs: string;
  /** 文件名（渲染时告诉模型"这份规矩叫什么"） */
  name: string;
  /** 取自 cwd 上溯几级（0 = cwd 本身） */
  level: number;
}

/**
 * 候选名单（**纯函数**，不碰盘）—— 顺序即搜索顺序（先近后远；同目录内按 `RULES_FILENAMES`）。
 * 探针只需按顺序做存在性检查 + 读，判据一条都不必重写。
 *
 * **到盘根就停**：`path.dirname(root) === root`，再往上还是它自己 —— 不停的话
 * `C:\AGENTS.md` 会被当成"上一级"和"上两级"各探一遍，同一个文件被报出三个等级，
 * 而**等级正是要渲染给模型看的东西**（"取自上一级目录"就成了假话）。
 * 所以这里把停留条件写进判据本身，而不是靠调用方去重 —— 于是"盘根起步只出两条候选"
 * 这件事可以拿 `rulesCandidates('C:/')` 直接打靶。
 */
export function rulesCandidates(cwd: string): RulesCandidate[] {
  const out: RulesCandidate[] = [];
  let dir = path.resolve(cwd);
  for (let level = 0; level <= RULES_UP_LEVELS; level++) {
    for (const name of RULES_FILENAMES) out.push({ abs: path.join(dir, name), name, level });
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

/**
 * 截断（**纯函数**）。空 / 全空白 → `undefined`（**不注入一句空话**，调用方据此当"没命中"）。
 * 与 `snapshot.ts` 的 `clipSnapshot` 同一形状 —— 两处的差别只有上限常量来自各自模块。
 */
export function clipRules(text: string, max: number = RULES_MAX): string | undefined {
  const t = typeof text === 'string' ? text.trim() : '';
  if (t === '') return undefined;
  return t.length > max ? `${t.slice(0, max)}\n...（截断）` : t;
}

/** 一次命中：文件在哪一级、叫什么、正文（**必非空** —— 空文件不算命中，见文件头） */
export interface RulesHit {
  /** 命中的文件名（如 `AGENTS.md`） */
  name: string;
  /** 取自 cwd 上溯几级：0 = cwd 本身，1 = 上一级，2 = 上两级 */
  level: number;
  /** 注入上限内的正文（trim 过，非空） */
  text: string;
}

/**
 * 渲染注入用的【项目规约】节。没命中 / 正文为空 → **空串**（整节缺席）——
 * 与 project / memory / task 各层同一纪律：没有就不注入，别拿空壳占上下文。
 *
 * 标题里那句"由人维护 / 与下方项目记忆冲突时以这里为准"是**给人看的路标**：
 * 它和项目记忆同层出现，没有这句话，模型会把两节读成一回事 —— 而两者的权威来源完全不同
 * （这份是**人写下的规矩**，那份是**模型自己攒的结论**）。冲突时以人为准。
 */
export function renderRulesSection(hit: RulesHit | null): string {
  if (!hit || typeof hit.text !== 'string' || hit.text.trim() === '') return '';
  const name = hit.name || RULES_FILENAMES[0]!;
  const where = LEVEL_WORDS[hit.level] ?? `上溯 ${hit.level} 级`;
  return `[项目规约]（${name}，取自${where} —— 本项目的规矩，由人维护；与下方项目记忆冲突时以这里为准）\n${hit.text}`;
}

/**
 * 当前项目的规约（内存单例）。**运行期唯一真相源**，与 `stackRegistry` / `commandRegistry`
 * 同一手法：由 `harness/project-context.ts` 在**启动与切换项目时**各播种一次，之后不再回读磁盘。
 *
 * ── 为什么是"播种一次"而不是"每轮现读"（像 `.flint/PROJECT.md` 那样）──
 * 判据是**这条内容在会话内该不该变**：
 *   · `PROJECT.md` 是**模型自己的工作记录**，"会话内会变"正是它的本职 → 每轮现读、改完即生效；
 *   · 规约是**人写的规矩**，会话内不该变 —— 而运行期回读会让模型 `write AGENTS.md` 就改写
 *     自己下一轮的注入内容（自我条件化），与 10.6.1 / 10.6.2 "用看得见的缺失换掉看不见的通路"
 *     同一条界线。改规约要重启（或 `/projects --switch`）才生效，代价是"重打一次"，收益是
 *     "规矩从哪来"这件事不在模型手里。
 */
let current: RulesHit | null = null;

export const rulesRegistry = {
  set(hit: RulesHit | null): void {
    current = hit ?? null;
  },
  get(): RulesHit | null {
    return current;
  },
  /** 复位（切换项目与测试都要用：模块级单例会跨项目 / 跨套件残留） */
  clear(): void {
    current = null;
  },
};
