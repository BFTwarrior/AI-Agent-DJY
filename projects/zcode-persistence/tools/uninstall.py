#!/usr/bin/env python3
"""卸载器：撤销 install.py 的改动。

用法:
    python uninstall.py             # 移除钩子、还原 provider 地址，保留脚本
    python uninstall.py --purge     # 额外删除安装目录并结束代理进程
    python uninstall.py --dry-run   # 只报告将做什么，不写盘

还原依据 install-state.json：
- 钩子按脚本 basename 精确匹配，只删命中的具体 hook，不整组删除。
- provider 只在当前地址仍是代理地址时还原，避免覆盖你后来的手动修改。
- 若 provider 指向代理但缺少原始地址记录，会明确警告并列出可用的 .bak 备份，
  不会静默跳过。
"""

import argparse
import json
import os
import shutil
import sys
import time

PROXY_HOST = "127.0.0.1:8787"


# 下面几个小工具（home/load_json/save_json/backup/script_basename）与 install.py
# 里的是刻意重复的：两个脚本互为对方的"撤销"手段，不能互相 import；抽成公共模块
# 又会多一个必须随包复制的文件，漏拷一个两个都不能用。几十行重复换这个确定性值。
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
    "改动前备份配置文件，返回备份路径。"
    dst = path + ".bak-uninstall-" + time.strftime("%Y%m%d-%H%M%S")
    i = 1
    while os.path.exists(dst):
        dst = path + ".bak-uninstall-" + time.strftime("%Y%m%d-%H%M%S") + "-%d" % i
        i += 1
    shutil.copy2(path, dst)
    return dst


def script_basename(hook):
    "取 hook 指向的脚本名（先看 args，再看 command），用于按 basename 精确匹配。"
    cmd = hook.get("command") or ""
    args = hook.get("args") or []
    for cand in list(args) + [cmd]:
        if isinstance(cand, str) and cand.lower().endswith(".py"):
            return os.path.basename(cand).lower()
    return os.path.basename(cmd).lower()


def remove_hooks(events, scripts):
    """只删除 basename 精确匹配的 hook 条目；组变空才删组。返回删除数量。"""
    targets = {s.lower() for s in scripts}
    removed = 0
    for ev_name in list(events.keys()):
        groups = events.get(ev_name)
        if not isinstance(groups, list):
            continue
        kept_groups = []
        for group in groups:
            hooks = group.get("hooks")
            if not isinstance(hooks, list):
                kept_groups.append(group)
                continue
            kept_hooks = [h for h in hooks if script_basename(h) not in targets]
            removed += len(hooks) - len(kept_hooks)
            if kept_hooks:
                new_group = dict(group)
                new_group["hooks"] = kept_hooks
                kept_groups.append(new_group)
            # 组内 hook 全被删掉 → 整组丢弃
        if kept_groups:
            events[ev_name] = kept_groups
        else:
            events.pop(ev_name, None)
    return removed


def points_to_proxy(url, host_port=PROXY_HOST):
    "baseUrl 是否恰好指向本地代理（解析后比较 host+port，避免 87870 之类误判）。"
    import urllib.parse
    try:
        parts = urllib.parse.urlsplit(url)
        host, _, port = host_port.partition(":")
        return parts.hostname == host and parts.port == int(port)
    except Exception:
        return False


def proxy_listening():
    "PROXY_HOST 上是否有人在监听（不区分是不是我们的代理）。"
    import socket
    host, _, port = PROXY_HOST.partition(":")
    s = socket.socket(); s.settimeout(0.5)
    try:
        return s.connect_ex((host, int(port))) == 0
    finally:
        s.close()


def _terminate(pid, wait=5.0):
    """用 TerminateProcess 结束进程并确认它真的消失。

    不用 taskkill：2026-10-31 在这台机器上它返回过 0 却没有杀掉代理，
    结果卸载删了目录、进程还在跑。失败时回退到 taskkill 作为兜底。
    """
    import ctypes
    import time as _t
    try:
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        k.OpenProcess.restype = ctypes.c_void_p
        k.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        k.CloseHandle.argtypes = [ctypes.c_void_p]
        k.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        h = k.OpenProcess(0x0001 | 0x00100000, 0, int(pid))   # TERMINATE | SYNCHRONIZE
        if not h:
            raise OSError("OpenProcess failed")
        try:
            if not k.TerminateProcess(h, 1):
                raise OSError("TerminateProcess failed")
        finally:
            k.CloseHandle(h)
        end = _t.time() + wait
        while _t.time() < end:
            h = k.OpenProcess(0x1000, 0, int(pid))           # QUERY_LIMITED_INFORMATION
            if not h:
                return True
            code = ctypes.c_ulong()
            k.GetExitCodeProcess(h, ctypes.byref(code))
            k.CloseHandle(h)
            if code.value != 259:                            # STILL_ACTIVE
                return True
            _t.sleep(0.2)
        return False
    except Exception:
        import subprocess
        try:
            r = subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                               capture_output=True, timeout=15)
            return r.returncode == 0
        except Exception:
            return False


def kill_proxy():
    """在 PROXY_HOST 上结束监听进程（尽力而为，失败不报错）。"""
    import subprocess
    port = PROXY_HOST.rpartition(":")[2]
    if not proxy_listening():
        return False
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=15).stdout
        for line in out.splitlines():
            fields = line.split()
            # 按"本地地址的端口字段"精确比较：字符串包含会把 :87870 也匹配上
            if (len(fields) < 5 or fields[1].rsplit(":", 1)[-1] != port
                    or "LISTENING" not in line.upper()):
                continue
            pid = line.split()[-1]
            # 先确认这个进程确实是我们的代理，避免误杀占用同端口的其它服务
            info = ""
            try:
                info = subprocess.run(["wmic", "process", "where", "processid=%s" % pid,
                                       "get", "commandline"],
                                      capture_output=True, text=True, timeout=15).stdout
            except Exception:
                info = ""
            if "retry_proxy.py" not in info:
                # wmic 在部分 Windows 11 已移除，回退到 PowerShell
                try:
                    ps = subprocess.run(
                        ["powershell", "-NoProfile", "-Command",
                         "(Get-CimInstance Win32_Process -Filter \"ProcessId=%s\").CommandLine" % pid],
                        capture_output=True, text=True, timeout=20).stdout
                except Exception:
                    ps = ""
                info = ps or info
            if "retry_proxy.py" not in info:
                print("提示: %s 被其它进程占用（PID %s），未结束它" % (PROXY_HOST, pid))
                return False
            if not _terminate(pid):
                print("提示: 结束进程失败（PID %s），请手动结束它" % pid)
                return False
            return True
    except Exception:
        pass
    return False


def kill_watcher():
    """结束运行中的报错监听（它不监听端口，只能按命令行找）。

    只在命令行里含 error_watch.py 时才杀，避免误伤同名的其它脚本。
    返回是否结束了至少一个进程。
    """
    import subprocess
    killed = False
    try:
        ps = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process"
             " | Where-Object { $_.CommandLine -like '*error_watch.py*'"
             "   -and $_.Name -like 'python*' }"
             " | ForEach-Object { $_.ProcessId }"],
            capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return False
    for line in ps.split():
        if not line.strip().isdigit():
            continue
        if _terminate(line.strip()):
            killed = True
    return killed


def main():
    "卸载入口：移除三处钩子条目 → 条件还原 provider → 结束代理进程。"
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", default=r"C:\Program Files (x86)\AI\Zcode-Persistence")
    ap.add_argument("--purge", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    dry = args.dry_run

    prefix = args.prefix
    state_path = os.path.join(prefix, "install-state.json")
    state = {}
    if os.path.exists(state_path):
        try:
            state = load_json(state_path)
        except Exception:
            state = {}
    if state.get("prefix"):
        recorded = state["prefix"]
        # 只接受"看起来确实是本工具装出来的目录"的记录，防止状态文件被改坏/伪造后
        # 让 --purge 去 rmtree 一个无关目录（递归删除不可撤销）。
        looks_ours = all(os.path.exists(os.path.join(recorded, f))
                         for f in ("install-state.json", "retry_hook.py"))
        if looks_ours and os.path.abspath(recorded) != os.path.abspath(args.prefix):
            prefix = recorded
        elif not looks_ours:
            print("提示: 状态文件记录的目录 %s 不含本工具文件，已忽略" % recorded)

    config_path = home(".zcode", "cli", "config.json")
    provider_path = home(".zcode", "v2", "provider_config.json")

    # 1) 钩子
    if os.path.exists(config_path):
        try:
            cfg = load_json(config_path)
        except Exception as exc:
            print("错误: 配置文件无法解析 %s（%s），未做任何改动" % (config_path, exc))
            return 2
        events = cfg.get("hooks", {}).get("events", {})
        n = remove_hooks(events, ["retry_hook.py", "ensure_proxy.py"])
        if n:
            if dry:
                print("[dry] 将移除 %d 个钩子条目" % n)
            else:
                bak = backup(config_path)
                save_json(config_path, cfg)
                print("已移除 %d 个钩子条目，备份: %s" % (n, bak))
        else:
            print("钩子已不存在，跳过")
    else:
        print("找不到 " + config_path + "，跳过钩子")

    # 2) provider
    if os.path.exists(provider_path):
        try:
            pc = load_json(provider_path)
        except Exception as exc:
            print("错误: 配置文件无法解析 %s（%s），未做任何改动" % (provider_path, exc))
            return 2
        records = state.get("providers") or {}
        pending = []
        for rule in pc.get("config", {}).get("providerConfigRules", {}).get("providerRules", []):
            pid = rule.get("providerId")
            api = rule.setdefault("config", {}).setdefault("api", {})
            current = api.get("baseUrl") or ""
            if not points_to_proxy(current):
                continue
            rec = records.get(pid) or {}
            original = rec.get("originalBaseUrl")
            expected = rec.get("proxyBaseUrl")
            if original and expected and current == expected:
                pending.append((pid, current, original))
            elif original:
                print("警告: provider %s 当前地址 %s 与本包记录的 %s 不一致，可能已被手动修改，不自动还原。"
                      % (pid, current, expected))
            else:
                print("警告: provider %s 指向代理(%s)，但没有原始地址记录，无法自动还原。" % (pid, current))
                print("      请手动把 baseUrl 改回真实上游，或用 .bak 备份还原：")
                print("      " + provider_path + ".bak-*")

        if pending:
            if dry:
                for pid, cur, orig in pending:
                    print("[dry] 将把 provider %s 从 %s 还原为 %s" % (pid, cur, orig))
            else:
                for pid, cur, orig in pending:
                    for rule in pc["config"]["providerConfigRules"]["providerRules"]:
                        if rule.get("providerId") == pid:
                            rule["config"]["api"]["baseUrl"] = orig
                            print("provider %s 已还原为 %s" % (pid, orig))
                bak = backup(provider_path)
                save_json(provider_path, pc)
                print("  备份: " + bak)
        elif not records:
            print("提示: 安装状态里没有 provider 记录")

    # 3) 代理进程、报错监听与目录
    if args.purge:
        if dry:
            print("[dry] 将结束 %s 上的代理进程、运行中的报错监听，并删除目录 "
                  % PROXY_HOST + prefix)
        else:
            if kill_proxy():
                print("已结束代理进程")
            if kill_watcher():
                print("已结束报错监听")
            if os.path.isdir(prefix):
                shutil.rmtree(prefix, ignore_errors=True)
                print("已删除 " + prefix)
    else:
        if proxy_listening():
            print("提示: 代理仍在监听 %s，加 --purge 可一并结束" % PROXY_HOST)
        print("脚本文件保留在 " + prefix + "（加 --purge 可删除）")

    if dry:
        print("\n[dry] 未写入任何文件。")
    else:
        # 状态文件同步为"已卸载"，避免 doctor/uninstall 读到过期信息
        if os.path.exists(state_path):
            try:
                st = load_json(state_path)
                st["hooks"] = []
                st["providers"] = {}
                st["uninstalledAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
                save_json(state_path, st)
            except Exception:
                pass
        print("\n完成。请重新打开 ZCode 使配置生效。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
