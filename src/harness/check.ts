/**
 * 启动前检查（可靠性工程）。
 * 调用方：harness/index.ts（Harness.run 中率先执行）
 * 服务于：验证运行环境 → 逐项自检（配置/API key/连通性/模型列表）→ 创建 LLM Provider → 返回结果
 *
 * 严重度分级：
 *   - pass  配置与网络全正常
 *   - warn  API key 缺失 / 网络不通 / 模型不在列表 —— 可继续启动，但 banner 明示
 *   - fail  配置文件读不出 / JSON 解析失败 / 缺关键字段 —— 阻断启动（抛 CheckFailureError）
 *
 * 设计：诊断结果用公共 Diagnostic 类型，启动检查与运行时错误统一结构（见 types.ts）。
 */
import { createProvider } from '../llm/index.js';
import { getConfigManager } from '../config/manager.js';
import type { LLMConfig } from '../llm/types.js';
import type { CheckResult, Diagnostic } from '../types.js';

/**
 * 启动检查失败错误 —— 配置坏到无法创建 Provider 时抛出。
 * 调用方：Harness.run 捕获后打印红字诊断并优雅退出
 * 携带 diagnostics，让调用方能展示完整的失败原因
 */
export class CheckFailureError extends Error {
  /** 失败时的诊断列表 */
  diagnostics: Diagnostic[];
  constructor(message: string, diagnostics: Diagnostic[]) {
    super(message);
    this.name = 'CheckFailureError';
    this.diagnostics = diagnostics;
  }
}

const pass = (item: string, message: string): Diagnostic => ({ level: 'pass', item, message });
const warn = (item: string, message: string): Diagnostic => ({ level: 'warn', item, message });

export async function check(): Promise<CheckResult> {
  const diagnostics: Diagnostic[] = [];

  // ── ① 配置读取 + 完整性（fail 级：无法继续） ──
  let config: LLMConfig;
  let providerName = '未知供应商';
  try {
    const mgr = await getConfigManager();
    const merged = mgr.getMergedConfig();
    if (!merged) throw new Error('无激活的供应商，请先配置 config/active-config.json');
    const missing: string[] = [];
    if (!merged.provider) missing.push('provider');
    if (!merged.baseUrl) missing.push('baseUrl');
    if (!merged.model) missing.push('model');
    if (missing.length > 0) {
      throw new Error(`配置缺少字段: ${missing.join(', ')}`);
    }
    config = merged;
    // 取激活供应商的显示名（供诊断提示具体是哪个供应商）
    providerName = mgr.getActive()?.name ?? '未知供应商';
    diagnostics.push(pass('config', `配置读取成功（${providerName} / ${merged.model}）`));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagnostics.push({ level: 'fail', item: 'config', message: `配置读取失败: ${msg}` });
    throw new CheckFailureError(msg, diagnostics);
  }

  // ── ② API key 是否存在（warn 级：可继续，但对话可能 401） ──
  if (config.apiKey) {
    diagnostics.push(pass('apikey', `「${providerName}」API Key 已配置`));
  } else {
    diagnostics.push(warn('apikey', `「${providerName}」API Key 未配置，首次对话可能失败。可在 /model 中选择并输入。`));
  }

  // ── ③ 连通性：baseUrl 是否可达（warn 级：网络抖动不影响进入程序） ──
  const network = await testConnectivity(config, providerName);
  diagnostics.push(network);

  // ── ④ 模型列表拉取（区分网络问题 / key 无效 / 成功） ──
  const { models, modelDiags } = await testModelList(config, providerName);
  diagnostics.push(...modelDiags);

  // ── ⑤ 当前 model 是否在远程列表（warn 级：可能是打错或用静态兜底） ──
  if (models.length > 0 && !models.includes(config.model)) {
    diagnostics.push(warn('model', `「${providerName}」模型 ${config.model} 不在远程列表中，可能是模型名有误或由静态列表兜底。`));
  }

  const llm = createProvider(config);
  return { llm, config, diagnostics };
}

/**
 * 连通性测试 —— 检查 baseUrl 是否能建立连接。
 * 只做 GET 探测，不关心返回内容；超时/连接失败 = 网络问题（warn）。
 */
async function testConnectivity(config: LLMConfig, providerName: string): Promise<Diagnostic> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/models`;
  try {
    await fetch(url, { signal: AbortSignal.timeout(8000) });
    return pass('network', `供应商「${providerName}」网络可达: ${config.baseUrl}`);
  } catch {
    return warn('network', `供应商「${providerName}」无法连接 ${config.baseUrl}（检查网络、代理或 baseUrl 是否正确）`);
  }
}

/**
 * 模型列表拉取 —— 验证 API key 有效性 + 获取可用模型。
 * 区分三种失败：
 *   401/403 → key 无效（warn，可在 /provider 换 key）
 *   其他非 2xx → 拉取失败（warn）
 *   网络异常 → 超时/断开（warn，用静态兜底）
 */
async function testModelList(config: LLMConfig, providerName: string): Promise<{ models: string[]; modelDiags: Diagnostic[] }> {
  const headers: Record<string, string> = {};
  if (config.provider === 'anthropic') {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  const url = `${config.baseUrl.replace(/\/+$/, '')}/models`;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (res.status === 401 || res.status === 403) {
      return { models: [], modelDiags: [warn('apikey', `供应商「${providerName}」API Key 无效（HTTP ${res.status}），对话会失败。请检查 key 或在 /model 中更换。`)] };
    }
    if (!res.ok) {
      return { models: [], modelDiags: [warn('models', `供应商「${providerName}」模型列表拉取失败（HTTP ${res.status}），使用静态模型兜底。`)] };
    }
    const data = (await res.json()) as { data?: Array<{ id: string }>; models?: Array<{ id: string }> };
    const list = (data.data ?? data.models ?? []).map((m) => m.id);
    return { models: list, modelDiags: [pass('models', `供应商「${providerName}」模型列表拉取成功（${list.length} 个可用）`)] };
  } catch {
    return { models: [], modelDiags: [warn('models', `供应商「${providerName}」模型列表拉取超时/失败，使用静态模型兜底。`)] };
  }
}
