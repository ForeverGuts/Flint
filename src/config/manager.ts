/**
 * 配置管理 —— 统一管理配置分层（项目/全局/环境变量）+ 供应商（模型/密钥/激活）。
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
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LLMConfig } from '../llm/types.js';

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
  /** 解析后的 API Key（环境变量 > 全局 > 项目） */
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

/* ════════════════════════════════════════════════════════════════════════════
   ConfigManager 类
   ════════════════════════════════════════════════════════════════════════════ */

export class ConfigManager {
  private providers: Map<string, ProviderDefinition> = new Map();
  /** 项目级密钥（config/provider-keys.json） */
  private projectKeys: ProviderKeys = { apiKeys: {} };
  /** 全局配置（~/.ts-agent/config.json） */
  private globalConfig: GlobalConfig = {};
  /** 路径覆盖（测试注入，默认用真实路径） */
  private paths: Required<PathOverrides>;

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

  /* ── 异步初始化：为有 key 的供应商并行拉取远程模型 ── */

  async init(): Promise<void> {
    const tasks = this.getAll().map(async (p) => {
      if (!p.apiKey) return; // 无密钥用 staticModels
      const remote = await this.fetchRemoteModels(p);
      this.providers.set(p.id, { ...p, models: this.mergeModels(remote, p.staticModels) });
    });
    await Promise.all(tasks);
  }

  /* ── 查询 ── */

  getAll(): ProviderDefinition[] {
    return [...this.providers.values()];
  }

  get(id: string): ProviderDefinition | undefined {
    return this.providers.get(id);
  }

  /** 获取当前激活的供应商（读 active-config.json） */
  getActive(): ProviderDefinition | undefined {
    const cfg = this.loadActive();
    return this.providers.get(cfg.provider ?? '');
  }

  /** 获取当前激活的模型 ID */
  getActiveModel(): string {
    return this.loadActive().model ?? '';
  }

  /** 获取兜底供应商 + 模型（isDefault 且有 key） */
  getFallback(): { provider: ProviderDefinition; modelId: string } | undefined {
    const def = this.getAll().find((p) => p.isDefault && p.apiKey);
    if (!def || def.models.length === 0) return undefined;
    const modelId = def.models.some((m) => m.id === 'deepseek-v4-flash')
      ? 'deepseek-v4-flash'
      : def.models[0].id;
    return { provider: def, modelId };
  }

  /* ── 修改 ── */

  /** 设置某供应商的项目级 API Key（写 provider-keys.json） */
  setKey(providerId: string, apiKey: string): void {
    const p = this.providers.get(providerId);
    if (p) {
      p.apiKey = apiKey;
      this.projectKeys.apiKeys[providerId] = apiKey;
      this.saveProjectKeys();
    }
  }

  /** 激活供应商 + 模型（写 active-config.json，不含 key） */
  activate(providerId: string, modelId: string): ProviderDefinition | undefined {
    const p = this.providers.get(providerId);
    if (!p) return undefined;
    this.saveActive(providerId, modelId, p.baseUrl);
    return p;
  }

  /** 运行中重新拉取某供应商模型（输入 key 后调用） */
  async refreshModels(providerId: string): Promise<void> {
    const p = this.providers.get(providerId);
    if (!p || !p.apiKey) return;
    const remote = await this.fetchRemoteModels(p);
    this.providers.set(providerId, { ...p, models: this.mergeModels(remote, p.staticModels) });
  }

  /** 返回合并后的最终 LLMConfig（供 check.ts / main.ts 创建 Provider） */
  getMergedConfig(): LLMConfig | undefined {
    const active = this.loadActive();
    const p = this.providers.get(active.provider ?? '');
    if (!p) return undefined;
    return {
      provider: p.type,
      baseUrl: this.globalConfig.baseUrls?.[p.id] ?? p.baseUrl,
      apiKey: p.apiKey,
      model: active.model ?? '',
    };
  }

  /* ── 私有：加载 ── */

  /** 从 providers.json 载入供应商定义，key 由 resolveApiKey 解析 */
  private loadProviders(): void {
    try {
      const raw = JSON.parse(readFileSync(this.paths.providersPath, 'utf-8')) as { providers: ProviderConfigJson[] };
      for (const cfg of raw.providers ?? []) {
        this.providers.set(cfg.id, {
          id: cfg.id,
          name: cfg.name,
          baseUrl: cfg.baseUrl,
          type: cfg.type,
          apiKey: this.resolveApiKey(cfg),
          ...(cfg.apiKeyEnv ? { apiKeyEnv: cfg.apiKeyEnv } : {}),
          isDefault: !!cfg.isDefault,
          staticModels: (cfg.staticModels ?? []).map((m) => ({ ...m, isStatic: true })),
          models: (cfg.staticModels ?? []).map((m) => ({ ...m, isStatic: true })),
        });
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
      return list.map((m) => ({ id: m.id, label: m.name || m.id }));
    } catch {
      return [];
    }
  }

  /** 合并远程模型 + 静态模型（远程优先，静态缺失的追加并标 isStatic） */
  private mergeModels(remote: ProviderModel[], staticModels: ProviderModel[]): ProviderModel[] {
    const seen = new Set<string>();
    const merged: ProviderModel[] = [];
    for (const m of remote) {
      seen.add(m.id);
      merged.push(m);
    }
    for (const m of staticModels) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push({ ...m, isStatic: true });
      }
    }
    return merged;
  }
}

/* ── 全局单例（promise 化，支持 async init） ── */

let _instancePromise: Promise<ConfigManager> | null = null;

/** 获取全局唯一的 ConfigManager 实例（首次调用时载入配置 + 拉取模型） */
export function getConfigManager(): Promise<ConfigManager> {
  if (!_instancePromise) {
    _instancePromise = (async () => {
      const mgr = new ConfigManager();
      await mgr.init();
      return mgr;
    })();
  }
  return _instancePromise;
}
