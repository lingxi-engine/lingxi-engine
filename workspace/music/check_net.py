import os, time
base = r'C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained\models--OpenMuQ--MuQ-MuLan-large'
blobs = os.path.join(base, 'blobs')
if os.path.isdir(blobs):
    for f in os.listdir(blobs):
        p = os.path.join(blobs, f)
        print('MUQ', f[:30], os.path.getsize(p), 'incomplete' if f.endswith('.incomplete') else '')
# any new lock files
locks = os.path.join(base, '.locks')
if os.path.isdir(locks):
    print('LOCKS:', os.listdir(locks))
import socket
try:
    socket.setdefaulttimeout(8)
    s = socket.create_connection(('huggingface.co', 443))
    print('NET huggingface.co: REACHABLE')
    s.close()
except Exception as e:
    print('NET huggingface.co: FAIL', e)
try:
    s = socket.create_connection(('cdn-lfs.huggingface.co', 443))
    print('NET cdn-lfs: REACHABLE')
    s.close()
except Exception as e:
    print('NET cdn-lfs: FAIL', e)
