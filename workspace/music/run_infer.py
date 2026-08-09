import subprocess, sys, os
base = r'C:\Users\Administrator\lingxi-engine\diffrhythm-local'
cmd = [
    sys.executable, os.path.join(base, 'infer', 'infer.py'),
    '--lrc-path', r'C:\Users\Administrator\lingxi-engine\workspace\music\lyrics.lrc',
    '--ref-prompt', 'Pop, Uplifting, Hopeful, Piano, Acoustic Guitar, Strings, Drums, Bass, Emotional',
    '--audio-length', '95',
    '--output-dir', r'C:\Users\Administrator\lingxi-engine\workspace\music\output',
]
print('RUN:', ' '.join(cmd))
proc = subprocess.run(cmd, cwd=base, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=1500)
print('STDOUT:\n', proc.stdout[-8000:])
print('STDERR:\n', proc.stderr[-8000:])
print('EXIT:', proc.returncode)
