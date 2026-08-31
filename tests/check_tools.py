import urllib.request, json
d = json.loads(urllib.request.urlopen('http://localhost:3456/api/tools').read())
tools = [t['name'] for t in d['tools']]
print(f"{len(tools)} tools: {', '.join(tools)}")
