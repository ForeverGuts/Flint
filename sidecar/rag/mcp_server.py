"""MCP server —— 把 RAG 检索以标准 MCP 工具暴露出去。

协议：MCP stdio 传输 = newline-delimited JSON-RPC 2.0（每行一条消息，stdin 进 stdout 出，
日志只走 stderr 不污染协议流——与前身 Python Agent 手写 MCP 栈的纪律一致）。

实现的 method（客户端视角）：
- initialize                    握手：回 protocolVersion / capabilities / serverInfo
- notifications/initialized     通知：握手完成，不回包
- ping                          存活探测
- tools/list                    列出工具（note_search + JSON Schema）
- tools/call                    调用工具：query 必填、top_k 可选，检索核心复用 query.search()

初始化前（未收到 initialize）的一切请求按 MCP 规范拒绝（-32002）。
检索核心一行不改——search() 由 query.py 提供，本文件只做协议信封。
"""
import json
import sys

# Windows 上三条标准流钉死 UTF-8（GBK 编不了笔记里的 emoji，实测踩过），同 query.py。
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "rag-notes", "version": "1.0.0"}

TOOL_DEF = {
    "name": "note_search",
    "description": (
        "语义检索自建 Obsidian 笔记知识库（Agent 架构与协议、开源 Agent 源码分析、"
        "设计模式、Python/TS）。两段式检索：向量粗召回 + reranker 精排，精排失败自动降级。"
        "用于回顾\"笔记里记过什么\"——决策来龙去脉、概念理解、踩坑记录。"
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "自然语言查询问题"},
            "top_k": {"type": "integer", "description": "返回条数，缺省 5"},
            "scope": {"type": "string", "description": (
                "可选：限定检索的笔记路径前缀（如 \"11-实践案例\"、"
                "\"2-Agent能力/提示词缓存.md\"）。只在范围内检索；范围内没命中就返回空，"
                "**不会**退回全库——要全库查就别传这个参数。")},
        },
        "required": ["query"],
    },
}


def _reply(req_id, result):
    print(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result},
                     ensure_ascii=False), flush=True)


def _reply_error(req_id, code, message):
    print(json.dumps({"jsonrpc": "2.0", "id": req_id,
                      "error": {"code": code, "message": message}},
                     ensure_ascii=False), flush=True)


def _tool_call(req_id, params):
    name = params.get("name")
    if name != "note_search":
        return _reply_error(req_id, -32602, f"unknown tool: {name}")
    args = params.get("arguments") or {}
    query = args.get("query")
    if not query or not isinstance(query, str):
        return _reply_error(req_id, -32602, "arguments.query (string) is required")
    top_k = args.get("top_k", 5)
    try:
        top_k = max(1, min(int(top_k), 20))
    except (TypeError, ValueError):
        return _reply_error(req_id, -32602, "arguments.top_k must be an integer")
    scope = args.get("scope")
    if scope is not None and not isinstance(scope, str):
        return _reply_error(req_id, -32602, "arguments.scope must be a string")
    try:
        # 惰性导入：首次 tools/call 才加载 chromadb/openai（重 import 拖慢握手），
        # 也让 tools/list 这类轻请求在索引库损坏时依然可用。
        from query import search
        result = search(query, top_k, scope=scope)
        _reply(req_id, {"content": [
            {"type": "text", "text": json.dumps(result, ensure_ascii=False)},
        ], "isError": False})
    except Exception as e:  # 检索失败按 MCP isError 回报，不当协议错误吞掉
        print(f"[mcp] search failed: {e}", file=sys.stderr)
        _reply(req_id, {"content": [
            {"type": "text", "text": str(e)},
        ], "isError": True})


def serve() -> None:
    """主循环：逐行收 JSON-RPC，逐行回；单请求异常不拖垮进程。"""
    initialized = False
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"jsonrpc": "2.0", "id": None,
                              "error": {"code": -32700, "message": f"parse error: {e}"}},
                             ensure_ascii=False), flush=True)
            continue
        method = msg.get("method")
        req_id = msg.get("id")
        is_notification = req_id is None

        if method == "initialize":
            initialized = True
            _reply(req_id, {"protocolVersion": PROTOCOL_VERSION,
                                  "capabilities": {"tools": {}},
                                  "serverInfo": SERVER_INFO})
        elif method == "notifications/initialized":
            pass  # 通知不回包
        elif method is None:
            continue  # 无 method 的畸形消息，静默丢弃
        elif not initialized:
            # MCP 规范：初始化完成前拒绝一切请求
            if not is_notification:
                _reply_error(req_id, -32002, "server not initialized")
        elif method == "ping":
            _reply(req_id, {})
        elif method == "tools/list":
            _reply(req_id, {"tools": [TOOL_DEF]})
        elif method == "tools/call":
            if is_notification:
                continue
            _tool_call(req_id, msg.get("params") or {})
        elif method.startswith("notifications/"):
            pass  # 其余通知一律静默
        else:
            if not is_notification:
                _reply_error(req_id, -32601, f"method not found: {method}")


if __name__ == "__main__":
    try:
        serve()
    except KeyboardInterrupt:
        pass
