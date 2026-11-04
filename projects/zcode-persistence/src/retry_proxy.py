#!/usr/bin/env python3
"""本地重试代理：夹在 ZCode 和中转之间，失败自动重发。

ZCode 只看到最终结果，看不到中间失败。

重试触发条件（七类，v0.4.0 起覆盖"任何报错"）：
  1. 连接失败 / 连接被断 / 任何异常
  2. 上游返回任何非 2xx 状态码（含 4xx —— 用户规格是"只要是报错就重试"）
  3. 上游 SILENCE_TIMEOUT 秒内一个字节都不吐
  4. 流式提前结束：无正文/工具调用时缺 finish_reason、未知 finish_reason
     （含字面 other），或只发 [DONE] / 正常 EOF（V0.2.3）
  5. 上游直接发 SSE `{"error":...}`（如 stream_truncated），且尚无正文/工具调用
     （V0.2.4）
  6. 流在工具调用参数中途结束（客户端会判 tool_args_invalid，V0.2.5）：
     工具增量先缓冲，收尾时没有已写出内容就整体丢弃重发
  7. 流被读错误/静默超时打断，且只吐了 reasoning、没有正文/完整工具调用
     （客户端会判 upstream_stream_read_error，V0.2.6）：丢弃本次尝试并重发

重试次数：
  不按次数，按时间窗：默认持续重试 300 秒，每 20 秒一次（窗口内约 15 次尝试）；
  上游给了更长的 Retry-After（响应头或错误正文）就尊重它（上限 60 秒）。窗口/间隔由
  PROXY_RETRY_WINDOW / PROXY_RETRY_INTERVAL 覆盖；MAX_ATTEMPTS（默认 200）
  只是防跑飞的保险丝，正常路径碰不到。流式与非流式一致。
  实测上游失败以 HTTP 429（并发打满）为主，等几秒再发基本都能过。

心跳保活：
  流式请求从请求开始计时，**连续 80 秒没有任何上游输入**时才发第一条心跳
  （往对话里写一条 SSE 注释行 `: keepalive`），之后仍是每 80 秒没有输入就补一条，
  **不设次数上限**。心跳由独立时钟驱动，不等某个尝试失败才发。
  90→80 秒是为了和客户端 95 秒首字节超时之间多留 15 秒余量。

路径前缀选上游：
  /ap/...  -> https://upstream-a.example.com/v1/...
  /cm/...  -> https://upstream-b.example.com/v1/...
  /cg/...  -> http://127.0.0.1:27891/v1/...（本机 Cherry AI 连接中心）

不记录任何请求/响应内容，只记状态行。
"""

import base64
import http.client
import json
import math
from datetime import datetime
import os
import queue
import re
import socket
import struct
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def env_float(name, default):
    """同 env_int，但用于浮点参数（Retry-After 上限等）。写错就回落默认值。"""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return float(default)
    try:
        v = float(raw)
    except (TypeError, ValueError, OverflowError):
        return float(default)
    if not math.isfinite(v):        # NaN / inf / 1e999
        return float(default)
    return v


def env_int(name, default, lo=1, hi=1000000):
    """环境变量写错不能让代理起不来：代理起不来 = 模型完全不可用。
    解析失败、非有限值、越界一律回落默认值。"""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return int(default)
    try:
        v = float(raw)
    except (TypeError, ValueError, OverflowError):
        return int(default)
    if not math.isfinite(v):        # inf/1e999 转 int 会 OverflowError
        return int(default)
    if v < lo or v > hi:            # 65536 这种有限但非法的值也要挡
        return int(default)
    return int(v)


LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = env_int("PROXY_PORT", 8787, 1, 65535)
# 只用于 /__zp_health 的能力标记，让 ensure_proxy 能分辨"跑的是不是支持 /p 的新代码"。
PROXY_VERSION = "0.2.8"

# 重试策略：按"时间窗"而不是次数。默认持续重试 5 分钟，每 20 秒一次（窗口内约 15 次）。
# MAX_ATTEMPTS 只保留为防跑飞的保险丝，正常永远碰不到。
RETRY_WINDOW = env_int("PROXY_RETRY_WINDOW", 300, 1, 3600)
RETRY_INTERVAL = max(0.05, min(env_float("PROXY_RETRY_INTERVAL", 20.0), 600.0))
MAX_ATTEMPTS = env_int("PROXY_MAX_ATTEMPTS", 200, 1, 1000)
SILENCE_TIMEOUT = env_int("PROXY_SILENCE_TIMEOUT", 30)
CONNECT_TIMEOUT = env_int("PROXY_CONNECT_TIMEOUT", 10)
SEND_TIMEOUT = env_int("PROXY_SEND_TIMEOUT", 90)

# 心跳：等到 HEARTBEAT_START 秒仍无任何数据才开始发，之后按 HEARTBEAT_INTERVAL 定时补发。
# 由独立时钟 next_hb_at 驱动，不挂在"某次尝试失败"的边界上。
# 80s 而不是 95s：与客户端首字节超时之间留 15 秒余量，退避期间也不会先超时。
HEARTBEAT_START = env_int("PROXY_HEARTBEAT_START", 80)
HEARTBEAT_INTERVAL = env_int("PROXY_HEARTBEAT_INTERVAL", 80)

def parse_retry_after(value):
    """Retry-After 既可能是秒数，也可能是 HTTP 日期（RFC 7231 允许）。
    解析不出来就当没给，按 RETRY_INTERVAL 的固定间隔重试。"""
    if not value:
        return 0.0
    try:
        return min(float(value), RETRY_AFTER_CAP)
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime
        when = parsedate_to_datetime(value)
        return min(max(0.0, (when - datetime.now(when.tzinfo)).total_seconds()),
                   RETRY_AFTER_CAP)
    except Exception:
        return 0.0


def retryable_status(code):
    """任何非 2xx 都重试（用户规格：只要是报错就重试）。"""
    return not (200 <= code < 300)


def error_body(message):
    """放弃时回给客户端的错误体。

    这里必须让 ZCode 客户端认出"可重试"，否则它会把整轮判死（retryable=false），
    用户看到的就是"任务被强制结束"。客户端运行时（zcode.cjs）的判定是：
        任一错误节点 retryable===true
        || code ∈ {model_request_timeout, model_rate_limited,
                   model_server_error, model_network_error}
        || reason ∈ {stream_idle_timeout, rate_limited, server_error,
                     network_error, timeout}
    命中后它会用自己的流恢复重试（最多 10 次），且恢复时带 previous-message-anchor
    —— 接着上次输出往下写，等价于自动发一条"继续"。
    正常结束、用户手动停止、暂停都不会走到这里，所以不会误触发。

    只给"代理耗尽重试"（503）用。客户端自己写错请求（400）必须回
    invalid_body：那种错重发多少次都一样，标成可重试只会把确定性失败放大 10 倍。
    """
    return {
        "message": message,
        "type": "server_error",
        "code": "model_server_error",   # 客户端 F7a 集合里的码
        "reason": "server_error",       # 客户端 j7a 集合里的原因
        "retryable": True,              # 客户端判定链的第一条
    }


def invalid_body(message):
    "客户端自己写错请求（400）时回的错误体：明确不可重试。"
    return {
        "message": message,
        "type": "invalid_request_error",
        "code": "invalid_request",
        "reason": "invalid_request",
        "retryable": False,
    }


RETRY_AFTER_CAP = max(0.0, env_float("PROXY_RETRY_AFTER_CAP", 60.0))

# 非 2xx 时只探测正文开头这么多字节，找网关写在正文里的等待提示。
# 错误页可能很大（Cloudflare HTML），整读会拖住重试；正文绝不写日志。
ERROR_BODY_PROBE = 64 * 1024

# 探测正文的总墙钟预算：正文分段到达时最多等这么久，避免慢错误页拖住重试。
ERROR_BODY_BUDGET = 1.0


def retry_after_from_body(body, complete=True):
    """从错误正文补读服务端给的等待秒数。

    Cloudflare/中转的 502/503 常把等待时间写在正文里
    （`"retry_after":60` 或 `Retry-After: 5`），响应头反而没有；调用方与
    响应头取较长者。只匹配数字，不解析、不记录正文；上限同 RETRY_AFTER_CAP。

    `complete=False` 表示正文还没读完（到了 64KB 上限或预算）：如果匹配正好
    结束在缓冲区末尾，数字可能被切断，宁可返回 0 也不采用半截值。
    """
    if not body:
        return 0.0
    number = rb'(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)'
    match = re.search(rb'"retry[_-]?after"\s*:\s*' + number, body, re.I)
    if match is None:
        match = re.search(rb'retry[_-]?after["\']?\s*[:=]\s*' + number, body, re.I)
    if match is None:
        return 0.0
    if not complete and match.end() == len(body):
        return 0.0
    try:
        return min(float(match.group(1)), RETRY_AFTER_CAP)
    except ValueError:
        return 0.0


def probe_retry_after(resp, conn):
    """分段读取错误正文，直到 EOF、读满 64KB 或超出预算。

    探测前把 socket 超时临时压到预算（探测完就关连接，无需恢复），这样
    上游发一段后停住时，read1 不会一直阻塞到 SILENCE_TIMEOUT。正文只在
    内存里做一次正则，不写日志。
    """
    sock = body_socket(resp, conn)
    if sock is not None:
        try:
            sock.settimeout(min(ERROR_BODY_BUDGET, SILENCE_TIMEOUT))
        except Exception:
            pass
    chunks = []
    total = 0
    eof = False
    deadline = time.monotonic() + ERROR_BODY_BUDGET
    while total < ERROR_BODY_PROBE:
        try:
            part = resp.read1(ERROR_BODY_PROBE - total)
        except Exception:
            break
        if not part:
            eof = True
            break
        chunks.append(part)
        total += len(part)
        if time.monotonic() >= deadline:
            break
    return retry_after_from_body(b"".join(chunks), complete=eof)


DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# 值可以是 (host, port) 或 (host, port, scheme)；scheme 默认 https。
# 允许 http 是为了本地测试和自建反代。
UPSTREAMS = {
    "/ap": ("upstream-a.example.com", 443),
    "/cm": ("upstream-b.example.com", 443),
    "/cg": ("127.0.0.1", 27891, "http"),
}

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
    "content-length", "accept-encoding",
    # send_response() 会自己补 Server / Date，上游的就不再透传，避免重复头
    "server", "date",
}


def _build_ssl_context():
    """Windows 自带根证书库缺 SSL.com 等根，会导致校验失败。
    优先用 certifi 的 CA 包，没有就退回系统默认。"""
    import ssl
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


SSL_CONTEXT = _build_ssl_context()

_lock = threading.Lock()


def log(msg):
    # 上游可能把密钥放在 query 里，日志统一抹掉，避免落盘泄漏
    "写一行状态日志；含 ? 的部分按 query 脱敏，绝不记录请求/响应正文。"
    if "?" in msg:
        msg = re.sub(r"\?[^\s)]*", "?<redacted>", msg)
    # /p/<token> 里的 token 是原始 baseUrl 的 base64，可逆；只留前 8 位便于
    # 对照是哪个 provider，不把完整地址（可能含密钥）写进日志。
    msg = re.sub(r"/p/([A-Za-z0-9_-]{8,})",
                 lambda m: "/p/" + m.group(1)[:8] + "…", msg)
    with _lock:
        # 带日期：报错邮件要按时间把 giveup 与报错时刻对齐（只有时分秒时跨天会张冠李戴）
        sys.stdout.write("%s\t%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
        sys.stdout.flush()


def read_body(handler):
    """读完整请求体，兼容 chunked。

    读不对就返回 None，让调用方回 400 并断开——早期版本遇到非法 chunk 长度会
    直接 break，把半截 body 当完整请求转发，残留字节还会被 keep-alive 当成
    下一个请求，客户端因此收到一段莫名其妙的 400 HTML。
    """
    if handler.headers.get("Transfer-Encoding", "").lower() == "chunked":
        chunks = []
        while True:
            line = handler.rfile.readline().strip()
            if not line:
                return None                      # 缺终止块
            try:
                size = int(line.split(b";")[0], 16)
            except ValueError:
                return None                      # 非法长度
            if size < 0:
                return None
            if size == 0:
                # 0 块之后可能有 trailer，读到空行才结束（否则残留字节会被
                # keep-alive 当成下一个请求解析）
                # 正常客户端最多一两条 trailer。上限 100 行：第 100 行后
                # 遇到空行正常结束，第 101 行即判畸形，避免残留字节污染下一个请求。
                trailers = 0
                while True:
                    trailer = handler.rfile.readline()
                    if not trailer or not trailer.strip():
                        return b"".join(chunks)
                    trailers += 1
                    if trailers > 100:
                        return None
            chunk = handler.rfile.read(size)
            if len(chunk) != size:
                return None                      # 提前 EOF
            chunks.append(chunk)
            handler.rfile.readline()
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except (TypeError, ValueError):
        return None                              # Content-Length 不是数字
    if length < 0:
        return None
    if not length:
        return b""
    body = handler.rfile.read(length)
    return body if len(body) == length else None    # 客户端提前断开


class Attempt(object):
    """一次上游尝试的结果。reason 决定要不要切心跳模式。"""

    __slots__ = ("resp", "conn", "reason", "detail", "retry_after")

    def __init__(self, resp=None, conn=None, reason="ok", detail="", retry_after=0.0):
        self.resp = resp
        self.conn = conn
        self.reason = reason
        self.detail = detail
        self.retry_after = retry_after  # 上游给了 Retry-After 就按它的节奏等


def fetch_once(host, port, scheme, method, path, headers, body):
    """向上游发一次请求，返回 Attempt。

    reason:
      ok       —— 拿到了响应（resp 有效）
      connect  —— 连接/发送阶段失败（快速失败，可立刻重试）
      silence  —— 连上了但 SILENCE_TIMEOUT 秒内没有响应头（沉默，可切心跳）
      status   —— 拿到了需要重试的状态码（任何非 2xx）
      other    —— 其它异常
    """
    if scheme == "http":
        conn = http.client.HTTPConnection(host, port, timeout=CONNECT_TIMEOUT)
    else:
        conn = http.client.HTTPSConnection(host, port, timeout=CONNECT_TIMEOUT,
                                           context=SSL_CONTEXT)
    try:
        # 显式建连，把"发请求"和"等响应"的超时分开：
        # 上下文体量可达数百 KB，用连接超时（10s）去写完会误判为失败。
        conn.connect()
        conn.sock.settimeout(SEND_TIMEOUT)
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for k, v in headers:
            conn.putheader(k, v)
        default_port = 443 if scheme == "https" else 80
        host_hdr = host if port == default_port else "%s:%d" % (host, port)
        if ":" in host and not host.startswith("["):
            # IPv6 字面量在 Host 头里必须加方括号，否则端口部分会被当成
            # 地址的一部分（::1:8080 无法解析）。
            host_hdr = "[%s]%s" % (host, "" if port == default_port else ":%d" % port)
        conn.putheader("Host", host_hdr)
        conn.putheader("Content-Length", str(len(body)))
        conn.endheaders()
        if body:
            conn.send(body)
    except Exception as exc:
        try:
            conn.close()
        except Exception:
            pass
        return Attempt(reason="connect", detail=repr(exc))

    try:
        conn.sock.settimeout(SILENCE_TIMEOUT)
    except Exception:
        pass

    try:
        resp = conn.getresponse()
    except (socket.timeout, TimeoutError):
        try:
            conn.close()
        except Exception:
            pass
        return Attempt(reason="silence",
                       detail="no response head in %ds" % SILENCE_TIMEOUT)
    except Exception as exc:
        try:
            conn.close()
        except Exception:
            pass
        return Attempt(reason="other", detail=repr(exc))

    if retryable_status(resp.status):
        retry_after = parse_retry_after(resp.getheader("Retry-After"))
        try:
            # 有界探测：分段读到 64KB 或命中提示为止；正文不写日志（只记状态行）。
            retry_after = max(retry_after, probe_retry_after(resp, conn))
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass
        return Attempt(reason="status", detail="HTTP %d" % resp.status,
                       retry_after=retry_after)

    return Attempt(resp=resp, conn=conn, reason="ok")


def body_socket(resp, conn):
    """找出响应体实际在读的那个 socket。

    上游回 `Connection: close` 时，http.client 会把 conn.sock 置 None（连接对象
    已被它 close，但 makefile 的引用计数让 fd 仍然有效）。这时候只能从响应自己的
    缓冲流里把 socket 取回来，否则改不了读超时 —— 那就会退化成"静默即截断"。
    """
    sock = getattr(conn, "sock", None)
    if sock is not None:
        return sock
    raw = getattr(getattr(resp, "fp", None), "raw", None)
    sock = getattr(raw, "_sock", None)
    return sock if sock is not None else None


def pipe_response(handler, resp, conn, path, started, sse_started=False, heartbeat=False):
    """把上游响应回写给客户端（chunked 编码）。

    sse_started=True 表示响应头已经由心跳模式发过了（200 + event-stream），
    此时绝不能再发一次状态行，否则会把状态行写进响应体导致内容损坏。
    heartbeat=True 表示客户端要的是流式响应，可以在长时间没有上游字节时
    往流里写 SSE 心跳注释行，把客户端续住（响应头之后同样适用）。
    """
    if not sse_started:
        handler.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() not in HOP_BY_HOP:
                handler.send_header(k, v)
        if resp.status in (204, 304):
            # RFC 7230：204/304 既不能带 Transfer-Encoding 也不能有 body
            handler.end_headers()
            try:
                conn.close()
            except Exception:
                pass
            log("ok %s status=%d bytes=0 (no body)" % (path, resp.status))
            return
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()

    total = 0
    first = None
    completed = False
    # read1 是"底层读到多少就给多少"，不会为凑满 8192 字节而攒批。
    # 用 read(8192) 时 chunked 响应要等攒够 8KB 或流结束才返回，
    # 一次模型吐几十字节会被压到 8KB 才发给客户端，看起来就是不流式。
    read = getattr(resp, "read1", None) or resp.read
    # 只有响应体确实是 SSE 才允许插心跳：往 JSON 里写注释行会直接把内容写坏。
    ctype = (resp.getheader("Content-Type") or "").lower()
    can_hb = bool(heartbeat) and (sse_started or ctype.startswith("text/event-stream"))
    is_sse = bool(sse_started or ctype.startswith("text/event-stream"))
    pending = b""
    # text_out：content 真的写给客户端了。客户端 Eqo() 只看“已丢弃的正文字节
    # >0”，所以所有“能不能内部重发/RST”的判断必须用 text_out；上游发过 content
    # 但还压在工具缓冲里（同事件带 tool_calls）不算。
    text_out = False
    tool_out = False
    saw_choices = False
    finish_out = False
    early = False
    # V0.2.7：正文已经写出、后面却残缺/上游报错时，内部重发会重复正文，不能
    # 再走 early。改为 RST 客户端连接：客户端把传输层 ECONNRESET 当作可重试
    # 错误，丢弃这段残缺输出并用 previous-message-anchor 续写（Sqo=10 次预算）。
    # 不能发 SSE 业务错误——客户端会包成 ProviderBusinessError，retryable 恒为 false。
    client_reset = False
    # 客户端写失败（关窗/取消）不能当成上游失败去重发；emit() 置位。
    client_gone = False
    # 工具调用增量先缓冲、写完整再出手（V0.2.5）。线上实测：上游经常在工具参数
    # 发到一半时就把流结束（无 finish_reason=tool_calls），客户端拿到"开了头没
    # 结尾"的工具调用，判 tool_args_invalid、retryable=false，回合失败。
    # 缓冲期间这些字节不出代理：流在工具调用中途结束且还没有任何已写出的
    # 正文/完整工具调用时，可以整体丢弃并内部重发。
    # 必须是**按到达顺序**的 list，不能按 index 分组：分组后 sorted() 会把
    # 后到的低 index 事件提前写出，多 index 的分片顺序就乱了，客户端按 index
    # 拼出来的参数会变成非法 JSON（甚至拼成错误命令）。每项是
    # (line, has_content, has_finish)，flush 时按原顺序逐行写出。
    tool_buf = []
    # 正常/可接受的结束原因。其它未知值（含字面 "other"）在“没有正文/工具调用”
    # 时一律按异常提前结束处理：客户端会把未知值映射成 other，然后当正常完成收掉回合。
    safe_finish = ("stop", "length", "content_filter",
                   "tool_calls", "tool_call", "function_call")

    def emit(data):
        "写一个 chunked 块；所有回写都走这里，保证 total/first 统计一致。"
        nonlocal total, first, client_gone
        if first is None:
            first = time.time() - started
        try:
            handler.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
            handler.wfile.flush()
        except Exception:
            client_gone = True
            raise
        total += len(data)

    def early_finish(why):
        """记录一次“上游没产出就结束”，交给 _handle 丢弃并重发。

        这里刻意不向客户端发错误：2026-11-02 实测，mid-stream 的 SSE error 会被
        ZCode 归成 ProviderBusinessError（retryable=false），整轮直接失败，不会自动
        续写。真正可行的做法是代理内部再发一次上游请求，把新流的 reasoning/正文
        接着写进同一个响应；客户端只看到流还在继续。
        """
        nonlocal early
        early = True
        log("early finish %s after %d bytes %s" % (why, total, path))
        return True

    def reject_constant(value):
        """JSON.parse 不接受 NaN/Infinity；Python 默认接受，这里必须对齐。"""
        raise ValueError("non-finite JSON constant: %s" % value)

    def tools_complete():
        """缓冲里的每个工具调用都必须有名字 + 合法 JSON 参数。

        V0.2.7：上游可能在 `finish_reason=tool_calls` 之后才结束，但参数仍是
        残缺 JSON；V0.2.5 只按“流结束”判断，会把这种调用当完整调用放行。
        客户端用 JSON.parse 判断完整性（iyn），解析失败就永远不发 tool-call，
        最后判 tool_args_invalid。所以代理必须自己先按同样标准验一遍。
        按到达顺序累加每个 index 的 arguments，与客户端拼接顺序一致。
        """
        names = {}
        args = {}
        for line, _hc, _hf in tool_buf:
            if not line.startswith(b"data:"):
                continue
            try:
                obj = json.loads(line[5:].strip().decode("utf-8", "replace"))
            except Exception:
                continue
            for choice in obj.get("choices") or []:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta") or {}
                for item in delta.get("tool_calls") or []:
                    if not isinstance(item, dict):
                        continue
                    k = -1
                    if "index" in item:
                        try:
                            k = int(item["index"])
                        except (TypeError, ValueError):
                            k = -1
                    fn = item.get("function") or {}
                    if isinstance(fn.get("name"), str) and fn["name"]:
                        names[k] = fn["name"]
                    a = fn.get("arguments")
                    if isinstance(a, str) and a:
                        args[k] = args.get(k, "") + a
                fc = delta.get("function_call")
                if isinstance(fc, dict):
                    if isinstance(fc.get("name"), str) and fc["name"]:
                        names[-1] = fc["name"]
                    a = fc.get("arguments")
                    if isinstance(a, str) and a:
                        args[-1] = args.get(-1, "") + a
        for key in set(names) | set(args):
            if key not in names:
                return False
            text = (args.get(key) or "").strip()
            if not text:
                return False
            try:
                json.loads(text, parse_constant=reject_constant)
            except Exception:
                return False
        return True

    def flush_tools():
        """把缓冲的工具调用按到达顺序写出；参数不完整时一个字节都不写。

        V0.2.7：不再“到收尾就 flush”。残缺参数一旦写给客户端，客户端就
        必然判 tool_args_invalid。返回 False 表示缓冲里有调用不完整。
        """
        nonlocal tool_out, text_out, finish_out
        if not tools_complete():
            return False
        for line, has_content, has_finish in tool_buf:
            emit(line)
            emit(b"\n")
            if has_content:
                text_out = True
            if has_finish:
                finish_out = True
        if tool_buf:
            tool_out = True
        tool_buf.clear()
        return True

    def reset_for_recovery(why):
        """正文已写出、工具调用残缺：RST 客户端连接，让客户端自己续写。

        V0.2.7：内部重发会把用户已经看到的正文再写一遍，不能再走 early。
        发 SSE 业务错误也没用：客户端把它包成 ProviderBusinessError，
        retryable 恒为 false（2026-11-02 实测）。客户端唯一认的恢复入口是
        **传输层错误**：它看到 ECONNRESET 且有 partial 输出时，会丢弃这段
        输出、用 previous-message-anchor 重新请求（最多 10 次）。
        所以这里不给终止块，直接 SO_LINGER=0 关客户端 socket 制造 RST。
        """
        nonlocal client_reset
        client_reset = True
        handler._zp_client_reset = True
        # 必须同时置 close_connection：BaseHTTPRequestHandler.handle() 是
        # while not close_connection 的循环。只关 socket 不置位的话，下一轮
        # handle_one_request 会对已关闭的 rfile readline，ValueError 被兜底
        # 吞掉后继续循环——每次 RST 泄漏一个 100% CPU 的空转线程（实测）。
        handler.close_connection = True
        log("reset client for recovery (%s) %s" % (why, path))
        try:
            sock = handler.connection
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                                struct.pack("ii", 1, 0))
            except Exception as exc:
                # 设不上也要继续关连接：宁可让客户端看到 FIN，也不能挂着。
                log("client reset setsockopt failed: %r %s" % (exc, path))
            # 只关 socket 对象不够：handler.wfile/rfile 还持有同一个 fd 的引用，
            # CPython 要等引用计数归零才真正 close，结果客户端既收不到 RST、
            # 也收不到 FIN，只会一直挂着（2026-11-03 Node 端到端实测）。
            # 先关这两个文件对象，再关 socket，SO_LINGER=0 才会真的发 RST。
            for name in ("wfile", "rfile"):
                stream = getattr(handler, name, None)
                try:
                    if stream is not None and not stream.closed:
                        stream.close()
                except Exception:
                    pass
            sock.close()
        except Exception as exc:
            log("client reset failed: %r %s" % (exc, path))
        return True

    def process_sse(data, emit_lines=True):
        """边转发边检查结束原因。

        2026-11-01 实测：上游在只吐了少量 reasoning、没有正文/工具调用时，经常
        **根本不给 finish_reason**（客户端日志里 rawFinishReason 为空），ZCode 的
        `Bto(undefined)` 会把它归成 other 并当正常完成（turn.completed），回合就停在
        半路；如果上游给的是字面 other / 其它未知值，结果一样。这里在 `[DONE]`
        或正常 EOF 之前截住，丢弃这次尝试并让 _handle 重发上游。
        正常 stop/tool_calls，以及已经有正文/完整工具调用的流，一律原样转发——
        重发会把用户已经看到的内容再写一遍。
        工具调用增量是例外（V0.2.5）：先缓冲，等 finish_reason 或收尾时整体写出；
        流在工具调用中途结束且尚无已写出内容时，可以整体丢弃重发。已经有正文
        但工具参数残缺时（V0.2.7），RST 客户端让它丢弃残缺输出自行续写。
        """
        nonlocal pending, text_out, tool_out, saw_choices, finish_out
        pending += data
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            line += b"\n"
            emit_this = True
            has_content = False
            has_finish = False
            if line.startswith(b"data:"):
                raw = line[5:].strip()
                if raw:
                    if raw == b"[DONE]":
                        # 客户端收到 [DONE] 就结束流；此前没有任何结束原因时，
                        # 它会按 other 收掉回合，所以必须在这一行之前截住。
                        if tool_buf:
                            if (not text_out and not tool_out
                                    and not finish_out):
                                return early_finish("incomplete tool call at DONE")
                            if not flush_tools():
                                if (not text_out and not tool_out
                                        and not finish_out):
                                    return early_finish("incomplete tool call at DONE")
                                if not tool_out and not finish_out:
                                    return reset_for_recovery("incomplete tool call at DONE")
                                # 已经有完整工具调用写出，重试会重复执行；
                                # 丢掉这次的残缺调用，让回合按已写出的内容收尾。
                                tool_buf.clear()
                        if (saw_choices and not finish_out
                                and not text_out and not tool_out):
                            return early_finish("missing finish_reason")
                    else:
                        try:
                            obj = json.loads(raw.decode("utf-8", "replace"))
                        except Exception:
                            obj = None
                        if isinstance(obj, dict):
                            choices = obj.get("choices")
                            if isinstance(choices, list) and choices:
                                saw_choices = True
                                has_tc = False
                                fr = None
                                for choice in choices:
                                    if not isinstance(choice, dict):
                                        continue
                                    delta = choice.get("delta")
                                    if isinstance(delta, dict):
                                        if delta.get("content"):
                                            has_content = True
                                        if (delta.get("tool_calls")
                                                or delta.get("function_call")):
                                            has_tc = True
                                    f = choice.get("finish_reason")
                                    if isinstance(f, str) and f:
                                        fr = f
                                if fr is not None:
                                    has_finish = True
                                    # 先判安全性再 flush：未知结束原因 + 尚无已
                                    # 写出内容时，缓冲里的残缺工具调用一并丢弃、
                                    # 整体重发；已经有内容则照旧放行。
                                    if (fr not in safe_finish
                                            and not text_out and not tool_out):
                                        return early_finish("reason=%s" % fr)
                                if has_tc:
                                    # 工具调用增量：只入缓冲，不写出去。按到达
                                    # 顺序保存整行（含同事件里的 content/finish），
                                    # flush 时原序写出，避免多 index 乱序。
                                    tool_buf.append((line, has_content, has_finish))
                                    emit_this = False
                                elif tool_buf and fr is not None:
                                    # 只在结束原因出现时结算工具调用阶段。
                                    # 正文出现后仍可能再补参数，提前 flush
                                    # 会把“还没传完”误判成残缺。
                                    if not flush_tools():
                                        if (not text_out and not tool_out
                                                and not finish_out):
                                            return early_finish("incomplete tool call")
                                        if not tool_out and not finish_out:
                                            return reset_for_recovery("incomplete tool call at finish")
                                        tool_buf.clear()
                            # 先记账同一事件里的 choices/delta，再判断 error：若上游
                            # 把正文和 error 塞进同一条事件，正文要算数，不能吞。
                            # 上游有时不回 finish_reason，而是直接发一条 SSE
                            # `{"error":{...}}`（线上实测 code=stream_truncated）。
                            # 客户端会把它归成 ProviderBusinessError、
                            # retryable=false，整轮直接失败。没有正文/完整工具
                            # 调用时吞掉并 early 重发；已有正文但还没有完整工具
                            # 调用时 RST，让客户端丢弃这段输出自行续写（V0.2.7）；
                            # 已有完整工具调用或已经收到结束原因时原样转发，
                            # 重发会造成重复/重复执行工具。
                            err = obj.get("error")
                            if err and not finish_out:
                                if isinstance(err, dict):
                                    why = err.get("code") or err.get("message") or "error"
                                else:
                                    why = err
                                # 只记状态行：message 截断、去换行，避免把上游
                                # 原文（可能很长）写进日志破坏一行一条的解析。
                                why = " ".join(str(why).split())[:80]
                                if not text_out and not tool_out:
                                    return early_finish("upstream error: %s" % why)
                                if text_out and not tool_out:
                                    return reset_for_recovery(
                                        "upstream error after content: %s" % why)
            if emit_lines and emit_this:
                emit(line)
                if has_content:
                    text_out = True
                if has_finish:
                    finish_out = True
        return False

    # 响应头之后的静默处理。
    #
    # 约束（都实测过）：
    #   · http.client 的缓冲流一旦读超时就被标记 unusable，之后每次读都抛
    #     "cannot read from timed out object"；
    #   · 超时后强行复位标记继续读也不行：chunked 的块长度行由 readline 读取，
    #     超时会让半行数据丢掉，下一次从残行解析必然失步（IncompleteRead）；
    #   · Windows 上 shutdown()/close() 叫不醒另一个线程里阻塞中的 read1，
    #     所以"看门狗关连接来打断读"这条路是死路（会和 BufferedReader 的锁互等）。
    #
    # 因此：读取放进独立线程（它只负责阻塞读和投递），主线程只消费队列，
    # 顺便按时发心跳、到点判截断。主线程从不直接碰 socket，也就没有打断需求。
    # 主线程收尾时置位 stop：读取线程若卡在投递（队列满/没人消费）会立刻退出；
    # 若正卡在阻塞读，只能等 socket 超时（RETRY_WINDOW+30 秒）——Windows 上
    # 无法从外部打断 read1，这是这一路设计无法避免的滞留上限。
    queue_ = queue.Queue(maxsize=64)
    stop = threading.Event()

    def put(item):
        """投递结果。

        不能"队列满就放弃"：那样慢客户端会让上游数据被静默丢掉，日志还会把它
        误报成"body silent"。这里改成阻塞投递（每 0.5 秒看一眼 stop），队列满
        时读取线程停在那里不读，TCP 背压自然传导给上游——慢客户端只会变慢，
        不会丢内容。主线程已经收尾（stop 置位）时才放弃。
        """
        while not stop.is_set():
            try:
                queue_.put(item, timeout=0.5)
                return True
            except queue.Full:
                continue
        return False

    def reader():
        "只做阻塞读：读到数据/EOF/异常都投递到队列，结束时关掉上游。"
        try:
            while not stop.is_set():
                chunk = read(8192)
                if not chunk:
                    put((None, None))       # EOF 哨兵必须投递成功，否则主线程只能等到窗口
                    return
                if not put(("data", chunk)):
                    return
        except Exception as exc:
            put(("error", repr(exc)))
        finally:
            try:
                resp.close()
            except Exception:
                pass

    bsock = body_socket(resp, conn)
    if can_hb:
        if bsock is not None:
            try:
                # 只做"泄漏保险"：正常路径主线程会先到截止时间，轮不到这个超时。
                # 读取线程只在"完全静默"的上游上才会走到这个超时；涓流上游靠
                # stop 事件在每次 put 时退出（见 put()）。
                bsock.settimeout(float(RETRY_WINDOW) + 30.0)
            except Exception:
                pass
        else:
            log("body socket unavailable, heartbeat limited (AGENTS.md inv.18) %s" % path)
        threading.Thread(target=reader, daemon=True).start()

    last_upstream = time.time()
    next_hb_at = last_upstream + HEARTBEAT_INTERVAL

    try:
        while True:
            if can_hb:
                try:
                    kind, payload = queue_.get(timeout=0.5)
                except queue.Empty:
                    # 静默中：心跳按独立时钟发，截断只看"距最后一次收到字节"多久
                    now = time.time()
                    if now - last_upstream >= RETRY_WINDOW:
                        raise TimeoutError("body silent %.0fs" % (now - last_upstream))
                    if now >= next_hb_at:
                        if not handler._heartbeat():
                            client_gone = True
                            raise ConnectionError("client gone during silent stream")
                        log("keepalive after %.0fs body silence %s"
                            % (now - last_upstream, path))
                        next_hb_at = now + HEARTBEAT_INTERVAL
                    continue
                if kind == "error":
                    raise IOError(payload)
                if kind is None:
                    break
                chunk = payload
            else:
                chunk = read(8192)
                if not chunk:
                    break
            last_upstream = time.time()
            next_hb_at = last_upstream + HEARTBEAT_INTERVAL
            if is_sse:
                if process_sse(chunk):
                    break
            else:
                emit(chunk)
        # 提前结束：丢掉这次上游响应，由 _handle 立刻再发一次；客户端连接保持打开，
        # 已经转发出去的 reasoning 不会撤回，新流的正文会接着写进同一个响应。
        if client_reset:
            return "client_reset"
        if early:
            return "early"
        # pending 只可能是“最后一行没有换行”。它可能是完整事件，也可能在 JSON
        # 中间被断开：半截 data: 行绝不能转发（重试流再追加时会合成非法事件）。
        # 完整行必须正常转发——否则正文被解析出来却没写给客户端，
        # 后面的“缺 finish_reason”判定会因为 text_out 仍为 False 而误判。
        if is_sse and pending:
            complete = True
            if pending.startswith(b"data:"):
                raw = pending[5:].strip()
                if raw and raw != b"[DONE]":
                    try:
                        json.loads(raw.decode("utf-8", "replace"))
                    except Exception:
                        complete = False
            if process_sse(b"\n", emit_lines=complete):
                return "client_reset" if client_reset else "early"
            if complete:
                # SSE 以空行分事件。最后一行补的 \n 只结束行、不结束事件；
                # 若随后 early 重发，新流的第一行会粘进同一个事件，data 里
                # 变成两段 JSON，客户端解析失败。所以完整行要补事件终止空行。
                emit(b"\n")
            pending = b""
        # 上游既没发 [DONE] 也没给 finish_reason，只是正常关闭了连接：客户端同样会
        # 把它当成完成，所以同样丢弃这次尝试并重发。
        # 缓冲里还有没写出去的工具调用（V0.2.5：流在工具参数中途结束）：还没有
        # 任何已写出内容时整体丢弃重发；否则只能写出，让客户端按残缺收尾。
        if is_sse and tool_buf:
            if not flush_tools():
                if not text_out and not tool_out and not finish_out:
                    early_finish("incomplete tool call at EOF")
                    return "early"
                if not tool_out and not finish_out:
                    reset_for_recovery("incomplete tool call at EOF")
                    return "client_reset"
                # 已有完整工具调用/结束原因写出：重试会重复执行，只能丢掉这次残缺调用。
                tool_buf.clear()
        if (is_sse and saw_choices and not finish_out
                and not text_out and not tool_out):
            early_finish("missing finish_reason at EOF")
            return "early"
        # Content-Length 定长响应：上游声明 N 字节却提前 EOF 时，http.client
        # 的 read1 只返回短数据、不抛异常，不能当成完整响应（否则还会误补终止块）。
        completed = not getattr(resp, "length", 0)
    except Exception as exc:
        # 上游读错误/静默超时：如果只吐了 reasoning（没有正文/完整工具调用），
        # 客户端还没有可用产出，丢弃本次尝试并内部重发（V0.2.6）。
        # 客户端自己断开（关窗/取消）不能重发，否则只是空转。
        if (is_sse and not client_gone and not text_out and not tool_out
                and not finish_out):
            early = True
            log("early finish stream error: %s after %d bytes %s"
                % (" ".join(repr(exc).split())[:120], total, path))
        else:
            if client_gone:
                # 客户端关窗/取消导致的写失败，不是上游故障；日志要能一眼分清，
                # 否则排查时会把它算到中转头上。
                log("client gone after %d bytes %s" % (total, path))
            else:
                log("stream broken after %d bytes: %r" % (total, exc))
                # V0.2.7：上游在读错误/静默里结束，但正文已经写出（工具参数
                # 残缺或纯文本截断都一样）。只发 FIN 时客户端把截断当普通流
                # 错误（retryable=false）；必须 RST，客户端才会丢弃这段输出
                # 并用锚点续写。已收到 finish 或已有完整工具调用则不 RST。
                if (is_sse and text_out and not tool_out
                        and not finish_out):
                    reset_for_recovery("stream error after content")
    finally:
        # 先让读取线程别再往队列里塞东西（它在 put 的 0.5 秒超时里能看到 stop），
        # 再写终止块/关连接。读取线程若正阻塞在 read1，只能等它自己的 socket 超时。
        stop.set()
        if client_reset:
            # 已经用 SO_LINGER=0 关掉客户端 socket 制造 RST；这里不能再写
            # 终止块，也无需再标记关闭。
            pass
        elif early:
            # 只关上游连接；客户端连接留给下一次尝试继续写，不能补终止块、
            # 也不能置 close_connection，否则客户端会把流当成正常结束。
            pass
        elif completed:
            try:
                handler.wfile.write(b"0\r\n\r\n")
                handler.wfile.flush()
            except Exception:
                pass
        else:
            handler.close_connection = True
        try:
            conn.close()
        except Exception:
            pass

    if client_reset:
        return "client_reset"
    if early:
        return "early"
    if completed:
        log("ok %s status=%d bytes=%d first=%.2fs" % (
            path, resp.status, total, first if first is not None else -1))
    else:
        log("truncated %s status=%d bytes=%d (client sees an incomplete stream)"
            % (path, resp.status, total))
    return "done"


class Handler(BaseHTTPRequestHandler):
    "单请求处理器：选上游、读 body、按状态机重试，成功后回写（支持 SSE 心跳）。"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        "屏蔽 http.server 自带的访问日志，避免重复刷屏。"
        pass

    def handle_one_request(self):
        """RST 恢复时 wfile/rfile 已被主动关闭，基类收尾 flush 会抛 ValueError。

        这是预期路径（连接已经被重置），不该被 socketserver 记成 thread error。
        """
        try:
            BaseHTTPRequestHandler.handle_one_request(self)
        except ValueError:
            # 只有主动重置的那次才吞；其它 ValueError 仍按原样抛出，
            # 不能被这个兜底掩盖真正的代码错误。同时置 close_connection，
            # 防止基类 handle() 继续循环、对已关闭的 rfile 反复 readline。
            if not getattr(self, "_zp_client_reset", False):
                raise
            self.close_connection = True

    # ---------- 输出辅助 ----------
    def _reject(self, code, msg):
        """返回 OpenAI 形状的 JSON 错误体（非流式路径）。

        只有 503（代理耗尽重试）带可重试标记；400 是客户端自己写错了，
        标成可重试会被客户端重发 10 次，把确定性失败拖长。
        """
        body = error_body(msg) if code >= 500 else invalid_body(msg)
        payload = json.dumps({"error": body}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _start_sse(self):
        "先把 SSE 响应头发出去，之后才能持续发心跳注释行。"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def _sse_write(self, text):
        "按 chunked 编码写一段数据并立即 flush。"
        data = text.encode("utf-8")
        self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    def _heartbeat(self):
        """发一个 SSE 注释行保活。客户端忽略内容，但能看到字节到达。"""
        try:
            self._sse_write(": keepalive\n\n")
            return True
        except Exception:
            return False

    def _sse_error(self, msg):
        "心跳模式下没有第二次机会发改状态码，只能作为 SSE 错误事件收尾。"
        try:
            self._sse_write("data: " + json.dumps(
                {"error": error_body(msg)}, ensure_ascii=False) + "\n\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except Exception:
            self.close_connection = True

    # ---------- 主流程 ----------
    def _handle(self, method):
        "主流程：解析路径选上游 → 读 body → 重试状态机 → 回写。"
        raw = urllib.parse.urlsplit(self.path)
        prefix = None
        target = None
        # 通用路由：/p/<base64url(原始 baseUrl)>/...（V0.2.6）。
        # 安装器把任意 provider 的 baseUrl 改写成这种形式，代理解码后转发到
        # 原始 host/路径；新增 provider 不需要再改代理的 UPSTREAMS 表。
        if raw.path == "/p" or raw.path.startswith("/p/"):
            rest = raw.path[3:] if raw.path.startswith("/p/") else ""
            token, _, tail = rest.partition("/")
            try:
                pad = "=" * (-len(token) % 4)
                base = base64.urlsafe_b64decode(
                    (token + pad).encode("ascii")).decode("utf-8")
                bu = urllib.parse.urlsplit(base)
                if bu.scheme not in ("http", "https") or not bu.hostname:
                    raise ValueError("bad base url")
                scheme = bu.scheme
                host = bu.hostname
                # 端口解析也要在 try 内：urlsplit 之后访问 .port 会为非法端口
                # （如 :abc / :99999）抛 ValueError，漏出去会变成 500。
                explicit_port = bu.port
                if explicit_port is not None and not (0 < explicit_port < 65536):
                    raise ValueError("bad port")
                port = explicit_port or (443 if scheme == "https" else 80)
            except Exception:
                self.close_connection = True
                self._reject(400, "bad /p/ route token")
                return
            base_path = bu.path.rstrip("/")
            base_query = bu.query
            path = (base_path + "/" + tail) if tail else (base_path or "/")
        else:
            for p in UPSTREAMS:
                if raw.path.startswith(p + "/") or raw.path == p:
                    prefix = p
                    break
            if prefix is None:
                # 400 之后不读 body 就会把它留在 keep-alive 连接里，下一次请求
                # 会把残留字节当成请求行解析。直接标记关闭，由 http.server 收尾。
                self.close_connection = True
                self._reject(400, "unknown upstream prefix, use /ap/, /cm/, /cg/ or /p/<token>")
                return
            target = UPSTREAMS[prefix]
            host, port = target[0], target[1]
            scheme = target[2] if len(target) > 2 else "https"
            path = raw.path[len(prefix):] or "/"
            base_query = ""
        # 原始 baseUrl 自带的查询串（如 ?api-version=...）和本次请求的查询串
        # 都要保留：前者是 provider 配置的一部分，后者是调用参数。
        for q in (base_query, raw.query):
            if q:
                path += ("&" if "?" in path else "?") + q

        body = read_body(self)
        if body is None:
            self.close_connection = True
            self._reject(400, "malformed request body (chunked/Content-Length)")
            return
        headers = [(k, v) for k, v in self.headers.items()
                   if k.lower() not in HOP_BY_HOP]

        # 中转的 Cloudflare 会拦 Python-urllib 这类 UA（报 1010），
        # 客户端没带或带的是脚本 UA 时换一个常规 UA。
        ua = next((v for k, v in headers if k.lower() == "user-agent"), "")
        if not ua or ua.lower().startswith("python"):
            headers = [(k, v) for k, v in headers if k.lower() != "user-agent"]
            headers.append(("User-Agent", DEFAULT_UA))

        wants_stream = False
        try:
            payload = json.loads(body.decode("utf-8", "replace") or "{}")
            wants_stream = bool(payload.get("stream"))
        except Exception:
            pass

        started = time.time()
        heartbeats = 0
        sse_mode = False
        reasons = []
        attempt = 0
        next_attempt_at = started
        next_hb_at = started + HEARTBEAT_START
        q = None

        def start_attempt():
            "起一个线程做一次上游尝试，结果放进队列，主循环不被阻塞。"
            box = queue.Queue(maxsize=1)

            def work():
                # 无论如何都要回填一个 Attempt：线程静默死掉会让主循环永远等不到结果
                "线程体：无论成败都必须回填一个 Attempt，否则主循环会永远等不到结果。"
                try:
                    box.put(fetch_once(host, port, scheme, method, path, headers, body))
                except Exception as exc:
                    box.put(Attempt(reason="other", detail="attempt crashed: %r" % (exc,)))

            threading.Thread(target=work, daemon=True).start()
            return box

        while True:
            now = time.time()

            # 窗口到期且没有在飞的尝试就收工。缺这一条时，若进程在退避期间被挂起
            # （机器休眠、被调试器停住），醒来后 now 已越过窗口，启动条件为假、
            # 失败分支的 break 又走不到，循环会零睡眠空转直到进程被杀。
            if q is None and now - started >= RETRY_WINDOW:
                break

            if q is None and now >= next_attempt_at and (now - started) < RETRY_WINDOW:
                attempt += 1
                q = start_attempt()

            a = None
            if q is not None:
                try:
                    a = q.get(timeout=0.2)
                    q = None
                except queue.Empty:
                    pass

            if a is not None:
                if a.reason == "ok":
                    # 非 2xx 在 fetch_once 里已经转成 reason=status，这里只可能是成功响应
                    result = pipe_response(self, a.resp, a.conn, path, started,
                                           sse_mode, heartbeat=wants_stream)
                    if result != "early":
                        return
                    # 这次上游只吐了 reasoning 就结束，没有正文/工具调用。代理已经
                    # 在同一个客户端响应上发过 200（可能还有心跳），后续尝试必须
                    # 沿用这个响应：sse_mode=True 阻止再发状态行。
                    sse_mode = True
                    reasons.append("early")
                    elapsed = time.time() - started
                    nxt = time.time() + RETRY_INTERVAL
                    # 先判窗口再写日志：静默 early 只在窗口到点时才被判定，
                    # 这种情况下不会再发请求，日志不能写成“retry after”。
                    if (elapsed >= RETRY_WINDOW or attempt >= MAX_ATTEMPTS
                            or nxt - started >= RETRY_WINDOW):
                        log("early finish, window exhausted attempt %d (%.0fs/%gs) %s"
                            % (attempt, elapsed, RETRY_WINDOW, path))
                        break
                    log("retry after early finish attempt %d (%.0fs/%gs) %s"
                        % (attempt, elapsed, RETRY_WINDOW, path))
                    next_attempt_at = nxt
                    continue

                reasons.append(a.reason)
                log("attempt %d fail (%s: %s) %.1fs %s"
                    % (attempt, a.reason, a.detail, time.time() - started, path))

                elapsed = time.time() - started
                if elapsed >= RETRY_WINDOW or attempt >= MAX_ATTEMPTS:
                    break

                # 固定间隔重试；上游给了更长的 Retry-After 就尊重它（最多 60 秒）
                backoff = RETRY_INTERVAL
                if a.retry_after > 0:
                    backoff = max(backoff, a.retry_after)
                next_attempt_at = time.time() + backoff
                # 下一次尝试会落在时间窗之外，就不再安排了（窗口结束即收工）
                if next_attempt_at - started >= RETRY_WINDOW:
                    break
                log("backoff %gs before attempt %d (%.0fs/%gs) %s"
                    % (backoff, attempt + 1, elapsed, RETRY_WINDOW, path))

            # 心跳由独立时钟驱动：到点就发，不受尝试边界影响
            now = time.time()
            if wants_stream and now >= next_hb_at:
                if not sse_mode:
                    # 客户端可能已经断开（用户取消/关窗）。这里第一次写响应头，
                    # 必须和 _heartbeat 一样把写失败吃掉，否则 traceback 会进日志。
                    try:
                        self._start_sse()
                    except Exception:
                        log("client gone before heartbeat mode %.1fs %s"
                            % (now - started, path))
                        return
                    sse_mode = True
                    log("enter heartbeat mode at %.1fs %s" % (now - started, path))
                if not self._heartbeat():
                    log("client gone at %.1fs, stop %s" % (now - started, path))
                    return
                heartbeats += 1
                log("heartbeat #%d at %.1fs %s"
                    % (heartbeats, now - started, path))
                next_hb_at = now + HEARTBEAT_INTERVAL
                continue

            # 等退避时不能空转：q 为空说明在等下一次尝试，睡到"下个尝试"或"下次心跳"
            # 里先到的那个为止。不睡就会把单核打满（实测 97%），并发几个请求就能拖垮机器。
            if q is None:
                wake = next_attempt_at
                if wants_stream:
                    wake = min(wake, next_hb_at)
                pause = max(0.0, min(0.2, wake - time.time()))
                if pause > 0:
                    time.sleep(pause)

        waited = time.time() - started
        log("gave up after %d attempts in %.0fs %s reasons=%s"
            % (attempt, waited, path, ",".join(reasons[-5:])))
        detail = ("已持续重试 %.0f 秒仍失败（共 %d 次尝试：%s）"
                  % (waited, attempt, ",".join(reasons[-5:])))
        if sse_mode:
            self._sse_error(detail)
        else:
            self._reject(503, detail)

    def do_POST(self):
        "POST 入口（模型请求都是 POST）。"
        self._safe_handle("POST")

    def do_GET(self):
        "GET 入口：只处理 /__zp_health 探针，其余交给主流程。"
        # 探针给 ensure_proxy / doctor / 运维换进程脚本用：确认端口上是本代理，
        # 并靠 root 分辨跑的是哪一份代码（换进程后旧代码残留一眼能看出来）
        if self.path.split("?")[0] == "/__zp_health":
            # features 是给自动迁移用的能力位：旧版代理不认识 /p 路由，
            # ensure_proxy 必须先看到 p_route 才允许改写 provider 配置，
            # 否则升级瞬间会把所有 provider 指向旧进程，全部请求 400。
            body = json.dumps({"name": "Zcode-Persistence",
                               "role": "retry_proxy",
                               "version": PROXY_VERSION,
                               "features": ["p_route", "cg_route"],
                               "root": os.path.dirname(os.path.abspath(__file__))},
                              ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._safe_handle("GET")

    def _safe_handle(self, method):
        """_handle 的外壳：把"客户端断开"这类正常事件收成一行日志。

        用户取消、关窗、切模型都会产生 ConnectionResetError/BrokenPipeError；
        以前这些异常从线程里冒出去，socketserver 会打印完整 traceback，
        proxy.log 里全是堆栈（也违反"只记状态行"的不变量）。
        """
        try:
            self._handle(method)
        except (ConnectionError, OSError) as exc:
            self.close_connection = True
            log("client gone %s: %s" % (method, type(exc).__name__))


class Server(ThreadingHTTPServer):
    """带单行错误日志的 HTTP 服务。

    socketserver 默认的 handle_error 会把整个 traceback 打进 stderr（=proxy.log）。
    代理处理的是"用户随时可能取消"的请求，断开是常态，只记一行就够。
    """

    def handle_error(self, request, client_address):
        "线程里漏出来的异常只记类型，不打堆栈。"
        exc = sys.exc_info()[1]
        log("thread error: %s" % type(exc).__name__)


def main():
    "进程入口：起 Server，打印启动行（参数一目了然，便于 doctor 对照）。"
    srv = Server((LISTEN_HOST, LISTEN_PORT), Handler)
    srv.daemon_threads = True
    log("proxy listening on http://%s:%d  (retry %gs window / every %gs, silence=%ds, "
        "heartbeat>=%ds every %ds)"
        % (LISTEN_HOST, LISTEN_PORT, RETRY_WINDOW, RETRY_INTERVAL,
           SILENCE_TIMEOUT, HEARTBEAT_START, HEARTBEAT_INTERVAL))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
