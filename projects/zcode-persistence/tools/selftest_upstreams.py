#!/usr/bin/env python3
"""自检：本地 upstreams.json 的加载规则。

不启动代理，只按文件路径导入 `retry_proxy.py`，验证：
  1. 没有 upstreams.json 时保留占位默认值
  2. 文件可覆盖已有前缀（/ap）
  3. 文件可新增前缀（/xx），默认 scheme=https
  4. 非法条目（端口越界/长度不足）被忽略，不污染默认值
"""

import importlib.util
import json
import os
import shutil
import tempfile


def load_module(path, name):
    "按文件路径导入模块，避免依赖 sys.path。"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    "跑四项断言；全部通过退出码 0。"
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = os.path.join(here, "src", "retry_proxy.py")
    work = tempfile.mkdtemp(prefix="upstreams-test-")
    dst = os.path.join(work, "retry_proxy.py")
    shutil.copy2(src, dst)
    ok = True
    try:
        defaults = load_module(dst, "proxy_defaults")
        checks = [
            ("占位默认", defaults.UPSTREAMS["/ap"] == ("upstream-a.example.com", 443)),
        ]

        with open(os.path.join(work, "upstreams.json"), "w", encoding="utf-8") as fh:
            json.dump({
                "/ap": ["relay.local", 8443, "http"],
                "/xx": ["new.local", 443],
                "/cm": ["bad-port", 0],
                "/bad": ["only-host"],
            }, fh)
        local = load_module(dst, "proxy_local")
        checks.extend([
            ("覆盖 /ap", local.UPSTREAMS["/ap"] == ("relay.local", 8443, "http")),
            ("新增 /xx", local.UPSTREAMS["/xx"] == ("new.local", 443, "https")),
            ("非法条目被忽略", local.UPSTREAMS["/cm"] == ("upstream-b.example.com", 443)
             and "/bad" not in local.UPSTREAMS),
        ])
        for name, passed in checks:
            print("%-18s %s" % (name, "PASS" if passed else "FAIL"))
            ok = ok and passed
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print("\n总体:", "全部通过" if ok else "有失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
