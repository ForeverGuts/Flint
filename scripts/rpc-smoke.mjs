/**
 * RPC 冒烟测试喂料器 —— 串行化请求（等上一条响应再发下一条）。
 * 调用方：开发者手动运行（验证真实 LLM 链路 + 阶段 B 提示词不破坏正常响应）
 * 运行方式：node scripts/rpc-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {
  env: { ...process.env, FLINT_MODE: 'rpc' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map();
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch {
    // 非 JSON 行（banner 等）忽略
  }
});

function call(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`请求 ${method} 超时(60s)`)), 60000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  });
}

const t0 = Date.now();
try {
  console.log('[1] create_session...');
  console.log(JSON.stringify(await call(1, 'create_session', { name: 'smoke-ab-test' })));
  console.log('[2] switch_session...');
  console.log(JSON.stringify(await call(2, 'switch_session', { name: 'smoke-ab-test.jsonl' })));
  console.log('[3] chat（真实 LLM，简单对话验证不调工具）...');
  const chatResp = await call(3, 'chat', { message: '你好，这是冒烟测试。请直接回答：1+1等于几？不要调用任何工具。' });
  console.log(JSON.stringify(chatResp, null, 2));
  const ok = chatResp.result && !String(chatResp.result).startsWith('⚠️') && !chatResp.error;
  console.log(ok ? '✅ 冒烟通过' : '❌ 冒烟失败');
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.error('❌', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
