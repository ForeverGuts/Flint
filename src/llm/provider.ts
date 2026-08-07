/**
 * 协议层抽象 —— Provider 对象（数据 + 行为自包含）。
 * 调用方：config/manager.ts（构造/查询）、commands/model.ts（选择）、runtime.ts（兜底）
 * 服务于：把"供应商"从纯数据升级为对象 —— 每个 Provider 携带协议实现行为
 *        （getModels/refreshModels/createLLM）+ 从配置构造的数据，运行时可注册自定义。
 *
 * 协议实现两种：
 *   - type='openai'   → DeepSeekProvider（OpenAI 兼容协议，覆盖 deepseek/openai/opencode-go）
 *   - type='anthropic'→ AnthropicProvider（Anthropic Messages 协议）
 */
import type { LLMProvider } from './types.js';
import { DeepSeekProvider } from './deepseek.js';
import { AnthropicProvider } from './anthropic.js';

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

/** providers.json 中的原始定义（可编辑，外部配置数据） */
export interface ProviderConfigJson {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** API 基础地址 */
  baseUrl: string;
  /** 协议类型：'openai' | 'anthropic'（决定用哪个 LLMProvider 实现） */
  type: string;
  /** 环境变量名（优先从此读取 API Key，如 "OPENCODE_GO_KEY"） */
  apiKeyEnv?: string;
  /** 兜底供应商标记（LLM 报错时切到它） */
  isDefault?: boolean;
  /** 静态模型列表（远程拉取失败时使用） */
  staticModels?: ProviderModel[];
}

/** Provider 对象依赖（由外部注入，避免对象直接读文件） */
export interface ProviderDeps {
  /** 解析 API Key（环境变量 > 全局 > 项目，由 ConfigManager 提供） */
  resolveApiKey: (cfg: ProviderConfigJson) => string;
  /** 拉取远程模型列表（由 ConfigManager 提供 fetch 实现） */
  fetchModels: (p: Provider) => Promise<ProviderModel[]>;
}

/**
 * Provider 对象 —— 一个供应商实例（数据 + 行为自包含）。
 * 行为：getApiKey / getModels / refreshModels / createLLM
 * 数据：id/name/baseUrl/type/apiKeyEnv/isDefault/staticModels
 */
export interface Provider {
  /** 唯一标识（供应商 id，如 "opencode-go" / "my-custom"） */
  id: string;
  /** 显示名称 */
  name: string;
  /** API 基础地址 */
  baseUrl: string;
  /** 协议类型：'openai' | 'anthropic' */
  type: 'openai' | 'anthropic';
  /** 环境变量名（key 优先来源，可选） */
  apiKeyEnv?: string;
  /** 是否兜底供应商 */
  isDefault: boolean;
  /** 静态模型列表 */
  staticModels: ProviderModel[];

  // ── 行为 ──
  /** 解析 API Key（环境变量 > 全局 > 项目，依赖注入的 resolver） */
  getApiKey(): string;
  /** 当前已知模型列表（同步；动态供应商为最近一次 refresh 结果） */
  getModels(): ProviderModel[];
  /** 拉取远程模型（动态供应商），失败保留静态 */
  refreshModels(): Promise<void>;
  /** 创建实际 LLM 客户端（按 type 走协议实现） */
  createLLM(model: string): LLMProvider;
}

/** 创建实际 LLM 客户端（按协议类型路由） */
function buildLLM(p: Provider, model: string): LLMProvider {
  const config = {
    provider: p.type,
    baseUrl: p.baseUrl,
    apiKey: p.getApiKey(),
    model,
  };
  return p.type === 'anthropic'
    ? new AnthropicProvider(config)
    : new DeepSeekProvider(config);
}

/** 合并远程模型 + 静态模型（远程优先，静态缺失的追加并标 isStatic） */
function mergeModels(remote: ProviderModel[], staticModels: ProviderModel[]): ProviderModel[] {
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

/**
 * 工厂：从 providers.json 配置构造 Provider 对象。
 * 行为（getApiKey/fetchModels）通过 deps 注入，保持"数据在外部配置、对象只持行为引用"。
 */
export function createProviderFromConfig(cfg: ProviderConfigJson, deps: ProviderDeps): Provider {
  const staticModels = (cfg.staticModels ?? []).map((m) => ({ ...m, isStatic: true }));
  let models: ProviderModel[] = [...staticModels];

  const provider: Provider = {
    id: cfg.id,
    name: cfg.name,
    baseUrl: cfg.baseUrl,
    type: (cfg.type === 'anthropic' ? 'anthropic' : 'openai') as 'openai' | 'anthropic',
    ...(cfg.apiKeyEnv ? { apiKeyEnv: cfg.apiKeyEnv } : {}),
    isDefault: !!cfg.isDefault,
    staticModels,

    getApiKey() {
      return deps.resolveApiKey(cfg);
    },

    getModels() {
      return models;
    },

    async refreshModels() {
      const remote = await deps.fetchModels(provider);
      models = mergeModels(remote, staticModels);
    },

    createLLM(model: string) {
      return buildLLM(provider, model);
    },
  };

  return provider;
}

/**
 * 运行时 Provider 集合（Pi 的 Models.setProvider/deleteProvider）。
 * 调用方：ConfigManager 持有，/model 自定义供应商时 register
 */
export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  /** 注册（或替换同 id）一个 Provider —— 运行时新增供应商 */
  register(p: Provider): void {
    this.providers.set(p.id, p);
  }

  /** 删除一个 Provider */
  unregister(id: string): void {
    this.providers.delete(id);
  }

  /** 按 id 获取 Provider */
  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  /** 获取全部 Provider */
  getAll(): Provider[] {
    return [...this.providers.values()];
  }
}
