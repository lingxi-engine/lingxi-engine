import os
d = 'E:/文档文件夹'
for f in os.listdir(d):
    if f.endswith('.docx'):
        fp = os.path.join(d, f)
        size = os.path.getsize(fp)
        print(f'{f}  ({size//1024}KB)')
print('---')
print(f'文件总数: {len([x for x in os.listdir(d) if x.endswith(\".docx\")])}')
