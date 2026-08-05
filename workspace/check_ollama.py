import json, urllib.request, socket, sys

def out(s):
    sys.stdout.write(s + "\n")
    sys.stdout.flush()

out("=" * 50)
out("TEST 1: Ollama local service (localhost:11434)")
out("=" * 50)
try:
    req = urllib.request.Request("http://localhost:11434/api/tags", method="GET")
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        models = data.get("models", [])
        out(f"Ollama RUNNING [OK]  local models: {len(models)}")
        for m in models:
            out(f"  - {m.get('name')}  ({m.get('size', 0) / 1e9:.1f} GB)")
except Exception as e:
    out(f"Ollama CONNECT FAIL: {e}")

out("")
out("=" * 50)
out("TEST 2: DeepSeek Cloud API")
out("=" * 50)
try:
    req = urllib.request.Request(
        "https://api.deepseek.com/models",
        headers={"Authorization": "Bearer sk-65d5"},
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        models = data.get("data", [])
        out(f"DeepSeek API OK  cloud models: {len(models)}")
        for m in models:
            out(f"  - {m.get('id')}")
except Exception as e:
    out(f"DeepSeek API FAIL: {e}")

out("")
out("=" * 50)
out("TEST 3: Port listening status")
out("=" * 50)
for port in [11434, 3000, 8000, 8080, 5173]:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1)
    result = s.connect_ex(("127.0.0.1", port))
    status = "LISTENING [OK]" if result == 0 else "NOT LISTENING"
    out(f"  127.0.0.1:{port}  {status}")
    s.close()
