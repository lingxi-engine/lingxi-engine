@echo off
echo === 检查 TTS 依赖 ===
python -c "import pyttsx3; print('pyttsx3: OK')" 2>&1
python -c "import edge_tts; print('edge_tts: OK')" 2>&1
python -c "import subprocess; subprocess.run(['where','sapi'],capture_output=True); print('done')" 2>&1
pip list 2>nul | findstr /i "tts pyttsx edge.comm SAPI"
echo === DONE ===
