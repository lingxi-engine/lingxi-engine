# -*- coding: utf-8 -*-
"""修复 song.py 中 build_drums 参数格式不匹配的问题"""
path = r"C:\Users\Administrator\lingxi-engine\workspace\music\song.py"
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

old = """def build_drums(section_map):
    \"\"\"section_map: 小节范围 -> 强度(0轻 1重)\"\"\"
    drums = make_bus()
    for (b0, b1), level in section_map:"""

new = """def build_drums(section_map):
    \"\"\"section_map: (起始小节, 结束小节, 强度) 或 ((起始, 结束), 强度)\"\"\"
    drums = make_bus()
    for item in section_map:
        if len(item) == 3:
            b0, b1, level = item
        else:
            (b0, b1), level = item"""

assert old in src, "未找到目标代码段"
src = src.replace(old, new)

with open(path, "w", encoding="utf-8") as f:
    f.write(src)
print("PATCH OK")
