import urllib.request
import json

# Test DeepSeek API
try:
    req = urllib.request.Request(
        'https://api.deepseek.com/v1/models',
        headers={'Authorization': 'Bearer sk-65d529832f8c4cdb86fa198df004dcab'}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())
        print("DeepSeek OK:", json.dumps(data, ensure_ascii=False)[:500])
except Exception as e:
    print("DeepSeek FAIL:", str(e)[:200])

print("---")

# Test Ollama API
try:
    with urllib.request.urlopen('http://localhost:11434/api/tags', timeout=5) as resp:
        data = json.loads(resp.read().decode())
        models = [m['name'] for m in data.get('models', [])]
        print("Ollama OK:", models)
except Exception as e:
    print("Ollama FAIL:", str(e)[:200])
