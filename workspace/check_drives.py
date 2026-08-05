import os, sys
# Check what drives exist
for d in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
    path = d + ':\\'
    if os.path.exists(path):
        print(f'{path} exists')
        files = os.listdir(path)
        for f in files[:20]:
            print(f'  {f}')
        if len(files) > 20:
            print(f'  ... and {len(files)-20} more')
