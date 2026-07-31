/**
 * 启动前检查。
 * 调用方：harness/index.ts（Harness.run 中率先执行）
 * 服务于：验证运行环境 → 读取配置 → 创建 LLM Provider → 返回结果
 */
import { readFileSync } from 'node:fs';
import { createProvider } from '../llm/index.js';
import type { LLMConfig } from '../llm/types.js';
import type { CheckResult } from '../types.js';

export async function check(): Promise<CheckResult> {
  // TODO: 更多启动前检查（环境变量、端口占用、权限等）
  // TODO: 调用模型列表接口，自动列出可用模型

  const raw = readFileSync('config/active-config.json', 'utf-8');
  const config = JSON.parse(raw) as LLMConfig;
  const llm = createProvider(config);

  return { llm, config };
}
