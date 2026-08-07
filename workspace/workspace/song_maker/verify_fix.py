# -*- coding: utf-8 -*-
"""语法与环境验证脚本"""
import ast
import sys

def main():
    # 1. 语法检查
    path = r'C:\Users\Administrator\lingxi-engine\workspace\workspace\song_maker\generate_song_final.py'
    with open(path, encoding='utf-8') as f:
        source = f.read()
    ast.parse(source)
    print('[OK] 语法检查通过: generate_song_final.py')
    
    # 2. 导入测试（不触发模型加载）
    sys.path.insert(0, r'C:\Users\Administrator\lingxi-engine\workspace\workspace\song_maker')
    
    # 3. torch 检查
    try:
        import torch
        print('[OK] torch', torch.__version__)
        print('[OK] CUDA available:', torch.cuda.is_available())
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            # 验证 total_memory 属性存在
            mem = props.total_memory / 1024**3
            print('[OK] GPU:', torch.cuda.get_device_name(0))
            print('[OK] 显存: {:.1f}GB'.format(mem))
    except ImportError as e:
        print('[WARN] torch 未安装:', e)
    except Exception as e:
        print('[WARN] torch 检查异常:', e)
    
    # 4. 依赖检查
    deps = ['transformers', 'soundfile', 'numpy', 'scipy']
    for dep in deps:
        try:
            __import__(dep)
            print('[OK] 依赖 {} 可用'.format(dep))
        except ImportError:
            print('[MISS] 依赖 {} 未安装'.format(dep))
    
    print('\n=== 验证完成 ===')

if __name__ == '__main__':
    main()
