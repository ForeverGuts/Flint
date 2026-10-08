"""语料清单 —— 遍历 vault，按黑名单过滤，产出 manifest.json。

口径承诺：manifest 里的篇数就是「自建笔记」数，预期与笔记库门禁口径(283)一致；
不一致时先查黑名单，不许改数字凑数。
"""
import json
import sys
from datetime import datetime

import config


def in_corpus(rel_path: str) -> bool:
    """判定一个相对路径是否属于自建域。黑名单是白纸黑字的配置，不是拍脑袋。"""
    parts = rel_path.replace("\\", "/").split("/")
    name = parts[-1]
    for p in parts[:-1]:
        if p in config.BLACKLIST_DIRS:
            return False
        if any(tag in p for tag in config.BLACKLIST_NAME_CONTAINS):
            return False
    if name in config.EXCLUDE_FILES or name == "SKILL.md":
        return False
    return name.endswith(".md")


def build_manifest() -> dict:
    files = []
    for p in sorted(config.VAULT.rglob("*.md")):
        rel = p.relative_to(config.VAULT).as_posix()
        if in_corpus(rel):
            files.append(rel)
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "vault": str(config.VAULT),
        "total": len(files),
        "files": files,
    }


def main() -> None:
    m = build_manifest()
    config.MANIFEST.write_text(
        json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
    # 按一级目录分组报告，肉眼可核对口径
    by_top: dict[str, int] = {}
    for f in m["files"]:
        top = f.split("/")[0]
        by_top[top] = by_top.get(top, 0) + 1
    print(f"自建语料：{m['total']} 篇 → {config.MANIFEST}")
    for top, n in sorted(by_top.items(), key=lambda x: -x[1]):
        print(f"  {n:>4}  {top}")
    if m["total"] == 0:
        print("!! 清单为空，检查 VAULT 路径与黑名单", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
