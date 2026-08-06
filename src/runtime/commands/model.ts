/**
 * /model 命令 —— 选择 AI 供应商及模型（两级 ↑↓ 导航）。
 * 调用方：commands.ts（自动扫描器加载）
 * 服务于：合并原 /provider + /model —— 一级选供应商，二级选该供应商的模型，应用切换并持久化
 *
 * 交互流程：
 *   ① 列出所有供应商（标注 API key 状态）
 *   ② 选供应商；若未配置 key → 交互输入并保存
 *   ③ 列出该供应商的模型（↑↓ 选择）
 *   ④ 应用切换：写激活状态 + 热替换 LLM
 */
import type { Runtime } from '../runtime.js';
import { getConfigManager } from '../../config/manager.js';
import { createProvider } from '../../llm/index.js';
import { readLine } from '../../io/terminal.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('model', '选择 AI 供应商及模型（↑↓ 导航）', async () => {
    const mgr = await getConfigManager();
    const providers = mgr.getAll().filter((p) => p.models.length > 0);

    // ── ① 一级：选择供应商 ──
    const providerChoices = providers.map((p) => ({
      value: p.id,
      label: p.name,
      description: p.apiKey
        ? `${p.models.length} 个模型可用`
        : `⚠️ 无 API Key${p.apiKeyEnv ? `（环境变量 ${p.apiKeyEnv}）` : ''}，选择后可输入`,
      // 无 key 也能选（选了再提示输入），所以不禁用
    }));

    const chosenProviderId = await runtime.select(providerChoices, '选择 AI 供应商（↑↓ 切换  Enter 确认）');
    if (!chosenProviderId) return '❌ 已取消选择';

    const provider = mgr.get(chosenProviderId);
    if (!provider) return '❌ 供应商不存在';

    // ── ② 若无 API Key，交互输入 ──
    if (!provider.apiKey) {
      const key = await promptApiKey(provider.name, provider.apiKeyEnv ?? '');
      if (!key) return '❌ 已取消（未配置 API Key）';
      mgr.setKey(chosenProviderId, key.trim());
      await mgr.refreshModels(chosenProviderId); // 输入密钥后重新拉取模型
    }

    const refreshed = mgr.get(chosenProviderId);
    if (!refreshed || refreshed.models.length === 0) {
      return '❌ 该供应商没有可用模型';
    }

    // ── ③ 二级：选择模型 ──
    const modelChoices = refreshed.models.map((m) => ({
      value: m.id,
      label: m.isStatic ? `${m.label} (静态模型)` : m.label,
      description: m.description ?? '',
    }));

    const chosenModelId = await runtime.select(
      modelChoices,
      `选择 ${refreshed.name} 的模型（↑↓ 切换  Enter 确认）`,
    );
    if (!chosenModelId) return '❌ 已取消选择';

    // ── ④ 应用切换 ──
    return applyModelSelection(runtime, mgr, chosenProviderId, chosenModelId);
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

/** 应用选择：激活状态 + 热替换 LLM + 更新 runtime 当前信息 */
function applyModelSelection(
  runtime: Runtime,
  mgr: Awaited<ReturnType<typeof getConfigManager>>,
  providerId: string,
  modelId: string,
): string {
  const provider = mgr.get(providerId);
  if (!provider) return '❌ 供应商不存在';

  mgr.activate(providerId, modelId);

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

  const modelLabel = provider.models.find((m) => m.id === modelId)?.label ?? modelId;
  return `✅ 已切换到 ${provider.name} / ${modelLabel}`;
}
