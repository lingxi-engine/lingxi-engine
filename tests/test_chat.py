import urllib.request, json
data = json.dumps({'chatId':'chat-demo-1','content':'你好','from':'user-shen'}).encode()
req = urllib.request.Request('http://localhost:3456/api/chat', data=data, headers={'Content-Type':'application/json'})
try:
    r = urllib.request.urlopen(req, timeout=30)
    print('status:', r.status)
    print('body:', r.read()[:500])
except urllib.error.HTTPError as e:
    print('http error:', e.code)
    print('body:', e.read()[:500])
except Exception as e:
    print('error:', e)
