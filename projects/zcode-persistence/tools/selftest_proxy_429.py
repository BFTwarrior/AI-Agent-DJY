#!/usr/bin/env python3
"""自检：失败重试链路。

不碰真实中转，全部在本机回环上跑：
  假上游（端口 = 代理端口 + 1） —— 可编排"先返 429 若干次，再返 200"
  代理副本（临时端口）          —— 用临时目录里的 retry_proxy.py 副本，映射到假上游

验证五件事：
  1. 上游 429 两次后代理会重发，最终拿到 200 并正常回写给客户端
  2. 一直 429 时，时间窗内持续重试，窗口到点返回 503 + OpenAI 形状的错误体
  3. 任何非 2xx 都重试（400 也重试，不只是 429）
  4. 一直失败时不会提前放弃，也不会挂死
  5. 客户端自己写错（未知前缀）时 400 必须不可重试

用法：python tools/selftest_proxy_429.py            （默认读同包 src/retry_proxy.py）
      python tools/selftest_proxy_429.py --src X    （指定要测的脚本）
"""

import argparse
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeUpstream(object):
    """按 plan 依次返回状态码；plan 用完后一直返最后一个。"""

    def __init__(self, plan, port):
        self.plan = list(plan)
        self.hits = 0
        outer = self

        class H(BaseHTTPRequestHandler):
            "假上游：按 plan 依次回状态码，plan 用完就重复最后一个。"
            def do_POST(self):
                "按 plan 依次返回状态码，用来编排“先失败后成功”。"
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                status = outer.plan[min(outer.hits, len(outer.plan) - 1)]
                outer.hits += 1
                if status != 200:
                    body = ('{"error":{"message":"upstream %d","type":"x"}}'
                            % status).encode()
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                body = json.dumps({"id": "cmpl-1", "choices": [
                    {"message": {"role": "assistant", "content": "ok"}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                "屏蔽自带访问日志。"
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), H)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()


def make_proxy_copy(src, workdir, upstream_port):
    """把被测脚本复制到临时目录，改写上游表和默认端口，避免影响真实代理。"""
    text = open(src, encoding="utf-8").read()
    text = text.replace(
        'UPSTREAMS = {\n    "/ap": ("upstream-a.example.com", 443),\n'
        '    "/cm": ("upstream-b.example.com", 443),\n}',
        'UPSTREAMS = {\n    "/ap": ("127.0.0.1", %d, "http"),\n'
        '    "/cm": ("127.0.0.1", %d, "http"),\n}' % (upstream_port, upstream_port))
    assert "127.0.0.1\", %d" % upstream_port in text, "改写 UPSTREAMS 失败，脚本结构变了"
    dst = os.path.join(workdir, "retry_proxy.py")
    open(dst, "w", encoding="utf-8").write(text)
    return dst


def wait_port(port, timeout=10):
    "等端口可连（最多 timeout 秒），用于确认代理已起来。"
    end = time.time() + timeout
    while time.time() < end:
        try:
            s = socket.create_connection(("127.0.0.1", port), 0.3)
            s.close()
            return True
        except OSError:
            time.sleep(0.05)
    return False


def call_proxy(proxy_port, timeout=30, path="/ap/v1/chat/completions"):
    "向代理发一次非流式请求，返回状态码与响应文本。"
    conn = http.client.HTTPConnection("127.0.0.1", proxy_port, timeout=timeout)
    body = json.dumps({"model": "t", "messages": [{"role": "user", "content": "hi"}],
                       "stream": False}).encode()
    conn.request("POST", path, body=body,
                 headers={"Content-Type": "application/json", "Authorization": "Bearer x"})
    resp = conn.getresponse()
    data = resp.read().decode("utf-8", "replace")
    conn.close()
    return resp.status, data


def free_pair():
    """找一对相邻空闲端口（代理用 p，假上游用 p+1），避免用例间 TIME_WAIT 撞端口。"""
    for p in range(18800, 18900, 2):
        ok = True
        for port in (p, p + 1):
            sk = socket.socket()
            try:
                sk.bind(("127.0.0.1", port))
            except OSError:
                ok = False
            finally:
                sk.close()
            if not ok:
                break
        if ok:
            return p
    raise RuntimeError("找不到空闲端口")


def run_case(name, plan, src, env_extra, proxy_port=None,
             path="/ap/v1/chat/completions"):
    "跑一个用例：起假上游 → 起代理副本 → 发请求 → 收集日志。"
    workdir = tempfile.mkdtemp(prefix="proxytest-")
    proxy_port = proxy_port or free_pair()
    upstream_port = proxy_port + 1
    # 先把调用者环境里的 PROXY_* 全部清掉，避免外部调参（比如 IDE 里设了默认值）
    # 悄悄渗进用例；窗口放大到 4 秒，慢机器上第 4 次尝试也不至于越过窗口。
    env = {k: v for k, v in os.environ.items() if not k.startswith("PROXY_")}
    env.update(PROXY_PORT=str(proxy_port),
               PROXY_RETRY_INTERVAL="0.2", PROXY_RETRY_WINDOW="4")
    env.update(env_extra)
    logfile = os.path.join(workdir, "proxy.log")
    results = {}
    try:
        proxy = make_proxy_copy(src, workdir, upstream_port)
        with FakeUpstream(plan, upstream_port) as up:
            out = open(logfile, "w", encoding="utf-8")
            proc = subprocess.Popen([sys.executable, proxy], env=env,
                                    stdout=out, stderr=subprocess.STDOUT,
                                    cwd=workdir)
            try:
                assert wait_port(proxy_port), "代理没起来"
                status, data = call_proxy(proxy_port, path=path)
                results["status"] = status
                results["data"] = data
                results["hits"] = up.hits
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()
                out.close()
        results["log"] = open(logfile, encoding="utf-8", errors="replace").read()
        print("== %s: status=%s upstream_hits=%s" % (name, results["status"], results["hits"]))
        for line in results["log"].splitlines():
            if "attempt" in line or "backoff" in line or "gave up" in line:
                print("   " + line)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    return results


def main():
    "依次跑 5 个场景并汇总；全部通过退出码 0。"
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "src", "retry_proxy.py"))
    args = ap.parse_args()

    ok = True

    # 场景 1：先 429 两次，第 3 次成功
    r = run_case("429 两次后恢复", [429, 429, 200], args.src, {})
    expect = r["status"] == 200 and r["hits"] == 3 and "backoff" in r["log"]
    print("   判定:", "PASS" if expect else "FAIL")
    ok = ok and expect

    # 场景 2：一直 429 —— 窗口内持续重试，到点给 503
    # 错误体必须带客户端的"可重试"标记（retryable/code/reason），否则 ZCode 会把
    # 整轮判死，用户看到的是"任务被强制结束"而不是自动续写。
    r = run_case("持续 429", [429], args.src, {})
    try:
        err = json.loads(r["data"])["error"]
        body_ok = (err.get("type") == "server_error"
                   and err.get("retryable") is True
                   and err.get("code") == "model_server_error"
                   and err.get("reason") == "server_error")
    except Exception:
        body_ok = False
    print("   错误体:", r["data"][:160])
    expect = (r["status"] == 503 and body_ok
              and "gave up after" in r["log"] and r["hits"] >= 3)
    print("   判定:", "PASS" if expect else "FAIL")
    ok = ok and expect

    # 场景 3：400 也要重试（任何报错都重试）
    r = run_case("400 后恢复", [400, 400, 400, 200], args.src, {})
    expect = r["status"] == 200 and r["hits"] == 4
    print("   判定:", "PASS" if expect else "FAIL")
    ok = ok and expect

    # 场景 4：一直 400 —— 在时间窗内一直试，窗口结束才放弃
    r = run_case("持续 400", [400], args.src, {})
    expect = r["status"] == 503 and r["hits"] >= 3
    print("   判定:", "PASS" if expect else "FAIL")
    ok = ok and expect

    # 场景 5：客户端自己写错（未知上游前缀）——400 必须明确"不可重试"，
    # 否则客户端会把这个确定性错误重发 10 次，把失败拖长（审查 P1-3）
    r = run_case("未知前缀 400", [200], args.src, {}, path="/zz/v1/chat/completions")
    try:
        err = json.loads(r["data"])["error"]
        bad_ok = (r["status"] == 400 and err.get("retryable") is False
                  and err.get("code") == "invalid_request")
    except Exception:
        bad_ok = False
    print("   错误体:", r["data"][:120])
    print("   判定:", "PASS" if bad_ok else "FAIL")
    ok = ok and bad_ok

    print("\n总体:", "全部通过" if ok else "有失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
