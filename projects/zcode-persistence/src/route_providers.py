#!/usr/bin/env python3
"""把所有 ZCode 模型 provider 的 baseUrl 改成走本地重试代理（V0.2.6）。

做法：baseUrl 改写为

    http://127.0.0.1:8787/p/<base64url(原始 baseUrl)>

代理从路径里解出原始地址再转发。任意中转/厂商都适用，新增 provider 不用改
代理代码；原始地址记录在 sidecar 文件里，可一键还原。

用法：
  python route_providers.py            # 迁移（幂等）
  python route_providers.py --dry-run  # 只打印将要做的改动
  python route_providers.py --restore  # 还原到迁移前的 baseUrl

默认改 ~/.zcode/v2/provider_config.json；测试可用 ZCODE_PROVIDER_CONFIG 覆盖。
运行前会自动备份为 provider_config.json.bak-<时间戳>。
"""

import base64
import json
import os
import shutil
import sys
import time
import urllib.parse

PROXY_BASE = "http://127.0.0.1:8787"
DEFAULT_CONFIG = os.path.join(
    os.path.expanduser("~"), ".zcode", "v2", "provider_config.json")
CONFIG = os.environ.get("ZCODE_PROVIDER_CONFIG") or DEFAULT_CONFIG
ORIGINS = CONFIG + ".proxy-origins.json"


def encode_base(url):
    "把原始 baseUrl 编成 URL 安全的 base64（去掉 = 填充）。"
    return base64.urlsafe_b64encode(url.encode("utf-8")).decode("ascii").rstrip("=")


def proxy_url(url):
    "原始 baseUrl -> 本地代理 URL。"
    return PROXY_BASE + "/p/" + encode_base(url.rstrip("/"))


def _usable_base(url):
    """只迁移能安全转发的地址；返回规范化后的 baseUrl，或 None。

    非 http(s)、没有主机、端口非法的地址编码成 /p 后代理只会回 400，
    而且客户端会当成可重试错误白跑满整个窗口，所以直接跳过并告警。
    """
    try:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return None
        if parts.username or parts.password:
            # 代理不会把 userinfo 转成 Authorization，迁移后必然 401。
            return None
        if parts.port is not None and not (0 < parts.port < 65536):
            return None
    except Exception:
        return None
    return url.rstrip("/")


def _points_to_proxy(url):
    "解析后比较 host+port，避免 8787.example.com / :87870 被误判。"
    try:
        parts = urllib.parse.urlsplit(url)
        return parts.hostname == "127.0.0.1" and parts.port == 8787
    except Exception:
        return False


def _rules(doc):
    return (doc.get("config", {})
               .get("providerConfigRules", {})
               .get("providerRules", []) or [])


def _save(path, doc):
    "原子写：先写临时文件再替换，避免断电/崩溃留下半个 JSON。"
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _backup():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dst = CONFIG + ".bak-" + stamp
    i = 1
    while os.path.exists(dst):
        # 同一秒内连续调用（脚本 + 自动迁移）不能互相覆盖备份。
        dst = CONFIG + ".bak-%s-%d" % (stamp, i)
        i += 1
    shutil.copyfile(CONFIG, dst)
    return dst


def route_all(dry_run=False, verbose=True):
    """返回 (changed, skipped, backup_path)。重复执行不会重复改写。"""
    if not os.path.exists(CONFIG):
        if verbose:
            print("provider 配置不存在，跳过:", CONFIG)
        return 0, 0, None
    with open(CONFIG, encoding="utf-8") as fh:
        doc = json.load(fh)
    origins = {}
    if os.path.exists(ORIGINS):
        try:
            with open(ORIGINS, encoding="utf-8") as fh:
                origins = json.load(fh)
        except Exception:
            origins = {}

    changed = skipped = 0
    for rule in _rules(doc):
        api = rule.get("config", {}).get("api") or {}
        base = api.get("baseUrl") or ""
        pid = rule.get("providerId") or "?"
        if not base:
            skipped += 1
            continue
        if _points_to_proxy(base):
            # 已在代理上（/p、/ap、/cm、/cg）；不重复编码。
            skipped += 1
            continue
        clean = _usable_base(base)
        if clean is None:
            skipped += 1
            if verbose:
                print("skip  %-16s 地址不可用: %r" % (pid, base))
            continue
        origins[pid] = clean
        api["baseUrl"] = proxy_url(clean)
        changed += 1
        if verbose:
            print("route %-16s %s -> %s" % (pid, base, api["baseUrl"]))

    if not changed:
        if verbose:
            print("没有需要迁移的 provider（已全部走代理）")
        return 0, skipped, None

    if dry_run:
        if verbose:
            print("dry-run：未写入", CONFIG)
        return changed, skipped, None

    bak = _backup()
    # 先写 sidecar 再改配置：sidecar 多一条记录无害（restore 会校验当前
    # baseUrl 是否真在 /p 上），反过来配置已改而 sidecar 写失败就永久
    # 失去还原依据，只剩手工翻 .bak。
    _save(ORIGINS, origins)
    _save(CONFIG, doc)
    if verbose:
        print("已迁移 %d 个 provider，备份 %s" % (changed, bak))
    return changed, skipped, bak


def restore(dry_run=False, verbose=True):
    "按 sidecar 里记录的原地址还原；没有记录就什么都不做。"
    if not os.path.exists(CONFIG) or not os.path.exists(ORIGINS):
        if verbose:
            print("没有可还原的记录")
        return 0
    with open(CONFIG, encoding="utf-8") as fh:
        doc = json.load(fh)
    with open(ORIGINS, encoding="utf-8") as fh:
        origins = json.load(fh)
    changed = 0
    for rule in _rules(doc):
        pid = rule.get("providerId")
        api = rule.get("config", {}).get("api") or {}
        if pid in origins and _points_to_proxy(api.get("baseUrl") or ""):
            api["baseUrl"] = origins[pid]
            changed += 1
            if verbose:
                print("restore %-16s -> %s" % (pid, origins[pid]))
    if not changed or dry_run:
        if verbose:
            print("dry-run：未写入" if dry_run else "没有需要还原的 provider")
        return changed
    bak = _backup()
    _save(CONFIG, doc)
    if verbose:
        print("已还原 %d 个 provider，备份 %s" % (changed, bak))
    return changed


def main(argv):
    dry = "--dry-run" in argv
    if "--restore" in argv:
        restore(dry_run=dry)
    else:
        route_all(dry_run=dry)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
