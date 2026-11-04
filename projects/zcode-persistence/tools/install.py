#!/usr/bin/env python3
"""安装器：把重试钩子（可选：本地重试代理）装进 ZCode。

用法:
    python install.py                                   # 只装钩子，不动 provider
    python install.py --with-proxy --provider-id new-provider
    python install.py --with-proxy --provider-id new-provider \
        --original-base-url https://api.example.com/v1   # 手工补记原始地址（修复用）
    python install.py --prefix "D:\\somewhere"

设计原则:
- 先校验后落盘：所有前置条件在写任何配置之前检查完，不会留半成品。
- 幂等：重复运行不重复加钩子；provider 已经是代理地址时默认不再切；
      显式指定不同前缀且已有原始地址记录时执行纠正，缺记录则拒绝（校验阶段即退出）。
- 可回滚：每次真正改动前备份，install-state.json 记录足够的还原信息。
- 钩子匹配按脚本 basename 精确相等，不做子串匹配。
"""

import argparse
import json
import os
import shutil
import sys
import time
import urllib.parse

VERSION = "0.2.8"
DEFAULT_PREFIX = r"C:\Program Files (x86)\AI\Zcode-Persistence"
PROXY_HOST = "127.0.0.1:8787"
PROXY_PORT = int(PROXY_HOST.rsplit(":", 1)[1])
PREFIXES = {"ap": "http://%s/ap/v1" % PROXY_HOST, "cm": "http://%s/cm/v1" % PROXY_HOST}

HOOK_SCRIPT = "retry_hook.py"
ENSURE_SCRIPT = "ensure_proxy.py"
PROXY_SCRIPT = "retry_proxy.py"
WATCH_SCRIPT = "error_watch.py"
ROUTE_SCRIPT = "route_providers.py"

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), "src")


def die(msg):
    "校验阶段失败：打印原因并退出，此时尚未写任何文件。"
    print("错误: " + msg)
    sys.exit(1)


# 下面几个小工具（home/load_json/save_json/backup/script_basename）与 uninstall.py
# 里的是刻意重复的：两个脚本互为对方的"撤销"手段，不能互相 import；抽成公共模块
# 又会多一个必须随包复制的文件，漏拷一个两个都不能用。几十行重复换这个确定性值。
def points_to_proxy(url):
    """baseUrl 是否恰好指向本地代理。

    必须解析后比较 host+port：字符串包含判断会把 `127.0.0.1:87870` 或
    `http://127.0.0.1:8787.example.com` 也当成代理地址。
    """
    try:
        parts = urllib.parse.urlsplit(url)
        return parts.hostname == "127.0.0.1" and parts.port == PROXY_PORT
    except Exception:
        return False


def home(*parts):
    "拼 ~ 下的路径。"
    return os.path.join(os.path.expanduser("~"), *parts)


def load_json(path):
    "读 JSON。文件不存在或内容损坏都会抛异常，由调用方决定怎么报错。"
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save_json(path, data):
    "原子写 JSON（先 .tmp 再 replace）。"
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def backup(path):
    """备份。同一秒内重复调用会追加序号，不覆盖。"""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dst = path + ".bak-" + stamp
    i = 1
    while os.path.exists(dst):
        dst = path + ".bak-%s-%d" % (stamp, i)
        i += 1
    shutil.copy2(path, dst)
    return dst


def script_basename(hook):
    """取出钩子实际执行的脚本文件名。"""
    cmd = hook.get("command") or ""
    args = hook.get("args") or []
    for cand in list(args) + [cmd]:
        if isinstance(cand, str) and cand.lower().endswith(".py"):
            return os.path.basename(cand).lower()
    return os.path.basename(cmd).lower()


def ensure_hook(events, event, script, command, args, matcher, timeout_ms, status):
    """保证 event 下存在指向该脚本的钩子，且参数与本次安装一致。

    已存在但路径/matcher/超时不符时就地改写 —— 换 --prefix 重装时最容易踩的坑，
    旧钩子会一直指向旧目录，而 doctor 只看 basename 还会说"已注册"。
    返回是否发生了改动。
    """
    groups = events.setdefault(event, [])
    target = script.lower()
    for group in groups:
        for hook in group.get("hooks", []) or []:
            if script_basename(hook) != target:
                continue
            changed = False
            if hook.get("command") != command:
                hook["command"] = command
                changed = True
            if list(hook.get("args") or []) != list(args):
                hook["args"] = list(args)
                changed = True
            if timeout_ms and hook.get("timeoutMs") != timeout_ms:
                hook["timeoutMs"] = timeout_ms
                changed = True
            if status and hook.get("statusMessage") != status:
                hook["statusMessage"] = status
                changed = True
            if matcher and group.get("matcher") != matcher:
                group["matcher"] = matcher
                changed = True
            return changed
    entry = {"type": "process", "command": command, "args": list(args)}
    if timeout_ms:
        entry["timeoutMs"] = timeout_ms
    if status:
        entry["statusMessage"] = status
    group = {"hooks": [entry]}
    if matcher:
        group["matcher"] = matcher
    groups.append(group)
    return True


def find_hooks(events, script, only_event=None):
    """返回 [(event_name, group_index, hook_index)]，按 basename 精确匹配。

    only_event 指定时只查该事件，避免钩子挂错事件时被误判为"已安装"。
    """
    target = script.lower()
    found = []
    for ev_name, groups in events.items():
        if only_event and ev_name != only_event:
            continue
        if not isinstance(groups, list):
            continue
        for gi, group in enumerate(groups):
            for hi, hook in enumerate(group.get("hooks", []) or []):
                if script_basename(hook) == target:
                    found.append((ev_name, gi, hi))
    return found


def pick_prefix(original_base_url, explicit):
    """决定切到哪个上游前缀。

    显式参数优先；否则按原始地址识别；判断不出来返回 None，
    由调用方报错，绝不静默默认成某个上游（那会把 A 通道的请求发到 B 通道）。
    """
    if explicit:
        return explicit
    url = (original_base_url or "").lower()
    if "upstream-b.example.com" in url:
        return "cm"
    if "upstream-a.example.com" in url:
        return "ap"
    return None


def main():
    "安装入口：阶段 1 全部校验 → 阶段 2 复制脚本 → 阶段 3 钩子 → 阶段 4 provider → 阶段 5 记录状态。"
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", default=DEFAULT_PREFIX, help="脚本安装目录")
    ap.add_argument("--with-proxy", action="store_true", help="把 provider 切到本地重试代理")
    ap.add_argument("--provider-id", default="new-provider", help="要切换到代理的 provider id")
    ap.add_argument("--proxy-prefix", default=None, choices=sorted(PREFIXES),
                    help="上游前缀；省略时按原始地址自动识别（upstream-b.example.com->cm, upstream-a.example.com->ap）")
    ap.add_argument("--original-base-url", default=None,
                    help="手工指定该 provider 的原始地址（修复缺失的回滚记录时用）")
    args = ap.parse_args()

    config_path = home(".zcode", "cli", "config.json")
    provider_path = home(".zcode", "v2", "provider_config.json")
    prefix = args.prefix
    state_path = os.path.join(prefix, "install-state.json")

    # ---------- 阶段 1：全部校验，不写盘 ----------
    if not os.path.exists(config_path):
        die("找不到 " + config_path)
    for name in (HOOK_SCRIPT, ENSURE_SCRIPT, PROXY_SCRIPT, WATCH_SCRIPT, ROUTE_SCRIPT):
        if not os.path.exists(os.path.join(SRC, name)):
            die("找不到源文件 " + os.path.join(SRC, name))

    try:
        cfg = load_json(config_path)
    except Exception as exc:
        die("配置文件无法解析 %s（%s）。未做任何改动" % (config_path, exc))
    events = cfg.setdefault("hooks", {}).setdefault("events", {})

    state = {}
    if os.path.exists(state_path):
        try:
            state = load_json(state_path)
        except Exception:
            state = {}

    provider_rule = None
    if args.with_proxy:
        if not os.path.exists(provider_path):
            die("找不到 " + provider_path + "，未做任何改动")
        try:
            pc = load_json(provider_path)
        except Exception as exc:
            die("provider 配置无法解析 %s（%s）。未做任何改动" % (provider_path, exc))
        rules = pc.get("config", {}).get("providerConfigRules", {}).get("providerRules", [])
        provider_rule = next((r for r in rules if r.get("providerId") == args.provider_id), None)
        if provider_rule is None:
            ids = [r.get("providerId") for r in rules]
            die("找不到 providerId=%s（现有: %s），未做任何改动" % (args.provider_id, ids))
        current_url = (provider_rule.get("config", {}).get("api", {}) or {}).get("baseUrl") or ""
        planned_prefix = None
        if not points_to_proxy(current_url):
            planned_prefix = pick_prefix(args.original_base_url or current_url, args.proxy_prefix)
            if planned_prefix is None:
                die("无法从原始地址判断该用哪个上游前缀（%s）。"
                    "请显式指定 --proxy-prefix cm 或 --proxy-prefix ap；"
                    "任意中转可改用 python src/route_providers.py 迁移。"
                    "未做任何改动。" % current_url)
        elif args.proxy_prefix:
            # 已指向代理且显式要求不同前缀：这是"纠正切错的上游"。
            # 必须在此处（写盘之前）确认有原始地址记录，否则拒绝。
            requested = PREFIXES[args.proxy_prefix]
            if requested != current_url:
                rec = (state.get("providers") or {}).get(args.provider_id) or {}
                if not (rec.get("originalBaseUrl") or args.original_base_url):
                    die("当前已指向代理但缺少原始地址记录，无法安全纠正前缀。"
                        "请先运行 uninstall.py 还原，或加 --original-base-url 补记。"
                        "未做任何改动。")

    # ---------- 阶段 2：复制脚本 ----------
    os.makedirs(prefix, exist_ok=True)
    placed = []
    for name in (HOOK_SCRIPT, ENSURE_SCRIPT, PROXY_SCRIPT, WATCH_SCRIPT, ROUTE_SCRIPT):
        shutil.copy2(os.path.join(SRC, name), os.path.join(prefix, name))
        placed.append(name)
    # doctor 也放一份到安装目录，否则安装完成后的提示路径不存在
    doctor_src = os.path.join(os.path.dirname(HERE), "tools", "doctor.py")
    if os.path.exists(doctor_src):
        shutil.copy2(doctor_src, os.path.join(prefix, "doctor.py"))
        placed.append("doctor.py")
    # 换进程脚本也要落在安装目录：文档里的重启命令指的是这里，不在包外找
    restart_src = os.path.join(os.path.dirname(HERE), "tools", "restart_proxy_idle.py")
    if os.path.exists(restart_src):
        shutil.copy2(restart_src, os.path.join(prefix, "restart_proxy_idle.py"))
        placed.append("restart_proxy_idle.py")
    readme_src = os.path.join(os.path.dirname(HERE), "README.md")
    if os.path.exists(readme_src):
        shutil.copy2(readme_src, os.path.join(prefix, "README.md"))
        placed.append("README.md")
    # VERSION 也要落盘：doctor 用它和 /__zp_health 的运行版本对比，
    # 抓“装了新版但旧代理进程还在跑”。
    version_src = os.path.join(os.path.dirname(SRC), "VERSION")
    if os.path.exists(version_src):
        shutil.copy2(version_src, os.path.join(prefix, "VERSION"))
        placed.append("VERSION")
    print("[1/4] 脚本已复制到 " + prefix)

    py = sys.executable

    # ---------- 阶段 3：钩子 ----------
    changed_events = []
    # 主挂载点：PostToolUse。实测本客户端对"被中断/超时"的工具调用不派发
    # PostToolUseFailure，只有 PostToolUse 一定会来，并且带 exitCode/timedOut/stderr。
    if ensure_hook(events, "PostToolUse", HOOK_SCRIPT, py,
                   [os.path.join(prefix, HOOK_SCRIPT)], "Bash", 5000, "检查是否可重试"):
        changed_events.append("PostToolUse")

    # 兜底挂载点：工具抛异常、根本没有 toolResponse 时靠它
    if ensure_hook(events, "PostToolUseFailure", HOOK_SCRIPT, py,
                   [os.path.join(prefix, HOOK_SCRIPT)], "Bash", 5000, "检查是否可重试"):
        changed_events.append("PostToolUseFailure")

    if ensure_hook(events, "SessionStart", ENSURE_SCRIPT, py,
                   [os.path.join(prefix, ENSURE_SCRIPT)], None, 8000, "检查重试代理"):
        changed_events.append("SessionStart")

    cfg_bak = None
    if changed_events:
        cfg_bak = backup(config_path)
        save_json(config_path, cfg)
        print("[2/4] 已注册钩子: " + ", ".join(changed_events))
        print("      配置备份: " + cfg_bak)
    else:
        print("[2/4] 钩子已存在，跳过写入")

    # ---------- 阶段 4：provider ----------
    providers_state = state.get("providers", {})
    p_bak = None
    if args.with_proxy:
        api = provider_rule.setdefault("config", {}).setdefault("api", {})
        current = api.get("baseUrl") or ""
        record = providers_state.get(args.provider_id) or {}

        if points_to_proxy(current):
            # 已经是代理地址：默认不重复切，也不覆盖已记录的原始地址。
            # 但若显式指定了不同前缀，说明是要纠正之前切错的上游，此时执行切换。
            requested = PREFIXES[args.proxy_prefix] if args.proxy_prefix else None
            original = record.get("originalBaseUrl") or args.original_base_url
            if requested and requested != current and not original:
                # 异常路径（阶段 1 本应拦住）：宁可不改，也不留下无法还原的改动
                target = current
                print("[警告] 该 provider 已在代理地址且缺少原始地址记录，"
                      "跳过前缀纠正。请用 --original-base-url 补记后重跑。")
            elif requested and requested != current:
                api["baseUrl"] = requested
                p_bak = backup(provider_path)
                save_json(provider_path, pc)
                target = requested
                print("[3/4] 按显式前缀纠正: %s -> %s" % (current, requested))
                print("      配置备份: " + p_bak)
            else:
                target = current
                print("[3/4] provider 已指向代理，无需切换: " + current)
        else:
            target = PREFIXES[planned_prefix]
            original = args.original_base_url or current
            api["baseUrl"] = target
            p_bak = backup(provider_path)
            save_json(provider_path, pc)
            print("[3/4] provider %s: %s -> %s" % (args.provider_id, current, target))
            print("      配置备份: " + p_bak)

        if original:
            providers_state[args.provider_id] = {
                "originalBaseUrl": original,
                "proxyBaseUrl": target,
            }
        else:
            providers_state.setdefault(args.provider_id, {})
            providers_state[args.provider_id].update({"proxyBaseUrl": target})
            print("      提示: 该 provider 已在代理地址且 install-state 没有原始地址记录。"
                  "如果它是 route_providers.py 做的 /p 迁移，uninstall 会按 sidecar 还原；"
                  "否则请用 --original-base-url 补记，或参考 " + (p_bak or "历史 .bak 备份"))
    else:
        print("[3/4] 未启用代理（如需自动重发请加 --with-proxy）")

    # ---------- 阶段 5：记录状态（记录"实际存在"，不是"本次改动"）----------
    present_hooks = sorted({ev for ev, _, _ in
                            find_hooks(events, HOOK_SCRIPT) + find_hooks(events, ENSURE_SCRIPT)})
    state.update({
        "version": VERSION,
        "prefix": prefix,
        "python": py,
        "installedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "files": placed,
        "hooks": present_hooks,
        "providers": providers_state,
    })
    save_json(state_path, state)
    print("[4/4] 安装状态写入 " + state_path)
    print("\n完成。请新开一个 ZCode 会话使配置生效。")
    print("健康检查: python " + os.path.join(prefix, "doctor.py"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
