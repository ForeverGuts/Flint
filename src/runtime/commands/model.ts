/**
 * /model 命令 —— 在当前激活的供应商内选择模型（↑↓ 导航）。
 * 调用方：commands.ts（自动扫描器加载）
 * 服务于：列出当前供应商的可用模型，用 ↑↓ 选择后切换
 */
import type { Runtime } from '../runtime.js';
import { getProviderRegistry } from '../provider-registry.js';
import { selectFromList } from '../../io/ui/selector.js';
import { createProvider } from '../../llm/index.js';
import { readFileSync, writeFileSync } from 'node:fs';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('model', '切换当前供应商的模型（↑↓ 导航选择）', async () => {
    const registry = getProviderRegistry();
    const active = registry.getActive();

    if (!active) return '❌ 当前没有激活的供应商，请先使用 /provider 选择一个供应商。';

    const modelChoices = active.models.map(m => {
      const isCurrent = m.id === registry.getActiveModel();
      return {
        value: m.id,
        label: isCurrent ? `${m.label} ← 当前` : m.label,
        description: m.description ?? '',
      };
    });

    const chosen = await selectFromList(
      modelChoices,
      `${active.name} —— 选择模型（↑↓ 切换  Enter 确认）`,
    );

    if (!chosen) return '❌ 已取消选择';
    if (chosen === registry.getActiveModel()) return `⏹️  未更改，仍为 ${active.models.find(m => m.id === chosen)?.label ?? chosen}`;

    return applyModelSwitch(runtime, registry, active.id, chosen);
  });
}

function applyModelSwitch(
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

  const modelLabel = provider.models.find(m => m.id === modelId)?.label ?? modelId;
  return `✅ 已切换模型为: ${modelLabel}`;
}
