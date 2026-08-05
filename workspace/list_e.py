import os
items = os.listdir('E:')
for item in items:
    if not item.startswith('System'):
        print(item)
