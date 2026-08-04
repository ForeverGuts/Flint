/**
 * /provider 命令 —— 选择 AI 供应商及模型（两级 ↑↓ 导航选择）。
 * 调用方：commands.ts（自动扫描器加载）
 * 服务于：选择供应商 → 选择该供应商的模型 → 应用切换并持久化
 *
 * 无 API Key 的供应商也可以选择，选中后交互式输入密钥并存入 store。
 */
import type { Runtime } from '../runtime.js';
import { getProviderRegistry } from '../provider-registry.js';
import { createProvider } from '../../llm/index.js';
import { readLine } from '../../io/terminal.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('provider', '选择 AI 供应商（↑↓ 导航选择）', async () => {
    const registry = await getProviderRegistry();
    const providers = registry.getAll().filter(p => p.models.length > 0);

    // ── 第 1 级：选择供应商 ──
    const providerChoices = providers.map(p => ({
      value: p.id,
      label: p.name,
      description: p.apiKey
        ? `${p.models.length} 个模型可用`
        : `⚠️ 无 API Key${p.apiKeyEnv ? `（环境变量 ${p.apiKeyEnv}）` : ''}，选择后可输入`,
      // 无 key 也能选（选了再提示输入），所以不禁用
    }));

    const chosenProviderId = await runtime.select(
      providerChoices,
      '选择 AI 供应商（↑↓ 切换  Enter 确认）',
    );
    if (!chosenProviderId) return '❌ 已取消选择';

    const provider = registry.get(chosenProviderId);
    if (!provider) return '❌ 供应商不存在';

    // ── 第 1.5 级：若未配置 API Key，交互输入 ──
    if (!provider.apiKey) {
      const key = await promptApiKey(provider.name, provider.apiKeyEnv ?? '');
      if (!key) return '❌ 已取消（未配置 API Key）';
      registry.setApiKey(chosenProviderId, key.trim());
      // 输入密钥后重新拉取模型列表
      await registry.refreshModels(chosenProviderId);
    }

    const refreshed = registry.get(chosenProviderId);
    if (!refreshed || refreshed.models.length === 0) {
      return '❌ 该供应商没有可用模型';
    }

    // ── 第 2 级：选择模型 ──
    const modelChoices = refreshed.models.map(m => ({
      value: m.id,
      label: m.isStatic ? `${m.label} (静态模型)` : m.label,
      description: m.description ?? '',
    }));

    const chosenModelId = await runtime.select(
      modelChoices,
      `选择 ${refreshed.name} 的模型（↑↓ 切换  Enter 确认）`,
    );
    if (!chosenModelId) return '❌ 已取消选择';

    return applyProviderSelection(runtime, registry, chosenProviderId, chosenModelId);
  });
}

/** 提示用户输入 API Key（环境变量未设置时的兜底途径） */
async function promptApiKey(providerName: string, envHint: string): Promise<string> {
  console.log('');
  console.log(`  请粘贴 ${providerName} 的 API Key：`);
  console.log(`  ${envHint ? `(也可以设置环境变量 ${envHint} 后重启)` : ''}`);
  const key = await readLine('  > ');
  return key.trim();
}

function applyProviderSelection(
  runtime: Runtime,
  registry: Awaited<ReturnType<typeof getProviderRegistry>>,
  providerId: string,
  modelId: string,
): string {
  const provider = registry.get(providerId);
  if (!provider) return '❌ 供应商不存在';

  registry.activate(providerId, modelId);

  try {
    const newProvider = createProvider({
      provider: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: modelId,
    });
    runtime.setLLM(newProvider);
  } catch (err) {
    return `❌ 模型加载失败: ${err instanceof Error ? err.message : String(err)}`;
  }

  runtime.currentProvider = provider.type;
  runtime.currentBaseUrl = provider.baseUrl;
  runtime.currentModel = modelId;
  // 注：config/active-config.json 已由 registry.activate() 写入，此处不重复写

  const modelLabel = provider.models.find(m => m.id === modelId)?.label ?? modelId;
  return `✅ 已切换到 ${provider.name} / ${modelLabel}`;
}
