import os
d = 'E:/文档文件夹'
files = [f for f in os.listdir(d) if f.endswith('.docx')]
for f in files:
    fp = os.path.join(d, f)
    size = os.path.getsize(fp)
    print(f + '  (' + str(size // 1024) + 'KB)')
print('Total files: ' + str(len(files)))
