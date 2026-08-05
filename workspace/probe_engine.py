import json, urllib.request, urllib.error, socket, sys, time

def out(s):
    sys.stdout.write(s + "\n")
    sys.stdout.flush()

def http_json(url, method="GET", body=None, headers=None, timeout=8):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", errors="replace")

# 1. 端口扫描
out("=== 1. 端口扫描 ===")
for port in [3456, 3000, 3001, 3002, 11434]:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1)
    r = s.connect_ex(("127.0.0.1", port))
    out(f"  127.0.0.1:{port}  {'LISTENING' if r == 0 else 'closed'}")
    s.close()

# 2. 引擎 API 探测
out("\n=== 2. 引擎 API 探测 (3456) ===")
for path in ["/api/health", "/health", "/api/status", "/", "/api/models", "/api/providers", "/api/chat"]:
    try:
        st, body = http_json(f"http://127.0.0.1:3456{path}", timeout=4)
        out(f"  GET {path} -> {st}: {body[:200]}")
    except Exception as e:
        out(f"  GET {path} -> FAIL: {e}")

# 3. Ollama 网关
out("\n=== 3. Ollama 本地网关 ===")
try:
    st, body = http_json("http://127.0.0.1:11434/api/tags", timeout=5)
    data = json.loads(body)
    models = data.get("models", [])
    out(f"  Ollama OK: {len(models)} models")
    for m in models:
        out(f"    - {m['name']}")
except Exception as e:
    out(f"  Ollama FAIL: {e}")

# 4. DeepSeek 云端直连（完整 key）
out("\n=== 4. DeepSeek 云端直连 ===")
FULL_KEY = "sk-65d529832f8c4cdb86fa198df004dcab"
try:
    st, body = http_json("https://api.deepseek.com/models", headers={"Authorization": "Bearer " + FULL_KEY}, timeout=8)
    data = json.loads(body)
    out(f"  DeepSeek OK: {[m['id'] for m in data.get('data', [])]}")
except Exception as e:
    out(f"  DeepSeek FAIL: {e}")
