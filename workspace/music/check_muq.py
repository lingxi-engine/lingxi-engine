import os
base = r'C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained\models--OpenMuQ--MuQ-MuLan-large'
blobs = os.path.join(base, 'blobs')
if os.path.isdir(blobs):
    for f in os.listdir(blobs):
        p = os.path.join(blobs, f)
        print(f, os.path.getsize(p), 'incomplete' if f.endswith('.incomplete') else '')
else:
    print('no blobs dir')
# also check snapshots
snap = os.path.join(base, 'snapshots')
for root, dirs, files in os.walk(snap):
    for f in files:
        p = os.path.join(root, f)
        print('snap:', os.path.relpath(p, base), os.path.getsize(p))
