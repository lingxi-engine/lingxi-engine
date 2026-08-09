import os
# check muq blob progress
base = r'C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained\models--OpenMuQ--MuQ-MuLan-large'
blobs = os.path.join(base, 'blobs')
if os.path.isdir(blobs):
    for f in os.listdir(blobs):
        p = os.path.join(blobs, f)
        print('MUQ', f[:20], os.path.getsize(p), 'incomplete' if f.endswith('.incomplete') else '')
# check output
out = r'C:\Users\Administrator\lingxi-engine\workspace\music\output'
if os.path.isdir(out):
    print('OUT:', os.listdir(out))
else:
    print('OUT dir missing')
# check if python is running
import subprocess
r = subprocess.run(['tasklist'], capture_output=True, text=True, encoding='utf-8', errors='replace')
lines = [l for l in r.stdout.splitlines() if 'python' in l.lower()]
print('PYTHON PROCS:', len(lines))
for l in lines[:10]:
    print(' ', l.strip())
