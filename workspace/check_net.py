import os
import socket

# 1. Test network connectivity
print("=== Network test ===")
try:
    socket.setdefaulttimeout(8)
    s = socket.create_connection(("huggingface.co", 443), timeout=8)
    print("huggingface.co:443 reachable:", s.getpeername())
    s.close()
except Exception as e:
    print("huggingface.co unreachable:", e)

# 2. Query MuQ model file list
print("=== MuQ-MuLan-large files ===")
try:
    from huggingface_hub import HfApi
    api = HfApi()
    files = api.list_repo_files("OpenMuQ/MuQ-MuLan-large")
    for f in files:
        print(" ", f)
except Exception as e:
    print("list_repo_files failed:", e)

# 3. Test soundfile mp3 write support
print("=== soundfile mp3 test ===")
try:
    import soundfile as sf
    import numpy as np
    tmp = r"C:\Users\Administrator\lingxi-engine\workspace\sf_test.mp3"
    sf.write(tmp, np.zeros((44100, 2), dtype=np.float32), 44100, format="MP3")
    print("MP3 write OK, size:", os.path.getsize(tmp))
    os.remove(tmp)
except Exception as e:
    print("MP3 write failed:", e)
