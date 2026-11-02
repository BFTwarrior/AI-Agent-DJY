#!/usr/bin/env python3
"""自检：红点报错监听（error_watch.py）。

不碰真实的 ZCode 库、不真的发信、不写发布包里的日志：造临时 sqlite 和临时
proxy.log，把 send_mail 换成记录器、把 LOG 指到临时目录，直接调函数验证。

验证十二件事（7 拆成 7a/7b/7c）：
  1. 刚发生的 error 会被抓出来，正文含会话标题/模型/provider/原因
  2. 发出去之后同一时间戳再扫不会重复报
  3. 首次启动时，两小时前的历史红点只记基线、不发信
  4. completed / interrupted 一律不报
  5. 一小时内已发满 MAX_PER_HOUR 封时不再发
  6. 同一轮多个报错合并成一封
  7. 原因归属：只有成功行 → "不是代理导致"；有失败无放弃 → "同一时段有失败"（新/旧格式各一次）
  8. 同一会话冷却期内不重复报，冷却过期后能再报
  9. 发信失败不推进 seen，下一轮会重试（不会被当成已处理而丢失）
 10. --once 只打印，不改状态（诊断不会吃掉常驻实例的通知）

用法：python tools/selftest_watch.py
"""

import contextlib
import io
import json
import os
import sqlite3
import sys
import tempfile
import time
import types

# 导入 src 模块时不要在发布目录生成 __pycache__。
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), "src")
sys.path.insert(0, SRC)
import error_watch as ew                      # noqa: E402

SCHEMA = """
create table session (id text, title text, parent_id text, last_outcome text,
                      time_updated integer, directory text);
create table message (session_id text, sequence integer, data text);
"""


def ts(sec):
    "秒 → 代理日志里的时间戳（带日期，和现行格式一致）。"
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(sec))


def make_plog(path, now_ts, mode="giveup", old_format=False):
    """造一份代理日志。

    mode: giveup（放弃）/ fail_only（只失败没放弃）/ ok_only（只有成功行）。
    old_format=True 时用升级前的 "HH:MM:SS" 行首，用来锁住两种格式都能解析。
    """
    def stamp(sec):
        fmt = "%H:%M:%S" if old_format else "%Y-%m-%d %H:%M:%S"
        return time.strftime(fmt, time.localtime(sec))

    lines = []
    if mode in ("giveup", "fail_only"):
        lines += [
            "%s\tattempt 1 fail (connect: Connection refused) 20.1s /v1/chat/completions"
            % stamp(now_ts - 60),
            "%s\tbackoff 20s before attempt 2 (20s/180s) /v1/chat/completions"
            % stamp(now_ts - 40),
            "%s\tattempt 2 fail (connect: Connection refused) 20.0s /v1/chat/completions"
            % stamp(now_ts - 20),
        ]
    if mode == "giveup":
        lines.append("%s\tgave up after 2 attempts in 40s /v1/chat/completions "
                     "reasons=connect,connect" % stamp(now_ts - 20))
    elif mode == "ok_only":
        lines.append("%s\tok /v1/chat/completions status=200 bytes=9123 first=3.10s"
                     % stamp(now_ts - 10))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def make_db(path, rows):
    "建一个最小库；rows 是 (id, title, outcome, time_updated, parent_id)。"
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    for i, (sid, title, outcome, updated, parent) in enumerate(rows):
        con.execute("insert into session values (?,?,?,?,?,?)",
                    (sid, title, parent, outcome, updated, r"D:\demo"))
        data = {"role": "assistant", "modelId": "deepseek-v4.1-flash",
                "providerId": "new-provider"}
        con.execute("insert into message values (?,?,?)",
                    (sid, i, json.dumps({"role": "user"})))
        con.execute("insert into message values (?,?,?)", (sid, i + 1, json.dumps(data)))
    con.commit()
    con.close()


def args_for(db, state, proxy_log):
    "造一个和 argparse 结果同形状的对象。"
    return types.SimpleNamespace(db=db, state=state, proxy_log=proxy_log,
                                 once=True, no_send=True)


def run_quiet(fn):
    "执行 fn，返回 (返回值, 它打到 stdout 的内容)。"
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        out = fn()
    return out, buf.getvalue()


def main():
    "按顺序跑 11 条断言并汇总；全部通过退出码 0。"
    ok = True
    tmp = tempfile.mkdtemp(prefix="watchtest-")
    ew.LOG = os.path.join(tmp, "watch.log")      # 别污染发布包里的日志
    db = os.path.join(tmp, "db.sqlite")
    plog = os.path.join(tmp, "proxy.log")
    now = int(time.time() * 1000)
    make_plog(plog, time.time())

    make_db(db, [
        ("sess_fresh", "Ai-Agent-Teams-Zcode", "error", now, None),
        ("sess_old", "旧会话", "error", now - 7200 * 1000, None),
        ("sess_done", "正常结束的会话", "completed", now, None),
        ("sess_stop", "用户停止的会话", "interrupted", now, None),
    ])

    # 1 + 3 + 4：首轮 —— 新的报出来，历史的只记基线，完成/停止的不管
    state = {}
    _, out = run_quiet(lambda: ew.scan_once(args_for(db, "", plog), state))
    p1 = ("Ai-Agent-Teams-Zcode" in out and "deepseek-v4.1-flash" in out
          and "new-provider" in out and "reasons=connect" in out
          and "旧会话" not in out and "正常结束的会话" not in out
          and "用户停止的会话" not in out)
    print("== 1 新红点被抓出（标题/模型/provider/原因）:", "PASS" if p1 else "FAIL")
    ok = ok and p1
    p3 = state.get("seen", {}).get("sess_old", 0) == now - 7200 * 1000
    p4 = ("sess_done" not in state.get("seen", {})
          and "sess_stop" not in state.get("seen", {}))
    print("== 3 历史红点只记基线:", "PASS" if p3 else "FAIL",
          "| 4 完成/停止不报:", "PASS" if p4 else "FAIL")
    ok = ok and p3 and p4

    # 2：发出去之后再扫，不应重复（去重靠"发成功才推进 seen"）
    sent = []
    real_send = ew.send_mail
    ew.send_mail = lambda subject, body: sent.append((subject, body)) or (True, "fake")
    try:
        st2 = {}
        a = args_for(db, "", plog)
        a.once = False               # 走真正的发信分支
        a.no_send = False
        run_quiet(lambda: ew.scan_once(a, st2))
        first = len(sent)
        _, out2 = run_quiet(lambda: ew.scan_once(a, st2))
        p2 = first == 1 and len(sent) == 1 and out2.strip() == ""
    finally:
        ew.send_mail = real_send
    print("== 2 发过之后不再重复:", "PASS" if p2 else "FAIL")
    ok = ok and p2

    # 5：限流 —— 预置一小时内的 sent，真发路径必须被拦住
    state5 = {"baseline": True, "seen": {},
              "sent": [time.time() - 60 * i for i in range(ew.MAX_PER_HOUR)]}
    calls = []
    ew.send_mail = lambda *a, **k: calls.append(a) or (True, "fake")
    try:
        a = args_for(db, "", plog)
        a.once = False
        a.no_send = False
        run_quiet(lambda: ew.scan_once(a, state5))
    finally:
        ew.send_mail = real_send
    p5 = (not calls) and "sess_fresh" not in state5.get("seen", {})
    print("== 5 限流生效（未调用 send_mail、不推进 seen）:", "PASS" if p5 else "FAIL")
    ok = ok and p5

    # 6：多条合并（用带 giveup 的日志，避免和 7 的措辞断言纠缠）
    db2 = os.path.join(tmp, "db2.sqlite")
    make_db(db2, [
        ("sess_a", "会话甲", "error", now, None),
        ("sess_b", "会话乙", "error", now, None),
    ])
    sent = []
    ew.send_mail = lambda subject, body: sent.append((subject, body)) or (True, "fake")
    try:
        a = args_for(db2, "", plog)
        a.once = False
        a.no_send = False
        run_quiet(lambda: ew.scan_once(a, {}))
    finally:
        ew.send_mail = real_send
    p6 = (len(sent) == 1 and "会话甲" in sent[0][1] and "会话乙" in sent[0][1]
          and "2 个会话报错" in sent[0][0])
    print("== 6 合并成一封:", "PASS" if p6 else "FAIL")
    print("   标题:", sent[0][0] if sent else "(未发)")
    ok = ok and p6

    # 7a：日志里只有成功行 → 必须说"不是代理耗尽重试导致的"
    oklog = os.path.join(tmp, "ok.log")
    make_plog(oklog, time.time(), mode="ok_only")
    sent = []
    ew.send_mail = lambda subject, body: sent.append((subject, body)) or (True, "fake")
    try:
        a7 = args_for(db2, "", oklog)
        a7.once = False
        a7.no_send = False
        run_quiet(lambda: ew.scan_once(a7, {}))
    finally:
        ew.send_mail = real_send
    p7a = bool(sent) and "不是代理耗尽重试导致的" in sent[0][1]
    print("== 7a 无相关记录措辞:", "PASS" if p7a else "FAIL")
    ok = ok and p7a

    # 7b：同一时段有失败、但没到放弃（**新格式**日志——上一轮 P1 的触发条件）
    faillog = os.path.join(tmp, "failonly.log")
    make_plog(faillog, time.time(), mode="fail_only")
    sent = []
    ew.send_mail = lambda subject, body: sent.append((subject, body)) or (True, "fake")
    try:
        a7b = args_for(db2, "", faillog)
        a7b.once = False
        a7b.no_send = False
        run_quiet(lambda: ew.scan_once(a7b, {}))
    finally:
        ew.send_mail = real_send
    p7b = (bool(sent) and "代理在同一时段有失败，但还没到放弃" in sent[0][1]
           and "Connection refused" in sent[0][1])
    print("== 7b 有失败未放弃的措辞（新格式日志）:", "PASS" if p7b else "FAIL")
    ok = ok and p7b

    # 7c：同样的内容用升级前的旧格式，锁住向后兼容
    oldlog = os.path.join(tmp, "failonly_old.log")
    make_plog(oldlog, time.time(), mode="fail_only", old_format=True)
    sent = []
    ew.send_mail = lambda subject, body: sent.append((subject, body)) or (True, "fake")
    try:
        a7c = args_for(db2, "", oldlog)
        a7c.once = False
        a7c.no_send = False
        run_quiet(lambda: ew.scan_once(a7c, {}))
    finally:
        ew.send_mail = real_send
    p7c = (bool(sent) and "代理在同一时段有失败，但还没到放弃" in sent[0][1]
           and "Connection refused" in sent[0][1])
    print("== 7c 同上（旧格式日志）:", "PASS" if p7c else "FAIL")
    ok = ok and p7c

    # 8：冷却 —— 1 秒后同一会话再报不发；把 sent_at 往前拨过冷却期后能再发
    st8, sent = {}, []
    ew.send_mail = lambda subject, body: sent.append((subject, body)) or (True, "fake")
    try:
        a8 = args_for(db2, "", plog)
        a8.once = False
        a8.no_send = False
        run_quiet(lambda: ew.scan_once(a8, st8))          # 两会话合并 1 封
        con = sqlite3.connect(db2)
        con.execute("update session set time_updated=? where id='sess_a'", (now + 1000,))
        con.commit()
        con.close()
        run_quiet(lambda: ew.scan_once(a8, st8))          # 冷却期内：不发
        cooled_ok = len(sent) == 1
        st8["sent_at"]["sess_a"] = time.time() - ew.SESSION_GAP - 1   # 冷却过期
        st8["sent"] = []                                   # 绕开每小时上限
        run_quiet(lambda: ew.scan_once(a8, st8))          # 过期后：再发
        expired_ok = len(sent) == 2
    finally:
        ew.send_mail = real_send
    print("== 8 冷却期内不发(%s) / 过期后能发(%s):"
          % (cooled_ok, expired_ok), "PASS" if (cooled_ok and expired_ok) else "FAIL")
    ok = ok and cooled_ok and expired_ok

    # 9：发信失败不推进 seen；退避期内不再撞；退避到期后重试成功
    st9, tries = {}, []
    ew.send_mail = lambda subject, body: tries.append(1) or (False, "boom")
    try:
        a9 = args_for(db, "", plog)
        a9.once = False
        a9.no_send = False
        run_quiet(lambda: ew.scan_once(a9, st9))
        kept = "sess_fresh" not in st9.get("seen", {})
        run_quiet(lambda: ew.scan_once(a9, st9))      # 退避期内：不发、也不再撞 MCP
        backed_off = len(tries) == 1
        ew.send_mail = lambda subject, body: tries.append(1) or (True, "fake")
        st9["retry_after"] = 0                        # 退避到期
        run_quiet(lambda: ew.scan_once(a9, st9))
        p9 = kept and backed_off and len(tries) == 2 and "sess_fresh" in st9.get("seen", {})
    finally:
        ew.send_mail = real_send
    print("== 9 失败不丢(%s) / 退避内不撞(%s) / 到期重试(%s):"
          % (kept, backed_off, len(tries) == 2),
          "PASS" if p9 else "FAIL")
    ok = ok and p9

    # 10：--once 走完整 main()，不落盘、不推进状态
    st10_path = os.path.join(tmp, "state_once.json")
    old_argv = sys.argv
    sys.argv = ["error_watch.py", "--once", "--db", db, "--state", st10_path,
                "--proxy-log", plog]
    try:
        run_quiet(lambda: ew.main())
    finally:
        sys.argv = old_argv
    p10 = not os.path.exists(st10_path)
    print("== 10 main(--once) 不落盘:", "PASS" if p10 else "FAIL")
    ok = ok and p10

    print("\n总体:", "全部通过" if ok else "有失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
