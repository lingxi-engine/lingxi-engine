# -*- coding: utf-8 -*-
"""
模型路由对比测试：用路由 vs 不用路由
"""
import json, urllib.request, sys, time, hashlib

# 修复 Windows 控制台编码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

def out(s):
    sys.stdout.write(s + "\n")
    sys.stdout.flush()

DEEPSEEK_KEY = "sk-65d529832f8c4cdb86fa198df004dcab"
OLLAMA = "http://localhost:11434/v1/chat/completions"
DEEPSEEK = "https://api.deepseek.com/v1/chat/completions"

def call(url, model, messages, max_tokens=1200, timeout=90):
    body = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if "deepseek" in url:
        req.add_header("Authorization", "Bearer " + DEEPSEEK_KEY)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        el = time.time() - t0
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        usage = data.get("usage", {})
        return {"ok": True, "elapsed": el, "content": content, "usage": usage,
                "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"),
                "total_tokens": usage.get("total_tokens")}
    except Exception as e:
        return {"ok": False, "error": str(e), "elapsed": time.time() - t0}

TASK = [
    {"role": "system", "content": "你是灵犀引擎上的 AI 助手，简洁有力，直接给答案。"},
    {"role": "user", "content": "用 Python 写一个生成斐波那契数列前 20 项的函数，并简要说明时间复杂度。不要多余废话。"},
]

TOOL_SUBTASK = [
    {"role": "system", "content": "你是工具调用模型，负责拆解任务。输出 JSON 格式步骤。"},
    {"role": "user", "content": "拆解任务：用 Python 写斐波那契前20项并说明复杂度。只输出步骤列表。"},
]

configs = [
    ("A 不用路由: 全程本地 qwen3.5:9b",      "qwen3.5:9b",       OLLAMA,  "qwen3.5:9b",       OLLAMA),
    ("B 用路由: 工具=DS-flash云端, 回复=glm-5.2:cloud", "deepseek-v4-flash", DEEPSEEK, "glm-5.2:cloud", OLLAMA),
    ("C 用路由: 工具=本地qwen3.5:9b, 回复=deepseek-v4-flash", "qwen3.5:9b", OLLAMA, "deepseek-v4-flash", DEEPSEEK),
    ("D 用路由: 工具=DS-flash, 回复=kimi-k2.6:cloud", "deepseek-v4-flash", DEEPSEEK, "kimi-k2.6:cloud", OLLAMA),
]

results = []
for name, tool_m, tool_url, reply_m, reply_url in configs:
    out(f"\n{'='*60}\n>> {name}\n{'='*60}")
    out(f"  [工具阶段] {tool_m}")
    tr = call(tool_url, tool_m, TOOL_SUBTASK, max_tokens=500)
    if tr["ok"]:
        out(f"    耗时 {tr['elapsed']:.1f}s  tokens={tr['total_tokens']}  输出前80字: {tr['content'][:80]!r}")
    else:
        out(f"    FAIL: {tr['error'][:100]}")
    tool_out = tr["content"][:400] if tr["ok"] else "(工具失败)"
    reply_msgs = TASK + [{"role": "assistant", "content": "（工具分析）" + tool_out}]
    out(f"  [回复阶段] {reply_m}")
    rr = call(reply_url, reply_m, reply_msgs)
    if rr["ok"]:
        out(f"    耗时 {rr['elapsed']:.1f}s  输入tokens={rr['prompt_tokens']} 输出tokens={rr['completion_tokens']} 总={rr['total_tokens']}")
        out(f"    答案: {rr['content'][:200]!r}")
    else:
        out(f"    FAIL: {rr['error'][:100]}")
    results.append({
        "name": name, "tool": tr, "reply": rr,
        "tool_elapsed": tr.get("elapsed"), "reply_elapsed": rr.get("elapsed"),
        "tool_tokens": (tr.get("total_tokens") if tr.get("ok") else None),
        "reply_prompt": (rr.get("prompt_tokens") if rr.get("ok") else None),
        "reply_completion": (rr.get("completion_tokens") if rr.get("ok") else None),
        "reply_total": (rr.get("total_tokens") if rr.get("ok") else None),
        "answer_hash": hashlib.md5((rr.get("content") or "").encode("utf-8")).hexdigest()[:8] if rr.get("ok") else "-",
        "answer_len": len(rr.get("content") or "") if rr.get("ok") else 0,
    })

out("\n\n" + "="*70)
out("汇总对比表")
out("="*70)
out(f"{'配置':<40} {'工具耗时':>8} {'回复耗时':>8} {'输入tok':>8} {'输出tok':>8} {'总tok':>8} {'答案len':>7} {'hash'}")
for r in results:
    out(f"{r['name'][:40]:<40} {r['tool_elapsed'] or 0:>7.1f}s {r['reply_elapsed'] or 0:>7.1f}s "
        f"{(r['reply_prompt'] or 0):>8} {(r['reply_completion'] or 0):>8} {(r['reply_total'] or 0):>8} "
        f"{r['answer_len']:>7} {r['answer_hash']}")
