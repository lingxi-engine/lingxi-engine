/**
 * 语音转文字 - Speech to Text (STT)
 * 支持：OpenAI Whisper API, 本地 whisper.cpp
 */
import { execFile } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface STTResult {
  ok: boolean;
  text?: string;
  language?: string;
  duration?: number;
  error?: string;
}

export type STTProvider = 'openai' | 'whisper-cpp' | 'none';

export class STTManager {
  private provider: STTProvider;
  private openaiKey?: string;
  private whisperModel: string;

  constructor() {
    this.provider = (process.env.STT_PROVIDER as STTProvider) || 'none';
    this.openaiKey = process.env.OPENAI_API_KEY;
    this.whisperModel = process.env.STT_WHISPER_MODEL || 'whisper-1';
  }

  async transcribe(audioBase64: string, mimeType = 'audio/mpeg'): Promise<STTResult> {
    if (!audioBase64) return { ok: false, error: '音频数据不能为空' };
    switch (this.provider) {
      case 'openai':     return this.openaiSTT(audioBase64, mimeType);
      case 'whisper-cpp': return this.whisperCppSTT(audioBase64, mimeType);
      default:           return { ok: false, error: 'STT 未配置。在 .env 中设置 STT_PROVIDER=openai 或 whisper-cpp' };
    }
  }

  private async openaiSTT(audioBase64: string, mimeType: string): Promise<STTResult> {
    if (!this.openaiKey) return { ok: false, error: 'OPENAI_API_KEY 未配置' };
    try {
      const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('wav') ? 'wav' : 'mp3';
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\n`),
        Buffer.from(`Content-Disposition: form-data; name="model"\r\n\r\n`),
        Buffer.from(`${this.whisperModel}\r\n`),
        Buffer.from(`--${boundary}\r\n`),
        Buffer.from(`Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n`),
        Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`),
        audioBuffer,
        Buffer.from(`\r\n--${boundary}\r\n`),
        Buffer.from(`Content-Disposition: form-data; name="language"\r\n\r\n`),
        Buffer.from(`zh\r\n`),
        Buffer.from(`--${boundary}--\r\n`),
      ]);
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.openaiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) return { ok: false, error: `Whisper API 失败: ${await res.text()}` };
      const data = await res.json() as any;
      return { ok: true, text: data.text || '', language: data.language || 'zh' };
    } catch (err: any) {
      return { ok: false, error: `Whisper API 错误: ${err.message}` };
    }
  }

  private async whisperCppSTT(audioBase64: string, mimeType: string): Promise<STTResult> {
    const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('wav') ? 'wav' : 'mp3';
    const tmpFile = join(tmpdir(), `stt_${Date.now()}.${ext}`);
    const modelPath = process.env.STT_WHISPER_MODEL_PATH || './models/ggml-base.bin';
    try {
      writeFileSync(tmpFile, Buffer.from(audioBase64, 'base64'));
      return await new Promise((resolve) => {
        execFile('whisper-cli', ['-m', modelPath, '-l', 'zh', '-f', tmpFile, '--output-txt', '--output-file', tmpFile + '.txt'], { timeout: 120000 }, (err: any, stdout: string) => {
          try { unlinkSync(tmpFile); } catch {}
          if (err) { resolve({ ok: false, error: `whisper-cli 错误: ${err.message}。请安装 whisper.cpp` }); return; }
          try {
            const text = readFileSync(`${tmpFile}.txt`, 'utf-8').trim();
            try { unlinkSync(`${tmpFile}.txt`); } catch {}
            resolve({ ok: true, text, language: 'zh' });
          } catch {
            resolve({ ok: true, text: stdout.trim(), language: 'zh' });
          }
        });
      });
    } catch (err: any) {
      return { ok: false, error: `whisper.cpp 错误: ${err.message}` };
    }
  }

  isAvailable(): boolean { return this.provider !== 'none'; }

  getStatus() {
    return { provider: this.provider, available: this.isAvailable(), model: this.whisperModel };
  }
}
