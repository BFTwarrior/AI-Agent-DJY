#!/usr/bin/env python3
"""在"没有在飞请求"的空闲窗口里重启本地重试代理，换掉正在跑旧代码的进程。

为什么需要它：代理进程是在会话启动时拉起的，install.py 只复制文件、不动进程；
而当前对话自己的模型请求就走这个代理，直接杀进程会把正在生成的回答掐断。

判据（三者同时满足才动手）：
  1. 代理进程没有 ESTABLISHED 的出站连接（对 127.0.0.1 的监听连接不算）
     —— 代理每次尝试都新建上游连接、回写完就关，所以"无出站连接"≈"无在飞请求"
  2. proxy.log 至少 SILENCE 秒没有新行（双重保险）
  3. 本脚本已运行 MIN_ALIVE 秒以上（避开刚启动时的日志滞后）

`--force` 跳过上面三条（等不到空闲窗口时用），下行安全检查一条不少；
代价是正在飞的请求会被掐断，所以要在**另一个会话/后台**执行，别在前台掐自己。

重启动作：TerminateProcess → 确认端口空出来 → 立刻脱离拉起 → 轮询 /__zp_health。
硬规矩：**旧进程还占着 8787 就绝不拉起新的**。Windows 的 SO_REUSEADDR 允许两个进程同时
监听 8787，第二个照样能通过健康检查，结果是"看起来重启成功、其实两个都在跑"，
下次请求随机落到旧代码上（2026-10-31 踩过一次）。所以以端口为准：kill 失败但 8787
已经空出（进程自行退出/正在终止）才继续拉起；端口仍被占用就放弃并写日志。

用法：pythonw 本脚本 [--force]        （由主代理以 DETACHED_PROCESS 拉起）
退出码：0=成功或无需处理，1=失败/放弃，2=脚本自身异常。
"""

import ctypes
import json
import os
import socket
import subprocess
import sys
import time

INSTALL_DIR = r"C:\Program Files (x86)\AI\Zcode-Persistence"
PROXY = os.path.join(INSTALL_DIR, "retry_proxy.py")
PROXY_LOG = os.path.join(INSTALL_DIR, "proxy.log")
OPS_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "restart.log")
HOST, PORT = "127.0.0.1", 8787

SILENCE = 12          # proxy.log 静默秒数
MIN_ALIVE = 8         # 脚本自身最短存活秒数
POLL = 2              # 轮询间隔
MAX_WAIT = 45 * 60    # 最长等待，超时就放弃（只记日志，不动进程）
MAX_SPAWN = 3
KILL_WAIT = 10        # 杀进程后等它消失的最长秒数
PROXY_ENV = None      # None = 继承当前环境；自测时注入 PROXY_PORT 用

PROCESS_TERMINATE = 0x0001
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SYNCHRONIZE = 0x00100000
STILL_ACTIVE = 259


def _kernel32():
    """声明过 argtypes 的 kernel32。

    默认 restype 是 c_int，64 位句柄会被截断；而且 ctypes.windll 上
    get_last_error() 恒为 0，错误码等于没写。统一从这里取。
    """
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    k.OpenProcess.restype = ctypes.c_void_p
    k.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    k.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    k.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    k.CloseHandle.argtypes = [ctypes.c_void_p]
    return k


def log(msg):
    "追加一行带时间的运维日志；写不了就算了，绝不让脚本崩。"
    try:
        with open(OPS_LOG, "a", encoding="utf-8") as fh:
            fh.write("%s\t%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
            fh.flush()
    except Exception:
        pass


def netstat_rows():
    "返回 netstat -ano 的 (本地, 远端, 状态, PID) 列表；失败返回 None。"
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             timeout=20, encoding="mbcs", errors="replace").stdout
    except Exception:
        return None
    rows = []
    for line in out.splitlines():
        f = line.split()
        if len(f) >= 5 and f[0].upper() in ("TCP", "TCPV6"):
            rows.append((f[1], f[2], f[3].upper(), f[4]))
    return rows


def listener_pids(rows):
    "8787 上所有 LISTENING 的 PID（正常应当恰好 0 个或 1 个）。"
    return [pid for local, _remote, state, pid in rows
            if state == "LISTENING" and local.endswith(":%d" % PORT)]


BUSY_STATES = ("ESTABLISHED", "SYN_SENT", "SYN_RECEIVED", "CLOSE_WAIT", "FIN_WAIT_1")


def inflight(rows, pid):
    """该代理进程当前有没有在飞的上游请求。

    只看"非 127.0.0.1"的连接：对 127.0.0.1:8787 的连接是客户端连进来的，
    keep-alive 空闲时也一直挂着，不能用来判断忙闲。
    FIN_WAIT_2 / TIME_WAIT 不算忙——那是回写完之后的正常收尾残留，会挂很久。
    SYN_SENT 也算忙：上游握手卡住时请求正在飞（否则会被误判成空闲）。
    """
    n = 0
    for local, remote, state, owner in rows:
        if owner != pid or state not in BUSY_STATES:
            continue
        if remote.startswith("127.0.0.1") or remote.startswith("[::1]"):
            continue
        n += 1
    return n


def health_info(timeout=1.0):
    "问一次 /__zp_health，返回解析后的 dict；失败返回 None。"
    try:
        s = socket.create_connection((HOST, PORT), timeout=timeout)
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
        return json.loads(data.split(b"\r\n\r\n", 1)[-1].decode("utf-8", "replace"))
    except Exception:
        return None


def alive(pid):
    "进程还活着（能开句柄且退出码仍是 STILL_ACTIVE）。"
    k = _kernel32()
    h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, int(pid))
    if not h:
        return False
    try:
        code = ctypes.c_ulong()
        if not k.GetExitCodeProcess(h, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        k.CloseHandle(h)


def cmdline_of(pid):
    "读进程命令行（WMI），读不到返回空串。只用来确认这个 PID 确实是我们的代理。"
    ps = ("(Get-CimInstance Win32_Process -Filter 'ProcessId=%s').CommandLine"
          % int(pid))
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, text=True, timeout=15,
                             encoding="mbcs", errors="replace").stdout
    except Exception:
        return ""
    return out.strip()


def kill(pid):
    """TerminateProcess 并等它真的消失；返回 (是否成功, 说明)。

    上一版用 taskkill，返回码没人看：2026-10-31 那次它没杀掉进程，脚本照样
    拉起了第二个监听。这里直接调 Win32 接口，失败时把错误码写进日志。
    """
    pid = int(pid)
    # 必须声明 argtypes/restype：默认 c_int 返回值会把 64 位句柄截断，
    # 而且 ctypes.windll 上 get_last_error() 恒为 0，错误码等于没写。
    k = _kernel32()
    h = k.OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, pid)
    if not h:
        return False, "OpenProcess 失败（Win32=%d）" % ctypes.get_last_error()
    try:
        if not k.TerminateProcess(h, 1):
            return False, "TerminateProcess 失败（Win32=%d）" % ctypes.get_last_error()
        k.WaitForSingleObject(h, KILL_WAIT * 1000)   # 最多等 KILL_WAIT 秒
    finally:
        k.CloseHandle(h)
    deadline = time.time() + KILL_WAIT
    while time.time() < deadline:
        if not alive(pid):
            return True, "已终止"
        time.sleep(0.2)
    return False, "TerminateProcess 返回成功但进程 %ds 内仍存活" % KILL_WAIT


def spawn():
    "按 ensure_proxy 的方式脱离拉起代理，输出追加到 proxy.log。"
    out = open(PROXY_LOG, "a", encoding="utf-8")
    try:
        flags = 0
        if os.name == "nt":
            flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        subprocess.Popen([sys.executable, PROXY], cwd=INSTALL_DIR, env=PROXY_ENV,
                         stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                         creationflags=flags, close_fds=True)
    finally:
        out.close()


def port_free():
    "8787 上没有 LISTENING 就返回 True；netstat 拿不到时按 False 处理（宁可不拉）。"
    rows = netstat_rows()
    return rows is not None and not listener_pids(rows)


def single_listener(expect_root=INSTALL_DIR):
    """确认 8787 上"只有一个监听、而且就是新装的这份代码"。

    健康检查通过不等于换进程成功：Windows 的 SO_REUSEADDR 允许两个进程同时
    监听，旧进程没死时健康检查也会由它应答，日志照样写 OK。所以健康之后必须
    回头数监听个数、并核对 /__zp_health 里的 root。
    """
    rows = netstat_rows()
    if rows is None:
        return False, "netstat 拿不到"
    pids = listener_pids(rows)
    if len(pids) != 1:
        return False, "监听进程数是 %d（%s）" % (len(pids), pids)
    info = health_info()
    if not info:
        return False, "健康探针无响应"
    root = info.get("root")
    # 没有 root 就是升级前启动的旧代码：正是复核要拦的情况，按失败处理
    if not root:
        return False, "健康探针没有 root 字段（旧版代理）"
    if os.path.normcase(os.path.abspath(root)) != os.path.normcase(
            os.path.abspath(expect_root)):
        return False, "root 是 %s，不是 %s" % (root, expect_root)
    return True, "PID %s root=%s" % (pids[0], root)


def restart(pid):
    "杀旧进程 → 确认端口空出来 → 拉起新进程 → 等健康 + 单监听复核。"
    if "retry_proxy.py" not in cmdline_of(pid):
        log("abort: 监听 8787 的 PID %s 不是本代理（命令行对不上），不敢动它" % pid)
        return False
    ok, why = kill(pid)
    log("kill: PID %s → %s（%s）" % (pid, "成功" if ok else "失败", why))
    if not ok:
        # 杀失败也可能是进程自己先退出了；以"端口是否空出来"为准，别误报成仍占用。
        if not port_free():
            log("abort: 旧进程仍占用 %d（%s），不拉起新进程（需人工处理）" % (PORT, why))
            return False
        log("warn: 杀进程返回失败（%s），但 %d 已空出，继续拉起" % (why, PORT))
    elif not port_free():
        # 关键：旧进程没死透就绝不拉起，否则两个监听并存且健康检查照样通过
        log("abort: PID %s 已终止，但 %d 仍被占用，不拉起新进程（需人工处理）"
            % (pid, PORT))
        return False
    for i in range(1, MAX_SPAWN + 1):
        spawn()
        end = time.time() + 10
        while time.time() < end:
            info = health_info()
            if info and info.get("name") == "Zcode-Persistence":
                fine, detail = single_listener()
                if fine:
                    log("restart: OK（第 %d 次拉起，%s）" % (i, detail))
                    return True
                log("restart: 健康但复核不过 —— %s" % detail)
                break
            time.sleep(0.5)
        log("restart: 第 %d 次拉起未通过健康检查" % i)
        rows = netstat_rows()
        if rows is None:
            # 连监听状态都读不到时不能盲目再 spawn，否则可能越堆越多
            log("abort: netstat 拿不到，无法清理残留，停止继续拉起（需人工处理）")
            return False
        leftover = listener_pids(rows)
        for lp in leftover:
            # 清理残留前也要验明正身，别把用户自己的服务杀了
            if "retry_proxy.py" not in cmdline_of(lp):
                log("abort: 8787 上的 PID %s 不是本代理，不清理" % lp)
                return False
            cleaned, why2 = kill(lp)
            log("cleanup: PID %s → %s（%s）" % (lp, "成功" if cleaned else "失败", why2))
        # 无条件复查：netstat 拿不到也算"没空出来"（port_free 对 None 返回 False）
        if not port_free():
            log("abort: 清理后 %d 仍被占用或无法确认，停止继续拉起（需人工处理）" % PORT)
            return False
    log("restart: FAILED（%d 次都没起来，需人工处理）" % MAX_SPAWN)
    return False


def main():
    """等到空闲窗口再重启；任何异常只记日志。

    --force：跳过"等空闲"，立刻换（其余安全条件不变）。用户明确要求热更新、
    而别的会话持续占用代理时用；代价是掐断在飞的请求。
    """
    force = "--force" in sys.argv
    log("start: %s（silence>=%ds, min_alive=%ds）"
        % ("--force 立即换进程" if force else "等待空闲窗口", SILENCE, MIN_ALIVE))
    if force:
        rows = netstat_rows()
        if rows is None:
            # 不能把"读不到 netstat"当成"没有监听"——那会假报"无需重启"
            log("abort: netstat 拿不到，无法确认 8787 的监听状态")
            return 1
        pids = listener_pids(rows)
        if not pids:
            log("nothing: 8787 上没有监听进程，无需重启")
            return 0
        if len(pids) > 1:
            log("abort: 8787 上有 %d 个监听进程 %s，先人工清理" % (len(pids), pids))
            return 1
        pid = pids[0]
        try:
            age = time.time() - os.path.getmtime(PROXY_LOG)
        except OSError:
            age = SILENCE
        # 把"代价"写进日志：事后能核对这次掐断了几条在飞请求
        log("force: 目标 PID %s，在飞出站连接 %d 条，日志静默 %.0fs（这些请求会被掐断）"
            % (pid, inflight(rows, pid), age))
        return 0 if restart(pid) else 1
    t0 = time.time()
    while time.time() - t0 < MAX_WAIT:
        rows = netstat_rows()
        if rows is None:
            time.sleep(POLL)
            continue
        pids = listener_pids(rows)
        if not pids:
            log("nothing: 8787 上没有监听进程，无需重启")
            return 0
        if len(pids) > 1:
            # 双监听是上次换进程留下的烂摊子，只可能越换越多，必须人工清理
            log("abort: 8787 上有 %d 个监听进程 %s，先人工清理再换" % (len(pids), pids))
            return 1
        pid = pids[0]
        try:
            age = time.time() - os.path.getmtime(PROXY_LOG)
        except OSError:
            age = SILENCE
        busy = inflight(rows, pid)
        if time.time() - t0 >= MIN_ALIVE and busy == 0 and age >= SILENCE:
            log("idle: PID %s, 无出站连接, 日志静默 %.0fs" % (pid, age))
            return 0 if restart(pid) else 1
        time.sleep(POLL)
    log("timeout: %d 分钟内没等到空闲窗口，放弃" % (MAX_WAIT // 60))
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log("crash: %s" % type(exc).__name__)
        sys.exit(2)          # 0/1 已被 main 用于成败，异常单独给 2
