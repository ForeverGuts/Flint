"""查询入口 —— 两种模式，同一个 search() 核心：

- CLI 手测：  python query.py "上下文压缩怎么做" [-k 5]
- flint 接入：python query.py --serve   （stdin 逐行收 JSON-RPC，逐行回）

JSON-RPC 形状是给 v2 MCP 化预留的：请求 {"method":"search","params":{...},"id":1}
响应 {"id":1,"result":{...}} —— 到时只套 stdio 信封，search 核心一行不改。
"""
import json
import math
import re
import sys
import time
import urllib.request

import chromadb
from openai import OpenAI

import config

# Windows 上 stdout/stderr 默认跟随系统 ANSI 代码页（简中 = GBK），编不了笔记里的
# emoji（🟡 = U+1F7E1 等），print 当场抛 UnicodeEncodeError。三条流显式钉死 UTF-8；
# flint 侧 spawn 时还传了 PYTHONUTF8=1，这里是手测 CLI 直跑时的双保险。
# reconfigure 只在 TextIOWrapper 上存在（stdin 被关/重定向成二进制的极端场合会抛），
# 包一层 try：编码修不了也不能挡检索。
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

_client = chromadb.PersistentClient(path=str(config.INDEX_DIR))
_col = _client.get_or_create_collection("notes", metadata={"hnsw:space": "cosine"})


def _embed(query: str) -> list[float]:
    cli = OpenAI(api_key=config.API_KEY, base_url=config.BASE_URL)
    return cli.embeddings.create(model=config.EMBED_MODEL,
                                 input=[query]).data[0].embedding


def _rewrite_system_prompt() -> str:
    """改写器系统提示词（独立成函数：词典注入可被 verify 纯逻辑断言）。

    领域词典（config.load_glossary() = 内置 + 本地合并）补的是"项目黑话"——
    "存笔记的东西"这类映射依赖"这个库讲什么"，通用大模型猜不到（金标实测的
    2 问盲区）。本地词典走热更新：glossary.py 改完文件，下次检索就是新词表。
    """
    glossary = config.load_glossary()
    base = ("你是技术知识库的检索查询改写器。把用户的口语化问题改写成 "
            f"{config.REWRITE_MAX} 个书面检索查询：第 1 个忠实原意书面化"
            "（补全术语、去掉语气词）；其余的猜测它在 LLM/编程领域的"
            "专业术语说法（例：\"打字机效果\"→\"流式输出\"，"
            "\"少花点钱\"→\"降低 API 调用成本/缓存命中\"）。"
            "每行一个，不要编号，不要解释，不要回答问题本身。")
    if glossary:
        # 措辞是承重的（2026-10-06 实测返工）：写成"优先采用"时，改写器会把
        # 词典生搬硬套到不相关的问题上——"MCP 服务器端怎么开发"被套上
        # "多智能体协作/ACP"变体，正主笔记在精排被挤出前 5。必须显式说
        # "命中才用、不符禁套"。
        base += ("\n\n领域术语对照表（口语俗称 → 本知识库的书面术语）。"
                 "使用纪律：仅当用户的问法确实是口语俗称、且命中表中某行时才采用；"
                 "原问题本身已是书面术语、或主题与表不符时，禁止套用表中词条：\n"
                 f"{glossary.strip()}")
    return base


def _rewrite(query: str) -> list[str]:
    """LLM 把口语问句改写成检索友好的书面变体，返回至多 REWRITE_MAX 条。

    为什么需要（2026-10-06 实测）：口语化问法对金标 8 问只中 3——口语
    （"怎么让大模型少花点钱"）与笔记书面语（"KV 缓存复用/命中率"）之间存在
    词面鸿沟，混合检索的字面/语义两头都够不着。改写器补的就是这一半；
    领域词典再补最后一半（项目黑话，通用模型猜不到的映射）。
    任何失败（超时/网络/输出不合规）返回 []，调用方退回原查询单路——
    改写是锦上添花，不能让它成为新的单点故障。
    """
    try:
        cli = OpenAI(api_key=config.API_KEY, base_url=config.BASE_URL)
        resp = cli.chat.completions.create(
            model=config.REWRITE_MODEL,
            messages=[
                {"role": "system", "content": _rewrite_system_prompt()},
                {"role": "user", "content": query},
            ],
            temperature=0.2, max_tokens=200, timeout=config.REWRITE_TIMEOUT,
            seed=config.REWRITE_SEED)
        out = []
        for line in resp.choices[0].message.content.splitlines():
            line = line.strip().lstrip("0123456789.、) -")
            if line and len(line) <= 80 and line != query:
                out.append(line)
        return out[:config.REWRITE_MAX]
    except Exception as e:  # 降级不静默：stderr 留痕
        print(f"[rewrite] 改写失败，退回原查询单路: {e}", file=sys.stderr)
        return []


# ---- 摘要句边界截断 ----
_SENT_END = "。！？；…!?;\n"
def _snippet(doc: str, limit: int = 300) -> str:
    """按句边界截断：宁可短半句，不留半句话。

    硬切 300 字的旧做法会把摘要停在句中，模型引用时容易把半句话当原文。
    句界落在窗口后半段才采用（避免截出过短摘要），否则保底硬切。
    """
    if len(doc) <= limit:
        return doc
    window = doc[:limit]
    best = max(window.rfind(c) for c in _SENT_END)
    return window[:best + 1] if best >= limit // 2 else window


def _rerank(query: str, docs: list[str], top_n: int) -> list[tuple[int, float]]:
    """cross-encoder 精排：query+doc 拼一起逐对打分，返回 [(原下标, 相关度)] 按分降序。

    用标准库 urllib（零依赖）——openai SDK 没有 rerank 端点，也不值得为一个
    POST 引 requests。失败由调用方降级，这里不吞错（把原始异常抛出去才有得诊断）。
    """
    req = urllib.request.Request(
        config.BASE_URL + "/rerank",
        data=json.dumps({"model": config.RERANK_MODEL, "query": query,
                         "documents": docs, "top_n": top_n}).encode("utf-8"),
        headers={"Authorization": f"Bearer {config.API_KEY}",
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=config.RERANK_TIMEOUT) as resp:
        body = json.loads(resp.read())
    # 响应形状（2026-10-06 实测）：{"results": [{"index": 0, "relevance_score": 0.9, ...}]}
    return [(r["index"], float(r["relevance_score"])) for r in body["results"]]


# ---- 混合检索：BM25 关键词通道（字面匹配）----
# 为什么需要：双塔向量只认"意思相近"，不认"字面相同"——2026-10-06 实测，
# hit@5 / HNSW / TTL 这类精确标识符查询 3/5 脱靶（标准答案进不了前 5）。
# BM25 倒排打分补的正是字面那一半：标识符整体成词、中文按二元组切（免 jieba 依赖）。
_TOKEN_ASCII = re.compile(r"[a-z0-9_@.\-]+")
_TOKEN_ZH = re.compile(r"[\u4e00-\u9fff]+")

def _tokens(text: str) -> list[str]:
    """ASCII 词元整体保留（cache_control / json.dumps / hit@5 不拆散），
    中文按二元组切（"提示词" → 提示/示词；单字保留）——免 jieba 依赖。"""
    text = text.lower()
    toks = _TOKEN_ASCII.findall(text)
    for seg in _TOKEN_ZH.findall(text):
        if len(seg) == 1:
            toks.append(seg)
        else:
            toks.extend(seg[i:i + 2] for i in range(len(seg) - 1))
    return toks


# BM25 索引：从 Chroma 全量文档惰性构建、常驻内存（2957 块 ≈ 几 MB，构建 1-2s）。
# 以 (库内条数) 为版本号：增量重建后条数变了自动重建，长驻 MCP server 不需要重启。
_bm25_cache: tuple | None = None

def _bm25_index() -> tuple:
    global _bm25_cache
    n = _col.count()
    if _bm25_cache and _bm25_cache[0] == n:
        return _bm25_cache
    got = _col.get(include=["documents", "metadatas"])
    ids, docs, metas = got["ids"], got["documents"], got["metadatas"]
    tf_list, df, dl = [], {}, []
    for doc in docs:
        toks = _tokens(doc)
        tf: dict[str, int] = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        for t in tf:
            df[t] = df.get(t, 0) + 1
        tf_list.append(tf)
        dl.append(len(toks))
    N = max(len(docs), 1)
    avgdl = sum(dl) / N
    # BM25 的 IDF（论文原式，+1 防负值）
    idf = {t: math.log(1 + (N - d + 0.5) / (d + 0.5)) for t, d in df.items()}
    _bm25_cache = (n, tf_list, idf, avgdl, dl, ids)
    return _bm25_cache


def _bm25_search(query: str, k: int) -> list[str]:
    """返回按 BM25 分降序的 chunk id 列表（截断到 k，零分剔除）。"""
    n, tf_list, idf, avgdl, dl, ids = _bm25_index()
    if n == 0 or k <= 0:
        return []
    k1, b = config.BM25_K1, config.BM25_B
    qtoks = _tokens(query)
    scored = []
    for i in range(n):
        tf = tf_list[i]
        s = 0.0
        for t in qtoks:
            f = tf.get(t)
            if f:
                s += idf.get(t, 0.0) * f * (k1 + 1) / (
                    f + k1 * (1 - b + b * dl[i] / avgdl))
        if s > 0:
            scored.append((i, s))
    scored.sort(key=lambda x: -x[1])
    return [ids[i] for i, _ in scored[:k]]


def _rrf(*ranked_lists: list[str], k: int = config.RRF_K,
         weights: list[float] | None = None) -> list[str]:
    """Reciprocal Rank Fusion：score(d) = Σ w_i/(K + rank_i(d))，K 取论文默认 60。
    融合的是**排名**不是分数——两路分数量纲不同（余弦 vs BM25），直接加权会一边倒。"""
    ws = weights if weights is not None else [1.0] * len(ranked_lists)
    agg: dict[str, float] = {}
    for w, lst in zip(ws, ranked_lists):
        for rank, cid in enumerate(lst, 1):
            agg[cid] = agg.get(cid, 0.0) + w / (k + rank)
    return sorted(agg, key=lambda c: -agg[c])



def _in_scope(meta: dict, scope: str | None) -> bool:
    """范围限定判据：scope 是**路径前缀**（如 "11-实践案例"、"2-Agent能力/提示词缓存.md"）。

    为什么是前缀匹配而不是 Chroma 的 where：Chroma 只支持等值 / $in 过滤，没有前缀语义
    （`category` 元数据只覆盖一级目录，再深一层就表达不了）。判据只此一处，**向量与 BM25
    两条通道共用同一个口径** —— "范围"只有一个定义，不会两条通道各筛各的。

    两处刻意的选择：
    - 尾部斜杠先剥掉再拼："11-实践案例" 与 "11-实践案例/" 必须给出相同结果；
    - 匹配是"路径段"级的（`s + "/"`），所以 "1-A" 不会误吞 "1-Agent理论"。
    None / 空串 = 不限（缺省行为与加本参数之前逐位一致）。
    """
    if not scope:
        return True
    s = scope.strip().strip("/")
    if not s:
        return True
    p = meta.get("path", "")
    return p == s or p.startswith(s + "/")


def search(query: str, top_k: int = config.DEFAULT_TOP_K,
           rerank: bool = True, scope: str | None = None) -> dict:
    """混合检索：查询改写 + 向量/BM25 双通道召回（RRF 融合）→ reranker 精排。

    - 检索前自动重建：发现索引过期（stale）就先跑一次增量重建再搜——
      "提醒重建"升级为"代劳重建"（开关/阈值/节流/失败降级见 _maybe_rebuild）。
      回执 rebuilt 字段非空即表示本次结果基于刚重建的新索引。
    - 查询改写：口语问句先由小模型改写成书面变体（补术语、去语气词），
      原查询 + 变体各跑一遍双通道召回，全部排名进同一个 RRF 融合池——
      改写只影响"找什么"，最终排序仍由融合与精排决定。改写失败退回单路。
    - 混合召回：向量（语义）+ BM25（字面）双通道各取 RECALL_K 条，RRF 融合排名。
      任一通道命中都进候选池——BM25 独有的命中块补算余弦，回执字段形状不因来源变化。
    - 精排：主查询先行——原问句先给主干候选打分，top1 分数 ≥ REWRITE_GATE
      （原问句已稳稳命中）时变体不参与精排；分数弱才对 head+tail 做
      max-over-queries 多查询融合（每个候选取各查询分的最大值）。
      任何失败（超时/网络/额度）都**降级为融合序**，不让检索整体死掉：
      粗排结果是可用的保底，精排只是锦上添花。
    - 范围限定（scope，2026-10-07 加）：只在该**路径前缀**内检索，向量与 BM25 共用同一个
      判据。**"缩窄范围"不等于"放宽检索"** —— 范围内没命中就返回空结果，绝不自动退回全
      库：调用方问的是"在我指定的这个域里有没有"，不是"随便哪里曾经有过"。
    - score 的口径随阶段变化：重排生效 = reranker 相关度（0~1，>0.5 强相关）；
      降级 = 1 − 余弦距离。每条同时带 cosine 字段保住召回侧的可解释性。
    """
    rebuilt = _maybe_rebuild()
    variants = [query]
    if config.REWRITE and config.API_KEY:
        variants += [q for q in _rewrite(query) if q not in variants][:config.REWRITE_MAX]
    rewrites_used = variants[1:]

    # ── 原查询：双路召回 + 融合（主干——行为与关闭改写时完全一致）──
    # 带上范围限定就放大召回条数再筛（两路都没有前缀过滤的原生支持），否则范围内靠后的
    # 好块会因为"排在第 20 名之外"而根本进不了候选池 —— 那是假空结果，比不筛更坏。
    recall_k = config.SCOPE_RECALL_K if scope else config.RECALL_K
    n = min(recall_k, _col.count())
    pool: dict[str, tuple[dict, str, float | None]] = {}
    hybrid_used = False

    def _recall(qv: str) -> tuple[list[str], list[str] | None]:
        """单查询双路召回，返回 (向量序, BM25 序或 None)；新块顺带写入 pool。"""
        vec = _embed(qv)
        res = _col.query(query_embeddings=[vec], n_results=n,
                         include=["metadatas", "documents", "distances"])
        # chroma 返回形状：ids/metadata/documents/distances 四条并行列表（每条 n 条）
        vrank: list[str] = []
        for cid, meta, doc, dist in zip(res["ids"][0], res["metadatas"][0],
                                        res["documents"][0], res["distances"][0]):
            if not _in_scope(meta, scope):   # 范围限定：出圈的块连池子都不进
                continue
            if cid not in pool:
                pool[cid] = (meta, doc, 1 - dist)
            vrank.append(cid)
        brank: list[str] | None = None
        # 判据不含 vrank：带范围时向量侧可能整片出圈（vrank 空）而 BM25 侧仍有范围内命中，
        # 用 vrank 当闸会把这条通道白关掉。
        if config.HYBRID:   # BM25 通道（RAG_HYBRID=0 可关，评测 A/B 用）
            brank = _bm25_search(qv, k=n)
            if brank:
                missing = [c for c in brank if c not in pool]
                if missing:
                    got = _col.get(ids=missing, include=["embeddings", "metadatas", "documents"])
                    for cid, meta, doc, emb in zip(got["ids"], got["metadatas"],
                                                   got["documents"], got["embeddings"]):
                        pool[cid] = (meta, doc, _cosine(vec, emb))
                # BM25 侧同样过范围判据 —— 拿到 meta 之后才筛，与向量侧同一个函数
                brank = [c for c in brank if _in_scope(pool[c][0], scope)]
        return vrank, brank

    v0, b0 = _recall(variants[0])
    hybrid_used = b0 is not None
    primary_lists = [v0] + ([b0] if b0 else [])
    cand_order = _rrf(*primary_lists) if primary_lists else []
    primary_set = set(cand_order)

    # ── 变体：只补充、不稀释 ──
    # multi-query 融合的经典陷阱（2026-10-06 实测两轮才定位）：变体多路命中的
    # "平庸块"在 RRF 里累分，会反超原查询单路命中的"精准块"——"大模型流式输出"
    # 一问，原查询直接命中的笔记被 3 个变体拉进来的 SSE/生成器块挤出候选池，
    # 原查询加权 1.6 也压不住（两路 1.0+1.0 ≈ 单路 1.6，数学上就是打平）。
    # 所以改：主干 = 原查询自己的融合序（与关闭改写时逐位一致），变体独有的
    # 新块按变体间 RRF 序**追加在主干之后**——变体负责"找回原查询够不着的块"，
    # 不能反过来把原查询的命中挤出去。
    if len(variants) > 1:
        vlists: list[list[str]] = []
        for q in variants[1:]:
            v, b = _recall(q)
            if b is not None:
                hybrid_used = True
            if v:
                vlists.append(v)
            if b:
                vlists.append(b)
        extra = _rrf(*vlists) if vlists else []
        cand_order = cand_order + [c for c in extra if c not in primary_set]

    used_rerank = False
    if rerank and config.API_KEY and cand_order:
        try:
            # 候选截断：主干前 RERANK_POOL 条 + 变体新块前 RERANK_POOL 条。
            # 无改写时 tail 为空，行为与纯主干完全一致；有改写时新块才有机会进精排
            # （否则追加序被主干挤满，变体找回来的块到不了 reranker 手里）。
            head = cand_order[:config.RERANK_POOL]
            tail = [c for c in cand_order[config.RERANK_POOL:]
                    if c not in primary_set][:config.RERANK_POOL]
            # 主查询先行 + 改写闸：原问句先给主干候选打分。top1 分数 ≥
            # REWRITE_GATE = 原问句自己已经稳稳命中，变体不参与精排——
            # 否则变体（尤其词典注入后）会把跑偏主题的块在 max 融合下
            # 抬进前 5（"MCP 服务器端"被拽向 ACP 是实测案例）。分数弱才
            # 走多查询融合，让变体捞回原问句够不着的块。
            docs_head = [pool[c][1] for c in head]
            p_order = _rerank(query, docs_head, top_n=min(top_k, len(head)))
            gate_open = (len(variants) > 1
                         and max(s for _, s in p_order) < config.REWRITE_GATE)
            if gate_open:
                pool_n = head + tail
                docs = [pool[c][1] for c in pool_n]
                # 多查询精排（max-over-queries）：每个候选取各查询 rerank 分的最大值。
                # 为什么不能只按原查询打分——改写召回的好结果会被原查询的
                # cross-encoder 惩罚（2026-10-06 实测："几个AI怎么组队干活"
                # 融合序第 1，单查询精排直接挤出前 5）。
                scores: dict[int, float] = {}
                win_q: dict[int, str] = {}     # 该候选的胜出查询（用于词典沉淀取证）
                for q2 in variants:
                    for idx, s in _rerank(q2, docs, top_n=len(pool_n)):
                        if s > scores.get(idx, float("-inf")):
                            scores[idx] = s
                            win_q[idx] = q2
                order = sorted(scores.items(), key=lambda kv: -kv[1])[:top_k]
                order = [(pool_n[i], s) for i, s in order]
                # 词典候选沉淀（第 13 步）：改写闸开着 = 原问句自己命中弱；
                # top1 强相关且由变体捞回 = 一次实证的"换词成功"，记入候选池。
                # 只记证据不进 prompt——提升进正式词典必须人审（glossary.py promote）。
                top_idx = max(scores, key=lambda i: scores[i])
                _maybe_sediment(query, win_q.get(top_idx, ""), scores[top_idx])
            else:
                order = [(head[i], s) for i, s in p_order]
            used_rerank = True
        except Exception as e:  # 降级不是静默的：stderr 留痕，诊断有据可查
            print(f"[rerank] 精排失败，降级为融合序: {e}", file=sys.stderr)
    if not used_rerank:
        order = [(c, pool[c][2]) for c in cand_order]   # 降级序：RRF 排名，分显示余弦

    items = []
    for cid, score in _diversify(order, pool, top_k):
        meta, doc, cosine = pool[cid]
        items.append({
            "path": meta["path"], "title": meta["title"], "heading": meta["heading"],
            "score": round(score, 4) if score is not None else None,
            "cosine": round(cosine, 4) if cosine is not None else None,
            "snippet": _snippet(doc),
        })
        if len(items) >= top_k:
            break
    return {"query": query, "scope": scope, "total_indexed": _col.count(),
            "rerank": used_rerank, "hybrid": hybrid_used,
            "rewrites": rewrites_used, "rebuilt": rebuilt,
            "stale": _staleness(), "results": items}


def _maybe_sediment(query: str, winner: str, score: float) -> None:
    """改写致胜对 → 候选池（glossary.cand.txt），失败绝不影响检索。

    "检索失败 + 用户换词成功"的自动化形态：原问句过不了改写闸（自己命中弱），
    最终强相关结果（≥ GLOSSARY_HIT_MIN）由某个变体捞回——(原问句 → 胜出变体)
    就是实证。但**只记证据**：变体措辞是模型泛化出来的，未必配当词条，
    自动进 prompt 等于把脏词条注入每次检索——提升必须人审（glossary.py promote）。
    """
    if not winner or winner == query or score < config.GLOSSARY_HIT_MIN:
        return
    try:
        import glossary
        glossary.add_candidate(query, winner)
    except Exception as e:
        print(f"[glossary] 候选沉淀失败（不影响检索）: {e}", file=sys.stderr)


def _diversify(order: list[tuple[str, float]], pool: dict, top_k: int,
               cap: int = config.MAX_PER_NOTE) -> list[tuple[str, float]]:
    """单篇多样性：每篇笔记最多保留 cap 块（config.MAX_PER_NOTE）。

    「查笔记」要的是命中的**笔记清单**，不是同一篇的 5 个段落——实测案例：
    "AI记性不好怎么办"有两簇都相关的答案（知识笔记 vs 实践案例日志），
    高分簇的 4-5 个块把另一簇整簇挤出前 5。多样性上限让两簇都能露面。
    """
    seen: dict[str, int] = {}
    out: list[tuple[str, float]] = []
    for cid, score in order:
        path = pool[cid][0]["path"]
        if seen.get(path, 0) >= cap:
            continue
        seen[path] = seen.get(path, 0) + 1
        out.append((cid, score))
        if len(out) >= top_k:
            break
    return out


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


# ---- 索引陈旧检测 ----
# 为什么需要：增量索引只在你主动跑 index_build.py 时更新——笔记改了但没重建，
# 检索结果就悄悄过期（搜到旧版本、新笔记搜不到）。过期本身不报错，最危险；
# 所以每次检索顺带对比 build-state 签名与 vault 现状，把"可能过期"当数据回报。
# 成本：278 个 stat 调用（毫秒级），对比嵌入 API 的秒级耗时可忽略。
def _staleness() -> dict | None:
    """对比 build-state 与 vault 现状 → {stale, changed, removed, added}。

    state 缺失（从未建过索引）返回 None——没有基线就没法说"过期"，别添乱。
    added 的口径：manifest 里有、state 里没有的篇目（corpus.py 没重跑时
    新笔记两者都没有，属于已知盲区，检出不了——如实记录）。
    """
    if not config.BUILD_STATE.exists():
        return None
    try:
        state = json.loads(config.BUILD_STATE.read_text("utf-8")).get("files", {})
    except (OSError, ValueError):
        return None
    changed = removed = 0
    for rel, rec in state.items():
        p = config.VAULT / rel
        if not p.exists():
            removed += 1
            continue
        st = p.stat()
        same = (abs(st.st_mtime - rec.get("mtime", 0)) < 1e-6
                and st.st_size == rec.get("size"))
        if not same:
            changed += 1
    try:
        manifest = json.loads(config.MANIFEST.read_text("utf-8")).get("files", [])
    except (OSError, ValueError):
        manifest = []
    added = sum(1 for rel in manifest if rel not in state)
    return {"stale": bool(changed or removed or added),
            "changed": changed, "removed": removed, "added": added}


# ---- 检索前自动重建（第 10 步）----
# 第 8 步只把"过期"当数据回报，重建仍靠人跑 index_build.py —— 实际使用中提醒
# 常被无视，下一次检索继续拿旧结果。这一步把提醒升级为代劳：检索前发现 stale
# 就顺手跑增量重建（秒级、只重嵌变更块），搜到的永远是新索引。
# 为什么写INDEX_DIR不需要过 flint 的写闸：写闸管的是"Agent 写用户文件"；
# 重建只写笔记库之外的派生缓存，vault 全程只读——性质与浏览器刷新自己的
# 缓存同类。风险由三道闸兜住：
#   ① 阈值——变更篇目超过 AUTO_REBUILD_MAX_FILES 不代劳（可能是大规模整理，
#      嵌入费用/延迟不可控），保持 stale 提醒由人拍板；
#   ② 节流——长驻 MCP server 内重建尝试（含失败）间隔不小于 AUTO_REBUILD_THROTTLE；
#   ③ 降级——重建失败按过期索引继续检索，绝不把重建失败变成检索失败。
_auto_rebuild_ts = 0.0

def _maybe_rebuild() -> dict | None:
    """stale 时自动跑增量重建，返回重建摘要；None = 没重建（开关/无变更/超阈值/节流/失败）。

    成功后必须显式清 _bm25_cache：它的版本号是"库内条数"，改内容不改条数时
    版本号不变、旧词表继续用——不能赌版本号，重建成功就清。
    """
    global _auto_rebuild_ts, _bm25_cache
    if not config.AUTO_REBUILD or not config.API_KEY:
        return None
    st = _staleness()
    if not st or not st["stale"]:
        return None
    n_changes = st["changed"] + st["removed"] + st["added"]
    if n_changes > config.AUTO_REBUILD_MAX_FILES:
        print(f"[auto-rebuild] 变更 {n_changes} 篇超过阈值 {config.AUTO_REBUILD_MAX_FILES}，"
              "不自动重建（保持提醒，由人拍板）", file=sys.stderr)
        return None
    now = time.time()
    if now - _auto_rebuild_ts < config.AUTO_REBUILD_THROTTLE:
        return None
    _auto_rebuild_ts = now   # 失败也计时：防长驻进程每次检索都重试一遍
    import index_build as ib
    try:
        s = ib.incremental_rebuild()
    except (Exception, SystemExit) as e:   # SystemExit：维度守卫用 sys.exit(1) 拒绝
        print(f"[auto-rebuild] 自动重建失败，按过期索引继续检索: {e}", file=sys.stderr)
        return None
    if s.get("skipped"):
        return None
    _bm25_cache = None
    return s


def _render(r: dict) -> str:
    mode = ("混合召回(BM25+向量)" if r.get("hybrid") else "仅向量召回")
    mode += "+精排" if r.get("rerank") else "（精排未生效）"
    sc = r.get("scope")
    lines = [f"「{r['query']}」 · 库内 {r['total_indexed']} 条 · {mode}"
             + (f" · 范围「{sc}」" if sc else "")
             + f" · top {len(r['results'])}"]
    st = r.get("stale")
    rb = r.get("rebuilt")
    if rb:
        lines.append(f"♻️ 检索前已自动重建索引（改 {rb['changed']} / 删 {rb['removed']} 篇，"
                     f"重嵌 {rb['embedded']} 块）—— 以下结果基于最新索引")
    if st and st.get("stale"):
        lines.append(f"⚠️ 索引可能过期：笔记库有变更（改 {st['changed']} / 删 {st['removed']}"
                     f" / 新增 {st['added']} 篇）—— 跑一次 index_build.py 更新")
    if r.get("rewrites"):
        lines.append(f"（口语查询已改写为：{'；'.join(r['rewrites'])}）")
    if sc and not r["results"]:
        lines.append(f"（范围「{sc}」内无命中 —— 限定范围不会自动退回全库："
                     f"要么范围写错了，要么该域里确实没记过）")
    for i, it in enumerate(r["results"], 1):
        lines.append(f"{i}. [{it['score']:.3f}] {it['title']}"
                     + (f" · {it['heading']}" if it["heading"] else "")
                     + f"  ({it['path']})")
        lines.append(f"   {it['snippet'][:120]}…")
    return "\n".join(lines)


def _serve() -> None:
    """JSON-RPC over stdio：flint 每次 spawn 一个进程、发一行、收一行、进程退出。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            result = search(req["params"]["query"],
                            int(req["params"].get("top_k", config.DEFAULT_TOP_K)),
                            scope=req["params"].get("scope"))
            print(json.dumps({"id": req.get("id"), "result": result},
                             ensure_ascii=False), flush=True)
        except Exception as e:  # 单请求失败不拖垮进程，错误按 JSON-RPC 形状回
            print(json.dumps({"id": req.get("id") if 'req' in dir() else None,
                              "error": {"message": str(e)}}, ensure_ascii=False),
                  flush=True)


def _take_opt(args: list[str], *names: str) -> tuple[list[str], str | None]:
    """从 argv 里摘出一个 `--xx value`（或 `-x value`）选项，返回值（没有就 None）。"""
    for nm in names:
        if nm in args:
            i = args.index(nm)
            if i + 1 >= len(args):
                raise SystemExit(f"{nm} 需要一个值")
            return args[:i] + args[i + 2:], args[i + 1]
    return args, None


USAGE = ('用法：python query.py "问题" [-k 5] [--in 路径前缀]\n'
         '      python query.py --json "问题" [-k 5] [--in 路径前缀]\n'
         '      python query.py --serve            （stdin 逐行 JSON-RPC）\n'
         '范围示例：--in 11-实践案例 或 --in 2-Agent能力/提示词缓存.md')


if __name__ == "__main__":
    argv = list(sys.argv[1:])
    if argv and argv[0] == "--serve":
        _serve()
    else:
        json_mode = "--json" in argv
        argv = [a for a in argv if a != "--json"]
        try:
            argv, k_raw = _take_opt(argv, "-k", "--k")
            argv, scope = _take_opt(argv, "--in", "--scope")
        except SystemExit as e:
            print(str(e))
            sys.exit(2)
        k = int(k_raw) if k_raw is not None else (
            config.DEFAULT_TOP_K if json_mode else 5)
        if not argv:
            print(USAGE)
        elif json_mode:
            # 单发模式：flint 每次 spawn 一个进程，argv 进 query、stdout 一行 JSON 出。
            # 形状与 --serve 的 JSON-RPC 响应一致 —— v2 MCP 化只换信封，不换 search 核心。
            try:
                print(json.dumps({"result": search(" ".join(argv), k, scope=scope)},
                                 ensure_ascii=False))
            except Exception as e:
                print(json.dumps({"error": {"message": str(e)}}, ensure_ascii=False))
        else:
            print(_render(search(" ".join(argv), k, scope=scope)))
