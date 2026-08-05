import json, urllib.request, sys, time

def out(s):
    sys.stdout.write(s + "\n")
    sys.stdout.flush()

FULL_KEY = "sk-65d529832f8c4cdb86fa198df004dcab"

def chat(url, model, key=None, timeout=60):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "请回复：云端模型测试成功"}],
        "max_tokens": 100,
        "temperature": 0.1
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    elapsed = time.time() - t0
    content = data["choices"][0]["message"]["content"]
    finish = data["choices"][0].get("finish_reason")
    usage = data.get("usage", {})
    return content, elapsed, finish, usage

out("TEST 1: DeepSeek deepseek-v4-flash (cloud, direct API)")
try:
    content, elapsed, finish, usage = chat("https://api.deepseek.com/v1/chat/completions", "deepseek-v4-flash", FULL_KEY)
    out(f"  OK ({elapsed:.1f}s) finish={finish} tokens={usage.get('total_tokens')}")
    out(f"  content: {content[:120]!r}")
except Exception as e:
    out(f"  FAIL: {e}")

out("")
out("TEST 2: Ollama glm-5.2:cloud (cloud via Ollama /v1)")
try:
    content, elapsed, finish, usage = chat("http://localhost:11434/v1/chat/completions", "glm-5.2:cloud")
    out(f"  OK ({elapsed:.1f}s) finish={finish} tokens={usage.get('total_tokens')}")
    out(f"  content: {content[:120]!r}")
except Exception as e:
    out(f"  FAIL: {e}")

out("")
out("TEST 3: Ollama kimi-k2.6:cloud (cloud via Ollama /v1)")
try:
    content, elapsed, finish, usage = chat("http://localhost:11434/v1/chat/completions", "kimi-k2.6:cloud")
    out(f"  OK ({elapsed:.1f}s) finish={finish} tokens={usage.get('total_tokens')}")
    out(f"  content: {content[:120]!r}")
except Exception as e:
    out(f"  FAIL: {e}")

out("")
out("TEST 4: Ollama local qwen3.5:9b (local, baseline)")
try:
    content, elapsed, finish, usage = chat("http://localhost:11434/v1/chat/completions", "qwen3.5:9b")
    out(f"  OK ({elapsed:.1f}s) finish={finish} tokens={usage.get('total_tokens')}")
    out(f"  content: {content[:120]!r}")
except Exception as e:
    out(f"  FAIL: {e}")
