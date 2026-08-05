import os
import sys
sys.stdout.reconfigure(encoding='utf-8')
items = os.listdir('E:/灵犀引擎')
for item in items:
    print(repr(item))
