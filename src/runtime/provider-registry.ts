/**
 * 供应商注册表 —— 运行时管理所有可用的 AI 供应商。
 * 调用方：/provider 命令、/model 命令、runtime.ts（兜底机制）、main.ts（启动初始化）
 * 服务于：统一管理各供应商的地址、密钥解析、可用模型列表
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 完整生命周期工作流
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 【阶段一：程序启动】
 *
 *   main.ts 启动 → 首次调用 getProviderRegistry()
 *        │
 *        ▼
 *   getProviderRegistry() 返回 Promise<ProviderRegistry>
 *        │
 *        ├── new ProviderRegistry()  ← 同步构造，做 3 件事（两个加载方法配套使用）：
 *        │      ① loadProviderKeys()        读 config/provider-keys.json
 *        │                                   （各供应商密钥的持久化存储，敏感）
 *        │      ② loadProviderDefinitions() 读 config/providers.json
 *        │                                   （供应商定义的持久化存储：id/name/baseUrl/type/apiKeyEnv/staticModels，公开）
 *        │                                   → 逐个 set 进 Map，apiKey 由 resolveApiKey() 解析
 *        │      ③ applyStoredKeysAndActivation()  若 keys 文件有密钥且环境变量没给，补到供应商上
 *        │
 *        └── await registry.init()  ← 异步初始化，并行拉取模型列表：
 *                任务 = getAll().map(每个供应商) ：
 *                     ├─ 无 apiKey → 跳过（用 staticModels 兜底）
 *                     └─ 有 apiKey → fetchRemoteModels(p)
 *                                     └─ fetch {baseUrl}/models
 *                                        ├─ 成功 → 覆盖为远程模型列表
 *                                        └─ 失败/超时 → 保留 staticModels
 *                等所有任务完成（Promise.all）后 init() 返回
 *
 * 【阶段二：运行中 —— LLM 调用正常】
 *
 *   Runtime.prompt() → this.llm.chat(toolMessages)
 *        │
 *        └─ 正常 → 返回回复，流程继续
 *
 * 【阶段三：运行中 —— LLM 调用失败，触发兜底】
 *
 *   Runtime.prompt() → this.llm.chat() 抛出异常
 *        │
 *        ▼
 *   runtime.ts 的 tryFallbackOnError(err)
 *        │
 *        ├── await getProviderRegistry()     （拿到已初始化的单例）
 *        │
 *        ├── registry.getFallback()
 *        │       └─ 遍历所有供应商，找：
 *        │              isDefault === true   （providers.json 里标记的兜底供应商）
 *        │          且 apiKey 非空            （有密钥才能用）
 *        │          且 models 非空
 *        │       → 优先选 deepseek-v4-flash，没有则第一个模型
 *        │       → 返回 { provider, modelId }
 *        │
 *        ├── 弹出 ↑↓ 选择器询问："是否切换到兜底模型？"
 *        │       ├─ 选"切换" →
 *        │       │    createProvider({ type, baseUrl, apiKey, model })
 *        │       │    → runtime.setLLM(newProvider)  热替换 LLM
 *        │       │    → 返回 true → 原调用处用新 Provider 重试 chat()
 *        │       └─ 选"不切换" → 返回 false → prompt 结束，报错
 *        │
 *        └── （非 TTY 管道模式自动跳过，不弹窗）
 *
 * 【阶段四：用户手动切换供应商 —— /provider 命令】
 *
 *   /provider → await getProviderRegistry()
 *        │
 *        ├── 第 1 级选择器：列出所有供应商
 *        │       ├─ 有 apiKey → 正常可选
 *        │       └─ 无 apiKey → 也可选（选中后提示输入密钥）
 *        │
 *        ├── 若无 apiKey：
 *        │       promptApiKey()  ← readLine 交互输入
 *        │       → registry.setApiKey(id, key)  存 config/provider-keys.json
 *        │       → registry.refreshModels(id)   重新拉取该供应商模型
 *        │
 *        ├── 第 2 级选择器：列出该供应商的模型（↑↓ 选择）
 *        │
 *        └── applyProviderSelection()
 *                ├─ registry.activate(id, modelId)   写 config/active-config.json（唯一真相源）
 *                ├─ createProvider(...) → runtime.setLLM()   热切换
 *                └─ 更新 runtime.currentProvider/baseUrl/model
 *
 * 【阶段五：重启程序 —— 恢复上次状态】
 *
 *   重启 → 再次 getProviderRegistry()
 *        │
 *        ├── loadProviderDefinitions() 重新载入定义
 *        │       → resolveApiKey()：环境变量优先，keys 密钥持久化次之，恢复 apiKey
 *        │
 *        ├── init() 重新拉取模型
 *        │
 *        └── getActive() 读 config/active-config.json → 恢复上次激活的供应商 + 模型
 *                → Banner 显示恢复的 Backend / Model
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 方法职责速查
 * ────────────────────────────────────────────────────────────────────────────
 *   loadProviderKeys()        读 provider-keys.json（各供应商密钥的持久化存储，敏感）
 *   loadProviderDefinitions() 读 providers.json（供应商定义的持久化存储，公开）
 *   resolveApiKey()           环境变量 > keys 密钥持久化 > 空，解析某供应商密钥
 *   applyStoredKeysAndActivation() 把 keys 密钥补到未配置环境变量的供应商
 *   init()                    并行拉取所有有 key 供应商的远程模型
 *   fetchRemoteModels()       单个供应商 fetch {baseUrl}/models，失败返回 []
 *   refreshModels()           运行中重新拉取单个供应商模型（/provider 输入 key 后）
 *   getAll() / get()          获取全部 / 单个供应商
 *   getActive()               获取当前激活供应商（读 config/active-config.json）
 *   getActiveModel()          获取当前激活模型（读 config/active-config.json）
 *   loadActiveConfig()        读 config/active-config.json 返回 { providerId, modelId }
 *   saveActiveConfig()        写 config/active-config.json（保留 apiKey/baseUrl，更新 provider+model）
 *   getFallback()             找 isDefault 且有 key 的兜底供应商 + 模型
 *   setApiKey()               设置密钥并写 provider-keys.json
 *   activate()                激活供应商+模型并写 config/active-config.json
 *   getProviderRegistry()   Promise 单例，首次调用时构造 + init()
 */
import { readFileSync, writeFileSync } from 'node:fs';

/* ════════════════════════════════════════════════════════════════════════════
   类型定义
   ════════════════════════════════════════════════════════════════════════════ */

/** 供应商可用的模型信息 */
export interface ProviderModel {
  /** 模型 ID（传给 API 的 model 参数） */
  id: string;
  /** 显示名称 */
  label: string;
  /** 简短描述 */
  description?: string;
  /** 是否来自静态列表（远程拉取失败时合并的兜底模型，选择器标注"静态模型"） */
  isStatic?: boolean;
}

/** providers.json 中的原始定义（可编辑） */
interface ProviderConfigJson {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** API 基础地址 */
  baseUrl: string;
  /** 厂商类型（对应 LLMConfig.provider：deepseek/openai/anthropic/opencode-go） */
  type: string;
  /** 环境变量名（优先从此读取 API Key，如 "OPENCODE_GO_KEY"） */
  apiKeyEnv?: string;
  /** 兜底供应商标记（LLM 报错时切到它） */
  isDefault?: boolean;
  /** 静态模型列表（远程拉取失败时使用） */
  staticModels?: ProviderModel[];
}

/** 运行时供应商定义（含解析后的 apiKey 和最终 models） */
export interface ProviderDefinition {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** API 基础地址 */
  baseUrl: string;
  /** 厂商类型 */
  type: string;
  /** 解析后的 API Key（环境变量 > provider-keys > 空） */
  apiKey: string;
  /** 环境变量名（提示用户设置用） */
  apiKeyEnv?: string;
  /** 是否兜底供应商 */
  isDefault: boolean;
  /** 静态模型列表（providers.json 中人工维护的精选，合并时作为兜底补充） */
  staticModels: ProviderModel[];
  /** 最终可用模型列表（远程 + 静态合并后的结果） */
  models: ProviderModel[];
}

/**
 * 密钥持久化存储 —— 记录各供应商的 API Key。
 * 敏感：含密钥，加入 .gitignore 不提交。
 * 与"兜底供应商"（isDefault，故障切换用，唯一）是两个不同概念。
 */
interface ProviderKeys {
  /** 各供应商的 API Key（环境变量未设置时的持久化存储） */
  apiKeys: Record<string, string>;
}

/* ════════════════════════════════════════════════════════════════════════════
   路径常量
   ════════════════════════════════════════════════════════════════════════════ */

const PROVIDERS_PATH = 'config/providers.json';
const KEYS_PATH = 'config/provider-keys.json';
/** 当前激活配置的唯一真相源（check.ts 启动读取 + 注册表 activate 写入） */
const ACTIVE_CONFIG_PATH = 'config/active-config.json';

/* ════════════════════════════════════════════════════════════════════════════
   ProviderRegistry 类
   ════════════════════════════════════════════════════════════════════════════ */

export class ProviderRegistry {
  private providers: Map<string, ProviderDefinition>;
  /** 密钥持久化（provider-keys.json，敏感） */
  private keys: ProviderKeys;

  constructor() {
    this.providers = new Map();
    // 配套加载：先读密钥持久化，再读定义，最后合并密钥
    this.keys = this.loadProviderKeys();
    this.loadProviderDefinitions();
    this.applyStoredKeysAndActivation();
  }

  /**
   * 异步初始化：为每个有 API Key 的供应商并行拉取远程模型列表。
   * 在 getProviderRegistry() 单例中调用，await 完成后调用方才拿到注册表，
   * 保证此时模型列表已是"能拉的都拉好了"的最新状态。
   *
   * 流程：
   *   1. getAll().map() 生成任务列表 —— 对每个供应商发起 fetchRemoteModels
   *   2. 无 apiKey 的供应商跳过（保留 providers.json 的 staticModels）
   *   3. Promise.all 等所有请求完成（并行，不等串行）
   *   4. 合并模型：远程列表（最新）+ 静态列表（精选兜底，标记 isStatic）
   *      远程拉取成功 → 合并进 staticModels 里缺失的模型
   *      失败/超时 → fetchRemoteModels 内部返回 []，仅保留 staticModels
   */
  async init(): Promise<void> {
    const tasks = this.getAll().map(async (p) => {
      if (!p.apiKey) return; // 无密钥无法拉取，用 staticModels
      const remote = await this.fetchRemoteModels(p);
      this.providers.set(p.id, { ...p, models: this.mergeModels(remote, p.staticModels) });
    });
    await Promise.all(tasks);
  }

  /** 获取所有供应商列表 */
  getAll(): ProviderDefinition[] {
    return [...this.providers.values()];
  }

  /** 按 ID 获取供应商 */
  get(id: string): ProviderDefinition | undefined {
    return this.providers.get(id);
  }

  /** 获取当前激活的供应商（读 config/active-config.json 唯一真相源） */
  getActive(): ProviderDefinition | undefined {
    const cfg = this.loadActiveConfig();
    return this.providers.get(cfg.providerId);
  }

  /** 获取当前激活的模型 ID（读 config/active-config.json 唯一真相源） */
  getActiveModel(): string {
    return this.loadActiveConfig().modelId;
  }

  /** 设置某供应商的 API Key（写入 keys 持久化存储，供环境变量缺失时恢复） */
  setApiKey(providerId: string, apiKey: string): void {
    const p = this.providers.get(providerId);
    if (p) {
      p.apiKey = apiKey;
      this.keys.apiKeys[providerId] = apiKey;
      this.saveProviderKeys();
    }
  }

  /** 激活供应商 + 模型（写入 config/active-config.json 唯一真相源） */
  activate(providerId: string, modelId: string): ProviderDefinition | undefined {
    const p = this.providers.get(providerId);
    if (!p) return undefined;
    this.saveActiveConfig(providerId, modelId);
    return p;
  }

  /** 获取兜底供应商 + 模型（标记为 isDefault 且配置了密钥的那个） */
  getFallback(): { provider: ProviderDefinition; modelId: string } | undefined {
    const def = this.getAll().find(p => p.isDefault && p.apiKey);
    if (!def || def.models.length === 0) return undefined;
    // 优先选 fallback 模型：deepseek-v4-flash 若存在，否则第一个
    const modelId = def.models.some(m => m.id === 'deepseek-v4-flash')
      ? 'deepseek-v4-flash'
      : def.models[0].id;
    return { provider: def, modelId };
  }

  /** 检查某供应商是否已配置 API Key */
  hasApiKey(providerId: string): boolean {
    return !!this.providers.get(providerId)?.apiKey;
  }

  /** 运行中重新拉取某供应商模型（/provider 输入 key 后调用） */
  async refreshModels(providerId: string): Promise<void> {
    const p = this.providers.get(providerId);
    if (!p || !p.apiKey) return;
    const remote = await this.fetchRemoteModels(p);
    this.providers.set(providerId, { ...p, models: this.mergeModels(remote, p.staticModels) });
  }

  /* ── 私有方法 ── */

  /**
   * 合并远程模型列表与静态模型列表。
   *
   * 规则：
   *   1. 远程模型优先（最新、来自 /models 接口）
   *   2. staticModels 中远程没有的模型追加到末尾，并标记 isStatic: true
   *      （这样即使远程列表不完整，人工精选的模型也不会丢失）
   *   3. 去重依据：模型 id
   */
  private mergeModels(
    remote: ProviderModel[],
    staticModels: ProviderModel[],
  ): ProviderModel[] {
    const seen = new Set<string>();
    const merged: ProviderModel[] = [];

    // ① 远程模型全部保留
    for (const m of remote) {
      seen.add(m.id);
      merged.push(m);
    }

    // ② 静态列表中远程缺失的模型追加（标记 isStatic）
    for (const m of staticModels) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push({ ...m, isStatic: true });
      }
    }

    return merged;
  }

  /**
   * 从 providers.json 载入供应商定义（与 loadProviderState 配套调用）。
   * 持久化的是供应商的元数据（公开）：id/name/baseUrl/type/apiKeyEnv/staticModels。
   */
  private loadProviderDefinitions(): void {
    try {
      const raw = readFileSync(PROVIDERS_PATH, 'utf-8');
      const data = JSON.parse(raw) as { providers: ProviderConfigJson[] };
      for (const cfg of data.providers ?? []) {
        this.providers.set(cfg.id, {
          id: cfg.id,
          name: cfg.name,
          baseUrl: cfg.baseUrl,
          type: cfg.type,
          apiKey: this.resolveApiKey(cfg),
          ...(cfg.apiKeyEnv ? { apiKeyEnv: cfg.apiKeyEnv } : {}),
          isDefault: !!cfg.isDefault,
          staticModels: (cfg.staticModels ?? []).map(m => ({ ...m, isStatic: true })),
          models: (cfg.staticModels ?? []).map(m => ({ ...m, isStatic: true })),
        });
      }
    } catch (err) {
      // providers.json 缺失或非法：注册表为空，启动时提示
      console.warn(`[provider-registry] 读取 ${PROVIDERS_PATH} 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 解析 API Key：
   *   ① 环境变量（providers.json 的 apiKeyEnv 字段）优先
   *   ② provider-keys.json 的 apiKeys（密钥持久化存储）次之
   *   ③ 都没有则空字符串（/provider 里可交互输入）
   */
  private resolveApiKey(cfg: ProviderConfigJson): string {
    if (cfg.apiKeyEnv) {
      const envVal = process.env[cfg.apiKeyEnv];
      if (envVal) return envVal;
    }
    return this.keys.apiKeys[cfg.id] ?? '';
  }

  /** 把 keys 持久化文件里的密钥应用到未配置环境变量的供应商 */
  private applyStoredKeysAndActivation(): void {
    for (const [id, p] of this.providers) {
      if (this.keys.apiKeys[id] && !p.apiKey) {
        this.providers.set(id, { ...p, apiKey: this.keys.apiKeys[id] });
      }
    }
    // 激活状态不需要额外处理，getActive 直接读 this.active
  }

  /** 从 {baseUrl}/models 拉取模型列表 */
  private async fetchRemoteModels(p: ProviderDefinition): Promise<ProviderModel[]> {
    try {
      const url = `${p.baseUrl.replace(/\/+$/, '')}/models`;
      const headers: Record<string, string> = {};
      if (p.type === 'anthropic') {
        headers['x-api-key'] = p.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['Authorization'] = `Bearer ${p.apiKey}`;
      }

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];

      const data = (await res.json()) as {
        data?: Array<{ id: string; name?: string }>;
        models?: Array<{ id: string; name?: string }>;
      };
      const list = data.data ?? data.models ?? [];
      return list.map((m) => ({
        id: m.id,
        label: m.name || m.id,
      }));
    } catch {
      return []; // 拉取失败返回空数组，由 mergeModels 决定（此时只剩 staticModels）
    }
  }

  /**
   * 从 provider-keys.json 载入密钥持久化（敏感）。
   * 与 loadProviderDefinitions 在 constructor 中配套调用。
   */
  private loadProviderKeys(): ProviderKeys {
    try {
      return JSON.parse(readFileSync(KEYS_PATH, 'utf-8'));
    } catch {
      return { apiKeys: {} };
    }
  }

  /** 保存密钥持久化到 provider-keys.json */
  private saveProviderKeys(): void {
    try {
      writeFileSync(KEYS_PATH, JSON.stringify(this.keys, null, 2), 'utf-8');
    } catch { /* 写入失败不阻塞运行 */ }
  }

  /**
   * 从 config/active-config.json 读当前激活配置（唯一真相源）。
   * 返回 { providerId, modelId }，文件缺失时返回空。
   */
  private loadActiveConfig(): { providerId: string; modelId: string } {
    try {
      const raw = JSON.parse(readFileSync(ACTIVE_CONFIG_PATH, 'utf-8')) as {
        provider?: string;
        model?: string;
      };
      return { providerId: raw.provider ?? '', modelId: raw.model ?? '' };
    } catch {
      return { providerId: '', modelId: '' };
    }
  }

  /**
   * 写 config/active-config.json 为当前激活配置（唯一真相源）。
   * 保留已有 apiKey 和 baseUrl，只更新 provider + model。
   */
  private saveActiveConfig(providerId: string, modelId: string): void {
    try {
      let existing: { baseUrl?: string; apiKey?: string } = {};
      try {
        existing = JSON.parse(readFileSync(ACTIVE_CONFIG_PATH, 'utf-8'));
      } catch { /* 文件不存在则用空对象 */ }
      const p = this.providers.get(providerId);
      writeFileSync(ACTIVE_CONFIG_PATH, JSON.stringify({
        provider: providerId,
        baseUrl: p?.baseUrl ?? existing.baseUrl ?? '',
        apiKey: p?.apiKey ?? existing.apiKey ?? '',
        model: modelId,
      }, null, 2), 'utf-8');
    } catch { /* 写入失败不阻塞运行 */ }
  }
}

/* ── 全局单例（promise 化，支持 async init） ── */

let _instancePromise: Promise<ProviderRegistry> | null = null;

/** 获取全局唯一的 ProviderRegistry 实例（首次调用时载入配置 + 拉取模型） */
export function getProviderRegistry(): Promise<ProviderRegistry> {
  if (!_instancePromise) {
    _instancePromise = (async () => {
      const registry = new ProviderRegistry();
      await registry.init();
      return registry;
    })();
  }
  return _instancePromise;
}
