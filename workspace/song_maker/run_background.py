"""后台运行脚本 - 下载模型并生成音乐"""
import sys
import os

# 重定向输出到文件
log_file = os.path.join(os.path.dirname(__file__), 'output', 'generation_log.txt')
sys.stdout = open(log_file, 'w', encoding='utf-8')
sys.stderr = sys.stdout

# 运行生成
from generate_song_final import generate_musicgen, check_gpu

try:
    device = check_gpu()
    print(f"Device: {device}")
    
    result = generate_musicgen(
        description="upbeat pop music with piano and light drums, catchy melody",
        duration=15,
        output_path="output/test_song.wav",
        device=device
    )
    print(f"\n✅ 完成！文件: {result}")
except Exception as e:
    print(f"\n❌ 失败: {e}")
    import traceback
    traceback.print_exc()
