# -*- coding: utf-8 -*-
"""金标评测 —— hit@5 / MRR，对照组（混合召回，无精排）vs 实验组（混合+精排）。

金标怎么来的：从 manifest 的 278 篇里选主题明确的笔记，查询词**刻意换说法**
（不抄标题词）——否则测的是关键词匹配，不是语义检索的"语义"那一半。
出题人须知：查询词必须是"用户会怎么问"，不是"笔记标题怎么写"。
2026-10-06 起增补"精确标识符类"（hit@5/HNSW/TTL）：查询词就是字面 token，
标准答案是 grep 全库扫出来的真值——这类题专门盯"字面匹配"那一半的能力。
2026-10-06 再增补"口语化类"：问法是大白话（"怎么让大模型少花点钱"），
诊断实测 8 问只中 3——口语与笔记书面语之间有词面鸿沟，专门盯查询改写。

判分口径：
- hit@5：期望笔记的**任意块**进 top-5 即命中（同一篇被切成多块，命中任意一块都算）。
- MRR：1/首次命中排名，未命中记 0 —— 反映"好结果排多前"。

确定性（2026-10-06 补）：
- base 对照组（无精排）全程无 LLM 参与，嵌入与 BM25 都确定 —— 跑 1 次即可。
- 实验组的查询改写有抽样随机性（temperature=0.2），边界题会"一跑中一跑不中"
  （2026-10-06 实测：同一道题三次跑分别 ❌/✅/❌）。对策：精排模式每问跑
  EVAL_ROUNDS 轮取**众数投票**——过半轮次命中才算命中，排名取命中轮的中位数。
  单轮抽样运气不再能决定分数，跑分从此可复现。
- 成本：每轮 = 每问 1 次改写 + 1 次精排（嵌入走缓存）。3 轮约 8-10 分钟。

跑法：python eval.py（默认 3 轮；RAG_EVAL_ROUNDS=1 退回单轮口径）
"""
import math
import os
import time

from query import search

EVAL_ROUNDS = max(1, int(os.environ.get("RAG_EVAL_ROUNDS", "3")))

# (查询词, 期望命中的笔记路径)。路径与 manifest 同口径（仓库相对路径）。
# expected 可以是 tuple：多个都算对 —— 评测第一版在这里翻过车："Agent 之间怎么互相
# 通信协作"单标 ACP协议.md，但 多Agent协作.md·通信方式 那节同样是正确答案（reranker
# 给了 0.888），单期望标签会把"检索对了"错判成"没命中"。
GOLD = [
    # ---- Agent 能力 ----
    ("KV 缓存复用是怎么省钱的",                        "2-Agent能力/提示词缓存.md"),
    ("向量库里存的是什么，怎么查出来",                  "2-Agent能力/向量数据库.md"),
    ("检索增强生成的基本原理和流程",                    "2-Agent能力/RAG基础.md"),
    ("大模型流式输出是怎么实现的",                      "2-Agent能力/流式处理.md"),
    # ---- 协议与框架 ----
    ("MCP 服务器端怎么开发",                           "3-Agent框架/MCP-Server.md"),
    ("Agent 之间怎么互相通信协作",                     ("3-Agent框架/ACP协议.md", "1-Agent理论/多Agent协作.md")),
    ("LangGraph 的状态图是什么",                       "3-Agent框架/LangGraph.md"),
    # ---- LLM 厂商 ----
    ("Anthropic 和 OpenAI 的思考机制有什么不同",        "4-LLM模型/OpenAI与Anthropic协议层思考机制对比.md"),
    ("DeepSeek 的模型有哪些",                          "4-LLM模型/DeepSeekV4系列-深度求索.md"),
    # ---- Python ----
    ("装饰器的原理和写法",                             "5-Python/基础语法/装饰器.md"),
    ("yield 和生成器函数怎么用",                       ("5-Python/基础语法/迭代器与生成器.md", "9-终端与IO/生成器与异步生成器.md")),
    ("用 pydantic 定义数据模型",                       "5-Python/类型系统/pydantic与数据模型.md"),
    ("Python 的虚拟环境和依赖管理",                    "5-Python/工程实践/虚拟环境与包管理.md"),
    # ---- TypeScript / 设计模式 ----
    ("TS 泛型在什么场景下用",                          "8-编程语言特性/类型系统/泛型.md"),
    ("观察者模式解决什么问题",                         "7-设计模式与范式/设计模式/观察者.md"),
    ("先拷贝一份再改，避免共享引用的实践",              "7-设计模式与范式/编码实践/防御性拷贝.md"),
    # ---- 实践案例（源码分析类，考验"分析笔记"的召回）----
    ("dsh 的事件系统是怎么设计的",                     "11-实践案例/dsh会话事件系统/01-会话事件系统.md"),
    ("pi 和 Cline 的主循环有什么区别",                 "11-实践案例/学习Log-pi与Cline对比/03-核心循环对比.md"),
    # ---- 精确标识符类（2026-10-06 新增）----
    # 动机：纯向量通道对这类查询 3/5 脱靶（grep 真值对照实测）——双塔只认"意思相近"
    # 不认"字面相同"。期望路径来自 grep 全库扫描的真值，不是拍脑袋。
    ("hit@5",                                         ("2-Agent能力/RAG实践-笔记库检索.md", "11-实践案例/00-项目知识索引/TS Agent.md")),
    ("HNSW",                                          ("2-Agent能力/向量数据库.md", "2-Agent能力/RAG基础.md")),
    ("TTL",                                           "2-Agent能力/提示词缓存.md"),
    # ---- 口语化类（2026-10-06 新增）----
    # 动机：口语问法（"怎么让大模型少花点钱"）对诊断 8 问只中 3——口语与笔记
    # 书面语之间存在词面鸿沟，混合检索的字面/语义两头都够不着。这组题专门盯
    # 查询改写的能力；问法来自"用户会怎么对 Agent 说话"，不是检索工程师的写法。
    ("怎么让大模型少花点钱",                           "2-Agent能力/提示词缓存.md"),
    ("那个存笔记的东西是咋工作的",                     "2-Agent能力/向量数据库.md"),
    ("RAG 是干嘛的",                                  "2-Agent能力/RAG基础.md"),
    ("打字机那种一个字一个字蹦的效果怎么做的",          "2-Agent能力/流式处理.md"),
    ("几个AI怎么组队干活",                            ("3-Agent框架/ACP协议.md", "1-Agent理论/多Agent协作.md")),
    ("python 那个 @ 语法是啥",                        "5-Python/基础语法/装饰器.md"),
    ("yield 是个啥玩意",                              ("5-Python/基础语法/迭代器与生成器.md", "9-终端与IO/生成器与异步生成器.md")),
    ("AI记性不好怎么办",                              ("2-Agent能力/上下文压缩.md", "2-Agent能力/提示词缓存.md")),
]

TOP_K = 5


def _rank_of(expected, results: list[dict]) -> int:
    """期望笔记（str 或 str 元组，任一命中即可）在结果中的首次排名（1 基），不在则 0。"""
    expected_set = {expected} if isinstance(expected, str) else set(expected)
    for i, it in enumerate(results, 1):
        if it["path"] in expected_set:
            return i
    return 0


def _score(rows: list[int]) -> tuple[float, float]:
    hits = [r for r in rows if r > 0]
    hit5 = sum(1 for r in rows if 0 < r <= TOP_K) / len(rows)
    mrr = sum(1.0 / r for r in hits) / len(rows)
    return hit5, mrr


def _vote(ranks: list[int]) -> tuple[int, int]:
    """多轮排名 → (稳定排名, 命中轮数)。

    众数投票：过半轮次命中才算命中（ ties 取更宽容的偶数半数——单轮判定
    已经是二值的，n 轮里命中 n/2 以上即通过，这里用严格过半，宁严勿松）。
    排名取**命中轮次的中位数**：不是最好成绩（虚高）也不是最差（冤枉），
    是"典型表现"。全部轮次未命中 → (0, 0)。
    """
    hits = sorted(r for r in ranks if r > 0)
    if not hits:
        return 0, 0
    if len(hits) * 2 <= len(ranks):
        return 0, len(hits)          # 命中轮没过半 → 判未命中
    mid = len(hits) // 2
    med = hits[mid] if len(hits) % 2 else (hits[mid - 1] + hits[mid]) / 2
    return max(1, round(med)), len(hits)


def main() -> None:
    print(f"金标 {len(GOLD)} 问 · top {TOP_K} · 两模式对照 · 精排 {EVAL_ROUNDS} 轮众数投票\n")
    base_rows, rer_rows, details = [], [], []
    for q, expected in GOLD:
        t0 = time.time()
        base = search(q, top_k=TOP_K, rerank=False)   # 无 LLM，确定，跑一次就够
        rb = _rank_of(expected, base["results"])
        base_rows.append(rb)
        rer_ranks = [_rank_of(expected, search(q, top_k=TOP_K, rerank=True)["results"])
                     for _ in range(EVAL_ROUNDS)]
        rr, wins = _vote(rer_ranks)
        rer_rows.append(rr)
        mark = "✅" if rr > 0 else "❌"
        delta = ""
        if rb != rr:
            delta = f"  （召回排 {rb or '-'} → 精排排 {rr or '-'}）"
        votes = f"{wins}/{EVAL_ROUNDS} 轮中" if EVAL_ROUNDS > 1 else ""
        details.append((mark, q, expected, rr, f"{time.time() - t0:.1f}s{delta}{votes}"))

    for mark, q, expected, rr, extra in details:
        print(f"  {mark} {q}")
        exp = " / ".join(expected) if isinstance(expected, tuple) else expected
        print(f"      期望 {exp} · 精排排 {rr or '未进前5'} · {extra}")

    b5, bm = _score(base_rows)
    r5, rm = _score(rer_rows)
    print(f"\n────── 汇总 ──────")
    print(f"  混合召回（对照组）：hit@5 = {b5:.2%}  MRR = {bm:.3f}")
    print(f"  混合+精排（实验组）：hit@5 = {r5:.2%}  MRR = {rm:.3f}")
    print(f"  精排带来：hit@5 {'↑' if r5 > b5 else '→' if r5 == b5 else '↓'}"
          f"{abs(r5 - b5):.0%}  MRR {'↑' if rm > bm else '→' if rm == bm else '↓'}{abs(rm - bm):.3f}")
    target = "🎯 达标" if r5 >= 0.8 else "⚠️ 未达 0.8 目标"
    print(f"  hit@5 目标 ≥ 0.8：{target}")


if __name__ == "__main__":
    main()
