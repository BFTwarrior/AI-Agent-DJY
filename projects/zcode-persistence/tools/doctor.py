#!/usr/bin/env python3
"""健康检查：一条命令看清当前安装状态。

    python doctor.py

输出每项 PASS / WARN / FAIL，末尾给总结。有 FAIL 时退出码 1。
"""

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse

PREFIX_DEFAULT = r"C:\Program Files (x86)\AI\Zcode-Persistence"
PORT = 8787

results = []


def add(level, title, detail=""):
    "记录并打印一条检查结果。"
    results.append((level, title, detail))
    print("[%s] %s%s" % (level, title, ("  — " + detail) if detail else ""))


def points_to_proxy(url):
    "baseUrl 是否恰好指向本地代理（解析后比较 host+port，避免 87870 之类误判）。"
    try:
        parts = urllib.parse.urlsplit(url)
        return parts.hostname == "127.0.0.1" and parts.port == PORT
    except Exception:
        return False


def is_our_proxy():
    "端口上的服务是不是本代理（/__zp_health 返回 name=Zcode-Persistence）。"
    try:
        s = socket.create_connection(("127.0.0.1", PORT), timeout=1.0)
        try:
            s.sendall(b"GET /__zp_health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            data = b""
            while True:
                chunk = s.recv(1024)
                if not chunk:
                    break
                data += chunk
        finally:
            s.close()
        info = json.loads(data.split(b"\r\n\r\n", 1)[-1].decode("utf-8", "replace"))
        return info.get("name") == "Zcode-Persistence"
    except Exception:
        return False


def count_listeners():
    """统计 8787 上的 LISTENING 进程数。

    Windows 的 SO_REUSEADDR 允许两个进程同时绑定同一端口（Linux 不允许），
    2026-11-01 重启后确实出现过两个代理同秒启动。只判断"有人在听"会漏掉这种
    请求被分流的状态，所以这里数一下进程数。
    """
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             timeout=10, encoding="utf-8", errors="replace").stdout
    except Exception:
        return None
    pids = set()
    for line in out.splitlines():
        parts = line.split()
        if (len(parts) >= 4 and parts[0].upper() == "TCP"
                and parts[-2].upper() == "LISTENING"
                and parts[1].endswith(":%d" % PORT)):
            pids.add(parts[-1])
    return len(pids)


def tail_lines(path, count):
    """读文件末尾 count 行（最多回看 64KB）。

    proxy.log 只追加不轮转，跑久了会到几百 KB～几 MB；doctor 只关心最后几行。
    """
    if not os.path.exists(path):
        return []
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 64 * 1024))
            data = fh.read()
    except Exception:
        return []
    lines = data.decode("utf-8", "replace").splitlines()
    # 从 64KB 中间切进去时第一行可能只有半截，丢掉它
    if size > 64 * 1024 and lines:
        lines = lines[1:]
    return [l for l in lines if l.strip()][-count:]


def find_last_line(path, needle, max_bytes=8 * 1024 * 1024):
    """从文件末尾往前分块找最后一条含 needle 的行。

    启动行可能被几个小时的日志推到很远（代理只在重启时写一次），
    所以不能只看尾部 64KB；但也别整文件读进内存，按块倒着找。
    """
    if not os.path.exists(path):
        return ""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            pos = fh.tell()
            lower = max(0, pos - max_bytes)
            carry = b""
            while pos > lower:
                block = min(64 * 1024, pos - lower)
                pos -= block
                fh.seek(pos)
                buf = fh.read(block) + carry
                lines = buf.split(b"\n")
                # 第一段可能被切断，留到下一块拼
                carry = lines[0] if pos > lower else b""
                for raw in reversed(lines[1:] if pos > lower else lines):
                    line = raw.decode("utf-8", "replace")
                    if needle in line:
                        return line
            return ""
    except Exception:
        return ""


def home(*parts):
    "拼 ~ 下的路径。"
    return os.path.join(os.path.expanduser("~"), *parts)


def hook_path_candidates(cmd, script):
    """从 hook 的 command 里抠出可能的脚本路径。

    command 有两种写法：裸路径（C:/.../retry_hook.py），或带解释器的
    「python C:/.../retry_hook.py」。路径里可能有空格，不能简单按空格切；
    这里按"脚本名结尾 + 向前找盘符/根"的方式截取。
    """
    out = []
    c = (cmd or "").strip()
    if not c:
        return out
    out.append(c.strip('"').strip("'"))
    i = c.lower().find(script)
    if i < 0:
        return out
    head = c[:i + len(script)]
    drive = None
    for m in re.finditer(r"[A-Za-z]:[\\/]", head):
        drive = m
    if drive:
        start = drive.start()
    else:
        quote = max(head.rfind('"'), head.rfind("'"))
        slash = head.find("/")
        start = quote + 1 if quote >= 0 else (slash if slash >= 0 else 0)
    out.append(head[start:].strip('"').strip("'"))
    return out


def hook_state(groups, script):
    """返回 (是否注册, matcher 是否为 Bash, 脚本路径是否存在)。

    只看 basename 会漏掉两类真故障：换过安装目录后旧钩子还指向旧路径、
    matcher 被改成别的工具名——两种情况都会让钩子静默不触发。
    候选里只要有一个真实存在就算路径 OK（整串 command 的 basename 也可能
    恰好等于脚本名，但它不是路径）。
    """
    found = False
    matcher_ok = False
    path_ok = False
    for g in groups or []:
        group_bash = str(g.get("matcher") or "").lower() == "bash"
        for h in g.get("hooks", []) or []:
            args = [x for x in (h.get("args") or []) if isinstance(x, str)]
            cands = list(args) + hook_path_candidates(h.get("command") or "", script)
            for cand in cands:
                if os.path.basename(cand).lower() != script:
                    continue
                found = True
                # 任意一组满足即可：同一脚本可能挂着多组（Read 组 + Bash 组）
                matcher_ok = matcher_ok or group_bash
                path_ok = path_ok or os.path.exists(cand)
    return found, matcher_ok, path_ok


def as_int_text(value):
    """把 "20.0" 这种默认值格式化成启动行里实际打印的 "20"。

    启动行用 %d 打印窗口/间隔，源码里的默认值却可能是浮点字面量，
    不统一就会被"代理运行参数"这一项误判为不一致。
    """
    try:
        f = float(value)
        return str(int(f)) if f == int(f) else str(f)
    except (TypeError, ValueError):
        return str(value)


def detail(registered, matcher_ok, path_ok):
    "把三项布尔结果翻译成人能看懂的一句话。"
    if not registered:
        return "未注册"
    if not matcher_ok:
        return "已注册但 matcher 不是 Bash（不会触发）"
    if not path_ok:
        return "已注册但脚本路径不存在（换过安装目录？）"
    return "已注册"


def _script_default(prefix, script, env_name, fallback):
    """从安装目录的脚本源码里读某个环境变量的默认值。

    只用于"运行中的代理是不是当前这版代码"这一项检查：不做完整解析，
    找不到就返回 fallback，绝不因为格式变化让 doctor 崩掉。
    """
    path = os.path.join(prefix, script)
    try:
        text = open(path, encoding="utf-8").read()
        # 源码里两种写法都用过：env_int("X", 4) 和 os.environ.get("X", "4")
        for pat in (r'env_(?:int|float)\(\s*"%s"\s*,\s*([0-9.]+)' % env_name,
                    r'os\.environ\.get\(\s*"%s"\s*,\s*"([^"]*)"' % env_name):
            m = re.search(pat, text)
            if m:
                return m.group(1)
    except Exception:
        pass
    return fallback


def resolve_prefix():
    """确定要检查哪个安装目录。

    优先级：环境变量 ZP_PREFIX > doctor.py 所在目录 > 默认目录。
    判定方式是"该目录下有 install-state.json"；都没有时，如果 doctor.py 所在目录
    有 retry_proxy.py 就认它（手工复制脚本、还没装过的场景），否则用默认目录。

    必须这样做的原因：install.py 支持 --prefix 装到任意目录，如果 doctor 永远
    只看默认目录，自定义安装的健康检查会静默检查错误的那个安装。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = []
    env = os.environ.get("ZP_PREFIX")
    if env:
        candidates.append(env)
    candidates.extend([here, PREFIX_DEFAULT])
    for cand in candidates:
        state_path = os.path.join(cand, "install-state.json")
        if os.path.exists(state_path):
            # 自身目录里有 install-state 就认自己：把 doctor.py 连 state 一起复制到
            # 别处时，用户显然想检查那个目录。
            return cand
    return here if os.path.exists(os.path.join(here, "retry_proxy.py")) else PREFIX_DEFAULT


def main():
    "逐项检查并打印总结；有 FAIL 时退出码 1，否则 0。"
    prefix = resolve_prefix()
    state_path = os.path.join(prefix, "install-state.json")
    state = {}
    if os.path.exists(state_path):
        try:
            loaded = json.load(open(state_path, encoding="utf-8"))
            state = loaded if isinstance(loaded, dict) else {}
        except Exception:
            state = {}
    # 不再用 state["prefix"] 覆盖：状态文件里的记录只用于 resolve_prefix 的兜底，
    # 否则把 doctor.py 连 install-state 一起复制到别处，检查的还是旧目录。

    print("安装目录: " + prefix)
    print("版本: " + str(state.get("version", "未知")) + "  安装时间: " + str(state.get("installedAt", "未知")))
    print("-" * 60)

    # 1) 脚本
    for name in ("retry_hook.py", "retry_proxy.py", "ensure_proxy.py"):
        p = os.path.join(prefix, name)
        if os.path.exists(p):
            add("PASS", "脚本存在 " + name, "%d 字节" % os.path.getsize(p))
        else:
            add("FAIL", "脚本缺失 " + name, p)

    # 2) 解释器
    py = state.get("python") or sys.executable
    if os.path.exists(py):
        add("PASS", "Python 解释器", py)
    else:
        add("FAIL", "Python 解释器不存在", py)

    # 3) 钩子
    cfg_path = home(".zcode", "cli", "config.json")
    if not os.path.exists(cfg_path):
        add("FAIL", "配置文件不存在", cfg_path)
    else:
        try:
            cfg = json.load(open(cfg_path, encoding="utf-8"))
            ev = cfg.get("hooks", {}).get("events", {})
            use, use_match, use_path = hook_state(ev.get("PostToolUse", []), "retry_hook.py")
            fail, fail_match, fail_path = hook_state(ev.get("PostToolUseFailure", []), "retry_hook.py")
            sst, _, sst_path = hook_state(ev.get("SessionStart", []), "ensure_proxy.py")
            enabled = cfg.get("hooks", {}).get("enabled")
            add("PASS" if enabled else "FAIL", "hooks.enabled", str(enabled))
            add("PASS" if use and use_match and use_path else "FAIL",
                "PostToolUse 钩子（主）", detail(use, use_match, use_path))
            add("PASS" if fail and fail_match and fail_path else "WARN",
                "PostToolUseFailure 钩子（兜底）", detail(fail, fail_match, fail_path))
            add("PASS" if sst and sst_path else "WARN",
                "SessionStart 自启动钩子",
                "已注册" if sst and sst_path else
                ("已注册但脚本路径不存在" if sst else "未注册"))
        except Exception as exc:
            add("FAIL", "配置文件解析失败", repr(exc))

    # 4) provider
    pp = home(".zcode", "v2", "provider_config.json")
    if os.path.exists(pp):
        try:
            pc = json.load(open(pp, encoding="utf-8"))
            for rule in pc.get("config", {}).get("providerConfigRules", {}).get("providerRules", []):
                pid = rule.get("providerId")
                url = rule.get("config", {}).get("api", {}).get("baseUrl", "")
                if points_to_proxy(url):
                    add("PASS", "provider 走代理 " + str(pid), url)
                else:
                    add("WARN", "provider 直连 " + str(pid), url)
        except Exception as exc:
            add("FAIL", "provider 配置解析失败", repr(exc))

    # 5) 代理端口 —— 只判断"有人在听"是不够的：Windows 的 SO_REUSEADDR 允许
    # 别的进程也绑定 8787，或者干脆是一个完全无关的服务占着。再请求一次
    # /__zp_health，确认回答的是本代理。
    s = socket.socket(); s.settimeout(0.8)
    try:
        listening = s.connect_ex(("127.0.0.1", PORT)) == 0
    except Exception:
        listening = False
    finally:
        s.close()
    listeners = count_listeners()
    if listening and is_our_proxy():
        if listeners and listeners > 1:
            add("FAIL", "代理端口 %d" % PORT,
                "%d 个进程同时监听（Windows SO_REUSEADDR）；请求会被分流，只保留一个 PID" % listeners)
        else:
            add("PASS", "代理端口 %d" % PORT, "监听中，且 /__zp_health 回答是本代理")
    elif listening:
        add("WARN", "代理端口 %d" % PORT,
            "端口有服务在听，但不是本代理（provider 会打到错误服务）")
    else:
        add("WARN", "代理端口 %d" % PORT,
            "未监听（provider 指向代理时会导致请求失败）")

    # 6) 正在跑的代理是不是当前脚本（改完代码没重启是很常见的坑）
    log = os.path.join(prefix, "proxy.log")
    tail_all = tail_lines(log, 400)       # 日志尾巴只读尾部，别整文件加载
    if os.path.exists(log):
        try:
            last_listen = find_last_line(log, "proxy listening on")
            if last_listen:
                want = [
                    "retry %ss window" % as_int_text(_script_default(prefix, "retry_proxy.py", "PROXY_RETRY_WINDOW", "180")),
                    "every %ss" % as_int_text(_script_default(prefix, "retry_proxy.py", "PROXY_RETRY_INTERVAL", "20")),
                    "silence=%ss" % as_int_text(_script_default(prefix, "retry_proxy.py", "PROXY_SILENCE_TIMEOUT", "30")),
                    "heartbeat>=%ss" % as_int_text(_script_default(prefix, "retry_proxy.py", "PROXY_HEARTBEAT_START", "80")),
                ]
                fresh = all(x in last_listen for x in want)
                add("PASS" if fresh else "WARN",
                    "代理运行参数",
                    last_listen.split("\t")[-1][:96] if fresh
                    else "运行中的代理参数与脚本不一致（多半是改完没重启）：%s"
                         % last_listen.split("\t")[-1][:80])
            else:
                add("WARN", "代理运行参数", "日志里没有启动行，无法确认运行的是哪一版")
        except Exception as exc:
            add("WARN", "代理运行参数", repr(exc))

    # 7) 报错监听（error_watch）：装没装、开关开没开、进程在不在
    watch = os.path.join(prefix, "error_watch.py")
    if not os.path.exists(watch):
        add("WARN", "报错监听", "安装目录里没有 error_watch.py（旧版安装）")
    else:
        switch = os.environ.get("ZCODE_PERSISTENCE_WATCH", "")
        lock = os.path.join(tempfile.gettempdir(), "Zcode-Persistence",
                            "error_watch.pid")
        pid = None
        try:
            with open(lock, encoding="utf-8") as fh:
                pid = json.load(fh).get("pid")
        except Exception:
            pass
        running = False
        if pid:
            try:
                import ctypes
                k = ctypes.WinDLL("kernel32", use_last_error=True)
                k.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
                k.OpenProcess.restype = ctypes.c_void_p
                h = k.OpenProcess(0x1000, 0, int(pid))
                running = bool(h)
                if h:
                    k.CloseHandle(h)
            except Exception:
                running = False
        if running:
            # 锁文件里的 pid 可能被系统复用：必须再核对命令行确实是 error_watch.py
            try:
                ps = subprocess.run(
                    ["powershell", "-NoProfile", "-Command",
                     "(Get-CimInstance Win32_Process -Filter \"ProcessId=%s\").CommandLine"
                     % pid], capture_output=True, text=True, timeout=15).stdout
            except Exception:
                ps = ""
            if "error_watch.py" in ps:
                add("PASS", "报错监听", "已安装并在跑（pid=%s）" % pid)
            else:
                add("WARN", "报错监听", "锁文件里的 pid=%s 不是本监听（可能已崩溃）" % pid)
                running = False
        if not running and switch.lower() in ("1", "true", "yes", "on"):
            add("WARN", "报错监听", "开关已打开但进程没在跑（下一个会话会被拉起）")
        elif not running:
            add("PASS", "报错监听", "已安装，默认关闭（ZCODE_PERSISTENCE_WATCH 未设置）")

    # 8) 日志尾巴
    if tail_all:
        print("-" * 60)
        print("proxy.log 最近 5 行:")
        for line in tail_all[-5:]:
            print("   " + line)

    print("-" * 60)
    fails = sum(1 for lvl, _, _ in results if lvl == "FAIL")
    warns = sum(1 for lvl, _, _ in results if lvl == "WARN")
    print("总结: %d 项通过, %d 项警告, %d 项失败" % (sum(1 for l in results if l[0] == "PASS"), warns, fails))
    if fails:
        print("存在失败项，请按上面的路径逐条处理。")
    elif warns:
        print("可用，但有需要留意的项。")
    else:
        print("全部正常。")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
