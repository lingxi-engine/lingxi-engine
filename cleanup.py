import shutil, os
target = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'DiffRhythm')
print(f"Target: {target}")
print(f"Exists: {os.path.exists(target)}")
if os.path.exists(target):
    shutil.rmtree(target, ignore_errors=True)
    print(f"Removed: {not os.path.exists(target)}")
else:
    print("Not found")
