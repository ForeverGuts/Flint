/**
 * Runtime 运行时 —— Agent 运行时的上下文与全局状态管理。
 * 调用方：main.ts（初始化并启动）
 * 服务于：串联 LLM 调用、session 对话、services 配置扩展、提供生命周期
 */
import type { LLMProvider } from '../llm/types.js';
import type { RuntimeOptions } from '../types.js';

export class Runtime {
  private llm: LLMProvider;

  constructor(private options: RuntimeOptions) {
    this.llm = options.llm!;
    void this.options;
  }

  async start(): Promise<void> {
    // TODO: 使用 session / services 启动子模块
  }

  async stop(): Promise<void> {
    // TODO: 停止 Runtime 子模块
  }

  /** 处理单次用户输入，返回 LLM 回复 */
  async prompt(input: string): Promise<string> {
    // TODO ①: 扩展命令检查（/ 开头匹配扩展注册表，拦截后不送 LLM）
    // TODO ②: 扩展 input 事件（扩展可 handled / transform 输入）
    // TODO ③: Skill / 模板展开（/skill:名称 读取文件，/模板名 展开提示）
    // TODO ④: 流式队列检查（LLM 输出中 → steer 打断 / followUp 排队）
    // TODO ⑤: 刷新待处理消息（注入排队中 Bash 执行结果等）
    // TODO ⑥: 模型 + Auth 验证（模型已选？API key 已配？OAuth 过期？）
    // TODO ⑦: 发送前压缩检查（上下文接近阈值 → 自动压缩历史）
    // TODO ⑧: 构建消息数组 → 调用 LLM → 返回回复

    const reply = await this.llm.chat([{ role: 'user', content: input }]);
    return reply;
  }
}
