import socket

for host, port in [("hf-mirror.com", 443), ("mirrors.tuna.tsinghua.edu.cn", 443), ("modelscope.cn", 443), ("www.modelscope.cn", 443)]:
    try:
        socket.setdefaulttimeout(8)
        s = socket.create_connection((host, port), timeout=8)
        print(f"{host}:{port} OK", s.getpeername())
        s.close()
    except Exception as e:
        print(f"{host}:{port} FAIL", e)
