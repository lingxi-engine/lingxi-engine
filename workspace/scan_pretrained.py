import os

base = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained"
for root, dirs, files in os.walk(base):
    # skip huge dirs but show them
    depth = root[len(base):].count(os.sep)
    if depth > 3:
        continue
    print(root)
    for f in files:
        p = os.path.join(root, f)
        try:
            size = os.path.getsize(p)
        except Exception as e:
            size = -1
        print("   ", f, size)
    for d in dirs:
        print("   [d]", d)
