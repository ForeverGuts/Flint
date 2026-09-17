/**
 * 技术栈自动探测（ROADMAP 10.1.1，**判据**半边）—— 把"这个项目用什么语言、用哪个包管理器"
 * 从"模型每轮 ls + read 现猜"变成"程序一次探测、每轮注入"。
 *
 * 为什么值得单做一条：进一个陌生项目，第一件事就是判断"这是 TS 还是 Python""该跑 npm 还是 pnpm"。
 * 判错的代价不是报错，而是**看着像项目不通过**（命令不存在只是退出码非 0）—— 模型不知道自己猜错了。
 * 把画像摆进上下文，"是什么"变成**读**而不是**猜**。
 *
 * ── 与 10.6.1（项目命令表）的分工 ──
 *   10.6.1 解决"有哪些命令"（从 `package.json` 的 scripts 发现）；本条解决"**在哪个生态里、用哪个包管理器**"。
 *   两半的接头处只有一处：`nodeManager` —— 命令表的 `run` 串（`npm run test`）由它派生。
 *   `commands.ts` 的注释里早就留了这句话（"不嗅探包管理器，pnpm/yarn/bun 归 10.1.1 那类画像活儿"），
 *   本条就是去兑现它。
 *
 * ── 原料清单**不另开一份**（承重）──
 *   `MANIFEST_FILES` 从 `detect.ts` 接过来（那边的注释里也点名要接），它答的是"什么算项目清单"。
 *   本条在原样复用它的基础上**只加不减**地补探测用文件（锁文件 / tsconfig / build.gradle …）。
 *   方向是**单向**的（stack → detect）：加长的这份**不得回流**去当准入证据 ——
 *   那边的注释说得很清楚，`requirements.txt` / `Makefile` 之类"在子目录里遍地都是，会把判据打穿"。
 *   于是两个用途共用一份**下限**、各自持有自己的**上限**，谁也别替谁做主。
 *
 * ── 判据（顺序是承重的，不是风格）──
 *   Node 生态的包管理器取三选一，优先级 **declaration > evidence > default**：
 *     ① `package.json` 的 `packageManager` 字段（corepack 的**声明**）—— 认不出即丢弃，往下滚；
 *     ② 锁文件（**实物证据**）—— 多个锁文件同时存在时按固定优先级取第一个，不随机；
 *     ③ 有 `package.json` 但两者皆无 → 默认 `npm`（命令表从前就是这么硬写的，行为不回退）。
 *   反过来，**没有 `package.json` 就绝不认 npm** —— 一个纯 Rust 项目不该被说成"用 npm"。
 *   非 Node 生态（Python / Go / Rust / Java）**只报语言与包管理器名**，不派生命令：
 *   那几个生态里"test 该跑什么"本机没有可对拍的实现（装不了 cargo / go / poetry），
 *   按本项目"没实测到的那一半不许用推理补"的纪律（同 `commands.ts` 的 Makefile 半边），留白不猜。
 *
 * ── 说不出就直说（不装糊涂）──
 *   `manager` 判不出来时是 **null**，且 `via` 一定要给一句**原因**（"pyproject.toml 不说明用哪个工具"）。
 *   编一个"看着合理"的默认，比留白危险得多：留白模型会去读文件确认，编错的它不会。
 *
 * 零运行时依赖：不碰磁盘、不起进程（只 `import` 一个纯判据模块）。读文件在 `probe.ts`，
 *   注入在 `context/system-prompt.ts` 的 project 层。
 */
import { MANIFEST_FILES } from './detect.js';

/** Node 生态的三个包管理器之外再加 bun —— 命令表能用的就这四个（`run` 串的形状都合法） */
export type NodeManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Node 锁文件 → 包管理器。**顺序即优先级**：取第一个命中，不随机 */
const NODE_LOCKFILES: ReadonlyArray<readonly [string, NodeManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

/** Python 的"用了哪个工具"证据。`requirements.txt` 单列（它是清单也是 pip 的证据，见 detectStack） */
const PY_TOOL_FILES: ReadonlyArray<readonly [string, string]> = [
  ['uv.lock', 'uv'],
  ['poetry.lock', 'poetry'],
  ['Pipfile', 'pipenv'],
];

/** Python 清单文件（只答"这是 Python"，不答"用哪个工具"） */
const PY_MARKERS: readonly string[] = ['pyproject.toml', 'requirements.txt', 'setup.py'];

/**
 * 探测要看的**文件全集**（存在性检查用）。`probe.ts` 逐个 `existsSync`，结果喂回 `detectStack`。
 * 下限来自 `MANIFEST_FILES`（与准入判据共用），上限是本条自己加的 —— 加长的部分**不回流**。
 * `Makefile` **刻意不在表里**：它是构建工具不是包管理器，而它的 target 语法本机没有 `make`
 * 可对拍（同 `commands.ts` 的边界），摆进来只会多一个"看着像能用"的假信号。
 */
export const STACK_CANDIDATES: readonly string[] = Array.from(new Set<string>([
  ...MANIFEST_FILES,
  'tsconfig.json',
  ...NODE_LOCKFILES.map(([f]) => f),
  ...PY_MARKERS,
  ...PY_TOOL_FILES.map(([f]) => f),
  'build.gradle',
  'build.gradle.kts',
]));

/** 一个生态（语言）的探测结论 */
export interface StackItem {
  /** 语言 / 生态名（人读，如 `TypeScript` / `Rust`） */
  language: string;
  /** 包管理器名；**判不出来是 null**，绝不编一个 */
  manager: string | null;
  /** `manager` 的依据，或判不出来的原因 —— 一律给一句话，不留空 */
  via: string;
  /** 命中的标记文件（为什么认成这个生态） */
  markers: readonly string[];
}

export interface ProjectStack {
  /** 命中的生态，按固定顺序（Node → Python → Go → Rust → Java），与文件系统返回顺序无关 */
  items: readonly StackItem[];
  /** 命令表该用的 Node 包管理器；**没有 Node 生态时是 null**（此时命令表退回默认 npm） */
  nodeManager: NodeManager | null;
}

/** 空画像 —— 无任何标记命中时的结论，也是注册表的初值 */
export const EMPTY_STACK: ProjectStack = { items: [], nodeManager: null };

/** 探测输入（探针已探好，本模块只判） */
export interface StackProbes {
  /** 目录下**存在**的标记文件名（`STACK_CANDIDATES` 的子集） */
  files: readonly string[];
  /** `package.json` 的文本；不存在 / 读不到传 null */
  packageJson: string | null;
}

/**
 * 读 `package.json` 的 `packageManager` 字段（corepack 的声明，形如 `pnpm@9.1.0` /
 * `yarn@4.0.0+sha256.…`）。**只认四个已知名字**：值取 `@` 之前那段并小写，
 * 认不出（`make@1`、非字符串、缺字段、文本不是 JSON）一律 null —— 认不出即丢弃，
 * 让判据往下滚到锁文件，而不是把一个陌生字符串当命令前缀塞进 `run` 串。
 */
export function parsePackageManagerField(text: unknown): NodeManager | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const field = (raw as Record<string, unknown>).packageManager;
  if (typeof field !== 'string') return null;
  const name = field.split('@')[0]?.trim().toLowerCase() ?? '';
  return (NODE_LOCKFILES.some(([, m]) => m === name) ? (name as NodeManager) : null);
}

/**
 * 存在性探测 → 技术栈画像。**纯函数**：输入是"哪些文件存在"，于是每条分支都能构造着打靶，
 * 不必先造一个真目录（同 `detect.ts` / `probe.ts` 的分家理由）。
 */
export function detectStack(p: StackProbes): ProjectStack {
  const files: readonly string[] = Array.isArray(p?.files) ? p.files : [];
  const json = p?.packageJson ?? null;
  const has = (f: string): boolean => files.includes(f);
  const items: StackItem[] = [];
  let nodeManager: NodeManager | null = null;

  // ── ① Node / TypeScript ──
  const nodeLock = NODE_LOCKFILES.filter(([f]) => has(f));
  if (has('package.json') || has('tsconfig.json') || nodeLock.length > 0) {
    const declared = parsePackageManagerField(json);
    let manager: string | null = null;
    let via: string;
    if (declared) {
      manager = declared;
      via = '`package.json` 的 `packageManager` 字段（corepack 的声明）';
    } else if (nodeLock.length > 0) {
      const [file, name] = nodeLock[0]!;
      manager = name;
      via = `锁文件 \`${file}\``;
    } else if (has('package.json')) {
      manager = 'npm';
      via = '默认（既无锁文件，也无 `packageManager` 字段）';
    } else {
      // 注意：`via` 是**纯原因**，不带"判不出来"这几个字 —— 那三个字由渲染器加且只加一次。
      // 两处都带就会印成"包管理器判不出来 —— 判不出来（…）"（"拼接放大"缺陷：单条路径上
      // 各自正确的东西，一拼接就重复。演示脚本第一次跑就把它照出来了，套件里钉在 B7）。
      via = '只有 `tsconfig.json`，没有 `package.json` 说明用哪个工具';
    }
    // 类型是 TS 还是 JS：有 tsconfig.json 就是 TS（比翻 devDependencies 稳，且不解析内容）
    items.push({
      language: has('tsconfig.json') ? 'TypeScript' : 'JavaScript',
      manager,
      via,
      markers: [...(has('package.json') ? ['package.json'] : []),
        ...(has('tsconfig.json') ? ['tsconfig.json'] : []),
        ...nodeLock.map(([f]) => f)],
    });
    nodeManager = (manager as NodeManager | null);
  }

  // ── ② Python ──
  const pyTools = PY_TOOL_FILES.filter(([f]) => has(f));
  const pyMarkers = PY_MARKERS.filter(has);
  if (pyMarkers.length > 0 || pyTools.length > 0) {
    let manager: string | null = null;
    let via: string;
    if (pyTools.length > 0) {
      const [file, name] = pyTools[0]!;
      manager = name;
      via = `工具文件 \`${file}\``;
    } else if (has('requirements.txt')) {
      manager = 'pip';
      via = '`requirements.txt`（装依赖的是 pip；没见到 poetry / uv / pipenv 的痕迹）';
    } else {
      // 同样只给原因，前缀由渲染器加（见上面 tsconfig 分支的说明）
      via = '`pyproject.toml` 只声明依赖，不说明用哪个工具装';
    }
    items.push({
      language: 'Python',
      manager,
      via,
      markers: [...pyMarkers, ...pyTools.map(([f]) => f)],
    });
  }

  // ── ③ Go / ④ Rust / ⑤ Java（只报名字，不派生命令 —— 边界见文件头）──
  if (has('go.mod')) items.push({ language: 'Go', manager: 'go', via: '`go.mod`（Go 模块内建）', markers: ['go.mod'] });
  if (has('Cargo.toml')) items.push({ language: 'Rust', manager: 'cargo', via: '`Cargo.toml`', markers: ['Cargo.toml'] });
  const javaMarkers = ['pom.xml', 'build.gradle', 'build.gradle.kts'].filter(has);
  if (javaMarkers.length > 0) {
    const maven = has('pom.xml');
    items.push({
      language: 'Java',
      manager: maven ? 'mvn' : 'gradle',
      via: maven ? '`pom.xml`（Maven）' : '`build.gradle`（Gradle）',
      markers: javaMarkers,
    });
  }

  return { items, nodeManager };
}

/**
 * 渲染注入用的【项目技术栈】段。**空画像返回空串**（整段缺席）——
 * 与 project/memory/task 三层同一纪律：没有就不注入，别拿空壳占上下文。
 *
 * 标题里那句"命令表用的包管理器由这里派生"是**给人看的路标**：它与命令表同层出现，
 * 没有这句话，模型会把两处口径当成两件事。
 */
export function renderStackSection(stack: ProjectStack): string {
  const items = Array.isArray(stack?.items) ? stack.items : [];
  if (items.length === 0) return '';
  const lines = items.map((it) => {
    const pm = it.manager === null ? `包管理器判不出来 —— ${it.via}` : `包管理器 \`${it.manager}\` —— ${it.via}`;
    return `- ${it.language}：${pm}；标记：${it.markers.join('、')}`;
  });
  return `## 项目技术栈（存在性探测；命令表的包管理器由这里派生）\n${lines.join('\n')}`;
}

/**
 * 当前项目的技术栈（内存单例）。**运行期唯一真相源**，与 `commandRegistry` 同一手法：
 * 由 `harness/project-context.ts` 在**启动与切换项目时**各播种一次，之后运行期不再回读磁盘。
 *
 * 为什么不是"每轮现读"（像 `.flint/PROJECT.md` 那样）：命令表的 `run` 串要从这里取包管理器，
 * 而命令表本身**只在启动读一次**（`package.json` 是模型可写文件，运行期重读会开出免弹窗执行的路）。
 * 两半若刷新率不同，就会出现"画像段说 pnpm、命令表写着 npm"——**同一段上下文里两个口径**。
 * 同播种、同刷新，是让它们不可能分家的唯一办法。
 *
 * `nodeManager` 判不出来时由调用方退回 `'npm'`（见 `main.ts`），本模块**不替它决定**。
 */
let current: ProjectStack = EMPTY_STACK;

export const stackRegistry = {
  set(stack: ProjectStack): void {
    current = stack && Array.isArray(stack.items) ? stack : EMPTY_STACK;
  },
  get(): ProjectStack {
    return current;
  },
  /** 复位（测试与"切换项目"都要用：模块级单例会跨套件 / 跨项目残留） */
  clear(): void {
    current = EMPTY_STACK;
  },
};
