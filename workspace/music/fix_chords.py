# 和弦序列修复
D  = (50, [62,66,69]); A  = (45, [57,61,64]); Bm = (47, [59,62,66]); G  = (43, [55,59,62])
Em = (40, [52,55,59]); A7 = (45, [57,61,64,67]); Fsm = (42, [54,57,61])

chords = []
# 前奏4
chords += [D, A, Bm, G]
# 主歌1 8
chords += [D, D, G, G, D, D, A, A]
# 预副歌1 4
chords += [Bm, Bm, G, G]
# 副歌1 8
chords += [A, A, Bm, Bm, G, G, A, A]
# 间奏4
chords += [D, A, Bm, G]
# 主歌2 8
chords += [D, D, G, G, D, D, A, A]
# 预副歌2 4
chords += [Bm, Bm, G, G]
# 副歌2 8
chords += [A, A, Bm, Bm, G, G, A, A]
# 桥段8
chords += [Bm, Bm, G, G, Em, Em, A, A]
# Solo 8
chords += [D, D, G, G, D, D, A, A]
# 副歌3（升调高潮）8
chords += [Bm, Bm, G, G, A, A7, D, D]
# 尾奏8
chords += [D, D, G, G, D, D, D, D]

print(f"和弦数: {len(chords)}, 应为80: {'OK' if len(chords)==80 else 'FAIL'}")
