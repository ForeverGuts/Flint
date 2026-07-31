/**
 * 供应商注册表 —— 管理所有可用的 AI 供应商及其模型。
 * 调用方：/provider 命令、/model 命令、main.ts（启动初始化）
 * 服务于：统一管理各供应商的 API 地址、密钥、可用模型列表
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
}

/** 供应商定义 */
export interface ProviderDefinition {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** API 基础地址 */
  baseUrl: string;
  /** API Key（可能为空，需要用户补充） */
  apiKey: string;
  /** 厂商类型（对应 LLMConfig.provider） */
  type: string;
  /** 可用模型列表 */
  models: ProviderModel[];
  /** 上次使用的模型（启动时自动选择） */
  lastModel: string;
}

/** 持久化存储格式（只保存关键信息，模型列表从定义中获取） */
interface ProviderStore {
  /** 各供应商的 API Key */
  apiKeys: Record<string, string>;
  /** 当前激活的供应商 ID */
  activeProvider: string;
  /** 当前激活的模型 ID */
  activeModel: string;
}

/* ════════════════════════════════════════════════════════════════════════════
   供应商预设
   ════════════════════════════════════════════════════════════════════════════ */

/** 内置供应商预设（模型列表完整，API Key 从配置文件 / 环境变量读取） */
const BUILTIN_PROVIDERS: Omit<ProviderDefinition, 'apiKey' | 'lastModel'>[] = [
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    type: 'opencode-go',
    models: [
      { id: 'deepseek-v4-flash',  label: 'DeepSeek V4 Flash',  description: '¥0.14/1M 输入，快速省钱的编码模型' },
      { id: 'deepseek-v4-pro',    label: 'DeepSeek V4 Pro',    description: '¥0.435/1M 输入，能力强但贵' },
      { id: 'qwen3.7-max',        label: 'Qwen3.7 Max',        description: '阿里通义旗舰' },
      { id: 'qwen3.7-plus',       label: 'Qwen3.7 Plus',       description: '¥0.40/1M 输入，256K 上下文' },
      { id: 'qwen3.6-plus',       label: 'Qwen3.6 Plus',       description: '¥0.50/1M 输入' },
      { id: 'kimi-k2.7-code',     label: 'Kimi K2.7 Code',     description: '月之暗面编程专用模型' },
      { id: 'kimi-k3',            label: 'Kimi K3',             description: '月之暗面旗舰' },
      { id: 'glm-5.2',            label: 'GLM-5.2',            description: '智谱旗舰' },
      { id: 'grok-4.5',           label: 'Grok 4.5',           description: 'xAI 最强模型，¥2/1M 输入' },
      { id: 'mimo-v2.5',          label: 'MiMo V2.5',          description: '¥0.14/1M 输入，超高性价比' },
      { id: 'mimo-v2.5-pro',      label: 'MiMo V2.5 Pro',      description: '¥0.435/1M 输入' },
      { id: 'minimax-m3',         label: 'MiniMax M3',         description: '¥0.30/1M 输入' },
      { id: 'hy3',                label: 'Hy3',                description: '¥0.14/1M 输入' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    type: 'deepseek',
    models: [
      { id: 'deepseek-v4-flash',  label: 'DeepSeek V4 Flash',  description: '¥0.50/1M 输入，快速版' },
      { id: 'deepseek-v4-pro',    label: 'DeepSeek V4 Pro',    description: '¥0.80/1M 输入，更强劲' },
      { id: 'deepseek-chat',      label: 'DeepSeek Chat',      description: '通用聊天模型' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    type: 'openai',
    models: [
      { id: 'gpt-4o',               label: 'GPT-4o',           description: 'OpenAI 旗舰多模态模型' },
      { id: 'gpt-4o-mini',          label: 'GPT-4o Mini',      description: 'GPT-4o 轻量版' },
      { id: 'gpt-4.1',              label: 'GPT-4.1',          description: 'GPT-4 最新版' },
      { id: 'o3-mini',              label: 'o3-mini',          description: 'OpenAI 推理模型' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic 官方',
    baseUrl: 'https://api.anthropic.com',
    type: 'anthropic',
    models: [
      { id: 'claude-sonnet-4-20250514',   label: 'Claude Sonnet 4',       description: 'Anthropic 旗舰' },
      { id: 'claude-haiku-3-5-20241022',  label: 'Claude Haiku 3.5',      description: '快速轻量版' },
      { id: 'claude-opus-4-20250514',     label: 'Claude Opus 4',         description: '最强推理模型' },
    ],
  },
];

/* ════════════════════════════════════════════════════════════════════════════
   持久化存储路径
   ════════════════════════════════════════════════════════════════════════════ */

const STORE_PATH = 'config/provider-store.json';

/* ════════════════════════════════════════════════════════════════════════════
   ProviderRegistry 类
   ════════════════════════════════════════════════════════════════════════════ */

export class ProviderRegistry {
  private providers: Map<string, ProviderDefinition>;
  private store: ProviderStore;

  constructor() {
    this.providers = new Map();
    // 载入内置供应商预设
    for (const p of BUILTIN_PROVIDERS) {
      this.providers.set(p.id, {
        ...p,
        apiKey: '',
        lastModel: p.models[0]?.id ?? '',
      });
    }
    // 加载持久化状态
    this.store = this.loadStore();
    // 注入已保存的 API Key 和 lastModel
    for (const [id, p] of this.providers) {
      if (this.store.apiKeys[id]) p.apiKey = this.store.apiKeys[id];
      this.providers.set(id, { ...p, lastModel: p.models.some(m => m.id === this.store.activeModel) ? this.store.activeModel : p.models[0]?.id ?? '' });
    }
  }

  /** 获取所有供应商列表 */
  getAll(): ProviderDefinition[] {
    return [...this.providers.values()];
  }

  /** 按 ID 获取供应商 */
  get(id: string): ProviderDefinition | undefined {
    return this.providers.get(id);
  }

  /** 获取当前激活的供应商 */
  getActive(): ProviderDefinition | undefined {
    return this.providers.get(this.store.activeProvider);
  }

  /** 获取当前激活的模型 ID */
  getActiveModel(): string {
    return this.store.activeModel;
  }

  /** 设置某供应商的 API Key */
  setApiKey(providerId: string, apiKey: string): void {
    const p = this.providers.get(providerId);
    if (p) {
      p.apiKey = apiKey;
      this.store.apiKeys[providerId] = apiKey;
      this.saveStore();
    }
  }

  /** 激活供应商 + 模型 */
  activate(providerId: string, modelId: string): ProviderDefinition | undefined {
    const p = this.providers.get(providerId);
    if (!p) return undefined;
    this.store.activeProvider = providerId;
    this.store.activeModel = modelId;
    this.saveStore();
    return p;
  }

  /** 获取兜底配置（OpenCode Go + DeepSeek V4 Flash） */
  getFallback(): { provider: ProviderDefinition; modelId: string } | undefined {
    const p = this.providers.get('opencode-go');
    if (!p || !p.apiKey) return undefined;
    const fallbackModel = 'deepseek-v4-flash';
    return { provider: p, modelId: fallbackModel };
  }

  /** 从 config/api.json 初始化（启动时调用） */
  initFromConfig(): void {
    try {
      const raw = readFileSync('config/api.json', 'utf-8');
      const cfg = JSON.parse(raw) as { provider?: string; baseUrl?: string; apiKey?: string; model?: string };

      // 尝试匹配已知供应商
      const matched = this.getAll().find(p =>
        p.type === cfg.provider || p.baseUrl === cfg.baseUrl
      );

      if (matched && cfg.apiKey) {
        this.setApiKey(matched.id, cfg.apiKey);
        const modelId = cfg.model && matched.models.some(m => m.id === cfg.model) ? cfg.model : matched.models[0]?.id ?? '';
        this.activate(matched.id, modelId);
      } else if (cfg.apiKey) {
        // 通过 fallback 机制兜底
        const fallback = this.getFallback();
        if (fallback) {
          this.setApiKey('opencode-go', cfg.apiKey);
          this.activate('opencode-go', fallback.modelId);
        }
      }

      // 如果仍然没有激活的供应商，激活第一个有 API Key 的
      if (!this.store.activeProvider) {
        const firstWithKey = this.getAll().find(p => p.apiKey);
        if (firstWithKey) {
          this.activate(firstWithKey.id, firstWithKey.models[0]?.id ?? '');
        }
      }
    } catch {
      // 配置文件不存在或非法，使用 fallback
      const fallback = this.getFallback();
      if (fallback) {
        this.activate('opencode-go', fallback.modelId);
      }
    }
  }

  /* ── 私有方法 ── */

  private storePath(): string {
    return STORE_PATH;
  }

  private loadStore(): ProviderStore {
    try {
      return JSON.parse(readFileSync(this.storePath(), 'utf-8'));
    } catch {
      return { apiKeys: {}, activeProvider: '', activeModel: '' };
    }
  }

  private saveStore(): void {
    try {
      writeFileSync(this.storePath(), JSON.stringify(this.store, null, 2), 'utf-8');
    } catch { /* 写入失败不阻塞运行 */ }
  }
}

/* ── 全局单例 ── */

let _instance: ProviderRegistry | null = null;

/** 获取全局唯一的 ProviderRegistry 实例（延迟初始化） */
export function getProviderRegistry(): ProviderRegistry {
  if (!_instance) {
    _instance = new ProviderRegistry();
    _instance.initFromConfig();
  }
  return _instance;
}
