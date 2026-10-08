"""建索引：manifest 的每篇笔记 → 按标题结构分块 → 脱敏 → 嵌入 → Chroma 入库。

设计要点：
- 分块用 MarkdownHeaderTextSplitter：语料有统一模板（固定六节），按标题切出的块天然语义完整；
- 嵌入文本 = 【标题 · 节名】+ 正文 —— 标题是检索的重要信号，不能只嵌正文；
- 嵌入缓存：按 chunk 文本 sha256 缓存向量，重建索引不重复计费；
- 脱敏在「发给 API 之前」执行，落库的就是脱敏后的文本；
- **块 id = 嵌入文本的 sha256**：内容没变 id 就不变，upsert 天然幂等——这是
  增量索引能省掉绝大部分写入的前提。

增量模式（默认）：
- build-state.json 记录每篇的 (mtime, size) 签名；只重新分块「签名变了/新增」的篇目；
- 变更/删除的篇目先按 path 删净旧块再插新块 —— 否则 upsert 留下孤儿块，
  改过的笔记会检索出旧版本、删掉的文件还能搜到（全量重建也治不了这个 bug）；
- 篇目内容没变 = 旧块 id 与新块 id 完全一致，跳过它们零副作用；
- manifest 由 corpus.build_manifest() 现场刷新（语料扫描很便宜，增量就该一条命令）。

增量核心提炼在 incremental_rebuild()：CLI（本文件 main）与 query.py 的
检索前自动重建（2026-10-06）共用同一段代码——不存在"手动重建和自动重建
行为不一致"的两套真相。

用法：
  python index_build.py            # 增量（无 state 时等同全量并落 state）
  python index_build.py --full     # 强制全量重建（换模型/换口径后用）
  python index_build.py --check    # 只报告差异，不碰索引（干跑）

注意：--full 后 state 同步刷新；redact-report 每次运行整文件重写，只含当次批量的命中。
"""
import hashlib
import json
import re
import sys

import chromadb
from openai import OpenAI
from langchain_text_splitters import MarkdownHeaderTextSplitter

import config


# ---- 脱敏 ----
_PATTERNS = [(tag, re.compile(pat)) for tag, pat in config.SENSITIVE_PATTERNS]

def redact(text: str, report: list) -> tuple[str, int]:
    hits = 0
    for tag, pat in _PATTERNS:
        text, n = pat.subn(f"[已脱敏:{tag}]", text)
        hits += n
    if hits:
        report.append({"hits": hits})
    return text, hits


# ---- frontmatter ----
_FM = re.compile(r"\A---\n(.*?)\n---\n", re.S)

def parse_doc(text: str) -> tuple[dict, str]:
    """拆 frontmatter，取 title；正文留给分块器。"""
    meta = {}
    body = text
    m = _FM.match(text)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip().strip('"')
        body = text[m.end():]
    return meta, body


def chunk_file(path, rel: str) -> list[dict]:
    text = path.read_text("utf-8", errors="replace")
    meta, body = parse_doc(text)
    title = meta.get("title", path.stem)
    splitter = MarkdownHeaderTextSplitter(
        headers_to_split_on=[("#", "h1"), ("##", "h2"), ("###", "h3")],
        strip_headers=False,
    )
    chunks = []
    category = rel.split("/")[0]
    for seg in splitter.split_text(body):
        content = seg.page_content.strip()
        if len(content) < config.MIN_CHUNK_CHARS:
            continue
        heading = seg.metadata.get("h2") or seg.metadata.get("h1") or seg.metadata.get("h3") or ""
        # 标题进嵌入文本：检索信号；不进则裸正文丢上下文
        embed_text = f"【{title}" + (f" · {heading}" if heading else "") + f"】\n{content}"
        chunks.append({
            "id": hashlib.sha256(embed_text.encode()).hexdigest()[:16],
            "path": rel,
            "title": title,
            "heading": heading,
            "category": category,
            "text": embed_text,
        })
    return chunks


# ---- 嵌入（带缓存）----
def load_cache() -> dict:
    cache = {}
    if config.EMBED_CACHE.exists():
        for line in config.EMBED_CACHE.read_text("utf-8").splitlines():
            try:
                rec = json.loads(line)
                cache[rec["k"]] = rec["v"]
            except (json.JSONDecodeError, KeyError):
                continue
    return cache


def embed_all(texts: list[str], cache: dict, report: list) -> list[list[float]]:
    client = OpenAI(api_key=config.API_KEY, base_url=config.BASE_URL)
    todo = [t for t in texts if hashlib.sha256(t.encode()).hexdigest() not in cache]
    # 进度只走 stderr：incremental_rebuild 会活在 MCP server 进程里（自动重建），
    # stdout 是协议通道，任何 print 混进去都是协议故障（verify ⑫ 实测抓过）
    print(f"  需嵌入 {len(todo)}/{len(texts)} 块（其余走缓存）", file=sys.stderr)
    for i in range(0, len(todo), config.EMBED_BATCH):
        batch = todo[i:i + config.EMBED_BATCH]
        resp = client.embeddings.create(model=config.EMBED_MODEL, input=batch)
        for t, d in zip(batch, resp.data):
            cache[hashlib.sha256(t.encode()).hexdigest()] = d.embedding
        print(f"    {min(i + config.EMBED_BATCH, len(todo))}/{len(todo)}", file=sys.stderr)
    with open(config.EMBED_CACHE, "a", encoding="utf-8") as f:
        for t in todo:
            f.write(json.dumps({"k": hashlib.sha256(t.encode()).hexdigest(),
                                "v": cache[hashlib.sha256(t.encode()).hexdigest()]},
                               ensure_ascii=False) + "\n")
    return [cache[hashlib.sha256(t.encode()).hexdigest()] for t in texts]


# ---- 增量：文件签名与差异 ----
def file_sig(path) -> list:
    st = path.stat()
    return [st.st_mtime, st.st_size]


def load_state() -> dict:
    """{rel_path: {mtime, size, chunks}} —— 上次入库时每篇的签名。"""
    if config.BUILD_STATE.exists():
        return json.loads(config.BUILD_STATE.read_text("utf-8")).get("files", {})
    return {}


def save_state(manifest_files: list[str], chunks_by_file: dict[str, int]) -> None:
    files = {}
    for rel in manifest_files:
        p = config.VAULT / rel
        files[rel] = {"mtime": file_sig(p)[0], "size": file_sig(p)[1],
                      "chunks": chunks_by_file.get(rel, 0)}
    config.INDEX_DIR.mkdir(parents=True, exist_ok=True)   # 不依赖调用方建过目录
    config.BUILD_STATE.write_text(
        json.dumps({"files": files}, ensure_ascii=False), encoding="utf-8")


def diff(state: dict, manifest_files: list[str]) -> tuple[list[str], list[str], list[str]]:
    """返回 (changed, removed, unchanged)。changed = 新增 + 签名变化。"""
    cur = set(manifest_files)
    changed = [r for r in manifest_files
               if r not in state
               or file_sig(config.VAULT / r) != [state[r]["mtime"], state[r]["size"]]]
    removed = [r for r in state if r not in cur]
    unchanged = [r for r in manifest_files if r not in changed]
    return changed, removed, unchanged


def _open_collection() -> tuple:
    client = chromadb.PersistentClient(path=str(config.INDEX_DIR))
    return client.get_or_create_collection("notes", metadata={"hnsw:space": "cosine"})


def _refresh_manifest() -> dict:
    """语料扫描便宜，manifest 现场刷新 —— 改完笔记一条命令即可（增量/check 共用）。"""
    import corpus
    manifest = corpus.build_manifest()
    config.MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    return manifest


def incremental_rebuild() -> dict:
    """增量重建核心（自动重建与 CLI 共用）：manifest 刷新 → diff → 删旧块 →
    只嵌变更篇目 → 落 state。返回摘要 dict，**不打印**。

    为什么不打印：复用方（query.py 的检索前自动重建）可能活在 MCP server
    进程里，stdout 是协议通道（newline-delimited JSON-RPC），任何日志混进去
    都是协议故障；CLI 的可读输出全部留在 main()。

    skipped=True 表示零变更——连 Chroma 都不开（PersistentClient 一打开就会
    重写 sqlite 簿记，「没做事 = 字节级没做事」的口径不变）。
    """
    state = load_state()
    manifest = _refresh_manifest()
    changed, removed, unchanged = diff(state, manifest["files"])
    if not changed and not removed:
        return {"skipped": True, "changed": 0, "removed": 0,
                "unchanged": len(unchanged), "embedded": 0, "total": None}
    config.INDEX_DIR.mkdir(parents=True, exist_ok=True)   # 到这里才真正要落盘
    col = _open_collection()
    # 第一步：变更/删除的篇目，先把旧块按 path 删净（孤儿块是检索正确性问题）
    doomed = changed + removed
    if doomed:
        col.delete(where={"path": {"$in": doomed}})
    # 第二步：只对「变更篇目」分块/嵌入/入库
    chunks: list[dict] = []
    chunks_by_file: dict[str, int] = {}
    for rel in changed:
        cs = chunk_file(config.VAULT / rel, rel)
        chunks_by_file[rel] = len(cs)
        chunks.extend(cs)
    redact_report: list = []
    n = _write_chunks(col, chunks, load_cache(), redact_report)
    save_state(manifest["files"], chunks_by_file)
    if redact_report:
        config.REDACT_REPORT.write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in redact_report),
            encoding="utf-8")
    return {"skipped": False, "changed": len(changed), "removed": len(removed),
            "unchanged": len(unchanged), "embedded": n, "total": col.count()}


def _write_chunks(col, chunks: list[dict], cache: dict, redact_report: list) -> int:
    """脱敏 → 嵌入 → upsert。返回入库块数。"""
    for c in chunks:
        c["text"], _ = redact(c["text"], redact_report)
    if not chunks:
        return 0
    vectors = embed_all([c["text"] for c in chunks], cache, redact_report)
    if len({len(v) for v in vectors}) != 1:
        print("!! 向量维度不一致，换模型必须全量重建", file=sys.stderr)
        sys.exit(1)
    col.upsert(
        ids=[c["id"] for c in chunks],
        embeddings=vectors,
        documents=[c["text"] for c in chunks],
        metadatas=[{"path": c["path"], "title": c["title"],
                    "heading": c["heading"], "category": c["category"]}
                   for c in chunks],
    )
    return len(chunks)


def main() -> None:
    full = "--full" in sys.argv
    check = "--check" in sys.argv
    state = load_state()

    if check:
        # 干跑：只报告差异，不碰索引。--full --check 组合沿用全量视角（不刷新
        # manifest），普通 --check 现场刷新 manifest（扫描便宜，报告才是当真的）。
        if full:
            if not config.MANIFEST.exists():
                print("先跑 corpus.py 生成 manifest", file=sys.stderr)
                sys.exit(1)
            manifest = json.loads(config.MANIFEST.read_text("utf-8"))
            changed, removed, unchanged = manifest["files"], [], []
        else:
            manifest = _refresh_manifest()
            changed, removed, unchanged = diff(state, manifest["files"])
        print(f"manifest：{manifest['total']} 篇（state 记录 {len(state)} 篇）")
        print(f"变更 {len(changed)} · 删除 {len(removed)} · 未变 {len(unchanged)}")
        for r in changed[:20]:
            print(f"  + {r}")
        for r in removed[:20]:
            print(f"  - {r}")
        if len(changed) > 20 or len(removed) > 20:
            print("  …（仅展示前 20 条）")
        print("（--check 干跑：索引未动）")
        return

    if full:
        # 全量口径不变：manifest 是唯一事实源，须先跑 corpus.py
        if not config.MANIFEST.exists():
            print("先跑 corpus.py 生成 manifest", file=sys.stderr)
            sys.exit(1)
        manifest = json.loads(config.MANIFEST.read_text("utf-8"))
        changed, removed, unchanged = manifest["files"], [], []
        config.INDEX_DIR.mkdir(parents=True, exist_ok=True)
        col = _open_collection()
        chunks: list[dict] = []
        chunks_by_file: dict[str, int] = {}
        for rel in changed:
            cs = chunk_file(config.VAULT / rel, rel)
            chunks_by_file[rel] = len(cs)
            chunks.extend(cs)
        redact_report: list = []
        n = _write_chunks(col, chunks, load_cache(), redact_report)
        print(f"全量：{len(changed)} 篇 → 入库 {n} 块")
        # 全量额外清一次孤儿（历史遗留：upsert 只加不删）
        all_ids = {c["id"] for c in chunks}
        existing = col.get(include=[])["ids"]
        stale = [i for i in existing if i not in all_ids]
        if stale:
            col.delete(ids=stale)
        print(f"全量孤儿清理：{len(stale)} 条")
        save_state(manifest["files"], chunks_by_file)
        print(f"入库总计：{col.count()} 条 → {config.INDEX_DIR}")
        if redact_report:
            config.REDACT_REPORT.write_text(
                "\n".join(json.dumps(r, ensure_ascii=False) for r in redact_report),
                encoding="utf-8")
        return

    # 增量：核心与 query.py 的自动重建共用（incremental_rebuild），main 只管可读输出
    s = incremental_rebuild()
    if s["skipped"]:
        print(f"增量：无变更，索引未动（{s['unchanged']} 篇零写入）")
        return
    print(f"增量：变更 {s['changed']} 篇 → 入库 {s['embedded']} 块；"
          f"未变 {s['unchanged']} 篇零写入；删除 {s['removed']} 篇旧块已清")
    print(f"入库总计：{s['total']} 条 → {config.INDEX_DIR}")


if __name__ == "__main__":
    main()
