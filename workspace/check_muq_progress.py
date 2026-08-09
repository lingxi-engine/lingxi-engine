import os

base = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained\models--OpenMuQ--MuQ-MuLan-large"
for root, dirs, files in os.walk(base):
    for f in files:
        p = os.path.join(root, f)
        try:
            size = os.path.getsize(p)
        except Exception as e:
            size = -1
        print(os.path.relpath(p, base), size)
