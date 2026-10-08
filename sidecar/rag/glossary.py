# -*- coding: utf-8 -*-
"""领域词典维护 CLI —— 内置 / 本地 / 候选池三层。

  内置  config.REWRITE_GLOSSARY        手工策展、随代码走、只读
  本地  glossary.local.txt             人审过的词条，改完热生效（mtime 版本号，
                                       长驻 MCP server 不用重启）
  候选  glossary.cand.txt              检索自动沉淀的"改写致胜对"（原问句 →
                                       胜出变体），只记证据不进 prompt

用法（在 sidecar/rag/ 下）：
  python glossary.py list             # 三层现状
  python glossary.py add "口语说法 → 书面术语"    # 本地词典追加，立即生效
  python glossary.py rm N             # 删本地第 N 条
  python glossary.py cand             # 看候选池
  python glossary.py promote N        # 候选第 N 条提升进本地词典（人审动作）
  python glossary.py drop N           # 丢弃候选第 N 条（判为脏词条）

设计立场：候选**不自动进 prompt**——变体措辞是模型泛化出来的，自动注入等于
把脏词条写进每次检索的 prompt；沉淀只记证据，提升必须人审。
"""
import sys
from pathlib import Path

import config

SEP = " → "


def _read_lines(p: Path) -> list[str]:
    """读词条文件为行列表（去空行、只留含分隔符的行）；文件不存在返回空。"""
    try:
        return [l.strip() for l in p.read_text("utf-8").splitlines()
                if l.strip() and SEP in l]
    except (OSError, UnicodeDecodeError):
        return []


def _write_lines(p: Path, lines: list[str]) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def merge_lines(builtin: str, local: list[str]) -> list[str]:
    """内置 + 本地合并去重（按口语键 = 分隔符前半段，本地覆盖内置同键）。"""
    out: dict[str, str] = {}
    for line in (l.strip() for l in builtin.splitlines()):
        if line and SEP in line:
            out[line.split(SEP, 1)[0].strip()] = line
    for line in local:
        out[line.split(SEP, 1)[0].strip()] = line
    return list(out.values())


def sediment(existing: list[str], q: str, v: str, cap: int) -> tuple[list[str], bool]:
    """候选沉淀纯逻辑：同问句覆盖（最新证据优先）、完全同对不重复、超 cap 丢最旧。

    返回 (新列表, 是否有实质变化)。永不抛错——调用方在检索链路里。
    """
    pair = f"{q}{SEP}{v}"
    changed = pair not in existing
    out = [l for l in existing if l != pair and not l.startswith(q + SEP)]
    out.append(pair)
    return out[-cap:], changed


def add_candidate(q: str, v: str) -> None:
    lines = _read_lines(config.GLOSSARY_CAND)
    new, _ = sediment(lines, q, v, config.GLOSSARY_CAND_MAX)
    _write_lines(config.GLOSSARY_CAND, new)


def _builtin_local() -> list[str]:
    return merge_lines(config.REWRITE_GLOSSARY, _read_lines(config.GLOSSARY_LOCAL))


def main() -> None:
    args = sys.argv[1:]
    cmd = args[0] if args else "list"
    if cmd == "list":
        print("── 内置 + 本地（prompt 实际生效的词表）──")
        for i, line in enumerate(_builtin_local(), 1):
            src = "内置" if line in config.REWRITE_GLOSSARY else "本地"
            print(f"{i:2d}. [{src}] {line}")
        print(f"\n── 候选池（{config.GLOSSARY_CAND.name}，人审后 promote）──")
        cand = _read_lines(config.GLOSSARY_CAND)
        if not cand:
            print("（空）")
        for i, line in enumerate(cand, 1):
            print(f"{i:2d}. {line}")
    elif cmd == "add" and len(args) == 2:
        if SEP not in args[1]:
            sys.exit(f'格式应为 "口语说法{SEP}书面术语"')
        local = _read_lines(config.GLOSSARY_LOCAL)
        line = args[1].strip()
        local = [l for l in local if l.split(SEP, 1)[0].strip()
                 != line.split(SEP, 1)[0].strip()] + [line]   # 同键覆盖
        _write_lines(config.GLOSSARY_LOCAL, local)
        print(f"已加入本地词典（热生效）：{line}")
    elif cmd == "rm" and len(args) == 2:
        local = _read_lines(config.GLOSSARY_LOCAL)
        i = int(args[1]) - 1
        if not (0 <= i < len(local)):
            sys.exit(f"序号超出范围（本地共 {len(local)} 条）")
        print(f"已删除：{local.pop(i)}")
        _write_lines(config.GLOSSARY_LOCAL, local)
    elif cmd == "cand":
        for i, line in enumerate(_read_lines(config.GLOSSARY_CAND), 1):
            print(f"{i:2d}. {line}")
    elif cmd == "promote" and len(args) == 2:
        cand = _read_lines(config.GLOSSARY_CAND)
        i = int(args[1]) - 1
        if not (0 <= i < len(cand)):
            sys.exit(f"序号超出范围（候选共 {len(cand)} 条）")
        line = cand.pop(i)
        local = [l for l in _read_lines(config.GLOSSARY_LOCAL)
                 if l.split(SEP, 1)[0].strip() != line.split(SEP, 1)[0].strip()]
        _write_lines(config.GLOSSARY_LOCAL, local + [line])
        _write_lines(config.GLOSSARY_CAND, cand)
        print(f"已提升进本地词典（热生效）：{line}")
    elif cmd == "drop" and len(args) == 2:
        cand = _read_lines(config.GLOSSARY_CAND)
        i = int(args[1]) - 1
        if not (0 <= i < len(cand)):
            sys.exit(f"序号超出范围（候选共 {len(cand)} 条）")
        print(f"已丢弃：{cand.pop(i)}")
        _write_lines(config.GLOSSARY_CAND, cand)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
