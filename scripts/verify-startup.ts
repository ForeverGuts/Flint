/**
 * 启动提速第二档验证 —— 启动关键路径 0 网络请求 + 模型列表的预热/去重/新鲜期。
 *
 * 覆盖：
 *   S1  new ConfigManager()：只读本地文件，全程 0 次 fetch（改造前这里会 await init() 拉 N 家）
 *   S2  getConfigManager()：真实单例同样 0 次 fetch（check() 阻塞 UI 的正是这一步）
 *   S3  构造完立刻能用：静态模型已在手，modelsFetchedAt 为 null
 *   S4  warmModels()：只拉有 key 的供应商，没 key 的一家一次都不打
 *   S5  warmModels() 后：远程模型并入（远程在前、静态标 isStatic）+ modelsFetchedAt 盖戳
 *   S6  无 key / 连不上的供应商：不盖戳、静态兜底仍在、warmModels 不抛
 *   S7  新鲜期内 ensureModels()：一次都不重发（这是"开 /model 零等待"的依据）
 *   S8  新鲜期过后 ensureModels()：重新拉一次并重新盖戳
 *   S9  inflight 去重：预热与 ensureModels 并发打同一家 → 只发一次请求
 *   S10 拉取失败（HTTP 500 / 200 空列表）→ 不盖戳，下一次仍会重试
 *   S11 refreshModels() 无视新鲜期（输入新 key 后必须现拉，不看戳）
 *
 * 注：S3 的构造耗时只打印实测值、不作断言 —— "0 次 fetch" 已经是硬保证，
 *     再卡一个毫秒阈值只会在慢盘上制造假红。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-startup.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ConfigManager, getConfigManager } from '../src/config/manager.js';
import type { ProviderConfigJson } from '../src/llm/provider.js';

/* ── 断言 ── */

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

/* ══ 假服务器：记下每一次 /models 请求，按脚本决定 200 / 500 / 空列表 / 延迟 ══ */

const hits: string[] = [];
const failPaths = new Set<string>();
const emptyPaths = new Set<string>();
let delayMs = 0;

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  hits.push(url);
  const finish = (): void => {
    if (failPaths.has(url)) { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(emptyPaths.has(url)
      ? { data: [] }
      : { data: [{ id: 'remote-1', name: '远程一号' }, { id: 'remote-2' }] }));
  };
  if (delayMs > 0) setTimeout(finish, delayMs);
  else finish();
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** 某条路径被打了几次 —— 去重与"不再重发"的断言全靠它 */
const count = (url: string): number => hits.filter((h) => h === url).length;

/* ══ fetch 探针：要数的是"所有"请求，而不只是打到假服务器的那些 ══
   getConfigManager() 读的是仓库里真实的 providers.json（baseUrl 指向真互联网），
   光看假服务器的计数证明不了它没联网，只能拦在 fetch 这一层。 */

const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  fetchCalls++;
  return realFetch(input, init);
};

/* ══ 临时配置：三家供应商（有 key / 没 key / 坏地址），跑完即删 ══ */

const stamp = Date.now();
const providersPath = join(tmpdir(), `flint-startup-${stamp}-providers.json`);
const keysPath = join(tmpdir(), `flint-startup-${stamp}-keys.json`);
const activePath = join(tmpdir(), `flint-startup-${stamp}-active.json`);
/** 刻意指向不存在的文件：免得读到用户真实的 ~/.flint/config.json（里面可能真有 key） */
const globalPath = join(tmpdir(), `flint-startup-${stamp}-global-missing.json`);

const providers: ProviderConfigJson[] = [
  { id: 'p-key', name: '有钥匙', baseUrl: `${base}/v1`, type: 'openai', staticModels: [{ id: 'static-a', label: '静态 A' }] },
  { id: 'p-nokey', name: '没钥匙', baseUrl: `${base}/v2`, type: 'openai', staticModels: [{ id: 'static-b', label: '静态 B' }] },
  { id: 'p-dead', name: '坏地址', baseUrl: 'http://127.0.0.1:1/v3', type: 'openai', staticModels: [{ id: 'static-c', label: '静态 C' }] },
];

writeFileSync(providersPath, JSON.stringify({ providers }, null, 2));
writeFileSync(keysPath, JSON.stringify({ apiKeys: { 'p-key': 'k1', 'p-dead': 'k2' } }, null, 2));
writeFileSync(activePath, JSON.stringify({ provider: 'p-key', model: 'static-a', baseUrl: `${base}/v1` }, null, 2));

const overrides = { providersPath, keysPath, activePath, globalPath };
const newMgr = (): ConfigManager => new ConfigManager(overrides);

/* ══ ① 启动关键路径：构造 ConfigManager（S1/S3） ══ */

console.log('① 启动关键路径：new ConfigManager()（S1/S3）');
const mgr = (() => {
  fetchCalls = 0;
  hits.length = 0;
  const t0 = performance.now();
  const m = newMgr();
  const cost = performance.now() - t0;
  assert('全程 0 次 fetch（改造前这里会 await init() 并行拉 N 家 /models）', fetchCalls === 0, `实际 ${fetchCalls} 次`);
  assert('0 次请求打到假服务器', hits.length === 0, `实际 ${hits.length} 次`);
  console.log(`     ↳ 实测构造耗时 ${cost.toFixed(1)}ms（读 3 个本地文件，只打印不断言）`);
  assert('构造完静态模型就在手（不必等网络）', m.get('p-key')!.getModels().length === 1);
  assert('构造完 modelsFetchedAt 为 null（本进程还没成功拉过）', m.get('p-key')!.modelsFetchedAt === null);
  return m;
})();

/* ══ ② 真实单例：getConfigManager()（S2） ══ */

console.log('② 真实单例：getConfigManager()（S2）');
{
  fetchCalls = 0;
  const real = await getConfigManager();
  assert('单例构造全程 0 次 fetch（check() 阻塞 UI 的正是这一步）', fetchCalls === 0, `实际 ${fetchCalls} 次`);
  assert('单例照样读到了真实 providers.json', real.getAll().length > 0, `实际 ${real.getAll().length} 家`);
}

/* ══ ③ 后台预热：warmModels()（S4/S5/S6） ══ */

console.log('③ 后台预热：warmModels()（S4/S5/S6）');
{
  hits.length = 0;
  await mgr.warmModels();
  assert('有 key 的一家拉了一次', count('/v1/models') === 1, `实际 ${count('/v1/models')} 次`);
  assert('没 key 的一家一次都没打（拉不动，用静态列表）', count('/v2/models') === 0, `实际 ${count('/v2/models')} 次`);
  const ids = mgr.get('p-key')!.getModels().map((m) => `${m.id}${m.isStatic ? '(静)' : ''}`);
  assert('远程模型并入：远程在前、静态在后且标 isStatic', ids.join(',') === 'remote-1,remote-2,static-a(静)', ids.join(','));
  assert('成功拉到 → modelsFetchedAt 盖戳', typeof mgr.get('p-key')!.modelsFetchedAt === 'number');
  assert('没 key 的一家 → modelsFetchedAt 仍是 null', mgr.get('p-nokey')!.modelsFetchedAt === null);
  assert('没 key 的一家 → 列表仍是静态兜底', mgr.get('p-nokey')!.getModels().map((m) => m.id).join() === 'static-b');
  assert('连不上的一家 → warmModels 不抛、不盖戳', mgr.get('p-dead')!.modelsFetchedAt === null);
  assert('连不上的一家 → 静态兜底仍在', mgr.get('p-dead')!.getModels().map((m) => m.id).join() === 'static-c');
}

/* ══ ④ 按需现拉：ensureModels() 与新鲜期（S7/S8） ══ */

console.log('④ 按需现拉：ensureModels() 与新鲜期（S7/S8）');
{
  hits.length = 0;
  assert('预热刚成功 → isModelsFresh 报真', mgr.isModelsFresh('p-key') === true);
  await mgr.ensureModels('p-key');
  assert('新鲜期内 → 一次都不重发（开 /model 零等待的依据）', count('/v1/models') === 0, `实际 ${count('/v1/models')} 次`);

  // 把戳改旧模拟过期（内存字段直接改，比真等 5 分钟实在）
  mgr.get('p-key')!.modelsFetchedAt = Date.now() - 6 * 60 * 1000;
  assert('戳改旧 → isModelsFresh 报假', mgr.isModelsFresh('p-key') === false);
  await mgr.ensureModels('p-key');
  assert('过期后 → 重新拉一次', count('/v1/models') === 1, `实际 ${count('/v1/models')} 次`);
  assert('重拉成功 → 重新盖戳', mgr.isModelsFresh('p-key') === true);

  hits.length = 0;
  await mgr.ensureModels('p-nokey');
  assert('没 key 的一家 → ensureModels 直接返回，不发请求', count('/v2/models') === 0);
  await mgr.ensureModels('查无此人');
  assert('未知供应商 id → 不抛、不发请求', hits.length === 0);
}

/* ══ ⑤ 在飞去重：预热与 /model 撞在一起（S9） ══ */

console.log('⑤ 在飞去重：预热与 /model 撞在一起（S9）');
{
  const m2 = newMgr();
  delayMs = 120;          // 让请求在飞一会儿，制造"用户紧接着开 /model"的窗口
  hits.length = 0;
  const warm = m2.warmModels();             // 后台预热先起飞
  const ensure = m2.ensureModels('p-key');  // 用户手快，紧跟着开 /model
  await Promise.all([warm, ensure]);
  delayMs = 0;
  assert('同一家并发两次 → 只发一次请求（第二次复用在飞的 promise）', count('/v1/models') === 1, `实际 ${count('/v1/models')} 次`);
  assert('两个调用方拿到同一份结果', m2.get('p-key')!.getModels().length === 3);
  assert('飞完就清账 → 下次过期还能重新发起', m2.isModelsFresh('p-key') === true);
}

/* ══ ⑥ 失败不盖戳：断网那一次不能被误记成"已新鲜"（S10） ══ */

console.log('⑥ 失败不盖戳（S10）');
{
  const m3 = newMgr();
  failPaths.add('/v1/models');
  await m3.ensureModels('p-key');
  assert('HTTP 500 → 不盖戳（否则整个进程周期都不会再重试）', m3.get('p-key')!.modelsFetchedAt === null);
  assert('HTTP 500 → 静态兜底仍在', m3.get('p-key')!.getModels().map((m) => m.id).join() === 'static-a');
  assert('HTTP 500 → isModelsFresh 报假，下次还会试', m3.isModelsFresh('p-key') === false);
  failPaths.delete('/v1/models');
  await m3.ensureModels('p-key');
  assert('网络恢复后重试成功 → 这次盖戳了', m3.isModelsFresh('p-key') === true);
  assert('网络恢复后重试成功 → 远程模型回来了', m3.get('p-key')!.getModels().length === 3);

  emptyPaths.add('/v1/models');
  const m4 = newMgr();
  await m4.warmModels();
  assert('200 但列表为空 → 同样不盖戳（空列表不是"拉到了"）', m4.get('p-key')!.modelsFetchedAt === null);
  emptyPaths.delete('/v1/models');
}

/* ══ ⑦ refreshModels：输入新 key 后必须现拉（S11） ══ */

console.log('⑦ refreshModels()：无视新鲜期（S11）');
{
  hits.length = 0;
  assert('此刻列表是新鲜的', mgr.isModelsFresh('p-key') === true);
  await mgr.refreshModels('p-key');
  assert('新鲜期内也照拉（新 key 可能解锁不同模型）', count('/v1/models') === 1, `实际 ${count('/v1/models')} 次`);
}

/* ── 收尾：还原 fetch 探针、关服务器、删临时文件 ── */

globalThis.fetch = realFetch;
server.close();
for (const f of [providersPath, keysPath, activePath]) {
  if (existsSync(f)) { try { unlinkSync(f); } catch { /* 清理失败不影响结论 */ } }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 100);
