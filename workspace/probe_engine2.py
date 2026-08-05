import json, urllib.request, urllib.error, sys, time

def out(s):
    sys.stdout.write(s + "\n")
    sys.stdout.flush()

def http_json(url, method="GET", body=None, headers=None, timeout=6):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", errors="replace"), time.time() - t0

ADMIN_TOKEN = "08b550ca5b73f587f9bf354c8f8eab9f"

# 带 admin token 尝试引擎 API
out("=== 带 ADMIN_TOKEN 探测引擎 ===")
for path in ["/api/health", "/api/providers", "/api/models", "/api/chat/messages", "/api/agents"]:
    for name, hdrs in [
        ("x-admin-token", {"x-admin-token": ADMIN_TOKEN}),
        ("Authorization", {"Authorization": "Bearer " + ADMIN_TOKEN}),
        ("x-auth-token", {"x-auth-token": ADMIN_TOKEN}),
    ]:
        try:
            st, body, el = http_json(f"http://127.0.0.1:3456{path}", headers=hdrs, timeout=4)
            out(f"  GET {path} [{name}] -> {st} ({el:.1f}s): {body[:150]}")
            break
        except Exception as e:
            out(f"  GET {path} [{name}] -> FAIL: {str(e)[:80]}")
