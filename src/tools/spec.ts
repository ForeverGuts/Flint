/**
 * 工具参数规格 —— 一份定义，派生出三样东西。
 *
 * 调用方：tools/builtin.ts（声明 6 个工具的参数）、tools/registry.ts（execute 里跑校验）
 * 服务于：把"发给 LLM 的参数单子"与"工具层的运行时审核"收敛成同一个源头
 *
 * 改造前的病（2026-09-06 实测取证，不是推测）：
 *   同一套参数规则在项目里写了两遍，且**没有任何机制保证一致**——
 *     ① builtin.ts 里 6 份 parameters（JSON Schema，序列化后发给 LLM）
 *     ② 14 处校验件调用 + 1 处手写 boolean 强转（工具层拿到 args 后自己再查一遍）
 *   两者之间唯一的纽带是**人手把同一个词打了多遍**：grep 的 'pattern' 在这一个工具里出现 7 次，
 *   其中 4 处是协议性的（description 文案 1、对象属性名 1、字符串字面量 2），而 TS 一处都不检查
 *   ——校验件的 key 形参类型是 string，什么都能塞。把它写成 'patern'（漏一个 t），编译通过、
 *   测试不红，只在运行时让模型收到一句"patern 是必填参数"，而它手上的单子写的是 pattern。
 *
 *   更硬的一条：registry.execute() 改前只有 3 行，tool.parameters **一个字段都没读**。实测造一个
 *   parameters 声明 required: ['mustHave'] 的工具，然后①什么都不传 ②传一个对象 ③传 Schema 里
 *   根本不存在的参数名——三次全部返回 [OK]。所以那份单子改前的身份是"给模型的建议书"，不是契约。
 *   收敛要做的因此不只是"让两处一致"，而是**让那份单子第一次真正生效**。
 *
 *   还有 requireString 里那句 `const str = String(val)`——一个**永远通过的校验**：传 123 / {a:1} /
 *   ['src'] / true 全部通过，被强转成 "123" / "[object Object]" / "src" / "true"，然后在**文件系统层**
 *   才失败并报 [NOT_FOUND] / [NOT_FILE]。错误归因错到另一层，模型会以为是自己路径写错而开始猜路径
 *  （与 grep 把执行失败报成 [NO_MATCH] 那个洞同构：都是"错误被算成了正常答案"）。
 *
 * 派生的三样（改一处，三处同时变；verify-spec.ts 的 1-6~1-8b 用**对照组**钉住这一点，
 * 否则"同源"可以被实现成"两份各自硬编码但恰好一致"而全绿）：
 *   toJsonSchema(spec)    → 发给 LLM 的 parameters
 *   parseSpec(spec, args) → 运行时审核，产出类型确定的参数对象
 *   Infer<typeof spec>    → handler 的入参类型（"撬参数"这个动作本身消失）
 *
 * 刻意不做的事：不做跨字段约束、不做嵌套对象、不做 union、不做自定义 refine。项目 16 个字段
 * 只用到 5 种形状，多写一分就是多一处要维护的死代码。要新形状时在这里加一个构造器。
 *（这也是不引 Zod / TypeBox 的原因：它们的表达力本项目用不到十分之一，而 Zod 还需要
 *  zodToJsonSchema 这座**有损**的桥——.refine() 之类的跨字段约束会被静默丢掉。）
 */
import type { ToolDefinition, ToolParameterSchema, ToolResult, ToolStatus } from '../core/tools.js';

/**
 * 参数不合法。由 registry.execute 就地转成 `[INVALID] ...` 回给模型，
 * 而 agent-loop 把 `[INVALID]` 前缀计入失败（2026-09-05 起），连错两次就会注入[系统提示]。
 * 这条链路是本类存在的理由：它不是"抛个错"，是**一个会被分类、会触发保护的信号**。
 */
export class ToolInputError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolInputError';
  }
}

interface FieldBase {
  /** 错误文案里的中文名，如 '文件路径'。与 description 分开：后者是给模型看的长文案 */
  label: string;
  /** 发给 LLM 的字段说明（含示例）。逐字进 JSON Schema，改它等于改对模型的措辞 */
  description: string;
  required: boolean;
}

export interface StringField extends FieldBase {
  kind: 'string';
  /** 必填但允许空串（edit 的 newText：空串=删掉这一段，是合法意图，不能当缺参拒绝） */
  allowEmpty?: boolean;
  /** allowEmpty 字段缺参时追加的提示语，逐字接在"是必填参数"后面 */
  emptyHint?: string;
  default?: string;
}

export interface NumberField extends FieldBase {
  kind: 'number';
  default?: number;
}

export interface BoolField extends FieldBase {
  kind: 'boolean';
  default?: boolean;
}

export type Field = StringField | NumberField | BoolField;

/** 一个工具的参数规格：字段名 → 字段规则。键的声明顺序会逐字成为 Schema 里 properties 的顺序 */
export type Spec = Record<string, Field>;

/**
 * 从规格推出 handler 的入参类型。可选字段的默认值已由 parse 填好，
 * 所以推出来的每个键都是**必有**的（不是 `?:`）——handler 里不必再判 undefined。
 */
export type Infer<S extends Spec> = {
  [K in keyof S]: S[K] extends { kind: 'string' } ? string
    : S[K] extends { kind: 'number' } ? number
      : S[K] extends { kind: 'boolean' } ? boolean
        : never;
};

/* ═══════════════════════════════════════════════════════════════════════════════
   构造器：五种形状，覆盖项目现有 16 个字段，不多做一种
   ═══════════════════════════════════════════════════════════════════════════════ */

/** 必填字符串。空白串按缺参处理（改前 requireString 的语义） */
export function str(label: string, description: string): StringField {
  return { kind: 'string', label, description, required: true };
}

/** 必填字符串但**允许空串**。missingHint 逐字接在"是必填参数"后面 */
export function strAllowEmpty(label: string, description: string, missingHint: string): StringField {
  return { kind: 'string', label, description, required: true, allowEmpty: true, emptyHint: missingHint };
}

/** 可选字符串，缺省填 defaultVal。空串合法（grep 的 include 缺省就是 ''） */
export function optStr(label: string, description: string, defaultVal: string): StringField {
  return { kind: 'string', label, description, required: false, default: defaultVal };
}

/** 可选正整数，缺省填 defaultVal */
export function optPosInt(label: string, description: string, defaultVal: number): NumberField {
  return { kind: 'number', label, description, required: false, default: defaultVal };
}

/** 可选布尔，缺省填 defaultVal */
export function optBool(label: string, description: string, defaultVal: boolean): BoolField {
  return { kind: 'boolean', label, description, required: false, default: defaultVal };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   派生物①：发给 LLM 的 JSON Schema
   ═══════════════════════════════════════════════════════════════════════════════ */

export function toJsonSchema(spec: Spec): ToolParameterSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, f] of Object.entries(spec)) {
    // 键序固定为 type → description：getLLMTools 会把整个对象序列化发给模型，
    // verify-spec ④ 段按**逐字**比对改造前的快照，顺序变了就红
    properties[key] = { type: f.kind, description: f.description };
    if (f.required) required.push(key);
  }
  const schema: ToolParameterSchema = { type: 'object', properties };
  // 名单为空时**不写这个键**：ls 改造前就没有 required，多写一个 `required: []`
  // 会让发给模型的 Schema 与基线不一致（Object.entries 保证 required 按声明顺序）
  if (required.length > 0) schema.required = required;
  return schema;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   派生物②：运行时审核
   ═══════════════════════════════════════════════════════════════════════════════ */

export function parseSpec<S extends Spec>(spec: S, args: Record<string, unknown>): Infer<S> {
  // 多余参数拒绝。改前静默忽略：{pattern:'x', pathh:'typo'} 会让 path 退回默认值 '.'，
  // 搜完整个项目还报 [OK]——模型以为自己在搜指定目录，实际搜的是全库。
  // 文案里**列出可用参数名**：这正是 'patern' 那类拼写错误唯一能被当场纠正的机会。
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) {
      throw new ToolInputError('unknown_param',
        `未知参数 (${key})：本工具不接受这个参数名，可用的是 ${Object.keys(spec).join(' / ')}`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, f] of Object.entries(spec)) {
    const val = args[key];
    if (val === undefined || val === null) {
      if (!f.required) {
        out[key] = f.default;   // 缺省填默认值，handler 拿到的一定是完整对象
        continue;
      }
      const hint = f.kind === 'string' && f.allowEmpty ? (f.emptyHint ?? '') : '';
      throw new ToolInputError('missing', `${f.label} (${key}) 是必填参数${hint}`);
    }
    out[key] = coerce(f, key, val);
  }
  return out as Infer<S>;
}

/** 按声明的 kind 收窄一个值。这里是全项目**唯一**做参数类型判断的地方 */
function coerce(f: Field, key: string, val: unknown): string | number | boolean {
  if (f.kind === 'string') {
    // 不再 String(val)：那是个永远通过的校验，把类型错误推迟到文件系统层才暴露，
    // 于是模型收到 [NOT_FOUND] 而真因是它传了个数字——归因错层，它会开始猜路径
    if (typeof val !== 'string') {
      throw new ToolInputError('invalid_type', `${f.label} (${key}) 必须是字符串`);
    }
    if (f.required && !f.allowEmpty && !val.trim()) {
      throw new ToolInputError('empty', `${f.label} (${key}) 不能为空`);
    }
    return val;
  }

  if (f.kind === 'number') {
    // 数字字符串仍宽容接受（模型常这么传，改前 Number(val) 也接受）；其余类型一律拒。
    // 空串要单独挡：Number('') === 0，会绕过下面 num < 1 的判断吗——不会，但它会变成一个
    // 看起来像"模型传了 0"的错误，归因不准，所以在这里就拒
    const num = typeof val === 'number' ? val
      : (typeof val === 'string' && val.trim() !== '' ? Number(val) : NaN);
    if (!Number.isInteger(num) || num < 1) {
      throw new ToolInputError('invalid_range', `${f.label} (${key}) 必须是正整数`);
    }
    return num;
  }

  if (typeof val === 'boolean') return val;
  // 'true'/'false' 字符串放行：模型偶尔这么传，拒了只是白烧一轮。其余（含数字 1）拒——
  // 改前 `String(args.replaceAll) === 'true'` 会把 1 静默当成 false，模型以为自己开了全量替换
  if (val === 'true') return true;
  if (val === 'false') return false;
  throw new ToolInputError('invalid_type', `${f.label} (${key}) 必须是布尔值`);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   返回值构造器：结构化返回值的**唯一**入口（2026-09-12 起）

   改前 handler 手写 `[前缀] 文本` 字符串，前缀是工具层与消费层之间唯一的协议——
   拼错一个字母（[ERORR]）分类就静默漂移成"成功"。现在 handler 返回 ToolResult：
   status 是机器读的字段（分类不再解析文本），content 是模型读的文本。
   前缀由构造器统一生成，handler 只写正文——**正文措辞与改前逐字一致**，
   模型看到的协议文本一字未变，变的只是机器通道。
   ═══════════════════════════════════════════════════════════════════════════════ */

/** 有效否定可用的五个前缀（与 agent-loop 分类注释里的名单一一对应，类型挡住乱造新前缀） */
export type ToolNegativePrefix = 'NOT_FOUND' | 'NOT_DIR' | 'NOT_FILE' | 'NO_MATCH' | 'EMPTY';

function make(status: ToolStatus, prefix: string, content: string): ToolResult {
  return { status, content: `[${prefix}] ${content}` };
}

/** 成功（不计失败） */
export function toolOk(content: string): ToolResult {
  return make('ok', 'OK', content);
}

/** 无效输入（计失败）：模型给的参数不合法，原样重试必然再错 */
export function toolInvalid(content: string): ToolResult {
  return make('invalid', 'INVALID', content);
}

/** 执行失败（计失败）：参数合法但工具没能完成工作 */
export function toolError(content: string): ToolResult {
  return make('error', 'ERROR', content);
}

/** 写回验证失败（计失败）：改类工具验证落盘结果与预期不符 */
export function toolVerifyFailed(content: string): ToolResult {
  return make('verify_failed', 'VERIFY_FAILED', content);
}

/** 有效否定（不计失败）：工具正常工作，答案是"没有"。prefix 限五个既有标识 */
export function toolNegative(prefix: ToolNegativePrefix, content: string): ToolResult {
  return make('negative', prefix, content);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   组装：把规格接进 core 的 ToolDefinition
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * 用一份 spec 造出完整的 ToolDefinition：parameters 与 parse 都从它派生，
 * handler 的入参类型也从它推出——于是"参数名"在源码里只剩 spec 里那一处。
 *
 * permissionKey / permissionDetail 拿的仍是**未经 parse 的原始 args**：权限确认发生在
 * agent-loop 调 execute **之前**，那时还没校验过。这两个成员因此保持 Record<string, unknown>
 * 签名，不能跟着泛型化（edit 的 permissionDetail 里那句 String(args.replaceAll) 就是这么留下的）。
 */
export function defineTool<S extends Spec>(def: {
  name: string;
  description: string;
  spec: S;
  handler: (args: Infer<S>) => Promise<ToolResult>;
  requirePermission?: boolean;
  permissionDetail?: (args: Record<string, unknown>) => string;
  permissionKey?: (args: Record<string, unknown>) => string;
}): ToolDefinition {
  const { spec, handler, ...rest } = def;
  return {
    ...rest,
    parameters: toJsonSchema(spec),
    parse: (raw) => parseSpec(spec, raw) as Record<string, unknown>,
    // 全项目**唯一**一次类型收窄。core 的 handler 契约仍是 Record<string, unknown>：跟着泛型化
    // 就得给 ToolDefinition 加类型参数，而它是三个文件的公共词汇（core/tools.ts 的接口与
    // ToolProvider.register 入参、tools/registry.ts 那个 Map 的值类型、本文件的返回类型），
    // 改一处就得跟改三处，而换来的只是省掉这一行 as。
    // 收窄的正确性由"execute 一定先跑 parse 再跑 handler"保证——verify-spec ⑥ 段钉的就是这条接线。
    handler: handler as (args: Record<string, unknown>) => Promise<ToolResult>,
  };
}
