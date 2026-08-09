import subprocess, sys, os, time
base = r'C:\Users\Administrator\lingxi-engine\diffrhythm-local'
log = r'C:\Users\Administrator\lingxi-engine\workspace\music\infer_log.txt'
cmd = [
    sys.executable, os.path.join(base, 'infer', 'infer.py'),
    '--lrc-path', r'C:\Users\Administrator\lingxi-engine\workspace\music\lyrics.lrc',
    '--ref-prompt', 'Pop, Uplifting, Hopeful, Piano, Acoustic Guitar, Strings, Drums, Bass, Emotional',
    '--audio-length', '95',
    '--output-dir', r'C:\Users\Administrator\lingxi-engine\workspace\music\output',
]
with open(log, 'w', encoding='utf-8') as f:
    f.write('START ' + time.strftime('%H:%M:%S') + '\n')
    f.flush()
    try:
        proc = subprocess.run(cmd, cwd=base, stdout=f, stderr=subprocess.STDOUT, timeout=5400)
        f.write('EXIT ' + str(proc.returncode) + '\n')
    except Exception as e:
        f.write('ERROR ' + repr(e) + '\n')
