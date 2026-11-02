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


def health_info():
    """读 /__zp_health 的 JSON；连不上或格式不对返回 None。

    除了身份，还要看 version/features/root：8787 上常驻的代理是旧代码时，
    provider 自动迁移绝不能执行——旧进程不认识 /p 路由，改了配置等于
    把每个模型请求都变成 400。
    """
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
            return info if isinstance(info, dict) else None
        finally:
            s.close()
    except Exception:
        return None


def is_our_proxy():
    "端口上的服务是不是本代理（身份匹配即可，能力检查另做）。"
    info = health_info()
    return bool(info and info.get("name") == "Zcode-Persistence")


def acquire_lock():
    """跨进程互斥：两个会话同时 SessionStart 时，只允许一个进程做检查+拉起。

    只靠 is_listening() 判断有竞态：两个钩子同时启动时都看到端口为空，就会各拉
    一个代理；Windows 的 SO_REUSEADDR 允许它们同时监听 8787。2026-11-01 重启后
    实际出现过两个 PID 在同一秒启动。命名互斥体随进程退出自动释放，不会留下
    需要手工清理的锁文件。

    返回值：HANDLE / None（非 Windows）/ False（Windows 上拿锁失败）。
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32
        # 64 位下 HANDLE 是指针宽度；不声明 restype 会按 c_int 截断句柄。
        k32.CreateMutexW.restype = wintypes.HANDLE
        k32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL,
                                     wintypes.LPCWSTR]
        k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k32.WaitForSingleObject.restype = wintypes.DWORD
        handle = k32.CreateMutexW(
            None, False, "Local\\ZcodePersistence-EnsureProxy")
        if not handle:
            return False
        rc = k32.WaitForSingleObject(handle, 5000)
        if rc not in (0, 0x80):          # WAIT_OBJECT_0 / WAIT_ABANDONED
            k32.CloseHandle(handle)
            return False
        return handle
    except Exception:
        return False


def release_lock(handle):
    "释放 acquire_lock 拿到的互斥体。"
    if not handle or os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32
        k32.ReleaseMutex.argtypes = [wintypes.HANDLE]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.ReleaseMutex(handle)
        k32.CloseHandle(handle)
    except Exception:
        pass


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


def route_providers_if_ready():
    """代理健康且支持 /p 路由时，把还没走代理的 provider 自动迁移（V0.2.6）。

    必须在代理确认可用之后才改：把 provider 指向一个没起来的 8787 会让
    模型请求全部失败。还要确认端口上跑的是**支持 /p 的新代码**——升级后
    旧代理进程常驻 8787 时，光看 name 会误判为健康，迁移后所有请求 400。
    失败只记日志，绝不影响会话启动。
    """
    info = health_info()
    if not info or info.get("name") != "Zcode-Persistence":
        return
    if "p_route" not in (info.get("features") or []):
        note("代理进程不支持 /p 路由（旧版本），跳过 provider 迁移；重启代理后下次会话自动生效")
        return
    root = info.get("root") or ""
    if (not root
            or os.path.normcase(os.path.abspath(root)) != os.path.normcase(HERE)):
        # 没说清自己是哪份代码，就不能信：宁可先不迁移。8787 上跑的是另一份
        # 代码（常见于项目 src 里的手动启动）时，那份代码是否有 /p 路由无法保证。
        note("8787 上运行的代理未报告可匹配的 root（%r），跳过 provider 迁移"
             % (root or "-",))
        return
    try:
        import route_providers
        changed, _skipped, bak = route_providers.route_all(verbose=False)
        if changed:
            note("provider 自动迁移 %d 个（备份 %s）"
                 % (changed, os.path.basename(bak) if bak else "-"))
    except Exception as exc:
        note("provider 自动迁移失败: %r" % (exc,))


def main():
    "会话启动时调用：代理没起就拉起，端口被别的进程占了就记一笔告警。永远返回 0。"
    lock = acquire_lock()
    if lock is False:
        # Windows 上拿不到互斥体（超时/API 失败）时宁可不起代理，也不能在
        # 另一个钩子正在拉起的窗口里再拉一个，否则又会出现双监听。
        note("acquire instance lock failed; skip spawn")
        return 0
    try:
        ensure_watch()
        if is_listening():
            if not is_our_proxy():
                note("端口 %d 被别的进程占用，且不是本代理；provider 会打到错误服务" % PORT)
            else:
                route_providers_if_ready()
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
        route_providers_if_ready()
        return 0
    finally:
        release_lock(lock)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
