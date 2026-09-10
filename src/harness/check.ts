/**
 * 启动前检查（可靠性工程）。
 * 调用方：harness/index.ts（Harness.run 中率先执行）
 * 服务于：验证运行环境 → 逐项自检（配置/API key，均为本地操作）→ 创建 LLM Provider → 返回结果
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

  // RPC 模式：快速启动（网络探测本来就不做）
  if (process.env.FLINT_MODE === 'rpc') {
    diagnostics.push(pass('network', `「${providerName}」RPC 模式跳过网络检查（快速启动）`));
    const llm = createProvider(config);
    return { llm, config, diagnostics, providerName };
  }

  // ── ③④⑤ 网络检查全部移出启动关键路径（启动提速第一档 + 第二档）──
  // 第一档：这三项原先是串行的 /models 探测（真实网络往返，启动大头）；现改为 check 只做
  //   本地检查快速返回，probeStartup 由 main.ts 后台发起，结果经 check_done 事件回填 banner。
  // 第二档：上面 ① 的 getConfigManager() 原先还会 await init() 并行拉每家供应商的 /models，
  //   同样压在界面渲染之前（实测冷启动 1998ms、连接池热时 278ms；网络差时每家最长卡 10s 超时，
  //   全程终端只有 banner 没有 UI）；现在启动路径 0 网络请求（new ConfigManager() 实测 1ms），
  //   模型列表改由 main.ts 后台预热 + /model 打开时按新鲜期现拉（见 ConfigManager.warmModels）。
  // 因此本函数返回的 diagnostics 只有 config / apikey 两条本地结论，network / models 由 probe 事后补。
  const llm = createProvider(config);
  return { llm, config, diagnostics, providerName };
}

/**
 * 启动探测 —— 单次带 key 的 /models 请求，同时产出 network + models 两条诊断（启动提速：原先两次串行请求合一）。
 * 失败分档：
 *   网络异常（超时/断连） → network warn + models warn（静态兜底）
 *   401/403            → network pass（可达） + apikey warn（key 无效）
 *   其他非 2xx          → network pass + models warn（静态兜底）
 *   成功              → network pass + models pass（含模型数）；当前模型不在列表再补 model warn
 */
export async function probeStartup(config: LLMConfig, providerName: string): Promise<Diagnostic[]> {
  const headers: Record<string, string> = {};
  if (config.provider === 'anthropic') {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  const url = `${config.baseUrl.replace(/\/+$/, '')}/models`;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  } catch {
    return [
      warn('network', `供应商「${providerName}」无法连接 ${config.baseUrl}（检查网络、代理或 baseUrl 是否正确）`),
      warn('models', `供应商「${providerName}」模型列表拉取超时/失败，使用静态模型兜底。`),
    ];
  }

  if (res.status === 401 || res.status === 403) {
    return [
      pass('network', `供应商「${providerName}」网络可达: ${config.baseUrl}`),
      warn('apikey', `供应商「${providerName}」API Key 无效（HTTP ${res.status}），对话会失败。请检查 key 或在 /model 中更换。`),
    ];
  }
  if (!res.ok) {
    return [
      pass('network', `供应商「${providerName}」网络可达: ${config.baseUrl}`),
      warn('models', `供应商「${providerName}」模型列表拉取失败（HTTP ${res.status}），使用静态模型兜底。`),
    ];
  }

  const data = (await res.json()) as { data?: Array<{ id: string }>; models?: Array<{ id: string }> };
  const list = (data.data ?? data.models ?? []).map((m) => m.id);
  const diags: Diagnostic[] = [
    pass('network', `供应商「${providerName}」网络可达: ${config.baseUrl}`),
    pass('models', `供应商「${providerName}」模型列表拉取成功（${list.length} 个可用）`),
  ];
  if (list.length > 0 && !list.includes(config.model)) {
    diags.push(warn('model', `「${providerName}」模型 ${config.model} 不在远程列表中，可能是模型名有误或由静态列表兜底。`));
  }
  return diags;
}
