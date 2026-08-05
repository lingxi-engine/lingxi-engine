#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修改灵犀引擎两个文档并标记页数"""

import os
import re
import sys
sys.stdout.reconfigure(encoding='utf-8')

from docx import Document
from docx.shared import Pt, Inches, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.section import WD_ORIENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import copy

SRC_DIR = 'E:/灵犀引擎'
DST_DIR = 'E:/文档文件夹'

# ============ 工具函数 ============

def add_page_number(doc):
    """为文档添加页码"""
    for section in doc.sections:
        footer = section.footer
        footer.is_linked_to_previous = False
        p = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run()
        fldChar1 = OxmlElement('w:fldChar')
        fldChar1.set(qn('w:fldCharType'), 'begin')
        run._r.append(fldChar1)
        run2 = p.add_run()
        instrText = OxmlElement('w:instrText')
        instrText.set(qn('xml:space'), 'preserve')
        instrText.text = ' PAGE '
        run2._r.append(instrText)
        run3 = p.add_run()
        fldChar2 = OxmlElement('w:fldChar')
        fldChar2.set(qn('w:fldCharType'), 'end')
        run3._r.append(fldChar2)
        run4 = p.add_run(' / ')
        run5 = p.add_run()
        fldChar3 = OxmlElement('w:fldChar')
        fldChar3.set(qn('w:fldCharType'), 'begin')
        run5._r.append(fldChar3)
        run6 = p.add_run()
        instrText2 = OxmlElement('w:instrText')
        instrText2.set(qn('xml:space'), 'preserve')
        instrText2.text = ' NUMPAGES '
        run6._r.append(instrText2)
        run7 = p.add_run()
        fldChar4 = OxmlElement('w:fldChar')
        fldChar4.set(qn('w:fldCharType'), 'end')
        run7._r.append(fldChar4)

def add_cover_page(doc, title, subtitle, version, date_str):
    """添加封面页"""
    section = doc.sections[0]
    # 在文档最前面插入封面
    paragraphs = []
    # 创建新的段落结构
    old_body = doc.element.body
    # 清除原有内容（我们会重新构建）
    
    # 添加封面标题
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run('\n\n\n\n\n')
    run.font.size = Pt(14)
    
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(title)
    run.font.size = Pt(26)
    run.bold = True
    run.font.color.rgb = RGBColor(0x1A, 0x56, 0xDB)
    
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(subtitle)
    run.font.size = Pt(18)
    run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
    
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run('\n\n')
    
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f'版本：{version}')
    run.font.size = Pt(14)
    
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f'日期：{date_str}')
    run.font.size = Pt(14)
    
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run('\n\n\n\n')
    
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run('【内部技术文档·修改版】')
    run.font.size = Pt(12)
    run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)
    
    doc.add_page_break()

def replace_in_all_paragraphs(doc, old_text, new_text):
    """替换文档中所有段落的文本"""
    for paragraph in doc.paragraphs:
        if old_text in paragraph.text:
            for run in paragraph.runs:
                if old_text in run.text:
                    run.text = run.text.replace(old_text, new_text)
    
    # 也替换表格中的文本
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    if old_text in paragraph.text:
                        for run in paragraph.runs:
                            if old_text in run.text:
                                run.text = run.text.replace(old_text, new_text)

def replace_regex_in_paragraphs(doc, pattern, replacement):
    """用正则替换文档中所有段落的文本"""
    compiled = re.compile(pattern)
    for paragraph in doc.paragraphs:
        text = paragraph.text
        if compiled.search(text):
            for run in paragraph.runs:
                if compiled.search(run.text):
                    run.text = re.sub(pattern, replacement, run.text)
    
    for table in doc.tables:
        for row in table.rows:
            for cell in cell_paragraphs(table):
                text = cell.text
                if compiled.search(text):
                    for p in cell.paragraphs:
                        for run in p.runs:
                            if compiled.search(run.text):
                                run.text = re.sub(pattern, replacement, run.text)

def cell_paragraphs(table):
    """遍历表格所有单元格"""
    for row in table.rows:
        for cell in row.cells:
            yield cell

# ============ 修改技术文档 ============

def fix_tech_doc():
    print("=" * 50)
    print("正在修改：灵犀引擎完整技术文档")
    
    src = os.path.join(SRC_DIR, '灵犀引擎完整技术文档.docx')
    dst = os.path.join(DST_DIR, '灵犀引擎完整技术文档（修改版）.docx')
    
    if not os.path.exists(src):
        print(f"❌ 源文件不存在: {src}")
        return False
    
    doc = Document(src)
    
    # 修改1：V5 状态
    count1 = 0
    for p in doc.paragraphs:
        if 'V5 灵犀 App + 个人 Agent' in p.text and ('开发中' in p.text or '0%' in p.text):
            for r in p.runs:
                if '开发中' in r.text or '0%' in r.text:
                    r.text = r.text.replace('🔥 开发中', '✅ 已完成')
                    r.text = r.text.replace('0%', '100%')
                    count1 += 1
    
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    if 'V5 灵犀 App + 个人 Agent' in p.text:
                        for r in p.runs:
                            if '开发中' in r.text:
                                r.text = r.text.replace('🔥 开发中', '✅ 已完成')
                                count1 += 1
                            if '0%' in r.text:
                                r.text = r.text.replace('0%', '100%')
                                count1 += 1
    
    print(f"  ✅ V5状态修正: {count1}处")
    
    # 修改2：替换本地路径
    path_patterns = [
        (r'C:\\Users\\Administrator\\Desktop\\', '{project-root}/'),
        (r'/c/Users/Administrator/Desktop/', '{project-root}/'),
        (r'C:/Users/Administrator/Desktop/', '{project-root}/'),
    ]
    path_count = 0
    for p in doc.paragraphs:
        for old, new in path_patterns:
            if old in p.text:
                for r in p.runs:
                    if old in r.text:
                        r.text = r.text.replace(old, new)
                        path_count += 1
    
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    for old, new in path_patterns:
                        if old in p.text:
                            for r in p.runs:
                                if old in r.text:
                                    r.text = r.text.replace(old, new)
                                    path_count += 1
    print(f"  ✅ 本地路径替换: {path_count}处")
    
    # 修改3：测试验证码
    code_count = 0
    for p in doc.paragraphs:
        if '"code": "123456"' in p.text:
            for r in p.runs:
                if '"code": "123456"' in r.text:
                    r.text = r.text.replace('"code": "123456"', '"code": "（实际发送至邮箱）"')
                    code_count += 1
        if r'code\": \"123456' in p.text:
            for r in p.runs:
                if r'code\": \"123456' in r.text:
                    r.text = r.text.replace(r'code\": \"123456', 'code\": \"（实际发送至邮箱）')
                    code_count += 1
    print(f"  ✅ 测试验证码修正: {code_count}处")
    
    # 修改4：版本号统一
    ver_count = 0
    for p in doc.paragraphs:
        if 'v2.2.3' in p.text and 'friendfix' not in p.text:
            # 只在标题和版本标注处修改，但不改所有v2.2.3引用
            for r in p.runs:
                if r.text.strip() == 'v2.2.3' and len(p.text) < 100:
                    r.text = 'v2.2.3-friendfix3'
                    ver_count += 1
    
    # 部署信息中的版本
    for table in doc.tables:
        for row in table.rows:
            cells_text = [cell.text for cell in row.cells]
            if '最新版本' in cells_text or '当前版本' in cells_text:
                for cell in row.cells:
                    if 'v2.2.3' in cell.text and 'friendfix' not in cell.text:
                        for p in cell.paragraphs:
                            for r in p.runs:
                                if r.text.strip() == 'v2.2.3':
                                    r.text = 'v2.2.3-friendfix3'
                                    ver_count += 1
    print(f"  ✅ 版本号统一: {ver_count}处")
    
    # 修改5：脱敏部署信息
    sens_count = 0
    sens_patterns = [
        ('47.93.157.83', '[服务器IP已脱敏]'),
        ('root@47.93.157.83', 'user@[服务器IP已脱敏]'),
        ('~/.ssh/lingxi_deploy', '[密钥路径已脱敏]'),
        ('ssh root@47.93.157.83', 'ssh user@[服务器IP已脱敏]'),
    ]
    for p in doc.paragraphs:
        for old, new in sens_patterns:
            if old in p.text:
                for r in p.runs:
                    if old in r.text:
                        r.text = r.text.replace(old, new)
                        sens_count += 1
    
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    for old, new in sens_patterns:
                        if old in p.text:
                            for r in p.runs:
                                if old in r.text:
                                    r.text = r.text.replace(old, new)
                                    sens_count += 1
    print(f"  ✅ 敏感信息脱敏: {sens_count}处")
    
    # 添加页码
    add_page_number(doc)
    
    # 保存
    os.makedirs(DST_DIR, exist_ok=True)
    doc.save(dst)
    print(f"  ✅ 已保存至: {dst}")
    
    # 统计页数（通过段落数估算，docx无法直接获取页数）
    total_para = len(doc.paragraphs)
    total_table = len(doc.tables)
    print(f"  📄 段落数: {total_para}, 表格数: {total_table}（打印时自动分页）")
    
    return True

# ============ 修改申报书 ============

def fix_app_doc():
    print("=" * 50)
    print("正在修改：灵犀引擎-政府扶持政策申报书")
    
    src = os.path.join(SRC_DIR, '灵犀引擎-政府扶持政策申报书.docx')
    dst = os.path.join(DST_DIR, '灵犀引擎-政府扶持政策申报书（修改版）.docx')
    
    if not os.path.exists(src):
        print(f"❌ 源文件不存在: {src}")
        return False
    
    doc = Document(src)
    
    # 修改1：软著时间
    sw_count = 0
    for p in doc.paragraphs:
        if '拟于 2026 年 Q3 提交申请' in p.text:
            for r in p.runs:
                if '拟于 2026 年 Q3 提交申请' in r.text:
                    r.text = r.text.replace('拟于 2026 年 Q3 提交申请', '已于 2026 年 7 月启动软著登记流程')
                    sw_count += 1
    print(f"  ✅ 软著时间更新: {sw_count}处")
    
    # 修改2：专利名称
    patent_count = 0
    for p in doc.paragraphs:
        if '拟申请发明专利' in p.text and '具体名称' not in p.text:
            for r in p.runs:
                if '拟申请发明专利' in r.text and '具体名称' not in r.text:
                    r.text = r.text.replace('拟申请发明专利', '拟申请发明专利——"一种多智能体协同编排方法与系统"')
                    patent_count += 1
    print(f"  ✅ 专利名称补充: {patent_count}处")
    
    # 修改3：经费范围明确
    fund_count = 0
    for p in doc.paragraphs:
        if '100-168 万元' in p.text:
            for r in p.runs:
                if '100-168 万元' in r.text:
                    r.text = r.text.replace('100-168 万元', '150 万元（占项目总预算 168 万元的 89.3%）')
                    fund_count += 1
    print(f"  ✅ 经费范围明确: {fund_count}处")
    
    # 修改4：附件清单第9项
    attach_count = 0
    for p in doc.paragraphs:
        if '多平台适配说明' in p.text:
            for r in p.runs:
                if '多平台适配说明（Win/Linux，iOS 规划）' in r.text:
                    r.text = r.text.replace('多平台适配说明（Win/Linux，iOS 规划）', '多平台架构说明（详见技术文档第二章）')
                    attach_count += 1
    print(f"  ✅ 附件清单修正: {attach_count}处")
    
    # 修改5：年份格式统一
    date_count = 0
    for p in doc.paragraphs:
        for r in p.runs:
            # "2026.07" → "2026年7月"
            if re.search(r'2026\.\d{2}', r.text):
                r.text = re.sub(r'2026\.(\d{2})', lambda m: f'2026年{int(m.group(1))}月', r.text)
                date_count += 1
    print(f"  ✅ 日期格式统一: {date_count}处")
    
    # 修改6：公网IP脱敏
    ip_count = 0
    for p in doc.paragraphs:
        if '47.93.157.83' in p.text:
            for r in p.runs:
                if '47.93.157.83' in r.text:
                    r.text = r.text.replace('47.93.157.83', '[服务器IP]')
                    ip_count += 1
    print(f"  ✅ 公网IP脱敏: {ip_count}处")
    
    # 修改7：安装命令脱敏
    cmd_count = 0
    for p in doc.paragraphs:
        if 'install.ps1' in p.text or 'install.sh' in p.text:
            for r in p.runs:
                if '47.93.157.83' in r.text:
                    r.text = r.text.replace('47.93.157.83', '[服务器域名]')
                    cmd_count += 1
    print(f"  ✅ 安装命令脱敏: {cmd_count}处")
    
    # 修改8：邮箱标注待替换
    email_count = 0
    for p in doc.paragraphs:
        if 'a15176430440@163.com' in p.text:
            for r in p.runs:
                if 'a15176430440@163.com' in r.text:
                    r.text = r.text.replace('a15176430440@163.com', '[请填写正式企业邮箱]')
                    email_count += 1
    print(f"  ✅ 邮箱标注替换: {email_count}处")
    
    # 修改9：硬件型号备注说明
    for p in doc.paragraphs:
        if 'Intel 395+' in p.text or 'Intel 395+' in p.text:
            for r in p.runs:
                if 'Intel 395+' in r.text:
                    text = r.text
                    # 在部分位置添加注释说明
                    if '适配' in r.text or '395+' in r.text:
                        pass  # 保持原文，因为用户说这是正确的
                        
    # 添加页码
    add_page_number(doc)
    
    # 保存
    os.makedirs(DST_DIR, exist_ok=True)
    doc.save(dst)
    print(f"  ✅ 已保存至: {dst}")
    
    total_para = len(doc.paragraphs)
    total_table = len(doc.tables)
    print(f"  📄 段落数: {total_para}, 表格数: {total_table}（打印时自动分页）")
    
    return True

# ============ 主流程 ============

if __name__ == '__main__':
    print("灵犀引擎文档自动修改工具")
    print("=" * 50)
    
    os.makedirs(DST_DIR, exist_ok=True)
    
    ok1 = fix_tech_doc()
    ok2 = fix_app_doc()
    
    print("=" * 50)
    if ok1 and ok2:
        print("✅ 全部修改完成！")
        print(f"📁 文件目录: {DST_DIR}")
        print("  ├ 灵犀引擎完整技术文档（修改版）.docx")
        print("  └ 灵犀引擎-政府扶持政策申报书（修改版）.docx")
        print("📄 两个文档均已添加页码（页脚），打印时自动显示")
    else:
        print("❌ 部分文件修改失败")
