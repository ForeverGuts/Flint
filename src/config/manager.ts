/**
 * 配置管理 —— 统一管理配置分层（项目/全局/环境变量）+ 供应商（Provider 对象集合）。
 * 调用方：/model 命令、check.ts、runtime.ts（兜底）、main.ts
 * 服务于：收敛原 provider-registry 的能力 + 增加全局配置层，让配置/供应商管理有单一入口
 *
 * 配置优先级链（高 → 低）：
 *   环境变量（apiKeyEnv 指定） > 全局 ~/.ts-agent/config.json > 项目 config/provider-keys.json
 *     > 项目 config/active-config.json > 代码默认
 *
 * 文件职责：
 *   - config/providers.json            供应商定义（公开，可提交）
 *   - config/provider-keys.json        项目级密钥（敏感，.gitignore）
 *   - config/active-config.json        当前激活 provider/model/baseUrl（不含 key）
 *   - ~/.ts-agent/config.json          全局密钥 + 常用 baseUrl（用户目录）
 *
 * TODO: 不同存在域的配置设置 —— 目前仅"密钥"分了环境变量/全局/项目三层，
 *       供应商定义（providers.json）与 baseUrl 等仍只存在于本项目单一域。
 *       后续规划：让供应商定义、baseUrl、默认模型等也支持按存在域分层
 *       （全局 ~/.ts-agent 追加供应商、项目追加、环境变量覆盖），统一配置模型。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LLMConfig } from '../llm/types.js';
import {
  ProviderRegistry,
  createProviderFromConfig,
} from '../llm/provider.js';
import type { Provider, ProviderConfigJson } from '../llm/provider.js';

/** 全局配置结构（~/.ts-agent/config.json） */
interface GlobalConfig {
  /** 各供应商的 API Key */
  apiKeys?: Record<string, string>;
  /** 常用 baseUrl 覆盖 */
  baseUrls?: Record<string, string>;
}

/** 项目级密钥存储（config/provider-keys.json） */
interface ProviderKeys {
  /** 各供应商的 API Key */
  apiKeys: Record<string, string>;
}

/** 激活状态（config/active-config.json，不含 key） */
interface ActiveConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** 思维链开关（阶段 C1）：'auto' | 'on' | 'off'，缺省等同 'auto' */
  thinking?: 'auto' | 'on' | 'off';
}

/* ════════════════════════════════════════════════════════════════════════════
   路径常量
   ════════════════════════════════════════════════════════════════════════════ */

/** 供应商定义（公开，可提交） */
const PROVIDERS_PATH = 'config/providers.json';
/** 项目级密钥（敏感，.gitignore） */
const KEYS_PATH = 'config/provider-keys.json';
/** 当前激活状态（唯一真相源，不含 key）。测试可用环境变量 TS_AGENT_CONFIG 指向临时文件 */
const ACTIVE_PATH = process.env.TS_AGENT_CONFIG || 'config/active-config.json';
/** 全局配置目录（用户主目录，跨项目共享） */
const GLOBAL_DIR = path.join(os.homedir(), '.ts-agent');
/** 全局配置文件 */
const GLOBAL_PATH = path.join(GLOBAL_DIR, 'config.json');

/** 测试注入：可覆盖路径，避免测试触碰真实配置（默认 undefined 用真实路径） */
interface PathOverrides {
  providersPath?: string;
  keysPath?: string;
  activePath?: string;
  globalPath?: string;
}

/**
 * 模型列表的内存新鲜期（启动提速第二档）。
 * 这段时间内已成功拉过就不再自动重拉：模型列表的变化频率是"月"级的（新模型发布），
 * 而现拉一次要 0.3~0.9s（实测 opencode-go 913ms），每次开 /model 都付这一下不值得。
 * 不落盘、不跳进程：只在内存里比一个时间戳，因此没有缓存文件、TTL 失效、baseUrl 变更这一整套机械。
 */
const MODELS_FRESH_MS = 5 * 60 * 1000;

/* ════════════════════════════════════════════════════════════════════════════
   ConfigManager 类
   ════════════════════════════════════════════════════════════════════════════ */

export class ConfigManager {
  /** Provider 对象集合（数据 + 行为自包含，运行时注册表） */
  private registry = new ProviderRegistry();
  /** 项目级密钥（config/provider-keys.json） */
  private projectKeys: ProviderKeys = { apiKeys: {} };
  /** 全局配置（~/.ts-agent/config.json） */
  private globalConfig: GlobalConfig = {};
  /** 路径覆盖（测试注入，默认用真实路径） */
  private paths: Required<PathOverrides>;
  /** 在飞的模型拉取（按供应商 id）：后台预热与用户开 /model 可能同时打同一家，靠它去重 */
  private inflight = new Map<string, Promise<void>>();

  constructor(overrides?: PathOverrides) {
    this.paths = {
      providersPath: overrides?.providersPath ?? PROVIDERS_PATH,
      keysPath: overrides?.keysPath ?? KEYS_PATH,
      activePath: overrides?.activePath ?? ACTIVE_PATH,
      globalPath: overrides?.globalPath ?? GLOBAL_PATH,
    };
    this.projectKeys = this.loadProjectKeys();
    this.globalConfig = this.loadGlobalConfig();
    this.loadProviders();
  }

  /* ── 模型列表：后台预热 + 按需现拉（启动提速第二档）──
     改造前：getConfigManager() 会 await init() 并行拉每个有 key 的供应商的 /models，
     而 check() 又 await 它 → 这一批网络往返全部压在界面渲染之前（实测冷启动 1998ms、
     连接池热时 278ms，网络差时每家最长卡 10s 超时，全程终端只有 banner 没有 UI）。
     而这些列表的唯一真消费者是 /model 的二级选择器（其余 8 处调用点要么只是说明文字，
     要么静态列表就能满足）——等于每次启动都在为用户可能永远不会打开的菜单提前付钱。 */

  /**
   * 后台预热：并行拉所有有 key 的供应商的模型列表，结果只更新内存里的 Provider。
   * 调用方：main.ts（界面渲染前发起但不 await，因此不挡界面）；RPC 模式不调（外部程序用不到选择器）。
   * 失败即静态兜底（fetchRemoteModels 内部已 swallow 并返回空），不向调用方抛——
   * 预热是锦上添花，不该因为它失败而在界面上报错。
   * 注：活动供应商会被拉两次（本方法一次 + probeStartup 一次）。不合并是有意的：
   * probe 要靠 HTTP 状态码分档（401 → key 无效），而 fetchRemoteModels 把状态码吞了；
   * 为省一次**后台**请求（用户感知为零）把两者耦起来不划算。
   */
  async warmModels(): Promise<void> {
    const tasks = this.getAll()
      .filter((p) => p.getApiKey())   // 无密钥拉不动，用 staticModels
      .map((p) => this.startRefresh(p));
    await Promise.all(tasks);
  }

  /**
   * 确保某供应商的模型列表可用：新鲜期内成功拉过就直接用（零等待），否则现拉一次。
   * 调用方：/model 二级选择器之前
   * 服务于：绝大多数情况下后台预热早已拉完，用户开 /model 不必再等那 0.3~0.9s
   */
  async ensureModels(providerId: string): Promise<void> {
    const p = this.registry.get(providerId);
    if (!p || !p.getApiKey()) return;
    if (this.isModelsFresh(providerId)) return;
    await this.startRefresh(p);
  }

  /** 模型列表是否仍在新鲜期内（调用方据此决定要不要先提示"正在拉取"，免得看着像卡死） */
  isModelsFresh(providerId: string): boolean {
    const at = this.registry.get(providerId)?.modelsFetchedAt;
    return at !== null && at !== undefined && Date.now() - at < MODELS_FRESH_MS;
  }

  /**
   * 发起一次模型拉取，并与在飞的同一家去重。
   * 不去重的后果：预热与 /model 同时打同一家，两次一模一样的往返，
   * 而 /model 那次还得等自己那份（明明另一份马上就要回来了）。
   */
  private startRefresh(p: Provider): Promise<void> {
    const flying = this.inflight.get(p.id);
    if (flying) return flying;
    const task = p.refreshModels().finally(() => { this.inflight.delete(p.id); });
    this.inflight.set(p.id, task);
    return task;
  }

  /* ── 查询 ── */

  getAll(): Provider[] {
    return this.registry.getAll();
  }

  get(id: string): Provider | undefined {
    return this.registry.get(id);
  }

  /** 获取当前激活的供应商（读 active-config.json） */
  getActive(): Provider | undefined {
    const cfg = this.loadActive();
    return this.registry.get(cfg.provider ?? '');
  }

  /** 获取当前激活的模型 ID */
  getActiveModel(): string {
    return this.loadActive().model ?? '';
  }

  /** 获取兜底供应商 + 模型（isDefault 且有 key） */
  getFallback(): { provider: Provider; modelId: string } | undefined {
    const def = this.getAll().find((p) => p.isDefault && p.getApiKey());
    if (!def || def.getModels().length === 0) return undefined;
    const modelId = def.getModels().some((m) => m.id === 'deepseek-v4-flash')
      ? 'deepseek-v4-flash'
      : def.getModels()[0].id;
    return { provider: def, modelId };
  }

  /* ── 修改 ── */

  /** 运行时注册 Provider（自定义供应商） */
  registerProvider(p: Provider): void {
    this.registry.register(p);
  }

  /** 运行时删除 Provider */
  unregisterProvider(id: string): void {
    this.registry.unregister(id);
  }

  /** 设置某供应商的项目级 API Key（写 provider-keys.json） */
  setKey(providerId: string, apiKey: string): void {
    this.projectKeys.apiKeys[providerId] = apiKey;
    this.saveProjectKeys();
  }

  /** 激活供应商 + 模型（写 active-config.json，不含 key） */
  activate(providerId: string, modelId: string): Provider | undefined {
    const p = this.registry.get(providerId);
    if (!p) return undefined;
    this.saveActive(providerId, modelId, p.baseUrl);
    return p;
  }

  /** 运行中重新拉取某供应商模型（输入新 key 后调用：新 key 可能解锁不同模型，必须现拉，不看新鲜期） */
  async refreshModels(providerId: string): Promise<void> {
    const p = this.registry.get(providerId);
    if (!p || !p.getApiKey()) return;
    await this.startRefresh(p);
  }

  /**
   * 从配置构造 Provider 对象（用 manager 的标准 key 解析 + 模型拉取）。
   * 调用方：/model 自定义供应商入口
   * 服务于：让自定义 Provider 也能用统一的 getApiKey/getModels/refreshModels 行为
   */
  createProviderObject(cfg: ProviderConfigJson): Provider {
    return createProviderFromConfig(cfg, {
      resolveApiKey: (c) => this.resolveApiKey(c),
      fetchModels: (p) => this.fetchRemoteModels(p),
    });
  }

  /** 持久化自定义供应商到 providers.json（追加到数组） */
  saveCustomProvider(cfg: ProviderConfigJson): void {
    try {
      const raw = this.readProvidersFile();
      raw.providers = raw.providers ?? [];
      // 同 id 覆盖，否则追加
      const idx = raw.providers.findIndex((p) => p.id === cfg.id);
      if (idx !== -1) raw.providers[idx] = cfg;
      else raw.providers.push(cfg);
      writeFileSync(this.paths.providersPath, JSON.stringify(raw, null, 2), 'utf-8');
    } catch { /* 写入失败不阻塞 */ }
  }

  /** 返回合并后的最终 LLMConfig（供 check.ts / main.ts 创建 Provider） */
  getMergedConfig(): LLMConfig | undefined {
    const active = this.loadActive();
    const p = this.registry.get(active.provider ?? '');
    if (!p) return undefined;
    return {
      provider: p.type,
      baseUrl: this.globalConfig.baseUrls?.[p.id] ?? p.baseUrl,
      apiKey: p.getApiKey(),
      model: active.model ?? '',
      // thinking 开关透传（阶段 C1）：不写时缺省，Provider 侧按 'auto'→关闭处理
      ...(active.thinking ? { thinking: active.thinking } : {}),
    };
  }

  /* ── 私有：加载 ── */

  /** 读 providers.json 原始内容 */
  private readProvidersFile(): { providers: ProviderConfigJson[] } {
    return JSON.parse(readFileSync(this.paths.providersPath, 'utf-8'));
  }

  /** 从 providers.json 载入供应商定义，构造 Provider 对象（注入行为依赖） */
  private loadProviders(): void {
    try {
      const raw = this.readProvidersFile();
      for (const cfg of raw.providers ?? []) {
        const provider = createProviderFromConfig(cfg, {
          resolveApiKey: (c) => this.resolveApiKey(c),
          fetchModels: (p) => this.fetchRemoteModels(p),
        });
        this.registry.register(provider);
      }
    } catch (e) {
      console.warn(`[config] 读取 ${this.paths.providersPath} 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 解析 API Key（优先级：环境变量 > 全局 > 项目）：
   *   ① 环境变量（apiKeyEnv 字段指定）—— 最高优先
   *   ② ~/.ts-agent/config.json 的 apiKeys —— 全局共享
   *   ③ config/provider-keys.json 的 apiKeys —— 项目级兜底
   *   ④ 都没有 → 空字符串（/model 里可交互输入）
   */
  private resolveApiKey(cfg: ProviderConfigJson): string {
    if (cfg.apiKeyEnv) {
      const envVal = process.env[cfg.apiKeyEnv];
      if (envVal) return envVal;
    }
    if (this.globalConfig.apiKeys?.[cfg.id]) return this.globalConfig.apiKeys[cfg.id]!;
    return this.projectKeys.apiKeys[cfg.id] ?? '';
  }

  /** 读项目级密钥（config/provider-keys.json） */
  private loadProjectKeys(): ProviderKeys {
    try {
      return JSON.parse(readFileSync(this.paths.keysPath, 'utf-8'));
    } catch {
      return { apiKeys: {} };
    }
  }

  /** 保存项目级密钥 */
  private saveProjectKeys(): void {
    try {
      writeFileSync(this.paths.keysPath, JSON.stringify(this.projectKeys, null, 2), 'utf-8');
    } catch { /* 写入失败不阻塞 */ }
  }

  /** 读全局配置（~/.ts-agent/config.json，不存在则空） */
  private loadGlobalConfig(): GlobalConfig {
    try {
      return JSON.parse(readFileSync(this.paths.globalPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  /** 读激活状态（config/active-config.json） */
  private loadActive(): ActiveConfig {
    try {
      return JSON.parse(readFileSync(this.paths.activePath, 'utf-8')) as ActiveConfig;
    } catch {
      return {};
    }
  }

  /** 写激活状态（只写 provider/model/baseUrl，不含 key） */
  private saveActive(providerId: string, modelId: string, baseUrl: string): void {
    try {
      writeFileSync(this.paths.activePath, JSON.stringify({
        provider: providerId,
        model: modelId,
        baseUrl,
      }, null, 2), 'utf-8');
    } catch { /* 写入失败不阻塞 */ }
  }

  /* ── 私有：模型拉取 ── */

  /** 从 {baseUrl}/models 拉取模型列表（Provider 的 refreshModels 注入用） */
  private async fetchRemoteModels(p: Provider): Promise<import('../llm/provider.js').ProviderModel[]> {
    try {
      const url = `${p.baseUrl.replace(/\/+$/, '')}/models`;
      const headers: Record<string, string> = {};
      if (p.type === 'anthropic') {
        headers['x-api-key'] = p.getApiKey();
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['Authorization'] = `Bearer ${p.getApiKey()}`;
      }
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        data?: Array<{ id: string; name?: string }>;
        models?: Array<{ id: string; name?: string }>;
      };
      const list = data.data ?? data.models ?? [];
      return list.map((m) => ({ id: m.id, label: m.name || m.id }));
    } catch {
      return [];
    }
  }
}

/* ── 全局单例（promise 化，支持 async init） ── */

let _instancePromise: Promise<ConfigManager> | null = null;

/** 获取全局唯一的 ConfigManager 实例（首次调用时载入本地配置；全程不发网络请求） */
export function getConfigManager(): Promise<ConfigManager> {
  // 模型列表不在这里拉（启动提速第二档）：启动关键路径纯本地（实测 1ms），
  // 预热由 main.ts 调 warmModels() 在后台做，/model 打开时再按新鲜期按需现拉。
  // 保留 Promise 签名：调用方已全面 await，且日后若要加异步初始化不必改调用点
  if (!_instancePromise) _instancePromise = Promise.resolve(new ConfigManager());
  return _instancePromise;
}
