#!/usr/bin/env python3
"""自检：流式（SSE）回写路径。

不碰真实中转：假上游在本机回环上按脚本吐字节，代理用临时副本 + 临时端口。

验证二十三件事（对应 2026-10-31 三轮复审与终验、2026-11-01 自动暂停修复）：
  1. 逐条透传：上游每 0.2 秒发一条 80 字节事件，客户端应当在每条到达后
     几十毫秒内收到，而不是攒到 8KB 或流结束才一起到
  2. 流中静默：响应头之后上游停 2.5 秒、空闲超时设 1 秒时，代理应当发
     `: keepalive` 继续等，而不是按旧逻辑判截断并把已读字节丢掉
  3. 定长短读：上游声明 Content-Length: 100 却只发 20 字节就断开，代理
     必须按 truncated 收尾，不能补 chunked 终止块让客户端以为响应完整
  4. 正常流式：请求仍能完整回写并正常结束
  5. 静默截止：上游发一条后彻底不动，心跳照发，但累计静默到重试窗口
     必须收尾（否则请求会永远挂着）
  6. 慢客户端：客户端先不读 1.5 秒、上游猛发 4MB，代理必须靠背压顶住，
     不能"队列满就丢"——丢数据还会被误报成 body silent
  7. 心跳模式下放弃：上游一个字节都不回、200 已经发出，放弃时只能把错误体
     塞进 SSE `data:` 事件——必须带 retryable/code，并补 chunked 终止块，
     否则客户端的"自动续写"没有依据
  8. 提前结束（2026-11-01 自动暂停）：上游只吐 reasoning、没有正文/工具调用，
     却以 `finish_reason=other` 结束——代理必须丢弃本次尝试并内部重发，不能让客户端
     把它当正常完成而结束整个回合
  9. 正常 `finish_reason=stop` 必须原样透传，不能被第 8 条误伤
 10. 已经有正文的 `other` 也原样透传：内容已经给用户看了，重发会重复
 11. 上游根本没给 `finish_reason`、只发 `[DONE]`（线上真实形态）——[DONE] 前判 early
 12. 没给 `finish_reason`、也没发 `[DONE]`，直接正常关闭连接——EOF 判 early
 13. 有正文但没 `finish_reason` 的 `[DONE]`——原样放行，避免重复内容
 14. 第一次连接提前结束、第二次连接成功：代理内部重发，客户端只看到一条连续的流
 15. 字面 `finish_reason=other` 同样透明续写（场景 14 覆盖的是"缺失"形态）
 16. 上游不发 finish_reason、直接发 `{"error":...}`（stream_truncated），且无正文/
     工具调用：代理吞掉错误事件并内部重发
 17. 已经有正文后上游才发 error：不能重试（会重复正文），原样转发
 18. 工具调用参数发到一半流就结束（线上 tool_args_invalid 形态，V0.2.5）：
     工具增量先缓冲不写出，EOF 时整体丢弃并内部重发，客户端只收到完整的工具调用
 19. 完整工具调用 + `finish_reason=tool_calls`：缓冲在收尾时写出，原样透传不重试
 20. 只吐 reasoning 后上游 RST（客户端判 upstream_stream_read_error）：代理丢弃
     本次尝试并内部重发，客户端只看到第二段的正文（V0.2.6）
 21. `/cg` 前缀路由到本机 Cherry 网关（HTTP），与 `/ap`、`/cm` 一样透传
 22. 通用 `/p/<base64url(原始 baseUrl)>` 路由：base 带路径、请求带 query 时
     路径拼成 `/relay/v1/...?...`，Host 带非默认端口（V0.2.6）
 23. `/p` 坏 token（空、非 base64、非 http(s)、非法端口）必须回 400

用法：python tools/selftest_stream.py            （默认读同包 src/retry_proxy.py）
      python tools/selftest_stream.py --src X
"""

import argparse
import base64
import json
import os
import re
import struct
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time


def free_pair():
    """找一对相邻空闲端口（上游用 p+1）。"""
    for p in range(18900, 19000, 2):
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


def make_proxy_copy(src, workdir, upstream_port):
    "复制代理脚本并改写上游表，避免影响真实代理。"
    text = open(src, encoding="utf-8").read()
    block = ("UPSTREAMS = {\n"
             '    "/ap": ("127.0.0.1", %d, "http"),\n'
             '    "/cm": ("127.0.0.1", %d, "http"),\n'
             '    "/cg": ("127.0.0.1", %d, "http"),\n'
             "}" % (upstream_port, upstream_port, upstream_port))
    text, n = re.subn(r"UPSTREAMS = \{.*?\n\}", block, text, count=1, flags=re.S)
    assert n == 1, "改写 UPSTREAMS 失败，脚本结构变了"
    dst = os.path.join(workdir, "retry_proxy.py")
    open(dst, "w", encoding="utf-8").write(text)
    return dst


class FakeUpstream(object):
    """按给定脚本回写的假上游：script 是 (字节, 之后等待秒数) 的列表。

    hold_after > 0 时，脚本发完后不结束响应，保持连接静默这么久——
    用来测"上游彻底不吐字节"时代理的静默截止路径。
    """

    def __init__(self, port, script, content_type="text/event-stream",
                 content_length=None, chunked=True, hold_after=0,
                 no_response=False, scripts=None, rst_after=0, echo=False):
        # scripts 非空时按顺序服务多次连接：用来模拟“第一次提前结束、代理内部
        # 重发第二次并成功”的透明续写路径。
        self.scripts = scripts if scripts is not None else [script]
        self.content_type = content_type
        self.content_length = content_length
        self.chunked = chunked
        self.hold_after = hold_after
        # no_response=True：读完请求后一个字节都不回，制造"上游一直不给响应头"，
        # 用来测心跳模式下的 SSE 错误收尾
        self.no_response = no_response
        # rst_after=True：脚本发完立刻 RST（SO_LINGER 0），模拟上游读错误，
        # 而不是正常 EOF。用来测"只吐了 reasoning 就被读错误打断"的重发路径。
        self.rst_after = rst_after
        # echo=True：把收到的请求行和 Host 头回显进正文。用来证明 /cg、/p
        # 不只知道"有个前缀"，而是真的把路径和 Host 转发到了正确位置。
        self.echo = echo
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", port))
        self.sock.listen(5)

    def __enter__(self):
        threading.Thread(target=self._serve, daemon=True).start()
        return self

    def __exit__(self, *exc):
        try:
            self.sock.close()
        except Exception:
            pass

    def _serve(self):
        for idx, script in enumerate(self.scripts):
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            try:
                self._serve_one(conn, script, idx < self.rst_after)
            finally:
                try:
                    conn.close()
                except Exception:
                    pass

    def _serve_one(self, conn, script, rst=False):
        try:
            conn.settimeout(10)
            data = b""
            while b"\r\n\r\n" not in data:
                d = conn.recv(4096)
                if not d:
                    return
                data += d
            head, _, rest = data.partition(b"\r\n\r\n")
            length = 0
            for line in head.split(b"\r\n")[1:]:
                if line.lower().startswith(b"content-length:"):
                    length = int(line.split(b":")[1])
            while len(rest) < length:
                d = conn.recv(4096)
                if not d:
                    break
                rest += d

            if self.no_response:
                time.sleep(self.hold_after or 5)
                return

            if self.echo:
                lines = head.split(b"\r\n")
                req_line = lines[0].decode("latin-1") if lines else ""
                host_h = ""
                for line in lines[1:]:
                    if line.lower().startswith(b"host:"):
                        host_h = line.split(b":", 1)[1].strip().decode("latin-1")
                payload = json.dumps(
                    {"choices": [{"delta": {"content": req_line + " | Host=" + host_h}}]},
                    ensure_ascii=False)
                script = [(("data: " + payload + "\r\n\r\n").encode(), 0.02),
                          (b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n', 0.02),
                          (b"data: [DONE]\r\n\r\n", 0.0)]

            resp = ["HTTP/1.1 200 OK",
                    "Content-Type: " + self.content_type,
                    "Connection: close"]
            if self.chunked:
                resp.append("Transfer-Encoding: chunked")
            if self.content_length is not None:
                resp.append("Content-Length: %d" % self.content_length)
            conn.sendall(("\r\n".join(resp) + "\r\n\r\n").encode())

            for body, pause in script:
                if self.chunked:
                    conn.sendall(b"%x\r\n" % len(body) + body + b"\r\n")
                else:
                    conn.sendall(body)
                if pause:
                    time.sleep(pause)
            if rst:
                try:
                    conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                                    struct.pack("ii", 1, 0))
                except Exception:
                    pass
                return
            if self.hold_after:
                time.sleep(self.hold_after)      # 故意不结束响应，制造"上游静默"
            if self.chunked:
                conn.sendall(b"0\r\n\r\n")
        except Exception:
            pass


def call_stream(proxy_port, read_seconds, idle=0.15, start_delay=0.0, prefix="ap",
                query=""):
    """发一个流式请求，返回 (每条数据到达的时刻, 原始字节)。

    start_delay > 0 时先不读（模拟慢客户端/卡住的界面），用来验证背压不丢数据。
    query 非空时拼在请求路径后面，用来验证 baseUrl 查询串是否保留。
    """
    body = (b'{"model":"t","stream":true,"messages":'
            b'[{"role":"user","content":"hi"}]}')
    tail = ("?" + query) if query else ""
    req = (b"POST /" + prefix.encode() + b"/v1/chat/completions" + tail.encode()
           + b" HTTP/1.1\r\nHost: x\r\n"
           b"Content-Type: application/json\r\n"
           b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n") + body
    s = socket.create_connection(("127.0.0.1", proxy_port), timeout=5)
    s.sendall(req)
    if start_delay:
        time.sleep(start_delay)
    chunks = []
    raw = b""
    end = time.time() + read_seconds
    s.settimeout(idle)
    while time.time() < end:
        try:
            d = s.recv(65536)
        except socket.timeout:
            continue
        if not d:
            break
        raw += d
        # 按 SSE 事件切分（只看以 "data:" 开头的行，心跳注释行单独记）
        while b"\n\n" in raw:
            ev, _, raw = raw.partition(b"\n\n")
            if ev.strip():
                chunks.append((round(time.time(), 2), ev))
    s.close()
    return chunks, raw


def call_raw(proxy_port, path):
    "发一个最小 POST，返回完整原始响应（状态行 + 头 + 体）。"
    body = b"{}"
    req = (("POST " + path + " HTTP/1.1\r\nHost: x\r\n"
            "Content-Type: application/json\r\nContent-Length: 2\r\n"
            "Connection: close\r\n\r\n").encode() + body)
    s = socket.create_connection(("127.0.0.1", proxy_port), timeout=5)
    s.sendall(req)
    data = b""
    while True:
        d = s.recv(65536)
        if not d:
            break
        data += d
    s.close()
    return data


def run_case(name, src, script, content_length=None, chunked=True,
             env_extra=None, read_seconds=4.0, heartbeat_start="100",
             hold_after=0, start_delay=0.0, no_response=False, scripts=None,
             rst_after=0, prefix="ap", generic=False, generic_path="",
             echo=False, query=""):
    "跑一个用例：起假上游 → 起代理副本 → 发流式请求 → 收日志与字节。"
    workdir = tempfile.mkdtemp(prefix="streamtest-")
    proxy_port = free_pair()
    upstream_port = proxy_port + 1
    # 先清掉调用者环境里的 PROXY_*，再按用例需要设置
    env = {k: v for k, v in os.environ.items() if not k.startswith("PROXY_")}
    env.update(PROXY_PORT=str(proxy_port),
               PROXY_SILENCE_TIMEOUT="1", PROXY_HEARTBEAT_START=heartbeat_start,
               PROXY_HEARTBEAT_INTERVAL="1", PROXY_RETRY_WINDOW="5",
               PROXY_RETRY_INTERVAL="0.2")
    env.update(env_extra or {})
    if generic:
        base = "http://127.0.0.1:%d%s" % (upstream_port, generic_path)
        token = base64.urlsafe_b64encode(base.encode()).decode().rstrip("=")
        prefix = "p/" + token
    logfile = os.path.join(workdir, "proxy.log")
    try:
        proxy = make_proxy_copy(src, workdir, upstream_port)
        with FakeUpstream(upstream_port, script, content_length=content_length,
                          chunked=chunked, hold_after=hold_after,
                          no_response=no_response, scripts=scripts,
                          rst_after=rst_after, echo=echo):
            out = open(logfile, "w", encoding="utf-8")
            proc = subprocess.Popen([sys.executable, proxy], env=env, cwd=workdir,
                                    stdout=out, stderr=subprocess.STDOUT)
            try:
                end = time.time() + 8
                while time.time() < end:
                    try:
                        sk = socket.create_connection(("127.0.0.1", proxy_port), 0.3)
                        sk.close()
                        break
                    except OSError:
                        time.sleep(0.05)
                chunks, tail = call_stream(proxy_port, read_seconds,
                                           start_delay=start_delay, prefix=prefix,
                                           query=query)
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()
                out.close()
        logtext = open(logfile, encoding="utf-8", errors="replace").read()
        print("== %s" % name)
        for t, ev in chunks[:6]:
            print("   %.2fs  %r" % (t, ev[:60]))
        for line in logtext.splitlines():
            if any(k in line for k in ("ok ", "truncated", "keepalive", "stream broken")):
                print("   log| " + line.strip())
        return chunks, logtext, tail
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main():
    "依次跑 23 个场景并汇总；全部通过退出码 0。"
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "src", "retry_proxy.py"))
    args = ap.parse_args()
    ok = True

    # 1) 逐条透传：10 条事件、间隔 0.2 秒
    script = [(b"data: " + (b"x" * 70) + b"\n\n", 0.2) for _ in range(10)]
    chunks, logtext, _ = run_case("逐条透传", args.src, script, read_seconds=4.0)
    times = [t for t, _ in chunks]
    spread = (times[-1] - times[0]) if len(times) >= 2 else 0
    # 相邻两条的间隔应接近上游的 0.2 秒；攒批时会一次性到达（间隔≈0）
    gaps = [b - a for a, b in zip(times, times[1:])]
    max_gap = max(gaps) if gaps else 0
    # 0.7 秒是给高负载机器的容差：上游间隔 0.2 秒，攒批时相邻间隔≈0
    pass1 = len(chunks) >= 8 and spread >= 1.0 and max_gap <= 0.7
    print("   到达 %d 条，跨度 %.2fs，最大相邻间隔 %.2fs（攒批时跨度≈0、间隔≈0 且条数少）"
          % (len(chunks), spread, max_gap))
    print("   判定:", "PASS" if pass1 else "FAIL")
    ok = ok and pass1

    # 2) 流中静默：发一条后停 2.5 秒再发一条
    script = [(b"data: first\n\n", 2.5), (b"data: second\n\n", 0.1)]
    chunks, logtext, _ = run_case("流中静默续命", args.src, script, read_seconds=5.0)
    got_first = any(b"first" in ev for _, ev in chunks)
    got_hb = "keepalive after" in logtext
    got_second = any(b"second" in ev for _, ev in chunks)
    pass2 = got_first and got_hb and got_second and "truncated" not in logtext
    print("   首条=%s 心跳=%s 第二条=%s 未截断=%s"
          % (got_first, got_hb, got_second, "truncated" not in logtext))
    print("   判定:", "PASS" if pass2 else "FAIL")
    ok = ok and pass2

    # 3) 定长短读：声明 100 字节只发 20 字节
    script = [(b"x" * 20, 0.1)]
    chunks, logtext, tail = run_case("定长短读判截断", args.src, script,
                                     content_length=100, chunked=False, read_seconds=3.0)
    truncated = "truncated" in logtext
    # 客户端收到的原始尾部不应有 chunked 终止块
    no_terminal = b"0\r\n\r\n" not in tail
    pass3 = truncated and no_terminal
    print("   log 记 truncated=%s，未补终止块=%s" % (truncated, no_terminal))
    print("   判定:", "PASS" if pass3 else "FAIL")
    ok = ok and pass3

    # 4) 正常流式仍然完整收尾
    script = [(b"data: a\n\n", 0.05), (b"data: b\n\n", 0.05)]
    chunks, logtext, _ = run_case("正常流式收尾", args.src, script, read_seconds=3.0)
    pass4 = "ok " in logtext and len(chunks) >= 2 and "truncated" not in logtext
    print("   判定:", "PASS" if pass4 else "FAIL")
    ok = ok and pass4

    # 5) 上游彻底静默：心跳照发；静默且无产出先内部重发，窗口到点才收尾。
    #    HEARTBEAT_INTERVAL=1、RETRY_WINDOW=2；上游发 1 条后保持连接不动 8 秒。
    script = [(b"data: only\n\n", 0)]
    chunks, logtext, tail = run_case(
        "静默到窗口重试后放弃", args.src, script, read_seconds=4.0, hold_after=8,
        env_extra={"PROXY_RETRY_WINDOW": "2"})
    data = b"\n\n".join(c for _t, c in chunks) + tail
    said = "early finish stream error" in logtext
    # 静默只在 RETRY_WINDOW 到点时才被判定，_handle 打 window exhausted 后立刻 break，
    # 不会再发起上游请求。这里只断言“进入 early + 窗口放弃 + 可重试错误体”；
    # 真正会重发的读错误路径由场景 20 覆盖。
    scheduled = ("window exhausted" in logtext
                 or "retry after early finish" in logtext)
    gave_up = "gave up" in logtext
    retryable = b'"retryable": true' in data or b'"retryable":true' in data
    pass5 = said and gave_up and retryable and scheduled
    print("   日志: %s" % [l.strip() for l in logtext.splitlines()
                         if "body silent" in l or "early finish" in l
                         or "gave up" in l or "keepalive" in l][-4:])
    print("   静默判早期=%s early收尾路径=%s 窗口放弃=%s 可重试错误体=%s"
          % (said, scheduled, gave_up, retryable))
    print("   判定:", "PASS" if pass5 else "FAIL")
    ok = ok and pass5

    # 6) 慢客户端 + 大响应：客户端前 1.5 秒完全不读，上游仍在猛发。
    #    代理必须靠背压顶住上游，不能"队列满就丢"，否则内容会缺块且被误报成静默。
    #    2000 条 × 2KB ≈ 4MB，远超队列（64×8KB=512KB）+ socket 缓冲。
    script = [(b"data: " + (b"y" * 2000) + b"\n\n", 0.001) for _ in range(2000)]
    chunks, logtext, tail = run_case("慢客户端不丢数据", args.src, script,
                                     read_seconds=20.0, start_delay=1.5,
                                     env_extra={"PROXY_RETRY_WINDOW": "10"})
    got = len(chunks)
    # 除了"条数齐、日志 ok"，还要确认客户端真的收到了 chunked 终止块：
    # 终止块写入失败会被 except 吞掉却仍记 ok，只查日志抓不到那种回归。
    ended = b"0\r\n\r\n" in tail
    pass6 = (got == 2000 and "ok " in logtext and "truncated" not in logtext and ended)
    print("   收到 %d/2000 条，终止块=%s，日志 %s"
          % (got, ended, "ok" if "ok " in logtext else ("truncated" if "truncated" in logtext else "?")))
    print("   判定:", "PASS" if pass6 else "FAIL")
    ok = ok and pass6

    # 7) 心跳模式下放弃：上游一个字节都不回，代理已经发出 200 + 心跳，
    #    收尾只能把错误体塞进 SSE data 事件。这段错误体是客户端"自动续写"的
    #    唯一依据，必须带 retryable/code（审查 P2-14）。
    chunks, logtext, tail = run_case(
        "流式放弃带可重试标记", args.src, [], read_seconds=7.0,
        heartbeat_start="1", hold_after=10, no_response=True,
        env_extra={"PROXY_RETRY_WINDOW": "3", "PROXY_RETRY_INTERVAL": "0.5",
                   "PROXY_SILENCE_TIMEOUT": "1"})
    text = (b"\n\n".join(c for _t, c in chunks) + tail).decode("utf-8", "replace")
    has_retry = '"retryable": true' in text
    has_code = '"code": "model_server_error"' in text
    has_term = b"0\r\n\r\n" in tail
    pass7 = has_retry and has_code and has_term
    print("   retryable=%s code=%s 终止块=%s" % (has_retry, has_code, has_term))
    print("   判定:", "PASS" if pass7 else "FAIL")
    ok = ok and pass7

    # 8) 提前结束：只有 reasoning、没有正文/工具调用，上游却回 finish_reason=other。
    #    代理必须截住这个结束事件、丢弃本次尝试并由 _handle 重发上游；客户端不能
    #    收到 finish_reason（收到就会被当正常完成）。
    script = [
        (b'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{},"finish_reason":"other"}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("提前结束转内部重发", args.src, script, read_seconds=3.0)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    text = data.decode("utf-8", "replace")
    early = "early finish reason=other" in logtext
    retried = "retry after early finish" in logtext
    no_finish = '"finish_reason"' not in text
    no_error = '"error"' not in text
    pass8 = early and retried and no_finish and no_error
    print("   early=%s 已重发=%s 无finish=%s 无error=%s"
          % (early, retried, no_finish, no_error))
    print("   判定:", "PASS" if pass8 else "FAIL")
    ok = ok and pass8

    # 9) 正常结束不能被误伤：stop + 正文必须原样透传。
    script = [
        (b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("正常结束原样透传", args.src, script, read_seconds=3.0)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    pass9 = (b'"finish_reason":"stop"' in data and b"hi" in data
             and '"retryable"' not in data.decode("utf-8", "replace")
             and "ok " in logtext and "early finish" not in logtext)
    print("   判定:", "PASS" if pass9 else "FAIL")
    ok = ok and pass9

    # 10) 已经有正文再收到 other：内容已经给用户看了，重发会造成重复，必须放行。
    script = [
        (b'data: {"choices":[{"delta":{"content":"done"}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{},"finish_reason":"other"}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("有正文的 other 放行", args.src, script, read_seconds=3.0)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    pass10 = (b'"finish_reason":"other"' in data and b"done" in data
              and '"retryable"' not in data.decode("utf-8", "replace")
              and "ok " in logtext and "early finish" not in logtext)
    print("   判定:", "PASS" if pass10 else "FAIL")
    ok = ok and pass10

    # 11) 线上真实形态：没有 finish_reason，直接 [DONE]。客户端把 undefined 映射成
    #     other 并当正常完成；必须在 [DONE] 交给客户端之前截住。
    script = [
        (b'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("缺 finish_reason 的 DONE", args.src, script, read_seconds=3.0)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    missing = "missing finish_reason" in logtext
    retried = "retry after early finish" in logtext
    passed_done = b"[DONE]" in data
    pass11 = missing and retried and not passed_done
    print("   missing=%s 已重发=%s 放行DONE=%s" % (missing, retried, passed_done))
    print("   判定:", "PASS" if pass11 else "FAIL")
    ok = ok and pass11

    # 12) 同样没有 finish_reason，但上游连 [DONE] 都不发，正常关闭连接。
    script = [
        (b'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n', 0.05),
    ]
    chunks, logtext, tail = run_case("缺 finish_reason 的 EOF", args.src, script, read_seconds=3.0)
    pass12 = ("missing finish_reason at EOF" in logtext
              and "retry after early finish" in logtext)
    print("   判定:", "PASS" if pass12 else "FAIL")
    ok = ok and pass12

    # 13) 有正文、没有 finish_reason 的 [DONE]：必须放行，重发会重复已显示内容。
    script = [
        (b'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("有正文的缺失结束原因", args.src, script, read_seconds=3.0)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    text = data.decode("utf-8", "replace")
    pass13 = (b"[DONE]" in data and b"answer" in data
              and '"retryable"' not in text and "ok " in logtext
              and "early finish" not in logtext)
    print("   判定:", "PASS" if pass13 else "FAIL")
    ok = ok and pass13
    # 14) 透明续写：第一次连接只有 reasoning + [DONE]（无 finish_reason），
    #     代理内部重发第二次连接，第二次给出正文和 stop。客户端应当只看到一条
    #     连续的流，最终正常完成，不出现任何错误事件。
    first = [
        (b'data: {"choices":[{"delta":{"reasoning_content":"first try"}}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    second = [
        (b'data: {"choices":[{"delta":{"reasoning_content":"second try"}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{"content":"final answer"}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("提前结束后透明续写", args.src, first,
                                     scripts=[first, second], read_seconds=8.0)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    text = data.decode("utf-8", "replace")
    pass14 = (b"final answer" in data and b'"finish_reason":"stop"' in data
              and b"[DONE]" in data and '"error"' not in text
              and "early finish missing finish_reason" in logtext
              and "retry after early finish" in logtext
              and "stream broken" not in logtext)
    print("   收到正文=%s stop=%s 无error=%s 日志重发=%s"
          % (b"final answer" in data, b'"finish_reason":"stop"' in data,
             '"error"' not in text, "retry after early finish" in logtext))
    print("   判定:", "PASS" if pass14 else "FAIL")
    ok = ok and pass14
    # 15) 字面 finish_reason=other 也要能透明续写（场景 14 覆盖的是“缺失”形态）。
    first_other = [
        (b'data: {"choices":[{"delta":{"reasoning_content":"literal first"}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{},"finish_reason":"other"}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    second_other = [
        (b'data: {"choices":[{"delta":{"content":"literal answer"}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("字面 other 透明续写", args.src, first_other,
                                     scripts=[first_other, second_other], read_seconds=8.0)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    text = data.decode("utf-8", "replace")
    pass15 = (b"literal answer" in data and b'"finish_reason":"stop"' in data
              and b"[DONE]" in data and '"error"' not in text
              and "early finish reason=other" in logtext
              and "retry after early finish" in logtext
              and "stream broken" not in logtext)
    print("   收到正文=%s stop=%s 无error=%s 日志重发=%s"
          % (b"literal answer" in data, b'"finish_reason":"stop"' in data,
             '"error"' not in text, "retry after early finish" in logtext))
    print("   判定:", "PASS" if pass15 else "FAIL")
    ok = ok and pass15

    # 16) 上游不发 finish_reason，直接发 {"error":...}（线上 stream_truncated）：
    #     只有 reasoning、没有正文/工具时必须吞掉错误并内部重发。
    first_err = [
        (b'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n', 0.05),
        (b'data: {"error":{"message":"upstream broke","type":"upstream_error",'
         b'"code":"stream_truncated"}}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    second_err = [
        (b'data: {"choices":[{"delta":{"content":"recovered answer"}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("上游 error 事件透明续写", args.src, first_err,
                                     scripts=[first_err, second_err], read_seconds=8.0)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    text = data.decode("utf-8", "replace")
    pass16 = (b"recovered answer" in data and b'"finish_reason":"stop"' in data
              and data.count(b"[DONE]") == 1
              and data.find(b"recovered answer") < data.find(b"[DONE]")
              and '"error"' not in text
              and "early finish upstream error: stream_truncated" in logtext
              and "retry after early finish" in logtext
              and "stream broken" not in logtext)
    print("   收到正文=%s stop=%s 无error=%s 日志重发=%s"
          % (b"recovered answer" in data, b'"finish_reason":"stop"' in data,
             '"error"' not in text, "retry after early finish" in logtext))
    print("   判定:", "PASS" if pass16 else "FAIL")
    ok = ok and pass16

    # 17) 已经有正文后上游才发 error：不能重试（会重复正文），必须原样转发。
    text_err = [
        (b'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n', 0.05),
        (b'data: {"error":{"message":"upstream broke","type":"upstream_error",'
         b'"code":"stream_truncated"}}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("有正文后 error 原样转发", args.src, text_err,
                                     read_seconds=4.0)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    text = data.decode("utf-8", "replace")
    pass17 = (b"partial answer" in data and b"stream_truncated" in data
              and b"0\r\n\r\n" in tail and "ok " in logtext
              and "retry after early finish" not in logtext
              and "stream broken" not in logtext)
    print("   收到正文=%s 收到error=%s 未重发=%s"
          % (b"partial answer" in data, b"stream_truncated" in data,
             "retry after early finish" not in logtext))
    print("   判定:", "PASS" if pass17 else "FAIL")
    ok = ok and pass17

    # 18) 工具调用参数发到一半流就结束（线上 tool_args_invalid 形态）：工具增量
    #     已缓冲、未写出，EOF 时整体丢弃并重发；客户端只收到完整的工具调用。
    first_partial = [
        (b'data: {"choices":[{"delta":{"reasoning_content":"need a tool"}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",'
         b'"type":"function","function":{"name":"Bash","arguments":"PARTIALARGS"}}]}}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    second_tool = [
        (b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2",'
         b'"type":"function","function":{"name":"Bash",'
         b'"arguments":"{\\"command\\":\\"ls -la\\"}"}}]}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("残缺工具调用透明续写", args.src, first_partial,
                                     scripts=[first_partial, second_tool],
                                     read_seconds=8.0)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    text = data.decode("utf-8", "replace")
    pass18 = (b"ls -la" in data and b'"finish_reason":"tool_calls"' in data
              and b"PARTIALARGS" not in data and '"error"' not in text
              and "early finish incomplete tool call at DONE" in logtext
              and "retry after early finish" in logtext
              and "stream broken" not in logtext)
    print("   收到完整工具=%s tool_calls收尾=%s 残缺未泄漏=%s 日志重发=%s"
          % (b"ls -la" in data, b'"finish_reason":"tool_calls"' in data,
             b"PARTIALARGS" not in data, "retry after early finish" in logtext))
    print("   判定:", "PASS" if pass18 else "FAIL")
    ok = ok and pass18

    # 19) 完整工具调用 + finish_reason=tool_calls：缓冲在收尾时写出，原样透传。
    full_tool = [
        (b'data: {"choices":[{"delta":{"reasoning_content":"run it"}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_3",'
         b'"type":"function","function":{"name":"Bash",'
         b'"arguments":"{\\"command\\":\\"echo done\\"}"}}]}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("完整工具调用透传", args.src, full_tool,
                                     read_seconds=4.0)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    text = data.decode("utf-8", "replace")
    pass19 = (b"echo done" in data and b'"finish_reason":"tool_calls"' in data
              and b"0\r\n\r\n" in tail and "ok " in logtext
              and "retry after early finish" not in logtext
              and "stream broken" not in logtext)
    print("   收到工具=%s tool_calls收尾=%s 终止块=%s 未重发=%s"
          % (b"echo done" in data, b'"finish_reason":"tool_calls"' in data,
             b"0\r\n\r\n" in tail, "retry after early finish" not in logtext))
    print("   判定:", "PASS" if pass19 else "FAIL")
    ok = ok and pass19

    # 20) 只吐 reasoning 后上游 RST（读错误，客户端会判 upstream_stream_read_error）：
    #     代理必须丢弃本次尝试并内部重发（V0.2.6）。
    first_reset = [
        (b'data: {"choices":[{"delta":{"reasoning_content":"need more time"}}]}\n\n', 0.05),
    ]
    second_reset = [
        (b'data: {"choices":[{"delta":{"content":"answer after reset"}}]}\n\n', 0.05),
        (b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 0.05),
        (b"data: [DONE]\n\n", 0.0),
    ]
    chunks, logtext, tail = run_case("读错误后透明续写", args.src, first_reset,
                                     scripts=[first_reset, second_reset],
                                     read_seconds=8.0, rst_after=1)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    text = data.decode("utf-8", "replace")
    pass20 = (b"answer after reset" in data
              and b'"finish_reason":"stop"' in data
              and b"[DONE]" in data and '"error"' not in text
              and "early finish stream error" in logtext
              and "retry after early finish" in logtext
              and "stream broken" not in logtext)
    print("   收到正文=%s 日志重发=%s 未记broken=%s"
          % (b"answer after reset" in data, "retry after early finish" in logtext,
             "stream broken" not in logtext))
    print("   判定:", "PASS" if pass20 else "FAIL")
    ok = ok and pass20

    # 21) /cg 前缀路由（本机 Cherry 网关走 http）：假上游回显请求行和 Host，
    #     证明转发的路径与端口都正确，而不只是"前缀命中"。
    chunks, logtext, tail = run_case("cg 前缀路由", args.src, [],
                                     read_seconds=4.0, prefix="cg", echo=True)
    data = b"\n\n".join(c for _t, c in chunks) + tail
    text = data.decode("utf-8", "replace")
    pass21 = ("POST /v1/chat/completions HTTP/1.1" in text
              and "Host=127.0.0.1:" in text
              and b'"finish_reason":"stop"' in data
              and b"0\r\n\r\n" in tail and "ok " in logtext
              and '"error"' not in text)
    print("   路径正确=%s Host带端口=%s 正常收尾=%s"
          % ("POST /v1/chat/completions HTTP/1.1" in text,
             "Host=127.0.0.1:" in text, "ok " in logtext))
    print("   判定:", "PASS" if pass21 else "FAIL")
    ok = ok and pass21
    # 22) 通用 /p/<base64url(baseUrl)> 路由：base 带路径 /relay，请求带 query。
    #     期望拼成 /relay/v1/chat/completions?base=1&api-version=1，且 Host 带非默认端口。
    chunks, logtext, tail = run_case("通用 /p 路由", args.src, [],
                                     read_seconds=4.0, generic=True,
                                     generic_path="/relay?base=1", echo=True,
                                     query="api-version=1")
    data = b"\n\n".join(c for _t, c in chunks) + tail
    text = data.decode("utf-8", "replace")
    want_path = "POST /relay/v1/chat/completions?base=1&api-version=1 HTTP/1.1"
    pass22 = (want_path in text and "Host=127.0.0.1:" in text
              and b'"finish_reason":"stop"' in data
              and b"0\r\n\r\n" in tail and "ok " in logtext
              and '"error"' not in text)
    print("   路径拼接=%s Host带端口=%s 正常收尾=%s"
          % (want_path in text, "Host=127.0.0.1:" in text, "ok " in logtext))
    print("   判定:", "PASS" if pass22 else "FAIL")
    ok = ok and pass22

    # 23) /p 坏 token 必须回 400（空 token / 非 base64 / 非 http(s) / 非法端口），
    #     不能落到 8787 上无限重试，也不能 500。
    bad_tokens = ["/p", "/p/", "/p/@@@@", "/p/" + "A" * 5,
                  "/p/" + base64.urlsafe_b64encode(b"ftp://x").decode().rstrip("="),
                  "/p/" + base64.urlsafe_b64encode(b"http://").decode().rstrip("="),
                  "/p/" + base64.urlsafe_b64encode(b"http://h:99999").decode().rstrip("=")]
    results = []
    for path in bad_tokens:
        workdir = tempfile.mkdtemp(prefix="streamtest-")
        proxy_port = free_pair()
        env = {k: v for k, v in os.environ.items() if not k.startswith("PROXY_")}
        env.update(PROXY_PORT=str(proxy_port), PROXY_RETRY_WINDOW="1",
                   PROXY_RETRY_INTERVAL="0.1", PROXY_SILENCE_TIMEOUT="1")
        try:
            proxy = make_proxy_copy(args.src, workdir, proxy_port + 1)
            out = open(os.path.join(workdir, "proxy.log"), "w", encoding="utf-8")
            proc = subprocess.Popen([sys.executable, proxy], env=env, cwd=workdir,
                                    stdout=out, stderr=subprocess.STDOUT)
            try:
                end = time.time() + 8
                while time.time() < end:
                    try:
                        sk = socket.create_connection(("127.0.0.1", proxy_port), 0.3)
                        sk.close()
                        break
                    except OSError:
                        time.sleep(0.05)
                raw = call_raw(proxy_port, path).decode("latin-1")
                results.append((path, "400" in raw.split("\r\n")[0]
                                and "bad /p/ route token" in raw))
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()
                out.close()
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
    pass23 = all(ok for _p, ok in results)
    print("   坏 token 全部 400=%s (%s)"
          % (pass23, ", ".join("%s:%s" % (p, "PASS" if r else "FAIL")
                               for p, r in results)))
    print("   判定:", "PASS" if pass23 else "FAIL")
    ok = ok and pass23


    print("\n总体:", "全部通过" if ok else "有失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
