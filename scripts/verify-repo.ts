/**
 * verify-repo.ts —— 会话仓库层（core/session-repo.ts + session/jsonl-repo.ts + Runtime 委托）
 *
 * 验什么（手段与行为分开钉）：
 *   ① isRemovableSessionName 纯函数 —— 文件名白名单逐形状喂（合法 / 路径穿越 / 错后缀 / _summary）
 *   ② 行为段（真 repo + 临时目录）—— create 缺省名与规范化、open 缺文件抛异常、list 排序与
 *      损坏文件跳过、remove 的真删/不存在/非法名三态、repo↔storage 联动（新建→写→重开→读到）
 *   ③ 行为段（真 Runtime + 探针 repo）—— 四个会话管理方法真走 repo 委托、删除守卫
 *      （当前会话拒删且 remove 未被调）、无 repo 时 deleteSession 返回 false
 *   ④ 源码断言 —— 委托接线、listAll 单一来源、types.ts 指向 core、main.ts 注入、命令有删除流程
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-repo.ts
 * 退出码：failed > 0 → 1
 */
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRemovableSessionName, JsonlSessionRepo } from '../src/session/jsonl-repo.js';
import { JsonlSessionStorage } from '../src/session/jsonl-storage.js';
import { Runtime } from '../src/runtime/runtime.js';
import { PromptEventEmitter } from '../src/runtime/events.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/* ── ① isRemovableSessionName 纯函数 ── */
console.log('── ① isRemovableSessionName 纯函数（白名单逐形状喂）──');

check('R1 普通 .jsonl → 合法', isRemovableSessionName('default.jsonl') === true);
check('R2 fork 名 → 合法', isRemovableSessionName('default-fork-abc12.jsonl') === true);
check('R3 无后缀 → 拒绝', isRemovableSessionName('default') === false);
check('R4 .txt 后缀 → 拒绝', isRemovableSessionName('evil.txt') === false);
check('R5 含 _summary → 拒绝', isRemovableSessionName('x_summary.jsonl') === false);
check('R6 相对路径穿越 .. → 拒绝', isRemovableSessionName('..\\evil.jsonl') === false);
check('R7 反斜杠分隔符 → 拒绝', isRemovableSessionName('sub\\x.jsonl') === false);
check('R8 正斜杠分隔符 → 拒绝', isRemovableSessionName('sub/x.jsonl') === false);
check('R9 裸 .. → 拒绝', isRemovableSessionName('...jsonl') === false);
check('R10 空字符串 → 拒绝', isRemovableSessionName('') === false);

/* ── 替身：Runtime 有 11 个必注入，这里只关心 sessionRepo 是真的，其余给最小假件 ── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(session: any, sessionRepo?: any): any {
  return new Runtime({
    llm: { chat: async () => ({ content: '' }), stream: () => { throw new Error('本脚本不触发 LLM'); } },
    session,
    sessionRepo,
    tools: { getLLMTools: () => [], requiresPermission: () => false, execute: async () => '', register: () => {} },
    permission: { isAutoAllowed: () => true, grantAutoAllow: () => {} },
    skills: { load: () => {} },
    events: new PromptEventEmitter(),
    spanCollector: { collect: () => [], running: () => [] },
    commandSystem: { register: () => {}, list: () => [], execute: () => null },
    diagnosticsService: { record: () => {}, getAll: () => [] },
    compaction: { maybeCompact: async (m: unknown[]) => ({ compacted: false, messages: m }) },
    systemPromptService: { build: async () => ({ messages: [] }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/** 探针 repo：记录每次调用，行为可剧本化 */
function makeProbeRepo(dir: string, opts: { openErr?: Error } = {}) {
  const calls: Record<string, unknown[]> = { list: [], open: [], create: [], remove: [] };
  return {
    calls,
    getDir: () => dir,
    list: async () => (calls.list.push([]), [{ fileName: 'from-repo.jsonl', msgCount: 7, updatedAt: 1 }]),
    open: async (f: string) => {
      calls.open.push([f]);
      if (opts.openErr) throw opts.openErr;
      return { marker: `opened:${f}` };
    },
    create: async (f?: string) => {
      calls.create.push([f]);
      return { fileName: f ? (f.endsWith('.jsonl') ? f : `${f}.jsonl`) : 'auto.jsonl', storage: { marker: `created:${f ?? ''}` } };
    },
    remove: async (f: string) => (calls.remove.push([f]), true),
  };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-repo-'));

/* ── ② 真 repo + 临时目录 ── */
console.log('── ② 真 JsonlSessionRepo（临时目录跑真文件）──');

// create：缺省名 / 补后缀 / 原样保留
{
  const repo = new JsonlSessionRepo(tmpDir);
  const a = await repo.create();
  check('R11 create 缺省名 → 返回 .jsonl 结尾文件名', a.fileName.endsWith('.jsonl'), a.fileName);
  const b = await repo.create('abc');
  check('R12 create 补后缀 → abc.jsonl', b.fileName === 'abc.jsonl', b.fileName);
  const c = await repo.create('x.jsonl');
  check('R13 create 已带后缀 → 原样', c.fileName === 'x.jsonl', c.fileName);
  const list = await repo.list();
  check('R14 list 看到三个会话', list.length === 3, `实得 ${list.length}`);
  check('R15 list 按 updatedAt 倒序（最新在前）',
    list[0].fileName === 'x.jsonl' && list[2].msgCount === 0,
    JSON.stringify(list.map((s) => s.fileName)));
}

// open：存在 / 不存在
{
  const repo = new JsonlSessionRepo(tmpDir);
  const s = await repo.open('abc.jsonl');
  check('R16 open 已存在文件 → 拿到存储', s !== undefined && typeof (s as { getMessages?: unknown }).getMessages === 'function');
  let threw = false;
  try { await repo.open('nope.jsonl'); } catch { threw = true; }
  check('R17 open 不存在 → 抛异常', threw);
}

// remove：真删 / 不存在 / 非法名
{
  const repo = new JsonlSessionRepo(tmpDir);
  check('R18 remove 存在的文件 → true', await repo.remove('x.jsonl') === true);
  check('R19 文件真没了', !fs.existsSync(path.join(tmpDir, 'x.jsonl')));
  check('R20 remove 不存在 → false', await repo.remove('x.jsonl') === false);
  let threw = false;
  try { await repo.remove('../escape.jsonl'); } catch { threw = true; }
  check('R21 remove 路径穿越 → 抛异常', threw);
  check('R22 穿越目标没被写到目录外', !fs.existsSync(path.join(tmpDir, '..', 'escape.jsonl')));
}

// repo ↔ storage 联动：新建 → 写消息 → 重开 → 读到同一批
{
  const repo = new JsonlSessionRepo(tmpDir);
  const { fileName, storage } = await repo.create('roundtrip');
  await storage.appendMessage('user', '仓库层回环');
  const reopened = (await repo.open(fileName)) as JsonlSessionStorage;
  const msgs = await reopened.getMessages();
  check('R23 新建→写→重开→读到同一批消息', msgs.length === 1 && msgs[0].content === '仓库层回环', JSON.stringify(msgs));
}

// list 的容错：空目录 / 不存在目录 / 损坏文件跳过
{
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsagent-verify-repo-empty-'));
  check('R24 空目录 → 空列表', (await new JsonlSessionRepo(emptyDir).list()).length === 0);
  const missing = path.join(emptyDir, 'not-exist-subdir');
  check('R25 目录不存在 → 空列表（不抛）', (await new JsonlSessionRepo(missing).list()).length === 0);
  fs.writeFileSync(path.join(emptyDir, 'broken.jsonl'), '{ 这不是 JSON', 'utf-8');
  fs.writeFileSync(path.join(emptyDir, 'good.jsonl'), JSON.stringify({ type: 'session', version: 2, id: 'g', createdAt: 't' }) + '\n', 'utf-8');
  const list = await new JsonlSessionRepo(emptyDir).list();
  check('R26 损坏文件跳过、好文件保留', list.length === 1 && list[0].fileName === 'good.jsonl', JSON.stringify(list));
}

/* ── ③ 真 Runtime + 探针 repo：四个方法真走 repo，删除守卫生效 ── */
console.log('── ③ Runtime 委托 repo + 删除守卫 ──');

{
  const probe = makeProbeRepo(tmpDir);
  const rt = makeRuntime({ marker: 'old-session' }, probe);

  const ls = await rt.listSessions();
  check('R27 listSessions 委托 repo.list', probe.calls.list.length === 1 && (ls[0] as { fileName?: string }).fileName === 'from-repo.jsonl');
  const sw = await rt.switchSession('target.jsonl');
  check('R28 switchSession 走 repo.open', sw === true && probe.calls.open[0][0] === 'target.jsonl');
  check('R29 切换后 session 换成了 repo 返回的存储', (rt as { session?: { marker?: string } }).session?.marker === 'opened:target.jsonl');

  let threw = false;
  const probeErr = makeProbeRepo(tmpDir, { openErr: new Error('boom') });
  const rtErr = makeRuntime({ marker: 'old' }, probeErr);
  const swErr = await rtErr.switchSession('whatever.jsonl').catch(() => { threw = true; return false; });
  check('R30 repo.open 抛异常 → switchSession 返回 false 不上抛', threw === false && swErr === false);

  const newName = await rt.createSession('fresh');
  check('R31 createSession 走 repo.create', probe.calls.create.length === 1 && probe.calls.create[0][0] === 'fresh');
  check('R32 createSession 返回规范化文件名', newName === 'fresh.jsonl', newName);
  check('R33 新建后 session 换成 repo 返回的存储', (rt as { session?: { marker?: string } }).session?.marker === 'created:fresh');

  const del = await rt.deleteSession('gone.jsonl');
  check('R34 deleteSession 走 repo.remove', del === true && probe.calls.remove[0][0] === 'gone.jsonl');
}

// 删除守卫：当前活跃会话拒删，且 repo.remove 没被调（守卫在 repo 之前）
{
  const cur = await JsonlSessionStorage.create(tmpDir, 'current.jsonl');
  await cur.appendMessage('user', '活跃线');
  const probe = makeProbeRepo(tmpDir);
  const rt = makeRuntime(cur, probe);

  check('R35 getCurrentSessionFile 返回当前会话路径',
    typeof rt.getCurrentSessionFile() === 'string' && rt.getCurrentSessionFile().endsWith('current.jsonl'),
    String(rt.getCurrentSessionFile()));

  const del = await rt.deleteSession('current.jsonl');
  check('R36 删除当前会话 → false（Runtime 守卫）', del === false);
  check('R37 守卫在 repo 之前：remove 未被调', probe.calls.remove.length === 0);

  check('R38 删除其他会话 → 照常走 repo', await rt.deleteSession('other.jsonl') === true && probe.calls.remove[0][0] === 'other.jsonl');

  // InMemory（无 getFilePath 可选成员）→ 守卫跳过比对、不误伤
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rtNoPath = makeRuntime({ getMessages: async () => [] } as any, probe);
  check('R39 session 无 getFilePath → 守卫跳过、照常委托', await rtNoPath.deleteSession('free.jsonl') === true);
}

// 无 repo：deleteSession 拒绝（旧 Runtime 兼容场景不提供删除能力）
{
  const rt = makeRuntime({ getMessages: async () => [] });
  check('R40 无 repo 注入 → deleteSession 返回 false', await rt.deleteSession('x.jsonl') === false);
}

/* ── ④ 源码断言 ── */
console.log('── ④ 源码断言（防回退）──');

{
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'src/runtime/runtime.ts'), 'utf8');
  check('S1 listSessions 委托 sessionRepo.list', /this\.sessionRepo\) return this\.sessionRepo\.list\(\)/.test(runtimeSrc));
  check('S2 switchSession 委托 sessionRepo.open', /this\.sessionRepo\.open\(/.test(runtimeSrc));
  check('S3 createSession 委托 sessionRepo.create', /this\.sessionRepo\.create\(/.test(runtimeSrc));
  check('S4 deleteSession 存在且走 sessionRepo.remove', /async deleteSession\(/.test(runtimeSrc) && /this\.sessionRepo\.remove\(/.test(runtimeSrc));
  check('S5 删除守卫在场（getFilePath 比对）', /getFilePath\?\.\(\)/.test(runtimeSrc));

  const storageSrc = fs.readFileSync(path.join(ROOT, 'src/session/jsonl-storage.ts'), 'utf8');
  check('S6 jsonl-storage 已无 listAll（列表逻辑单一来源在 jsonl-repo）', !/listAll/.test(storageSrc));

  const typesSrc = fs.readFileSync(path.join(ROOT, 'src/types.ts'), 'utf8');
  check('S7 RuntimeOptions.sessionRepo 指向 core/session-repo.js',
    /sessionRepo\?:\s*import\('\.\/core\/session-repo\.js'\)\.SessionRepo/.test(typesSrc));

  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/harness/main.ts'), 'utf8');
  check('S8 main.ts 装配并注入 sessionRepo', /new JsonlSessionRepo\(/.test(mainSrc) && /sessionRepo,/.test(mainSrc));

  const cmdSrc = fs.readFileSync(path.join(ROOT, 'src/commands/builtin/sessions.ts'), 'utf8');
  check('S9 /sessions 命令接了 deleteSession', /deleteSession\(/.test(cmdSrc));
  check('S10 /sessions 命令有 UI 层守卫（当前会话 disabled）', /disabled:/.test(cmdSrc));

  const repoSrc = fs.readFileSync(path.join(ROOT, 'src/session/jsonl-repo.ts'), 'utf8');
  check('S11 JsonlSessionRepo 实现 SessionRepo 契约', /implements SessionRepo/.test(repoSrc));
}

/* ── 收尾：临时目录清理 ── */
await fsPromises.rm(tmpDir, { recursive: true, force: true });

console.log(`结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
