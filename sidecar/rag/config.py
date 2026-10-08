"""集中配置 —— 路径、模型、黑名单都在这一处，改口径只改这里。"""
import os
from pathlib import Path

# ---- 路径 ----
VAULT = Path(os.environ.get("RAG_VAULT", r"C:/Users/31075/Documents/obsidian_-note/Agent"))
SIDEcar_DIR = Path(__file__).resolve().parent
# INDEX_DIR / MANIFEST 可用环境变量覆盖：verify 套件用临时目录做夹具，
# 不污染真实索引与唯一事实源（与 RAG_VAULT 同一套口径）。
INDEX_DIR = Path(os.environ.get(
    "RAG_INDEX_DIR", SIDEcar_DIR.parent.parent / ".flint" / "rag-index"))
MANIFEST = Path(os.environ.get(
    "RAG_MANIFEST", SIDEcar_DIR / "manifest.json"))
EMBED_CACHE = INDEX_DIR / "embed-cache.jsonl"
REDACT_REPORT = INDEX_DIR / "redact-report.jsonl"
BUILD_STATE = INDEX_DIR / "build-state.json"   # 增量索引的文件签名快照（mtime+size）

# ---- 语料黑名单（与笔记库「扫描域」口径对齐）----
# 原则：只索引「自建知识笔记」，第三方 clone 资料 / 工具配置 / 模板一律不入库
BLACKLIST_DIRS = {".git", ".claude", ".obsidian", "模板", "Skills", "assets", ".pi"}
BLACKLIST_NAME_CONTAINS = ("Git获得",)      # Agent学习路线(Git获得的) —— 227 篇第三方资料
EXCLUDE_FILES = {"笔记目录.md"}             # 索引文件，链接清单无语义检索价值

# ---- 嵌入模型（硅基流动 bge-m3：免费 / 中文优化 / 1024 维 / OpenAI 兼容）----
API_KEY = os.environ.get("SILICONFLOW_API_KEY", "")
if not API_KEY and (SIDEcar_DIR / ".env").exists():
    for line in (SIDEcar_DIR / ".env").read_text("utf-8").splitlines():
        if line.startswith("SILICONFLOW_API_KEY="):
            API_KEY = line.split("=", 1)[1].strip()
BASE_URL = "https://api.siliconflow.cn/v1"
EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "BAAI/bge-m3")
EMBED_DIM = 1024
EMBED_BATCH = 32

# ---- 分块与检索 ----
MIN_CHUNK_CHARS = 20      # 短于此的块不入库（纯标题/空节）
DEFAULT_TOP_K = 5
RECALL_K = 20             # 向量召回条数 = reranker 的候选池（召回宽、精排严）
SCOPE_RECALL_K = 200      # 带范围限定（--in / scope）时的召回条数。向量与 BM25 都没有
                          # "前缀过滤"的原生支持，只能多召回再筛——不放大就会出现
                          # "范围内明明有、只是排在 20 名之外"的假空结果。200 条粗排仍是毫秒级

# ---- 重排（硅基流动 bge-reranker-v2-m3：免费 / cross-encoder 逐对打分）----
# 与嵌入的区别：嵌入是"双塔"各自编码再算距离（快但粗），reranker 把 query+doc
# 拼一起过模型（慢但准）——所以只对召回的 20 条精排，不对全库 2959 条算。
RERANK_MODEL = os.environ.get("RAG_RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
RERANK_TIMEOUT = 10       # 秒；重排超时/报错一律降级为不重排（召回序兜底）
RERANK_POOL = 12          # 送精排的候选上限（RRF 前 12 条；top_k=5 足够，全池逐对打分慢且稀释）

# ---- 混合检索（BM25 关键词通道 + 向量语义通道，RRF 融合）----
# 依据（2026-10-06 实测）：精确标识符查询 hit@5 / HNSW / TTL 在纯向量通道 3/5 脱靶
# ——双塔只认"意思相近"，不认"字面相同"；BM25 补的正是字面那一半。
# 分词：ASCII 词元（标识符/文件名整体保留）+ 中文二元组（免 jieba 依赖）。
HYBRID = os.environ.get("RAG_HYBRID", "1") != "0"   # RAG_HYBRID=0 退回纯向量（A/B 用）
BM25_K1 = 1.5
BM25_B = 0.75
RRF_K = 60            # Reciprocal Rank Fusion 常数，论文默认值

# ---- 自动重建（stale → 检索前顺手跑增量重建）----
# 第 8 步只把"过期"当数据回报，重建仍靠人跑 index_build.py —— 实际使用中提醒
# 常被无视，下一次检索继续拿旧结果。这一步把提醒升级为代劳。
# 安全边界（为什么这不需要过 flint 的写闸）：flint 写闸管的是"Agent 写用户文件"；
# 重建只写 INDEX_DIR（笔记库之外的派生缓存），vault 全程只读——性质与浏览器
# 刷新自己的缓存同类。边界由三道闸兜住：阈值（大批量变更不代劳）、节流（长驻
# 进程不反复尝试）、失败降级（重建挂了按过期索引继续搜，绝不挡检索）。
AUTO_REBUILD = os.environ.get("RAG_AUTO_REBUILD", "1") != "0"   # =0 关闭（A/B 用）
AUTO_REBUILD_MAX_FILES = int(os.environ.get("RAG_AUTO_REBUILD_MAX_FILES", "50"))
# 变更篇目数超过阈值不当场代劳（可能是一次大规模整理，嵌入费用/延迟不可控），
# 保持 stale 提醒、由人拍板。设 0 可让任何变更都触发"不代劳"（verify 用）。
AUTO_REBUILD_THROTTLE = 30   # 秒；长驻 MCP server 内重建尝试（含失败）的最小间隔

# ---- 查询改写（口语问句 → 书面检索查询，LLM 改写 + 多路融合）----
# 依据（2026-10-06 实测）：口语化问法对金标 8 问只中 3（"怎么让大模型少花点钱"
# "几个AI怎么组队干活"全脱靶）——口语与笔记书面语之间存在"词面鸿沟"，
# 混合检索也填不上（字面/语义两头都不搭）。改写器用小模型补的就是这一半。
REWRITE = os.environ.get("RAG_REWRITE", "1") != "0"      # RAG_REWRITE=0 关闭（A/B 用）
# 72B 不是奢侈：改写器的核心难点是"术语常识"（打字机效果→流式输出），
# 7B 实测会跑偏（"少花点钱"→"训练成本"），32B/72B 对比实测 72B 才稳定补对；
# 免费档 + 1.6s 延迟（对比检索全链路 3-5s）可接受。
REWRITE_MODEL = os.environ.get("RAG_REWRITE_MODEL", "Qwen/Qwen2.5-72B-Instruct")
REWRITE_TIMEOUT = 8       # 秒；改写超时/报错一律退回原查询，检索不因改写死掉
REWRITE_MAX = 3           # 最多改写几条变体（每多一条 = 多 1 次嵌入 + 2 路召回）

# 领域词典（2026-10-06）：口语说法 → 本知识库的书面术语，注入改写器 prompt。
# 动机（金标实测）：剩 2 问盲区是改写器的"项目黑话"常识盲区——"存笔记的东西"
# 猜不到"向量数据库"、"几个AI组队干活"猜不到"多智能体协作/ACP"。这类映射
# 依赖"这个库讲什么"，通用大模型不知道，词典补的就是这最后半个鸿沟。
# 为什么手工策展而不是从库自动抽词：自动抽高频词会抽到"怎么做/笔记"这类
# 无区分度的词，反而把改写带偏；只收"通用模型猜不到 + 库里真实存在"的映射，
# 控制在个位数条目——防词表膨胀（每多一条都是 prompt 成本与跑偏风险）。
REWRITE_GLOSSARY = """\
存笔记的东西/查笔记背后 → 向量数据库、语义检索、嵌入（embedding）、RAG
几个AI组队/多个AI一起干活 → 多智能体协作（multi-agent）、Agent 通信协议（ACP/A2A）
AI记性不好/聊长了忘事 → 上下文压缩、提示词缓存、多轮对话记忆
少花点钱/调用太贵 → KV 缓存复用、提示词缓存命中率、降低 API 调用成本
打字机效果/一个字一个字蹦 → 流式输出（streaming/SSE）
AI自己琢磨着干活 → ReAct、工具调用（function calling）、反思（reflection）
长文档塞不下 → 文档切分（chunking）、长上下文、检索增强生成
"""

# ---- 领域词典维护（2026-10-06 第 13 步）----
# 内置词典之外支持两层动态来源，三层分工：
#   内置（REWRITE_GLOSSARY）：手工策展、随代码走、只读；
#   本地（GLOSSARY_LOCAL）：glossary.py add/promote 写入的**人审过**的词条，
#     立即生效——mtime 作版本号热更新，长驻 MCP server 不用重启；
#   候选（GLOSSARY_CAND）：检索自动沉淀的"改写致胜对"，**只记证据不进 prompt**
#     （变体措辞是模型泛化的，自动注入等于把脏词条写进每次检索），人审后 promote。
GLOSSARY_LOCAL = Path(os.environ.get(
    "RAG_GLOSSARY_LOCAL", SIDEcar_DIR / "glossary.local.txt"))
GLOSSARY_CAND = Path(os.environ.get(
    "RAG_GLOSSARY_CAND", SIDEcar_DIR / "glossary.cand.txt"))
GLOSSARY_CAND_MAX = 50     # 候选池上限：自动沉淀不许无限膨胀（丢最旧留最新）
GLOSSARY_HIT_MIN = 0.5     # 沉淀门槛：仅当胜出结果精排分 ≥ 此值（强相关）才记录

_glossary_cache: tuple | None = None

def load_glossary() -> str:
    """改写器 prompt 用的词典全文 = 内置 + 本地合并；本地文件 mtime 缓存热更新。

    与 BM25 缓存同款思路：版本号用 (mtime, size)，文件一改下次检索就是新词表；
    文件不存在/读不动都静默退回内置词典——词典层永远不能挡检索。
    """
    global _glossary_cache
    try:
        st = GLOSSARY_LOCAL.stat()
        key: tuple | None = (st.st_mtime, st.st_size)
    except OSError:
        key = None
    if _glossary_cache and _glossary_cache[0] == key:
        return _glossary_cache[1]
    text = REWRITE_GLOSSARY
    if key:
        try:
            local = GLOSSARY_LOCAL.read_text("utf-8").strip()
            if local:
                text = REWRITE_GLOSSARY.rstrip("\n") + "\n" + local + "\n"
        except (OSError, UnicodeDecodeError):
            pass
    _glossary_cache = (key, text)
    return text

# 改写闸（2026-10-06 第 11 步实测返工）：原问句自己精排 top1 分数 ≥ 此值时，
# 变体不参与精排——书面问句原问句已稳稳命中，变体只会把跑偏主题的高分块
# 掺进 max 融合（实测案例：领域词典把"MCP 服务器端怎么开发"的变体拽向
# 多智能体协作/ACP，正主在召回第 2 却被挤出前 5）。校准数据（仅原问句精排
# top1）：需要变体捞回的口语题 0.58（组队干活）/0.03（少花点钱/存笔记的
# 东西），必须挡住变体的书面题 0.64（MCP 服务器端）——0.60 卡在窄缝里，
# env 可调，靠金标盯防；这窄缝本身如实记录为已知脆弱点。
REWRITE_GATE = float(os.environ.get("RAG_REWRITE_GATE", "0.60"))

# 单篇多样性上限（2026-10-06 第 11 步实测）：top_k 结果里同一篇笔记最多几块。
# 「查笔记」要的是命中的**笔记清单**，不是同一篇的 5 个段落——实测案例：
# "AI记性不好怎么办"有两簇都相关的答案（知识笔记 vs 实践案例日志），
# 高分簇的 4-5 个块把另一簇整簇挤出前 5。多样性上限让两簇都能露面，
# 对 hit@5 只帮忙不添乱（更多不同笔记进前 k）。
MAX_PER_NOTE = int(os.environ.get("RAG_MAX_PER_NOTE", "2"))

# 固定随机种子（2026-10-06）：金标边界题此前随 temperature 抖动（MRR 0.784↔0.810）。
# seed 让改写输出可复现（支持 seed 的服务商生效；不支持的会忽略，不影响正确性）。
REWRITE_SEED = int(os.environ.get("RAG_REWRITE_SEED", "20261006"))

# ---- 敏感信息脱敏（发给嵌入 API 前执行）----
SENSITIVE_PATTERNS = [
    ("手机号", r"(?<!\d)1[3-9]\d{9}(?!\d)"),
    ("邮箱", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    ("API密钥", r"\bsk-[A-Za-z0-9]{20,}\b"),
]
