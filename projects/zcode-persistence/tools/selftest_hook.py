#!/usr/bin/env python3
"""自检：钩子的失败判定。

重点回归 2026-11-01 的假阳性：`exitCode=1` 且 stdout/stderr 全空，是
`grep -q` 无匹配、`diff --quiet` 无差异、`test` 条件不成立这类谓词命令的
正常否定结果，不能建议重试；客户端仍会把它标成 `status="failed"`，所以
不能只看 status。

验证十件事 + 一组次数文案（共 11 行断言）：
  1. exit 1 + 无输出              → 静默
  2. exit 1 + stderr              → 建议重试
  3. exit 1 + stdout              → 建议重试
  4. exit 2 + 无输出              → 建议重试（非 1 的退出码仍算失败）
  5. exit 0 + success             → 静默
  6. 超时 + 无输出                → 建议原样重试
  7. 取消 + 无输出                → 建议重试（取消仍算失败）
  8. status=failed + exit 1 + 空  → 静默（客户端会把 exit 1 标成 failed）
  9. status=failed + exit 0       → 建议重试（明确的失败状态仍算失败）
 10. 上游无产出                   → 建议先等 3 分钟（sleep 180）
 11. status=failed 且无 exitCode  → 建议重试（只能靠状态判定）
 另加一组次数文案：同一条命令连续失败 3 次，第 3 次必须出现“3/3”和
 “不要因此停下整个任务”；第 4 次必须静默（达到上限）。

用法：python tools/selftest_hook.py            （默认读同包 src/retry_hook.py）
      python tools/selftest_hook.py --src X    （指定要测的脚本）
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

CASES = [
    ("exit1_no_output", {"exitCode": 1, "stdout": "", "stderr": "",
                         "status": "failed"}, False, ""),
    ("exit1_stderr", {"exitCode": 1, "stdout": "", "stderr": "boom",
                      "status": "failed"}, True, "原样重试"),
    ("exit1_stdout", {"exitCode": 1, "stdout": "some output", "stderr": "",
                      "status": "failed"}, True, "原样重试"),
    ("exit2_no_output", {"exitCode": 2, "stdout": "", "stderr": "",
                         "status": "failed"}, True, "原样重试"),
    ("success", {"exitCode": 0, "stdout": "", "stderr": "",
                 "status": "success"}, False, ""),
    ("timeout", {"exitCode": 1, "stdout": "", "stderr": "",
                 "timedOut": True}, True, "原样重试"),
    ("cancelled", {"exitCode": 1, "stdout": "", "stderr": "",
                   "cancelled": True}, True, "原样重试"),
    ("status_failed_no_exit", {"stdout": "", "stderr": "",
                               "status": "failed"}, True, "原样重试"),
    ("status_failed_exit0", {"exitCode": 0, "stdout": "", "stderr": "",
                             "status": "failed"}, True, "原样重试"),
    ("upstream_no_output", {"exitCode": 2, "stdout": "",
                            "stderr": "upstream_deadline"}, True, "sleep 180"),
]


def run_case(script, index, name, response, want_advice, want_text):
    "跑一个用例；每个用例用独立状态目录，避免 3 次上限互相干扰。"
    state_dir = tempfile.mkdtemp(prefix="zcode-hook-selftest-")
    payload = {
        "tool_name": "Bash",
        "session_id": "selftest",
        "tool_use_id": "call-%d" % index,
        "tool_response": response,
        "tool_input": {"command": "selftest-%d" % index},
    }
    env = dict(os.environ, ZCODE_RETRY_HOOK_STATE_DIR=state_dir)
    try:
        proc = subprocess.run(
            [sys.executable, script],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            encoding="utf-8",
            env=env,
            timeout=10,
        )
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)

    # 钩子用 ensure_ascii=True 输出 JSON，中文是 \uXXXX 转义；必须解析后再比对，
    # 不能直接拿原始 stdout 做子串匹配。
    advice = ""
    if proc.stdout.strip():
        try:
            advice = str(json.loads(proc.stdout).get("additionalContext") or "")
        except ValueError:
            advice = ""
    got_advice = bool(advice)
    ok = proc.returncode == 0 and got_advice == want_advice
    if ok and want_text:
        ok = want_text in advice
    print("%-28s want=%-5s got=%-5s rc=%d %s"
          % (name, want_advice, got_advice, proc.returncode, "PASS" if ok else "FAIL"))
    if not ok:
        print("  stdout=%r" % proc.stdout[:500])
        print("  stderr=%r" % proc.stderr[:500])
    return ok


def run_sequence(script):
    """同一条命令连续失败 4 次，验证次数文案与上限。

    第 3 次是模型最容易照做的一次：旧文案在这里要求“停止重试并向用户说明”，
    模型会直接结束回合。必须断言它变成“继续当前任务的其他步骤”，
    并且第 4 次安静（上限 3 次，不能无限建议）。
    """
    state_dir = tempfile.mkdtemp(prefix="zcode-hook-seq-")
    env = dict(os.environ, ZCODE_RETRY_HOOK_STATE_DIR=state_dir)
    advices = []
    try:
        for i in range(4):
            payload = {
                "tool_name": "Bash",
                "session_id": "selftest-seq",
                "tool_use_id": "call-seq-%d" % i,
                "tool_response": {"exitCode": 2, "stdout": "", "stderr": "boom",
                                  "status": "failed"},
                "tool_input": {"command": "same-command"},
            }
            proc = subprocess.run(
                [sys.executable, script],
                input=json.dumps(payload),
                text=True,
                capture_output=True,
                encoding="utf-8",
                env=env,
                timeout=10,
            )
            advice = ""
            if proc.stdout.strip():
                try:
                    advice = str(json.loads(proc.stdout).get("additionalContext") or "")
                except ValueError:
                    advice = ""
            advices.append((proc.returncode, advice))
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)

    third = advices[2][1] if len(advices) > 2 else ""
    fourth = advices[3][1] if len(advices) > 3 else ""
    ok = (len(advices) == 4
          and all(rc == 0 for rc, _ in advices)
          and all(advice for _, advice in advices[:3])
          and "3/3" in third
          and "不要因此停下整个任务" in third
          and not fourth)
    print("%-28s %s" % ("third_attempt_wording", "PASS" if ok else "FAIL"))
    if not ok:
        print("  advices=%r" % [(rc, a[:120]) for rc, a in advices])
    return ok


def main():
    "入口：解析参数、逐项跑用例，全部通过才返回 0。"
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(description="钩子失败判定自检")
    parser.add_argument("--src", default=os.path.join(here, "src", "retry_hook.py"),
                        help="要测试的 retry_hook.py 路径")
    args = parser.parse_args()
    if not os.path.isfile(args.src):
        print("找不到钩子脚本: %s" % args.src)
        return 2

    print("== 钩子判定（2026-11-01 假阳性回归）")
    all_ok = True
    for i, (name, response, want_advice, want_text) in enumerate(CASES):
        all_ok &= run_case(args.src, i, name, response, want_advice, want_text)
    all_ok &= run_sequence(args.src)
    print("总体: %s" % ("全部通过" if all_ok else "有失败"))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
