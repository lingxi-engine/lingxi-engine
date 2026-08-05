from docx import Document

# 创建一个简单的文档来测试
doc = Document()
doc.add_heading('这是一个测试文档')
doc.add_paragraph('这用于验证 python-docx 是否可以正常读取和写入。', style='Normal')

doc.save(r'C:\Users\Administrator\lingxi-engine\workspace\test.docx')
print(f'✓ 成功创建并保存了文件：{r"C:\\Users\\Administrator\\lingxi-engine\\workspace\\test.docx"}')

# 现在尝试读取它
try:
    doc_read = Document(r'C:\Users\Administrator\lingxi-engine\workspace\test.docx')
    print(f'✓ 成功读取文档，包含段落数：{len(doc_read.paragraphs)}')
except Exception as e:
    print(f'✗ 读取失败：{e}')
