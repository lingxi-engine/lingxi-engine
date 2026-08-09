import os
base = r'C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained\models--OpenMuQ--MuQ-MuLan-large'
for sub in ['refs', 'snapshots']:
    p = os.path.join(base, sub)
    if os.path.isdir(p):
        for root, dirs, files in os.walk(p):
            for f in files:
                fp = os.path.join(root, f)
                print(os.path.relpath(fp, base), os.path.getsize(fp))
                if f == 'main':
                    with open(fp, 'r', encoding='utf-8', errors='replace') as fh:
                        print('  ->', fh.read().strip()[:120])
