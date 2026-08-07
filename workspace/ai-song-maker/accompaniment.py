"""
伴奏生成模块 - 使用 MusicGen 生成器乐伴奏
支持 facebook/musicgen-small (300M, ~3GB VRAM) 和 musicgen-medium (1.5B, ~5GB VRAM)
"""
import torch
import numpy as np
import soundfile as sf
from pathlib import Path
from typing import Optional
import time


class AccompanimentGenerator:
    """MusicGen 伴奏生成器"""

    def __init__(self, model_id: str = "facebook/musicgen-small",
                 device: str = "cuda"):
        """
        Args:
            model_id: MusicGen 模型 ID
                - "facebook/musicgen-small"  (300M, ~3GB VRAM, 速度快)
                - "facebook/musicgen-medium" (1.5B, ~5GB VRAM, 质量更好)
            device: cuda / cpu
        """
        self.model_id = model_id
        self.device = device
        self.model = None

    def load_model(self):
        """加载 MusicGen 模型"""
        print(f"[Accompaniment] Loading model: {self.model_id}")
        from audiocraft.models import MusicGen

        self.model = MusicGen.get_pretrained(self.model_id)
        self.model.set_generation_params(
            duration=30,  # 默认30秒
            use_sampling=True,
            top_k=250,
        )
        print("[Accompaniment] Model loaded successfully")

    def generate(self, prompt: str, duration: float = 30.0,
                 bpm: Optional[int] = None,
                 melody_audio: Optional[np.ndarray] = None,
                 sample_rate: int = 32000) -> dict:
        """
        生成伴奏音频

        Args:
            prompt: 风格描述，如 "Chinese pop ballad, piano, soft drums, emotional"
            duration: 生成时长（秒），最长30秒
            bpm: 节拍速度（可选）
            melody_audio: 旋律音频（可选，用于 melody 模式）
            sample_rate: 采样率

        Returns:
            dict: {
                "audio": numpy array (channels, samples),
                "sample_rate": int,
                "duration": float,
                "prompt": str
            }
        """
        if self.model is None:
            self.load_model()

        duration = min(duration, 30.0)  # MusicGen 单次最长30秒
        self.model.set_generation_params(duration=duration)

        print(f"[Accompaniment] Generating {duration}s audio for: {prompt}")
        start_time = time.time()

        if melody_audio is not None:
            # melody 模式：基于旋律生成伴奏
            melody_tensor = torch.from_numpy(melody_audio).float().unsqueeze(0)
            if melody_tensor.dim() == 2:
                melody_tensor = melody_tensor.unsqueeze(0)  # add batch dim

            wav = self.model.generate_with_chroma(
                descriptions=[prompt],
                melody_wavs=melody_tensor,
                melody_sample_rate=sample_rate,
                progress=True,
            )
        else:
            # 纯文本生成模式
            wav = self.model.generate(
                descriptions=[prompt],
                progress=True,
            )

        elapsed = time.time() - start_time
        print(f"[Accompaniment] Generated in {elapsed:.1f}s")

        # 转换为 numpy
        audio = wav[0].cpu().numpy()  # shape: (channels, samples)

        return {
            "audio": audio,
            "sample_rate": self.model.sample_rate,
            "duration": duration,
            "prompt": prompt,
            "generation_time": elapsed,
        }

    def generate_full_song(self, prompt: str, total_duration: float = 180.0,
                           overlap: float = 5.0) -> dict:
        """
        生成完整歌曲长度的伴奏（多次生成 + 拼接）

        Args:
            prompt: 风格描述
            total_duration: 总时长（秒）
            overlap: 片段重叠（秒）

        Returns:
            dict: 同 generate()
        """
        if self.model is None:
            self.load_model()

        chunk_duration = 30.0
        step = chunk_duration - overlap
        chunks = []
        position = 0.0

        print(f"[Accompaniment] Generating full song: {total_duration}s")

        while position < total_duration:
            remaining = total_duration - position
            current_duration = min(chunk_duration, remaining + overlap)

            print(f"  Generating chunk at {position:.0f}s - {position + current_duration:.0f}s")
            result = self.generate(prompt, duration=current_duration)
            chunks.append(result["audio"])

            position += step

        # 拼接音频片段（使用交叉淡入淡出）
        full_audio = self._crossfade_concat(chunks, overlap,
                                             self.model.sample_rate)

        # 裁剪到目标时长
        max_samples = int(total_duration * self.model.sample_rate)
        full_audio = full_audio[:, :max_samples]

        return {
            "audio": full_audio,
            "sample_rate": self.model.sample_rate,
            "duration": total_duration,
            "prompt": prompt,
        }

    def _crossfade_concat(self, chunks: list, overlap_sec: float,
                          sample_rate: int) -> np.ndarray:
        """交叉淡入淡出拼接音频片段"""
        if not chunks:
            return np.array([])

        overlap_samples = int(overlap_sec * sample_rate)
        result = chunks[0]

        for i in range(1, len(chunks)):
            chunk = chunks[i]

            if overlap_samples > 0 and result.shape[-1] >= overlap_samples:
                # 创建淡入淡出曲线
                fade_out = np.linspace(1.0, 0.0, overlap_samples)
                fade_in = np.linspace(0.0, 1.0, overlap_samples)

                # 应用到所有通道
                if result.ndim == 2:
                    fade_out = fade_out[np.newaxis, :]
                    fade_in = fade_in[np.newaxis, :]

                # 重叠部分混合
                overlap_region = (result[:, -overlap_samples:] * fade_out +
                                  chunk[:, :overlap_samples] * fade_in)

                result = np.concatenate([
                    result[:, :-overlap_samples],
                    overlap_region,
                    chunk[:, overlap_samples:]
                ], axis=-1)
            else:
                result = np.concatenate([result, chunk], axis=-1)

        return result


# 便捷函数
def generate_accompaniment(prompt: str, duration: float = 30.0,
                           model_size: str = "small") -> dict:
    """
    快速生成伴奏

    Example:
        result = generate_accompaniment("Chinese pop ballad, piano, emotional", 30)
        sf.write("accompaniment.wav", result["audio"].T, result["sample_rate"])
    """
    model_id = f"facebook/musicgen-{model_size}"
    gen = AccompanimentGenerator(model_id=model_id)
    gen.load_model()
    return gen.generate(prompt, duration=duration)


def style_prompt_for_chinese_pop(mood: str = "emotional",
                                  instruments: str = "piano, acoustic guitar") -> str:
    """生成适合中文流行歌的 MusicGen 提示词"""
    return (f"Chinese pop ballad, {mood}, {instruments}, "
            f"soft drums, warm bass, 4/4 time signature, "
            f"melodic, professional production, studio quality")


if __name__ == "__main__":
    print("Testing accompaniment generation...")
    prompt = style_prompt_for_chinese_pop("melancholic", "piano, strings")
    result = generate_accompaniment(prompt, duration=15, model_size="small")

    output_path = Path(__file__).parent / "output" / "test_accompaniment.wav"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output_path), result["audio"].T, result["sample_rate"])
    print(f"Saved to: {output_path}")
