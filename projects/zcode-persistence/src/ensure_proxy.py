#!/usr/bin/env python3
"""ZCode SessionStart 钩子：确保本地重试代理在跑。

端口上空 → 以脱离父进程的方式拉起 retry_proxy.py。
端口已监听 → 先用 /__zp_health 确认是本代理；不是本代理就在日志里告警
（别的进程占着 8787 时，provider 指向 127.0.0.1:8787 会打到错误服务）。
任何异常都吞掉并退出 0，绝不阻塞会话启动。
"""

import json
import os
import socket
import subprocess
import sys
import time

HOST = "127.0.0.1"
PORT = 8787
HERE = os.path.dirname(os.path.abspath(__file__))
PROXY = os.path.join(HERE, "retry_proxy.py")
WATCH = os.path.join(HERE, "error_watch.py")
WATCH_LOG = os.path.join(HERE, "error_watch.log")
LOG = os.path.join(HERE, "proxy.log")


def note(msg):
    "往 proxy.log 追加一行告警（SessionStart 阶段没有别的地方可写）。"
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write("%s\tensure_proxy: %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


def is_listening():
    "端口上有没有人在监听（只判断 TCP 可达）。"
    s = socket.socket()
    s.settimeout(0.5)
    try:
        return s.connect_ex((HOST, PORT)) == 0
    finally:
        s.close()


def is_our_proxy():
    """端口上的服务是不是本代理。连不上或回的格式不对都算“不是”。"""
    try:
        s = socket.create_connection((HOST, PORT), timeout=1.0)
        try:
            req = "GET /__zp_health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n"
            s.sendall(req.encode("ascii"))
            data = b""
            while True:
                chunk = s.recv(1024)
                if not chunk:
                    break
                data += chunk
            body = data.split(b"\r\n\r\n", 1)[-1]
            info = json.loads(body.decode("utf-8", "replace"))
            return info.get("name") == "Zcode-Persistence"
        finally:
            s.close()
    except Exception:
        return False


def ensure_watch():
    """确保报错监听（红点 → 邮件）在跑 —— 默认关闭，需显式开关。

    2026-10-31 用户要求停止自动发信后改成 opt-in：
    只有设置环境变量 ZCODE_PERSISTENCE_WATCH=1（或 true/yes/on）才拉起。
    error_watch 自带单例锁，已经有活着的实例时新起的会立刻退出。
    """
    if os.environ.get("ZCODE_PERSISTENCE_WATCH", "").lower() not in (
            "1", "true", "yes", "on"):
        return
    if not os.path.exists(WATCH):
        return
    try:
        out = open(WATCH_LOG, "a", encoding="utf-8")
        flags = 0
        if os.name == "nt":
            flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        subprocess.Popen([sys.executable, WATCH], cwd=HERE,
                         stdin=subprocess.DEVNULL, stdout=out,
                         stderr=subprocess.STDOUT, creationflags=flags,
                         close_fds=True)
        out.close()
    except Exception:
        pass


def main():
    "会话启动时调用：代理没起就拉起，端口被别的进程占了就记一笔告警。永远返回 0。"
    ensure_watch()
    if is_listening():
        if not is_our_proxy():
            note("端口 %d 被别的进程占用，且不是本代理；provider 会打到错误服务" % PORT)
        return 0
    if not os.path.exists(PROXY):
        return 0
    try:
        out = open(LOG, "a", encoding="utf-8")
        flags = 0
        if os.name == "nt":
            # 脱离父进程，父进程退出后继续运行
            flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(
            [sys.executable, PROXY],
            cwd=HERE,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=subprocess.STDOUT,
            creationflags=flags,
            close_fds=True,
        )
        # 只看 Popen 不抛异常是不够的：代理可能因为端口被占、权限不足立刻退出，
        # 那样日志里写"started"会误导排查。最多等 2 秒做一次健康检查再说。
        started = False
        end = time.time() + 2.0
        while time.time() < end:
            if is_our_proxy():
                started = True
                break
            time.sleep(0.1)
        out.write("%s\tensure_proxy: %s\n"
                  % (time.strftime("%H:%M:%S"),
                     "started" if started else "spawned but health check failed (see log above)"))
        out.flush()
        out.close()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
