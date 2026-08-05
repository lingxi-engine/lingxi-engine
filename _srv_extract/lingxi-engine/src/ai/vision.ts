/**
 * Vision 图片理解
 * 让 AI 能看图回复，支持多模态模型
 * 支持：OpenAI GPT-4o, NVIDIA NIM vision models, Ollama vision models
 */

import { AIHub } from '../ai/hub.js';

export interface VisionResult {
  ok: boolean;
  description?: string;
  error?: string;
}

export class VisionManager {
  private aiHub: AIHub;

  constructor(aiHub: AIHub) {
    this.aiHub = aiHub;
  }

  /**
   * 分析图片
   * @param imageBase64 base64 编码的图片
   * @param mimeType 图片类型 image/png, image/jpeg, image/webp
   * @param question 用户的问题（可选）
   */
  async analyze(imageBase64: string, mimeType: string, question?: string): Promise<VisionResult> {
    if (!imageBase64) {
      return { ok: false, error: '图片数据不能为空' };
    }

    const prompt = question || '请描述这张图片的内容。';
    
    // 尝试使用支持 vision 的模型
    const visionModels = this.getVisionModels();
    if (visionModels.length === 0) {
      return { ok: false, error: '没有可用的 vision 模型。需要 GPT-4o 或其他多模态模型。' };
    }

    for (const model of visionModels) {
      try {
        const result = await this.callVisionModel(model, imageBase64, mimeType, prompt);
        if (result.ok) return result;
      } catch (err: any) {
        console.error(`[Vision] ${model} 失败:`, err.message);
        continue;
      }
    }

    return { ok: false, error: '所有 vision 模型都失败了' };
  }

  /**
   * 获取可用的 vision 模型
   */
  private getVisionModels(): string[] {
    const models = this.aiHub.listModels();
    const visionKeywords = ['gpt-4o', 'gpt-4-vision', 'llava', 'bakllava', 'moondream', 'qwen2-vl', 'qwen2.5-vl', 'vl-', 'vision', 'multimodal', 'cogvlm', 'internvl'];
    return models.filter((m: any) => {
      const id = (m.id || m.name || '').toLowerCase();
      return visionKeywords.some(k => id.includes(k));
    }).map((m: any) => m.id || m.name);
  }

  /**
   * 调用 vision 模型
   */
  private async callVisionModel(model: string, imageBase64: string, mimeType: string, prompt: string): Promise<VisionResult> {
    const clientResult = this.aiHub.getClient(model);
    if (!clientResult) {
      return { ok: false, error: `模型 ${model} 不可用` };
    }

    const { client, resolvedModel } = clientResult;

    try {
      // 使用 OpenAI 兼容的 Chat Completion API + image_url
      const dataUrl = `data:${mimeType};base64,${imageBase64}`;
      
      const completion = await client.chat.completions.create({
        model: resolvedModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 1000,
        temperature: 0.7,
      });

      const description = completion.choices?.[0]?.message?.content || '';
      if (!description) {
        return { ok: false, error: '模型返回空内容' };
      }

      return { ok: true, description };
    } catch (err: any) {
      return { ok: false, error: `模型 ${model} 调用失败: ${err.message}` };
    }
  }

  /**
   * 检查是否可用
   */
  isAvailable(): boolean {
    return this.getVisionModels().length > 0;
  }

  /**
   * 获取状态
   */
  getStatus() {
    const models = this.getVisionModels();
    return {
      available: models.length > 0,
      models,
    };
  }
}