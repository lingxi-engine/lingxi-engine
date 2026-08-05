import os
for root, dirs, files in os.walk('E:'):
    for f in files:
        if f.endswith('.docx'):
            full = os.path.join(root, f)
            print(full)
