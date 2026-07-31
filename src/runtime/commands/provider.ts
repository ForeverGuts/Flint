/**
 * /provider 命令 —— 选择 AI 供应商及模型（两级 ↑↓ 导航选择）。
 * 调用方：commands.ts（自动扫描器加载）
 * 服务于：选择供应商 → 选择该供应商的模型 → 应用切换并持久化
 */
import type { Runtime } from '../runtime.js';
import { getProviderRegistry } from '../provider-registry.js';
import { selectFromList } from '../../io/ui/selector.js';
import { createProvider } from '../../llm/index.js';
import { readFileSync, writeFileSync } from 'node:fs';

export function activate(runtime: Runtime): void {
  const registry = getProviderRegistry();

  runtime.registerCommand('provider', '选择 AI 供应商（↑↓ 导航选择）', async () => {
    const providers = registry.getAll().filter(p => p.models.length > 0);

    // ── 第 1 级：选择供应商 ──
    const providerChoices = providers.map(p => ({
      value: p.id,
      label: p.name,
      description: p.apiKey ? `${p.models.length} 个模型可用` : '⚠️ 未配置 API Key',
      disabled: !p.apiKey,
    }));

    const chosenProviderId = await selectFromList(
      providerChoices,
      '选择 AI 供应商（↑↓ 切换  Enter 确认）',
    );

    if (!chosenProviderId) return '❌ 已取消选择';

    const provider = registry.get(chosenProviderId);
    if (!provider) return '❌ 供应商不存在';

    // ── 第 2 级：选择模型 ──
    const modelChoices = provider.models.map(m => ({
      value: m.id,
      label: m.label,
      description: m.description ?? '',
    }));

    const chosenModelId = await selectFromList(
      modelChoices,
      `选择 ${provider.name} 的模型（↑↓ 切换  Enter 确认）`,
    );

    if (!chosenModelId) return '❌ 已取消选择';

    return applyProviderSelection(runtime, registry, chosenProviderId, chosenModelId);
  });
}

function applyProviderSelection(
  runtime: Runtime,
  registry: ReturnType<typeof getProviderRegistry>,
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

  try {
    const oldConfig = JSON.parse(readFileSync('config/api.json', 'utf-8'));
    writeFileSync('config/api.json', JSON.stringify({
      provider: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey || oldConfig.apiKey || '',
      model: modelId,
    }, null, 2), 'utf-8');
  } catch { /* 写入失败不影响运行 */ }

  return `✅ 已切换到 ${provider.name} / ${provider.models.find(m => m.id === modelId)?.label ?? modelId}`;
}
