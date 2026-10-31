#!/usr/bin/env python3
"""Zcode-Persistence 的失败建议钩子。

挂在 ZCode 的 PostToolUse 与 PostToolUseFailure 两个事件上（matcher = Bash）。
两种事件都接是有原因的：实测这个客户端对"被中断/超时的工具调用"不会派发
PostToolUseFailure，但 PostToolUse 一定会来，并且带结构化结果
（exitCode / timedOut / status / stderr）。没有 PostToolUse 就永远不触发。

行为：判断这次 Bash 调用是否失败；**任何失败**都向会话注入一条建议重试的提示，
最多建议 3 次。v0.4.0 起不再按错误类型筛除——用户规格是"只要是报错就重试三次"。
永不阻断会话，所有路径退出码 0。

判定顺序（命中即返回）：
  1. 不是 Bash                       → 静默
  2. 没有失败                       → 静默
  3. 同一个 toolCallId 已经建议过     → 静默（防两个事件重复触发）
  4. 超时                            → 建议"立刻原样重试"
  5. 上游没产出（UPSTREAM 命中）      → 建议"先等 3 分钟再重试"
  6. 其它任何报错                    → 建议"立刻原样重试"
"""

import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time

MAX_RETRIES = 3
RESET_AFTER_SECONDS = 600      # 同一条命令超过 10 分钟算新一轮
STATE_TTL_SECONDS = 86400
DEDUPE_SECONDS = 120           # 同一 toolCallId 在此窗口内只建议一次

# 上游/提供方过载类：建议等 3 分钟再重试
UPSTREAM_PATTERNS = [
    r"upstream[_\s-]?deadline",
    r"upstream[_\s-]?error",
    r"turn execution failed",
    r"没有产出",
    r"\boverloaded\b",
    r"provider[_\s-]?code",
    r"\bcapacity\b",
]

# 注意：早期版本这里还有 FATAL_PATTERNS（确定性错误永不重试），v0.4.0 已整体删除。
# 用户规格是"只要是报错就重试三次"，任何失败都必须建议重试，不要再加回来。
UPSTREAM_RE = re.compile("|".join(UPSTREAM_PATTERNS), re.IGNORECASE)

# 这些字段是标识符/元数据，不参与错误匹配（仅用于 PostToolUseFailure 的回退路径）
EXCLUDED_KEYS = {
    "session_id", "sessionid", "transcript_path", "transcriptpath", "traceid",
    "toolcallid", "tool_call_id", "tooluseid", "tool_use_id",
    "requestid", "request_id", "message_id", "messageid", "turnid",
    "hook_event_name", "hookeventname", "timestamp", "uuid",
    "cwd", "version", "mode", "permissionmode", "permission_mode",
    "toolname", "tool_name", "toolinput", "tool_input",
}


def flatten(value, key=""):
    """递归收集字符串，跳过元数据字段。"""
    out = []
    if isinstance(value, str):
        if key.lower() not in EXCLUDED_KEYS:
            out.append(value)
    elif isinstance(value, dict):
        for k, v in value.items():
            out.extend(flatten(v, k))
    elif isinstance(value, (list, tuple)):
        for v in value:
            out.extend(flatten(v, key))
    elif value is not None and not isinstance(value, bool):
        if key.lower() not in EXCLUDED_KEYS:
            out.append(str(value))
    return out


def state_path():
    "状态文件路径：默认 %TEMP%/Zcode-Persistence/state.json，可用 ZCODE_RETRY_HOOK_STATE_DIR 改写（测试用）。"
    override = os.environ.get("ZCODE_RETRY_HOOK_STATE_DIR")
    d = override or os.path.join(tempfile.gettempdir(), "Zcode-Persistence")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "state.json")


def log_path():
    "日志路径，与状态文件同目录（hook.log）。"
    return os.path.join(os.path.dirname(state_path()), "hook.log")


def log(msg):
    "追加一行带时间戳的日志；日志写失败绝不抛出（钩子不允许因日志崩掉）。"
    try:
        with open(log_path(), "a", encoding="utf-8") as fh:
            fh.write("%s\t%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def load_state():
    "读状态文件；不存在/损坏/不是对象一律当空字典，宁可从零计数也不要静默。"
    try:
        with open(state_path(), encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_state(state):
    "原子写状态文件（先写 .tmp 再 replace），写失败静默。"
    try:
        p = state_path()
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        os.replace(tmp, p)
    except Exception:
        pass


def num(value, default):
    """状态文件可能被手工改坏：非数字、NaN、Inf 一律当默认值。

    早期版本直接 float()/int()，遇到 "junk"/"NaN"/"1e999" 就抛异常，
    整个钩子静默退出——失败不重试比崩溃更隐蔽，所以这里必须兜住。
    """
    try:
        v = float(value)
    except (TypeError, ValueError, OverflowError):
        return float(default)
    if not math.isfinite(v):
        return float(default)
    return v


def text_of(value):
    """把 stderr/stdout 统一成字符串；非字符串（数字、对象）也不许炸。"""
    if value is None or isinstance(value, (dict, list)):
        return ""
    return str(value)


def pick_head(text, last=False):
    """挑一行最能代表这次失败的文本。

    stderr 取**第一行**（错误摘要通常在开头），stdout 取**最后一行**
    （普通输出在前、真正的失败往往压尾）。
    """
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    if not lines:
        return ""
    return (lines[-1] if last else lines[0])[:60]


def to_int(value):
    """退出码可能是 0 / "0" / null。转不出来就当没有（None），别当成失败。"""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def is_true(value):
    """布尔字段可能是 True / "true" / "1"。bool("false") 是 True，不能用。"""
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "1", "yes", "y")


def failure_of(data):
    """判断本次调用是否失败，返回 (是否失败, 错误全文, 是否超时, 摘要首行)。

    PostToolUse 有结构化 toolResponse；PostToolUseFailure 只有 error。
    两条路径都支持，优先用结构化字段；两条路径都返回同一形状的四元组。
    摘要用于日志，可以很短；全文才参与 UPSTREAM_PATTERNS 匹配。
    """
    resp = data.get("tool_response")
    if resp is None:
        resp = data.get("toolResponse")
    if isinstance(resp, dict):
        exit_code = to_int(resp.get("exitCode"))
        timed_out = is_true(resp.get("timedOut"))
        status = str(resp.get("status") or "").lower()
        stopped = is_true(resp.get("cancelled")) or is_true(resp.get("interrupted"))
        # 只看硬信号：退出码非 0 / 真超时 / 被取消 / status 明确是失败词。
        # 绝不能写成 status != "completed" —— 有的成功调用给的是 success/ok，
        # 那样会把成功命令判成失败，进而建议重试（v0.4.0 复审抓到的假阳性）。
        failed = (exit_code not in (0, None)) or timed_out or stopped or \
                 status in ("failed", "error", "failure")
        stderr_text = text_of(resp.get("stderr"))
        stdout_text = text_of(resp.get("stdout"))
        parts = [x for x in (stderr_text, stdout_text) if x]
        # 摘要优先 stderr 第一行；没有 stderr 才退回 stdout 最后一行
        head = pick_head(stderr_text) or pick_head(stdout_text, last=True)
        return failed, "\n".join(parts), timed_out, head

    # tool_response 不是字典（少数客户端直接给字符串）时按内容判，不要拿元数据凑
    if resp is not None:
        text = resp if isinstance(resp, str) else json.dumps(resp, ensure_ascii=False)
        return bool(text.strip()), text, False, pick_head(text)

    # 回退：PostToolUseFailure 的形状
    err = data.get("error")
    if err is None:
        err = data.get("error_details")
    if err is None:
        err = data.get("error_message")
    if err is None:
        err = data.get("errorMessage")
    if err is None:
        # 既没有结构化 toolResponse，也没有任何 error 字段：这次调用是否失败无从判断。
        # 绝不能拿 tool_name / session_id 这些元数据去凑"错误文本"——那会把每一次
        # 成功的 Bash 调用都判成失败并建议重试（复审发现的假阳性）。
        return False, "", False, ""
    text = "\n".join(flatten(err))
    return bool(text), text, False, pick_head(text)


def read_stdin():
    """固定按 UTF-8 解码，不依赖系统码页。

    Windows 上 sys.stdin 默认是 GBK，中文错误文本会变乱码，`UPSTREAM_PATTERNS`
    里的中文就永远匹配不上；非法字节也不能让钩子崩，用 replace 兜住。
    """
    buf = getattr(sys.stdin, "buffer", None)
    if buf is not None:
        return buf.read().decode("utf-8", "replace")
    return sys.stdin.read()


def main():
    "钩子入口：读 payload → 判失败 → 去重 → 计数 → 输出 additionalContext。永远返回 0。"
    raw = read_stdin()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        log("skip: stdin 不是合法 JSON")
        return 0
    if not isinstance(data, dict):
        return 0

    tool_name = str(data.get("tool_name") or data.get("toolName") or "")
    if tool_name != "Bash":
        return 0

    failed, text, timed_out, head = failure_of(data)
    if not failed:
        return 0
    # 失败但一个字都没有（例如 grep 无匹配 exit=1）照样要建议重试：
    # 用户的规格是"任何报错都重试"，没有输出不等于没失败。

    # 防重复：两个事件可能对同一次调用各触发一次
    call_id = str(data.get("tool_use_id") or data.get("toolCallId") or "")
    session = str(data.get("session_id") or data.get("sessionId") or "unknown")
    state = load_state()
    now = time.time()

    if call_id:
        seen = state.get("__last_call__")
        if not isinstance(seen, dict):      # 状态文件可能被改坏/被旧版本写过
            seen = {}
        if seen.get("id") == call_id and now - num(seen.get("t"), 0) < DEDUPE_SECONDS:
            log("skip: 同一 toolCallId 已建议过 (%s)" % call_id)
            return 0

    # v0.4.0：不再按错误类型筛除。用户的规格是"只要是报错就重试三次"，
    # 所以任何失败都建议重试，唯一的例外是上游没产出（这类先等 3 分钟再发更有效）。
    upstream = None if timed_out else UPSTREAM_RE.search(text)
    if timed_out:
        kind, sig = "timeout", "timedOut"
    elif upstream:
        kind, sig = "upstream", upstream.group(0)
    else:
        # 只为让人看懂是哪条错误，不影响是否重试
        kind, sig = "error", head or "no output"

    command = ""
    ti = data.get("tool_input") or data.get("toolInput") or {}
    if isinstance(ti, dict):
        command = str(ti.get("command") or "")
    if not command:
        command = json.dumps(ti, sort_keys=True, ensure_ascii=False)

    key = hashlib.sha1(("%s|%s" % (session, command)).encode("utf-8", "replace")).hexdigest()[:16]
    for k in [k for k, v in state.items()
              if not k.startswith("__") and isinstance(v, dict)
              and now - num(v.get("last"), 0.0) > STATE_TTL_SECONDS]:
        state.pop(k, None)

    rec = state.get(key)
    if not isinstance(rec, dict):
        rec = {}
    count = int(num(rec.get("count"), 0))
    if now - num(rec.get("last"), 0.0) > RESET_AFTER_SECONDS:
        count = 0

    if count >= MAX_RETRIES:
        state[key] = {"count": count, "last": now}
        if call_id:
            state["__last_call__"] = {"id": call_id, "t": now}
        save_state(state)
        log("cap: 已达 %d 次上限 kind=%s" % (MAX_RETRIES, kind))
        return 0

    count += 1
    state[key] = {"count": count, "last": now}
    if call_id:
        state["__last_call__"] = {"id": call_id, "t": now}
    save_state(state)
    # 只记次数和类型，不把错误正文写进日志（可能含密钥/路径）
    log("advise: %d/%d kind=%s" % (count, MAX_RETRIES, kind))

    if kind == "upstream":
        msg = ("检测到上游/服务方暂时没有产出（{sig}）。这类错误立刻重试通常还会失败："
               "先运行 `sleep 180` 等 3 分钟再重试。注意 sleep 这条命令本身要把超时上限"
               "设到 200000 毫秒以上（默认 2 分钟会把它杀掉，那就白等了），"
               "然后原样重试同一条命令，这是第 {n}/{mx} 次。"
               "若第 {mx} 次仍失败，停止重试并向用户说明卡在哪一步，不要改写命令或跳过它。").format(
                   sig=sig, n=count, mx=MAX_RETRIES)
    else:
        msg = ("检测到报错（{sig}）。按要求任何报错都重试：原样重试同一条命令，"
               "这是第 {n}/{mx} 次。若第 {mx} 次仍失败，停止重试并向用户说明卡在哪一步，"
               "不要改写命令或跳过它。").format(sig=sig, n=count, mx=MAX_RETRIES)

    # 必须用 additionalContext：只有这个字段会注入模型上下文，模型才会真的去重试。
    # systemMessage 只对用户可见、模型看不见，等于没生效（v0.3.0 的 bug）。
    # ensure_ascii=True：Windows 管道默认 GBK 码页会把中文写坏；JSON 转义成 ASCII
    # 最稳妥，客户端解码后仍是中文。
    sys.stdout.write(json.dumps({"additionalContext": msg}, ensure_ascii=True))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # 钩子自身出错也绝不打断会话
        try:
            # 只记异常类型：repr(exc) 可能把原始输入字节写进日志
            log("error: %s" % type(exc).__name__)
        except Exception:
            pass
        sys.exit(0)
