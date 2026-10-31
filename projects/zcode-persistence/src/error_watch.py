#!/usr/bin/env python3
"""会话报错监听：红点出现时，把"这次为什么失败"发到邮箱。

红点在本地就是 ~/.zcode/cli/db/db.sqlite 的 session.last_outcome：
  completed   正常结束        -> 不管
  interrupted 用户停止/暂停   -> 不管
  error       任务出错（左侧会话列表、通知区变红点）-> 处理

处理动作：
  1. 从 proxy.log 取与报错时刻前后 15 分钟内对得上的"放弃"记录
     （尝试次数、耗时、失败原因序列；对不上就不硬编原因）
  2. 从 session / message 取会话标题、模型、provider、报错时刻
  3. 通过 outlook MCP（ms-365-mcp-server 的 stdio JSON-RPC）发一封中文邮件

为什么用 MCP 而不是 SMTP：AGENTS.md 规定发信用 outlook MCP；这个 MCP 是 stdio
服务，起一个实例、走 initialize + tools/call 就能发信，凭据复用 %APPDATA% 下的
token 缓存，不需要另存密码。

防刷屏：
  - 同一个 (会话, time_updated) 只报一次
  - 同一轮扫到的多个报错合并成一封
  - 每小时最多 MAX_PER_HOUR 封，超了只写日志
  - 首次启动只记基线，不回灌历史红点

用法：
  python error_watch.py            常驻（SessionStart 钩子以脱离方式拉起）
  python error_watch.py --once     只扫一轮，打印判定结果，不发信
  python error_watch.py --dry-run  常驻但不发信，只把邮件正文写日志
  python error_watch.py --test-mail 发一封链路自检邮件
  python error_watch.py --db X     指向别的库（自检用）
"""

import argparse
import ctypes
import json
import os
import queue
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROXY_LOG = os.path.join(HERE, "proxy.log")
ZCODE_HOME = os.path.join(os.path.expanduser("~"), ".zcode")
DB_DEFAULT = os.path.join(ZCODE_HOME, "cli", "db", "db.sqlite")
CONFIG = os.path.join(ZCODE_HOME, "cli", "config.json")
STATE_DIR = os.path.join(tempfile.gettempdir(), "Zcode-Persistence")
STATE = os.path.join(STATE_DIR, "error_watch.json")
LOCK = os.path.join(STATE_DIR, "error_watch.pid")
LOG = os.path.join(HERE, "error_watch.log")

# 状态文件（error_watch.json）里的键，改状态机前先看清楚各自的语义：
#   seen         {会话 id: 已成功发送到的 time_updated}，只在发送成功后推进
#   sent         [最近一小时的发送时刻]，用于每小时限流（MAX_PER_HOUR）
#   sent_at      {会话 id: 上次发送时刻}，用于会话级冷却（SESSION_GAP）
#   retry_after  上次发信失败后的重试时刻（没到点就不撞 MCP）
#   logged       {节流 key: 上次写日志时刻}，防 5 秒轮询刷屏
#   baseline     首轮基线是否已建立（查询失败时不置位）

MAIL_TO = "your-email@example.com"
# 发件人必须固定成 outlook 地址：用账号本名（QQ 地址）发，QQ 侧会当伪造直接丢弃
# （2026-10-31 实测：From=your-email@example.com 的信只留在"已发送"，收件箱没有）
MAIL_FROM = "your-sender@example.com"
POLL = 5                 # 轮询间隔（秒）
FRESH = 180              # 首次启动时，只把这么新的历史红点当"刚发生"
MAX_PER_HOUR = 8         # 每小时最多几封
SESSION_GAP = 600        # 同一会话两次报错邮件的最小间隔（秒）
MAIL_RETRY_GAP = 60      # 发信失败后隔多久再试
CAUSE_WINDOW = 900       # 只把报错时刻前后这么多秒内的 giveup 当作"原因"
MAX_ITEMS = 10           # 一封邮件最多列几条报错
# 代理日志行首：新版本 "YYYY-MM-DD HH:MM:SS\t"，老版本只有 "HH:MM:SS\t"
LOG_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} )?(\d{2}:\d{2}:\d{2})\s")
# reasons 可能是空串（窗口到期但一次都没尝试到），Group 4 用 \S* 而不是 \S+
GIVEUP_RE = re.compile(r"gave up after (\d+) attempts in (\d+)s (\S+) reasons=(\S*)")
# 失败明细：行首日期可有可无（老日志只有时分秒），明细里常有 repr(exc) 自带右括号，
# 所以用贪婪 (.*) 到行尾的 [\d.]+s 收口。**别再把行首写死成 HH:MM:SS**——代理日志
# 2026-10-31 起带了日期，写死会让这里对每一行都返回 None，邮件里的失败明细全空，
# 还会把"代理在失败"误判成"不是代理导致的"（复审 P1）。
FAIL_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} )?(\d{2}:\d{2}:\d{2})\s"
                     r"attempt \d+ fail \((.*)\)\s+[\d.]+s")


def log(msg):
    "追加一行带时间的日志；写不了就算了，绝不让监听器崩。"
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write("%s\t%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def load_json(path, default):
    "读 JSON；文件缺失或损坏都返回 default。"
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def save_json(path, obj):
    "原子写 JSON（先写临时文件再替换），避免半截文件。"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False)
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def read_tail(path, limit=65536):
    "读文件尾部若干字节（日志只关心最近的行）。"
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > limit:
                fh.seek(size - limit)
            return fh.read().decode("utf-8", "replace")
    except Exception:
        return ""


def fmt_ts(ms):
    "毫秒时间戳 → 本地时间字符串。"
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ms / 1000.0))
    except Exception:
        return "?"


def log_time(line, now=None):
    """从代理日志行首解析时间戳（秒）；认带日期和只有时分秒两种格式。

    只有时分秒的老格式按"今天"补全；算出来比 now 还晚一分钟以上就当成昨天的行。
    解析不出来返回 None——调用方据此拒绝把这一行当成"本次报错的原因"。
    """
    m = LOG_TS_RE.match(line)
    if not m:
        return None
    now = now or time.time()
    if m.group(1):
        try:
            return time.mktime(time.strptime((m.group(1) + m.group(2)).strip(),
                                             "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            return None
    try:
        t = time.strptime(m.group(2), "%H:%M:%S")
    except ValueError:
        return None
    lt = time.localtime(now)
    cand = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday,
                        t.tm_hour, t.tm_min, t.tm_sec, 0, 0, -1))
    if cand > now + 60:
        cand -= 86400
    return cand


DB_ERR = {"msg": "", "at": 0.0}


def db_note(msg):
    "数据库相关故障：同样的消息 10 分钟只记一次，否则每 5 秒一条会把日志淹掉。"
    now = time.time()
    if msg != DB_ERR["msg"] or now - DB_ERR["at"] > 600:
        DB_ERR["msg"], DB_ERR["at"] = msg, now
        log(msg)


def connect_db(path):
    """只读打开 ZCode 的会话库；不存在或打不开返回 None。

    失败必须留痕：库被锁/路径变了/表不兼容时，监听器会每 5 秒空转到天荒地老，
    看起来"在跑"，实际什么都没做（复审 P2-3）。
    """
    if not os.path.exists(path):
        db_note("db: 会话库不存在（%s）" % path)
        return None
    try:
        con = sqlite3.connect("file:%s?mode=ro" % path.replace("\\", "/"), uri=True,
                              timeout=5)
        con.execute("select 1 from session limit 1")
        return con
    except Exception as exc:
        db_note("db: 打不开会话库（%s: %s）" % (type(exc).__name__, str(exc)[:100]))
        return None


def new_errors(con):
    """最近出错、且是顶层（非子代理）的会话；查询失败返回 None（不是空列表）。

    区分 None 和 [] 很重要：空列表代表"确实没有报错"，可以让首轮基线成立；
    查询失败时若也当空，基线会被错误地置位，之后库恢复时几天前的历史红点
    会被当成新报错整批发出去（复审 P2-7）。
    """
    try:
        return con.execute(
            "select id, coalesce(title, ''), coalesce(time_updated, 0) from session "
            "where last_outcome='error' and (parent_id is null or parent_id='') "
            "order by time_updated desc limit 30").fetchall()
    except Exception as exc:
        db_note("db: 查询 session 失败（%s: %s）" % (type(exc).__name__, str(exc)[:120]))
        return None


def session_detail(con, sid):
    """会话的模型/供应商/目录。

    模型信息不在 session 表里，藏在最后几条 assistant 消息的 data JSON 中；
    最多翻 8 条，够用且不会扫全表。
    """
    detail = {"model": "?", "provider": "?", "dir": ""}
    try:
        row = con.execute("select directory from session where id=?", (sid,)).fetchone()
        if row and row[0]:
            detail["dir"] = row[0]
    except Exception:
        pass
    try:
        rows = con.execute("select data from message where session_id=? "
                           "order by sequence desc limit 8", (sid,)).fetchall()
    except Exception:
        rows = []
    for (data,) in rows:
        try:
            d = json.loads(data)
        except Exception:
            continue
        detail["model"] = detail["model"] if detail["model"] != "?" else d.get("modelId") or "?"
        detail["provider"] = (detail["provider"] if detail["provider"] != "?"
                              else d.get("providerId") or "?")
        if detail["model"] != "?" and detail["provider"] != "?":
            break
    return detail


def proxy_cause(path=PROXY_LOG, near_ts=None, window=CAUSE_WINDOW):
    """proxy.log 里与本次报错对得上的那一次"放弃"；没有就返回 None。

    代理只在这三种情况写 gave up：连不上 / 连不上之后又超时 / 窗口耗尽。
    这几行是"报错原因"最硬的证据——客户端弹窗里的 provider_code 反而是我们
    自己回给它的错误码，不含根因。

    near_ts（秒）给出报错时刻时，只接受 [near_ts-window, near_ts+window] 内的
    记录。旧版直接取日志最后一条，跨天或上一次故障的 giveup 会被当成这次的
    原因（独立审查 P1-2）。
    """
    text = read_tail(path, 256 * 1024)
    if not text:
        return None
    lines = text.splitlines()

    def related(line):
        "这一行是否落在报错时刻附近；没给 near_ts 就都算相关。"
        if near_ts is None:
            return True
        ts = log_time(line)
        return ts is not None and near_ts - window <= ts <= near_ts + window

    giveup, giveup_ts = None, None
    for line in reversed(lines):
        m = GIVEUP_RE.search(line)
        if m and related(line):
            giveup = {"raw": line.strip(), "attempts": int(m.group(1)),
                      "seconds": int(m.group(2)), "path": m.group(3),
                      "reasons": m.group(4) or "(无语义原因)"}
            giveup_ts = log_time(line)
            break
    fails = []
    for line in lines[-400:]:
        m = FAIL_RE.search(line)
        if m and related(line):
            fails.append("%s  %s" % (m.group(2), m.group(3)))
    if not giveup and not fails:
        return None
    return {"giveup": giveup, "giveup_ts": giveup_ts, "fails": fails[-3:]}


def build_mail(items, cause, now=None):
    "拼标题和正文；items 是 (sid, title, updated, detail) 列表。"
    now = now or time.time()
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(now))
    if len(items) == 1:
        subject = "【Zcode-Persistence】会话报错：%s（%s）" % (
            (items[0][1] or "无标题")[:28], when)
    else:
        subject = "【Zcode-Persistence】%d 个会话报错（%s）" % (len(items), when)

    out = ["Zcode-Persistence 报错汇报", "",
           "时间：%s" % when,
           "判定：session.last_outcome = error（左侧会话列表 / 通知区红点）", ""]
    for sid, title, updated, detail in items[:MAX_ITEMS]:
        out.append("—" * 30)
        out.append("会话：%s" % (title or "(无标题)"))
        out.append("  id：%s" % sid)
        out.append("  模型：%s（provider %s）" % (detail["model"], detail["provider"]))
        if detail["dir"]:
            out.append("  目录：%s" % detail["dir"])
        out.append("  报错时刻：%s" % fmt_ts(updated))
    if len(items) > MAX_ITEMS:
        out.append("…另有 %d 个会话同样报错，未展开。" % (len(items) - MAX_ITEMS))
    out.append("")

    if cause and cause.get("giveup"):
        g = cause["giveup"]
        out.append("原因（本地重试代理在报错前后 %.0f 分钟内的放弃记录）："
                   % (CAUSE_WINDOW / 60.0))
        out.append("  %s" % g["raw"])
        out.append("  尝试 %d 次、共 %.0f 秒，失败原因序列：%s"
                   % (g["attempts"], g["seconds"],
                      g["reasons"].replace(",", " → ")))
        if cause["fails"]:
            out.append("  同一时段的失败明细：")
            for line in cause["fails"]:
                out.append("    %s" % line)
    elif cause and cause["fails"]:
        out.append("原因（代理在同一时段有失败，但还没到放弃）：")
        for line in cause["fails"]:
            out.append("  %s" % line)
    else:
        out.append("原因：本地代理日志里没有与本次报错时间相符的放弃记录——")
        out.append("      这次不是代理耗尽重试导致的，更像工具调用 / 客户端侧报错，")
        out.append("      具体看会话里那条红色消息。")
    out.append("")
    out.append("说明：ZCode 的模型请求走本地代理 127.0.0.1:8787；代理按时间窗反复重发，")
    out.append("窗口耗尽才把错误交回客户端，客户端判定不可重试就结束本轮并亮红点。")
    out.append("")
    out.append("—— 本邮件由 Zcode-Persistence 自动发出，不需要回复。")
    return subject, "\n".join(out)


class Mcp(object):
    "ms-365-mcp-server 的最小 stdio 客户端：起进程、发 JSON-RPC、收结果。"

    def __init__(self, command, args):
        # stderr 落到临时文件：node 侧的真实失败原因（缺模块、认证过期）都在里面，
        # 丢掉 stderr 只剩一句"tools/call 超时"，排障无从下手。
        self.err = tempfile.TemporaryFile()
        self.proc = subprocess.Popen([command] + list(args),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.err, text=True,
                                     encoding="utf-8", errors="replace", bufsize=1)
        self.lines = queue.Queue()
        self.seq = 0
        threading.Thread(target=self._pump, daemon=True).start()

    def stderr_tail(self, n=300):
        "取 stderr 尾部若干字符，用在失败原因里。"
        try:
            self.err.seek(0)
            return self.err.read().decode("utf-8", "replace")[-n:].strip()
        except Exception:
            return ""

    def _pump(self):
        "把 stdout 的每一行丢进队列；EOF 时放一个 None 收尾。"
        try:
            for line in self.proc.stdout:
                self.lines.put(line)
        except Exception:
            pass
        finally:
            self.lines.put(None)

    def notify(self, method, params=None):
        "发一条通知（不需要响应）；写不进去就静默放弃——调用方只看后续请求的结果。"
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        try:
            self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
        except Exception:
            pass

    def request(self, method, params, timeout):
        "发请求并等到同 id 的响应；超时/断流返回 None。"
        self.seq += 1
        mid = self.seq
        msg = {"jsonrpc": "2.0", "id": mid, "method": method, "params": params}
        try:
            self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
        except Exception:
            return None
        end = time.time() + timeout
        while True:
            left = end - time.time()
            if left <= 0:
                return None
            try:
                line = self.lines.get(timeout=left)
            except queue.Empty:
                return None
            if line is None:
                return None
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("id") == mid:
                return d

    def close(self):
        "关掉子进程与临时文件（发信是一次性的，不留常驻实例）。"
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:
                pass
        try:
            self.err.close()
        except Exception:
            pass


def mcp_server():
    "从 ZCode 配置里取 ms365 的启动命令；取不到就用安装位置兜底。"
    cfg = load_json(CONFIG, {}) or {}
    entry = (((cfg.get("mcp") or {}).get("servers") or {}).get("ms365") or {})
    cmd = entry.get("command")
    args = entry.get("args") or []
    if cmd and args and os.path.exists(args[0]):
        return cmd, args
    fallback = (r"C:\Program Files\nodejs\node.exe",
                r"C:\Program Files (x86)\AI\ms-365-mcp-server\node_modules\@softeria"
                r"\ms-365-mcp-server\dist\index.js")
    if os.path.exists(fallback[0]) and os.path.exists(fallback[1]):
        return fallback[0], [fallback[1]]
    return None, None


def send_mail(subject, body, timeout=90):
    "通过 outlook MCP 发一封纯文本邮件；返回 (是否成功, 说明)。"
    cmd, args = mcp_server()
    if not cmd:
        return False, "找不到 ms-365-mcp-server（配置和兜底路径都不可用）"
    try:
        cli = Mcp(cmd, args)
    except Exception as exc:
        # 命令不存在、没有权限等：契约要求永远返回二元组，不能把异常抛给调用方
        return False, "启动 MCP 失败：%s: %s" % (type(exc).__name__, str(exc)[:160])
    try:
        init = cli.request("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "Zcode-Persistence", "version": "0.2"}}, timeout=45)
        if not init or "result" not in init:
            return False, "initialize 无有效响应 %s" % cli.stderr_tail()
        cli.notify("notifications/initialized")
        args_ = {"body": {"Message": {
            "subject": subject,
            "from": {"emailAddress": {"address": MAIL_FROM}},
            "toRecipients": [{"emailAddress": {"address": MAIL_TO}}],
            "body": {"contentType": "text", "content": body}},
            "SaveToSentItems": True}}
        res = cli.request("tools/call", {"name": "send-mail", "arguments": args_},
                          timeout=timeout)
        if not res:
            return False, "tools/call 超时或断流 %s" % cli.stderr_tail()
        if res.get("error"):
            return False, "协议错误：%s" % json.dumps(res["error"], ensure_ascii=False)[:200]
        result = res.get("result") or {}
        text = "".join(c.get("text", "") for c in (result.get("content") or [])
                       if isinstance(c, dict))
        if result.get("isError"):
            return False, text[:300] or "工具返回 isError"
        return True, text[:120] or "已投递"
    finally:
        cli.close()


def alive(pid):
    "进程句柄还打得开就认为活着（pid 复用有极小概率误判，只用于单例锁的粗判）。"
    try:
        # 必须显式声明 argtypes/restype：默认按 c_int 返回值会把 64 位句柄截断
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        k.OpenProcess.restype = ctypes.c_void_p
        k.CloseHandle.argtypes = [ctypes.c_void_p]
        h = k.OpenProcess(0x1000, 0, int(pid))       # QUERY_LIMITED_INFORMATION
        if not h:
            return False
        k.CloseHandle(h)
        return True
    except Exception:
        return False


def hold_lock():
    "单例：已经有活着的监听器就返回 False。"
    info = load_json(LOCK, {}) or {}
    if info.get("pid") and alive(info["pid"]):
        return False
    save_json(LOCK, {"pid": os.getpid(), "started": int(time.time())})
    return True


def log_throttled(state, key, msg, gap=600):
    "同一类提示每 gap 秒最多记一条，避免 5 秒轮询把日志淹掉。"
    marks = state.setdefault("logged", {})
    now = time.time()
    if now - float(marks.get(key, 0)) < gap:
        return
    marks[key] = now
    log(msg)


def scan_once(args, state):
    """扫一轮：返回 (是否发过信, 本轮待投递条目数)。

    状态推进规则：
      - seen 只在"确实发出去"或"判定为历史基线"时推进；
      - 被冷却/限流挡住、发信失败、--no-send 都不推进，下一轮再看，绝不把
        "已扫描"当成"已送达"（复审 P1-1）；
      - 查询失败不置基线（复审 P2-7）；
      - --once 只是诊断：绕开冷却与限流、只打印、不落盘。
    """
    con = connect_db(args.db)
    if con is None:
        return False, 0
    rows = new_errors(con)
    if rows is None:                 # 查询失败：本轮什么都别下结论
        con.close()
        return False, 0
    seen = state.setdefault("seen", {})
    baseline_done = state.get("baseline")
    fresh, baseline = [], 0
    for sid, title, updated in rows:
        if not updated:              # 没时间戳的脏行，跳过而不是抛 TypeError
            continue
        if seen.get(sid, 0) >= updated:
            continue
        if not baseline_done and time.time() - updated / 1000.0 > FRESH:
            seen[sid] = updated      # 历史红点：只记基线，永不补发
            baseline += 1
            continue
        fresh.append((sid, title, updated))
    state["baseline"] = True
    if len(seen) > 200:
        alive_ids = {row[0] for row in rows}
        for key in list(seen):
            if key not in alive_ids:
                seen.pop(key, None)
        for key in list(state.get("sent_at", {})):
            if key not in alive_ids:
                state["sent_at"].pop(key, None)
    if baseline:
        log("baseline: 忽略 %d 个历史红点（首次启动）" % baseline)
    if not fresh:
        con.close()
        return False, 0

    if args.once:
        # 诊断模式：不看冷却/限流，把当前能看到的都打出来
        items = [(sid, title, updated, session_detail(con, sid))
                 for sid, title, updated in fresh]
        con.close()
        subject, body = build_mail(items,
                                   proxy_cause(args.proxy_log,
                                               near_ts=max(it[2] for it in items) / 1000.0))
        print(subject)
        print()
        print(body)
        return False, len(items)

    # 会话级冷却：报错中的会话会被反复"触碰"（time_updated 一直变），
    # 只按时间戳去重会在一次故障里连发几十封。冷却期内的先留着，过期再报。
    now = time.time()
    sent_at = state.setdefault("sent_at", {})
    ready = [it for it in fresh if now - float(sent_at.get(it[0], 0)) >= SESSION_GAP]
    ready_ids = {it[0] for it in ready}
    for sid, _t, _u in fresh:
        if sid not in ready_ids:
            log_throttled(state, "cooldown:" + sid,
                          "cooldown: 会话 %s 的报错还在冷却期，留到下一轮" % sid[-12:])
    if not ready:
        con.close()
        return False, 0

    # 发信失败后的退避：别每 5 秒撞一次 MCP
    if now < float(state.get("retry_after", 0)):
        con.close()
        return False, len(ready)
    sent = [t for t in state.get("sent", []) if now - t < 3600]
    if len(sent) >= MAX_PER_HOUR:
        log_throttled(state, "ratelimit",
                      "ratelimit: 一小时内已发 %d 封，%d 条留到下一轮"
                      % (len(sent), len(ready)))
        con.close()
        return False, len(ready)

    items = [(sid, title, updated, session_detail(con, sid))
             for sid, title, updated in ready]
    con.close()
    cause = proxy_cause(args.proxy_log, near_ts=max(it[2] for it in items) / 1000.0)
    subject, body = build_mail(items, cause)
    if args.no_send:
        # key 用会话集合而不是标题：标题带分钟，key 每分钟都变，等于没节流
        log_throttled(state, "nosend:" + ",".join(sorted(it[0] for it in items)),
                      "no-send: %d 条报错（不投递，状态不推进）\n%s" % (len(items), body))
        return False, len(items)
    ok, why = send_mail(subject, body)
    if not ok:
        state["retry_after"] = now + MAIL_RETRY_GAP
        log_throttled(state, "sendfail", "mail: 发送失败（%s），%.0f 秒后重试，状态不推进"
                      % (why, MAIL_RETRY_GAP), gap=MAIL_RETRY_GAP)
        if not save_json(args.state, state):
            log("state: 状态写盘失败（%s）" % args.state)
        return False, len(items)
    sent.append(now)
    state["sent"] = sent
    state.pop("retry_after", None)
    for sid, _t, updated, _d in items:
        seen[sid] = updated
        sent_at[sid] = now
    log("mail: 已发送 %d 条报错 → %s（%s）" % (len(items), MAIL_TO, why))
    if not save_json(args.state, state):
        log("state: 状态写盘失败（%s）" % args.state)
    return True, len(items)


def main():
    "命令行入口：按参数分发到补报 / 自检信 / 单轮诊断 / 常驻循环。"
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="只扫一轮并打印")
    ap.add_argument("--dry-run", "--no-send", dest="no_send", action="store_true",
                    help="常驻但不投递，只把邮件正文写日志")
    ap.add_argument("--test-mail", action="store_true", help="发一封自检邮件")
    ap.add_argument("--report-sid", metavar="SID", help="立刻补报某个会话（不看基线/限流）")
    ap.add_argument("--db", default=DB_DEFAULT)
    ap.add_argument("--state", default=STATE, help="状态文件（自检时指到临时目录）")
    ap.add_argument("--proxy-log", default=PROXY_LOG, help="代理日志（自检时指到样本文件）")
    args = ap.parse_args()

    if args.report_sid:
        con = connect_db(args.db)
        if con is None:
            print("打不开会话库：%s" % args.db)
            return 1
        row = con.execute("select coalesce(title,''), coalesce(time_updated, 0) "
                          "from session where id=?", (args.report_sid,)).fetchone()
        if not row:
            print("库里没有这个会话：%s" % args.report_sid)
            return 1
        title, updated = row
        if not updated:
            print("这个会话没有 time_updated，无法按时间对齐原因：%s" % args.report_sid)
        item = [(args.report_sid, title, updated, session_detail(con, args.report_sid))]
        con.close()
        subject, body = build_mail(item, proxy_cause(args.proxy_log,
                                                     near_ts=updated / 1000.0))
        ok, why = send_mail(subject, body)
        print("补报%s：%s" % ("成功" if ok else "失败", why))
        print("标题：%s" % subject)
        return 0 if ok else 1

    if args.test_mail:
        ok, why = send_mail("Zcode-Persistence 报错汇报链路自检",
                            "这是一封自检邮件：如果你收到它，说明红点报错汇报的"
                            "发信链路是通的。\n\n发件账号：outlook MCP 当前登录账号\n"
                            "收件人：%s" % MAIL_TO)
        print("发送%s：%s" % ("成功" if ok else "失败", why))
        return 0 if ok else 1

    state = load_json(args.state, {}) or {}
    if args.once:
        # 诊断模式：不落盘。否则跑一次 --once 就把当前红点记成已处理，
        # 常驻实例起来后不会再报（独立审查 P1-5）。
        scan_once(args, state)
        return 0

    if not hold_lock():
        print("已有监听器在跑，退出")
        return 0
    log("start: pid=%d poll=%ds no_send=%s" % (os.getpid(), POLL, args.no_send))
    while True:
        try:
            scan_once(args, state)
            save_json(args.state, state)
        except Exception as exc:
            log("loop: %s: %s" % (type(exc).__name__, str(exc)[:200]))
        time.sleep(POLL)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log("crash: %s: %s" % (type(exc).__name__, str(exc)[:200]))
        sys.exit(0)
