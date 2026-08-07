"""快速测试脚本"""
import sys
sys.path.insert(0, '.')
from generate_song_final import generate_musicgen, check_gpu

device = check_gpu()
print(f"Device: {device}")

result = generate_musicgen(
    description="upbeat pop music with piano and light drums",
    duration=15,
    output_path="output/test_song.wav",
    device=device
)
print(f"Result: {result}")
