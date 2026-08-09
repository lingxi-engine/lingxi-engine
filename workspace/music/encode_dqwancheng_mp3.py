# -*- coding: utf-8 -*-
"""将 daqiwancheng.wav 编码为 MP3 + 写入 ID3 标签"""
import struct, os

wav_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'daqiwancheng.wav')
mp3_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'daqiwancheng.mp3')

# 读取 WAV
with open(wav_path, 'rb') as f:
    data = f.read()

# 验证 WAV
assert data[:4] == b'RIFF', "不是 WAV 文件"
assert data[8:12] == b'WAVE', "不是 WAVE 格式"
print(f"WAV 大小: {len(data):,} 字节")

# 尝试 lameenc
try:
    import lameenc
    print("使用 lameenc 编码 MP3...")
    
    # 解析 WAV 格式
    fmt_offset = data.find(b'fmt ')
    audio_format = struct.unpack_from('<H', data, fmt_offset + 8)[0]
    channels = struct.unpack_from('<H', data, fmt_offset + 10)[0]
    sample_rate = struct.unpack_from('<I', data, fmt_offset + 12)[0]
    bits_per_sample = struct.unpack_from('<H', data, fmt_offset + 22)[0]
    
    data_offset = data.find(b'data') + 8
    data_size = struct.unpack_from('<I', data, data_offset - 4)[0]
    pcm = data[data_offset:data_offset + data_size]
    
    print(f"格式: {sample_rate}Hz / {channels}ch / {bits_per_sample}bit")
    
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(192)
    encoder.set_in_sample_rate(sample_rate)
    encoder.set_channels(channels)
    encoder.set_quality(2)
    
    mp3_data = encoder.encode(pcm)
    mp3_data += encoder.flush()
    
    # 写入 ID3v2 标签
    title = "大器晚成".encode('utf-16')
    artist = "AI Composer".encode('utf-16')
    album = "AI Music".encode('utf-16')
    
    # ID3v2.3 header
    id3_header = b'ID3' + b'\x03\x00' + b'\x00'
    
    # TIT2 frame (Title)
    def make_frame(frame_id, text):
        text_bytes = b'\xFF\xFE' + text  # UTF-16LE BOM + text
        frame_size = len(text_bytes)
        frame = frame_id.encode('ascii') + struct.pack('>I', frame_size) + b'\x00\x00' + text_bytes
        return frame
    
    frames = b''
    frames += make_frame('TIT2', "大器晚成".encode('utf-16-le'))
    frames += make_frame('TPE1', "AI Composer".encode('utf-16-le'))
    frames += make_frame('TALB', "AI Music".encode('utf-16-le'))
    
    # Calculate syncsafe size
    total_size = len(frames)
    syncsafe = bytes([
        (total_size >> 21) & 0x7F,
        (total_size >> 14) & 0x7F,
        (total_size >> 7) & 0x7F,
        total_size & 0x7F
    ])
    
    id3 = id3_header + syncsafe + frames
    
    with open(mp3_path, 'wb') as f:
        f.write(id3)
        f.write(mp3_data)
    
    mp3_size = os.path.getsize(mp3_path)
    print(f"MP3 输出: {mp3_path}")
    print(f"MP3 大小: {mp3_size:,} 字节 ({mp3_size/1024/1024:.2f} MB)")
    print(f"MP3 时长: ~{len(mp3_data) * 8 / 192000:.1f} 秒")
    print("编码完成!")

except ImportError:
    print("lameenc 不可用，尝试 pydub...")
    try:
        from pydub import AudioSegment
        audio = AudioSegment.from_wav(wav_path)
        audio.export(mp3_path, format='mp3', bitrate='192k', 
                     tags={'title': '大器晚成', 'artist': 'AI Composer', 'album': 'AI Music'})
        print(f"MP3 输出: {mp3_path}")
        print(f"MP3 大小: {os.path.getsize(mp3_path):,} 字节")
    except Exception as e:
        print(f"pydub 也失败: {e}")
        print("请安装 ffmpeg 或 lameenc: pip install lameenc")