/**
 * 语音合成 - Text to Speech (TTS)
 * 支持多种 TTS 后端：OpenAI TTS, Edge TTS
 */
import { execFile } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface TTSResult {
  ok: boolean;
  audioBase64?: string;
  mimeType?: string;
  duration?: number;
  error?: string;
}

export type TTSProvider = 'openai' | 'edge' | 'none';

export class TTSManager {
  private provider: TTSProvider;
  private openaiKey?: string;
  private openaiVoice: string;
  private edgeVoice: string;

  constructor() {
    this.provider = (process.env.TTS_PROVIDER as TTSProvider) || 'none';
    this.openaiKey = process.env.OPENAI_API_KEY;
    this.openaiVoice = process.env.TTS_VOICE || 'alloy';
    this.edgeVoice = process.env.TTS_EDGE_VOICE || 'zh-CN-XiaoxiaoNeural';
  }

  async synthesize(text: string): Promise<TTSResult> {
    if (!text || text.length === 0) {
      return { ok: false, error: '文本不能为空' };
    }
    const truncated = text.slice(0, 4000);
    switch (this.provider) {
      case 'openai': return this.openaiTTS(truncated);
      case 'edge':   return this.edgeTTS(truncated);
      default:       return { ok: false, error: 'TTS 未配置。在 .env 中设置 TTS_PROVIDER=openai 或 edge' };
    }
  }

  private async openaiTTS(text: string): Promise<TTSResult> {
    if (!this.openaiKey) return { ok: false, error: 'OPENAI_API_KEY 未配置' };
    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tts-1', voice: this.openaiVoice, input: text, response_format: 'mp3' }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return { ok: false, error: `OpenAI TTS 失败: ${await res.text()}` };
      const buffer = Buffer.from(await res.arrayBuffer());
      return { ok: true, audioBase64: buffer.toString('base64'), mimeType: 'audio/mpeg', duration: Math.ceil(buffer.length / 2000) };
    } catch (err: any) {
      return { ok: false, error: `OpenAI TTS 错误: ${err.message}` };
    }
  }

  private async edgeTTS(text: string): Promise<TTSResult> {
    const tmpFile = join(tmpdir(), `tts_${Date.now()}.mp3`);
    try {
      return await new Promise((resolve) => {
        execFile('edge-tts', ['--voice', this.edgeVoice, '--text', text, '--write-media', tmpFile], { timeout: 30000 }, async (err: any) => {
          if (err) {
            resolve({ ok: false, error: `edge-tts 错误: ${err.message}。请安装: pip install edge-tts` });
            return;
          }
          try {
            const buffer = readFileSync(tmpFile);
            const audioBase64 = buffer.toString('base64');
            unlinkSync(tmpFile);
            resolve({ ok: true, audioBase64, mimeType: 'audio/mpeg', duration: Math.ceil(buffer.length / 2000) });
          } catch (e: any) {
            resolve({ ok: false, error: `读取音频文件失败: ${e.message}` });
          }
        });
      });
    } catch (err: any) {
      return { ok: false, error: `Edge TTS 错误: ${err.message}` };
    }
  }

  isAvailable(): boolean { return this.provider !== 'none'; }

  getStatus() {
    return { provider: this.provider, available: this.isAvailable(), voice: this.provider === 'openai' ? this.openaiVoice : this.edgeVoice };
  }
}
