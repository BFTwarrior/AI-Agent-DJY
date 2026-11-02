#!/usr/bin/env python3
"""自检：provider 全量迁移（V0.2.6）。

验证：
  1. 远程 baseUrl 改写成 http://127.0.0.1:8787/p/<b64>，编码可还原
  2. 已在代理上的 provider（含无尾斜杠的 8787）不重复改写
  3. 没有 baseUrl / 非 http(s) / 无主机 的规则跳过
  4. 迁移写 sidecar 原始地址表，并生成备份
  5. 第二次迁移 changed=0（幂等）
  6. --restore 按 sidecar 还原
  7. 代理不支持 /p（旧进程）时自动迁移必须什么都不改
  8. 代理支持 /p 且 root 存在并一致时才自动迁移（health 不通/root 空/root 不符都不改）
  9. uninstall.py 能读 sidecar 还原 /p 迁移（dry-run 不写）

用法：python tools/selftest_route.py [--src <src目录>]
"""

import argparse
import base64
import json
import os
import shutil
import sys
import tempfile

# 这个自检会 import src/ 里的模块；不要在发布目录里生成 __pycache__。
sys.dont_write_bytecode = True


def write_cfg(path, rules):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"config": {"providerConfigRules": {"providerRules": rules}}},
                  fh, ensure_ascii=False, indent=2)


def read_cfg(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def rules_of(doc):
    return doc["config"]["providerConfigRules"]["providerRules"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
    args = ap.parse_args()

    work = tempfile.mkdtemp(prefix="routetest-")
    cfg = os.path.join(work, "provider_config.json")
    write_cfg(cfg, [
        {"providerId": "remote", "config": {"api": {
            "type": "openai-chat-completions",
            "baseUrl": "https://api.example.com/v1"}}},
        {"providerId": "already", "config": {"api": {
            "type": "openai-chat-completions",
            "baseUrl": "http://127.0.0.1:8787/ap/v1"}}},
        {"providerId": "proxy-root", "config": {"api": {
            "type": "openai-chat-completions",
            "baseUrl": "http://127.0.0.1:8787"}}},
        {"providerId": "ftp", "config": {"api": {
            "type": "openai-chat-completions", "baseUrl": "ftp://x/v1"}}},
        {"providerId": "no-host", "config": {"api": {
            "type": "openai-chat-completions", "baseUrl": "http://"}}},
        {"providerId": "leading-zero", "config": {"api": {
            "type": "openai-chat-completions",
            "baseUrl": "http://127.0.0.1:08787/v1"}}},
        {"providerId": "bad-port", "config": {"api": {
            "type": "openai-chat-completions",
            "baseUrl": "http://h:99999/v1"}}},
        {"providerId": "userinfo", "config": {"api": {
            "type": "openai-chat-completions",
            "baseUrl": "http://u:p@h/v1"}}},
        {"providerId": "empty", "config": {"api": {
            "type": "openai-chat-completions"}}},
    ])

    old_env = os.environ.get("ZCODE_PROVIDER_CONFIG")
    os.environ["ZCODE_PROVIDER_CONFIG"] = cfg
    sys.path.insert(0, args.src)
    try:
        import route_providers as rp

        changed, skipped, bak = rp.route_all(verbose=False)
        pass1 = changed == 1 and skipped == 8 and bak and os.path.exists(bak)

        rules = {r["providerId"]: r for r in rules_of(read_cfg(cfg))}
        remote = rules["remote"]["config"]["api"]["baseUrl"]
        token = remote.split("/p/", 1)[1]
        decoded = base64.urlsafe_b64decode(
            token + "=" * (-len(token) % 4)).decode("utf-8")
        pass2 = (remote.startswith("http://127.0.0.1:8787/p/")
                 and decoded == "https://api.example.com/v1")
        pass3 = rules["already"]["config"]["api"]["baseUrl"] == "http://127.0.0.1:8787/ap/v1"
        pass3b = rules["proxy-root"]["config"]["api"]["baseUrl"] == "http://127.0.0.1:8787"
        pass3c = (rules["ftp"]["config"]["api"]["baseUrl"] == "ftp://x/v1"
                  and rules["no-host"]["config"]["api"]["baseUrl"] == "http://"
                  and rules["bad-port"]["config"]["api"]["baseUrl"] == "http://h:99999/v1"
                  and rules["userinfo"]["config"]["api"]["baseUrl"] == "http://u:p@h/v1")
        # 端口写成 08787：解析后就是 8787，必须跳过；字符串前缀
        # "http://127.0.0.1:8787/" 判断不到它，会错误地再包一层 /p。
        pass3d = (rules["leading-zero"]["config"]["api"]["baseUrl"]
                  == "http://127.0.0.1:08787/v1")

        with open(cfg + ".proxy-origins.json", encoding="utf-8") as fh:
            origins = json.load(fh)
        pass4 = origins.get("remote") == "https://api.example.com/v1"

        changed2, _, _ = rp.route_all(verbose=False)
        pass5 = changed2 == 0

        restored = rp.restore(verbose=False)
        rules = {r["providerId"]: r for r in rules_of(read_cfg(cfg))}
        pass6 = (restored == 1
                 and rules["remote"]["config"]["api"]["baseUrl"]
                 == "https://api.example.com/v1")

        # 7/8) 自动迁移的门槛：旧代理（无 p_route）必须跳过；新代理且 root
        #      一致才执行。否则升级瞬间会把 provider 指向不认识 /p 的旧进程。
        import ensure_proxy
        cfg2 = os.path.join(work, "auto.json")
        rp.CONFIG = cfg2
        rp.ORIGINS = cfg2 + ".proxy-origins.json"
        write_cfg(cfg2, [{"providerId": "auto", "config": {"api": {
            "type": "openai-chat-completions",
            "baseUrl": "https://auto.example.com/v1"}}}])

        orig_health = ensure_proxy.health_info
        orig_log = ensure_proxy.LOG
        # note() 默认写到脚本同目录的 proxy.log；测试必须重定向，
        # 否则每跑一次自检就往发布目录里追加几行日志。
        ensure_proxy.LOG = os.path.join(work, "ensure.log")
        try:
            ensure_proxy.health_info = lambda: {
                "name": "Zcode-Persistence", "features": [], "root": ensure_proxy.HERE}
            ensure_proxy.route_providers_if_ready()
            after_old = rules_of(read_cfg(cfg2))[0]["config"]["api"]["baseUrl"]
            pass7 = after_old == "https://auto.example.com/v1"

            pass7b = True
            for bad_health in (
                    None,
                    {"name": "Zcode-Persistence", "features": ["p_route"], "root": ""},
                    {"name": "Zcode-Persistence", "features": ["p_route"],
                     "root": os.path.join(work, "other")}):
                ensure_proxy.health_info = lambda h=bad_health: h
                ensure_proxy.route_providers_if_ready()
                if (rules_of(read_cfg(cfg2))[0]["config"]["api"]["baseUrl"]
                        != "https://auto.example.com/v1"):
                    pass7b = False
                    break

            ensure_proxy.health_info = lambda: {
                "name": "Zcode-Persistence", "features": ["p_route"],
                "root": ensure_proxy.HERE}
            ensure_proxy.route_providers_if_ready()
            after_new = rules_of(read_cfg(cfg2))[0]["config"]["api"]["baseUrl"]
            pass8 = after_new.startswith("http://127.0.0.1:8787/p/")
        finally:
            ensure_proxy.health_info = orig_health
            ensure_proxy.LOG = orig_log

        # 9) 卸载链路：uninstall.py 必须能读 sidecar 还原 /p 迁移。
        #    用临时 USERPROFILE 跑真实脚本，不碰本机配置。
        import subprocess
        fake_home = os.path.join(work, "home")
        os.makedirs(os.path.join(fake_home, ".zcode", "cli"))
        os.makedirs(os.path.join(fake_home, ".zcode", "v2"))
        with open(os.path.join(fake_home, ".zcode", "cli", "config.json"),
                  "w", encoding="utf-8") as fh:
            json.dump({"hooks": {"events": {}}}, fh)
        orig_url = "https://orig.example.com/v1"
        pcfg = os.path.join(fake_home, ".zcode", "v2", "provider_config.json")
        write_cfg(pcfg, [{"providerId": "gone", "config": {"api": {
            "type": "openai-chat-completions",
            "baseUrl": rp.proxy_url(orig_url)}}}])
        with open(pcfg + ".proxy-origins.json", "w", encoding="utf-8") as fh:
            json.dump({"gone": orig_url}, fh)
        env = dict(os.environ, USERPROFILE=fake_home, HOME=fake_home)
        uninstall = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "uninstall.py")
        inst = os.path.join(work, "inst")
        os.makedirs(inst, exist_ok=True)
        dry = subprocess.run([sys.executable, uninstall, "--prefix", inst,
                              "--dry-run"], env=env, capture_output=True, text=True)
        unchanged = (rules_of(read_cfg(pcfg))[0]["config"]["api"]["baseUrl"]
                     == rp.proxy_url(orig_url))
        real = subprocess.run([sys.executable, uninstall, "--prefix", inst],
                              env=env, capture_output=True, text=True)
        restored_url = rules_of(read_cfg(pcfg))[0]["config"]["api"]["baseUrl"]
        backups = [n for n in os.listdir(os.path.dirname(pcfg))
                   if n.startswith("provider_config.json.bak-")]
        pass9 = (dry.returncode == 0 and "按 /p 迁移记录还原" in dry.stdout
                 and unchanged
                 and real.returncode == 0 and restored_url == orig_url
                 and bool(backups))

        print("== provider 全量迁移")
        print("   首次迁移=%s 编码还原=%s 已代理不重复=%s 根地址不重复=%s 坏地址跳过=%s 前导零不误迁移=%s"
              % (pass1, pass2, pass3, pass3b, pass3c, pass3d))
        print("   sidecar=%s 幂等=%s 还原=%s 旧代理不改=%s 不健康/坏root不改=%s 新代理迁移=%s 卸载可还原=%s"
              % (pass4, pass5, pass6, pass7, pass7b, pass8, pass9))
        ok = all((pass1, pass2, pass3, pass3b, pass3c, pass3d,
                  pass4, pass5, pass6, pass7, pass7b, pass8, pass9))
    finally:
        if old_env is None:
            os.environ.pop("ZCODE_PROVIDER_CONFIG", None)
        else:
            os.environ["ZCODE_PROVIDER_CONFIG"] = old_env
        shutil.rmtree(work, ignore_errors=True)

    print("   判定:", "PASS" if ok else "FAIL")
    print("总体:", "全部通过" if ok else "有失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
