#!/usr/bin/env python3
"""自检：ensure_proxy 的跨进程单实例锁。

2026-11-01 重启后，两个 SessionStart 在同一秒各拉起一个代理，两个进程同时
监听 8787（Windows SO_REUSEADDR）。这里用两个子进程同时抢锁，验证它们被
串行化，而不是各自往下走。

不碰配置、不拉代理、不占端口；只测互斥体本身。非 Windows 直接跳过。
"""

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), "src")

CODE = (
    "import sys,time;"
    "sys.path.insert(0, %r);"
    "import ensure_proxy as e;"
    "h = e.acquire_lock();"
    "assert h, 'lock not acquired';"
    "print('acq', flush=True);"
    "time.sleep(1.2);"
    "e.release_lock(h)"
) % SRC


def main():
    "起两个进程抢同一把锁；串行化时总耗时 >= 2.4 秒。"
    if os.name != "nt":
        print("非 Windows，跳过（本项目只在 Windows 上运行）")
        return 0
    start = time.time()
    procs = [subprocess.Popen([sys.executable, "-c", CODE],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True)
             for _ in range(2)]
    outs = []
    for p in procs:
        out, err = p.communicate(timeout=15)
        outs.append((p.returncode, out.strip(), err.strip()))
    elapsed = time.time() - start
    serialized = elapsed >= 2.4
    ok = (all(rc == 0 for rc, _o, _e in outs)
          and all("acq" in o for _rc, o, _e in outs)
          and serialized)
    print("两个进程都拿到锁=%s，总耗时 %.2fs（串行化阈值 2.4s）=%s"
          % (all("acq" in o for _rc, o, _e in outs), elapsed, serialized))
    for rc, out, err in outs:
        if rc != 0:
            print("  rc=%d out=%r err=%r" % (rc, out[:300], err[:300]))
    print("总体:", "全部通过" if ok else "有失败")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
