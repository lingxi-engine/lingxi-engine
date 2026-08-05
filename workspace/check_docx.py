import subprocess, sys
result = subprocess.run([sys.executable, '-m', 'pip', 'list', '--format=columns'], capture_output=True, text=True, encoding='utf-8')
print(result.stdout)
if 'python-docx' in result.stdout:
    print("python-docx 已安装")
else:
    print("python-docx 未安装")
