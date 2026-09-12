/**
 * 会话仓库层接口（core 层公共契约）。
 * 调用方：Runtime（listSessions/switchSession/createSession/deleteSession 委托）、
 *         session/jsonl-repo.ts（Jsonl 实现）
 * 服务于：把「会话管理」（列表/打开/新建/删除）从「单会话存储」（core/storage.ts 的
 *         SessionStorage）里分出来——storage 只管一个会话文件内部的读写，
 *         repo 管 sessions/ 目录下的一群会话文件。对标 Pi 的 jsonl-repo.ts。
 *
 * 为什么单独一层：改造前会话管理散在两处——JsonlSessionStorage 的静态方法（listAll/open/create）
 * 与 Runtime 的私有方法（文件名规范化、目录推导），且**没有删除能力**。repo 层把目录级操作
 * 收拢成一个可注入、可替身的契约，Runtime 缺省时回退到旧的静态路径（mock / 兼容场景）。
 *
 * 可选注入：RuntimeOptions.sessionRepo 是可选成员——InMemory/Mock 场景下 Runtime 不依赖
 * 本接口也能工作（与 storage.ts 可选成员的探测式设计同一立场）。
 */

/** 会话列表条目（/sessions 展示用） */
export interface SessionInfo {
  /** 文件名（不含目录），如 default.jsonl */
  fileName: string;
  /** 当前分支上的消息数 */
  msgCount: number;
  /** 文件最后修改时间（毫秒时间戳，列表按它倒序） */
  updatedAt: number;
}

/** 会话仓库层接口 */
export interface SessionRepo {
  /** 会话目录（Runtime 推导目标路径、UI 展示用） */
  getDir(): string;
  /** 列出目录下全部会话（按 updatedAt 倒序；单个文件损坏 → 跳过） */
  list(): Promise<SessionInfo[]>;
  /** 打开指定会话文件（不存在 / 格式不符 → 抛异常，调用方转译） */
  open(fileName: string): Promise<import('./storage.js').SessionStorage>;
  /** 新建空会话（缺省名自动生成）；返回规范化后的文件名与已打开的存储 */
  create(fileName?: string): Promise<{ fileName: string; storage: import('./storage.js').SessionStorage }>;
  /**
   * 删除指定会话文件。
   * @returns true=已删除 / false=文件不存在；文件名非法 → 抛异常
   */
  remove(fileName: string): Promise<boolean>;
}
