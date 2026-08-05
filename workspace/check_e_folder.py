import os
path = r"E:\文档文件夹"
print(f"Checking: {path}")
print(f"Exists: {os.path.exists(path)}")
if os.path.exists(path):
    for f in os.listdir(path):
        full = os.path.join(path, f)
        size = os.path.getsize(full)
        print(f"  {f}  ({size} bytes)")
