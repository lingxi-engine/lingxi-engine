import os
import sys
sys.stdout.reconfigure(encoding='utf-8')
for root, dirs, files in os.walk('E:'):
    for f in files:
        if f.endswith('.docx') or f.endswith('.doc'):
            full = os.path.join(root, f)
            print(repr(full))
