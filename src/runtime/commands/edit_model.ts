/**
 * /edit_model 命令 —— 修改已有供应商的配置。
 * 调用方：commands.ts（自动扫描器加载）
 * 服务于：选择某供应商 → 重走配置表单 → 更新 providers.json + provider-keys.json（只更新不切换）
 *
 * 与 /model 区分：/model 是"选供应商+模型并切换"，/edit_model 是"改已有供应商配置"。
 */
import type { Runtime } from '../runtime.js';
import { getConfigManager } from '../../config/manager.js';
import { promptProviderForm } from './model.js';

export function activate(runtime: Runtime): void {
  runtime.registerCommand('edit_model', '修改已有供应商的配置（名称/地址/协议/key/模型）', async () => {
    const mgr = await getConfigManager();
    const providers = mgr.getAll();

    // ── ① 选择供应商（展示名称 + 模型 ID） ──
    const choices = providers.map((p) => ({
      value: p.id,
      label: `${p.name}`,
      description: `模型: ${p.getModels().map((m) => m.id).join(', ')}`,
    }));

    const chosenId = await runtime.select(choices, '选择要修改的供应商（↑↓ 切换  Enter 确认）');
    if (!chosenId) return '❌ 已取消';

    const existing = mgr.get(chosenId);
    if (!existing) return '❌ 供应商不存在';

    // ── ② 重走表单（带默认值，留空沿用现有） ──
    const form = await promptProviderForm(runtime, {
      name: existing.name,
      baseUrl: existing.baseUrl,
      type: existing.type,
      model: existing.getModels()[0]?.id,
    });
    if (!form) return '❌ 已取消';

    // ── ③ 更新配置（同 id 覆盖 + 改 key） ──
    const cfg = { ...form.cfg, id: chosenId };
    mgr.saveCustomProvider(cfg);
    if (form.apiKey) mgr.setKey(chosenId, form.apiKey);

    // ④ 更新运行时 Provider 对象（重新实例化，让新配置生效）
    mgr.registerProvider(mgr.createProviderObject(cfg));

    return `✅ 已更新供应商「${existing.name}」的配置（未切换，可用 /model 选择）。`;
  });
}
