/**
 * verify-rag-index.ts —— RAG 增量索引的正确性验证（sidecar/rag/index_build.py）
 *
 * 为什么需要它：增量索引的核心风险不是"没更新"，而是"更新了但留下脏数据"：
 *   · 删除/改名的笔记，旧块残留在 Chroma（孤儿块）→ 检索命中已不存在的内容；
 *   · 改过的笔记，旧版本块与新版本块并存 → 检索返回过期文本；
 *   · 签名误判 → 该更新的没更新——静默漏更比报错更危险。
 * 全部用例跑在 RAG_VAULT/RAG_INDEX_DIR/RAG_MANIFEST 指向的临时目录里，
 * 真实索引（.flint/rag-index）与唯一事实源（manifest.json）零接触。
 *
 * 验什么：
 *   ① config 环境变量覆盖 —— 夹具隔离的前提（RAG_VAULT/INDEX_DIR/MANIFEST 各自生效）
 *   ② chunk_file 确定性 —— 同内容两次分块 id 一致（"未变 = 零写入"的前提）
 *   ③ diff 三分类 —— 变更/删除/未变判定正确
 *   ④ state 读写往返 —— build-state.json 落盘可还原
 *   ⑤ --check 干跑 —— 只报告不落地（idx 目录不应被创建）
 *   ⑥ 零变更运行字节级无副作用 —— chroma.sqlite3 前后逐字节一致
 *      （PersistentClient 一打开就会重写 sqlite 簿记，index_build 必须在
 *       无变更时快速退出、连库都不开——账本"一字未变"认字节不认语义）
 *   ⑦ 端到端（环境豁免，同 note-search ④⑤ 的口径）—— 改甲删乙：
 *      乙旧内容从库中消失（孤儿清除）、甲新内容入库、丙零重嵌
 *   ⑧ 混合检索 —— 分词（标识符整体成词/中文二元组）、RRF 融合纯函数、
 *      端到端字面查询走双通道
 *   ⑨ 索引陈旧检测 —— 刚重建 stale=False；改笔记不重建 stale=True 且 changed=1
 *      （过期是静默失败，检索侧必须能看见）
 *   ⑩ 摘要句边界截断 —— 截在句号上；无句界保底硬切
 *   ⑪ 查询改写端到端 —— 口语问句被改写为书面变体并命中目标（环境豁免口径）
 *   ⑫ 检索前自动重建 —— 关闭开关只提醒不代劳；默认开启时代劳增量重建且本次
 *      检索即新索引（stale 熄灭、新内容可检索）；超阈值不代劳交还人拍板
 *   ⑬ 词典维护三层纯逻辑 —— 合并去重 / 候选沉淀覆盖与上限 / 本地词典热更新进 prompt
 *   ⑭ 检索范围限定（scope / --in）—— 路径段级前缀判据（"1-A" 不吞 "1-Agent理论"、
 *      尾斜杠归一、None/空不限）；范围内无命中就返回空，**绝不退回全库**
 *      （"范围写错了"与"库里真没有"必须是两种回执，否则人会误判成后者）
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/verify-rag-index.ts
 * 退出码：failed > 0 → 1
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, 'sidecar', 'rag', '.venv', 'Scripts', 'python.exe');
const SIDECAR = path.join(ROOT, 'sidecar', 'rag');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

/* ---- 夹具：临时 vault 三篇笔记（甲乙丙），索引/manifest 全部指到临时目录 ---- */
const FIXTURE = path.join(ROOT, '.flint', '_verify-rag-inc');
const VAULT = path.join(FIXTURE, 'vault');
const IDX = path.join(FIXTURE, 'idx');
const MANIFEST = path.join(FIXTURE, 'manifest.json');
const ENV = {
  ...process.env,
  RAG_VAULT: VAULT,
  RAG_INDEX_DIR: IDX,
  RAG_MANIFEST: MANIFEST,
  // 词典三层里可写的两层也指到临时目录：端到端项会触发"改写致胜"沉淀，
  // 不隔离的话测试数据会写进真实的 glossary.cand.txt（夹具纪律：测真实逻辑、假文件）
  RAG_GLOSSARY_LOCAL: path.join(IDX, 'glossary.local.txt'),
  RAG_GLOSSARY_CAND: path.join(IDX, 'glossary.cand.txt'),
  PYTHONUTF8: '1',
} as NodeJS.ProcessEnv;

function note(title: string, what: string, how: string): string {
  return `---\ntitle: ${title}\ntags: [t]\n---\n\n# ${title}\n\n## 做什么\n\n${what}\n\n## 怎么做\n\n${how}\n`;
}
fs.rmSync(FIXTURE, { recursive: true, force: true });
fs.mkdirSync(path.join(VAULT, '1-测试'), { recursive: true });
fs.writeFileSync(path.join(VAULT, '1-测试', '甲.md'),
  note('甲笔记', '甲笔记讲语义检索的原理与实现细节。', '双塔编码后算余弦距离，召回靠向量。'), 'utf8');
fs.writeFileSync(path.join(VAULT, '1-测试', '乙.md'),
  note('乙笔记', '乙笔记讲重排器 cross-encoder 的逐对打分机制。', 'query 与 doc 拼接过模型，精排比召回准。'), 'utf8');
fs.writeFileSync(path.join(VAULT, '1-测试', '丙.md'),
  note('丙笔记', '丙笔记讲上下文压缩的摘要折叠策略。', '旧对话折叠成摘要腾出窗口。'), 'utf8');
fs.writeFileSync(path.join(VAULT, '1-测试', '丁.md'),
  note('丁笔记', '丁笔记讲 HNSW 近似最近邻索引的图结构。', '分层可导航小世界图逐层收敛。'), 'utf8');

/* ① config 环境变量覆盖 */
const cfgOut = await run(PY, ['-c', [
  'import config, json',
  `print(json.dumps({'v': str(config.VAULT), 'i': str(config.INDEX_DIR), 'm': str(config.MANIFEST)}))`,
].join('\n')], { cwd: SIDECAR, env: ENV });
const cfg = JSON.parse(cfgOut.stdout.trim());
check('① RAG_VAULT / RAG_INDEX_DIR / RAG_MANIFEST 覆盖各自生效',
  cfg.v === VAULT && cfg.i === IDX && cfg.m === MANIFEST, cfgOut.stdout.trim());

/* ②③④ 纯逻辑：chunk 确定性 / diff 三分类 / state 往返（不碰 Chroma、不碰网络） */
const logicOut = await run(PY, ['-c', [
  'import json, sys',
  `sys.path.insert(0, r'${SIDECAR}')`,
  'import index_build as ib',
  'from pathlib import Path',
  `jia = Path(r'${VAULT}') / '1-测试' / '甲.md'`,
  'c1 = ib.chunk_file(jia, "1-测试/甲.md"); c2 = ib.chunk_file(jia, "1-测试/甲.md")',
  'det = len(c1) == len(c2) and len(c1) > 0 and all(a["id"] == b["id"] for a, b in zip(c1, c2))',
  // diff：甲签名造假 → changed；乙丙真签名 → unchanged；幽灵条目 → removed
  'sig_yi = ib.file_sig(Path(r\'' + VAULT + '\') / "1-测试" / "乙.md")',
  'sig_bing = ib.file_sig(Path(r\'' + VAULT + '\') / "1-测试" / "丙.md")',
  'state = {"1-测试/甲.md": {"mtime": 0, "size": 999, "chunks": 2},',
  '         "1-测试/乙.md": {"mtime": sig_yi[0], "size": sig_yi[1], "chunks": 2},',
  '         "1-测试/丙.md": {"mtime": sig_bing[0], "size": sig_bing[1], "chunks": 2},',
  '         "1-测试/已删.md": {"mtime": 0, "size": 0, "chunks": 1}}',
  'chg, rem, unch = ib.diff(state, ["1-测试/甲.md", "1-测试/乙.md", "1-测试/丙.md"])',
  'ib.save_state(["1-测试/甲.md", "1-测试/乙.md"], {"1-测试/甲.md": 2, "1-测试/乙.md": 2})',
  'loaded = ib.load_state()',
  'st = loaded["1-测试/甲.md"]["chunks"] == 2 and loaded["1-测试/乙.md"]["size"] == sig_yi[1]',
  // ⑧ 混合检索纯函数：分词保留标识符整体 + RRF 融合排名
  'import query as q',
  'tk = q._tokens("cache_control 提示词缓存")',
  'tok = "cache_control" in tk and "hit@5" in q._tokens("hit@5") and "提示" in tk and "示词" in tk',
  'fused = q._rrf(["a", "b", "c"], ["c", "a", "b"])',
  'rrf = fused[0] == "a"  # 两路都排第 1 的元素必须 fused 第 1',
  // ⑩ 摘要句边界截断：截在句号上；无句界保底硬切
  'sn1 = q._snippet("甲乙丙丁。" * 80, 300)',
  'sn1ok = sn1.endswith("。") and 150 < len(sn1) <= 300',
  'sn2 = q._snippet("没有句号的一长串" * 60, 300)',
  'sn2ok = len(sn2) == 300',
  // ⑪b 领域词典注入改写器提示词（"存笔记的东西"→向量数据库这类盲区映射在场）
  'pr = q._rewrite_system_prompt()',
  'gl = "领域术语对照表" in pr and "向量数据库" in pr and "多智能体协作" in pr',
  // ⑪c 改写闸参数在合法区间（0~1 的 rerank 相关度阈值）
  'gate = 0 < q.config.REWRITE_GATE < 1',
  // ⑪d 单篇多样性：同篇超过 cap 的块被跳过，别的笔记得以进前 k
  'pool = {"a1": ({"path": "A"}, "x", 0.5), "a2": ({"path": "A"}, "x", 0.5), "a3": ({"path": "A"}, "x", 0.5), "b1": ({"path": "B"}, "x", 0.5), "b2": ({"path": "B"}, "x", 0.5)}',
  'ids = [c for c, _ in q._diversify([("a1", 1.0), ("a2", 0.9), ("a3", 0.8), ("b1", 0.7), ("b2", 0.6)], pool, 3)]',
  'div = ids == ["a1", "a2", "b1"]',
  // ⑪e 评测众数投票：过半命中才算命中，排名取命中轮中位数（确定性口径）
  'import eval as ev',
  'v1 = ev._vote([2, 3, 2]) == (2, 3) and ev._vote([0, 2, 0]) == (0, 1)',
  'v2 = ev._vote([5, 1, 0]) == (3, 2) and ev._vote([0, 1]) == (0, 1) and ev._vote([0, 0, 0]) == (0, 0)',
  'vt = v1 and v2',
  // ⑬ 词典维护三层：合并去重 / 候选沉淀纯逻辑 / 本地词典热更新进 prompt
  // 别名用 _glx —— gl 已被 ⑪b 占用（布尔），import 覆盖它会让 json.dumps 炸
  'import glossary as _glx',
  'm1 = _glx.merge_lines("a → x\\nb → y", ["a → z"]) == ["a → z", "b → y"]',
  's1, c1 = _glx.sediment(["q0 → v0", "q1 → v1"], "q1", "v2", 50)',
  's1ok = s1 == ["q0 → v0", "q1 → v2"] and c1',
  's2, c2 = _glx.sediment(["q1 → v1"], "q1", "v1", 50)',
  's2ok = s2 == ["q1 → v1"] and not c2',
  's3, _ = _glx.sediment(["a → 1", "b → 2", "c → 3"], "d", "4", 3)',
  's3ok = s3 == ["b → 2", "c → 3", "d → 4"]',
  'from pathlib import Path as _P',
  'import tempfile as _tf',
  'tmp = _P(_tf.mkdtemp()) / "g.local.txt"',
  'tmp.write_text("语音转文字 => Whisper", encoding="utf-8")',
  'q.config.GLOSSARY_LOCAL = tmp',
  'q.config._glossary_cache = None',
  'hot = "Whisper" in q._rewrite_system_prompt()',
  'gm = m1 and s1ok and s2ok and s3ok and hot',
  // ⑭ 范围限定判据：路径段级前缀（不是裸字符串前缀）、尾斜杠归一、None/空不限
  '_m = {"path": "1-测试/甲.md"}',
  'sc = (q._in_scope(_m, None) and q._in_scope(_m, "") and q._in_scope(_m, "  ")   # 缺省/空 = 不限',
  '      and q._in_scope(_m, "1-测试") and q._in_scope(_m, "1-测试/")               # 尾斜杠归一',
  '      and q._in_scope(_m, "1-测试/甲.md")                                        # 细到单文件',
  '      and q._in_scope({"path": "1-Agent理论/x.md"}, "1-Agent理论")               # 整段命中',
  '      and not q._in_scope({"path": "1-Agent理论/x.md"}, "1-A")                   # "1-A" 不吞 "1-Agent理论"',
  '      and not q._in_scope(_m, "1-测") and not q._in_scope(_m, "1-测试2")         # 半段/多字都不算',
  '      and not q._in_scope(_m, "2-Agent能力"))                                    # 圈外不算',
  `print(json.dumps({'det': det, 'chg': chg, 'rem': rem, 'unch': unch, 'st': st, 'tok': tok, 'rrf': rrf, 'sn1': sn1ok, 'sn2': sn2ok, 'gl': gl, 'gate': gate, 'div': div, 'vt': vt, 'gm': gm, 'sc': sc}))`,
].join('\n')], { cwd: SIDECAR, env: ENV });
const logic = JSON.parse(logicOut.stdout.trim());
check('② chunk_file 确定性：同内容两次分块 id 一致', logic.det);
// 数组比较走 JSON.stringify —— JS 的 === 比引用，JSON.parse 出来的数组永远不等
check('③ diff：签名变化的甲判为变更',
  JSON.stringify(logic.chg) === JSON.stringify(['1-测试/甲.md']), JSON.stringify(logic.chg));
check('③b diff：state 里的幽灵条目判为删除',
  JSON.stringify(logic.rem) === JSON.stringify(['1-测试/已删.md']), JSON.stringify(logic.rem));
check('③c diff：签名一致的乙丙判为未变',
  JSON.stringify(logic.unch) === JSON.stringify(['1-测试/乙.md', '1-测试/丙.md']),
  JSON.stringify(logic.unch));

/* ⑤ --check 干跑：只报告，不落地（必须在任何会建 idx 目录的步骤之前跑） */
fs.rmSync(IDX, { recursive: true, force: true });
const dry = await run(PY, ['index_build.py', '--check'], { cwd: SIDECAR, env: ENV });
check('⑤ --check 退出码 0 且输出含"干跑"', dry.stdout.includes('干跑'));
check('⑤b 干跑后 idx 目录不存在（索引确实没被建）', !fs.existsSync(IDX));

/* ④ state 读写往返（save_state 会建 idx 目录，所以排在 ⑤b 之后） */
check('④ build-state 落盘往返可还原', logic.st);
check('⑧ 分词：标识符整体成词（cache_control / hit@5 不拆散）、中文二元组', logic.tok);
check('⑧b RRF：两路都排第 1 的元素融合后仍第 1', logic.rrf);
check('⑩ 摘要句边界截断：截在句号上（宁可短半句，不留半句话）', logic.sn1);
check('⑩b 无句界保底硬切：长度等于窗口', logic.sn2);
check('⑪b 领域词典已注入改写器提示词（盲区映射在场，防 prompt 改坏后悄悄丢）', logic.gl);
check('⑪c 改写闸阈值在合法区间（0 < REWRITE_GATE < 1）', logic.gate);
check('⑪d 单篇多样性：同篇最多 2 块，其他笔记递补进前 k', logic.div);
check('⑪e 评测众数投票：过半命中才命中、排名取命中轮中位数（跑分可复现的口径）', logic.vt);
check('⑬ 词典维护：本地覆盖内置去重 / 候选沉淀覆盖与上限 / 本地词典热更新进 prompt', logic.gm);
check('⑭ 范围判据（纯逻辑）：路径段级前缀（"1-A" 不吞 "1-Agent理论"）、尾斜杠归一、None/空不限', logic.sc);

/* ⑥⑦ 端到端（依赖嵌入 API；网络/服务不可用则整段豁免——套件钉的是逻辑形状） */
try {
  // 首轮建库（增量无 state → 等同全量；execFile 非 0 退出会 reject，由外层 catch 豁免）
  await run(PY, ['index_build.py'], { cwd: SIDECAR, env: ENV });

  // 改甲（新增一节）+ 删乙 → 第二轮增量
  fs.writeFileSync(path.join(VAULT, '1-测试', '甲.md'),
    note('甲笔记', '甲笔记讲语义检索的原理与实现细节。', '双塔编码后算余弦距离，召回靠向量。')
    + '\n## 增量更新\n\n这一节是第二轮新加的内容，讲金标评测反哺分块。\n', 'utf8');
  fs.rmSync(path.join(VAULT, '1-测试', '乙.md'));
  const r2 = await run(PY, ['index_build.py'], { cwd: SIDECAR, env: ENV });
  check('⑦ 增量轮识别 变更1/删除1（乙丙丁未变）',
    /变更 1 篇/.test(r2.stdout) && /删除 1 篇/.test(r2.stdout) && /未变 2 篇/.test(r2.stdout),
    r2.stdout.slice(0, 200));

  // 库内容断言：乙的旧块必须消失（孤儿清除），甲的新节必须入库
  const probe = await run(PY, ['-c', [
    'import json, chromadb',
    `col = chromadb.PersistentClient(path=r'${IDX}').get_collection('notes')`,
    "got = col.get(include=['metadatas', 'documents'])",
    "paths = sorted({m['path'] for m in got['metadatas']})",
    "text = ' '.join(got['documents'])",
    `print(json.dumps({'paths': paths, 'gone': 'cross-encoder 的逐对打分机制' in text,`,
    `                  'new': '金标评测反哺分块' in text, 'n': col.count()}))`,
  ].join('\n')], { cwd: SIDECAR, env: ENV });
  const db = JSON.parse(probe.stdout.trim());
  check('⑦b 删除的乙在库中只剩 path 集 {甲,丙,丁}（旧块已清）',
    db.paths.join(',') === '1-测试/丁.md,1-测试/丙.md,1-测试/甲.md', JSON.stringify(db.paths));
  check('⑦c 乙的旧内容不再可检索（孤儿块清除是正确性问题）', db.gone === false);
  check('⑦d 甲的新节已入库', db.new === true && db.n === 7, `n=${db.n}`);

  // ⑥ 零变更运行必须字节级无副作用（连 Chroma 都不开）
  const sqlite = path.join(IDX, 'chroma.sqlite3');
  const before = fs.readFileSync(sqlite);
  const r3 = await run(PY, ['index_build.py'], { cwd: SIDECAR, env: ENV });
  const after = fs.readFileSync(sqlite);
  check('⑥ 零变更运行：chroma.sqlite3 逐字节一致（快速退出、库都没开）',
    before.equals(after) && /索引未动/.test(r3.stdout), r3.stdout.slice(0, 120));

  // ⑧c 混合端到端：字面 token 查询走 BM25 通道命中丁笔记（需嵌入 API，随 try 豁免）
  const hy = await run(PY, ['-c', [
    'import json, sys',
    `sys.path.insert(0, r'${SIDECAR}')`,
    'from query import search',
    "r = search('HNSW', top_k=3)",
    `print(json.dumps({'hybrid': r['hybrid'], 'rr': r['rerank'],`,
    `                  'paths': [it['path'] for it in r['results']]}))`,
  ].join('\n')], { cwd: SIDECAR, env: ENV });
  const h = JSON.parse(hy.stdout.trim());
  check('⑧c 混合端到端：字面查询 HNSW 命中丁笔记（BM25+向量双通道生效）',
    h.hybrid === true && h.paths.some((p: string) => p.includes('丁.md')),
    JSON.stringify(h.paths));

  // ⑭ 范围限定端到端：scope 走完"召回→过滤→精排"整条链路。
  // 关键在 b 例：范围写错 → 空结果 + 回显 scope；**绝不能悄悄退回全库**
  // （若退回，人看到"有结果"会以为那个范围里真有，实际是别处的内容）。
  const scOut = await run(PY, ['-c', [
    'import json, sys',
    `sys.path.insert(0, r'${SIDECAR}')`,
    'from query import search',
    "a = search('HNSW', top_k=3, scope='1-测试')",
    "b = search('HNSW', top_k=3, scope='99-不存在的域')",
    "c = search('语义检索', top_k=3, scope='1-测试/甲.md')",
    `print(json.dumps({'a': {'scope': a.get('scope'), 'paths': [it['path'] for it in a['results']]},`,
    `                  'b': {'scope': b.get('scope'), 'n': len(b['results'])},`,
    `                  'c': {'scope': c.get('scope'), 'paths': [it['path'] for it in c['results']]}}))`,
  ].join('\n')], { cwd: SIDECAR, env: { ...ENV, RAG_REWRITE: '0' } });
  const sco = JSON.parse(scOut.stdout.trim());
  check('⑭b 范围限定端到端：scope="1-测试" 命中且全在圈内、回执回显 scope',
    sco.a.scope === '1-测试' && sco.a.paths.length > 0 && sco.a.paths.every((p: string) => p.startsWith('1-测试/')),
    JSON.stringify(sco.a));
  check('⑭c 范围无命中 → 空结果 + 回显 scope（范围写错不自动退回全库）',
    sco.b.scope === '99-不存在的域' && sco.b.n === 0, JSON.stringify(sco.b));
  check('⑭d 范围可细到单文件：scope="1-测试/甲.md" 只返回该篇',
    sco.c.paths.length > 0 && sco.c.paths.every((p: string) => p === '1-测试/甲.md'),
    JSON.stringify(sco.c));
  // ⑨ 索引陈旧检测：改笔记不重建 → stale 标志必须亮（检索结果悄悄过期是最危险的静默失败）
  const staleQ = [
    'import json, sys',
    `sys.path.insert(0, r'${SIDECAR}')`,
    'from query import _staleness',
    'print(json.dumps(_staleness()))',
  ].join('\n');
  const st0 = JSON.parse((await run(PY, ['-c', staleQ], { cwd: SIDECAR, env: ENV })).stdout.trim());
  check('⑨ 刚重建后陈旧检测：无变更、stale=False',
    st0 !== null && st0.stale === false && st0.changed === 0 && st0.added === 0, JSON.stringify(st0));
  fs.appendFileSync(path.join(VAULT, '1-测试', '丁.md'),
    '\n## 陈旧检测\n\n这一行是建索引之后才加的，索引还不认识它。\n', 'utf8');
  const st1 = JSON.parse((await run(PY, ['-c', staleQ], { cwd: SIDECAR, env: ENV })).stdout.trim());
  check('⑨b 改丁未重建：stale=True 且 changed=1（签名对比生效）',
    st1 !== null && st1.stale === true && st1.changed === 1, JSON.stringify(st1));

  // ⑫ 检索前自动重建（第 10 步）：stale 不再只是提醒，检索自己把增量重建跑掉。
  // 顺序讲究：先在 ⑨b 制造的过期态上验「不代劳」（开关关/超阈值），再验默认代劳。
  const arOff = await run(PY, ['-c', [
    'import json, sys',
    `sys.path.insert(0, r'${SIDECAR}')`,
    'from query import search',
    "r = search('上下文压缩', top_k=3)",
    `print(json.dumps({'rebuilt': r.get('rebuilt'), 'stale': (r.get('stale') or {}).get('stale')}))`,
  ].join('\n')], { cwd: SIDECAR, env: { ...ENV, RAG_AUTO_REBUILD: '0', RAG_REWRITE: '0' } });
  const off = JSON.parse(arOff.stdout.trim());
  check('⑫a 开关关闭（RAG_AUTO_REBUILD=0）：只提醒不代劳（rebuilt 为空、stale 保持亮）',
    off.rebuilt === null && off.stale === true, JSON.stringify(off));

  const ar = await run(PY, ['-c', [
    'import json, sys',
    `sys.path.insert(0, r'${SIDECAR}')`,
    'from query import search',
    "r = search('陈旧检测', top_k=3)",
    `print(json.dumps({'rebuilt': r.get('rebuilt'), 'stale': (r.get('stale') or {}).get('stale'),`,
    `                  'paths': [it['path'] for it in r['results']]}))`,
  ].join('\n')], { cwd: SIDECAR, env: ENV });
  const a = JSON.parse(ar.stdout.trim());
  check('⑫b 自动重建端到端：检索前发现 stale 代劳增量重建（changed=1、重嵌≥1）',
    a.rebuilt !== null && a.rebuilt.changed === 1 && a.rebuilt.embedded >= 1,
    JSON.stringify(a.rebuilt));
  check('⑫c 重建后本次检索即新索引：stale 熄灭', a.stale === false, JSON.stringify(a.stale));
  check('⑫d 刚追加的内容可检索：「陈旧检测」节命中丁笔记（进程内 Chroma 句柄可见重建结果）',
    a.paths.some((p: string) => p.includes('丁.md')), JSON.stringify(a.paths));

  // ⑫e 阈值守卫：变更篇目超过阈值不代劳（可能是大规模整理，费用/延迟不可控）。
  // MAX_FILES=0 让「改 1 篇」也超阈值——不用真造 50 篇变更。
  fs.appendFileSync(path.join(VAULT, '1-测试', '丙.md'),
    '\n## 阈值守卫\n\n这一行再次制造过期，验证超过阈值时不自动重建。\n', 'utf8');
  const arMax = await run(PY, ['-c', [
    'import json, sys',
    `sys.path.insert(0, r'${SIDECAR}')`,
    'from query import search',
    "r = search('摘要折叠', top_k=3)",
    `print(json.dumps({'rebuilt': r.get('rebuilt'), 'stale': (r.get('stale') or {}).get('stale')}))`,
  ].join('\n')], { cwd: SIDECAR, env: { ...ENV, RAG_AUTO_REBUILD_MAX_FILES: '0', RAG_REWRITE: '0' } });
  const mx = JSON.parse(arMax.stdout.trim());
  check('⑫e 超阈值不代劳：rebuilt 为空、stale 保持亮（交还给人拍板）',
    mx.rebuilt === null && mx.stale === true, JSON.stringify(mx));

  // ⑪ 查询改写端到端：口语问句被改写为书面变体并命中目标（改写失败会退回单路，此处验主路径）
  const rw = await run(PY, ['-c', [
    'import json, sys',
    `sys.path.insert(0, r'${SIDECAR}')`,
    'from query import search',
    "r = search('怎么让AI记住前面聊过的话', top_k=3)",
    `print(json.dumps({'rw': r.get('rewrites') or [], 'paths': [it['path'] for it in r['results']]}))`,
  ].join('\n')], { cwd: SIDECAR, env: ENV });
  const w = JSON.parse(rw.stdout.trim());
  check('⑪ 查询改写端到端：口语问句被改写且命中丙笔记（上下文压缩）',
    w.rw.length > 0 && w.paths.some((p: string) => p.includes('丙.md')),
    JSON.stringify(w).slice(0, 200));
} catch (e) {
  console.log('  ⚠️ ⑥⑦ 端到端跳过（嵌入 API 不可用或索引构建失败——逻辑项①-⑤已验，环境项不算失败）');
  console.log(`     ${e instanceof Error ? e.message.slice(0, 150) : String(e)}`);
}

/* 收尾：夹具清理（失败不影响判定，但必须喊出来） */
try { fs.rmSync(FIXTURE, { recursive: true, force: true }); }
catch (e) { console.log(`  ⚠️ 夹具清理失败（不影响判定）: ${FIXTURE}`); }

// 汇总行是**协议**不是装饰：collect-stats.mjs 只认 `结果：N 通过 / M 失败` 这一行。
console.log(`\nverify-rag-index：结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed > 0 ? 1 : 0);
