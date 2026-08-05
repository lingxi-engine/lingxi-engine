import subprocess, sys
result = subprocess.run([sys.executable, '-c', 'import docx; print("python-docx OK")'], capture_output=True, text=True)
if result.returncode == 0:
    print("python-docx 已安装 -", result.stdout.strip())
else:
    print("python-docx 未安装")
    print("stderr:", result.stderr)
