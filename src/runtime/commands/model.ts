/**
 * /model 命令 —— 选择 AI 供应商及模型（两级 ↑↓ 导航）+ 自定义供应商。
 * 调用方：commands.ts（自动扫描器加载）
 * 服务于：一级选供应商，二级选该供应商的模型，应用切换并持久化；
 *        支持"➕ 自定义供应商"入口：填 baseUrl+type+key+模型，运行时注册 + 持久化
 *
 * 交互流程：
 *   ① 列出所有供应商（标注 API key 状态）+ 末尾"➕ 自定义供应商"
 *   ② 选供应商；若未配置 key → 交互输入并保存
 *   ③ 列出该供应商的模型（↑↓ 选择）
 *   ④ 应用切换：写激活状态 + 热替换 LLM
 */
import type { Runtime } from '../runtime.js';
import { getConfigManager } from '../../config/manager.js';
import type { ProviderConfigJson } from '../../llm/provider.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('model', '选择 AI 供应商及模型 / 自定义供应商（↑↓ 导航）', async () => {
    const mgr = await getConfigManager();
    const providers = mgr.getAll().filter((p) => p.getModels().length > 0);

    // ── ① 一级：选择供应商（含"自定义"入口） ──
    const providerChoices = providers.map((p) => ({
      value: p.id,
      label: p.name,
      description: p.getApiKey()
        ? `${p.getModels().length} 个模型可用`
        : `⚠️ 无 API Key${p.apiKeyEnv ? `（环境变量 ${p.apiKeyEnv}）` : ''}，选择后可输入`,
    }));
    providerChoices.push({ value: '__custom__', label: '➕ 自定义供应商', description: '填入 baseUrl / API Key / 模型，运行时新增' });

    const chosen = await runtime.select(providerChoices, '选择 AI 供应商（↑↓ 切换  Enter 确认）');
    if (!chosen) return '❌ 已取消选择';

    // ── ② 自定义供应商流程 ──
    if (chosen === '__custom__') {
      return await addCustomProvider(runtime, mgr);
    }

    const provider = mgr.get(chosen);
    if (!provider) return '❌ 供应商不存在';

    // ── ③ 若无 API Key，交互输入 ──
    if (!provider.getApiKey()) {
      const key = await promptInput(
        runtime,
        `请粘贴 ${provider.name} 的 API Key：`,
        '',
        provider.apiKeyEnv ? `(也可以设置环境变量 ${provider.apiKeyEnv} 后重启)` : undefined,
      );
      if (!key) return '❌ 已取消（未配置 API Key）';
      mgr.setKey(chosen, key.trim());
      await mgr.refreshModels(chosen); // 输入密钥后重新拉取模型
    }

    const refreshed = mgr.get(chosen);
    if (!refreshed || refreshed.getModels().length === 0) {
      return '❌ 该供应商没有可用模型';
    }

    // ── ④ 二级：选择模型 ──
    const modelChoices = refreshed.getModels().map((m) => ({
      value: m.id,
      label: m.isStatic ? `${m.label} (静态模型)` : m.label,
      description: m.description ?? '',
    }));

    const chosenModelId = await runtime.select(
      modelChoices,
      `选择 ${refreshed.name} 的模型（↑↓ 切换  Enter 确认）`,
    );
    if (!chosenModelId) return '❌ 已取消选择';

    // ── ⑤ 应用切换 ──
    return applyModelSelection(runtime, mgr, chosen, chosenModelId);
  });
}

/** 交互输入一行（带提示 + 可选默认值；留空回车返回默认值）。TTY 下走 runtime.readLineInput（绕过 readline 污染） */
async function promptInput(runtime: Runtime, label: string, defaultVal = '', hint?: string): Promise<string> {
  console.log('');
  console.log(`  ${label}`);
  if (hint) console.log(`  ${hint}`);
  if (defaultVal) console.log(`  (默认: ${defaultVal}，直接回车沿用)`);
  const input = (await runtime.readLineInput('  > ')).trim();
  return input || defaultVal;
}

/**
 * 交互表单：收集供应商配置（名称/地址/协议/key/模型）。
 * 调用方：/model 自定义入口、/edit_model 命令
 * 服务于：新增和编辑复用同一套表单，避免重复代码
 * @returns 供应商配置（不含 key）或 null（取消）
 */
export async function promptProviderForm(
  runtime: Runtime,
  defaults?: { name?: string; baseUrl?: string; type?: string; model?: string },
): Promise<{ cfg: ProviderConfigJson; apiKey: string } | null> {
  console.log('');
  console.log('  ── 供应商配置 ──');
  console.log('  (可随时 Ctrl+C 取消)');

  const name = await promptInput(runtime, '供应商名称：', defaults?.name);
  if (!name) return null;
  const baseUrl = await promptInput(runtime, 'API 地址（如 https://api.deepseek.com）：', defaults?.baseUrl);
  if (!baseUrl) return null;
  // 协议类型用选择器（↑↓ 选 openai / anthropic，避免手输打错）
  const type = await runtime.select(
    [
      { value: 'openai', label: 'OpenAI 兼容协议', description: '覆盖 DeepSeek / OpenRouter / 通义等（/v1/chat/completions）' },
      { value: 'anthropic', label: 'Anthropic 协议', description: 'Anthropic Messages 格式（/v1/messages）' },
    ],
    '选择协议类型（↑↓ 切换  Enter 确认）',
  );
  if (!type) return null;
  const apiKey = await promptInput(runtime, 'API Key（留空则沿用现有）：', '');
  const modelId = await promptInput(runtime, '默认模型 ID（如 deepseek-chat）：', defaults?.model);
  if (!modelId) return null;

  return {
    cfg: {
      id: '', // 调用方填 id
      name,
      baseUrl,
      type,
      staticModels: [{ id: modelId, label: modelId }],
    },
    apiKey,
  };
}

/**
 * 自定义供应商：交互收集 baseUrl/type/key/模型 → 运行时注册 Provider + 持久化到 providers.json。
 */
async function addCustomProvider(runtime: Runtime, mgr: Awaited<ReturnType<typeof getConfigManager>>): Promise<string> {
  const form = await promptProviderForm(runtime);
  if (!form) return '❌ 已取消';
  const { cfg, apiKey } = form;

  // 生成唯一 id（时间戳后缀）
  const id = `custom-${Date.now().toString(36).slice(-5)}`;
  cfg.id = id;

  // ① 持久化到 providers.json（不含 key，密钥走 provider-keys.json）
  mgr.saveCustomProvider(cfg);
  // ② key 存项目密钥文件（注意：需先 setKey 再 createProviderObject，让 getApiKey 能命中）
  if (apiKey) mgr.setKey(id, apiKey);
  // ③ 运行时实例化 Provider 对象（用 manager 的标准 key 解析），注册
  const provider = mgr.createProviderObject(cfg);
  mgr.registerProvider(provider);

  // ④ 远程拉取模型列表（失败/不兼容自动保留静态模型兜底）
  await provider.refreshModels();

  // ⑤ 应用：激活 + 热替换
  const chosenModelId = cfg.staticModels?.[0]?.id ?? '';
  mgr.activate(id, chosenModelId);
  try {
    const llm = provider.createLLM(chosenModelId);
    runtime.setLLM(llm);
  } catch (err) {
    return `❌ 模型加载失败: ${err instanceof Error ? err.message : String(err)}`;
  }
  runtime.currentProvider = provider.type;
  runtime.currentBaseUrl = provider.baseUrl;
  runtime.currentModel = chosenModelId;

  return `✅ 已添加并切换到自定义供应商「${cfg.name}」/ ${chosenModelId}（已持久化到 providers.json）`;
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
    const newProvider = provider.createLLM(modelId);
    runtime.setLLM(newProvider);
  } catch (err) {
    return `❌ 模型加载失败: ${err instanceof Error ? err.message : String(err)}`;
  }

  runtime.currentProvider = provider.type;
  runtime.currentBaseUrl = provider.baseUrl;
  runtime.currentModel = modelId;

  const modelLabel = provider.getModels().find((m) => m.id === modelId)?.label ?? modelId;
  return `✅ 已切换到 ${provider.name} / ${modelLabel}`;
}
