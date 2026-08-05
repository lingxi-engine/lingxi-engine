import json, urllib.request, sys, time

def out(s):
    sys.stdout.write(s + "\n")
    sys.stdout.flush()

FULL_KEY = "sk-65d529832f8c4cdb86fa198df004dcab"

out("=" * 50)
out("TEST A: DeepSeek API with FULL key (models list)")
out("=" * 50)
try:
    req = urllib.request.Request(
        "https://api.deepseek.com/models",
        headers={"Authorization": "Bearer " + FULL_KEY},
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        models = data.get("data", [])
        out(f"DeepSeek API OK [FULL KEY WORKS]  models: {len(models)}")
        for m in models:
            out(f"  - {m.get('id')}")
except Exception as e:
    out(f"DeepSeek API FAIL: {e}")

out("")
out("=" * 50)
out("TEST B: DeepSeek chat completion (full key)")
out("=" * 50)
try:
    body = json.dumps({
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": "Say OK"}],
        "max_tokens": 10
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.deepseek.com/v1/chat/completions",
        data=body,
        headers={"Authorization": "Bearer " + FULL_KEY, "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    elapsed = time.time() - t0
    content = data["choices"][0]["message"]["content"]
    out(f"DeepSeek chat OK ({elapsed:.1f}s): {content!r}")
except Exception as e:
    out(f"DeepSeek chat FAIL: {e}")

out("")
out("=" * 50)
out("TEST C: Ollama OpenAI-compatible endpoint (/v1/chat/completions)")
out("=" * 50)
try:
    body = json.dumps({
        "model": "glm-5.2:cloud",
        "messages": [{"role": "user", "content": "Say OK"}],
        "max_tokens": 10
    }).encode("utf-8")
    req = urllib.request.Request(
        "http://localhost:11434/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    elapsed = time.time() - t0
    content = data["choices"][0]["message"]["content"]
    out(f"Ollama /v1 cloud glm-5.2 OK ({elapsed:.1f}s): {content!r}")
except Exception as e:
    out(f"Ollama /v1 FAIL: {e}")

out("")
out("=" * 50)
out("TEST D: .env key check (does engine see DEEPSEEK_API_KEY?)")
out("=" * 50)
try:
    with open(".env", "r", encoding="utf-8", errors="replace") as f:
        env = f.read()
    lines = [l for l in env.splitlines() if "DEEPSEEK" in l.upper() or "API_KEY" in l.upper()]
    for l in lines:
        out(f"  {l.strip()}")
except Exception as e:
    out(f"read .env FAIL: {e}")
