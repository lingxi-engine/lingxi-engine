import muq, os
print("muq module:", muq.__file__)
pkg_dir = os.path.dirname(muq.__file__)
print("pkg dir:", pkg_dir)
for root, dirs, files in os.walk(pkg_dir):
    for f in files:
        if f.endswith(".py"):
            print(os.path.join(root, f))
