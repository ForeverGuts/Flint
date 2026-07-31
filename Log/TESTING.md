# 🧪 测试策略

> 目前测试框架未选型，此文档先约定测试策略和 mock 方式，待统一下轮接入。

---

## 一、测试层次

```
单元测试                         集成测试                       E2E 测试
┌──────────────┐          ┌──────────────────┐          ┌─────────────────┐
│ Agent 类      │          │ Runtime.prompt() │          │ 完整 REPL 循环   │
│ Session 存储  │          │ Harness.run()    │          │ 从 index.ts 启动 │
│ LLM Provider  │          │ check()          │          │ 模拟用户输入     │
│ Terminal I/O  │          │ main()           │          │ 验证输出         │
└──────────────┘          └──────────────────┘          └─────────────────┘
      ↑                           ↑                           ↑
  无外部依赖                   可 mock LLM                  可 mock 终端
  纯逻辑验证                   可 mock 存储                  可 mock 网络
```

### 1. 单元测试

测试纯逻辑，不涉及 I/O 和网络。

**可测模块：**
- `Agent` 类的 `start()` / `stop()` 状态变化
- `InMemorySession` 的消息读写
- `Mode` 枚举的类型守卫
- 工具函数

**mock 策略：** 不需要 mock，纯逻辑直接测。

```typescript
// 示例：测试 InMemorySession
const session = new InMemorySession()
await session.appendMessage('user', '你好')
const msgs = await session.getMessages()
assert.equal(msgs.length, 1)
assert.equal(msgs[0].content, '你好')
```

### 2. 集成测试

测试模块间的协作，可 mock 外部依赖。

**可测模块：**
- `Runtime.prompt()` → mock LLMProvider
- `Harness.run()` → mock check()
- `check()` → mock 文件系统
- `main()` → mock check 和 terminal

**mock 策略：** 通过接口注入 mock 实现。

```typescript
// 示例：测试 Runtime.prompt() 使用 MockSession
const mockLLM: LLMProvider = {
  chat: async () => 'mock reply',
  stream: async function* () { yield 'mock '; yield 'reply'; },
}

const runtime = new Runtime({ llm: mockLLM })
const reply = await runtime.prompt('你好')
assert.equal(reply, 'mock reply')
```

### 3. E2E 测试

模拟真实用户输入，验证完整链路。

**可测场景：**
- 启动后显示提示符
- 输入消息后显示回复
- `/exit` 退出
- 空输入被跳过

**mock 策略：** mock stdin/stdout。

```typescript
// 示例：模拟管道输入
const input = '你好\n/exit\n'
// 通过子进程运行，断言 stdout 包含预期内容
```

---

## 二、Mock 清单

| 依赖 | Mock 实现 | 用途 |
|------|-----------|------|
| LLMProvider | `MockLLM` | 测试 prompt 逻辑，不调真实 API |
| SessionStorage | `MockSession` | 测试会话管理，不读写文件 |
| Terminal I/O | mock stdin/stdout | 测试 REPL 循环，不依赖真实终端 |
| 文件系统 | mock fs | 测试 check() 读取配置 |
| Date.now | 固定时间戳 | 测试时间敏感逻辑 |

**已有实现：**
- `src/runtime/session.mock.ts` — `MockSession implements SessionStorage`
- `src/llm/types.ts` — `LLMProvider` 接口，可用于创建 mock

---

## 三、选型待定

以下需后续统一决定：

| 项目 | 待定选项 |
|------|---------|
| 测试框架 | Vitest / Jest / Node:test |
| 断言库 | Node 内置 assert / Chai / 框架自带 |
| mock 库 | 框架内置 / sinon |
| 覆盖率 | c8 / v8 / istanbul |
| 测试文件位置 | `src/**/*.test.ts` / `test/` 目录 |
