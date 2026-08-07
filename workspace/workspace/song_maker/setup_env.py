# -*- coding: utf-8 -*-
"""安装缺失依赖 + 设置 espeak-ng 环境变量"""
import os
import subprocess
import sys

def pip_install(packages):
    """pip 安装包"""
    cmd = [sys.executable, '-m', 'pip', 'install']
    cmd.extend(packages)
    print(f'>>> {" ".join(cmd)}')
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    print(r.stdout[-2000:] if r.stdout else '')
    if r.returncode != 0:
        print(f'[ERR] {r.stderr[-1500:]}')
    return r.returncode == 0

def main():
    # 1. 设置 espeak-ng 环境变量（当前会话 + 持久化）
    espeak_dir = r'C:\Program Files\eSpeak NG'
    env_vars = {
        'PHONEMIZER_ESPEAK_LIBRARY': os.path.join(espeak_dir, 'libespeak-ng.dll'),
        'PHONEMIZER_ESPEAK_PATH': espeak_dir,
    }
    for k, v in env_vars.items():
        os.environ[k] = v
        print(f'[ENV] {k} = {v}')
    
    # 持久化（用户级）
    for k, v in env_vars.items():
        subprocess.run(['setx', k, v], capture_output=True, timeout=30)
        print(f'[SETX] {k} 已持久化')
    
    # 2. 安装缺失包
    missing = ['pyarrow', 'pylance', 'onnxruntime', 'Unidecode']
    print(f'\n安装缺失包: {missing}')
    ok = pip_install(missing)
    
    # 3. 验证
    print('\n=== 验证 ===')
    for pkg in missing:
        try:
            __import__(pkg)
            print(f'  [OK] {pkg}')
        except ImportError as e:
            print(f'  [FAIL] {pkg}: {e}')
            ok = False
    
    # 验证 phonemizer 能初始化 espeak backend
    try:
        from phonemizer.backend import EspeakBackend
        backend = EspeakBackend('cmn', language_switch='remove_blank')
        print('  [OK] phonemizer EspeakBackend(中文) 初始化成功')
    except Exception as e:
        print(f'  [WARN] phonemizer 中文初始化: {e}')
    
    print(f'\n结果: {"全部成功" if ok else "部分失败"}')

if __name__ == '__main__':
    main()
