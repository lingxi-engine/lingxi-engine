import os
import sys
sys.stdout.reconfigure(encoding='utf-8')
items = os.listdir('E:')
for item in items:
    print(repr(item))
