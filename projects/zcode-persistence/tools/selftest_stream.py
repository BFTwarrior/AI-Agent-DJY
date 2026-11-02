#!/usr/bin/env python3
"""自检：流式（SSE）回写路径。

不碰真实中转：假上游在本机回环上按脚本吐字节，代理用临时副本 + 临时端口。

验证十七件事（对应 2026-10-31 三轮复审与终验、2026-11-01 自动暂停修复）：
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

用法：python tools/selftest_stream.py            （默认读同包 src/retry_proxy.py）
      python tools/selftest_stream.py --src X
"""

import argparse
import os
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
    text = text.replace(
        'UPSTREAMS = {\n    "/ap": ("upstream-a.example.com", 443),\n'
        '    "/cm": ("upstream-b.example.com", 443),\n}',
        'UPSTREAMS = {\n    "/ap": ("127.0.0.1", %d, "http"),\n'
        '    "/cm": ("127.0.0.1", %d, "http"),\n}' % (upstream_port, upstream_port))
    assert '127.0.0.1", %d' % upstream_port in text, "改写 UPSTREAMS 失败，脚本结构变了"
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
                 no_response=False, scripts=None):
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
        for script in self.scripts:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            try:
                self._serve_one(conn, script)
            finally:
                try:
                    conn.close()
                except Exception:
                    pass

    def _serve_one(self, conn, script):
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
            if self.hold_after:
                time.sleep(self.hold_after)      # 故意不结束响应，制造"上游静默"
            if self.chunked:
                conn.sendall(b"0\r\n\r\n")
        except Exception:
            pass


def call_stream(proxy_port, read_seconds, idle=0.15, start_delay=0.0):
    """发一个流式请求，返回 (每条数据到达的时刻, 原始字节)。

    start_delay > 0 时先不读（模拟慢客户端/卡住的界面），用来验证背压不丢数据。
    """
    body = (b'{"model":"t","stream":true,"messages":'
            b'[{"role":"user","content":"hi"}]}')
    req = (b"POST /ap/v1/chat/completions HTTP/1.1\r\nHost: x\r\n"
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


def run_case(name, src, script, content_length=None, chunked=True,
             env_extra=None, read_seconds=4.0, heartbeat_start="100",
             hold_after=0, start_delay=0.0, no_response=False, scripts=None):
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
    logfile = os.path.join(workdir, "proxy.log")
    try:
        proxy = make_proxy_copy(src, workdir, upstream_port)
        with FakeUpstream(upstream_port, script, content_length=content_length,
                          chunked=chunked, hold_after=hold_after,
                          no_response=no_response, scripts=scripts):
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
                                           start_delay=start_delay)
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
    "依次跑 17 个场景并汇总；全部通过退出码 0。"
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

    # 5) 上游彻底静默：心跳照发，但累计静默到窗口必须收尾（不能无限挂着）
    #    HEARTBEAT_INTERVAL=1、RETRY_WINDOW=2；上游发 1 条后保持连接不动 8 秒。
    script = [(b"data: only\n\n", 0)]
    chunks, logtext, tail = run_case(
        "静默到窗口判截断", args.src, script, read_seconds=4.0, hold_after=8,
        env_extra={"PROXY_RETRY_WINDOW": "2"})
    said = "body silent" in logtext
    truncated = "truncated" in logtext
    closed = b"0\r\n\r\n" not in tail
    pass5 = said and truncated and closed
    print("   日志: %s" % [l.strip() for l in logtext.splitlines()
                         if "body silent" in l or "truncated" in l or "keepalive" in l][-4:])
    print("   静默截止=%s 记 truncated=%s 未补终止块=%s" % (said, truncated, closed))
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

    print("\n总体:", "全部通过" if ok else "有失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
