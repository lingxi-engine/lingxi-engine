import json, urllib.request, sys, time

def out(s):
    sys.stdout.write(s + "\n")
    sys.stdout.flush()

def call_ollama(model, prompt, timeout=60):
    body = json.dumps({"model": model, "prompt": prompt, "stream": False}).encode("utf-8")
    req = urllib.request.Request(
        "http://localhost:11434/api/generate",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    elapsed = time.time() - t0
    return data, elapsed

# 测试云端模型
cloud_models = ["glm-5.2:cloud", "kimi-k2.6:cloud", "gpt-oss:20b-cloud"]
for m in cloud_models:
    out(f"--- CALLING cloud model: {m} ---")
    try:
        data, elapsed = call_ollama(m, "Say OK in one word.")
        resp_text = data.get("response", "")[:100]
        out(f"  RESPONSE ({elapsed:.1f}s): {resp_text!r}")
        out(f"  done={data.get('done')} eval_count={data.get('eval_count')}")
    except Exception as e:
        out(f"  FAIL: {e}")
    out("")

# 对比: 本地模型
out("--- CALLING local model: qwen3:4b ---")
try:
    data, elapsed = call_ollama("qwen3:4b", "Say OK in one word.")
    resp_text = data.get("response", "")[:100]
    out(f"  RESPONSE ({elapsed:.1f}s): {resp_text!r}")
    out(f"  done={data.get('done')} eval_count={data.get('eval_count')}")
except Exception as e:
    out(f"  FAIL: {e}")
